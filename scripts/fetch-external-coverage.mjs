/* Phase 2：BOSS 直聘 / 智联招聘 岗位覆盖校验（内部官方源 vs 外部平台）
 * - 智联招聘：公开校园招聘岗位页（zhaopin.com/zhaopin/...）可抓取 → 对内部热门公司做覆盖检查
 * - BOSS 直聘：公开校招频道抓取返回空（疑似登录墙/风控）→ 标记为不可抓，后续改用开放 API/人工
 * 输出：data/external-coverage.json
 */
import { chromium } from 'playwright';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const ZHAOPIN_URL = 'https://www.zhaopin.com/zhaopin/ce0da13797714f73954da00b5311fdcb';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
function companyKey(name) {
  return String(name || '')
    .replace(/[（(].*?[)）]/g, '')
    .replace(/(股份有限公司|有限责任公司|有限公司|集团公司|集团|控股|公司|总公司)$/g, '')
    .replace(/\s+/g, '').trim();
}

async function scrapeZhaopinText() {
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, userAgent: UA, locale: 'zh-CN' });
  try {
    await page.goto(ZHAOPIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const text = await page.evaluate(() => document.body.innerText);
    const tlen = (text || '').length;
    await closeBrowser();
    return { text, textLen: tlen, url: page.url() };
  } finally {
    await closeBrowser();
  }
}

async function run() {
  const { text, textLen, url } = await scrapeZhaopinText();
  const internalHot = JSON.parse(await readFile(path.join(DATA_DIR, 'external-hot-diff.json'), 'utf8'));
  const internalHotCompanies = Array.isArray(internalHot.internalHotCompanies) ? internalHot.internalHotCompanies : [];
  const covered = [];
  const notCovered = [];
  for (const c of internalHotCompanies) {
    if (!c) continue;
    if (text && text.includes(c)) covered.push(c);
    else notCovered.push(c);
  }
  const report = {
    generatedAt: new Date().toISOString(),
    source: 'zhaopin',
    pageUrl: url,
    textLen,
    internalHotCount: internalHotCompanies.length,
    externalChecked: true,
    coveredCount: covered.length,
    covered,
    notCovered,
    bossDirect: { status: 'skipped-login-wall', note: 'BOSS直聘公开校招频道抓取返回空/登录墙，本次不纳入覆盖校验' },
  };
  await writeFile(path.join(DATA_DIR, 'external-coverage.json'), JSON.stringify(report, null, 2));
  console.log(`智联公开页抓取完成（textLen=${textLen}）；内部热门 ${internalHotCompanies.length} 家中，命中外部覆盖 ${covered.length} 家。`);
  console.log(`未被外部覆盖到：${notCovered.join('、') || '无'}`);
}

run().then(() => process.exit(0)).catch((e) => { console.error('覆盖校验抓取失败：' + e.message); process.exit(1); });
