// Sends a signed webhook to the local server, the same way the gateway does
// (HMAC-SHA512 of the raw body, hex, in the "HMAC" header).
//
//   node scripts/test-webhook.js <track_id> [status] [--bad-signature]
//
// Uses OXAPAY_MERCHANT_API_KEY from .env (or "mock-merchant-key" in MOCK mode).

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* none */ }

const [trackId, status = 'Paid'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const bad = process.argv.includes('--bad-signature');
if (!trackId) {
  console.error('usage: node scripts/test-webhook.js <track_id> [status] [--bad-signature]');
  process.exit(1);
}

const key = process.env.OXAPAY_MERCHANT_API_KEY || 'mock-merchant-key';
const port = process.env.PORT || 4000;
const body = JSON.stringify({
  track_id: trackId,
  status,
  type: 'white_label',
  amount: 0,
  currency: 'USD',
  date: Math.floor(Date.now() / 1000),
  txs: [],
});
const hmac = crypto.createHmac('sha512', bad ? 'wrong-key' : key).update(body).digest('hex');

const res = await fetch(`http://localhost:${port}/webhooks/payment`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', HMAC: hmac },
  body,
});
console.log(res.status, await res.text());
