// White-label crypto checkout server.
//
// The browser only ever talks to THIS server. The gateway's API key, its
// hostnames, its hosted QR images and its raw error messages never reach the
// payer, so nothing on the page reveals which gateway processes the payment.
//
//   GET  /                         checkout page (public/)
//   GET  /api/config               brand + fiat list for the page
//   GET  /api/options              coin/network choices the page may offer
//   POST /api/payments             create a white-label payment
//   GET  /api/payments/:id         payment status (refreshed from the gateway)
//   GET  /api/payments/:id/qr.svg  QR of the deposit address, drawn locally
//   POST /webhooks/payment         signed status callback from the gateway

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env file — use the real environment */ }

// ─── Config ──────────────────────────────────────────────────────────────────

const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
const clampInt = (v, min, max, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

const MOCK = process.env.MOCK === '1';
const cfg = {
  apiKey: process.env.OXAPAY_MERCHANT_API_KEY || (MOCK ? 'mock-merchant-key' : ''),
  port: Number(process.env.PORT) || 4000,
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  brandName: process.env.BRAND_NAME || 'Payments',
  brandColor: /^#[0-9a-fA-F]{6}$/.test(process.env.BRAND_COLOR || '') ? process.env.BRAND_COLOR : '#2563EB',
  supportText: process.env.SUPPORT_TEXT || '',
  fiats: list(process.env.FIAT_CURRENCIES || 'INR,USD').map((s) => s.toUpperCase()),
  // "COIN:NETWORK" pairs, or "*" for everything the merchant account accepts.
  allowedCoins: list(process.env.ALLOWED_COINS || 'USDT:Tron,USDT:BSC'),
  lifetime: clampInt(process.env.PAYMENT_LIFETIME_MIN, 15, 2880, 30),
  feePaidByPayer: num(process.env.FEE_PAID_BY_PAYER),
  underpaidCoverage: num(process.env.UNDERPAID_COVERAGE),
  minAmount: num(process.env.MIN_AMOUNT) ?? 1,
  maxAmount: num(process.env.MAX_AMOUNT),
  trustProxy: process.env.TRUST_PROXY === '1',
};

if (!cfg.apiKey) {
  console.error('OXAPAY_MERCHANT_API_KEY is not set. Copy .env.example to .env and fill it in (or run with MOCK=1).');
  process.exit(1);
}
if (!cfg.publicUrl) {
  console.warn('PUBLIC_URL is not set — webhooks are disabled; payment status will come from polling only.');
}

// ─── Gateway client (server-side only) ───────────────────────────────────────

const GATEWAY = 'https://api.oxapay.com/v1';

class GatewayError extends Error {}

async function gateway(method, urlPath, body) {
  let res;
  try {
    res = await fetch(GATEWAY + urlPath, {
      method,
      headers: { merchant_api_key: cfg.apiKey, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new GatewayError(`network: ${err.message}`);
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok || !json || json.status !== 200) {
    const detail = json?.error?.message || json?.message || `HTTP ${res.status}`;
    throw new GatewayError(`${method} ${urlPath} failed: ${detail}`);
  }
  return json.data;
}

// Small TTL cache for the public lookup lists.
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, until: Date.now() + ttlMs });
  return value;
}

// ─── Coin / network options ──────────────────────────────────────────────────

const STANDARD_RE = /^(TRC20|BEP20|ERC20|SPL|TON|POLYGON|ARB|BASE)$/i;

async function getOptions() {
  return cached('options', 10 * 60 * 1000, async () => {
    const currencies = await gateway('GET', '/common/currencies');
    const accepted = MOCK
      ? null
      : new Set(((await gateway('GET', '/payment/accepted-currencies'))?.list || []).map((s) => s.toUpperCase()));

    const all = [];
    for (const cur of Object.values(currencies || {})) {
      if (!cur?.status) continue;
      if (accepted && !accepted.has(String(cur.symbol).toUpperCase())) continue;
      for (const [netKey, net] of Object.entries(cur.networks || {})) {
        const keys = (net.keys || []).map(String);
        const std = keys.find((k) => STANDARD_RE.test(k) && k.toLowerCase() !== netKey.toLowerCase());
        all.push({
          id: `${cur.symbol}:${net.network || netKey}`,
          coin: cur.symbol,
          coinName: cur.name,
          network: net.network || netKey,
          label: `${cur.symbol} · ${net.name || netKey}${std ? ` (${std})` : ''}`,
          minDeposit: Number(net.deposit_min) || 0,
          _keys: [netKey, net.network, net.name, ...keys].filter(Boolean).map((k) => String(k).toLowerCase()),
        });
      }
    }

    const wildcard = cfg.allowedCoins.includes('*');
    const picked = wildcard
      ? all
      : cfg.allowedCoins.flatMap((pair) => {
          const [coin, network] = pair.split(':').map((s) => s.trim().toLowerCase());
          const hit = all.find((o) => o.coin.toLowerCase() === coin && (!network || o._keys.includes(network)));
          if (!hit) console.warn(`ALLOWED_COINS entry "${pair}" is not available on this merchant account — skipped.`);
          return hit ? [hit] : [];
        });
    return picked.map(({ _keys, ...o }) => o);
  });
}

async function getFiatPrices() {
  return cached('fiats', 10 * 60 * 1000, () => gateway('GET', '/common/fiats'));
}

// ─── Payment store (JSON file) ───────────────────────────────────────────────

const DATA_DIR = path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, MOCK ? 'payments.mock.json' : 'payments.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const payments = new Map();
try {
  for (const p of JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))) payments.set(p.track_id, p);
} catch { /* first run */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = `${STORE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...payments.values()], null, 2));
    fs.renameSync(tmp, STORE_FILE);
  }, 200);
}

const FINAL = new Set(['paid', 'manual_accept', 'expired', 'refunded']);
const PAID = new Set(['paid', 'manual_accept']);

function setStatus(p, status, source) {
  const next = String(status || '').toLowerCase();
  if (!next || next === p.status) return;
  // Never let a late/out-of-order update move a paid payment backwards.
  if (PAID.has(p.status) && !['refunding', 'refunded'].includes(next)) return;
  const prev = p.status;
  p.status = next;
  p.history = [...(p.history || []), { status: next, at: new Date().toISOString(), source }];
  save();
  console.log(`[payment] ${p.track_id} ${prev} → ${next} (${source})`);
  if (PAID.has(next)) onPaid(p);
}

// Fulfilment hook — this is where you mark the order as paid in your own system.
function onPaid(p) {
  console.log(`[paid] order=${p.order_id} ${p.amount} ${p.currency} = ${p.pay_amount} ${p.pay_currency} (${p.track_id})`);
}

// What the browser is allowed to see. No gateway URLs, no callback URL.
function publicView(p) {
  const now = Math.floor(Date.now() / 1000);
  const pastExpiry = now >= p.expired_at;
  // A payment already detected ("paying") can still complete after the timer;
  // only an untouched one is treated as expired locally.
  const status = pastExpiry && ['new', 'waiting'].includes(p.status) ? 'expired' : p.status;
  const payable = !pastExpiry && ['new', 'waiting', 'paying', 'underpaid'].includes(p.status);
  return {
    id: p.track_id,
    order_id: p.order_id,
    description: p.description || '',
    amount: p.amount,
    currency: p.currency,
    pay_amount: p.pay_amount,
    pay_currency: p.pay_currency,
    network_label: p.network_label,
    received: p.received ?? null,
    status,
    expires_at: p.expired_at,
    // Funds sent after expiry are lost, so the address disappears with it.
    address: payable ? p.address : null,
    memo: payable ? p.memo || '' : null,
    server_time: now,
  };
}

async function refreshStatus(p) {
  if (FINAL.has(p.status) || MOCK) return;
  if (p.checked_at && Date.now() - p.checked_at < 5000) return;
  p.checked_at = Date.now();
  try {
    const info = await gateway('GET', `/payment/${encodeURIComponent(p.track_id)}`);
    const txs = (info?.txs || []).filter((t) => String(t.currency).toUpperCase() === p.pay_currency.toUpperCase());
    if (txs.length) p.received = Number(txs.reduce((s, t) => s + Number(t.amount || 0), 0).toFixed(8));
    setStatus(p, info?.status, 'poll');
  } catch (err) {
    console.error(`[status] ${p.track_id}: ${err.message}`);
  }
}

// ─── Create payment ──────────────────────────────────────────────────────────

class BadRequest extends Error {}

function validateCreate(body, options) {
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new BadRequest('Enter a valid amount.');
  if (amount < cfg.minAmount) throw new BadRequest(`The minimum amount is ${cfg.minAmount}.`);
  if (cfg.maxAmount && amount > cfg.maxAmount) throw new BadRequest(`The maximum amount is ${cfg.maxAmount}.`);
  if (Math.round(amount * 100) / 100 !== amount) throw new BadRequest('Use at most 2 decimal places.');

  const currency = String(body.currency || cfg.fiats[0]).toUpperCase();
  if (!cfg.fiats.includes(currency)) throw new BadRequest('Unsupported currency.');

  const option = options.find((o) => o.id === body.option);
  if (!option) throw new BadRequest('Choose how you want to pay.');

  const email = String(body.email || '').trim();
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new BadRequest('Enter a valid email.');

  const orderId = String(body.order_id || '').trim();
  if (orderId && !/^[A-Za-z0-9._-]{1,64}$/.test(orderId)) throw new BadRequest('Invalid order reference.');

  const description = String(body.description || '').trim().slice(0, 200);
  return { amount, currency, option, email, orderId, description };
}

async function createPayment(body) {
  const options = await getOptions();
  const v = validateCreate(body, options);
  const orderId = v.orderId || `ORD-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  const request = {
    amount: v.amount,
    currency: v.currency,
    pay_currency: v.option.coin,
    network: v.option.network,
    lifetime: cfg.lifetime,
    order_id: orderId,
    ...(v.email && { email: v.email }),
    ...(v.description && { description: v.description }),
    ...(cfg.publicUrl && { callback_url: `${cfg.publicUrl}/webhooks/payment` }),
    ...(cfg.feePaidByPayer !== undefined && { fee_paid_by_payer: cfg.feePaidByPayer }),
    ...(cfg.underpaidCoverage !== undefined && { under_paid_coverage: cfg.underpaidCoverage }),
  };

  const d = MOCK ? await mockCreate(request) : await gateway('POST', '/payment/white-label', request);

  const p = {
    track_id: String(d.track_id),
    order_id: d.order_id || orderId,
    description: v.description,
    email: v.email,
    amount: Number(d.amount ?? v.amount),
    currency: String(d.currency || v.currency).toUpperCase(),
    pay_amount: Number(d.pay_amount),
    pay_currency: String(d.pay_currency || v.option.coin).toUpperCase(),
    network: v.option.network,
    network_label: v.option.label,
    address: String(d.address),
    memo: d.memo ? String(d.memo) : '',
    rate: d.rate ?? null,
    expired_at: Number(d.expired_at) || Math.floor(Date.now() / 1000) + cfg.lifetime * 60,
    created_at: new Date().toISOString(),
    status: 'waiting',
    history: [{ status: 'waiting', at: new Date().toISOString(), source: 'create' }],
  };
  if (!p.track_id || !p.address || !Number.isFinite(p.pay_amount)) {
    throw new GatewayError(`create returned an incomplete payment: ${JSON.stringify(d)}`);
  }
  payments.set(p.track_id, p);
  save();
  return p;
}

// MOCK=1: fake payments so the page can be built and tested without a key.
async function mockCreate(req) {
  let usdPerUnit = 1;
  try { usdPerUnit = Number((await getFiatPrices())?.[req.currency]?.price) || 1; } catch { /* offline */ }
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const rand = (n) => Array.from(crypto.randomBytes(n), (b) => alphabet[b % alphabet.length]).join('');
  return {
    track_id: `${crypto.randomInt(1e8, 1e9)}`,
    amount: req.amount,
    currency: req.currency,
    pay_amount: Number((req.amount * usdPerUnit).toFixed(4)),
    pay_currency: req.pay_currency,
    address: req.network === 'Tron' ? `T${rand(33)}` : `0x${crypto.randomBytes(20).toString('hex')}`,
    memo: '',
    order_id: req.order_id,
    expired_at: Math.floor(Date.now() / 1000) + req.lifetime * 60,
  };
}

// ─── Webhook ─────────────────────────────────────────────────────────────────

function verifyHmac(rawBody, header) {
  const expected = crypto.createHmac('sha512', cfg.apiKey).update(rawBody).digest('hex');
  const got = String(header || '').toLowerCase();
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

function handleWebhook(raw, headers) {
  if (!verifyHmac(raw, headers['hmac'])) return { code: 400, body: 'invalid signature' };
  let data;
  try { data = JSON.parse(raw.toString('utf8')); } catch { return { code: 400, body: 'invalid json' }; }

  const p = payments.get(String(data.track_id));
  if (!p) {
    console.warn(`[webhook] unknown track_id ${data.track_id} (status ${data.status})`);
    return { code: 200, body: 'ok' };
  }
  const txs = (data.txs || []).filter((t) => String(t.currency).toUpperCase() === p.pay_currency);
  if (txs.length) p.received = Number(txs.reduce((s, t) => s + Number(t.received_amount ?? t.sent_amount ?? 0), 0).toFixed(8));
  setStatus(p, data.status, 'webhook');
  return { code: 200, body: 'ok' };
}

// ─── HTTP plumbing ───────────────────────────────────────────────────────────

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
  res.end(payload);
}
const ok = (res, data) => send(res, 200, { success: true, data });
const fail = (res, code, message) => send(res, code, { success: false, error: { message } });

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new BadRequest('Request too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Per-IP limit on payment creation (each one reserves a fresh address).
const hits = new Map();
function rateLimited(ip, max = 15, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > max;
}
const clientIp = (req) =>
  (cfg.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;
  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', file)), type,
        url.pathname === '/' ? {} : { 'Cache-Control': 'public, max-age=300' });
    }

    if (route === 'GET /api/config') {
      return ok(res, {
        brandName: cfg.brandName,
        brandColor: cfg.brandColor,
        supportText: cfg.supportText,
        fiats: cfg.fiats,
        minAmount: cfg.minAmount,
        maxAmount: cfg.maxAmount ?? null,
        lifetimeMinutes: cfg.lifetime,
        mock: MOCK,
      });
    }

    if (route === 'GET /api/options') return ok(res, await getOptions());

    if (route === 'POST /api/payments') {
      if (rateLimited(clientIp(req))) return fail(res, 429, 'Too many payment attempts. Please wait a few minutes.');
      let body;
      try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { throw new BadRequest('Invalid request.'); }
      const p = await createPayment(body);
      return ok(res, publicView(p));
    }

    const m = url.pathname.match(/^\/api\/payments\/([A-Za-z0-9_-]{1,64})(\/qr\.svg)?$/);
    if (req.method === 'GET' && m) {
      const p = payments.get(m[1]);
      if (!p) return fail(res, 404, 'Payment not found.');
      if (m[2]) {
        const view = publicView(p);
        if (!view.address) return fail(res, 410, 'This payment can no longer be paid.');
        const svg = await QRCode.toString(view.address, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        return send(res, 200, svg, 'image/svg+xml');
      }
      await refreshStatus(p);
      return ok(res, publicView(p));
    }

    if (route === 'POST /webhooks/payment') {
      const raw = await readBody(req, 256 * 1024);
      const r = handleWebhook(raw, req.headers);
      return send(res, r.code, r.body, 'text/plain; charset=utf-8');
    }

    // Test-only: drive a mock payment through its statuses.
    const mm = url.pathname.match(/^\/api\/mock\/([A-Za-z0-9_-]+)\/([a-z_]+)$/);
    if (MOCK && req.method === 'POST' && mm) {
      const p = payments.get(mm[1]);
      if (!p) return fail(res, 404, 'Payment not found.');
      if (mm[2] === 'underpaid') p.received = Number((p.pay_amount / 2).toFixed(4));
      if (mm[2] === 'expire') { p.expired_at = Math.floor(Date.now() / 1000) - 1; save(); }
      else setStatus(p, mm[2], 'mock');
      return ok(res, publicView(p));
    }

    return fail(res, 404, 'Not found.');
  } catch (err) {
    if (err instanceof BadRequest) return fail(res, 400, err.message);
    // Gateway details stay in the server log; the payer gets a neutral message.
    console.error(`[error] ${route}: ${err.message}`);
    return fail(res, 502, 'Payment service is temporarily unavailable. Please try again.');
  }
});

server.listen(cfg.port, () => {
  console.log(`Checkout running on http://localhost:${cfg.port}${MOCK ? '  (MOCK mode — no real payments)' : ''}`);
});
