// 为每家企业生成静态落地页 + 全站 sitemap，便于搜索引擎收录长尾关键词
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'companies');
const SITE = 'https://campus-jobs.pages.dev';
const TODAY = new Date();
const pad = (n) => String(n).padStart(2, '0');
const todayStr = `${TODAY.getFullYear()}-${pad(TODAY.getMonth() + 1)}-${pad(TODAY.getDate())}`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function decode(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || payload.v !== 2 || !Array.isArray(payload.r)) return [];
  const { d, r } = payload;
  const pick = (k, i) => (i >= 0 && d[k][i] !== undefined ? d[k][i] : '');
  const list = (k, arr) => (arr || []).map((i) => pick(k, i)).filter((v) => v !== '');
  return r.map((a) => ({
    id: a[0],
    company: a[1],
    ownership: pick('o', a[2]),
    industries: list('i', a[3]),
    positions: (a[4] || []).filter(Boolean),
    cities: list('c', a[5]),
    nationwide: !!a[6],
    gradYears: a[7] || [],
    gradUnlimited: !!a[8],
    batches: list('b', a[9]),
    degrees: list('g', a[10]),
    deadline: a[12] === undefined ? null : a[12],
    deadlineText: a[13] || '',
    updatedAt: a[14] || '',
    summary: a[15] || '',
    sourceName: a[17] || '',
    sourceUrl: a[18] || '',
    applyUrl: a[19] || '',
    majors: a[21] || '',
  }));
}

const expired = (row) => !!row.deadline && row.deadline < todayStr;
const fileName = (name) => String(name).replace(/[\\/:*?"<>|#%]/g, '-').replace(/\s+/g, ' ').trim();

const jobs = decode(JSON.parse(await readFile(path.join(ROOT, 'data/jobs.json'), 'utf8')));
const internships = decode(JSON.parse(await readFile(path.join(ROOT, 'data/internships.json'), 'utf8')));

const groups = new Map();
for (const [type, rows] of [['校招', jobs], ['实习', internships]]) {
  for (const row of rows) {
    if (expired(row)) continue; // 只给仍有在招岗位的企业建页
    const key = row.company.trim();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { company: key, jobs: [], internships: [] });
    groups.get(key)[type === '校招' ? 'jobs' : 'internships'].push(row);
  }
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const pageShell = (title, desc, body, ld, canonical) => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<style>
:root{color-scheme:light}
body{margin:0;background:#f6f7f9;color:#1f2733;font:15px/1.75 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:24px 18px 64px}
a{color:#3b5bdb}
.crumb{font-size:13px;color:#6b7280;margin-bottom:14px}
h1{font-size:24px;margin:0 0 6px}
.meta{color:#6b7280;font-size:13px;margin-bottom:18px}
.card{background:#fff;border:1px solid #e5e8ef;border-radius:12px;padding:18px 20px;margin-bottom:16px}
.card h2{font-size:16px;margin:0 0 10px}
dl{display:grid;grid-template-columns:84px 1fr;gap:6px 12px;margin:0;font-size:14px}
dt{color:#6b7280}
dd{margin:0}
ul{margin:0;padding-left:20px}
li{margin:2px 0}
.note{font-size:12px;color:#8b93a1;margin-top:20px}
.btn{display:inline-block;margin-top:12px;padding:8px 14px;border-radius:8px;background:#3b5bdb;color:#fff;text-decoration:none;font-size:14px}
</style>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
</head>
<body><div class="wrap">${body}
<p class="note">信息整理自企业官方招聘公告，投递前请以企业官方最新公告为准。数据更新于 ${todayStr}。</p>
</div></body></html>`;

const links = [];
for (const g of [...groups.values()].sort((a, b) => a.company.localeCompare(b.company, 'zh-CN'))) {
  const all = [...g.jobs, ...g.internships];
  const main = all[0];
  const openJobs = g.jobs.reduce((n, r) => n + r.positions.length, 0);
  const openInterns = g.internships.reduce((n, r) => n + r.positions.length, 0);
  const cities = [...new Set(all.flatMap((r) => r.cities))].slice(0, 12);
  const batches = [...new Set(all.flatMap((r) => r.batches))];
  const years = [...new Set(all.flatMap((r) => (r.gradUnlimited ? [...r.gradYears, '不限届别'] : r.gradYears.map(String))))];
  const degrees = [...new Set(all.flatMap((r) => r.degrees))];
  const majors = [...new Set(all.map((r) => r.majors).filter(Boolean))];
  const deadlines = all.map((r) => r.deadlineText || r.deadline).filter(Boolean).sort();
  const deadline = deadlines[deadlines.length - 1] || '长期有效';
  const slug = fileName(g.company);
  const url = `${SITE}/companies/${encodeURIComponent(slug)}.html`;

  const positionList = (rows) => rows.flatMap((r) => r.positions.map((p) => `<li>${esc(p)}${r.cities.length ? ` <span style="color:#8b93a1">· ${esc(r.cities.slice(0, 6).join('、'))}</span>` : ''}</li>`)).join('');

  const body = `
<nav class="crumb"><a href="${SITE}/">校招信息查询</a> › <a href="${SITE}/companies/">全部企业</a> › ${esc(g.company)}</nav>
<h1>${esc(g.company)} 校园招聘岗位汇总</h1>
<p class="meta">${openJobs ? `校招 ${openJobs} 个岗位` : ''}${openJobs && openInterns ? ' · ' : ''}${openInterns ? `实习 ${openInterns} 个岗位` : ''} · 更新于 ${esc(main.updatedAt || todayStr)}</p>
<section class="card"><h2>基本信息</h2><dl>
<dt>企业性质</dt><dd>${esc(main.ownership || '—')}</dd>
<dt>行业</dt><dd>${esc(main.industries.join('、') || '—')}</dd>
<dt>工作地点</dt><dd>${esc(cities.join('、') || '—')}</dd>
<dt>招聘批次</dt><dd>${esc(batches.join('、') || '—')}</dd>
<dt>面向届别</dt><dd>${esc(years.join('、') || '—')}</dd>
<dt>学历要求</dt><dd>${esc(degrees.join('、') || '—')}</dd>
<dt>投递截止</dt><dd>${esc(deadline)}</dd>
</dl></section>
${openJobs ? `<section class="card"><h2>校招岗位（${openJobs}）</h2><ul>${positionList(g.jobs)}</ul></section>` : ''}
${openInterns ? `<section class="card"><h2>实习岗位（${openInterns}）</h2><ul>${positionList(g.internships)}</ul></section>` : ''}
${majors.length ? `<section class="card"><h2>专业要求</h2><p>${majors.map((m) => esc(m)).join('<br>')}</p></section>` : ''}
${main.sourceUrl ? `<a class="btn" href="${esc(main.sourceUrl)}" rel="nofollow noopener" target="_blank">查看官方招聘公告</a>` : ''}`;

  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: '校招信息查询', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: '全部企业', item: `${SITE}/companies/` },
          { '@type': 'ListItem', position: 3, name: g.company, item: url },
        ],
      },
      {
        '@type': 'Organization',
        name: g.company,
        ...(main.sourceUrl ? { sameAs: [main.sourceUrl] } : {}),
        description: `${g.company} ${years.join('、')} 校园招聘与实习岗位汇总，共 ${openJobs + openInterns} 个在招岗位，工作地点：${cities.join('、')}。`,
      },
    ],
  };

  const desc = `${g.company} ${years.join('、')} 校园招聘与实习岗位汇总，共 ${openJobs + openInterns} 个在招岗位，工作地点覆盖${cities.slice(0, 5).join('、') || '全国'}，投递截止 ${deadline}。`;
  await writeFile(path.join(OUT, `${slug}.html`), pageShell(`${g.company} 校招岗位与实习岗位汇总`, desc, body, ld, url), 'utf8');
  links.push({ url, name: g.company, count: openJobs + openInterns });
}

// 企业索引页
const indexBody = `
<nav class="crumb"><a href="${SITE}/">校招信息查询</a> › 全部企业</nav>
<h1>全部企业（${links.length}）</h1>
<p class="meta">按企业名称浏览校招与实习岗位，仅收录仍有未截止岗位的企业。</p>
<section class="card"><ul style="columns:2;column-gap:28px">${links.map((l) => `<li><a href="${l.url}">${esc(l.name)}</a> ${l.count}</li>`).join('')}</ul></section>`;
await writeFile(path.join(OUT, 'index.html'), pageShell('全部企业校招岗位索引', `共 ${links.length} 家企业的校招与实习岗位汇总，按企业名称浏览。`, indexBody, {
  '@context': 'https://schema.org',
  '@type': 'CollectionPage',
  name: '全部企业校招岗位索引',
  url: `${SITE}/companies/`,
}, `${SITE}/companies/`), 'utf8');

// 覆盖 dist/sitemap.xml，把企业页一并收录
const urls = [
  `${SITE}/`,
  `${SITE}/companies/`,
  `${SITE}/?view=internships`,
  `${SITE}/?view=soe`,
  `${SITE}/?view=dashboard`,
  ...links.map((l) => l.url),
];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u.replace(/&/g, '&amp;')}</loc><lastmod>${todayStr}</lastmod></url>`).join('\n')}
</urlset>`;
await writeFile(path.join(DIST, 'sitemap.xml'), sitemap, 'utf8');

console.log(`企业页生成完成：${links.length} 家 → dist/companies/`);
console.log(`sitemap 收录 ${urls.length} 个地址`);
