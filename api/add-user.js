import crypto from 'crypto';

const KV_URL    = process.env.KV_REST_API_URL;
const KV_TOKEN  = process.env.KV_REST_API_TOKEN;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

async function kvSet(key, value) {
  await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(value)),
  });
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

// Valid tool IDs
const VALID_TOOLS = ['cos', 'reviews', 'notes', 'management', 'library', 'flepic'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const { secret, action, email, password, name, tools, gasUrl, active } = req.body || {};

  if (secret !== ADMIN_SECRET) return res.status(403).json({ ok: false, error: 'Unauthorized' });

  const normalizedEmail = (email || '').toLowerCase().trim();
  if (!normalizedEmail) return res.status(400).json({ ok: false, error: 'Email required' });

  const key = `user:${normalizedEmail}`;

  // ── ADD / UPDATE USER ──────────────────────────────────────────────────────
  if (action === 'upsert') {
    if (!name) return res.status(400).json({ ok: false, error: 'Name required' });
    if (!tools || !tools.length) return res.status(400).json({ ok: false, error: 'At least one tool required' });
    if (tools.some(t => !VALID_TOOLS.includes(t))) return res.status(400).json({ ok: false, error: `Invalid tool. Valid: ${VALID_TOOLS.join(', ')}` });

    const existing = await kvGet(key);
    const passwordHash = password ? sha256(password) : existing?.passwordHash;
    if (!passwordHash) return res.status(400).json({ ok: false, error: 'Password required for new users' });

    await kvSet(key, {
      name,
      email: normalizedEmail,
      passwordHash,
      tools,
      gasUrl: gasUrl || null,
      active: active !== false,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    return res.status(200).json({ ok: true, message: `User ${normalizedEmail} saved` });
  }

  // ── DEACTIVATE USER ────────────────────────────────────────────────────────
  if (action === 'deactivate') {
    const existing = await kvGet(key);
    if (!existing) return res.status(404).json({ ok: false, error: 'User not found' });
    await kvSet(key, { ...existing, active: false, updatedAt: new Date().toISOString() });
    return res.status(200).json({ ok: true, message: `User ${normalizedEmail} deactivated` });
  }

  // ── GET USER ───────────────────────────────────────────────────────────────
  if (action === 'get') {
    const user = await kvGet(key);
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
    const { passwordHash: _, ...safe } = user;
    return res.status(200).json({ ok: true, user: safe });
  }

  return res.status(400).json({ ok: false, error: 'Unknown action' });
}
