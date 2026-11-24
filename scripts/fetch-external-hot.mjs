/* Phase 1：抓取牛客网（nowcoder.com）公开校招/热榜数据，生成外部热度数据源
 * 输出：
 *   - data/external-hot.json      : 外部热榜数据源（供前端热门打分加权使用）
 *   - data/external-hot-diff.json : 内部热门榜（jobs top60 / internships top40）vs 外部热榜 的交叉验证差异
 * 说明：牛客公开页 /jobs/school/schedule 含子 Tab「热门推荐 / 24h更新 / 即将截止 / 我的收藏」，
 *       默认选中「热门推荐」，可用公开页面 + Playwright 抓取（与 fetch-official 同模式）。
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const NC_URL = 'https://www.nowcoder.com/jobs/school/schedule';
const HOT_TABS = ['热门推荐', '24h更新', '即将截止'];
const TOP_JOBS = 60;
const TOP_INTERN = 40;

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function companyKey(name) {
  return String(name || '')
    .replace(/[（(].*?[)）]/g, '')
    .replace(/(股份有限公司|有限责任公司|有限公司|集团公司|集团|控股|公司|总公司)$/g, '')
    .replace(/\s+/g, '').trim();
}

let _browser = null;
let _browserPromise = null;
async function getBrowser() {
  if (!_browserPromise) {
    _browserPromise = (async () => {
      const { chromium } = await import('playwright');
      _browser = await chromium.launch({ headless: true, channel: process.env.PW_BROWSER_CHANNEL || undefined });
      return _browser;
    })().catch((e) => { _browserPromise = null; throw e; });
  }
  return _browserPromise;
}
async function closeBrowser() {
  if (!_browser) return;
  const browser = _browser;
  _browser = null;
  _browserPromise = null;
  await browser.close();
}

async function scrapeNowcoderHot() {
  const browser = await getBrowser();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    userAgent: UA,
    locale: 'zh-CN',
  });
  const entries = [];
  const seenRaw = new Set();
  await page.goto(NC_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(3000);
  for (const tab of HOT_TABS) {
    try {
      try { await page.keyboard.press('Escape'); } catch { /* noop */ }
      await page.waitForTimeout(800);
      await page.locator('.tab-item', { hasText: tab }).first().click({ timeout: 15000 });
      await page.waitForTimeout(2500);
    } catch (e) { console.warn(`点击牛客子 Tab「${tab}」失败：${e.message}`); }
    const items = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.list-item-style'))
        .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean));
    for (const t of items) {
      if (seenRaw.has(t)) continue;
      seenRaw.add(t);
      const company = (t.split(/\s+/)[0] || '').trim();
      const batchM = t.match(/(25|26|27)届((?:秋招|春招|暑期|日常实习|实习|社招)?)/);
      const batch = batchM ? batchM[0] : (t.match(/(日常实习|实习|社招|秋招|春招|暑期)/)?.[0] || '');
      if (!company) continue;
      entries.push({ company, batch, sourceUrl: NC_URL, updatedAt: todayStr(), hot: true, raw: t.slice(0, 120) });
    }
  }
  await closeBrowser();
  const uniq = [];
  const seenC = new Set();
  for (const e of entries) {
    const k = companyKey(e.company);
    if (!k || seenC.has(k)) continue;
    seenC.add(k);
    uniq.push({ company: e.company, batch: e.batch, sourceUrl: e.sourceUrl, updatedAt: e.updatedAt, hot: true });
  }
  return uniq;
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return null;
  const target = new Date(y, m - 1, d);
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - base) / 86400000);
}
function hotScore(row) {
  let score = 0;
  const updatedDays = daysUntil(row.updatedAt);
  if (updatedDays != null) {
    const ago = -updatedDays;
    if (ago <= 1) score += 45;
    else if (ago <= 3) score += 38;
    else if (ago <= 7) score += 30;
    else if (ago <= 30) score += 18;
    else if (ago <= 90) score += 8;
  }
  const deadlineDays = daysUntil(row.deadline);
  if (deadlineDays != null && deadlineDays >= 0) score += deadlineDays <= 7 ? 22 : 14;
  else if (deadlineDays == null && /尽快/.test(row.deadlineText || '')) score += 12;
  score += Math.min((row.positions || []).length, 50) * 0.8;
  score += Math.min((row.cities || []).length, 8);
  if (row.ownership === '央国企') score += 8;
  else if (row.ownership === '外企') score += 6;
  if (row.source === 'official') score += 8;
  if ((row.gradYears || []).includes(2027)) score += 4;
  if ((row.batches || []).some((b) => /秋招|春招|暑期/.test(b))) score += 2;
  return score;
}

async function readJSONSafe(file, fallback) {
  try { return JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8')); } catch { return fallback; }
}

function decodeList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || payload.v !== 2 || !Array.isArray(payload.r)) return [];
  const { d, r } = payload;
  const pick = (k, i) => (i >= 0 && d[k] && d[k][i] !== undefined ? d[k][i] : '');
  const list = (k, arr) => (arr || []).map((i) => pick(k, i)).filter((v) => v !== '');
  return r.map((a) => ({
    id: a[0], company: a[1], ownership: pick('o', a[2]), industries: list('i', a[3]),
    positions: a[4] || [], cities: list('c', a[5]), nationwide: !!a[6], gradYears: a[7] || [],
    gradUnlimited: !!a[8], batches: list('b', a[9]), degree: list('g', a[10]),
    writtenTest: a[11] === 1 ? true : a[11] === 0 ? false : null,
    deadline: a[12] === undefined ? null : a[12], deadlineText: a[13] || '', updatedAt: a[14] || '', sm: a[15] || '',
    source: a[16], sourceName: a[17], sourceUrl: a[18], apply: a[19] ? { url: a[19] } : null, note: a[20], majors: a[21],
  }));
}

async function run() {
  console.log('抓取牛客公开热榜（校招日程 / 热门推荐 / 24h更新 / 即将截止）...');
  const externalHot = await scrapeNowcoderHot();
  const generatedAt = new Date().toISOString();

  const jobsPayload = await readJSONSafe(path.join(DATA_DIR, 'jobs.json'), { r: [] });
  const internPayload = await readJSONSafe(path.join(DATA_DIR, 'internships.json'), { r: [] });
  const jobs = decodeList(jobsPayload).filter((r) => !(r.deadline && daysUntil(r.deadline) < 0));
  const interns = decodeList(internPayload).filter((r) => !(r.deadline && daysUntil(r.deadline) < 0));

  const internalHot = (rows, topN) => rows
    .map((r) => ({ r, s: hotScore(r) }))
    .sort((a, b) => b.s - a.s || String(a.r.updatedAt).localeCompare(String(b.r.updatedAt)))
    .slice(0, topN);

  const jobsHot = internalHot(jobs, TOP_JOBS);
  const internHot = internalHot(interns, TOP_INTERN);
  const internalHotCompanies = [...new Set([...jobsHot.map((x) => x.r.company), ...internHot.map((x) => x.r.company)].map(companyKey).filter(Boolean))];
  const externalHotCompanies = [...new Set(externalHot.map((e) => companyKey(e.company)).filter(Boolean))];
  const internalHotKeys = new Set(internalHotCompanies);
  const externalHotKeys = new Set(externalHotCompanies);
  const externalOnly = externalHotCompanies.filter((k) => !internalHotKeys.has(k));
  const internalOnly = internalHotCompanies.filter((k) => !externalHotKeys.has(k));

  await writeFile(path.join(DATA_DIR, 'external-hot.json'), JSON.stringify({
    generatedAt, source: 'nowcoder',
    entries: externalHot.map((e) => ({ company: e.company, batch: e.batch, sourceUrl: e.sourceUrl, updatedAt: e.updatedAt, hot: e.hot })),
  }, null, 2));

  await writeFile(path.join(DATA_DIR, 'external-hot-diff.json'), JSON.stringify({
    generatedAt, source: 'nowcoder',
    internalHotCount: jobsHot.length + internHot.length,
    internalHotCompanies: internalHotCompanies.map((k) => k),
    externalHotCount: externalHot.length,
    externalHotCompanies: externalHotCompanies.map((k) => k),
    externalOnly, internalOnly,
  }, null, 2));

  console.log(`外部热榜（牛客）共 ${externalHot.length} 家公司；内部热门榜含 ${jobsHot.length + internHot.length} 条（jobs top${TOP_JOBS} + internships top${TOP_INTERN}）。`);
  console.log(`命中：internal∩external=${[...internalHotKeys].filter((k) => externalHotKeys.has(k)).length}；仅外部=${externalOnly.length}；仅内部=${internalOnly.length}。`);
  if (externalOnly.length) console.log('仅外部热榜：' + externalOnly.join('、'));
  if (internalOnly.length) console.log('仅内部热门：' + internalOnly.join('、'));
}

run().then(() => process.exit(0)).catch((e) => { console.error('外部热榜抓取失败：' + e.message); process.exit(1); });
