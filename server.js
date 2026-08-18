require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const nodemailer = require('nodemailer');
const path = require('path');
const { buildInvoiceEmail, buildReceiptEmail, buildNoticeEmail } = require('./lib/emails');

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('\nMissing STRIPE_SECRET_KEY. Copy .env.example to .env and add your key.\n');
  process.exit(1);
}

const stripe = require('stripe')(key);
const app = express();

const PORT = process.env.PORT || 4242;
const DOMAIN = process.env.DOMAIN || `http://localhost:${PORT}`;
const CURRENCY = (process.env.CURRENCY || 'usd').toLowerCase();
const MIN_AMOUNT = Number(process.env.MIN_AMOUNT || 1);
const MAX_AMOUNT = Number(process.env.MAX_AMOUNT || 500000);
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'RetailEval';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

// ---- Cloudflare D1 ------------------------------------------------------
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '';
const CF_D1_DATABASE_ID = process.env.CF_D1_DATABASE_ID || '';
const CF_API_TOKEN = process.env.CF_API_TOKEN || '';
const CF_API_BASE = process.env.CF_API_BASE || 'https://api.cloudflare.com';
const LOGGING = Boolean(CF_ACCOUNT_ID && CF_D1_DATABASE_ID && CF_API_TOKEN);

// ---- SMTP ---------------------------------------------------------------
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_IGNORE_TLS = process.env.SMTP_IGNORE_TLS === 'true';
const MAIL_FROM = process.env.MAIL_FROM || '';
const MAILING = Boolean(SMTP_HOST && MAIL_FROM);

let mailer = null;
if (MAILING) {
  mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    ...(SMTP_USER ? { auth: { user: SMTP_USER, pass: SMTP_PASS } } : {}),
    ...(SMTP_IGNORE_TLS ? { ignoreTLS: true } : {}),
  });
}

async function sendMail(to, tpl) {
  if (!MAILING) throw new Error('mail not configured');
  await mailer.sendMail({ from: MAIL_FROM, to, subject: tpl.subject, text: tpl.text, html: tpl.html });
}

// ---- Admin --------------------------------------------------------------
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';

// ---- Helpers ------------------------------------------------------------
const POS_ID_RE = /^RE-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const nowIso = () => new Date().toISOString();
const jsonBody = express.json({ limit: '100kb' });

function newPosId() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (const b of bytes) s += A[b % A.length];
  return `RE-${s.slice(0, 4)}-${s.slice(4)}`;
}

async function d1(sql, params = []) {
  if (!LOGGING) throw new Error('D1 not configured');
  const url = `${CF_API_BASE}/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_D1_DATABASE_ID}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params: params.map((p) => (p === null ? null : String(p))) }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.success !== true) {
    throw new Error(`D1 ${res.status}: ${JSON.stringify(data && data.errors)}`);
  }
  return data.result[0] || { results: [] };
}

async function tryD1(sql, params) {
  if (!LOGGING) return;
  try {
    await d1(sql, params);
  } catch (err) {
    console.error('[d1]', err.message);
  }
}

async function initDb() {
  // Each statement runs on its own: D1 executes multi-statement batches
  // transactionally, so one failure would roll back everything else.
  const create = [
    `CREATE TABLE IF NOT EXISTS transactions (
       id TEXT PRIMARY KEY,
       stripe_session_id TEXT,
       payment_intent TEXT,
       amount_cents INTEGER NOT NULL,
       currency TEXT NOT NULL,
       note TEXT,
       status TEXT NOT NULL,
       kind TEXT DEFAULT 'terminal',
       customer_name TEXT,
       customer_email TEXT,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS contacts (
       email TEXT PRIMARY KEY,
       name TEXT,
       last_pos_id TEXT,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status)`,
  ];
  for (const sql of create) await d1(sql);

  // Upgrade tables created by earlier versions. "duplicate column" just
  // means the column already exists — that's fine.
  const migrations = [
    `ALTER TABLE transactions ADD COLUMN payment_intent TEXT`,
    `ALTER TABLE transactions ADD COLUMN kind TEXT DEFAULT 'terminal'`,
    `ALTER TABLE transactions ADD COLUMN customer_name TEXT`,
    `ALTER TABLE transactions ADD COLUMN customer_email TEXT`,
  ];
  for (const m of migrations) {
    try {
      await d1(m);
    } catch (err) {
      if (!/duplicate column/i.test(err.message)) console.error('[d1 migrate]', err.message);
    }
  }

  // Only after payment_intent is guaranteed to exist.
  await d1(`CREATE INDEX IF NOT EXISTS idx_tx_pi ON transactions(payment_intent)`);
}

async function getTx(pid) {
  const r = await d1(`SELECT * FROM transactions WHERE id = ?`, [pid]);
  return (r.results && r.results[0]) || null;
}

async function upsertContact(email, name, posId) {
  const t = nowIso();
  await tryD1(
    `INSERT INTO contacts (email, name, last_pos_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       name = excluded.name,
       last_pos_id = COALESCE(excluded.last_pos_id, contacts.last_pos_id),
       updated_at = excluded.updated_at`,
    [email, name, posId || null, t, t]
  );
}

async function reconcile(row) {
  if (!row || !row.stripe_session_id) return row;
  if (!['pending', 'processing'].includes(row.status)) return row;
  try {
    const s = await stripe.checkout.sessions.retrieve(row.stripe_session_id);
    let next = row.status;
    if (s.status === 'complete') next = s.payment_status === 'paid' ? 'succeeded' : 'processing';
    else if (s.status === 'expired') next = 'expired';
    if (next !== row.status) {
      const t = nowIso();
      await tryD1(`UPDATE transactions SET status = ?, updated_at = ? WHERE id = ?`, [next, t, row.id]);
      row.status = next;
      row.updated_at = t;
    }
  } catch (err) {
    console.error('[reconcile]', err.message);
  }
  return row;
}

function parseAmount(raw) {
  const cleaned = String(raw || '').replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  if (value < MIN_AMOUNT || value > MAX_AMOUNT) return null;
  return Math.round(value * 100);
}

function cleanText(raw, max) {
  return String(raw || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}
const cleanNote = (raw) => cleanText(raw, 120);
const cleanName = (raw) => cleanText(raw, 80);

function validEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  if (e.length > 254) return null;
  return /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null;
}

function trackPayload(row) {
  return {
    id: row.id,
    status: row.status,
    amount_cents: Number(row.amount_cents),
    currency: row.currency,
    note: row.note || '',
    customer_name: row.customer_name || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function adminAuth(req, res, next) {
  if (!ADMIN_USER || !ADMIN_PASS) {
    return res.status(503).send('Admin is disabled: set ADMIN_USER and ADMIN_PASS in the environment.');
  }
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const raw = Buffer.from(encoded, 'base64').toString();
    const idx = raw.indexOf(':');
    const user = idx >= 0 ? raw.slice(0, idx) : raw;
    const pass = idx >= 0 ? raw.slice(idx + 1) : '';
    if (safeEqual(user, ADMIN_USER) && safeEqual(pass, ADMIN_PASS)) return next();
  }
  res
    .set('WWW-Authenticate', 'Basic realm="RetailEval Admin", charset="UTF-8"')
    .status(401)
    .send('Authentication required');
}

// ---- Stripe session builder (shared by terminal + invoices) -------------
function buildSession(pid, cents, note, extra = {}) {
  return {
    mode: 'payment',
    submit_type: 'pay',
    client_reference_id: pid,
    metadata: { pos_id: pid },
    line_items: [
      {
        price_data: {
          currency: CURRENCY,
          product_data: {
            name: `${BUSINESS_NAME} payment`,
            description: note || 'Point-of-sale payment',
          },
          unit_amount: cents,
        },
        quantity: 1,
      },
    ],
    success_url: `${DOMAIN}/pay/return?pid=${pid}&sid={CHECKOUT_SESSION_ID}`,
    cancel_url: `${DOMAIN}/pay/cancel?pid=${pid}`,
    ...extra,
  };
}

// ---- Webhook (raw body, must not go through other parsers) --------------
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!STRIPE_WEBHOOK_SECRET) return res.status(503).send('STRIPE_WEBHOOK_SECRET not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send('signature verification failed');
  }
  try {
    await handleStripeEvent(event);
  } catch (err) {
    console.error('[webhook]', err.message);
  }
  res.json({ received: true });
});

async function handleStripeEvent(event) {
  const obj = event.data.object;
  const t = nowIso();
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const pid = obj.client_reference_id;
      if (!pid) return;
      const paid = event.type === 'checkout.session.async_payment_succeeded' || obj.payment_status === 'paid';
      const details = obj.customer_details || {};
      await tryD1(
        `UPDATE transactions SET
           status = ?,
           payment_intent = COALESCE(?, payment_intent),
           customer_email = COALESCE(customer_email, ?),
           customer_name = COALESCE(customer_name, ?),
           updated_at = ?
         WHERE id = ? AND status IN ('pending','processing')`,
        [paid ? 'succeeded' : 'processing', obj.payment_intent || null, validEmail(details.email), cleanName(details.name) || null, t, pid]
      );
      return;
    }
    case 'checkout.session.async_payment_failed': {
      const pid = obj.client_reference_id;
      if (!pid) return;
      await tryD1(
        `UPDATE transactions SET status = 'failed', updated_at = ? WHERE id = ? AND status IN ('pending','processing')`,
        [t, pid]
      );
      return;
    }
    case 'checkout.session.expired': {
      const pid = obj.client_reference_id;
      if (!pid) return;
      await tryD1(`UPDATE transactions SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'`, [t, pid]);
      return;
    }
    case 'charge.refunded': {
      const pi = obj.payment_intent;
      if (!pi) return;
      await tryD1(`UPDATE transactions SET status = 'refunded', updated_at = ? WHERE payment_intent = ? AND status = 'succeeded'`, [t, pi]);
      return;
    }
    default:
      return;
  }
}

// ---- Standard middleware ------------------------------------------------
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- Terminal charge ----------------------------------------------------
app.post('/create-checkout-session', async (req, res) => {
  const cents = parseAmount(req.body.amount);
  if (cents === null) return res.redirect(303, '/?error=amount');

  const note = cleanNote(req.body.note);
  const pid = newPosId();
  const t = nowIso();

  await tryD1(
    `INSERT INTO transactions (id, stripe_session_id, amount_cents, currency, note, status, kind, created_at, updated_at)
     VALUES (?, NULL, ?, ?, ?, 'pending', 'terminal', ?, ?)`,
    [pid, cents, CURRENCY, note, t, t]
  );

  try {
    const session = await stripe.checkout.sessions.create(buildSession(pid, cents, note), {
      idempotencyKey: `cks_${pid}`,
    });
    await tryD1(`UPDATE transactions SET stripe_session_id = ?, updated_at = ? WHERE id = ?`, [session.id, nowIso(), pid]);
    res.redirect(303, session.url);
  } catch (err) {
    console.error('Stripe error:', err.message);
    await tryD1(`UPDATE transactions SET status = 'failed', updated_at = ? WHERE id = ?`, [nowIso(), pid]);
    res.redirect(303, '/?error=stripe');
  }
});

// ---- Invoice payment link (from emails) ---------------------------------
const REPAYABLE = ['pending', 'canceled', 'expired', 'failed'];

app.get('/pay/invoice/:pid', async (req, res) => {
  if (!LOGGING) return res.redirect('/');
  const pid = String(req.params.pid || '').toUpperCase();
  if (!POS_ID_RE.test(pid)) return res.redirect('/');
  try {
    const row = await getTx(pid);
    if (!row || row.kind !== 'invoice') return res.redirect('/');
    if (row.status === 'succeeded' || row.status === 'refunded') {
      return res.redirect(`/success.html?pid=${pid}&st=succeeded`);
    }
    if (row.status === 'processing') {
      return res.redirect(`/success.html?pid=${pid}&st=processing`);
    }
    if (!REPAYABLE.includes(row.status)) return res.redirect('/');

    const session = await stripe.checkout.sessions.create(
      buildSession(pid, Number(row.amount_cents), row.note || '', {
        ...(row.customer_email ? { customer_email: row.customer_email } : {}),
      })
    );
    await tryD1(`UPDATE transactions SET stripe_session_id = ?, status = 'pending', updated_at = ? WHERE id = ?`, [
      session.id,
      nowIso(),
      pid,
    ]);
    res.redirect(303, session.url);
  } catch (err) {
    console.error('[invoice pay]', err.message);
    res.redirect('/?error=stripe');
  }
});

// ---- Return + cancel from Stripe ----------------------------------------
app.get('/pay/return', async (req, res) => {
  const pid = String(req.query.pid || '').toUpperCase();
  const sid = String(req.query.sid || '');
  if (!POS_ID_RE.test(pid) || !sid) return res.redirect('/');

  let status = 'processing';
  try {
    const s = await stripe.checkout.sessions.retrieve(sid);
    if (s.client_reference_id !== pid) return res.redirect('/');
    if (s.status === 'complete') status = s.payment_status === 'paid' ? 'succeeded' : 'processing';
    else if (s.status === 'expired') status = 'expired';
    else return res.redirect('/');
  } catch (err) {
    console.error('[return]', err.message);
  }

  await tryD1(
    `UPDATE transactions SET status = ?, updated_at = ? WHERE id = ? AND status IN ('pending','processing')`,
    [status, nowIso(), pid]
  );

  if (status === 'expired') return res.redirect(`/cancel.html?pid=${pid}&st=expired`);
  res.redirect(`/success.html?pid=${pid}&st=${status}`);
});

app.get('/pay/cancel', async (req, res) => {
  const pid = String(req.query.pid || '').toUpperCase();
  if (!POS_ID_RE.test(pid)) return res.redirect('/');
  await tryD1(`UPDATE transactions SET status = 'canceled', updated_at = ? WHERE id = ? AND status = 'pending'`, [
    nowIso(),
    pid,
  ]);
  res.redirect(`/cancel.html?pid=${pid}`);
});

// ---- Tracking -----------------------------------------------------------
// GET: used by the receipt pages (possession of the ID is the credential).
app.get('/api/track/:pid', async (req, res) => {
  if (!LOGGING) return res.status(503).json({ error: 'tracking-disabled' });
  const pid = String(req.params.pid || '').toUpperCase();
  if (!POS_ID_RE.test(pid)) return res.status(400).json({ error: 'bad-id' });
  try {
    let row = await getTx(pid);
    if (!row) return res.status(404).json({ error: 'not-found' });
    row = await reconcile(row);
    res.json(trackPayload(row));
  } catch (err) {
    console.error('[track]', err.message);
    res.status(502).json({ error: 'store-unavailable' });
  }
});

// POST: used by the Payment review panel — records who looked it up.
app.post('/api/track/:pid', jsonBody, async (req, res) => {
  if (!LOGGING) return res.status(503).json({ error: 'tracking-disabled' });
  const pid = String(req.params.pid || '').toUpperCase();
  if (!POS_ID_RE.test(pid)) return res.status(400).json({ error: 'bad-id' });
  const name = cleanName(req.body && req.body.name);
  const email = validEmail(req.body && req.body.email);
  if (!name || !email) return res.status(400).json({ error: 'name-email-required' });
  try {
    let row = await getTx(pid);
    if (!row) return res.status(404).json({ error: 'not-found' });
    await upsertContact(email, name, pid);
    row = await reconcile(row);
    res.json(trackPayload(row));
  } catch (err) {
    console.error('[track]', err.message);
    res.status(502).json({ error: 'store-unavailable' });
  }
});

// ---- Admin: page, logout ------------------------------------------------
app.get('/admin', adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

// Best-effort Basic-auth logout: answering 401 makes browsers drop the
// cached credentials for this realm.
app.get('/admin/logout', (req, res) => {
  res
    .set('WWW-Authenticate', 'Basic realm="RetailEval Admin", charset="UTF-8"')
    .status(401)
    .send('Logged out.');
});

// ---- Admin: data --------------------------------------------------------
app.get('/api/admin/summary', adminAuth, async (req, res) => {
  if (!LOGGING) return res.status(503).json({ error: 'logging-disabled' });
  try {
    const r = await d1(
      `SELECT status, COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS amount_cents
       FROM transactions GROUP BY status`
    );
    const by_status = {};
    for (const row of r.results || []) {
      by_status[row.status] = { count: Number(row.count), amount_cents: Number(row.amount_cents) };
    }
    const g = (s) => by_status[s] || { count: 0, amount_cents: 0 };
    res.json({
      currency: CURRENCY,
      by_status,
      totals: {
        collected_cents: g('succeeded').amount_cents,
        succeeded: g('succeeded').count,
        processing: g('processing').count,
        pending: g('pending').count,
        canceled: g('canceled').count,
        failed: g('failed').count + g('expired').count,
        refunded: g('refunded').count,
      },
    });
  } catch (err) {
    console.error('[summary]', err.message);
    res.status(502).json({ error: 'store-unavailable' });
  }
});

const STATUSES = ['pending', 'processing', 'succeeded', 'canceled', 'failed', 'expired', 'refunded'];

app.get('/api/admin/transactions', adminAuth, async (req, res) => {
  if (!LOGGING) return res.status(503).json({ error: 'logging-disabled' });
  const status = STATUSES.includes(req.query.status) ? req.query.status : null;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  try {
    const sql = status
      ? `SELECT * FROM transactions WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
      : `SELECT * FROM transactions ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const params = status ? [status, limit, offset] : [limit, offset];
    const r = await d1(sql, params);
    res.json({ transactions: r.results || [], limit, offset });
  } catch (err) {
    console.error('[transactions]', err.message);
    res.status(502).json({ error: 'store-unavailable' });
  }
});

app.get('/api/admin/contacts', adminAuth, async (req, res) => {
  if (!LOGGING) return res.status(503).json({ error: 'logging-disabled' });
  try {
    const r = await d1(`SELECT * FROM contacts ORDER BY updated_at DESC LIMIT 500`);
    res.json({ contacts: r.results || [] });
  } catch (err) {
    console.error('[contacts]', err.message);
    res.status(502).json({ error: 'store-unavailable' });
  }
});

// ---- Admin: create + email an invoice -----------------------------------
app.post('/api/admin/invoices', adminAuth, jsonBody, async (req, res) => {
  if (!LOGGING) return res.status(503).json({ error: 'logging-disabled' });
  const name = cleanName(req.body && req.body.name);
  const email = validEmail(req.body && req.body.email);
  const cents = parseAmount(req.body && req.body.amount);
  const note = cleanNote(req.body && req.body.note);
  if (!name) return res.status(400).json({ error: 'name-required' });
  if (!email) return res.status(400).json({ error: 'valid-email-required' });
  if (cents === null) return res.status(400).json({ error: 'bad-amount' });

  const pid = newPosId();
  const t = nowIso();
  try {
    await d1(
      `INSERT INTO transactions (id, amount_cents, currency, note, status, kind, customer_name, customer_email, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 'invoice', ?, ?, ?, ?)`,
      [pid, cents, CURRENCY, note, name, email, t, t]
    );
  } catch (err) {
    console.error('[invoice]', err.message);
    return res.status(502).json({ error: 'store-unavailable' });
  }
  await upsertContact(email, name, pid);

  let emailed = false;
  let mail_error;
  if (MAILING) {
    try {
      await sendMail(
        email,
        buildInvoiceEmail({
          businessName: BUSINESS_NAME,
          name,
          amountCents: cents,
          currency: CURRENCY,
          note,
          posId: pid,
          payUrl: `${DOMAIN}/pay/invoice/${pid}`,
        })
      );
      emailed = true;
    } catch (err) {
      console.error('[mail]', err.message);
      mail_error = 'send-failed';
    }
  } else {
    mail_error = 'mail-not-configured';
  }
  res.json({ id: pid, emailed, mail_error, pay_url: `${DOMAIN}/pay/invoice/${pid}` });
});

// ---- Admin: email a printable receipt for a transaction -----------------
app.post('/api/admin/transactions/:pid/receipt', adminAuth, jsonBody, async (req, res) => {
  if (!LOGGING) return res.status(503).json({ error: 'logging-disabled' });
  if (!MAILING) return res.status(503).json({ error: 'mail-not-configured' });
  const pid = String(req.params.pid || '').toUpperCase();
  if (!POS_ID_RE.test(pid)) return res.status(400).json({ error: 'bad-id' });
  try {
    const row = await getTx(pid);
    if (!row) return res.status(404).json({ error: 'not-found' });
    if (!['succeeded', 'refunded'].includes(row.status)) return res.status(400).json({ error: 'not-paid' });
    const email = validEmail(req.body && req.body.email) || validEmail(row.customer_email);
    if (!email) return res.status(400).json({ error: 'no-email' });
    await sendMail(
      email,
      buildReceiptEmail({
        businessName: BUSINESS_NAME,
        name: row.customer_name || '',
        amountCents: Number(row.amount_cents),
        currency: row.currency,
        note: row.note || '',
        posId: row.id,
        status: row.status,
        paidAt: row.updated_at,
      })
    );
    if (row.customer_name) await upsertContact(email, row.customer_name, pid);
    res.json({ sent: true, to: email });
  } catch (err) {
    console.error('[receipt]', err.message);
    res.status(502).json({ error: 'send-failed' });
  }
});

// ---- Admin: notice to all contacts or a selection -----------------------
app.post('/api/admin/notify', adminAuth, jsonBody, async (req, res) => {
  if (!LOGGING) return res.status(503).json({ error: 'logging-disabled' });
  if (!MAILING) return res.status(503).json({ error: 'mail-not-configured' });
  const subjectLine = cleanText(req.body && req.body.subject, 120);
  const message = cleanText(req.body && req.body.message, 2000);
  if (!subjectLine || !message) return res.status(400).json({ error: 'subject-message-required' });

  let recipients = [];
  try {
    if (req.body.emails === 'all') {
      const r = await d1(`SELECT email, name FROM contacts ORDER BY updated_at DESC LIMIT 500`);
      recipients = r.results || [];
    } else if (Array.isArray(req.body.emails)) {
      const wanted = [...new Set(req.body.emails.map(validEmail).filter(Boolean))].slice(0, 100);
      if (wanted.length) {
        const marks = wanted.map(() => '?').join(',');
        const r = await d1(`SELECT email, name FROM contacts WHERE email IN (${marks})`, wanted);
        recipients = r.results || [];
      }
    }
  } catch (err) {
    console.error('[notify]', err.message);
    return res.status(502).json({ error: 'store-unavailable' });
  }
  if (!recipients.length) return res.status(400).json({ error: 'no-recipients' });

  let sent = 0;
  const failed = [];
  for (const c of recipients) {
    try {
      await sendMail(
        c.email,
        buildNoticeEmail({ businessName: BUSINESS_NAME, name: c.name || '', subjectLine, message })
      );
      sent++;
    } catch (err) {
      console.error('[notify send]', c.email, err.message);
      failed.push(c.email);
    }
  }
  res.json({ sent, failed });
});

// ---- Boot ---------------------------------------------------------------
app.listen(PORT, async () => {
  console.log(`${BUSINESS_NAME} terminal ready → http://localhost:${PORT}`);
  if (!LOGGING) console.warn('[d1] not configured — logging, tracking, invoices, and admin data are disabled.');
  else {
    try {
      await initDb();
      console.log('[d1] connected — tables ready.');
    } catch (err) {
      console.error('[d1] init failed (will keep retrying per-query):', err.message);
    }
  }
  if (!MAILING) console.warn('[mail] SMTP_HOST / MAIL_FROM not set — invoice, receipt, and notice emails are disabled.');
  else console.log(`[mail] SMTP ready via ${SMTP_HOST}:${SMTP_PORT}`);
  if (!ADMIN_USER || !ADMIN_PASS) console.warn('[admin] ADMIN_USER / ADMIN_PASS not set — /admin is disabled.');
  if (!STRIPE_WEBHOOK_SECRET) console.warn('[webhook] STRIPE_WEBHOOK_SECRET not set — /webhooks/stripe is disabled; statuses update via return/lookup only.');
});
