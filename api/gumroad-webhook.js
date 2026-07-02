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
function subscriptionIndexKey(subscriptionId) { return `subscription:${subscriptionId}`; }

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

// resource_name: "sale" (or absent, from the plain Ping URL) — a new purchase or trial start.
async function handleSale(sale, res) {
  const saleId = sale.sale_id || sale.id;
  if (!saleId) return res.status(400).json({ ok: false, error: 'Missing sale id' });

  // Gumroad retries pings that don't get a 2xx back, so dedupe by sale id.
  const dedupeKey = `gumroad:processed:${saleId}`;
  if (await kvGet(dedupeKey)) {
    return res.status(200).json({ ok: true, message: 'Already processed' });
  }

  const email = (sale.email || '').toLowerCase().trim();
  const permalink = sale.product_permalink || sale.short_product_id || '';
  const tools = PRODUCT_TOOL_MAP[permalink];
  const isTest = sale.test === 'true' || sale.test === true;
  const isRefunded = sale.refunded === 'true' || sale.refunded === true;
  const subscriptionId = sale.subscription_id || null;

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
      subscriptionId: subscriptionId || existing?.subscriptionId || null,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // Lets subscription_ended/cancellation pings (which carry subscription_id, not email) find this account.
    if (subscriptionId) await kvSet(subscriptionIndexKey(subscriptionId), { email });
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
}

// resource_name: "subscription_ended" — the actual moment access should stop
// (trial expired without conversion, cancelled subscription reached period end, etc).
// Requires registering this resource_name via the Gumroad resource_subscriptions API;
// the plain Settings > Advanced Ping URL only ever sends "sale".
async function handleSubscriptionEnded(payload, res) {
  const subscriptionId = payload.subscription_id || payload.id;
  if (!subscriptionId) return res.status(400).json({ ok: false, error: 'Missing subscription id' });

  const subRecord = await kvGet(subscriptionIndexKey(subscriptionId));
  const email = subRecord?.email || null;
  let matched = false;
  if (email) {
    const userKey = `user:${email}`;
    const existing = await kvGet(userKey);
    if (existing) {
      matched = true;
      if (existing.active) {
        await kvSet(userKey, { ...existing, active: false, updatedAt: new Date().toISOString() });
      }
    }
  }

  const id = `revoked-${subscriptionId}`;
  await kvSet(itemKey(id), {
    id,
    name: email || '(unknown)',
    email: email || null,
    tempPassword: null,
    tools: [],
    product: payload.product_name || null,
    permalink: payload.product_permalink || null,
    status: 'revoked',
    flagReason: matched
      ? 'Subscription ended — access revoked'
      : `Subscription ended for unrecognized subscription_id ${subscriptionId} (no matching account — check manually)`,
    createdAt: new Date().toISOString(),
  });
  await addToIndex(id);

  return res.status(200).json({ ok: true, status: 'revoked', matched });
}

// resource_name: "cancellation" — customer requested cancellation; access typically
// continues until the current period ends, where subscription_ended will fire. This
// branch is informational only — it does not revoke anything.
async function handleCancellation(payload, res) {
  const subscriptionId = payload.subscription_id || payload.id;
  if (!subscriptionId) return res.status(400).json({ ok: false, error: 'Missing subscription id' });

  const subRecord = await kvGet(subscriptionIndexKey(subscriptionId));
  const email = subRecord?.email || null;

  const id = `cancelling-${subscriptionId}`;
  await kvSet(itemKey(id), {
    id,
    name: email || '(unknown)',
    email: email || null,
    tempPassword: null,
    tools: [],
    product: payload.product_name || null,
    permalink: payload.product_permalink || null,
    status: 'flagged',
    flagReason: 'Cancellation requested — access continues until period ends; will auto-revoke on subscription_ended',
    createdAt: new Date().toISOString(),
  });
  await addToIndex(id);

  return res.status(200).json({ ok: true, status: 'cancellation_noted', matched: Boolean(email) });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  if (!WEBHOOK_SECRET || !timingSafeEqual(req.query.secret || '', WEBHOOK_SECRET)) {
    return res.status(403).json({ ok: false, error: 'Unauthorized' });
  }

  const payload = req.body || {};
  // The plain Ping URL never sends resource_name (it's sale-only); resource_subscriptions do.
  const resourceName = payload.resource_name || 'sale';

  // Only check seller_id when the payload actually includes one — don't assume every
  // resource type carries it, or we'd silently drop legitimate events that omit it.
  if (SELLER_ID && payload.seller_id && payload.seller_id !== SELLER_ID) {
    return res.status(200).json({ ok: true, message: 'Ignored: seller_id mismatch' });
  }

  try {
    if (resourceName === 'subscription_ended') return await handleSubscriptionEnded(payload, res);
    if (resourceName === 'cancellation') return await handleCancellation(payload, res);
    if (resourceName === 'sale') return await handleSale(payload, res);
    // Some other resource type we haven't subscribed to on purpose — ack so Gumroad doesn't retry.
    return res.status(200).json({ ok: true, message: `Ignored resource_name: ${resourceName}` });
  } catch (err) {
    console.error('gumroad-webhook error:', err);
    // Non-2xx so Gumroad retries — this path is for infra failures, not business-logic flags.
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
