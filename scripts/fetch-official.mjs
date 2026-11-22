/* 从企业官方校招官网抓取补充岗位，输出 data/supplement.json
 * 与 jobs.json 列表项结构对齐，并附加 source / 内嵌详情字段。
 * mode='http' 直抓 HTML 解析；mode='browser' 用 Playwright 渲染 SPA 后提取。
 */
import * as cheerio from 'cheerio';
import https from 'node:https';
import http from 'node:http';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fetchText(url, timeout = 25000, redirects = 3) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchText(new URL(res.headers.location, url).href, timeout, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
  });
}

async function postJSON(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const REGION_SHORT = {
  新疆维吾尔自治区: '新疆',
  广西壮族自治区: '广西',
  宁夏回族自治区: '宁夏',
  内蒙古自治区: '内蒙古',
  西藏自治区: '西藏',
};

const cleanCity = (c) => {
  const s = String(c || '').replace(/^工作地点/, '').trim();
  if (REGION_SHORT[s]) return REGION_SHORT[s];
  return s.replace(/市$/, '').replace(/省$/, '').replace(/自治区$/, '').trim();
};

// 从 "四川省-成都市-武侯区" 这类路径里挑城市（跳过区级）
const pickCity = (segment) => {
  const parts = String(segment || '').split('-').map((s) => s.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!/区$/.test(parts[i])) return cleanCity(parts[i]);
  }
  return cleanCity(parts[parts.length - 1]);
};

const normalizeCity = (c) => cleanCity(c);
const toISODate = (s) => {
  const m = String(s || '').match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!m) return '';
  const y = Number(m[1]);
  if (y < 2000 || y > 2100) return '';
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
};

const splitCities = (raw) =>
  String(raw || '')
    .split(/[\/、,，]/)
    .map((s) => pickCity(s))
    .filter((s) => s && s.length <= 8);

/* 统一行构造器，保证 supplement 与 jobs.json 结构一致 */
function makeRow(src, o) {
  const position = o.position || '';
  const cities = (o.cities || []).map(normalizeCity).filter(Boolean);
  return {
    id: `off_${src.key}_${o.code}`,
    company: src.company,
    ownership: src.ownership,
    industries: src.industries,
    positions: [position],
    cities,
    nationwide: false,
    gradYears: src.gradYears,
    gradUnlimited: false,
    batches: src.batches,
    degree: o.degree || src.degree,
    writtenTest: null, // 官网列表不提供笔试信息，避免伪造“无笔试”
    deadline: o.deadline && /^\d{4}-\d{2}-\d{2}$/.test(o.deadline) ? o.deadline : '',
    deadlineText: '',
    updatedAt: o.updatedAt || todayStr(),
    sm: String(position || '').toLowerCase(), // 正文已在 note，不再重复写入 sm
    source: 'official',
    sourceName: `${src.company}招聘官网`,
    sourceUrl: src.applyUrl,
    apply: { url: src.applyUrl },
    note: o.note != null ? o.note : (o.content || ''),
    majors: '',
  };
}

/* ---------- 百度：服务端渲染，直接解析 HTML ---------- */

function parseBaidu(html, src) {
  const $ = cheerio.load(html);
  const rows = [];
  $('[class*="post-item__"]').each((i, el) => {
    const $el = $(el);
    const title = $el.find('[class*="post-title-content__"] span').first().text().trim();
    const subs = $el.find('[class*="post-subtitle-item__"]').map((j, s) => $(s).text().trim()).get();
    const content = $el.find('[class*="post-content__"]').text().trim();
    if (!title) return;
    const m = title.match(/\((J[^)]+)\)$/);
    const code = m ? m[1] : `p${i}`;
    const city = normalizeCity(subs[0] || '');
    let position = title.replace(/\([^)]+\)$/, '');
    if (city && position.startsWith(city + '-')) position = position.slice(city.length + 1);
    const deadline = subs[subs.length - 1] || '';
    const count = subs[3] || '';
    rows.push(makeRow(src, {
      code,
      position,
      cities: city ? [city] : [],
      deadline,
      content,
      note: [count ? `招聘人数：${count}` : '', content].filter(Boolean).join('\n'),
    }));
  });
  return rows;
}

/* ---------- 浏览器 ---------- */

let _browser = null;
let _browserPromise = null;
async function getBrowser() {
  if (!_browserPromise) {
    _browserPromise = (async () => {
      const { chromium } = await import('playwright');
      _browser = await chromium.launch({ headless: true });
      return _browser;
    })().catch((e) => {
      _browserPromise = null;
      throw e;
    });
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

/* 通用翻页：readFn 读取当前页，toRow 转统一结构，nextSel 为下一页按钮 */
async function paginate(page, { maxPages = 5, nextSel, readFn, toRow, codePrefix }) {
  const seen = new Set();
  const rows = [];
  for (let p = 1; p <= maxPages; p++) {
    const items = await readFn(page);
    if (!items.length) break;
    for (const it of items) {
      const row = toRow(it, rows.length, codePrefix);
      if (!row) continue;
      const key = `${row.positions[0]}|${row.cities.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    if (p === maxPages) break;
    const next = page.locator(nextSel);
    if ((await next.count()) === 0) break;
    const disabled = await next.first().evaluate((el) =>
      el.hasAttribute('disabled') ||
      el.classList.contains('ant-pagination-disabled') ||
      el.classList.contains('mtd-pagination-item-disabled') ||
      el.getAttribute('aria-disabled') === 'true' ||
      !!el.querySelector('button[disabled]')
    );
    if (disabled) break;
    await next.first().click();
    await page.waitForTimeout(1600);
  }
  return rows;
}

async function runBrowserSource(src) {
  const browser = await getBrowser();
  const page = await browser.newPage({
    userAgent: UA,
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
  });
  try {
    await page.goto(src.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(src.wait || 5000);
    try { await page.waitForLoadState('networkidle', { timeout: 20000 }); } catch {}
    return await src.extract(page, src);
  } finally {
    await page.close();
  }
}

/* ---------- 美团 ---------- */

function readMeituanPage(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.position_list_item')].map((el) => {
      const title = (el.querySelector('.postion_name .title')?.innerText || '').trim();
      const cityRaw = (el.querySelector('.city span')?.innerText || '').trim();
      const lines = [...el.querySelectorAll('.split_line_box_item')].map((x) => (x.innerText || '').trim());
      const upd = lines.find((t) => t.includes('更新于')) || '';
      const duty = [...el.querySelectorAll('.position_duty .desc')]
        .map((x) => (x.innerText || '').trim())
        .filter((t) => t && t !== '岗位职责')
        .join('\n');
      return { title, cityRaw, upd, duty };
    })
  );
}

function extractMeituan(page, src) {
  return paginate(page, {
    maxPages: src.pages || 5,
    nextSel: 'li.mtd-pagination-next',
    codePrefix: 'm',
    readFn: readMeituanPage,
    toRow: (it, idx, pre) => {
      if (!it.title) return null;
      return makeRow(src, {
        code: `${pre}${idx}`,
        position: it.title,
        cities: it.cityRaw.split(/[、,，/]/).map((s) => s.trim()),
        updatedAt: toISODate(it.upd),
        content: it.duty,
      });
    },
  });
}

/* ---------- 快手 ---------- */

function readKuaishouPage(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.item')].map((el) => {
      const nameEl = el.querySelector('.name');
      const name = (nameEl?.getAttribute('title') || nameEl?.innerText || '').trim();
      const nature = (el.querySelector('.position-nature')?.innerText || '').trim();
      const cat = (el.querySelector('.position-category')?.innerText || '').trim();
      const loc = (el.querySelector('.work-location')?.innerText || '').trim();
      const time = (el.querySelector('.update-time')?.innerText || '').trim();
      return { name, nature, cat, loc, time };
    })
  );
}

function extractKuaishou(page, src) {
  return paginate(page, {
    maxPages: src.pages || 5,
    nextSel: '.ant-pagination-next',
    codePrefix: 'k',
    readFn: readKuaishouPage,
    toRow: (it, idx, pre) => {
      if (!it.name) return null;
      return makeRow(src, {
        code: `${pre}${idx}`,
        position: it.name,
        cities: splitCities(it.loc),
        updatedAt: toISODate(it.time),
        content: [it.nature, it.cat].filter(Boolean).join(' '),
        note: [it.nature, it.cat].filter(Boolean).join(' · '),
      });
    },
  });
}

/* ---------- 京东 ---------- */

function readJDPage(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[class*="item___"]')]
      .filter((el) => el.querySelector('[class*="content___"]') || el.querySelector('[class*="addrBox___"]'))
      .map((el) => {
        const head = el.querySelector('div');
        const spans = head ? [...head.querySelectorAll('span')] : [];
        const title = (spans[0]?.innerText || '').trim();
        const desc = (el.querySelector('[class*="content___"]')?.innerText || '').trim();
        const addr = (el.querySelector('[class*="addrBox___"]')?.innerText || '').trim();
        const biz = (el.querySelector('[class*="bgBox___"]')?.innerText || '').trim();
        return { title, desc, addr, biz };
      })
  );
}

function extractJD(page, src) {
  return paginate(page, {
    maxPages: src.pages || 5,
    nextSel: '.ant-pagination-next',
    codePrefix: 'j',
    readFn: readJDPage,
    toRow: (it, idx, pre) => {
      if (!it.title) return null;
      return makeRow(src, {
        code: `${pre}${idx}`,
        position: it.title,
        cities: splitCities(it.addr),
        updatedAt: '',
        content: it.desc,
        note: [it.biz.replace(/^所属业务/, '').trim(), it.desc].filter(Boolean).join('\n'),
      });
    },
  });
}

/* ---------- 腾讯 ---------- */

function readTencentPage(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.post_box')].map((el) => ({
      title: (el.querySelector('.post_title')?.innerText || '').trim(),
      tags: [...el.querySelectorAll('.post_tag')]
        .map((t) => (t.innerText || '').replace(/｜/g, ' ').replace(/\s+/g, ' ').trim())
        .filter(Boolean),
      site: (el.querySelector('.site')?.innerText || '').replace(/\s+/g, ' ').trim(),
    }))
  );
}

function extractTencent(page, src) {
  return paginate(page, {
    maxPages: src.pages || 5,
    nextSel: '.el-pagination .btn-next',
    codePrefix: 't',
    readFn: readTencentPage,
    toRow: (it, idx, pre) => {
      if (!it.title) return null;
      return makeRow(src, {
        code: `${pre}${idx}`,
        position: it.title,
        cities: it.site.replace(/总部/g, '').split(/\s+/).map((s) => s.trim()),
        updatedAt: '',
        content: it.tags.join(' '),
        note: it.tags.join(' · '),
      });
    },
  });
}

/* ---------- 华为：官方列表 API（POST JSON） ---------- */

const HW_HEADERS = {
  Referer: 'https://career.huawei.com/',
  'x-jalor-tenantalias': 'hcm',
  'x-alb-gray': 'prod',
  'x-language': 'zh_CN',
  'x-referer': 'https://career.huawei.com/cn',
  'User-Agent': UA,
};

async function collectHuawei(src) {
  const out = [];
  for (let p = 1; p <= 10; p++) {
    const j = await postJSON(src.apiUrl, {
      curPage: p,
      pageSize: 20,
      jobType: 'CR',
      recruitmentType: ['FRESH_GRADUATE'],
    }, HW_HEADERS);
    const d = j?.data || {};
    const arr = d.result || [];
    if (!arr.length) break;
    out.push(...arr);
    if (out.length >= (d.pageVO?.totalRows || 0)) break;
  }
  const seen = new Set();
  const rows = [];
  out.forEach((it, idx) => {
    const position = it.jobNameNew || it.jobName || '';
    if (!position) return;
    const key = `${position}|${it.workPlace || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(makeRow(src, {
      code: `h${idx}`,
      position,
      cities: splitCities(it.workPlace),
      updatedAt: toISODate(it.lastUpdateDate),
      content: [it.categoryName, it.deptName].filter(Boolean).join(' '),
      note: it.categoryName || '',
    }));
  });
  return rows;
}

/* ---------- 北森 zhiye 系：统一 JSON API ---------- */

const zhiyeHeaders = (host) => ({
  'Content-Type': 'application/json',
  Accept: 'application/json, text/plain, */*',
  Origin: `https://${host}`,
  Referer: `https://${host}/campus/jobs`,
  'User-Agent': UA,
});

async function zhiyePost(host, pathname, body) {
  const res = await fetch(`https://${host}${pathname}`, {
    method: 'POST',
    headers: zhiyeHeaders(host),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ATS 只设防死循环的保险上限；触及上限必须报错，不能静默截断。 */
const ATS_PAGE_LIMIT = 200;

/* 拉取一页/全部职位；locId 为地区码数组，null 表示不过滤 */
async function zhiyeList(host, portalId, locId, maxPages = 20, strict = false) {
  const out = [];
  for (let p = 0; p < maxPages; p++) {
    const body = {
      PageIndex: p,
      PageSize: 50,
      Category: ['2'],
      KeyWords: '',
      SpecialType: 0,
      PortalId: portalId || '',
      DisplayFields: ['Category', 'Kind', 'PostDate'],
    };
    if (locId) body.LocId = locId;
    const j = await zhiyePost(host, '/api/Jobad/GetJobAdPageList', body);
    const arr = j.Data || [];
    out.push(...arr);
    if (arr.length < 50) break;
    if (strict && p + 1 >= maxPages) {
      throw new Error(`${host} 北森岗位超过 ${maxPages} 页，已停止以避免静默截断`);
    }
  }
  return out;
}

const stripJobCode = (s) => String(s || '').replace(/\(J\d+\)\s*$/, '').trim();

async function collectZhiye(src) {
  const host = src.host;
  /* 地区码 → 名称 */
  let tree = [];
  try {
    const res = await fetch(`https://${host}/api/Jobad/SearchAreasTreeConditions?categoryId=2&_timestamp=${Date.now()}`, {
      headers: zhiyeHeaders(host),
    });
    tree = (await res.json()).Data || [];
  } catch {}
  const nameOf = new Map(tree.map((t) => [String(t.Code), cleanCity((t.Name && t.Name[0]) || '')]));
  const parentOf = new Map(tree.map((t) => [String(t.Code), String(t.ParentCode || '')]));

  /* 自动翻到短页，企业配置中的 pages 不再决定抓取完整性。 */
  const all = await zhiyeList(host, src.portalId, null, ATS_PAGE_LIMIT, true);

  /* 按地区计数，只查有岗位的叶子地区，给岗位补城市 */
  const cityByJob = new Map();
  let counts = {};
  if (tree.length) {
    try {
      const q = src.portalId ? `?portalId=${src.portalId}` : '';
      const cj = await zhiyePost(host, `/api/Jobad/GetJobCount${q}`, {
        Condition: [{ Type: 'workLocation', Values: tree.map((t) => t.Code) }],
        Category: 'campus',
      });
      counts = cj.Data || {};
    } catch {}
  }
  const active = Object.entries(counts)
    .filter(([, n]) => Number(n) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([c]) => c);
  const leaf = active
    .filter((c) => !active.some((o) => parentOf.get(o) === c))
    .slice(0, src.cityLimit || 24); // 大城市优先，避免长尾地区拖慢抓取
  for (const code of leaf) {
    if (code === '1') continue; // 全国：不作为城市
    const nm = /^2$/.test(code) ? '海外' : nameOf.get(code) || '';
    if (!nm) continue;
    try {
      const arr = await zhiyeList(host, src.portalId, [Number(code)], 1);
      for (const it of arr) {
        if (!cityByJob.has(it.Id)) cityByJob.set(it.Id, new Set());
        cityByJob.get(it.Id).add(nm);
      }
    } catch {}
  }

  const seen = new Set();
  const rows = [];
  all.forEach((it, idx) => {
    if (!it.Id || seen.has(it.Id)) return;
    seen.add(it.Id);
    const raw = String(it.JobAdName || '').trim();
    if (!raw) return;
    const position = stripJobCode(raw.replace(/^【[^】]*】/, '')) || stripJobCode(raw);
    const duty = String(it.Duty || '').trim();
    const require = String(it.Require || '').trim();
    const directCities = Array.isArray(it.LocNames)
      ? [...new Set(it.LocNames.flatMap((s) => splitCities(String(s).replace(/·/g, '-'))))]
      : [];
    rows.push(makeRow(src, {
      code: `z${idx}`,
      position,
      cities: directCities.length ? directCities : [...(cityByJob.get(it.Id) || [])],
      updatedAt: toISODate(it.PostDate),
      deadline: toISODate(it.EndTime),
      content: [duty, require].filter(Boolean).join(' '),
      note: [duty, require ? `任职要求：\n${require}` : ''].filter(Boolean).join('\n\n'),
    }));
  });
  return rows;
}

/* ---------- Moka：通用校招官网（浏览器渲染） ----------
 * Moka 的职位接口已加密（data 为密文），改为解析渲染后的职位卡。
 * 卡片结构：标题 / 信息行（部门|职能|学历|城市）/ 完整 JD。
 */

const MOKA_DEGREE_RE = /^(大专|本科|硕士|博士|不限)$/;

function parseMokaInfo(raw) {
  const segs = String(raw || '')
    .split('|')
    .map((s) => [...new Set(s.trim().split(/\s+/).filter(Boolean))].join(' '))
    .filter(Boolean);
  const degree = segs.find((s) => MOKA_DEGREE_RE.test(s)) || '';
  const cityRaw = segs[segs.length - 1] || '';
  const cities = cityRaw
    .split(/\s+/)
    .map((s) => s.replace(/等\d+个地点$/, ''))
    .filter((s) => s.includes('·') || /市$/.test(s))
    .map((s) => normalizeCity(s.split('·').pop()))
    .filter(Boolean);
  return { degree, cities: [...new Set(cities)], info: segs.join(' · ') };
}

async function collectMoka(src) {
  const browser = await getBrowser();
  const page = await browser.newPage({
    userAgent: UA,
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
  });
  try {
    const url = /#/.test(src.url) ? src.url : `${src.url.replace(/\/$/, '')}#/jobs`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    const cookieAccept = page.getByRole('button', { name: '好的', exact: true });
    if (await cookieAccept.count()) {
      await cookieAccept.click({ timeout: 8000 });
      await page.waitForTimeout(1000);
    }
    if (!(await page.locator('[class*="card-content-"]').count())) {
      const tab = page.locator('text=职位列表').first();
      if (await tab.count()) {
        await tab.click().catch(() => {});
        await page.waitForTimeout(3000);
      }
    }

    const seen = new Set();
    const rows = [];
    const maxPages = ATS_PAGE_LIMIT;
    for (let p = 1; p <= maxPages; p++) {
      const items = await page.evaluate(() =>
        [...document.querySelectorAll('[class*="card-content-"]')].map((el) => ({
          title: (el.querySelector('[class*="title-"]')?.innerText || '').trim().split('\n')[0],
          infoRaw: (el.querySelector('[class*="info-"]')?.innerText || '').replace(/\s+/g, ' ').trim(),
          desc: (el.querySelector('[class*="job-description-"]')?.innerText || '').trim(),
        }))
      );
      if (!items.length) {
        if (p === 1) break;
        throw new Error(`${src.company} Moka 翻页后岗位列表为空，已停止以避免静默截断`);
      }
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it.title) continue;
        // 校招官网常把实习岗混在同一列表，实习由独立板块承载，这里跳过
        if (/实习/.test(it.title)) continue;
        const info = parseMokaInfo(it.infoRaw);
        const key = `${it.title}|${info.cities.join(',')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let cities = info.cities;
        let note = it.desc;
        if (src.details) {
          await page.locator('[class*="card-content-"]').nth(i).click();
          await page.waitForURL(/#\/job\//, { timeout: 15000 });
          await page.waitForTimeout(800);
          const detail = await page.evaluate(() => {
            const body = document.body.innerText;
            const start = body.indexOf('职位描述');
            const end = body.lastIndexOf('职位信息');
            const location = body.match(/工作地点\s*\n工作地点\s*\n([^\n]+)/);
            return {
              note: start >= 0 && end > start ? body.slice(start + '职位描述'.length, end).trim() : '',
              cityRaw: location ? location[1].trim() : '',
            };
          });
          if (!detail.note || !detail.cityRaw) throw new Error(`${src.company}「${it.title}」详情正文或工作地点为空`);
          note = detail.note;
          cities = parseMokaInfo(detail.cityRaw).cities;
          await page.goBack({ waitUntil: 'domcontentloaded' });
          await page.waitForSelector('[class*="card-content-"]', { timeout: 15000 });
        }
        rows.push(makeRow(src, {
          code: `mk${rows.length}`,
          position: it.title,
          cities,
          degree: info.degree ? [info.degree] : src.degree,
          note,
        }));
      }
      const firstTitle = items[0].title;
      const next = page.locator('[class*="Pagination-icon"]').last();
      if (!(await next.count())) break;
      const disabled = (await next.isDisabled()) || await next.evaluate((el) => {
        let n = el;
        for (let i = 0; i < 6 && n; i++) {
          const className = typeof n.className === 'string' ? n.className : (n.className?.baseVal || '');
          if (
            n.hasAttribute?.('disabled') ||
            n.getAttribute?.('aria-disabled') === 'true' ||
            n.disabled === true ||
            /disabled/i.test(className)
          ) return true;
          n = n.parentElement;
        }
        return false;
      });
      if (disabled) break;
      if (p === maxPages) {
        throw new Error(`${src.company} Moka 岗位超过 ${maxPages} 页，已停止以避免静默截断`);
      }
      try { await next.click({ timeout: 8000 }); }
      catch (e) { throw new Error(`${src.company} Moka 下一页点击失败：${e.message}`); }
      await page.waitForTimeout(2500);
      const after = await page.evaluate(() =>
        (document.querySelector('[class*="card-content-"] [class*="title-"]')?.innerText || '').trim().split('\n')[0]
      );
      if (!after || after === firstTitle) {
        throw new Error(`${src.company} Moka 下一页未出现新岗位，已停止以避免静默截断`);
      }
    }
    return rows;
  } finally {
    await page.close();
  }
}

/* ---------- 比亚迪 / 拼多多：官方公开职位接口 ---------- */

async function collectByd(src) {
  const items = [];
  let totalPage = 1;
  let totalCount = null;
  for (let p = 1; p <= totalPage; p++) {
    if (p > ATS_PAGE_LIMIT) throw new Error(`${src.company} 职位超过 ${ATS_PAGE_LIMIT} 页，已停止以避免静默截断`);
    const j = await postJSON('https://job.byd.com/portal/api/portal-api/schoolPortal/queryPositionList', {
      topicCode: '', batch: '2027', campusNature: '008501', abroad: '', degree: '',
      jobType: [], researchDirection: [], workPlace: [], keywords: '', pageSize: 100, pageIndex: p,
    }, { Referer: 'https://job.byd.com/portal/pc/#/school/home' });
    if (j.code !== 0 || !Array.isArray(j.data)) throw new Error(`${src.company} 职位接口异常：${j.msg || '未知错误'}`);
    items.push(...j.data);
    totalPage = Number(j.page?.totalPage) || p;
    totalCount = Number(j.page?.totalCount);
    if (!j.data.length && p < totalPage) throw new Error(`${src.company} 第 ${p} 页为空，已停止以避免静默截断`);
  }
  if (totalCount != null && items.length !== totalCount) {
    throw new Error(`${src.company} 岗位数 ${items.length} 与官网总数 ${totalCount} 不一致`);
  }
  return items.map((it) => makeRow(src, {
    code: it.id,
    position: it.jobName,
    cities: splitCities(it.workPlace),
    updatedAt: toISODate(it.updateTime),
    content: it.jobType || '',
    note: it.jobType ? `职位类别：${it.jobType}` : '',
  }));
}

async function collectPdd(src) {
  const items = [];
  const pageSize = 10; // 官网服务端固定每页最多返回 10 条
  let total = null;
  for (let p = 1; p <= ATS_PAGE_LIMIT; p++) {
    const j = await postJSON('https://careers.pddglobalhr.com/api/careers/api/recruit/position/list', {
      page: p, pageSize, t: null,
    }, { Referer: 'https://careers.pddglobalhr.com/campus/grad' });
    const list = j.result?.list;
    if (!j.success || !Array.isArray(list)) throw new Error(`${src.company} 职位接口异常：${j.errorMsg || '未知错误'}`);
    items.push(...list);
    total = Number(j.result.total);
    if (items.length >= total || list.length < pageSize) break;
    if (p === ATS_PAGE_LIMIT) throw new Error(`${src.company} 职位超过 ${ATS_PAGE_LIMIT} 页，已停止以避免静默截断`);
  }
  if (total != null && items.length !== total) {
    throw new Error(`${src.company} 岗位数 ${items.length} 与官网总数 ${total} 不一致`);
  }
  return items.map((it) => {
    const meta = [it.recruitTypeName, it.jobName, it.graduationYear ? `${it.graduationYear}届` : ''].filter(Boolean).join(' · ');
    const rawLocation = String(it.workLocationName || it.workLocation || '').trim();
    const explicitCities = rawLocation.match(/^广东[（(]([^）)]+)[）)]$/);
    const cityRaw = rawLocation === '全国多省区' ? '全国'
      : rawLocation.startsWith('广东省（如') ? '广东'
        : explicitCities ? explicitCities[1] : rawLocation;
    const cities = splitCities(cityRaw).map((c) => c.replace(/^广东(?=肇庆$)/, '').replace(/^河北(?=雄安$)/, ''));
    return makeRow(src, {
      code: it.id,
      position: it.name,
      cities,
      updatedAt: it.releaseTime ? toISODate(new Date(Number(it.releaseTime)).toISOString()) : '',
      content: [meta, it.jobDuty].filter(Boolean).join(' '),
      note: [meta, it.jobDuty].filter(Boolean).join('\n\n'),
    });
  });
}

/* ---------- 通用小工具：HTML 转文本 / 并发映射 ---------- */

const htmlToText = (h) =>
  String(h || '')
    .replace(/<(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n· ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------- 携程：招聘官网 JSON API ---------- */

const CITY_EN = {
  Shanghai: '上海', Beijing: '北京', Guangzhou: '广州', Shenzhen: '深圳', Hangzhou: '杭州',
  Chengdu: '成都', Nantong: '南通', Wuhan: '武汉', Nanjing: '南京', "Xi'an": '西安',
  Suzhou: '苏州', Chongqing: '重庆', Tianjin: '天津', Qingdao: '青岛', Xiamen: '厦门',
  Changsha: '长沙', Zhengzhou: '郑州', Hefei: '合肥', Jinan: '济南', Shenyang: '沈阳',
  Dalian: '大连', Harbin: '哈尔滨', Kunming: '昆明', Guiyang: '贵阳', Fuzhou: '福州',
  Nanchang: '南昌', Wuxi: '无锡', Foshan: '佛山', Dongguan: '东莞', Zhuhai: '珠海',
  'Hong Kong': '香港', Tokyo: '东京', Singapore: '新加坡', Seoul: '首尔', Bangkok: '曼谷',
  'Kuala Lumpur': '吉隆坡', Edinburgh: '爱丁堡', London: '伦敦',
};

async function collectCtrip(src) {
  const res = await fetch('https://careers.ctrip.com/api/hrrecruit/getJobAd', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: 'https://careers.ctrip.com',
      Referer: 'https://careers.ctrip.com/',
      'User-Agent': UA,
    },
    body: JSON.stringify({
      condition: { fromId: [], keyword: '', kind: [], country: [], city: [], bucode: [], jobFamilyCode: [], jobFamilyGroupCode: [], category: 2 },
      pager: { index: '1', size: '100' },
      head: { language: 'zh_CN', version: '1' },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const list = j?.retValue?.recruitJobAdList || [];
  const rows = [];
  list.forEach((it, idx) => {
    const raw = String(it.jobTitle || '').trim();
    if (!raw) return;
    const position = stripJobCode(raw).replace(/^校招[-－]?\s*/, '');
    const duty = htmlToText(it.duty);
    const req = htmlToText(it.requirements);
    const cityRaw = String(it.cityName || '').trim();
    rows.push(makeRow(src, {
      code: `c${idx}`,
      position,
      cities: splitCities(CITY_EN[cityRaw] || cityRaw),
      updatedAt: toISODate(it.publishDate),
      content: [duty, req, it.kindName, it.buName].filter(Boolean).join(' '),
      note: [duty ? `岗位职责：\n${duty}` : '', req ? `任职要求：\n${req}` : ''].filter(Boolean).join('\n\n'),
    }));
  });
  return rows;
}

/* ---------- 理想汽车：校招列表 + 详情 ---------- */

const LX_API = 'https://api-web.lixiang.com/osd-hr-recruitment-website/v1/recruit';
const lxHeaders = {
  Accept: 'application/json',
  Origin: 'https://www.lixiang.com',
  Referer: 'https://www.lixiang.com/',
  'User-Agent': UA,
};

async function collectLixiang(src) {
  /* 城市字典：城市名 + 区名拼接，如「上海闵行区」 */
  const cityNames = [];
  try {
    const res = await fetch(`${LX_API}/job/location?hire_mode=2`, { headers: lxHeaders });
    const j = await res.json();
    for (const p of j?.data?.items || []) {
      for (const c of p.city_list || []) if (c.name) cityNames.push(c.name);
    }
  } catch {}
  cityNames.sort((a, b) => b.length - a.length);
  const cityOf = (t) => {
    const s = String(t || '').trim();
    if (!s) return '';
    return cityNames.find((c) => s.startsWith(c)) || cityNames.find((c) => s.includes(c)) || cleanCity(s);
  };

  /* 列表 */
  const all = [];
  for (let p = 1; p <= 30; p++) {
    const res = await fetch(`${LX_API}/school/job-page?page=${p}&page_size=100&job_mode=1`, { headers: lxHeaders });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const d = j?.data || {};
    const items = d.items || [];
    all.push(...items);
    if (!items.length || p >= (d.total_pages || 0)) break;
  }

  /* 详情：并发 8 */
  const details = await mapLimit(all, 8, async (it) => {
    try {
      const res = await fetch(`${LX_API}/job/detail?job_id=${it.id}`, { headers: lxHeaders });
      const j = await res.json();
      return j?.data || {};
    } catch {
      return {};
    }
  });

  const seen = new Set();
  const rows = [];
  all.forEach((it, idx) => {
    const position = String(it.title || '').trim();
    if (!position || seen.has(it.id)) return;
    seen.add(it.id);
    const d = details[idx] || {};
    const desc = htmlToText(d.description);
    const req = htmlToText(d.requirements);
    rows.push(makeRow(src, {
      code: `l${idx}`,
      position,
      cities: [cityOf(it.location_title)].filter(Boolean),
      content: [desc, req, it.first_job_function_title, it.second_job_function_title, it.department_title].filter(Boolean).join(' '),
      note: [desc ? `岗位职责：\n${desc}` : '', req ? `任职要求：\n${req}` : ''].filter(Boolean).join('\n\n'),
    }));
  });
  return rows;
}

/* ---------- 用友：hotjob 校招列表 ---------- */

const YONYOU_SK = 'SU67ac41886202cc7916ae3029';

async function collectYonyou(src) {
  const url = `https://career.yonyou.com/wecruit/positionInfo/listPosition/${YONYOU_SK}?iSaJAx=isAjax&request_locale=zh_CN&t=${Date.now()}`;
  const all = [];
  for (let p = 1; p <= 10; p++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json',
        Referer: `https://career.yonyou.com/${YONYOU_SK}/pb/school.html`,
        'User-Agent': UA,
      },
      body: `isFrompb=true&recruitType=1&pageSize=50&currentPage=${p}`,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const pf = j?.data?.pageForm || {};
    const arr = pf.pageData || [];
    all.push(...arr);
    if (!arr.length || p >= (pf.totalPage || 0)) break;
  }
  const rows = [];
  all.forEach((it, idx) => {
    const position = String(it.postName || '').trim();
    if (!position) return;
    const extra = [it.department, it.projectName, it.educationStr, it.postTypeName].filter(Boolean);
    rows.push(makeRow(src, {
      code: `y${idx}`,
      position,
      cities: splitCities(it.workPlaceStr),
      updatedAt: toISODate(it.publishDate),
      deadline: toISODate(it.endDate),
      content: extra.join(' '),
      note: [
        it.department ? `所属部门：${it.department}` : '',
        it.projectName ? `招聘项目：${it.projectName}` : '',
        it.educationStr ? `学历要求：${it.educationStr}` : '',
      ].filter(Boolean).join('\n'),
    }));
  });
  return rows;
}

/* ---------- 数据源配置 ---------- */

/* ---------- 中国公共招聘网（人社部）：补充应届岗位 ----------
 * 页面把当页岗位以 JSON 塞在隐藏域 #findjoblist 中，服务端渲染、无需登录。
 * 用「应届生/毕业生/校园招聘」等关键词过滤，再按岗位 id 去重。
 */

function cityFromAddress(addr, fallback) {
  // 先去掉省级前缀，避免把“江苏省扬州”整段当成城市
  const s = String(addr || '').replace(/^[\u4e00-\u9fa5]{2,8}?(?:省|自治区)/, '');
  const m = s.match(/^([\u4e00-\u9fa5]{2,4})市/) || s.match(/([\u4e00-\u9fa5]{2,4})市/) ||
    s.match(/^([\u4e00-\u9fa5]{2,6}?(?:自治州|地区|盟))/) || s.match(/([\u4e00-\u9fa5]{2,6}?(?:自治州|地区|盟))/);
  if (m) return cleanCity(m[1]);
  return cleanCity(String(fallback || ''));
}

function publicRow(it) {
  const company = String(it.aab004 || '').trim();
  const position = String(it.aca112 || it.aac112 || '').trim();
  if (!company || !position) return null;
  const jd = String(it.acb22a || '').trim();
  const salary = it.acb241 && it.acb242 ? `${it.acb241}-${it.acb242} 元/月` : '';
  const degree = /博士/.test(jd)
    ? ['博士']
    : /硕士/.test(jd)
      ? ['硕士', '博士']
      : /本科/.test(jd)
        ? ['本科', '硕士', '博士']
        : ['大专', '本科'];
  const url = `http://job.mohrss.gov.cn/cjobs/jobinfolist/cb21/showwlzpgw?id=${it.acb200}`;
  return {
    id: `pub_${it.acb200}`,
    company,
    ownership: '其他',
    industries: ['其他'],
    positions: [position],
    cities: [cityFromAddress(it.acb202 || it.aae006, it.aab302)].filter(Boolean),
    nationwide: false,
    gradYears: [2027],
    gradUnlimited: true,
    batches: ['秋招'],
    degree,
    writtenTest: null,
    deadline: toISODate(it.s_aae398),
    deadlineText: '',
    updatedAt: toISODate(it.s_aae397) || todayStr(),
    sm: position.toLowerCase(),
    source: 'public',
    sourceName: '中国公共招聘网',
    sourceUrl: url,
    apply: { url },
    note: [salary ? `薪资：${salary}` : '', jd].filter(Boolean).join('\n'),
    majors: '',
  };
}

async function collectPublic(src) {
  const rows = [];
  const seen = new Set();
  // 公共招聘网以中小企业为主，只保留规模企业/事业单位，避免稀释校招岗位质量
  const INSTITUTION_RE = /(集团|股份|研究院|设计院|医院|大学|学院|学校|银行|证券|保险|电网|电力|烟草|铁路|航空|航天|船舶|中建|中铁|中交|中冶|中化|中电|中核|中粮|中材|国药|中国|国家|事务所)/;
  const keywords = src.keywords || ['应届生', '毕业生', '校园招聘'];
  for (const kw of keywords) {
    for (let page = 1; page <= (src.pages || 4); page++) {
      const url = `http://job.mohrss.gov.cn/cjobs/jobinfolist/listJobinfolist?pageNo=${page}&orderType=score&textfield=${encodeURIComponent(kw)}`;
      let html;
      try {
        html = await fetchText(url, 30000);
      } catch {
        break;
      }
      const $ = cheerio.load(html);
      const raw = $('#findjoblist').attr('value') || '';
      if (!raw) break;
      let list;
      try {
        list = JSON.parse(cheerio.load(raw).text() || raw);
      } catch {
        break;
      }
      if (!Array.isArray(list) || !list.length) break;
      let fresh = 0;
      for (const it of list) {
        const row = publicRow(it);
        if (!row || seen.has(row.id)) continue;
        if (row.company.includes('\uFFFD') || !INSTITUTION_RE.test(row.company)) continue;
        if (!/应届|毕业生|校园|储备干部|管培/.test(`${it.acb22a || ''}${row.positions[0]}`)) continue;
        seen.add(row.id);
        rows.push(row);
        fresh += 1;
      }
      if (!fresh) break;
      await sleep(400);
    }
  }
  return rows;
}

const SOURCES = [
  {
    key: 'baidu',
    mode: 'http',
    company: '百度',
    ownership: '民企',
    industries: ['IT/互联网/游戏'],
    degree: ['本科', '硕士'],
    gradYears: [2027],
    batches: ['秋招'],
    url: 'https://talent.baidu.com/jobs/list?jobType=campus',
    applyUrl: 'https://talent.baidu.com/jobs/list?jobType=campus',
    parse: parseBaidu,
  },
  {
    key: 'meituan',
    mode: 'browser',
    company: '美团',
    ownership: '民企',
    industries: ['IT/互联网/游戏', '生活服务业'],
    degree: ['本科', '硕士'],
    gradYears: [2027],
    batches: ['秋招'],
    url: 'https://zhaopin.meituan.com/web/campus',
    applyUrl: 'https://zhaopin.meituan.com/web/campus',
    wait: 5000,
    pages: 5,
    extract: extractMeituan,
  },
  {
    key: 'kuaishou',
    mode: 'browser',
    company: '快手',
    ownership: '民企',
    industries: ['IT/互联网/游戏'],
    degree: ['本科', '硕士'],
    gradYears: [2027],
    batches: ['秋招'],
    url: 'https://campus.kuaishou.cn/#/campus/jobs',
    applyUrl: 'https://campus.kuaishou.cn/#/campus/jobs',
    wait: 6000,
    pages: 5,
    extract: extractKuaishou,
  },
  {
    key: 'jd',
    mode: 'browser',
    company: '京东',
    ownership: '民企',
    industries: ['IT/互联网/游戏', '交通/物流/仓储'],
    degree: ['本科', '硕士'],
    gradYears: [2027],
    batches: ['秋招'],
    url: 'https://campus.jd.com/#/jobs',
    applyUrl: 'https://campus.jd.com/#/jobs',
    wait: 7000,
    pages: 5,
    extract: extractJD,
  },
  {
    key: 'tencent',
    mode: 'browser',
    company: '腾讯',
    ownership: '民企',
    industries: ['IT/互联网/游戏'],
    degree: ['本科', '硕士'],
    gradYears: [2027],
    batches: ['秋招'],
    url: 'https://join.qq.com/post.html',
    applyUrl: 'https://join.qq.com/post.html',
    wait: 6000,
    pages: 5,
    extract: extractTencent,
  },
  {
    key: 'huawei',
    mode: 'http',
    company: '华为',
    ownership: '民企',
    industries: ['电子/通信/半导体'],
    degree: ['本科', '硕士'],
    gradYears: [2027],
    batches: ['秋招'],
    url: 'https://career.huawei.com/cn/campus-recruitment-job-list?recruitmentType=FRESH_GRADUATE',
    applyUrl: 'https://career.huawei.com/cn/campus-recruitment',
    apiUrl: 'https://apigw-dgg-b0.huawei.com/api/apig/channelhw/recruitmentPosition/pub/getJobPage?X-HW-ID=app_000000035886',
    collect: collectHuawei,
  },
  {
    key: 'dahua',
    mode: 'http',
    company: '大华股份',
    ownership: '民企',
    industries: ['电子/通信/半导体'],
    degree: ['本科', '硕士'],
    gradYears: [2027],
    batches: ['秋招'],
    url: 'https://dahua.zhiye.com/campus/jobs',
    applyUrl: 'https://dahua.zhiye.com/campus/jobs',
    host: 'dahua.zhiye.com',
    portalId: '455a866e-2e06-4ff1-8c1f-8dd03749a267',
    collect: collectZhiye,
  },
  {
    key: 'boe',
    mode: 'http',
    company: '京东方',
    ownership: '民企',
    industries: ['电子/通信/半导体'],
    degree: ['本科', '硕士'],
    gradYears: [2027],
    batches: ['秋招'],
    url: 'https://boe.zhiye.com/campus/jobs',
    applyUrl: 'https://boe.zhiye.com/campus/jobs',
    host: 'boe.zhiye.com',
    portalId: 'e71a8ad7-a321-4305-80db-73f2f18f8d22',
    collect: collectZhiye,
    optional: true, // 通道关闭时允许 0 条，不产生告警
  },
  {
    key: 'ctrip',
    mode: 'http',
    company: '携程',
    ownership: '民企',
    industries: ['IT/互联网/游戏', '生活服务业'],
    degree: ['本科', '硕士'],
    gradYears: [2027],
    batches: ['秋招'],
    url: 'https://careers.ctrip.com/#/campus/jobList',
    applyUrl: 'https://careers.ctrip.com/#/campus/jobList',
    collect: collectCtrip,
  },
  {
    key: 'lixiang',
    mode: 'http',
    company: '理想汽车',
    ownership: '民企',
    industries: ['制造业'],
    degree: ['本科', '硕士'],
    gradYears: [2027],
    batches: ['秋招'],
    url: 'https://www.lixiang.com/employ/campus/list.html?fromJob=1&job_mode=1',
    applyUrl: 'https://www.lixiang.com/employ/campus/list.html?fromJob=1&job_mode=1',
    collect: collectLixiang,
  },
  {
    key: 'yonyou',
    mode: 'http',
    company: '用友',
    ownership: '民企',
    industries: ['IT/互联网/游戏'],
    degree: ['本科', '硕士'],
    gradYears: [2027],
    batches: ['秋招'],
    url: 'https://career.yonyou.com/SU67ac41886202cc7916ae3029/pb/school.html',
    applyUrl: 'https://career.yonyou.com/SU67ac41886202cc7916ae3029/pb/school.html',
    collect: collectYonyou,
  },
  {
    key: 'public-mohrss',
    mode: 'http',
    company: '中国公共招聘网',
    ownership: '其他',
    industries: ['其他'],
    degree: ['本科', '硕士'],
    gradYears: [2027],
    batches: ['秋招'],
    url: 'http://job.mohrss.gov.cn/cjobs/jobinfolist/listJobinfolist',
    applyUrl: 'http://job.mohrss.gov.cn/',
    pages: 4,
    keywords: ['应届生', '毕业生', '校园招聘', '储备干部', '管培生'],
    collect: collectPublic,
  },
];

/* ---------- ATS 企业在册表（data/ats-companies.json） ----------
 * 新增企业只需往 JSON 里加一行，不用改代码。
 */
const ATS_COLLECTORS = { moka: collectMoka, beisen: collectZhiye, byd: collectByd, pdd: collectPdd };
const ATS_DEFAULTS = { degree: ['本科', '硕士'], gradYears: [2027], batches: ['秋招'], pages: 3 };
try {
  const cfg = JSON.parse(await readFile(path.join(DATA_DIR, 'ats-companies.json'), 'utf8'));
  for (const c of Array.isArray(cfg) ? cfg : []) {
    if (!c.key || !c.company || !c.url || !ATS_COLLECTORS[c.ats]) continue;
    SOURCES.push({
      key: c.key,
      mode: c.ats === 'moka' ? 'browser' : 'http',
      usesBrowser: c.ats === 'moka',
      company: c.company,
      ownership: c.ownership || '其他',
      industries: c.industries || ['其他'],
      degree: c.degree || ATS_DEFAULTS.degree,
      gradYears: c.gradYears || ATS_DEFAULTS.gradYears,
      batches: c.batches || ATS_DEFAULTS.batches,
      url: c.url,
      applyUrl: c.url,
      host: c.host,
      portalId: c.portalId,
      pages: c.pages || ATS_DEFAULTS.pages,
      details: c.details === true,
      collect: ATS_COLLECTORS[c.ats],
      optional: c.optional === true,
    });
  }
} catch (e) {
  if (e.code !== 'ENOENT') console.warn(`ATS 在册表读取失败：${e.message}`);
}

/* ---------- 主流程 ---------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJSONSafe(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function fetchSourceOnce(src) {
  if (src.collect) return src.collect(src);
  if (src.mode === 'browser') return runBrowserSource(src);
  return src.parse(await fetchText(src.url), src);
}

async function fetchSource(src) {
  const started = Date.now();
  let error = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const rows = await fetchSourceOnce(src);
      return { rows, durationMs: Date.now() - started, attempts: attempt, error: null };
    } catch (e) {
      error = e;
      if (attempt < 3) await sleep(1000 * 2 ** (attempt - 1)); // 1s、2s 后重试
    }
  }
  return { rows: [], durationMs: Date.now() - started, attempts: 3, error };
}

async function run() {
  const startedAt = Date.now();
  // 增量抓取：node scripts/fetch-official.mjs --only=moka-xxx,beisen-yyy
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const onlyKeys = onlyArg ? new Set(onlyArg.slice(7).split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const activeSources = onlyKeys ? SOURCES.filter((s) => onlyKeys.has(s.key)) : SOURCES;
  if (onlyKeys && !activeSources.length) {
    console.error('✗ --only 未匹配到任何来源，请检查 key');
    process.exitCode = 1;
    return;
  }
  const prevRows = await readJSONSafe(path.join(DATA_DIR, 'supplement.json'), []);
  const prevHealth = await readJSONSafe(path.join(DATA_DIR, 'fetch-health.json'), { sources: [] });
  const prevByCompany = new Map();
  for (const row of Array.isArray(prevRows) ? prevRows : []) {
    if (!prevByCompany.has(row.company)) prevByCompany.set(row.company, []);
    prevByCompany.get(row.company).push(row);
  }
  const fetchOne = async (src) => {
    process.stdout.write(`抓取 ${src.company} (${src.key}) ... `);
    const r = await fetchSource(src);
    const prev = prevByCompany.get(src.company) || [];
    let status;
    let rows;
    if (r.rows.length) {
      status = 'ok';
      rows = r.rows;
      console.log(`${rows.length} 条`);
    } else {
      status = r.error ? 'error' : 'empty';
      rows = prev;
      const detail = r.error ? `失败：${r.error.message}` : '0 条';
      console.log(prev.length ? `${detail}，沿用上次 ${prev.length} 条` : detail);
      if (prev.length && !r.error) status = 'stale';
    }
    return {
      src,
      rows,
      status,
      freshCount: r.rows.length,
      attempts: r.attempts,
      durationMs: r.durationMs,
      error: r.error ? r.error.message : '',
    };
  };

  // collect/http 源并发 3；浏览器源单独并发 2，避免同时开太多页面
  const isBrowserSource = (s) => s.mode === 'browser' || s.usesBrowser === true;
  const fast = activeSources.filter((s) => !isBrowserSource(s));
  const browser = activeSources.filter(isBrowserSource);
  let results;
  try {
    const [fastResults, browserResults] = await Promise.all([
      mapLimit(fast, 3, fetchOne),
      mapLimit(browser, 2, fetchOne),
    ]);
    results = new Map([...fastResults, ...browserResults].map((r) => [r.src.key, r]));
  } finally {
    await closeBrowser();
  }

  const all = activeSources.flatMap((src) => results.get(src.key).rows);
  // 增量模式：保留未参与本次抓取的企业数据
  const pickedCompanies = new Set(activeSources.map((s) => s.company));
  const baseRows = onlyKeys ? prevRows.filter((r) => !pickedCompanies.has(r.company)) : [];
  const seen = new Set();
  const uniq = [];
  for (const r of [...baseRows, ...all]) {
    if (!seen.has(r.id)) { seen.add(r.id); uniq.push(r); }
  }

  const now = new Date().toISOString();
  const prevSources = new Map((prevHealth.sources || []).map((s) => [s.key, s]));
  const updatedByKey = new Map(activeSources.map((src) => {
    const h = results.get(src.key);
    const prev = prevSources.get(src.key);
    const failed = h.status !== 'ok';
    return [src.key, {
      key: src.key,
      company: src.company,
      mode: src.usesBrowser ? 'browser' : (src.collect ? 'collect' : (src.mode || 'http')),
      optional: src.optional === true,
      status: h.status,
      count: h.rows.length,
      freshCount: h.freshCount,
      attempts: h.attempts,
      durationMs: h.durationMs,
      error: h.error || undefined,
      consecutiveFailures: failed ? (Number(prev?.consecutiveFailures) || 0) + 1 : 0,
      lastSuccessAt: h.status === 'ok' ? now : (prev?.lastSuccessAt || null),
      lastFailureAt: failed ? now : (prev?.lastFailureAt || null),
    }];
  }));
  const sources = onlyKeys
    ? SOURCES.map((src) => updatedByKey.get(src.key) || prevSources.get(src.key)).filter(Boolean)
    : [...updatedByKey.values()];
  const warnings = [...updatedByKey.values()]
    .filter((s) => s.status !== 'ok' && !(s.optional && s.status === 'empty' && s.count === 0))
    .map((s) => `${s.company}: ${s.status}（${s.count} 条${s.error ? `，${s.error}` : ''}）`);
  const history = [
    ...(Array.isArray(prevHealth.history) ? prevHealth.history : []),
    { generatedAt: now, total: uniq.length, warnings: warnings.length, failed: sources.filter((s) => s.status !== 'ok').length },
  ].slice(-14);
  const health = {
    generatedAt: now,
    durationMs: Date.now() - startedAt,
    total: uniq.length,
    warnings,
    history,
    sources,
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(path.join(DATA_DIR, 'fetch-health.json'), JSON.stringify(health, null, 2), 'utf8');

  if (warnings.length) {
    console.log('\n⚠ 需要关注：');
    for (const w of warnings) console.log(`  - ${w}`);
    await sendAlert(warnings, uniq.length);
  }

  if (!uniq.length) {
    console.error('\n✗ 所有来源均为 0 条且无历史数据，已保留现有 supplement.json，不覆盖');
    process.exitCode = 1;
    return;
  }

  await writeFile(path.join(DATA_DIR, 'supplement.json'), JSON.stringify(uniq), 'utf8');
  console.log(`\n完成：共 ${uniq.length} 条补充岗位，已写入 data/supplement.json（耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);
  const byCompany = {};
  for (const r of uniq) byCompany[r.company] = (byCompany[r.company] || 0) + 1;
  console.log('按企业：', JSON.stringify(byCompany));
  console.log('健康报告：data/fetch-health.json');
}

// 可选：配置 FETCH_ALERT_WEBHOOK（飞书/企微机器人地址）后有告警时推送
async function sendAlert(warnings, total) {
  const url = process.env.FETCH_ALERT_WEBHOOK;
  if (!url) return;
  const text = `【校招数据抓取告警】\n${warnings.join('\n')}\n本次补充岗位 ${total} 条`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }),
      signal: AbortSignal.timeout(10000),
    });
    console.log(res.ok ? '已推送 webhook 告警' : `webhook 告警失败：HTTP ${res.status}`);
  } catch (e) {
    console.log(`webhook 告警失败：${e.message}`);
  }
}

run().catch((e) => {
  console.error('抓取失败:', e);
  process.exitCode = 1;
});
