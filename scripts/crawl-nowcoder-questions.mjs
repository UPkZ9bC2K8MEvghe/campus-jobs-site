// 从牛客网企业面经页的公开接口批量抽取「企业 + 面试问题」
// 只存问题句与原文链接，不搬运答案
// 用法：node scripts/crawl-nowcoder-questions.mjs [--top=1000] [--pages=3] [--dry]
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const CACHE = path.join(ROOT, '.cache', 'nowcoder');
const SUGGEST = 'https://gw-c.nowcoder.com/api/sparta/job-experience/company/name/suggest?name=';
const FEED = 'https://gw-c.nowcoder.com/api/sparta/experience/info/company-v2';
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  referer: 'https://www.nowcoder.com/',
  accept: 'application/json',
};
const MAX_PER_COMPANY = 10;
const CUE = /(什么|为什么|为何|怎么|如何|哪些|哪个|是否|能不能|会不会|有没有|介绍|说说|讲讲|聊聊|谈谈|区别|了解|原理|设计|实现|优化|比较|评价|看法|认为|吗|呢|多少|多久|几轮)/;
const NOISE = /(offer|oc\b|挂了|凉经|感谢信|薪资|开奖|进度|时间线|timeline|已编辑|牛客|投递|笔试|一面|二面|三面|hr面|面试官|面完|oc了|综测|上岸|攻略|上家|他们怎么|第\s*\d+\s*期)/i;
const CHATTER = /(不过|但是|而且|所以|因为|感觉|我觉得|我的|今天|昨天|最近|流程真|自闭|矫情|同感|牛油|哈哈|😭|😂|反问|介绍了一下|然后问|然后说|问了一下|聊了一下|\.{3,}|…)/;
const CHATTER_HEAD = /^(不过|但是|而且|所以|因为|感觉|今天|昨天|最近|然后|最后|整体|总的来说|其实|我)/;
// 面经站的 SEO 模板问句，不是真实面试题
const SEO_TEMPLATE = /^(如何|怎样)(准备|使用|回答|应对|通过)|(面经|面试)(主要)?(适合谁|有哪些常见问题|常问哪些问题|主要考察|考什么|有哪些经典问题|难吗|好过吗)|面经中的回答思路可以直接背诵吗|这篇.{0,20}面经/;

const args = Object.fromEntries(process.argv.slice(2).map((s) => {
  const m = s.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [s, true];
}));
const TOP = Number(args.top || 1000);
const PAGES = Math.max(1, Number(args.pages || 3));
const DRY = Boolean(args.dry);
const ONLY = args.only ? String(args.only).split(/[,，]/).map((s) => s.trim()).filter(Boolean) : null;
const CONCURRENCY = Math.max(1, Number(args.concurrency || 6));

const readJson = async (p, f) => { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return f; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normName = (s) => String(s).replace(/[\s·・()（）\-—_]/g, '').toLowerCase();
const matchKey = (s) => normName(String(s).replace(/(股份有限公司|有限责任公司|有限公司|集团公司|集团|控股|公司|总公司)$/g, ''));
const normQ = (s) => s.replace(/[\s“”"'‘’？?、，,。.；;：:]/g, '').toLowerCase();
const decode = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ');

function clean(raw) {
  return decode(raw)
    .replace(/\[[^\]]{1,10}\]/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/(?:^|\s)(?:问|Q|q)\s*[：:]\s*/g, ' ')
    .replace(/^\s*\d{1,2}\s*[.、,，)）]\s*/, '')
    .replace(/^\s*\d{1,2}\s+(?=\S)/, '')
    .replace(/^\s*[一二三四五六七八九十]{1,3}\s*[、.)）]\s*/, '')
    .replace(/[，,。；;：:\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function accept(q) {
  if (q.length < 8 || q.length > 80) return false;
  if (/https?:|www\.|\{|\}|<|>|[【】]/.test(q)) return false;
  if (NOISE.test(q) || CHATTER.test(q) || CHATTER_HEAD.test(q) || SEO_TEMPLATE.test(q)) return false;
  if (/[？?]$/.test(q)) return true;
  return CUE.test(q);
}

function extractQuestions(text) {
  const src = decode(String(text || '')).replace(/\[[^\]]{1,10}\]/g, ' ').slice(0, 12000);
  const chunks = src.split(/(?<=[？?])|(?=\d{1,2}\s*[.、])|(?<=[。；;])|\n+/);
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    let q = clean(raw);
    if (!/[？?]$/.test(q)) q = q;
    if (!accept(q)) return;
    q = q.replace(/\?$/, '？');
    const k = normQ(q);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(q);
  };
  for (const chunk of chunks) {
    if (!chunk) continue;
    if (!/[？?]$/.test(chunk.trim()) && chunk.length > 40) {
      for (const part of chunk.split(/(?=(?:请)?(?:简单)?(?:自我)?介绍|说说|讲讲|聊一聊|谈一谈|为什么|为什么|怎么|如何|什么是|有哪些|了解|知道|是否|能不能|会不会|有没有|多少|怎样)/)) push(part);
    } else {
      push(chunk);
    }
  }
  return out;
}

async function cached(key, loader, refresh = false) {
  const file = path.join(CACHE, `${key}.json`);
  if (!refresh) {
    const hit = await readJson(file, null);
    if (hit) return hit;
  }
  const data = await loader();
  // 接口报错时 data 缺少 records 字段，不要写缓存，避免下次误判为「无面经」
  if (key.startsWith('feed-') && (!data || typeof data !== 'object' || !('records' in data))) return data;
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(file, JSON.stringify(data));
  return data;
}

async function getJson(url, attempt = 0) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } catch (e) {
    if (attempt < 2) {
      await sleep(600 + attempt * 900);
      return getJson(url, attempt + 1);
    }
    throw e;
  }
}

async function mapLimit(items, limit, fn) {
  let cursor = 0;
  const results = new Array(items.length);
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
      await sleep(150 + Math.random() * 200);
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

function pickCompany(target, results) {
  const t = matchKey(target);
  const exact = results.find((r) => matchKey(r.companyName) === t);
  if (exact) return exact;
  const scored = results
    .map((r) => {
      const key = matchKey(r.companyName);
      const extra = key.slice(t.length);
      let score = 3;
      if (/^[a-z]+$/i.test(extra)) score = 1;
      else if (/(集团|公司|科技|股份|银行|保险|通信|电子|控股)/.test(extra)) score = 2;
      return { r, score, len: extra.length };
    })
    .filter((x) => matchKey(x.r.companyName).startsWith(t) && x.len <= 8)
    .sort((a, b) => a.score - b.score || a.len - b.len);
  return scored[0]?.r || null;
}

async function main() {
  const jobs = await readJson(path.join(DATA, 'jobs.json'), { r: [] });
  const counts = new Map();
  for (const row of jobs.r) {
    const c = String(row[1] || '').split(/[-—]/)[0].trim();
    if (c.length >= 2) counts.set(c, (counts.get(c) || 0) + 1);
  }
  const store = await readJson(path.join(DATA, 'company-questions.json'), { companies: {} });
  store.companies = store.companies || {};

  // 同名主体（含「股份有限公司/集团/分行」等后缀）合并为一个候选，取最短名称
  const canonical = new Map();
  for (const [name, n] of counts) {
    const k = matchKey(name);
    const prev = canonical.get(k);
    if (!prev) canonical.set(k, { name, count: n });
    else {
      prev.count += n;
      if (name.length < prev.name.length) prev.name = name;
    }
  }
  const storeKeyByMatch = new Map(Object.keys(store.companies).map((n) => [matchKey(n), n]));
  const candidates = [...canonical.values()]
    .sort((a, b) => b.count - a.count)
    .map((x) => x.name)
    .slice(0, TOP)
    .filter((c) => !ONLY || ONLY.includes(c))
    .filter((c) => {
      const hit = store.companies[storeKeyByMatch.get(matchKey(c)) || c];
      return !hit?.length || hit.length < MAX_PER_COMPANY;
    });

  console.log(`[nowcoder] candidates=${candidates.length} pages=${PAGES}${DRY ? ' (dry)' : ''}`);

  // 1) 企业名 -> 企业 ID（原名单未命中时，尝试去掉「中国」前缀/省市后缀再查）
  const variantsOf = (name) => {
    const out = [name];
    const noPrefix = name.replace(/^中国/, '');
    const noSuffix = name.replace(/(市|省|自治区|特别行政区)$/, '');
    out.push(noPrefix, noSuffix, noPrefix.replace(/(市|省|自治区|特别行政区)$/, ''));
    return [...new Set(out.filter((v) => v.length >= 2))];
  };
  const suggested = await mapLimit(candidates, CONCURRENCY, async (name) => {
    for (const v of variantsOf(name)) {
      try {
        const data = await cached(`suggest-${normName(v)}`, async () => {
          const r = await getJson(`${SUGGEST}${encodeURIComponent(v)}`);
          return r.data?.result || [];
        });
        const pick = pickCompany(name, data);
        if (pick) return { name, id: pick.companyId, via: v };
      } catch {
        /* 换下一个变体 */
      }
    }
    return { name, id: null };
  });
  const matched = suggested.filter((x) => x.id);
  console.log(`[nowcoder] idMatched=${matched.length}`);

  // 2) 拉企业面经列表（20 条/页），抽问题
  let companiesAdded = 0;
  let companiesMerged = 0;
  let pagesFetched = 0;
  let totalPosts = 0;
  await mapLimit(matched, CONCURRENCY, async ({ name, id }) => {
    const items = [];
    for (let p = 1; p <= PAGES; p++) {
      try {
        if (DRY) console.log(`  fetch ${name} id=${id} page=${p}`);
        const data = await cached(`feed-${id}-${p}`, async () => {
          const r = await getJson(`${FEED}/${id}?order=3&pageNo=${p}&pageSize=20&careerJobId=0`);
          if (DRY) console.log('  api keys', Object.keys(r || {}), 'dataKeys', Object.keys(r?.data || {}));
          return r.data || {};
        });
        if (!data.records?.length) break;
        pagesFetched++;
        totalPosts += data.records.length;
        if (DRY) {
          const valid = data.records.filter((x) => String(x.contentData?.content || x.momentData?.content || '').length >= 40);
          console.log(`  ${name} id=${id} page=${p} recs=${data.records.length} valid=${valid.length}`);
        }
        for (const it of data.records) {
          // contentType=74 的正文在 momentData.content（完整），250 在 contentData.content（约 300 字截断）
          const body = String(it?.contentData?.content || it?.momentData?.content || '');
          if (body.length >= 40) items.push({ id: it.contentId, content: body });
        }
        if (items.length >= 30) break;
      } catch {
        break;
      }
    }
    if (!items.length) return;
    const questions = [];
    const seen = new Set();
    for (const item of items) {
      for (const q of extractQuestions(item.content)) {
        const k = normQ(q);
        if (seen.has(k)) continue;
        seen.add(k);
        questions.push({ q, src: '牛客网', url: `https://www.nowcoder.com/discuss/${item.id}` });
        if (questions.length >= MAX_PER_COMPANY) break;
      }
      if (questions.length >= MAX_PER_COMPANY) break;
    }
    if (!questions.length) return;

    if (DRY) {
      console.log(`\n== ${name} (id=${id}) ==`);
      questions.forEach((x, i) => console.log(`${i + 1}. ${x.q}`));
      return;
    }

    const existingName = storeKeyByMatch.get(matchKey(name)) || name;
    const existing = store.companies[existingName] || [];
    const existingKeys = new Set(existing.map((x) => normQ(x.q)));
    const fresh = questions.filter((x) => !existingKeys.has(normQ(x.q)));
    if (!fresh.length) return;
    store.companies[existingName] = existing.concat(fresh).slice(0, MAX_PER_COMPANY);
    storeKeyByMatch.set(matchKey(existingName), existingName);
    if (existing.length) companiesMerged++;
    else companiesAdded++;
  });

  if (DRY) return;
  store.lastNowcoderRun = {
    at: new Date().toISOString(),
    source: 'nowcoder',
    candidates: candidates.length,
    idMatched: matched.length,
    companiesAdded,
    companiesMerged,
    pagesFetched,
    postsScanned: totalPosts,
    totalCompanies: Object.keys(store.companies).length,
  };
  await fs.writeFile(path.join(DATA, 'company-questions.json'), `${JSON.stringify(store, null, 2)}\n`);
  console.log(`[nowcoder] done: added=${companiesAdded} merged=${companiesMerged} total=${Object.keys(store.companies).length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
