/**
 * Recebe o webhook da Cakto e manda o evento Purchase para a API de Conversões da Meta.
 *
 * Por que existe: a Cakto não tem integração nativa de pixel, e a compra acontece no
 * domínio dela (pay.cakto.com.br), onde o pixel do site não roda. Sem isto, a campanha
 * otimiza no escuro.
 *
 * Variáveis de ambiente necessárias na Vercel:
 *   CAKTO_WEBHOOK_SECRET  — o secret que a Cakto mostra ao criar o webhook
 *   META_CAPI_TOKEN       — token da API de Conversões (Events Manager → Configurações)
 *
 * O evento é enviado com event_id = id do pedido, que é o mesmo identificador usado
 * pelo pixel do navegador. A Meta usa isso para não contar a mesma venda duas vezes.
 */

import crypto from 'node:crypto';

export const config = { api: { bodyParser: false } };

const PIXEL_ID = '1107457028532296';
const GRAPH = `https://graph.facebook.com/v21.0/${PIXEL_ID}/events`;
const TOLERANCIA_SEG = 5 * 60;

const sha256 = (v) =>
  crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');

function lerCorpoCru(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

/** Confere a assinatura do header; cai para o secret do corpo se o header não vier. */
function veioDaCakto(corpoCru, timestamp, assinatura, secretDoCorpo) {
  const segredo = process.env.CAKTO_WEBHOOK_SECRET;
  if (!segredo) return false;

  if (timestamp && assinatura) {
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCIA_SEG) return false;
    const esperado = crypto
      .createHmac('sha256', segredo)
      .update(`${timestamp}.`)
      .update(corpoCru)
      .digest('hex');
    const a = Buffer.from(assinatura);
    const b = Buffer.from(`v1=${esperado}`);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  const a = Buffer.from(String(secretDoCorpo || ''));
  const b = Buffer.from(segredo);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Monta um evento Purchase a partir de um pedido da Cakto. */
function montarEvento(pedido) {
  const cliente = pedido.customer || {};
  const userData = {};

  if (cliente.email) userData.em = [sha256(cliente.email)];
  if (cliente.phone) userData.ph = [sha256(String(cliente.phone).replace(/\D/g, ''))];
  if (cliente.name) {
    const partes = String(cliente.name).trim().split(/\s+/);
    userData.fn = [sha256(partes[0])];
    if (partes.length > 1) userData.ln = [sha256(partes[partes.length - 1])];
  }
  if (cliente.id) userData.external_id = [sha256(cliente.id)];
  // fbc/fbp vêm do próprio checkout da Cakto e melhoram muito a atribuição
  if (pedido.fbc) userData.fbc = pedido.fbc;
  if (pedido.fbp) userData.fbp = pedido.fbp;

  const valor = typeof pedido.amount === 'number' ? pedido.amount : Number(pedido.baseAmount || 0);
  const quando = pedido.paidAt || pedido.createdAt;

  return {
    event_name: 'Purchase',
    event_time: Math.floor(new Date(quando || Date.now()).getTime() / 1000),
    event_id: pedido.id,                       // dedup com o pixel do navegador
    event_source_url: pedido.checkoutUrl || undefined,
    action_source: 'website',
    user_data: userData,
    custom_data: {
      value: valor,
      currency: (pedido.offer && pedido.offer.currency) || 'BRL',
      content_name: (pedido.product && pedido.product.name) || undefined,
      content_ids: pedido.product && pedido.product.id ? [pedido.product.id] : undefined,
      content_type: 'product',
      order_id: pedido.refId || pedido.id,
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'use POST' });

  let corpoCru, payload;
  try {
    corpoCru = await lerCorpoCru(req);
    payload = JSON.parse(corpoCru.toString('utf8'));
  } catch {
    return res.status(400).json({ erro: 'json invalido' });
  }

  if (!veioDaCakto(corpoCru, req.headers['x-cakto-timestamp'], req.headers['x-cakto-signature'], payload.secret)) {
    return res.status(401).json({ erro: 'assinatura invalida' });
  }

  // Só compra aprovada vira Purchase. Os outros eventos respondem 200 e param aqui.
  if (payload.event !== 'purchase_approved') {
    return res.status(200).json({ ok: true, ignorado: payload.event });
  }

  // No modo Agrupado a Cakto entrega data como lista: o pedido principal e os
  // order bumps da MESMA cobrança. Isso é uma venda só — mandar um Purchase por
  // item faria a Meta contar 4 compras onde houve 1, e estragaria o custo por
  // compra. Então somamos tudo num evento só, ancorado no pedido principal.
  const pedidos = (Array.isArray(payload.data) ? payload.data : [payload.data]).filter(Boolean);
  if (!pedidos.length) return res.status(200).json({ ok: true, aviso: 'sem pedidos' });

  const principal = pedidos.find((p) => p.offer_type === 'main') || pedidos[0];
  const total = pedidos.reduce((soma, p) => {
    const v = typeof p.amount === 'number' ? p.amount : Number(p.baseAmount || 0);
    return soma + (isFinite(v) ? v : 0);
  }, 0);

  const evento = montarEvento(principal);
  evento.custom_data.value = Number(total.toFixed(2));
  evento.custom_data.contents = pedidos.map((p) => ({
    id: (p.product && p.product.id) || p.id,
    quantity: 1,
    item_price: typeof p.amount === 'number' ? p.amount : Number(p.baseAmount || 0),
  }));
  evento.custom_data.num_items = pedidos.length;
  const eventos = [evento];

  const token = process.env.META_CAPI_TOKEN;
  if (!token) {
    // Responde 2xx assim mesmo: reenviar não resolveria falta de configuração.
    console.error('META_CAPI_TOKEN ausente — evento não enviado', eventos.map((e) => e.event_id));
    return res.status(200).json({ ok: true, aviso: 'META_CAPI_TOKEN nao configurado' });
  }

  try {
    const r = await fetch(GRAPH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: eventos, access_token: token }),
    });
    const resposta = await r.json();
    if (!r.ok) console.error('Meta recusou o evento', resposta);
    return res.status(200).json({ ok: true, enviados: eventos.length, meta: resposta });
  } catch (e) {
    console.error('falha ao chamar a Meta', e);
    return res.status(200).json({ ok: true, aviso: 'falha ao enviar, ver log' });
  }
}
