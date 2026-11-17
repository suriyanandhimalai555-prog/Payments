'use strict';

const $ = (id) => document.getElementById(id);

const LABEL = {
  open: { text: 'Not paid', tone: 'wait' },
  paid: { text: 'Paid', tone: 'good' },
  cancelled: { text: 'Cancelled', tone: 'bad' },
};
const ATTEMPT = {
  waiting: 'customer opened it, waiting for funds',
  new: 'customer opened it, waiting for funds',
  paying: 'payment detected, confirming',
  underpaid: 'partly paid',
  expired: 'last attempt expired',
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  if (!res.ok || !json?.success) {
    const err = new Error(json?.error?.message || 'Something went wrong.');
    err.status = res.status;
    throw err;
  }
  return json.data;
}

function fiat(amount, currency) {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount); }
  catch { return `${amount} ${currency}`; }
}

function showError(id, msg) {
  $(id).textContent = msg || '';
  $(id).hidden = !msg;
}

async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = 'Copied';
  btn.classList.add('done');
  setTimeout(() => { btn.textContent = old; btn.classList.remove('done'); }, 1500);
}

function signedIn(yes) {
  $('loginView').hidden = yes;
  $('appView').hidden = !yes;
  $('logoutBtn').hidden = !yes;
  if (!yes) $('password').focus();
}

// ─── Links list ──────────────────────────────────────────────────────────────

function renderLinks(list) {
  const box = $('links');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<p class="muted small">No links yet.</p>';
    return;
  }
  for (const l of list) {
    const row = document.createElement('div');
    row.className = 'link-row';

    const main = document.createElement('div');
    main.className = 'link-main';
    const top = document.createElement('div');
    top.className = 'link-top';
    const amt = document.createElement('strong');
    amt.textContent = fiat(l.amount, l.currency);
    const pill = document.createElement('span');
    pill.className = 'pill';
    const lab = LABEL[l.status] || { text: l.status, tone: 'wait' };
    pill.textContent = lab.text;
    pill.dataset.tone = l.status === 'open' && l.last_attempt?.status === 'paying' ? 'busy' : lab.tone;
    top.append(amt, pill);

    const meta = document.createElement('div');
    meta.className = 'muted small';
    const bits = [`Ref ${l.order_id}`];
    if (l.description) bits.push(l.description);
    bits.push(new Date(l.created_at).toLocaleString());
    meta.textContent = bits.join(' · ');

    const sub = document.createElement('div');
    sub.className = 'small';
    if (l.status === 'paid' && l.last_attempt) {
      sub.textContent = `Received ${l.last_attempt.pay_amount} ${l.last_attempt.pay_currency} on ${l.last_attempt.network.split(' · ')[1] || ''}${l.paid_at ? ` · ${new Date(l.paid_at).toLocaleString()}` : ''}`;
    } else if (l.status === 'open' && l.last_attempt) {
      sub.textContent = ATTEMPT[l.last_attempt.status] || l.last_attempt.status;
    } else if (l.status === 'open') {
      sub.textContent = 'Not opened yet';
    }
    sub.classList.add('muted');
    main.append(top, meta, sub);

    const actions = document.createElement('div');
    actions.className = 'link-actions';
    if (l.status === 'open') {
      const c = document.createElement('button');
      c.className = 'copy';
      c.type = 'button';
      c.textContent = 'Copy link';
      c.addEventListener('click', () => copy(l.url, c));
      const x = document.createElement('button');
      x.className = 'copy danger';
      x.type = 'button';
      x.textContent = 'Cancel';
      x.addEventListener('click', async () => {
        if (!confirm(`Cancel the ${fiat(l.amount, l.currency)} link (${l.order_id})? The customer will no longer be able to pay it.`)) return;
        try { await api(`/api/admin/links/${encodeURIComponent(l.code)}/cancel`, { method: 'POST', body: '{}' }); }
        catch (err) { alert(err.message); }
        load();
      });
      actions.append(c, x);
    }
    row.append(main, actions);
    box.append(row);
  }
}

async function load() {
  try {
    renderLinks(await api('/api/admin/links'));
    signedIn(true);
  } catch (err) {
    if (err.status === 401) return signedIn(false);
    $('links').textContent = err.message;
  }
}

// ─── Events ──────────────────────────────────────────────────────────────────

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('loginError', '');
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) });
    $('password').value = '';
    load();
  } catch (err) {
    showError('loginError', err.message);
  }
});

$('logoutBtn').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST', body: '{}' }).catch(() => {});
  signedIn(false);
});

$('linkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('linkError', '');
  const amount = $('amount').value.replace(/,/g, '').trim();
  if (!(Number(amount) > 0)) return showError('linkError', 'Enter the amount.');
  const btn = $('createBtn');
  btn.disabled = true;
  try {
    const link = await api('/api/admin/links', {
      method: 'POST',
      body: JSON.stringify({
        amount: Number(amount),
        currency: $('currency').value,
        order_id: $('order_id').value.trim(),
        description: $('description').value.trim(),
      }),
    });
    $('createdUrl').textContent = link.url;
    $('created').hidden = false;
    $('amount').value = '';
    $('order_id').value = '';
    $('description').value = '';
    load();
  } catch (err) {
    if (err.status === 401) return signedIn(false);
    showError('linkError', err.message);
  } finally {
    btn.disabled = false;
  }
});

$('copyCreated').addEventListener('click', (e) => copy($('createdUrl').textContent, e.currentTarget));
$('refreshBtn').addEventListener('click', load);

(async () => {
  try {
    const config = await api('/api/config');
    $('brandName').textContent = config.brandName;
    document.documentElement.style.setProperty('--brand', config.brandColor);
    $('mockBanner').hidden = !config.mock;
    for (const c of config.fiats) $('currency').append(new Option(c, c));
  } catch { /* page still works */ }
  load();
  setInterval(() => { if (!$('appView').hidden && !document.hidden) load(); }, 20000);
})();
