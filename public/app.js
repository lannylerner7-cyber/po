// Keep MAX in sync with MAX_AMOUNT in .env (server enforces the real limit).
const MAX = 500000;
const MIN = 1;

const amount = document.getElementById('amount');
const note = document.getElementById('note');
const charge = document.getElementById('charge');
const chargeLabel = document.getElementById('charge-label');
const clearBtn = document.getElementById('clear');
const errorEl = document.getElementById('error');
const form = document.getElementById('pos');

function sanitize(v) {
  v = v.replace(/[^0-9.]/g, '');
  const dot = v.indexOf('.');
  if (dot !== -1) {
    // keep only the first dot and at most 2 decimals
    v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '');
    const [whole, frac] = v.split('.');
    v = whole + '.' + (frac || '').slice(0, 2);
  }
  v = v.replace(/^0+(?=\d)/, ''); // 0012 -> 12, but keep 0.75
  return v.slice(0, 10);
}

function update() {
  const val = parseFloat(amount.value);
  const ok = Number.isFinite(val) && val >= MIN && val <= MAX;
  charge.disabled = !ok;
  chargeLabel.textContent = ok
    ? 'Charge $' + val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : 'Charge';
}

function hideError() {
  errorEl.hidden = true;
}

amount.addEventListener('input', () => {
  amount.value = sanitize(amount.value);
  hideError();
  update();
});

document.querySelectorAll('.keypad [data-k]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const k = btn.dataset.k;
    playTone(k);
    let v = amount.value;
    if (k === 'back') v = v.slice(0, -1);
    else if (k === '.') v = v === '' ? '0.' : v.includes('.') ? v : v + '.';
    else v += k;
    amount.value = sanitize(v);
    hideError();
    update();
  });
});

clearBtn.addEventListener('click', () => {
  amount.value = '';
  note.value = '';
  hideError();
  update();
  amount.focus();
});

form.addEventListener('submit', () => {
  const val = parseFloat(amount.value);
  if (Number.isFinite(val)) amount.value = val.toFixed(2);
  charge.disabled = true;
  chargeLabel.textContent = 'Processing\u2026';
});

// Show validation messages the server sent back via /?error=...
const messages = {
  amount:
    'Enter an amount between $' +
    MIN.toFixed(2) +
    ' and $' +
    MAX.toLocaleString('en-US') +
    '.',
  stripe: 'Payment service is unavailable right now \u2014 please try again.',
};
const err = new URLSearchParams(location.search).get('error');
if (err && messages[err]) {
  errorEl.textContent = messages[err];
  errorEl.hidden = false;
  history.replaceState(null, '', location.pathname); // don't re-show on refresh
}

update();

// ---- Dialpad audio ----------------------------------------------------
// Real DTMF, the same system phones use: every key plays TWO sine waves at
// once (a row frequency + a column frequency). '.' and backspace borrow the
// * and # tones. Generated live with the Web Audio API — no audio files.
const soundBtn = document.getElementById('sound');
let soundOn = true;
let audioCtx = null;

const DTMF = {
  1: [697, 1209], 2: [697, 1336], 3: [697, 1477],
  4: [770, 1209], 5: [770, 1336], 6: [770, 1477],
  7: [852, 1209], 8: [852, 1336], 9: [852, 1477],
  0: [941, 1336], '.': [941, 1209], back: [941, 1477],
};

function playTone(k) {
  if (!soundOn) return;
  const freqs = DTMF[k];
  if (!freqs) return;
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const t = audioCtx.currentTime;
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.1, t + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
  gain.connect(audioCtx.destination);
  freqs.forEach((f) => {
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + 0.14);
  });
}

soundBtn.addEventListener('click', () => {
  soundOn = !soundOn;
  soundBtn.setAttribute('aria-pressed', String(soundOn));
});

// Typing on a physical keyboard clicks too
amount.addEventListener('keydown', (e) => {
  if (/^[0-9.]$/.test(e.key)) playTone(e.key);
  else if (e.key === 'Backspace') playTone('back');
});

// ---- Payment review ---------------------------------------------------
const overlay = document.getElementById('review-overlay');
const openBtn = document.getElementById('review-open');
const closeBtn = document.getElementById('review-close');
const idInput = document.getElementById('review-id');
const checkBtn = document.getElementById('review-check');
const resultBox = document.getElementById('review-result');
const errorBox = document.getElementById('review-error');

const STATUS_VIEW = {
  succeeded: ['Approved', 'good'],
  processing: ['Processing', 'info'],
  pending: ['Awaiting payment', 'neutral'],
  canceled: ['Canceled', 'neutral'],
  failed: ['Failed', 'bad'],
  expired: ['Expired', 'bad'],
  refunded: ['Refunded', 'info'],
};

function openReview() {
  overlay.setAttribute('data-open', '');
  idInput.focus();
}
function closeReview() {
  overlay.removeAttribute('data-open');
  openBtn.focus();
}

openBtn.addEventListener('click', openReview);
closeBtn.addEventListener('click', closeReview);
overlay.addEventListener('click', (e) => {
  if (e.target === overlay) closeReview();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && overlay.hasAttribute('data-open')) closeReview();
});

function showReviewError(msg) {
  resultBox.hidden = true;
  errorBox.textContent = msg;
  errorBox.hidden = false;
}

const nameInput = document.getElementById('review-name');
const emailInput = document.getElementById('review-email');

async function checkPayment() {
  const pid = idInput.value.trim().toUpperCase();
  idInput.value = pid;
  const name = nameInput.value.trim();
  const email = emailInput.value.trim();
  if (!/^RE-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(pid)) {
    showReviewError('Enter a POS ID like RE-XXXX-XXXX.');
    return;
  }
  if (!name) {
    showReviewError('Please add your name.');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    showReviewError('Please add a valid email address.');
    return;
  }
  errorBox.hidden = true;
  checkBtn.disabled = true;
  try {
    const res = await fetch('/api/track/' + encodeURIComponent(pid), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email }),
    });
    if (res.status === 404) return showReviewError('No payment found with that ID.');
    if (res.status === 503) return showReviewError('Tracking is not configured on this terminal.');
    if (!res.ok) return showReviewError('Lookup is unavailable right now \u2014 try again shortly.');
    const tx = await res.json();
    const [label, tone] = STATUS_VIEW[tx.status] || [tx.status, 'neutral'];
    const pill = document.getElementById('review-pill');
    pill.textContent = label;
    pill.className = 'review-pill ' + tone;
    document.getElementById('review-amount').textContent =
      (tx.amount_cents / 100).toLocaleString('en-US', { style: 'currency', currency: (tx.currency || 'usd').toUpperCase() });
    document.getElementById('review-created').textContent = new Date(tx.created_at).toLocaleString();
    document.getElementById('review-updated').textContent = new Date(tx.updated_at).toLocaleString();
    document.getElementById('review-note').textContent = tx.note || '\u2014';
    resultBox.hidden = false;
  } catch {
    showReviewError("Couldn't reach the server.");
  } finally {
    checkBtn.disabled = false;
  }
}

checkBtn.addEventListener('click', checkPayment);
[idInput, nameInput, emailInput].forEach((el) =>
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') checkPayment();
  })
);
