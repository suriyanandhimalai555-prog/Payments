# Crypto Checkout (white-label)

A branded crypto payment page. It runs on OxaPay's **white-label** API, but nothing on the page shows OxaPay: no logo, no hosted invoice, no OxaPay URLs.

- The payer only ever talks to this server. The API key, the gateway hostnames and the gateway's error text stay server-side.
- The QR code is drawn locally as SVG. The gateway's hosted `qr_code` image is never used.
- The deposit address is hidden once the payment window expires, because funds sent after expiry are lost.
- Status updates arrive two ways: by polling the gateway (always on), and by HMAC-SHA512-signed webhooks when `PUBLIC_URL` is set.

## Run

```bash
npm install
cp .env.example .env      # set OXAPAY_MERCHANT_API_KEY + branding
npm start                 # http://localhost:4000
```

To try it without a key (fake payments, no money moves):

```bash
MOCK=1 npm start
```

In mock mode, `POST /api/mock/<id>/<status>` moves a payment along: `paying`, `paid`, `underpaid`, `expire`.

## Payment links

Open the page with the form already filled in:

```
https://pay.yourdomain.com/?amount=1500&currency=INR&ref=INV-22&desc=Gold%20scheme&email=a@b.com
```

The payer can still edit these values. If a link has to fix the amount, the amount must be set on the server (for example a signed link or a token-protected create endpoint). That is not built yet.

## Webhooks

Set `PUBLIC_URL=https://pay.yourdomain.com`. Each payment then registers `PUBLIC_URL/webhooks/payment` as its callback, and the server checks the `HMAC` header (HMAC-SHA512 of the raw body, keyed with your merchant API key). The path doesn't name the gateway.

Test locally:

```bash
node scripts/test-webhook.js <track_id> Paid
node scripts/test-webhook.js <track_id> Paid --bad-signature   # → 400
```

## Where paid orders go

`onPaid()` in `server.js` runs once, when a payment reaches `paid` or `manual_accept`. Right now it logs. Put your own fulfilment there: email, database write, Telegram message and so on. Payments are saved in `data/payments.json`.

## Config

See `.env.example`. The main settings:

| Var | Meaning |
|---|---|
| `BRAND_NAME`, `BRAND_COLOR`, `SUPPORT_TEXT` | What the payer sees |
| `FIAT_CURRENCIES` | Currencies the amount can be priced in (`INR,USD`) |
| `ALLOWED_COINS` | `USDT:Tron,USDT:BSC`, or `*` for everything your account accepts |
| `PAYMENT_LIFETIME_MIN` | Address validity, 15–2880 minutes |
| `FEE_PAID_BY_PAYER`, `UNDERPAID_COVERAGE` | Override your dashboard defaults |
| `TRUST_PROXY=1` | Set this behind Railway, Nginx or Cloudflare so rate limiting sees real IPs |
