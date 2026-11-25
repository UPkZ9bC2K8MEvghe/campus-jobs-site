/**
 * 导出飞书多维表格「26、27校招汇总表」并归一化为站点数据
 * 用法: node campus-jobs/scripts/export-data.mjs
 *
 * 注意: 本机 PATH 上的 lark-cli 会挂死, 必须使用绝对路径调用 exe。
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

// 优先用插件目录里最新版本的 lark-cli，避免写死版本号后插件升级导致路径失效
function resolveLarkCli() {
  const base = 'C:\\Users\\pc\\.trae-cn\\plugins\\trae-remote-official\\lark';
  try {
    for (const d of readdirSync(base).sort().reverse()) {
      const p = path.join(base, d, 'bin', 'lark-cli.exe');
      try { readFileSync(p); return p; } catch { /* 继续找 */ }
    }
  } catch { /* 回退到 PATH */ }
  return 'lark-cli.exe';
}
const LARK_CLI = process.env.LARK_CLI || resolveLarkCli();
const BASE_TOKEN = 'GtSLbyyR3aCENOsJYC6cdlsVnih';
const TABLES = [
  { key: 'jobs', tableId: 'tblH4au5rnBcqHgJ', expected: 9210 },
  { key: 'internships', tableId: 'tbl507pxNhre0z2l', expected: 2246 },
];
const PAGE_LIMIT = 2000;
const MAX_PAGES = 12;

const beijingDate = (value = new Date()) =>
  new Date(new Date(value).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const SUPPLEMENT_FILE = path.join(DATA_DIR, 'supplement.json');

// 来源表格的店铺水印文案（出现在「备注」列），导出时统一剔除
const WATERMARK_RE = /(小红书\s*[-—–－]?\s*)?婉清学姐冲冲冲的店\s*唯一正版|婉清学姐整理/g;
const EDGE_SEP_RE = /^[\s/、,，\-–—|]+|[\s/、,，\-–—|]+$/g;

/* ---------- 官网补充数据：构建期合并 ---------- */

// 与前端原去重键保持一致：公司主体名 + 岗位列表
const baseName = (n) => String(n || '').split(/[-－(（]/)[0].trim();
const jobKey = (r) => `${baseName(r.company)}|${(r.positions || []).join(',')}`;

async function loadSupplement() {
  try {
    return JSON.parse(await readFile(SUPPLEMENT_FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e; // 文件损坏时中止，避免把已合并的官网行清掉
  }
}

// 已接入 ATS/官网直抓的企业：对应飞书汇总行不再展示，改用官网明细
let _atsNames = null;
function atsCompanyNames() {
  if (_atsNames) return _atsNames;
  try {
    _atsNames = JSON.parse(readFileSync(path.join(DATA_DIR, 'ats-companies.json'), 'utf8'))
      .map((c) => baseName(c.company));
  } catch {
    _atsNames = [];
  }
  return _atsNames;
}

// 先去重再统计，保证 facets / dashboard 与列表口径一致
function mergeSupplement(jobs, supplement) {
  const ats = new Set(atsCompanyNames());
  const coveredAts = new Set(
    supplement.map((r) => baseName(r.company)).filter((n) => ats.has(n))
  );
  // ATS 已覆盖的企业：丢弃飞书汇总行；其余企业保留飞书数据兜底
  const base = jobs.filter((r) => r.source !== 'official' && !coveredAts.has(baseName(r.company)));
  const seen = new Set(base.map(jobKey));
  // 同 id 的旧行（如公共招聘网）用最新抓取结果覆盖，避免城市等字段修复后仍留旧值
  const byId = new Map(base.map((r, i) => [r.id, i]));
  let added = 0;
  for (const row of supplement) {
    const idx = byId.get(row.id);
    if (idx != null) {
      base[idx] = { ...row, sm: (row.positions || []).join(' ').toLowerCase() };
      continue;
    }
    const key = jobKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    // 官网行详情已在 note 中，sm 只保留岗位名，避免同一段正文存两遍
    base.push({ ...row, sm: (row.positions || []).join(' ').toLowerCase() });
    added += 1;
  }
  return { rows: base, added };
}

/* ---------- 详情分片（前端只加载命中 id 所在分片） ---------- */

const SHARD_COUNT = 16; // 必须与 assets/app.js 的 DETAIL_SHARDS 保持一致

function shardOf(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % SHARD_COUNT;
}

async function writeDetailShards(tableKey, details) {
  const shards = Array.from({ length: SHARD_COUNT }, () => ({}));
  for (const [id, detail] of Object.entries(details)) shards[shardOf(id)][id] = detail;
  await Promise.all(shards.map((s, i) =>
    writeFile(path.join(DATA_DIR, `${tableKey}-detail-${i}.json`), JSON.stringify(s), 'utf8')
  ));
  // 单体文件已不再被前端使用，删除避免占空间
  await unlink(path.join(DATA_DIR, `${tableKey}-detail.json`)).catch(() => {});
}

/* ---------- 同公司合并：列表里每家只保留一个入口 ---------- */

const companyKey = (name) => String(name || '').replace(/\s+/g, '').toLowerCase();

async function loadDetailShards(tableKey) {
  const all = {};
  for (let i = 0; i < SHARD_COUNT; i += 1) {
    try {
      const shard = JSON.parse(await readFile(path.join(DATA_DIR, `${tableKey}-detail-${i}.json`), 'utf8'));
      Object.assign(all, shard);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return all;
}

async function loadRowsWithDetails(tableKey) {
  const payload = JSON.parse(await readFile(path.join(DATA_DIR, `${tableKey}.json`), 'utf8'));
  const rows = decodeRows(payload);
  const [details, search] = await Promise.all([
    loadDetailShards(tableKey),
    readFile(path.join(DATA_DIR, `${tableKey}-search.json`), 'utf8').then(JSON.parse).catch(() => []),
  ]);
  rows.forEach((row, i) => {
    const detail = details[row.id] || {};
    if (detail.positions?.length >= (row.positionCount ?? row.positions.length)) row.positions = detail.positions;
    row.sm = search[i] || detail.search || row.sm || '';
  });
  return { rows, details };
}

async function writeSearchIndex(tableKey, rows) {
  await writeFile(path.join(DATA_DIR, `${tableKey}-search.json`), JSON.stringify(rows.map((row) => row.sm || '')), 'utf8');
}

function pushUnique(target, values) {
  for (const v of values || []) if (v != null && v !== '' && !target.includes(v)) target.push(v);
}

// 备注统一带上岗位名称：备注来自具体岗位的 JD，缺少岗位名就无法对应
function withPosLabel(note, positions) {
  if (!note) return note;
  let text = String(note).trim();
  if (!text) return note;
  const list = (positions || []).map((p) => String(p || '').trim()).filter(Boolean);
  if (!list.length) return note;
  const first = list[0];
  // 岗位过多时只展示前 3 个，避免前缀比正文还长
  let label = list.slice(0, 3).join(' / ');
  if (list.length > 3) label += ` 等${list.length}个岗位`;
  if (label.length > 44) label = `${label.slice(0, 44)}…`;
  // 已带岗位名前缀（含历史合并结果）不重复叠加
  const head = /^【([^】]*)】[ \t]*\r?\n?/.exec(text);
  if (head) {
    const matched = list.some((p) => head[1] === p || head[1].includes(p) || p.includes(head[1]));
    if (matched) {
      if (head[1].length <= 60) return note;
      // 旧版超长前缀压缩成规范格式
      return `【${label}】\n${text.slice(head[0].length).trimStart()}`;
    }
  }
  if (text.startsWith(first)) return note;
  return `【${label}】\n${text}`;
}

// 把同一家公司的多条岗位合并成一条：岗位、专业、城市、批次取并集，截止时间取最近一个
function collapseByCompany(rows, details = {}) {
  const groups = new Map();
  for (const row of rows) {
    const k = companyKey(row.company);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }
  if (groups.size === rows.length) {
    const outDetails = {};
    for (const row of rows) {
      const detail = { ...(details[row.id] || {}) };
      const positions = detail.positions?.length >= row.positions.length ? detail.positions : row.positions;
      if (positions?.length) detail.positions = positions;
      if (row.sm) detail.search = row.sm;
      if (Object.keys(detail).length) outDetails[row.id] = detail;
    }
    return { rows, details: outDetails, mergedGroups: 0 };
  }

  const outRows = [];
  const outDetails = {};
  let mergedGroups = 0;

  for (const members of groups.values()) {
    if (members.length === 1) {
      const row = members[0];
      outRows.push(row);
      const detail = { ...(details[row.id] || {}) };
      const positions = detail.positions?.length >= row.positions.length ? detail.positions : row.positions;
      if (positions?.length) detail.positions = positions;
      if (row.sm) detail.search = row.sm;
      // 单岗位官网企业也必须把正文留在详情分片，列表编码时再移除重复正文。
      // 备注统一补上岗位名称（幂等，重复合并不会叠加）
      const singleNote = withPosLabel(detail.note || row.note, positions);
      if (singleNote) detail.note = singleNote;
      if (Object.keys(detail).length) outDetails[row.id] = detail;
      continue;
    }
    mergedGroups += 1;

    // 主记录优先挑有详情的、更新时间最新的，保证深链与详情稳定
    const primary = [...members].sort((a, b) => {
      const da = details[a.id] ? 1 : 0;
      const db = details[b.id] ? 1 : 0;
      if (da !== db) return db - da;
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    })[0];
    const officialMember = members.find((m) => m.source === 'official') || null;

    const positions = [];
    const cities = [];
    const industries = [];
    const batches = [];
    const degree = [];
    const gradYears = [];
    const notes = [];
    const smParts = [];
    const majorParts = [];
    const noteLinks = [];
    let nationwide = false;
    let gradUnlimited = false;
    let writtenTest = null;
    let updatedAt = '';
    let asap = false;
    let announce = null;
    let apply = null;
    let sourceText = '';

    for (const m of members) {
      const d = details[m.id];
      const memberPositions = d?.positions?.length >= (m.positionCount ?? m.positions.length) ? d.positions : m.positions;
      pushUnique(positions, memberPositions);
      pushUnique(cities, m.cities);
      pushUnique(industries, m.industries);
      pushUnique(batches, m.batches);
      pushUnique(degree, m.degree);
      pushUnique(gradYears, m.gradYears);
      if (m.nationwide) nationwide = true;
      if (m.gradUnlimited) gradUnlimited = true;
      if (m.writtenTest === true) writtenTest = true;
      else if (m.writtenTest === false && writtenTest == null) writtenTest = false;
      if (String(m.updatedAt || '') > updatedAt) updatedAt = String(m.updatedAt || '');
      const memberSearch = m.sm || d?.search || '';
      if (memberSearch && !smParts.includes(memberSearch)) smParts.push(memberSearch);
      if (m.note) {
        const block = withPosLabel(m.note, m.positions);
        if (block && !notes.includes(block)) notes.push(block);
      }
      if (/尽快/.test(m.deadlineText || '')) asap = true;
      if (!sourceText && m.source) sourceText = m.source;
      if (!apply && m.apply) apply = m.apply;

      if (!d) continue;
      if (d.majors && !majorParts.includes(d.majors)) majorParts.push(d.majors);
      if (!announce && d.announce) announce = d.announce;
      if (!apply && d.apply) apply = d.apply;
      if (!sourceText && d.source) sourceText = d.source;
      for (const l of d.noteLinks || []) {
        if (l && l.url && !noteLinks.some((x) => x.url === l.url)) noteLinks.push(l);
      }
    }

    // 截止时间取未截止成员里最早的一个；全都已截止时保留最早的日期，整条会按已截止隐藏
    const openMembers = members.filter((m) => {
      const dd = scriptDaysUntil(m.deadline);
      return !(dd != null && dd < 0);
    });
    let deadline = null;
    let deadlineText = '';
    for (const m of openMembers.length ? openMembers : members) {
      if (!m.deadline) continue;
      if (!deadline || m.deadline < deadline) {
        deadline = m.deadline;
        deadlineText = m.deadlineText || m.deadline;
      }
    }
    if (!deadline && asap) deadlineText = '尽快投递';

    const row = {
      id: primary.id,
      company: primary.company,
      ownership: primary.ownership,
      industries,
      positions,
      cities,
      nationwide,
      gradYears: gradYears.sort((a, b) => a - b),
      gradUnlimited,
      batches,
      degree,
      writtenTest,
      deadline: deadline || null,
      deadlineText,
      updatedAt,
      sm: smParts.join(' '),
      source: primary.source || (officialMember ? 'official' : ''),
      sourceName: (officialMember && officialMember.sourceName) || primary.sourceName || '',
      sourceUrl: (officialMember && officialMember.sourceUrl) || primary.sourceUrl || '',
      note: notes.join('\n'),
      majors: majorParts.join('；'),
    };
    if (!row.source) delete row.source;
    if (!row.sourceName) { delete row.sourceName; delete row.sourceUrl; }
    if (!row.note) delete row.note;
    if (!row.majors) delete row.majors;
    outRows.push(row);

    const detail = { positions, search: row.sm };
    if (row.majors) detail.majors = row.majors;
    if (announce) detail.announce = announce;
    if (apply) detail.apply = apply;
    if (row.note) detail.note = row.note;
    if (noteLinks.length) detail.noteLinks = noteLinks;
    if (sourceText) detail.source = sourceText;
    if (Object.keys(detail).length) outDetails[primary.id] = detail;
  }

  return { rows: outRows, details: outDetails, mergedGroups };
}

/* ---------- 列表紧凑编码（v3） ----------
 * 行转为数组 + 字符串字典；列表只保留前 4 个岗位，完整岗位与搜索索引按需加载。
 * 前端 assets/app.js 的 decodeRows 必须与此处保持同一列顺序。
 */

function encodeRows(rows) {
  const d = { o: [], i: [], b: [], g: [], c: [] };
  const maps = { o: new Map(), i: new Map(), b: new Map(), g: new Map(), c: new Map() };
  const at = (k, v) => {
    if (v == null || v === '') return -1;
    let n = maps[k].get(v);
    if (n === undefined) {
      n = d[k].length;
      d[k].push(v);
      maps[k].set(v, n);
    }
    return n;
  };
  const arrs = (k, list) => (list || []).map((v) => at(k, v));

  const r = rows.map((x) => {
    const positions = x.positions || [];
    return [
      x.id, x.company,
      at('o', x.ownership),
      arrs('i', x.industries),
      positions.slice(0, 4),
      arrs('c', x.cities),
      x.nationwide ? 1 : 0,
      x.gradYears || [],
      x.gradUnlimited ? 1 : 0,
      arrs('b', x.batches),
      arrs('g', x.degree),
      x.writtenTest === true ? 1 : x.writtenTest === false ? 0 : null,
      x.deadline || null,
      x.deadlineText || '',
      x.updatedAt || '',
      '',
      x.source || '',
      x.sourceName || '',
      x.sourceUrl || '',
      (x.apply && x.apply.url) || '',
      // 官网正文只存详情分片，避免大公司数千条 JD 在列表中重复占用体积。
      x.source === 'official' ? '' : (x.note || ''),
      x.majors || '',
      positions.length,
    ];
  });

  return { v: 3, d, r };
}

function decodeRows(payload) {
  if (Array.isArray(payload)) return payload; // 兼容旧格式
  if (!payload || ![2, 3].includes(payload.v) || !Array.isArray(payload.r)) return [];
  const { d, r } = payload;
  const pick = (k, i) => (i >= 0 && d[k][i] !== undefined ? d[k][i] : '');
  const list = (k, arr) => (arr || []).map((i) => pick(k, i)).filter((v) => v !== '');

  return r.map((a) => {
    const row = {
      id: a[0],
      company: a[1],
      ownership: pick('o', a[2]),
      industries: list('i', a[3]),
      positions: a[4] || [],
      cities: list('c', a[5]),
      nationwide: !!a[6],
      gradYears: a[7] || [],
      gradUnlimited: !!a[8],
      batches: list('b', a[9]),
      degree: list('g', a[10]),
      writtenTest: a[11] === 1 ? true : a[11] === 0 ? false : null,
      deadline: a[12] === undefined ? null : a[12],
      deadlineText: a[13] || '',
      updatedAt: a[14] || '',
      sm: payload.v === 2 ? (a[15] || '') : '',
    };
    if (payload.v === 3) row.positionCount = a[22] ?? row.positions.length;
    if (a[16]) row.source = a[16];
    if (a[17]) row.sourceName = a[17];
    if (a[18]) row.sourceUrl = a[18];
    if (a[19]) row.apply = { url: a[19] };
    if (a[20]) row.note = a[20];
    if (a[21]) row.majors = a[21];
    return row;
  });
}

/* ---------- 每日变更（官网岗位新增 / 下架） ---------- */

function buildChangelog(prevRows, nextRows) {
  const pickOfficial = (rows) => rows.filter((r) => r.source === 'official');
  const prev = pickOfficial(prevRows);
  const next = pickOfficial(nextRows);
  const generatedAt = new Date().toISOString();
  if (!prev.length) return { generatedAt, basedOnPrev: 0, addedCount: 0, removedCount: 0, added: [], removed: [] };
  const prevKeys = new Set(prev.map(jobKey));
  const nextKeys = new Set(next.map(jobKey));
  const brief = (r) => ({ id: r.id, company: r.company, positions: (r.positions || []).slice(0, 5), deadline: r.deadline || null });
  const added = next.filter((r) => !prevKeys.has(jobKey(r))).map(brief);
  const removed = prev.filter((r) => !nextKeys.has(jobKey(r))).map(brief);
  return {
    generatedAt: new Date().toISOString(),
    basedOnPrev: prev.length,
    addedCount: added.length,
    removedCount: removed.length,
    added: added.slice(0, 80),
    removed: removed.slice(0, 80),
  };
}

async function readPreviousJobs() {
  try {
    return (await loadRowsWithDetails('jobs')).rows;
  } catch {
    return [];
  }
}

/* ---------- 字段清洗规则 ---------- */

// 说明性脏选项（不是真实城市/行业）
const NOISE = new Set([
  '筛选前必看表格使用说明',
  '不要按省份筛选',
  '新疆也是省份！不要选新疆！',
  '按具体城市多选！',
  '等于改成包含！',
  '全国多地', // 单独作为 nationwide 标记处理
]);
const NOISE_PATTERN = /筛选|不要按|不要选|改成包含|多选！|更新中|假期之后/;

const OWNERSHIP_MAP = {
  民企: '民企',
  央国企: '央国企',
  国企: '央国企',
  央企: '央国企',
  外企: '外企',
  合资: '合资',
  事业单位: '事业单位',
  政府机关: '政府机关',
  社会组织: '社会组织',
  其他: '其他',
  集体所有制: '其他',
};

const UNLIMITED_RE = /不限/;

/* ---------- 工具函数 ---------- */

function asArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter((x) => x != null && String(x).trim() !== '');
  const s = String(v).trim();
  return s ? [s] : [];
}

function splitMulti(v) {
  return asArray(v)
    .flatMap((x) => String(x).split(/[,，;；、]/))
    .map((x) => x.trim())
    .filter(Boolean);
}

function uniq(arr) {
  return [...new Set(arr)];
}

function cleanLabel(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

function isNoise(s) {
  return NOISE.has(s) || NOISE_PATTERN.test(s);
}

// 解析 "[文本](url)" 或裸链接；邮箱自动转 mailto
function parseLink(v) {
  if (v == null) return null;
  const raw = String(v).trim();
  if (!raw) return null;
  const m = raw.match(/\[([^\]]*)\]\(([^)]*)\)/);
  let text = raw;
  let url = raw;
  if (m) {
    text = m[1].trim();
    url = m[2].trim();
  }
  const email = (text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || url.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0];
  if (email && !/^https?:\/\//i.test(text)) {
    return { text: text || email, url: `mailto:${email}`, email };
  }
  if (email && /^http:\/\//i.test(url) && url.includes('@')) {
    return { text: text || email, url: `mailto:${email}`, email };
  }
  if (!/^(https?:|mailto:)/i.test(url)) {
    if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(url)) return { text: text || url, url: `mailto:${url}`, email: url };
    if (/^https?:\/\//i.test(text)) return { text: text, url: text };
    return { text, url: null };
  }
  return { text, url, email: email || null };
}

// 备注里可能存在 Markdown 链接，提取成可点击片段
function parseRichText(v) {
  const raw = v == null ? '' : String(v).trim();
  if (!raw) return { text: '', links: [] };
  const links = [];
  const text = raw.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    links.push({ label, url });
    return label;
  }).replace(WATERMARK_RE, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n')
    .replace(EDGE_SEP_RE, '').trim();
  return { text, links };
}

function parseGradYears(v) {
  const labels = asArray(v);
  const unlimited = labels.some((l) => UNLIMITED_RE.test(l));
  const years = new Set();
  for (const label of labels) {
    const matches = label.match(/20\d{2}/g) || [];
    matches.forEach((y) => years.add(Number(y)));
  }
  return { gradYears: [...years].sort((a, b) => a - b), gradUnlimited: unlimited };
}

function parseDeadline(v) {
  const raw = v == null ? '' : String(v).trim();
  const m = raw.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (m) {
    const iso = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    return { deadline: iso, deadlineText: raw };
  }
  return { deadline: null, deadlineText: raw };
}

function parseDate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const m = s.match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

/* ---------- 单条记录归一化 ---------- */

function normalizeJob(r) {
  const { gradYears, gradUnlimited } = parseGradYears(r['届次']);
  const citiesRaw = asArray(r['工作地点'])
    .flatMap((x) => String(x).split(/[,，;；、]/))
    .map(cleanLabel)
    .filter(Boolean);
  const nationwide = citiesRaw.some((c) => c === '全国多地');
  const cities = uniq(citiesRaw.filter((c) => !isNoise(c)));

  const industries = uniq(asArray(r['行业分类']).map(cleanLabel).filter((x) => x && !isNoise(x)));
  const ownershipRaw = asArray(r['企业性质']).map(cleanLabel)[0] || '';
  const ownership = OWNERSHIP_MAP[ownershipRaw] || (isNoise(ownershipRaw) ? '其他' : ownershipRaw || '其他');
  const batches = uniq(asArray(r['批次']).map(cleanLabel).filter(Boolean));
  const positions = uniq(splitMulti(r['招聘岗位']));
  const degree = uniq(splitMulti(r['学历要求']));
  const writtenRaw = asArray(r['是否笔试']).map(cleanLabel).join('');
  // 先判“无”再判“有”，避免「无笔试」被 /笔试/ 误判为有
  let writtenTest = null;
  if (/无笔试|无|否|不需要|不要求|免笔试|false/i.test(writtenRaw)) writtenTest = false;
  else if (/有笔试|有|是|需要|true|笔试/i.test(writtenRaw)) writtenTest = true;
  const { deadline, deadlineText } = parseDeadline(r['截止时间']);
  const updatedAt = parseDate(r['更新时间']);
  const note = parseRichText(r['备注']);

  const company = cleanLabel(r['公司名称'] || '');
  if (!company) return null;

  const id = r.record_id;
  // 链接去重：text 与 url 相同时只存 url，省掉约一半体积
  const announce = compactLink(parseLink(r['公告链接']));
  const apply = compactLink(parseLink(r['投递链接'] || r['投递方式']));

  // 列表/筛选/搜索所需字段（首屏加载）
  const list = {
    id,
    company,
    ownership,
    industries,
    positions,
    cities,
    nationwide,
    gradYears,
    gradUnlimited,
    batches,
    degree,
    writtenTest,
    deadline,
    deadlineText,
    updatedAt,
    // 搜索用：专业与备注的纯文本（不存原始长字段）
    sm: [cleanLabel(r['专业要求'] || ''), note.text].join(' ').toLowerCase(),
  };

  // 详情字段（打开卡片时才懒加载）
  const detail = {};
  if (announce) detail.announce = announce;
  if (apply) detail.apply = apply;
  if (note.text) detail.note = withPosLabel(note.text, positions);
  if (note.links && note.links.length) detail.noteLinks = note.links;
  const majors = cleanLabel(r['专业要求'] || '');
  if (majors) detail.majors = majors;
  const source = cleanLabel(r['公告来源'] || '');
  if (source) detail.source = source;

  return { list, detail };
}

// 只保留有意义的链接字段
function compactLink(link) {
  if (!link) return null;
  const out = {};
  if (link.url) out.url = link.url;
  if (link.text && link.text !== link.url) out.text = link.text;
  if (link.email) out.email = link.email;
  return Object.keys(out).length ? out : null;
}

/* ---------- 飞书多维表格：应用直读（CI 无 lark-cli 时使用） ---------- */

// 表格字段（日期/链接/人员等）转成与 lark-cli NDJSON 一致的可解析值
function flattenBitableValue(v) {
  if (v == null) return null;
  if (Array.isArray(v)) {
    const out = v.map(flattenBitableValue).filter((x) => x != null && x !== '');
    return out.length ? out : null;
  }
  if (typeof v === 'object') {
    if (typeof v.link === 'string') {
      const text = typeof v.text === 'string' && v.text && v.text !== v.link ? v.text : '';
      return text ? `[${text}](${v.link})` : v.link;
    }
    if (typeof v.text === 'string') return v.text;
    if (Array.isArray(v.text_arr)) return v.text_arr.join('');
    if (typeof v.name === 'string') return v.name;
    return null;
  }
  // 日期字段是毫秒时间戳，按东八区转 YYYY-MM-DD
  if (typeof v === 'number' && v >= 1e12) {
    return new Date(v + 8 * 3600 * 1000).toISOString().slice(0, 10);
  }
  return v;
}

async function fetchBitableRecordsViaApp(tableId, appToken, { updatedSince } = {}) {
  const records = [];
  let pageToken = '';
  const incremental = Boolean(updatedSince);
  const sinceMs = incremental
    ? Date.parse(`${updatedSince}T00:00:00+08:00`) - 24 * 3600 * 1000
    : 0;
  if (incremental && !Number.isFinite(sinceMs)) throw new Error(`无效增量日期：${updatedSince}`);
  for (let page = 0; page < 40; page += 1) {
    const qs = new URLSearchParams({ page_size: '500' });
    if (pageToken) qs.set('page_token', pageToken);
    const headers = { Authorization: `Bearer ${appToken}` };
    const options = { headers, signal: AbortSignal.timeout(60000) };
    let url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/records?${qs}`;
    if (incremental) {
      url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/records/search?${qs}`;
      headers['Content-Type'] = 'application/json';
      options.method = 'POST';
      options.body = JSON.stringify({
        automatic_fields: true,
        filter: {
          conjunction: 'and',
          conditions: [{
            field_name: '更新时间',
            operator: 'isGreater',
            value: ['ExactDate', String(sinceMs)],
          }],
        },
      });
    }
    const res = await fetch(url, options);
    const j = await res.json();
    if (j.code !== 0) throw new Error(`bitable ${tableId}: ${j.msg || j.code}`);
    for (const it of j.data.items || []) {
      const rec = { record_id: it.record_id || it.id };
      for (const [k, v] of Object.entries(it.fields || {})) {
        const flat = flattenBitableValue(v);
        if (flat != null) rec[k] = flat;
      }
      records.push(rec);
    }
    if (!j.data.has_more || !j.data.page_token) break;
    pageToken = j.data.page_token;
  }
  return records;
}

/* ---------- 导出 ---------- */

async function exportTable({ key, tableId, expected }, appToken = null) {
  const rows = [];
  const details = {};
  const seen = new Set();

  const addRecord = (rec) => {
    if (!rec || !rec.record_id || seen.has(rec.record_id)) return 0;
    seen.add(rec.record_id);
    const normalized = normalizeJob(rec);
    if (!normalized) return 0;
    rows.push(normalized.list);
    if (Object.keys(normalized.detail).length) details[normalized.list.id] = normalized.detail;
    return 1;
  };

  if (appToken) {
    const records = await fetchBitableRecordsViaApp(tableId, appToken);
    for (const rec of records) addRecord(rec);
    process.stdout.write(`  ${key} 应用直读: 读取 ${records.length} 条, 保留 ${rows.length} 条\n`);
    if (rows.length !== expected) {
      process.stdout.write(`  ⚠ ${key} 条数 ${rows.length} 与预期 ${expected} 不一致（数据可能已更新）\n`);
    } else {
      process.stdout.write(`  ✓ ${key} 共 ${rows.length} 条，与预期一致\n`);
    }
    return { rows, details };
  }

  const workDir = await mkdtemp(path.join(tmpdir(), `campusjobs-${key}-`));

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const offset = page * PAGE_LIMIT;
    const outFile = path.join(workDir, `page-${page}.ndjson`);
    const args = [
      'base', '+record-list',
      '--base-token', BASE_TOKEN,
      '--table-id', tableId,
      '--limit', String(PAGE_LIMIT),
      '--offset', String(offset),
      '--format', 'ndjson',
      '--output', outFile,
      '--as', 'user',
    ];
    await execFileAsync(LARK_CLI, args, { maxBuffer: 64 * 1024 * 1024, timeout: 300000, windowsHide: true });

    let text = '';
    try {
      text = await readFile(outFile, 'utf8');
    } catch {
      break;
    }
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    let added = 0;
    for (const line of lines) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      added += addRecord(rec);
    }
    process.stdout.write(`  ${key} 第 ${page + 1} 页: 读取 ${lines.length} 条, 新增 ${added} 条, 累计 ${rows.length}\n`);
    if (lines.length < PAGE_LIMIT) break;
  }

  if (rows.length !== expected) {
    process.stdout.write(`  ⚠ ${key} 条数 ${rows.length} 与预期 ${expected} 不一致（数据可能已更新）\n`);
  } else {
    process.stdout.write(`  ✓ ${key} 共 ${rows.length} 条，与预期一致\n`);
  }
  return { rows, details };
}

async function loadTableState(key) {
  return loadRowsWithDetails(key);
}

async function exportTableIncremental(table, appToken, updatedSince) {
  const previous = await loadTableState(table.key);
  if (!previous.rows.length) return null;
  const records = await fetchBitableRecordsViaApp(table.tableId, appToken, { updatedSince });
  if (!records.length) return null;
  const rowsById = new Map(previous.rows.map((row) => [row.id, row]));
  const details = { ...previous.details };
  let changed = 0;
  for (const rec of records) {
    const normalized = normalizeJob(rec);
    if (!normalized) continue;
    rowsById.set(normalized.list.id, normalized.list);
    if (Object.keys(normalized.detail).length) details[normalized.list.id] = normalized.detail;
    else delete details[normalized.list.id];
    changed += 1;
  }
  return {
    rows: [...rowsById.values()],
    details,
    fetchedCount: records.length,
    changedCount: changed,
  };
}

/* ---------- 选项统计 ---------- */

function buildFacets(rows) {
  const count = (pick) => {
    const map = new Map();
    for (const row of rows) {
      for (const val of pick(row)) {
        if (!val) continue;
        map.set(val, (map.get(val) || 0) + 1);
      }
    }
    return [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
  };

  const years = new Set();
  for (const row of rows) row.gradYears.forEach((y) => years.add(y));

  // 前端默认只展示未截止岗位，这里同时给出未截止条数，保证 tab 计数与列表一致
  const open = rows.reduce((n, r) => {
    const d = scriptDaysUntil(r.deadline);
    return n + (d != null && d < 0 ? 0 : 1);
  }, 0);

  return {
    industries: count((r) => r.industries),
    ownership: count((r) => [r.ownership]),
    batches: count((r) => r.batches),
    degree: count((r) => r.degree),
    cities: count((r) => r.cities),
    gradYears: [...years].sort((a, b) => a - b),
    total: rows.length,
    open,
  };
}

/* ---------- 看板数据 ---------- */

function scriptDaysUntil(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(y, m - 1, d);
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - base) / 86400000);
}

function buildDashboard(jobs, internships) {
  const all = [...jobs, ...internships];
  const today = new Date().toISOString().slice(0, 10);
  const countWhere = (arr, fn) => arr.reduce((s, r) => s + (fn(r) ? 1 : 0), 0);

  const posMap = new Map();
  for (const r of all) {
    for (const p of r.positions) {
      for (const tok of String(p).split(/[,，、;；/／()（）\s]+/)) {
        const t = tok.trim();
        if (t.length >= 2) posMap.set(t, (posMap.get(t) || 0) + 1);
      }
    }
  }
  const positions = [...posMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 80);

  const cityMap = new Map();
  for (const r of all) for (const c of r.cities) cityMap.set(c, (cityMap.get(c) || 0) + 1);
  const cities = [...cityMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 80);

  const upcoming = all
    .map((r) => ({ r, days: scriptDaysUntil(r.deadline) }))
    .filter((x) => x.days != null && x.days >= 0)
    .sort((a, b) => a.days - b.days)
    .slice(0, 12)
    .map((x) => ({ company: x.r.company, deadline: x.r.deadline, days: x.days, id: x.r.id }));

  const cards = {
    jobsTotal: jobs.length,
    internTotal: internships.length,
    grad26: countWhere(jobs, (r) => r.gradYears.includes(2026)),
    grad27: countWhere(jobs, (r) => r.gradYears.includes(2027)),
    soe: countWhere(all, (r) => r.ownership === '央国企'),
    foreign: countWhere(all, (r) => r.ownership === '外企'),
    intern: countWhere(all, (r) => r.batches.some((b) => /实习/.test(b))),
    upcoming7: countWhere(all, (r) => { const d = scriptDaysUntil(r.deadline); return d != null && d >= 0 && d <= 7; }),
    updatedToday: countWhere(all, (r) => r.updatedAt === today),
    updatedThisWeek: countWhere(all, (r) => {
      if (!r.updatedAt) return false;
      const d = scriptDaysUntil(r.updatedAt);
      return d != null && d >= -6 && d <= 0;
    }),
  };

  return { cards, positions, cities, upcoming, generatedAt: new Date().toISOString() };
}

/* ---------- 央国企名录 ---------- */

const SOE_TABLE = 'tbllTNyaMiYmRlv4';

async function exportSOE(appToken = null) {
  let records;
  if (appToken) {
    records = await fetchBitableRecordsViaApp(SOE_TABLE, appToken);
    process.stdout.write(`  SOE 应用直读: ${records.length} 条记录\n`);
  } else {
    const workDir = await mkdtemp(path.join(tmpdir(), 'campusjobs-soe-'));
    const outFile = path.join(workDir, 'soe.ndjson');
    await execFileAsync(LARK_CLI, [
      'base', '+record-list',
      '--base-token', BASE_TOKEN,
      '--table-id', SOE_TABLE,
      '--limit', '2000',
      '--format', 'ndjson',
      '--output', outFile,
      '--as', 'user',
    ], { maxBuffer: 64 * 1024 * 1024, timeout: 300000, windowsHide: true });

    const text = await readFile(outFile, 'utf8');
    records = [];
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      try { records.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
    }
  }

  const items = [];
  for (const r of records) {
    for (const [c, l] of [[r['公司'], r['链接']], [r['公司2'], r['链接2']]]) {
      const company = cleanLabel(c || '');
      if (!company) continue;
      const link = compactLink(parseLink(l));
      items.push({ company, url: link?.url || null });
    }
  }
  const seen = new Set();
  const dedup = [];
  for (const it of items) {
    const k = `${it.company}|${it.url || ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(it);
  }
  return dedup;
}

/* ---------- 文档导出（markdown → 简易 HTML） ---------- */

const DOCS = [
  { key: 'interview', token: 'Qkg2dwnISo6Jlqx5O16cSt1tnId', title: '校招面试常见问题及参考答案' },
  { key: 'experience', token: 'UHNMd1JBWonKQFxONCecVMFfnNG', title: '面经分享' },
];

function inline(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/!\[[^\]]*\]\(([^)]+)\)/g, '<img src="$1" loading="lazy" alt="">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function mdToHtml(md) {
  let html = String(md || '').replace(/<\/?(callout|cite|title|bitable|fragment|comment|img)[^>]*>/g, '');
  const lines = html.split(/\r?\n/);
  const out = [];
  let inList = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) { if (inList) { out.push('</ul>'); inList = false; } continue; }
    const h = t.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    const li = t.match(/^[-*]\s+(.*)/);
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    out.push(`<p>${inline(t)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

async function fetchDocHtml(token) {
  const { stdout } = await execFileAsync(LARK_CLI, [
    'docs', '+fetch', '--doc', token, '--doc-format', 'markdown', '--as', 'user',
  ], { maxBuffer: 32 * 1024 * 1024, timeout: 180000, windowsHide: true });
  const data = JSON.parse(stdout);
  return data.data.document.content;
}

/* ---------- 飞书自建应用直读文档（CI 无 lark-cli 时使用） ---------- */

async function feishuAppCredentials() {
  const env = { ...process.env };
  try {
    const text = readFileSync(path.resolve(__dirname, '..', '.env.local'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0 && !line.trim().startsWith('#')) env[line.slice(0, i).trim()] ??= line.slice(i + 1).trim();
    }
  } catch { /* 没有 .env.local 就只用进程环境变量 */ }
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) return null;
  return { id: env.FEISHU_APP_ID, secret: env.FEISHU_APP_SECRET };
}

async function feishuTenantToken() {
  const cred = await feishuAppCredentials();
  if (!cred) return null;
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: cred.id, app_secret: cred.secret }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`tenant_access_token: ${j.msg || j.code}`);
  return j.tenant_access_token;
}

function blockText(block) {
  for (const v of Object.values(block)) {
    if (v && Array.isArray(v.elements)) {
      return v.elements.map((e) => e.text_run?.content ?? e.mention_doc?.title ?? '').join('').trim();
    }
  }
  return '';
}

async function fetchDocMarkdownViaApp(docToken, appToken) {
  const blocks = [];
  let pageToken = '';
  do {
    const qs = new URLSearchParams({ page_size: '500', document_revision_id: '-1' });
    if (pageToken) qs.set('page_token', pageToken);
    const res = await fetch(`https://open.feishu.cn/open-apis/docx/v1/documents/${docToken}/blocks?${qs}`, {
      headers: { Authorization: `Bearer ${appToken}` }, signal: AbortSignal.timeout(30000),
    });
    const j = await res.json();
    if (j.code !== 0) throw new Error(`blocks: ${j.msg || j.code}`);
    blocks.push(...(j.data.items || []));
    pageToken = j.data.has_more ? j.data.page_token : '';
  } while (pageToken);

  const byId = new Map(blocks.map((b) => [b.block_id, b]));
  const root = blocks.find((b) => b.block_type === 1) || blocks[0];
  const lines = [];
  const walk = (id) => {
    const b = byId.get(id);
    if (!b) return;
    const text = blockText(b);
    const t = b.block_type;
    if (t >= 3 && t <= 11) lines.push(`${'#'.repeat(t - 2)} ${text}`);
    else if (t === 12) lines.push(`- ${text}`);
    else if (t === 13) lines.push(`1. ${text}`);
    else if (t === 15) lines.push(`> ${text}`);
    else if (t === 22) lines.push('---');
    else if (text) lines.push(text);
    for (const c of b.children || []) walk(c);
  };
  for (const c of root.children || []) walk(c);
  return lines.join('\n');
}

/* 文档当前 revision（轻量元信息请求，不拉正文）。
 * 用于增量判断：revision 与上次一致 → 文档未被编辑，站点已有内容直接复用。 */
async function fetchDocRevision(docToken, appToken) {
  const res = await fetch(`https://open.feishu.cn/open-apis/docx/v1/documents/${docToken}`, {
    headers: { Authorization: `Bearer ${appToken}` }, signal: AbortSignal.timeout(15000),
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`document meta: ${j.msg || j.code}`);
  return String(j.data.document.revision_id ?? '');
}

/* 每个文档上次抓取时的 revision 缓存（与 docs.json 分离，避免改变其结构） */
const DOCS_REV_FILE = path.join(DATA_DIR, 'docs-revisions.json');
const BITABLE_REV_FILE = path.join(DATA_DIR, 'bitable-revisions.json');
const MAX_INCREMENTAL_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 最多 7 天强制全量一次，避免长期漏检

/* ---------- 飞书多维表格变更探针（增量导出） ---------- */
async function fetchBitableRevisions(appToken) {
  const res = await fetch(`https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables?page_size=100`, {
    headers: { Authorization: `Bearer ${appToken}` }, signal: AbortSignal.timeout(20000),
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`bitable tables revision: ${j.msg || j.code}`);
  const revisions = {};
  for (const t of j.data?.items || []) revisions[t.table_id] = Number(t.revision) || 0;
  return revisions;
}

async function incrementalProbe(appToken) {
  const supplementHash = createHash('sha1')
    .update(await readFile(SUPPLEMENT_FILE, 'utf8').catch(() => '[]')).digest('hex');
  if (process.env.FORCE_FULL_EXPORT === '1') return { mode: 'full', reason: 'FORCE_FULL_EXPORT', supplementHash };
  if (!appToken) return { mode: 'full', reason: 'lark-cli 回退模式，不做增量跳过', supplementHash };
  let revisions;
  try { revisions = await fetchBitableRevisions(appToken); }
  catch (e) { return { mode: 'full', reason: `revision 探针失败：${e.message}`, supplementHash }; }
  const target = TABLES.map((t) => Number(revisions[t.tableId]) || 0);
  if (target.some((v) => !v)) return { mode: 'full', reason: '部分表 revision 缺失', supplementHash, revisions };
  let cache = null;
  try { cache = JSON.parse(await readFile(BITABLE_REV_FILE, 'utf8')); } catch { /* 首次 */ }
  if (!cache?.revisions) return { mode: 'full', reason: '无历史 revision 缓存', supplementHash, revisions };
  const sameRevs = TABLES.every((t) => Number(cache.revisions[t.tableId]) === Number(revisions[t.tableId]));
  const supplementChanged = cache.supplementHash !== supplementHash;
  const lastFullAt = Date.parse(cache.generatedAt || 0);
  const freshEnough = Number.isFinite(lastFullAt) && Date.now() - lastFullAt < MAX_INCREMENTAL_AGE_MS;
  if (sameRevs && freshEnough) {
    return {
      mode: 'skip', skip: true, supplementChanged, cache, revisions, supplementHash,
      reason: `表 revision（${target.join('/')}）未变化${supplementChanged ? '，仅官网补充数据变化' : ''}`,
    };
  }
  if (!sameRevs && freshEnough) {
    const lastSyncAt = Date.parse(cache.lastSyncAt || cache.generatedAt);
    const updatedSince = beijingDate(Number.isFinite(lastSyncAt) ? lastSyncAt : lastFullAt);
    return {
      mode: 'incremental', skip: false, supplementChanged, cache, revisions, supplementHash, updatedSince,
      reason: `表 revision 变化，按更新时间 ${updatedSince} 起增量导出`,
    };
  }
  return {
    mode: 'full', skip: false, supplementChanged, cache, revisions, supplementHash,
    reason: sameRevs ? '增量缓存超过 7 天，执行全量对账' : `revision 变化且缓存过期（${target.join('/')}）`,
  };
}

async function exportDocs() {
  let docs = {};
  try { docs = JSON.parse(await readFile(path.join(DATA_DIR, 'docs.json'), 'utf8')); } catch { /* 首次导出 */ }
  let revCache = {};
  try { revCache = JSON.parse(await readFile(DOCS_REV_FILE, 'utf8')); } catch { /* 首次运行 */ }

  let appToken = null;
  try { appToken = await feishuTenantToken(); } catch (e) {
    process.stdout.write(`  ⚠ 应用凭证获取失败，改用 lark-cli：${e.message}\n`);
  }
  if (!appToken) process.stdout.write('  · 未配置 FEISHU_APP_ID / FEISHU_APP_SECRET，使用 lark-cli 导出\n');

  let changed = 0;
  for (const d of DOCS) {
    // 增量检查：轻量请求当前 revision，与上次抓取一致 → 文档未被编辑，直接复用站点已有内容
    let rev = null;
    if (appToken) {
      try { rev = await fetchDocRevision(d.token, appToken); } catch (e) {
        process.stdout.write(`  ⚠ ${d.title} revision 查询失败（${e.message}），走全量抓取\n`);
      }
    }
    if (rev && revCache[d.key]?.revision === rev && docs[d.key]?.html) {
      process.stdout.write(`  ✓ ${d.title}（revision ${rev} 无变化，复用站点已有内容）\n`);
      continue;
    }
    try {
      let md = '';
      if (appToken) {
        try { md = await fetchDocMarkdownViaApp(d.token, appToken); } catch (e) {
          process.stdout.write(`  ⚠ 应用读取「${d.title}」失败，改用 lark-cli：${e.message}\n`);
        }
      }
      if (!md) md = await fetchDocHtml(d.token);
      docs[d.key] = { title: d.title, html: stripDocPromo(mdToHtml(md)) };
      if (rev) revCache[d.key] = { revision: rev, updatedAt: new Date().toISOString() };
      changed += 1;
      process.stdout.write(`  ✓ ${d.title}（已更新${rev ? `，revision ${rev}` : ''}）\n`);
    } catch (e) {
      process.stdout.write(`  ⚠ ${d.title} 导出失败: ${e.message}\n`);
    }
  }
  if (changed) {
    await writeFile(path.join(DATA_DIR, 'docs.json'), JSON.stringify(docs), 'utf8');
    await writeFile(DOCS_REV_FILE, JSON.stringify(revCache, null, 2), 'utf8');
    process.stdout.write(`  → docs.json（${changed} 个文档有更新）\n`);
  } else {
    process.stdout.write('  → 文档均无变化，docs.json 保持不变\n');
  }
}

async function mergeOnly() {
  // 先把已有数据按公司合并，保证重复执行也不会把合并结果拆回去
  const prevJobsState = await loadRowsWithDetails('jobs');
  const internshipsState = await loadRowsWithDetails('internships');
  const prevJobsCollapsed = collapseByCompany(prevJobsState.rows, prevJobsState.details);
  const internshipsCollapsed = collapseByCompany(internshipsState.rows, internshipsState.details);
  const { rows, added } = mergeSupplement(prevJobsCollapsed.rows, await loadSupplement());
  const jobsCollapsed = collapseByCompany(rows, prevJobsCollapsed.details);

  await writeFile(path.join(DATA_DIR, 'jobs.json'), JSON.stringify(encodeRows(jobsCollapsed.rows)), 'utf8');
  await writeFile(path.join(DATA_DIR, 'internships.json'), JSON.stringify(encodeRows(internshipsCollapsed.rows)), 'utf8');
  await writeSearchIndex('jobs', jobsCollapsed.rows);
  await writeSearchIndex('internships', internshipsCollapsed.rows);
  await writeDetailShards('jobs', jobsCollapsed.details);
  await writeDetailShards('internships', internshipsCollapsed.details);
  const facets = { jobs: buildFacets(jobsCollapsed.rows), internships: buildFacets(internshipsCollapsed.rows) };
  await writeFile(path.join(DATA_DIR, 'facets.json'), JSON.stringify(facets), 'utf8');
  const dashboard = buildDashboard(jobsCollapsed.rows, internshipsCollapsed.rows);
  await writeFile(path.join(DATA_DIR, 'dashboard.json'), JSON.stringify(dashboard), 'utf8');
  const changelog = buildChangelog(prevJobsCollapsed.rows, jobsCollapsed.rows);
  await writeFile(path.join(DATA_DIR, 'changelog.json'), JSON.stringify(changelog), 'utf8');
  process.stdout.write(`→ changelog.json 新增 ${changelog.addedCount} / 下架 ${changelog.removedCount}\n`);

  process.stdout.write(`合并模式：基础 ${jobsCollapsed.rows.length - added} 家 + 官网补充 ${added} 条 = ${jobsCollapsed.rows.length} 家\n`);
  process.stdout.write('→ jobs.json / internships.json / facets.json / dashboard.json / 详情分片 已更新\n');
}

/* ---------- 主流程 ---------- */

// 资料页里带店铺名的购买渠道提醒段落（含紧随其后的店铺截图），导出时整段删除
const DOC_PROMO_RE = /<p>(?:(?!<\/p>)[\s\S])*?婉清学姐(?:(?!<\/p>)[\s\S])*?<\/p>\s*(?:<p>\s*<img\b(?:(?!<\/p>)[\s\S])*?<\/p>\s*)?/g;
const stripDocPromo = (html) => html.replace(DOC_PROMO_RE, '').replace(/\n{3,}/g, '\n\n').trim();

async function saveBitableCache(probe, fullExport) {
  const now = new Date().toISOString();
  await writeFile(BITABLE_REV_FILE, JSON.stringify({
    generatedAt: fullExport ? now : (probe.cache?.generatedAt || now),
    lastSyncAt: now,
    revisions: probe.revisions || {},
    supplementHash: probe.supplementHash,
  }, null, 2), 'utf8');
  process.stdout.write('  → bitable-revisions.json（增量基线已更新）\n');
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  if (process.argv.includes('--merge-only')) return mergeOnly();
  if (process.argv.includes('--docs-only')) return exportDocs();

  const prevJobs = await readPreviousJobs();
  const facets = {};
  const data = {};

  // 优先用自建应用直读多维表格（CI 无 lark-cli），失败或未配置时回退 lark-cli
  let appToken = null;
  try {
    appToken = await feishuTenantToken();
  } catch (e) {
    process.stdout.write(`  ⚠ 应用凭证获取失败，回退 lark-cli：${e.message}\n`);
  }
  if (appToken) process.stdout.write('  · 使用飞书自建应用直读多维表格\n');

  // 飞书表 revision 与官网补充数据相互独立：表未变时复用飞书数据，仅重新合并官网补充。
  let probe = null;
  if (process.argv.includes('--incremental')) {
    probe = await incrementalProbe(appToken);
    process.stdout.write(`  · 增量探针：${probe.reason}\n`);
    if (probe.skip) {
      await exportDocs();
      if (probe.supplementChanged) {
        process.stdout.write('官网补充数据变化，复用飞书数据并重新合并…\n');
        await mergeOnly();
      }
      await saveBitableCache(probe, false);
      process.stdout.write('全部完成（飞书表格无需重新读取）\n');
      return;
    }
  }

  let usedFullExport = !probe || probe.mode === 'full';
  for (const table of TABLES) {
    process.stdout.write(`导出 ${table.key} (${table.tableId})…\n`);
    let exported = null;
    if (probe?.mode === 'incremental') {
      try {
        exported = await exportTableIncremental(table, appToken, probe.updatedSince);
      } catch (e) {
        process.stdout.write(`  ⚠ ${table.key} 增量读取失败（${e.message}），回退全量导出\n`);
      }
      if (!exported) {
        process.stdout.write(`  ⚠ ${table.key} 增量窗口无记录，回退全量对账\n`);
        usedFullExport = true;
      }
    }
    if (!exported) exported = await exportTable(table, appToken);
    if (exported.fetchedCount != null) {
      process.stdout.write(`  ${table.key} 增量读取: ${exported.fetchedCount} 条, 更新 ${exported.changedCount} 条\n`);
    }
    let rows = exported.rows;
    let details = exported.details;
    if (table.key === 'jobs') {
      const merged = mergeSupplement(rows, await loadSupplement());
      rows = merged.rows;
      process.stdout.write(`  ↳ 合并官网补充 ${merged.added} 条\n`);
    }
    const collapsed = collapseByCompany(rows, details);
    rows = collapsed.rows;
    details = collapsed.details;
    if (collapsed.mergedGroups) process.stdout.write(`  ↳ 同公司合并 ${collapsed.mergedGroups} 组\n`);
    data[table.key] = rows;
    await writeFile(path.join(DATA_DIR, `${table.key}.json`), JSON.stringify(encodeRows(rows)), 'utf8');
    await writeSearchIndex(table.key, rows);
    await writeDetailShards(table.key, details);
    facets[table.key] = buildFacets(rows);
    process.stdout.write(`  → ${table.key}.json (${rows.length} 条列表) + ${table.key}-detail-0..${SHARD_COUNT - 1}.json (${Object.keys(details).length} 条详情)\n`);
  }

  await writeFile(path.join(DATA_DIR, 'facets.json'), JSON.stringify(facets), 'utf8');
  const dashboard = buildDashboard(data.jobs, data.internships);
  await writeFile(path.join(DATA_DIR, 'dashboard.json'), JSON.stringify(dashboard), 'utf8');
  const changelog = buildChangelog(prevJobs, data.jobs);
  await writeFile(path.join(DATA_DIR, 'changelog.json'), JSON.stringify(changelog), 'utf8');
  process.stdout.write(`  → facets.json / dashboard.json / changelog.json（新增 ${changelog.addedCount} / 下架 ${changelog.removedCount}）\n`);

  process.stdout.write(`导出央国企名录…\n`);
  const soe = await exportSOE(appToken);
  await writeFile(path.join(DATA_DIR, 'soe.json'), JSON.stringify(soe), 'utf8');
  process.stdout.write(`  → soe.json (${soe.length} 条)\n`);

  process.stdout.write(`导出文档栏目…\n`);
  await exportDocs();
  if (probe) await saveBitableCache(probe, usedFullExport);
  process.stdout.write('全部完成\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error('导出失败:', err);
    process.exit(1);
  });
}

export { encodeRows, decodeRows };
