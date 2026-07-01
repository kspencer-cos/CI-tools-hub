import crypto from 'crypto';

const KV_URL         = process.env.KV_REST_API_URL;
const KV_TOKEN       = process.env.KV_REST_API_TOKEN;
const WEBHOOK_SECRET  = process.env.GUMROAD_WEBHOOK_SECRET;
const SELLER_ID       = process.env.GUMROAD_SELLER_ID;

let PRODUCT_TOOL_MAP = {};
try {
  PRODUCT_TOOL_MAP = JSON.parse(process.env.GUMROAD_PRODUCT_TOOL_MAP || '{}');
} catch {
  PRODUCT_TOOL_MAP = {};
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

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

async function kvExpire(key, seconds) {
  await fetch(`${KV_URL}/expire/${encodeURIComponent(key)}/${seconds}`, {
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

async function addToIndex(id) {
  const idx = await getIndex();
  if (!idx.includes(id)) await kvSet(indexKey(), [...idx, id]);
}

function generateTempPassword() {
  return crypto.randomBytes(9).toString('base64url');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  if (!WEBHOOK_SECRET || !timingSafeEqual(req.query.secret || '', WEBHOOK_SECRET)) {
    return res.status(403).json({ ok: false, error: 'Unauthorized' });
  }

  const sale = req.body || {};
  const saleId = sale.sale_id || sale.id;
  if (!saleId) return res.status(400).json({ ok: false, error: 'Missing sale id' });

  try {
    // Gumroad retries pings that don't get a 2xx back, so dedupe by sale id.
    const dedupeKey = `gumroad:processed:${saleId}`;
    if (await kvGet(dedupeKey)) {
      return res.status(200).json({ ok: true, message: 'Already processed' });
    }

    if (SELLER_ID && sale.seller_id !== SELLER_ID) {
      return res.status(200).json({ ok: true, message: 'Ignored: seller_id mismatch' });
    }

    const email = (sale.email || '').toLowerCase().trim();
    const permalink = sale.product_permalink || sale.short_product_id || '';
    const tools = PRODUCT_TOOL_MAP[permalink];
    const isTest = sale.test === 'true' || sale.test === true;
    const isRefunded = sale.refunded === 'true' || sale.refunded === true;

    let status = 'ok';
    let flagReason = null;
    if (!email) {
      status = 'flagged'; flagReason = 'Missing email in payload';
    } else if (!tools) {
      status = 'flagged'; flagReason = `Unrecognized product permalink: ${permalink}`;
    } else if (isRefunded) {
      status = 'flagged'; flagReason = 'Marked refunded by Gumroad';
    }
    if (isTest) {
      status = 'flagged';
      flagReason = flagReason ? `${flagReason} (test sale)` : 'Test sale';
    }

    const tempPassword = generateTempPassword();

    // Only provision real, mapped, non-refunded, non-test sales.
    if (status === 'ok') {
      const userKey = `user:${email}`;
      const existing = await kvGet(userKey);
      await kvSet(userKey, {
        name: sale.full_name || email,
        email,
        passwordHash: sha256(tempPassword),
        tools,
        gasUrl: existing?.gasUrl || null,
        active: true,
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    await kvSet(itemKey(saleId), {
      id: saleId,
      name: sale.full_name || email || '(unknown)',
      email,
      tempPassword,
      tools: tools || [],
      product: sale.product_name || null,
      permalink,
      status,
      flagReason,
      createdAt: new Date().toISOString(),
    });
    await addToIndex(saleId);

    await kvSet(dedupeKey, true);
    await kvExpire(dedupeKey, 60 * 60 * 24 * 60); // 60 days

    return res.status(200).json({ ok: true, status });
  } catch (err) {
    console.error('gumroad-webhook error:', err);
    // Non-2xx so Gumroad retries — this path is for infra failures, not business-logic flags.
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
