// Local stand-in for an SMTP provider. Accepts every message and prints the
// envelope + subject, so you can test invoices, receipts, and notices with
// no real mail account.
//
// Usage:
//   1. node tools/mock-smtp.js        (listens on 127.0.0.1:2525)
//   2. In .env set:
//        SMTP_HOST=127.0.0.1
//        SMTP_PORT=2525
//        SMTP_SECURE=false
//        SMTP_IGNORE_TLS=true
//        MAIL_FROM="RetailEval <billing@example.test>"
//   3. npm start — sent mail appears in this window (and /tmp not required).

const { SMTPServer } = require('smtp-server');

const server = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onData(stream, session, callback) {
    let raw = '';
    stream.on('data', (chunk) => {
      if (raw.length < 200000) raw += chunk.toString('utf8');
    });
    stream.on('end', () => {
      const subject = (raw.match(/^Subject: (.*)$/m) || [])[1] || '(no subject)';
      const from = session.envelope.mailFrom ? session.envelope.mailFrom.address : '?';
      const to = session.envelope.rcptTo.map((r) => r.address).join(', ');
      console.log(`[mail] from=${from} to=${to} subject=${subject}`);
      callback();
    });
  },
});

const PORT = process.env.MOCK_SMTP_PORT || 2525;
server.listen(PORT, '127.0.0.1', () => console.log(`mock SMTP → 127.0.0.1:${PORT}`));
