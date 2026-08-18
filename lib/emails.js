// Transactional email templates. All three return { subject, html, text }.
// Design notes for deliverability: table-based layout with inline styles
// (what email clients actually render), a real plain-text alternative,
// no remote images, and plain professional wording — transactional copy,
// nothing that reads like marketing. The strongest anti-spam levers are
// outside this file: SPF, DKIM, and DMARC records on the sending domain,
// and a MAIL_FROM address on that same domain.

const esc = (s) =>
  String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = (cents, currency) =>
  (Number(cents) / 100).toLocaleString('en-US', { style: 'currency', currency: (currency || 'usd').toUpperCase() });

function shell(businessName, title, bodyRows) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#e8eaef;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e8eaef;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="width:480px;max-width:94%;background:#fafbfc;border-radius:14px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
<tr><td style="background:#23262d;padding:16px 28px;">
  <span style="color:#9aa1ac;font-size:12px;letter-spacing:4px;font-weight:bold;">${esc(businessName).toUpperCase()}</span>
</td></tr>
${bodyRows}
<tr><td style="padding:18px 28px 24px;border-top:1px solid #e3e6eb;">
  <p style="margin:0;color:#6b7280;font-size:12px;line-height:1.6;">
    Sent by ${esc(businessName)}. This is a transactional message about a payment.
    If you were not expecting it, you can reply to this email or simply disregard it.
  </p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function buildInvoiceEmail({ businessName, name, amountCents, currency, note, posId, payUrl }) {
  const amount = money(amountCents, currency);
  const subject = `Payment request from ${businessName} — ${amount}`;
  const html = shell(
    businessName,
    subject,
    `<tr><td style="padding:26px 28px 6px;">
  <h1 style="margin:0;font-size:20px;color:#14161b;">Payment request</h1>
  <p style="margin:10px 0 0;color:#6b7280;font-size:14px;line-height:1.6;">
    Hello ${esc(name)}, ${esc(businessName)} has requested the following payment.
  </p>
</td></tr>
<tr><td style="padding:16px 28px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f3;border-radius:10px;">
    <tr><td style="padding:16px 18px;">
      <span style="display:block;color:#6b7280;font-size:12px;letter-spacing:1px;">AMOUNT DUE</span>
      <span style="display:block;color:#14161b;font-size:28px;font-family:'Courier New',monospace;font-weight:bold;margin-top:4px;">${esc(amount)}</span>
    </td></tr>
  </table>
</td></tr>
<tr><td style="padding:14px 28px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#14161b;">
    ${note ? `<tr><td style="padding:6px 0;color:#6b7280;">For</td><td align="right" style="padding:6px 0;">${esc(note)}</td></tr>` : ''}
    <tr><td style="padding:6px 0;color:#6b7280;">Reference</td><td align="right" style="padding:6px 0;font-family:'Courier New',monospace;">${esc(posId)}</td></tr>
  </table>
</td></tr>
<tr><td style="padding:20px 28px 26px;" align="center">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="background:#2e6be6;border-radius:10px;">
      <a href="${esc(payUrl)}" style="display:inline-block;padding:13px 34px;color:#ffffff;font-size:15px;font-weight:bold;text-decoration:none;">Pay ${esc(amount)}</a>
    </td>
  </tr></table>
  <p style="margin:12px 0 0;color:#6b7280;font-size:12px;">The secure payment page is provided by Stripe.</p>
</td></tr>`
  );
  const text = [
    `Payment request from ${businessName}`,
    ``,
    `Hello ${name},`,
    `${businessName} has requested a payment of ${amount}.`,
    note ? `For: ${note}` : null,
    `Reference: ${posId}`,
    ``,
    `Pay securely here: ${payUrl}`,
    ``,
    `Sent by ${businessName}. If you were not expecting this, you can disregard it.`,
  ]
    .filter((l) => l !== null)
    .join('\n');
  return { subject, html, text };
}

function buildReceiptEmail({ businessName, name, amountCents, currency, note, posId, status, paidAt }) {
  const amount = money(amountCents, currency);
  const when = new Date(paidAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const label = status === 'refunded' ? 'Refunded' : 'Approved';
  const subject = `Receipt from ${businessName} — ${amount}`;
  const line = (k, v, mono) =>
    `<tr><td style="padding:7px 0;color:#6b7280;border-bottom:1px solid #eef0f3;">${esc(k)}</td>
     <td align="right" style="padding:7px 0;color:#14161b;border-bottom:1px solid #eef0f3;${mono ? "font-family:'Courier New',monospace;" : ''}">${esc(v)}</td></tr>`;
  const html = shell(
    businessName,
    subject,
    `<tr><td style="padding:26px 28px 4px;" align="center">
  <h1 style="margin:0;font-size:20px;color:#14161b;">Payment receipt</h1>
  <p style="margin:8px 0 0;font-size:13px;letter-spacing:2px;color:${status === 'refunded' ? '#b06f0c' : '#1a9a62'};font-weight:bold;">${label.toUpperCase()}</p>
</td></tr>
<tr><td style="padding:14px 28px 8px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
    ${line('Billed to', name || '—')}
    ${line('Date', when)}
    ${line('Reference', posId, true)}
    ${note ? line('For', note) : ''}
    ${line('Amount', amount, true)}
  </table>
</td></tr>
<tr><td style="padding:8px 28px 24px;">
  <p style="margin:0;color:#6b7280;font-size:12px;line-height:1.6;">
    Keep this receipt for your records. To print a paper copy, use your email
    client's print option — this layout is print-friendly.
  </p>
</td></tr>`
  );
  const text = [
    `Payment receipt from ${businessName} — ${label}`,
    ``,
    `Billed to: ${name || '—'}`,
    `Date: ${when}`,
    `Reference: ${posId}`,
    note ? `For: ${note}` : null,
    `Amount: ${amount}`,
    ``,
    `Keep this receipt for your records.`,
  ]
    .filter((l) => l !== null)
    .join('\n');
  return { subject, html, text };
}

function buildNoticeEmail({ businessName, name, subjectLine, message }) {
  const subject = subjectLine;
  const html = shell(
    businessName,
    subject,
    `<tr><td style="padding:26px 28px 24px;">
  <h1 style="margin:0;font-size:20px;color:#14161b;">${esc(subjectLine)}</h1>
  <p style="margin:12px 0 0;color:#14161b;font-size:14px;line-height:1.7;white-space:pre-line;">${esc(message)}</p>
  <p style="margin:16px 0 0;color:#6b7280;font-size:12px;">
    You are receiving this because you have a payment record with ${esc(businessName)}.
  </p>
</td></tr>`
  );
  const text = `${subjectLine}\n\n${message}\n\nYou are receiving this because you have a payment record with ${businessName}.`;
  return { subject, html, text };
}

module.exports = { buildInvoiceEmail, buildReceiptEmail, buildNoticeEmail };
