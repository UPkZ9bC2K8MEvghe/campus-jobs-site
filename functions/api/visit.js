// 访问量统计（Cloudflare Pages Functions + D1）
// 规则：同一 IP + 同一台设备（浏览器本地生成的设备 ID）只计 1 次，永久去重。
// 只保存 SHA-256 哈希，不保存原始 IP。
// 需要在 Cloudflare Pages 项目里绑定 D1 数据库，变量名 VISITS_DB（见 重要信息/访问量统计说明.md）。

const SCHEMA = `CREATE TABLE IF NOT EXISTS visitors (
  id TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  day TEXT NOT NULL
)`;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 按北京时间计算日期
const cnDay = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.prepare(SCHEMA).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_visitors_day ON visitors(day)').run();
  schemaReady = true;
}

async function totals(db, day) {
  const row = await db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN day = ?1 THEN 1 ELSE 0 END) AS today FROM visitors').bind(day).first();
  return { total: row?.total || 0, today: row?.today || 0 };
}

export async function onRequestPost({ request, env }) {
  const db = env.VISITS_DB;
  if (!db) return json({ error: 'VISITS_DB 未绑定' }, 503);
  try {
    await ensureSchema(db);
    const ip = request.headers.get('CF-Connecting-IP') || '';
    let device = '';
    try { device = String((await request.json())?.device || '').slice(0, 64); } catch { /* ignore */ }
    if (!/^[a-z0-9-]{8,64}$/i.test(device)) device = 'nodevice';
    const salt = env.VISIT_SALT || 'campus-jobs';
    const id = await sha256(`${salt}|${ip}|${device}`);
    const day = cnDay();
    const res = await db.prepare('INSERT OR IGNORE INTO visitors (id, first_seen, day) VALUES (?1, ?2, ?3)')
      .bind(id, new Date().toISOString(), day).run();
    const t = await totals(db, day);
    return json({ ...t, isNew: (res.meta?.changes || 0) > 0 });
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
}

export async function onRequestGet({ env }) {
  const db = env.VISITS_DB;
  if (!db) return json({ error: 'VISITS_DB 未绑定' }, 503);
  try {
    await ensureSchema(db);
    return json(await totals(db, cnDay()));
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
}
