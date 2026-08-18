// Local stand-in for the Cloudflare D1 REST API, backed by Node's built-in
// SQLite. Lets you run and test the full terminal (logging, tracking, admin)
// with no Cloudflare account.
//
// Usage:
//   1. node tools/mock-d1.js            (starts on http://127.0.0.1:8787)
//   2. In .env set:
//        CF_API_BASE=http://127.0.0.1:8787
//        CF_ACCOUNT_ID=local
//        CF_D1_DATABASE_ID=local
//        CF_API_TOKEN=local
//   3. npm start
// Remove CF_API_BASE (or point it back to https://api.cloudflare.com) for
// the real database.

const { DatabaseSync } = require('node:sqlite');
const express = require('express');

const db = new DatabaseSync(process.env.MOCK_D1_FILE || ':memory:');
const app = express();
app.use(express.json());

app.post('/client/v4/accounts/:acc/d1/database/:db/query', (req, res) => {
  const { sql, params = [] } = req.body || {};
  try {
    const statements = String(sql || '').split(';').map((s) => s.trim()).filter(Boolean);
    let results = [];
    for (const st of statements) {
      if (/^select/i.test(st)) results = db.prepare(st).all(...params);
      else if (params.length && statements.length === 1) db.prepare(st).run(...params);
      else db.exec(st);
    }
    res.json({ success: true, result: [{ success: true, results, meta: {} }], errors: [], messages: [] });
  } catch (err) {
    res.json({ success: false, result: [], errors: [{ code: 7500, message: err.message }], messages: [] });
  }
});

const PORT = process.env.MOCK_D1_PORT || 8787;
app.listen(PORT, () => console.log(`mock D1 → http://127.0.0.1:${PORT}`));
