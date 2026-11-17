'use strict';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const STATUS = {
  new:           { pill: 'Awaiting payment', tone: 'wait' },
  waiting:       { pill: 'Awaiting payment', tone: 'wait' },
  paying:        { pill: 'Confirming',       tone: 'busy' },
  underpaid:     { pill: 'Partly paid',      tone: 'warn' },
  paid:          { pill: 'Paid',             tone: 'good' },
  manual_accept: { pill: 'Paid',             tone: 'good' },
  expired:       { pill: 'Expired',          tone: 'bad'  },
  refunding:     { pill: 'Refunding',        tone: 'warn' },
  refunded:      { pill: 'Refunded',         tone: 'bad'  },
};
const FINAL = new Set(['paid', 'manual_accept', 'expired', 'refunded']);

let config = null;
let current = null;      // payment view from the server
let clockOffset = 0;     // server time − device time, seconds
let pollTimer = null;
let tickTimer = null;

// ─── API ─────────────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  if (!res.ok || !json?.success) {
    const err = new Error(json?.error?.message || 'Something went wrong. Please try again.');
    err.status = res.status;
    throw err;
  }
  return json.data;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function fiat(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

function cryptoAmount(n) {
  // Keep every significant decimal; wallets need the exact figure.
  return String(Number(n)).includes('e') ? Number(n).toFixed(8).replace(/0+$/, '') : String(Number(n));
}

function show(view) {
  for (const id of ['formView', 'payView', 'loadingView']) $(id).hidden = id !== view;
}

// ─── Form ────────────────────────────────────────────────────────────────────

function renderForm(options) {
  const sel = $('currency');
  sel.innerHTML = '';
  for (const c of config.fiats) sel.append(new Option(c, c));
  if (params.get('currency') && config.fiats.includes(params.get('currency').toUpperCase())) {
    sel.value = params.get('currency').toUpperCase();
  }
  sel.disabled = config.fiats.length === 1;

  const box = $('options');
  box.innerHTML = '';
  if (!options.length) {
    box.innerHTML = '<p class="muted small">No payment methods are available right now.</p>';
    $('submitBtn').disabled = true;
  }
  options.forEach((o, i) => {
    const label = document.createElement('label');
    label.className = 'option';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'option';
    input.value = o.id;
    input.checked = i === 0;
    const coin = document.createElement('span');
    coin.className = 'coin';
    coin.textContent = o.coin.slice(0, 4);
    const text = document.createElement('span');
    text.className = 'option-text';
    const [, net] = o.label.split(' · ');
    text.innerHTML = '<strong></strong><small></small>';
    text.querySelector('strong').textContent = o.coinName || o.coin;
    text.querySelector('small').textContent = net || o.network;
    label.append(input, coin, text);
    box.append(label);
  });

  // Prefill from link: ?amount=1500&currency=INR&ref=INV-22&desc=...&email=...
  if (params.get('amount')) $('amount').value = params.get('amount');
  if (params.get('ref')) $('order_id').value = params.get('ref');
  if (params.get('email')) $('email').value = params.get('email');
  if (params.get('desc')) $('description').value = params.get('desc');

  show('formView');
  if (!$('amount').value) $('amount').focus();
}

function formError(msg) {
  $('formError').textContent = msg || '';
  $('formError').hidden = !msg;
}

$('payForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  formError('');
  const amount = $('amount').value.replace(/,/g, '').trim();
  if (!amount || !(Number(amount) > 0)) return formError('Enter the amount you want to pay.');
  const option = document.querySelector('input[name="option"]:checked')?.value;
  if (!option) return formError('Choose how you want to pay.');

  const btn = $('submitBtn');
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  try {
    const payment = await api('/api/payments', {
      method: 'POST',
      body: JSON.stringify({
        amount: Number(amount),
        currency: $('currency').value,
        option,
        email: $('email').value.trim(),
        order_id: $('order_id').value.trim(),
        description: $('description').value.trim(),
      }),
    });
    history.replaceState(null, '', `?id=${encodeURIComponent(payment.id)}`);
    openPayment(payment);
  } catch (err) {
    formError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Continue';
  }
});

// ─── Payment view ────────────────────────────────────────────────────────────

function openPayment(p) {
  current = p;
  clockOffset = p.server_time - Date.now() / 1000;
  $('qr').src = p.address ? `/api/payments/${encodeURIComponent(p.id)}/qr.svg` : '';
  show('payView');
  renderPayment();
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, 1000);
  tick();
  schedulePoll();
}

function renderPayment() {
  const p = current;
  const s = STATUS[p.status] || { pill: p.status, tone: 'wait' };

  $('payRef').textContent = p.description ? `${p.description} · Ref ${p.order_id}` : `Ref ${p.order_id}`;
  $('payFiat').textContent = fiat(p.amount, p.currency);
  $('statusPill').textContent = s.pill;
  $('statusPill').dataset.tone = s.tone;

  const payable = Boolean(p.address) && !FINAL.has(p.status);
  $('payBlock').hidden = !payable;
  $('resultBlock').hidden = payable;

  if (payable) {
    $('payAmount').textContent = `${cryptoAmount(p.pay_amount)} ${p.pay_currency}`;
    $('payNetwork').textContent = `on ${p.network_label.split(' · ')[1] || p.network_label}`;
    $('address').textContent = p.address;
    $('memoField').hidden = !p.memo;
    $('memo').textContent = p.memo || '';
    $('warnNetwork').textContent =
      `Send only ${p.pay_currency} on ${p.network_label.split(' · ')[1] || 'this network'}. Any other coin or network will be lost.`;

    const rec = $('receivedRow');
    if (p.status === 'underpaid' && p.received != null) {
      const left = Math.max(0, Number(p.pay_amount) - Number(p.received));
      rec.textContent = `Received ${cryptoAmount(p.received)} ${p.pay_currency}. Send the remaining ${cryptoAmount(left.toFixed(8))} ${p.pay_currency} to the same address.`;
      rec.hidden = false;
    } else if (p.status === 'paying') {
      rec.textContent = 'We can see your payment. Waiting for network confirmations. This page updates on its own.';
      rec.hidden = false;
    } else {
      rec.hidden = true;
    }
  } else {
    renderResult(p);
  }
}

function renderResult(p) {
  const icon = $('resultIcon');
  if (p.status === 'paid' || p.status === 'manual_accept') {
    icon.dataset.tone = 'good';
    icon.textContent = '✓';
    $('resultTitle').textContent = 'Payment received';
    $('resultText').textContent = `Thank you. ${fiat(p.amount, p.currency)} (${cryptoAmount(p.pay_amount)} ${p.pay_currency}) was received for reference ${p.order_id}. You can close this page.`;
    $('newPaymentBtn').hidden = true;
  } else if (p.status === 'paying') {
    icon.dataset.tone = 'busy';
    icon.textContent = '…';
    $('resultTitle').textContent = 'Confirming your payment';
    $('resultText').textContent = 'Your payment was detected and is waiting for network confirmations. This page updates on its own. Do not send it again.';
    $('newPaymentBtn').hidden = true;
  } else if (p.status === 'underpaid') {
    icon.dataset.tone = 'warn';
    icon.textContent = '!';
    $('resultTitle').textContent = 'Partly paid';
    $('resultText').textContent = `Only part of the amount arrived before the window closed (reference ${p.order_id}). Please contact us with this reference. Do not send to the old address.`;
    $('newPaymentBtn').hidden = true;
  } else if (p.status === 'refunding' || p.status === 'refunded') {
    icon.dataset.tone = 'warn';
    icon.textContent = '↺';
    $('resultTitle').textContent = p.status === 'refunded' ? 'Payment refunded' : 'Refund in progress';
    $('resultText').textContent = `The funds for reference ${p.order_id} are being returned to the sender.`;
    $('newPaymentBtn').hidden = false;
  } else {
    icon.dataset.tone = 'bad';
    icon.textContent = '!';
    $('resultTitle').textContent = 'Payment window closed';
    $('resultText').textContent = 'This payment expired before it was completed. Do not send anything to the old address. Start a new payment to get a fresh one.';
    $('newPaymentBtn').hidden = false;
  }
}

function tick() {
  if (!current) return;
  const now = Date.now() / 1000 + clockOffset;
  const left = Math.max(0, Math.floor(current.expires_at - now));
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  $('countdown').textContent = `${mm}:${ss}`;
  const total = (config?.lifetimeMinutes || 30) * 60;
  $('timerBar').style.width = `${Math.min(100, (left / total) * 100)}%`;
  $('countdown').dataset.urgent = left < 120 ? '1' : '';

  // Hide the address the moment the window closes, even before the server says so.
  if (left === 0 && current.address && !['paid', 'manual_accept'].includes(current.status)) {
    const untouched = ['new', 'waiting'].includes(current.status);
    current = { ...current, address: null, memo: null, status: untouched ? 'expired' : current.status };
    renderPayment();
    poll();
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (FINAL.has(current.status)) {
    clearInterval(tickTimer);
    return;
  }
  pollTimer = setTimeout(poll, document.hidden ? 15000 : 6000);
}

async function poll() {
  if (!current) return;
  try {
    const p = await api(`/api/payments/${encodeURIComponent(current.id)}`);
    const addressChanged = p.address !== current.address;
    current = p;
    clockOffset = p.server_time - Date.now() / 1000;
    if (addressChanged) $('qr').src = p.address ? `/api/payments/${encodeURIComponent(p.id)}/qr.svg` : '';
    renderPayment();
  } catch { /* transient — try again */ }
  schedulePoll();
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && current) poll(); });

// ─── Copy buttons ────────────────────────────────────────────────────────────

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button.copy');
  if (!btn || !current) return;
  const key = btn.dataset.copy;
  const value = key === 'payAmountRaw' ? cryptoAmount(current.pay_amount) : current[key];
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = value;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  btn.textContent = 'Copied';
  btn.classList.add('done');
  setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1500);
});

$('newPaymentBtn').addEventListener('click', () => {
  clearTimeout(pollTimer);
  clearInterval(tickTimer);
  current = null;
  history.replaceState(null, '', location.pathname);
  params.delete('id');
  start();
});

// ─── Boot ────────────────────────────────────────────────────────────────────

async function start() {
  show('loadingView');
  try {
    config = config || (await api('/api/config'));
    document.title = `${config.brandName} · Checkout`;
    $('brandName').textContent = config.brandName;
    document.documentElement.style.setProperty('--brand', config.brandColor);
    $('mockBanner').hidden = !config.mock;
    $('support').textContent = config.supportText || '';

    const id = params.get('id');
    if (id) {
      try {
        return openPayment(await api(`/api/payments/${encodeURIComponent(id)}`));
      } catch (err) {
        if (err.status !== 404) throw err;
        history.replaceState(null, '', location.pathname);
      }
    }
    renderForm(await api('/api/options'));
  } catch (err) {
    $('loadingView').innerHTML = '';
    const p = document.createElement('p');
    p.className = 'error';
    p.textContent = err.message;
    $('loadingView').append(p);
  }
}

start();
