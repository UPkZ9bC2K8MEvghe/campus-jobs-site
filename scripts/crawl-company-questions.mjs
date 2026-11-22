// 从公开面经站的 sitemap 批量抽取「企业 + 面试问题」
// 只存问题句与原文链接，不搬运答案
// 用法：node scripts/crawl-company-questions.mjs [--limit=1000] [--concurrency=4] [--refresh]
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const CACHE = path.join(ROOT, '.cache', 'questions');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_PER_COMPANY = 10;

const SOURCES = [
  { name: '超级简历WonderCV', sitemap: 'https://www.wondercv.com/sitemap-mianjing.xml' },
  { name: 'HI简历', sitemap: 'https://hicv.cn/sitemap-mianjing.xml' },
];

const META_WORDS = /(参考答案|真题解析|面试准备|注意事项|考察重点|追问链|流程有哪些|面试流程|岗位定位|招聘概况|面试总体概述)/;
// 面经站为 SEO 生成的模板问答，不是真实面试题
const SEO_TEMPLATE = /^(如何|怎样)(准备|使用|回答|应对|通过)|(面经|面试)(主要)?(适合谁|有哪些常见问题|常问哪些问题|主要考察|考什么|有哪些经典问题|难吗|好过吗)|面经中的回答思路可以直接背诵吗|这篇.{0,20}面经/;

const args = Object.fromEntries(process.argv.slice(2).map((s) => {
  const m = s.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [s, true];
}));
const LIMIT = Number(args.limit || 1000);
const CONCURRENCY = Math.max(1, Number(args.concurrency || 4));
const REFRESH = Boolean(args.refresh);

const readJson = async (p, f) => { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return f; } };
const strip = (s) => String(s).replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const norm = (s) => s.replace(/[\s“”"'‘’？?、，,。.]/g, '').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function cleanQuestion(raw) {
  return strip(raw)
    .replace(/^(?:Q|q)\s*\d+\s*[.、:：)）]?\s*/, '')
    .replace(/^第\s*\d+\s*题\s*[.、:：]?\s*/, '')
    .replace(/^\(?[一二三四五六七八九十]{1,3}[)）、.]\s*/, '')
    .replace(/^\d{1,2}\s*[.、)）]\s*/, '')
    .replace(/_HI简历$/, '')
    .trim();
}

function extractQuestions(html) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const q = cleanQuestion(raw);
    if (q.length < 8 || q.length > 90) return;
    if (!/[？?]$/.test(q)) return;
    if (/^(http|www)/i.test(q)) return;
    if (META_WORDS.test(q)) return;
    if (SEO_TEMPLATE.test(q)) return;
    if ((q.match(/(?:Q|q)\s*\d+/g) || []).length > 1) return;
    const k = norm(q);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(q.replace(/\?$/, '？'));
  };
  for (const m of html.matchAll(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/g)) push(m[1]);
  for (const m of html.matchAll(/(?:^|[>。\s])(\d{1,2}[.、]\s*[^<>]{6,80}[？?])/g)) push(m[1]);
  for (const m of html.matchAll(/<strong[^>]*>([^<>]{6,80}[？?])<\/strong>/g)) push(m[1]);
  return out;
}

function companyFromTitle(title, names) {
  const t = strip(title).replace(/_HI简历$/, '').trim();
  const head = t.split(/(20\d{2}|19\d{2}|校招|秋招|春招|社招|实习|应届|届)/)[0]
    .replace(/[【\[（(].*$/, '')
    .replace(/[:：|｜].*$/, '')
    .trim();
  let best = '';
  for (const n of names) {
    const prefixed = t.startsWith(n);
    const contains = head.length >= 2 && (head.startsWith(n) || n.startsWith(head));
    if (!prefixed && !contains) continue;
    if (n.length > best.length) best = n;
  }
  return best;
}

async function crawlOne(url) {
  const file = path.join(CACHE, `${crypto.createHash('sha1').update(url).digest('hex')}.json`);
  if (!REFRESH) {
    const hit = await readJson(file, null);
    if (hit) return hit;
  }
  const html = await fetchText(url);
  const title = strip((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
  const payload = { url, title, questions: extractQuestions(html) };
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(file, JSON.stringify(payload));
  return payload;
}

async function main() {
  const jobs = await readJson(path.join(DATA, 'jobs.json'), { r: [] });
  const baseNames = new Set();
  for (const row of jobs.r) {
    const base = String(row[1] || '').split(/[-—]/)[0].trim();
    if (base.length >= 2) baseNames.add(base);
  }
  const names = [...baseNames].sort((a, b) => b.length - a.length);

  const store = await readJson(path.join(DATA, 'company-questions.json'), { companies: {} });
  store.companies = store.companies || {};

  const runs = [];
  for (const source of SOURCES) {
    let urls = [];
    try {
      const xml = await fetchText(source.sitemap);
      urls = [...xml.matchAll(/<loc>(https:\/\/[^<]*\/mianjing\/[^<]+)<\/loc>/g)]
        .map((m) => m[1])
        .slice(0, LIMIT);
    } catch (e) {
      console.log(`[${source.name}] sitemap 失败：${e.message}`);
      continue;
    }
    console.log(`[${source.name}] pages=${urls.length} concurrency=${CONCURRENCY}`);

    let cursor = 0;
    let matched = 0;
    let added = 0;
    let merged = 0;
    const worker = async () => {
      while (cursor < urls.length) {
        const url = urls[cursor++];
        try {
          const page = await crawlOne(url);
          const company = companyFromTitle(page.title, names);
          if (!company) continue;
          matched++;
          const items = page.questions.slice(0, MAX_PER_COMPANY).map((q) => ({
            q,
            src: source.name,
            url: page.url,
          }));
          if (!items.length) continue;
          const existing = store.companies[company] || [];
          // 人工精编的公司不覆盖、不追加，保留原有质量
          const manual = existing.some((x) => !/wondercv\.com|hicv\.cn/.test(x.url || ''));
          if (manual) continue;
          const seen = new Set(existing.map((x) => norm(x.q)));
          const fresh = items.filter((x) => {
            const k = norm(x.q);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
          if (!existing.length) {
            store.companies[company] = items.slice(0, MAX_PER_COMPANY);
            added++;
          } else if (fresh.length && existing.length < MAX_PER_COMPANY) {
            store.companies[company] = existing.concat(fresh).slice(0, MAX_PER_COMPANY);
            merged++;
          } else {
            continue;
          }
          console.log(`  ✓ ${company} +${fresh.length || items.length}`);
        } catch (e) {
          console.log(`  ! ${url} ${e.message}`);
        }
        await sleep(250 + Math.random() * 250);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    runs.push({ source: source.name, pages: urls.length, matched, addedCompanies: added, mergedCompanies: merged });
    console.log(`[${source.name}] done: matched=${matched} newCompanies=${added} merged=${merged}`);
  }

  store.lastBulkRun = { at: new Date().toISOString(), sources: runs, totalCompanies: Object.keys(store.companies).length };
  await fs.writeFile(path.join(DATA, 'company-questions.json'), `${JSON.stringify(store, null, 2)}\n`);
  console.log(`[done] companies=${Object.keys(store.companies).length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
