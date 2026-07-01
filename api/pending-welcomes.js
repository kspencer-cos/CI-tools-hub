import crypto from 'crypto';

const KV_URL       = process.env.KV_REST_API_URL;
const KV_TOKEN     = process.env.KV_REST_API_TOKEN;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
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

async function kvDel(key) {
  await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
}

function indexKey() { return 'pending:index'; }
function itemKey(id) { return `pending:item:${id}`; }

async function getIndex() {
  const idx = await kvGet(indexKey());
  return Array.isArray(idx) ? idx : [];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const secret = req.method === 'GET' ? req.query.secret : (req.body || {}).secret;
  if (!ADMIN_SECRET || !timingSafeEqual(secret || '', ADMIN_SECRET)) {
    return res.status(403).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    if (req.method === 'GET') {
      const ids = await getIndex();
      const items = await Promise.all(ids.map(id => kvGet(itemKey(id))));
      const pending = items
        .filter(Boolean)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return res.status(200).json({ ok: true, pending });
    }

    if (req.method === 'POST') {
      const { action, id } = req.body || {};

      if (action === 'clear') {
        const currentIds = await getIndex();
        const idsToClear = id ? currentIds.filter(existingId => existingId === id) : currentIds;
        await Promise.all(idsToClear.map(itemId => kvDel(itemKey(itemId))));
        const remaining = id ? currentIds.filter(existingId => existingId !== id) : [];
        await kvSet(indexKey(), remaining);
        return res.status(200).json({ ok: true, cleared: idsToClear.length });
      }

      return res.status(400).json({ ok: false, error: 'Unknown action' });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('pending-welcomes error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
