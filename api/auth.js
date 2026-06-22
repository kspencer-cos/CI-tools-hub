import crypto from 'crypto';

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

async function kvGet(key) {
  const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const json = await res.json();
  if (!json.result) return null;
  const parsed = JSON.parse(json.result);
  return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
}

async function kvSet(key, value) {
  await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(value)),
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const { action, email, password, token } = req.body || {};

  // ── LOGIN ──────────────────────────────────────────────────────────────────
  if (action === 'login') {
    if (!email || !password) return res.status(400).json({ ok: false, error: 'Email and password required' });

    const key = `user:${email.toLowerCase().trim()}`;
    const user = await kvGet(key);

    if (!user) return res.status(401).json({ ok: false, error: 'Invalid email or password' });
    if (!user.active) return res.status(403).json({ ok: false, error: 'Account inactive — contact your administrator' });
    if (user.passwordHash !== sha256(password)) return res.status(401).json({ ok: false, error: 'Invalid email or password' });

    // Issue a session token (24-hour expiry stored in KV)
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const sessionKey = `session:${sessionToken}`;
    await kvSet(sessionKey, { email: email.toLowerCase().trim(), name: user.name, tools: user.tools, gasUrl: user.gasUrl || null });
    // Set token to expire in 24h via KV TTL
    await fetch(`${KV_URL}/expire/${encodeURIComponent(sessionKey)}/86400`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });

    return res.status(200).json({ ok: true, token: sessionToken, name: user.name, tools: user.tools, gasUrl: user.gasUrl || null });
  }

  // ── VERIFY SESSION ─────────────────────────────────────────────────────────
  if (action === 'verify') {
    if (!token) return res.status(400).json({ ok: false, error: 'Token required' });
    const session = await kvGet(`session:${token}`);
    if (!session) return res.status(401).json({ ok: false, error: 'Session expired — please log in again' });
    return res.status(200).json({ ok: true, ...session });
  }

  return res.status(400).json({ ok: false, error: 'Unknown action' });
}
