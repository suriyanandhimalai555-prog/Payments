# Crypto Checkout (white-label)

A branded crypto payment page. It runs on OxaPay's **white-label** API, but nothing on the page shows OxaPay: no logo, no hosted invoice, no OxaPay URLs.

- The payer only ever talks to this server. The API key, the gateway hostnames and the gateway's error text stay server-side.
- The QR code is drawn locally as SVG. The gateway's hosted `qr_code` image is never used.
- The deposit address is hidden once the payment window expires, because funds sent after expiry are lost.
- The payer's email stays on this server; it is not sent to the gateway.
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

## Fixed-amount payment links

1. Set `ADMIN_PASSWORD` in `.env` and open `/admin`.
2. Enter the amount, reference and what it's for, then click **Create link**.
3. Send the link (`/p/<code>`) whenever you like. It doesn't expire.
4. The customer sees the amount locked and picks a coin. Only then is the address and QR made, at the current rate, with a fresh timer.
5. Each link can be paid once. Reopening it resumes the same attempt. If that attempt expires, the customer can start a new one on the same link.
6. `/admin` lists every link: not paid, confirming, paid (with the coin and amount received), or cancelled. Open links can be cancelled.

Links are saved in `data/links.json`.

## Pre-filled open-amount links

`/?amount=1500&currency=INR&ref=INV-22&desc=...` only fills in the form, so the payer can change it. Use the admin links above when the amount must be fixed.

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
