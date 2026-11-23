/**
 * 构建产物校验：解码紧凑列表，检查列表 / facets / 看板 / 详情分片 / 官网补充 / 健康报告是否一致
 * 用法: node campus-jobs/scripts/validate-data.mjs
 * 失败时以非 0 退出，可直接作为部署前的门禁。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeRows } from './export-data.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SHARD_COUNT = 16;

const errors = [];
const warns = [];
const stats = [];
const fail = (msg) => errors.push(msg);
const warn = (msg) => warns.push(msg);
const note = (msg) => stats.push(msg);

const DEADLINE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TABLES = ['jobs', 'internships'];

async function readJSON(name, { required = true } = {}) {
  const file = path.join(DATA_DIR, name);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' && !required) return null;
    fail(`${name} 无法读取或 JSON 无效：${e.message}`);
    return null;
  }
}

function countBy(rows, pick) {
  const map = new Map();
  for (const r of rows) for (const v of pick(r)) if (v) map.set(v, (map.get(v) || 0) + 1);
  return map;
}

function checkRows(tab, payload) {
  if (!payload || Array.isArray(payload) || payload.v !== 2 || !Array.isArray(payload.r)) {
    fail(`${tab}.json 不是 v2 紧凑格式`);
    return [];
  }
  const dict = payload.d || {};
  for (const k of ['o', 'i', 'b', 'g', 'c']) {
    if (!Array.isArray(dict[k])) fail(`${tab}.json 字典缺列 d.${k}`);
  }
  const rows = decodeRows(payload);
  if (rows.length !== payload.r.length) fail(`${tab}.json 解码行数 ${rows.length} 与原始 ${payload.r.length} 不一致`);

  const ids = new Set();
  const dup = new Set();
  let badDeadline = 0;
  let badField = 0;
  let badWritten = 0;
  const written = { true: 0, false: 0, null: 0 };

  for (const r of rows) {
    if (!r.id || typeof r.id !== 'string') badField += 1;
    else if (ids.has(r.id)) dup.add(r.id);
    else ids.add(r.id);
    if (!r.company) badField += 1;
    if (!r.ownership) badField += 1;
    if (r.deadline != null && r.deadline !== '' && !DEADLINE_RE.test(r.deadline)) badDeadline += 1;
    if (!Array.isArray(r.positions) || !Array.isArray(r.cities) || !Array.isArray(r.industries) || !Array.isArray(r.gradYears) || !Array.isArray(r.batches) || !Array.isArray(r.degree)) badField += 1;
    if (r.writtenTest === true) written.true += 1;
    else if (r.writtenTest === false) written.false += 1;
    else if (r.writtenTest === null) written.null += 1;
    else badWritten += 1;
  }

  if (dup.size) fail(`${tab} 存在重复 id ${dup.size} 个：${[...dup].slice(0, 5).join(', ')}`);
  if (badField) fail(`${tab} 有 ${badField} 行必填字段缺失或类型错误`);
  if (badDeadline) fail(`${tab} 有 ${badDeadline} 行 deadline 不是 YYYY-MM-DD`);
  if (badWritten) fail(`${tab} 有 ${badWritten} 行 writtenTest 不是布尔/空`);
  note(`${tab}: ${rows.length} 行，笔试字段 有=${written.true} 无=${written.false} 未注明=${written.null}`);

  return rows;
}

async function checkShards(tab, rows) {
  const ids = new Set(rows.map((r) => r.id));
  const detailIds = new Set();
  let shardRows = 0;
  for (let i = 0; i < SHARD_COUNT; i++) {
    const name = `${tab}-detail-${i}.json`;
    const shard = await readJSON(name);
    if (!shard || typeof shard !== 'object') continue;
    for (const [id, detail] of Object.entries(shard)) {
      if (!ids.has(id)) fail(`${name} 存在孤儿详情 id：${id}`);
      if (detailIds.has(id)) fail(`详情 id 重复出现在多个分片：${id}`);
      if (shardHash(id) !== i) fail(`${name} 中的 ${id} 哈希落在 ${shardHash(id)}，分片错位`);
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) fail(`${name} 中 ${id} 详情不是对象`);
      detailIds.add(id);
      shardRows += 1;
    }
  }
  if (!shardRows) warn(`${tab} 详情分片为空`);
  else note(`${tab}: 详情 ${detailIds.size} 条，覆盖列表 ${((detailIds.size / (ids.size || 1)) * 100).toFixed(1)}%`);
}

function shardHash(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % SHARD_COUNT;
}

function checkFacets(facets, tables) {
  if (!facets) return;
  for (const tab of TABLES) {
    const f = facets[tab];
    const rows = tables[tab];
    if (!f) { fail(`facets.json 缺 ${tab}`); continue; }
    if (f.total !== rows.length) fail(`facets.${tab}.total=${f.total} 与列表 ${rows.length} 条不一致`);
    for (const key of ['industries', 'ownership', 'batches', 'degree', 'cities']) {
      const list = f[key];
      if (!Array.isArray(list)) { fail(`facets.${tab}.${key} 不是数组`); continue; }
      const names = new Set();
      for (const item of list) {
        if (!item || !item.name) fail(`facets.${tab}.${key} 存在空名称项`);
        else if (names.has(item.name)) fail(`facets.${tab}.${key} 名称重复：${item.name}`);
        else names.add(item.name);
        if (item && !(item.count > 0)) fail(`facets.${tab}.${key} 计数非正：${item.name}=${item.count}`);
      }
      const actual = countBy(rows, (r) => {
        if (key === 'ownership') return [r.ownership];
        return r[key] || [];
      });
      for (const item of list) {
        if (actual.get(item.name) !== item.count) {
          fail(`facets.${tab}.${key}.${item.name}=${item.count} 与实际 ${actual.get(item.name) || 0} 不一致`);
          break;
        }
      }
    }
    if (!Array.isArray(f.gradYears)) fail(`facets.${tab}.gradYears 不是数组`);
    else {
      const actualYears = [...new Set(rows.flatMap((r) => r.gradYears))].sort((a, b) => a - b);
      if (actualYears.join(',') !== f.gradYears.join(',')) fail(`facets.${tab}.gradYears 与列表不一致`);
    }
  }
}

function checkDashboard(dashboard, tables) {
  if (!dashboard || !dashboard.cards) return;
  const all = [...tables.jobs, ...tables.internships];
  const c = dashboard.cards;
  const expect = {
    jobsTotal: tables.jobs.length,
    internTotal: tables.internships.length,
    soe: all.filter((r) => r.ownership === '央国企').length,
    foreign: all.filter((r) => r.ownership === '外企').length,
    grad26: tables.jobs.filter((r) => r.gradYears.includes(2026)).length,
    grad27: tables.jobs.filter((r) => r.gradYears.includes(2027)).length,
  };
  for (const [k, v] of Object.entries(expect)) {
    if (c[k] !== v) fail(`dashboard.cards.${k}=${c[k]} 应为 ${v}`);
  }
  if (!Array.isArray(dashboard.upcoming)) fail('dashboard.upcoming 不是数组');
  else for (const u of dashboard.upcoming) {
    if (!u.id || !u.company) fail('dashboard.upcoming 存在缺 id/company 的条目');
  }
  if (!dashboard.generatedAt || Number.isNaN(Date.parse(dashboard.generatedAt))) fail('dashboard.generatedAt 无效');
}

async function checkSupplement() {
  const supplement = await readJSON('supplement.json');
  const health = await readJSON('fetch-health.json');
  if (!Array.isArray(supplement)) { fail('supplement.json 不是数组'); return; }
  if (!health) return;
  if (health.total !== supplement.length) fail(`fetch-health.total=${health.total} 与 supplement ${supplement.length} 条不一致`);
  if (!Array.isArray(health.sources)) fail('fetch-health.sources 不是数组');
  else {
    const optional = new Set((health.sources || []).filter((s) => s.optional).map((s) => s.key));
    for (const s of health.sources) {
      if (!s.key) fail('fetch-health 存在空 key 来源');
      // 源级抓取失败/空返回：fetch-official 已自动回退到上次数据，数据完整性不受影响，
      // 只能作为告警（warn），不能阻塞构建/部署。仅结构性损坏（total 不一致等）才 fail。
      if (s.status === 'error' && !optional.has(s.key)) warn(`来源 ${s.company || s.key} 抓取失败：${s.error || '未知错误'}（已沿用历史数据）`);
      if (s.status === 'empty' && !optional.has(s.key)) warn(`来源 ${s.company || s.key} 返回 0 条且没有历史数据`);
      if (s.status === 'stale') warn(`来源 ${s.company || s.key} 沿用历史数据（fresh=0）`);
      if (typeof s.consecutiveFailures === 'number' && s.consecutiveFailures >= 3) {
        warn(`来源 ${s.company || s.key} 已连续失败 ${s.consecutiveFailures} 次`);
      }
    }
    if (Array.isArray(health.history) && health.history.length) {
      const last = health.history[health.history.length - 1];
      if (last.generatedAt !== health.generatedAt) warn('fetch-health.history 最后一条与当前生成时间不一致');
    }
  }
  if (Array.isArray(health.warnings) && health.warnings.length) warn(`健康报告有 ${health.warnings.length} 条告警：${health.warnings[0]}`);
}

async function checkChangelog() {
  const log = await readJSON('changelog.json', { required: false });
  if (!log) return;
  if (!Array.isArray(log.added) || !Array.isArray(log.removed)) {
    fail('changelog.json 缺少 added / removed 数组');
    return;
  }
  note(`changelog: 新增 ${log.added.length}，下架 ${log.removed.length}`);
}

async function checkSync() {
  try {
    const app = await readFile(path.join(ROOT, 'assets', 'app.js'), 'utf8');
    const m = app.match(/DETAIL_SHARDS\s*=\s*(\d+)/);
    if (!m) fail('app.js 未找到 DETAIL_SHARDS 常量');
    else if (Number(m[1]) !== SHARD_COUNT) fail(`app.js DETAIL_SHARDS=${m[1]} 与校验脚本 ${SHARD_COUNT} 不一致`);
    const index = await readFile(path.join(ROOT, 'index.html'), 'utf8');
    if (!/assets\/app\.js/.test(index)) fail('index.html 未引用 assets/app.js');
  } catch (e) {
    fail(`读取前端文件失败：${e.message}`);
  }
}

async function main() {
  const tables = {};
  for (const tab of TABLES) {
    const payload = await readJSON(`${tab}.json`);
    tables[tab] = payload ? checkRows(tab, payload) : [];
  }
  for (const tab of TABLES) await checkShards(tab, tables[tab]);
  checkFacets(await readJSON('facets.json'), tables);
  checkDashboard(await readJSON('dashboard.json'), tables);
  await checkSupplement();
  await checkChangelog();
  await checkSync();

  for (const s of stats) console.log(`  · ${s}`);
  for (const w of warns) console.log(`  ⚠ ${w}`);
  if (errors.length) {
    console.error(`\n✗ 数据校验失败（${errors.length} 项）：`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`\n✓ 数据校验通过${warns.length ? `（${warns.length} 条提示）` : ''}`);
}

main().catch((e) => {
  console.error('校验脚本异常:', e);
  process.exit(1);
});
