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
const SHARDS = 16;

async function loadDetails(tab) {
  const all = {};
  for (let i = 0; i < SHARDS; i += 1) {
    try { Object.assign(all, JSON.parse(await readFile(path.join(ROOT, 'data', `${tab}-detail-${i}.json`), 'utf8'))); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return all;
}

function decode(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || ![2, 3].includes(payload.v) || !Array.isArray(payload.r)) return [];
  const { d, r } = payload;
  const pick = (k, i) => (i >= 0 && d[k][i] !== undefined ? d[k][i] : '');
  const list = (k, arr) => (arr || []).map((i) => pick(k, i)).filter((v) => v !== '');
  return r.map((a) => ({
    id: a[0],
    company: a[1],
    ownership: pick('o', a[2]),
    industries: list('i', a[3]),
    positions: (a[4] || []).filter(Boolean),
    positionCount: payload.v === 3 ? (a[22] ?? (a[4] || []).length) : (a[4] || []).length,
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
const normDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
};

// 脏数据防护：把误当成企业名的表头/文档标题/Markdown 链接剔掉，避免生成垃圾页被收录
const isJunkName = (name) => /\]\s*\(|https?:|www\.|必看|使用说明|表格说明/i.test(name);

const [jobsPayload, internshipsPayload, jobsDetails, internshipsDetails] = await Promise.all([
  readFile(path.join(ROOT, 'data/jobs.json'), 'utf8').then(JSON.parse),
  readFile(path.join(ROOT, 'data/internships.json'), 'utf8').then(JSON.parse),
  loadDetails('jobs'),
  loadDetails('internships'),
]);
const hydrate = (rows, details) => rows.map((row) => {
  const positions = details[row.id]?.positions;
  return positions?.length >= row.positionCount ? { ...row, positions } : row;
});
const jobs = hydrate(decode(jobsPayload), jobsDetails);
const internships = hydrate(decode(internshipsPayload), internshipsDetails);

const groups = new Map();
for (const [type, rows] of [['校招', jobs], ['实习', internships]]) {
  for (const row of rows) {
    if (expired(row)) continue; // 只给仍有在招岗位的企业建页
    const key = row.company.trim();
    if (!key || isJunkName(key)) continue;
    if (!groups.has(key)) groups.set(key, { company: key, jobs: [], internships: [] });
    groups.get(key)[type === '校招' ? 'jobs' : 'internships'].push(row);
  }
}

// 第一遍：算出每家企业页需要的全部数据（含准确 lastmod），供页面与 sitemap 复用
const records = [];
for (const g of groups.values()) {
  const all = [...g.jobs, ...g.internships];
  const main = all[0];
  const openJobs = g.jobs.reduce((n, r) => n + r.positions.length, 0);
  const openInterns = g.internships.reduce((n, r) => n + r.positions.length, 0);
  const cities = [...new Set(all.flatMap((r) => r.cities))].slice(0, 12);
  const batches = [...new Set(all.flatMap((r) => r.batches))];
  const years = [...new Set(all.flatMap((r) => (r.gradUnlimited ? [...r.gradYears, '不限届别'] : r.gradYears.map(String))))];
  const degrees = [...new Set(all.flatMap((r) => r.degrees))];
  const industries = [...new Set(all.flatMap((r) => r.industries))];
  const majors = [...new Set(all.map((r) => r.majors).filter(Boolean))];
  const deadlines = all.map((r) => r.deadlineText || r.deadline).filter(Boolean).sort();
  const deadline = deadlines[deadlines.length - 1] || '长期有效';
  const lastmod = all.map((r) => normDate(r.updatedAt)).filter(Boolean).sort().pop() || todayStr;
  const slug = fileName(g.company);
  records.push({
    company: g.company, slug, jobs: g.jobs, internships: g.internships, main,
    openJobs, openInterns, total: openJobs + openInterns,
    cities, batches, years, degrees, industries, majors, deadline, lastmod,
    // Cloudflare Pages 会把 /companies/xxx.html 308 到 /companies/xxx（无后缀），
    // 因此 canonical/sitemap/内链统一用无后缀形式，避免每页多一次重定向、信号不一致
    url: `${SITE}/companies/${encodeURIComponent(slug)}`,
  });
}
records.sort((a, b) => a.company.localeCompare(b.company, 'zh-CN'));

// 反向索引：用来在每页底部挂「同行业 / 同城市」内链，降低 7000+ 页面的爬取深度
const byIndustry = new Map();
const byCity = new Map();
const pushTo = (map, key, rec) => {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(rec);
};
for (const rec of records) {
  rec.industries.slice(0, 2).forEach((k) => pushTo(byIndustry, k, rec));
  rec.cities.slice(0, 3).forEach((k) => pushTo(byCity, k, rec));
}
for (const map of [byIndustry, byCity]) {
  for (const list of map.values()) list.sort((a, b) => b.total - a.total || a.company.localeCompare(b.company, 'zh-CN'));
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
<meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large">
<meta name="theme-color" content="#2b59ff">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="alternate" type="application/rss+xml" title="校招信息查询 · 每日新增岗位" href="/feeds.xml">
<meta property="og:type" content="website">
<meta property="og:site_name" content="校招信息查询">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:locale" content="zh_CN">
<meta property="og:image" content="${SITE}/icon-512.png">
<meta property="og:image:width" content="512">
<meta property="og:image:height" content="512">
<meta property="og:image:alt" content="校招信息查询">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${SITE}/icon-512.png">
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
.rel{font-size:14px}
.rel a{margin-right:12px;white-space:nowrap}
.company-search{box-sizing:border-box;width:100%;max-width:520px;height:40px;padding:0 14px;border:1px solid #d8e0f5;border-radius:10px;font-size:14px;margin:0 0 14px;outline:none}
.company-search:focus{border-color:#3b5bdb;box-shadow:0 0 0 3px rgba(59,91,219,.1)}
.company-empty{display:none;color:#6b7280;padding:18px 0}
.note{font-size:12px;color:#8b93a1;margin-top:20px}
.btn{display:inline-block;margin:12px 10px 0 0;padding:8px 14px;border-radius:8px;background:#3b5bdb;color:#fff;text-decoration:none;font-size:14px}
.btn.ghost{background:#fff;color:#3b5bdb;border:1px solid #c7d2f5}
.jump{position:fixed;right:18px;bottom:20px;z-index:5;width:42px;height:42px;border-radius:50%;border:1px solid #d8e0f5;background:#fff;color:#3b5bdb;display:none;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 8px 20px rgba(20,40,110,.16);padding:0}
.jump.show{display:flex}
.jump.up{bottom:70px}
.jump:hover{background:#3b5bdb;color:#fff}
@media (max-width:640px){.jump{right:12px;bottom:14px;width:38px;height:38px}.jump.up{bottom:60px}}
</style>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
</head>
<body><div class="wrap">${body}
<p class="note">信息整理自企业官方招聘公告，投递前请以企业官方最新公告为准。数据更新于 ${todayStr}。</p>
</div>
<button class="jump up" id="jumpTop" type="button" title="回到顶部（Alt + ↑）" aria-label="滚动到页面顶部"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 19V6m0 0l-5.5 5.5M12 6l5.5 5.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
<button class="jump" id="jump" type="button" title="一键到底（Alt + ↓）" aria-label="滚动到页面底部"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v13m0 0l-5.5-5.5M12 18l5.5-5.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
<script>
(function(){
  var b=document.getElementById('jump'),t=document.getElementById('jumpTop');
  function upd(){
    var r=document.documentElement.scrollHeight-window.innerHeight-window.scrollY;
    b.classList.toggle('show',r>160);
    t.classList.toggle('show',window.scrollY>160);
  }
  function go(top){window.scrollTo({top:top?0:document.documentElement.scrollHeight,behavior:'smooth'})}
  b.addEventListener('click',function(){go(false)});
  t.addEventListener('click',function(){go(true)});
  window.addEventListener('scroll',upd,{passive:true});
  window.addEventListener('resize',upd);
  document.addEventListener('keydown',function(e){
    if(!e.altKey)return;
    if(e.key==='ArrowDown'){e.preventDefault();go(false)}
    if(e.key==='ArrowUp'){e.preventDefault();go(true)}
  });
  upd();
})();
</script>
</body></html>`;

const relatedLinks = (list, self) => list
  .filter((r) => r.company !== self)
  .slice(0, 8)
  .map((r) => `<a href="${encodeURIComponent(r.slug)}">${esc(r.company)}</a>`)
  .join('');

for (const rec of records) {
  const { company, main, openJobs, openInterns, cities, batches, years, degrees, industries, majors, deadline } = rec;

  const positionList = (rows) => rows.flatMap((r) => r.positions.map((p) => `<li>${esc(p)}${r.cities.length ? ` <span style="color:#8b93a1">· ${esc(r.cities.slice(0, 6).join('、'))}</span>` : ''}</li>`)).join('');

  const inSiteUrl = `${SITE}/?q=${encodeURIComponent(company)}`;
  const indLinks = relatedLinks(byIndustry.get(industries[0]) || [], company);
  const cityLinks = relatedLinks(byCity.get(cities[0]) || [], company);

  const body = `
<nav class="crumb"><a href="${SITE}/">校招信息查询</a> › <a href="${SITE}/companies/">全部企业</a> › ${esc(company)}</nav>
<h1>${esc(company)} 校园招聘岗位汇总</h1>
<p class="meta">${openJobs ? `校招 ${openJobs} 个岗位` : ''}${openJobs && openInterns ? ' · ' : ''}${openInterns ? `实习 ${openInterns} 个岗位` : ''} · 更新于 ${esc(rec.lastmod)}</p>
<section class="card"><h2>基本信息</h2><dl>
<dt>企业性质</dt><dd>${esc(main.ownership || '—')}</dd>
<dt>行业</dt><dd>${esc(industries.join('、') || '—')}</dd>
<dt>工作地点</dt><dd>${esc(cities.join('、') || '—')}</dd>
<dt>招聘批次</dt><dd>${esc(batches.join('、') || '—')}</dd>
<dt>面向届别</dt><dd>${esc(years.join('、') || '—')}</dd>
<dt>学历要求</dt><dd>${esc(degrees.join('、') || '—')}</dd>
<dt>投递截止</dt><dd>${esc(deadline)}</dd>
</dl></section>
<p><a class="btn" href="${inSiteUrl}">在站内查看 ${esc(company)} 全部岗位</a>${cities[0] ? `<a class="btn ghost" href="${SITE}/?c=${encodeURIComponent(cities[0])}">${esc(cities[0])} 校招岗位</a>` : ''}${main.sourceUrl ? `<a class="btn ghost" href="${esc(main.sourceUrl)}" rel="nofollow noopener" target="_blank">官方招聘公告</a>` : ''}</p>
${openJobs ? `<section class="card"><h2>校招岗位（${openJobs}）</h2><ul>${positionList(rec.jobs)}</ul></section>` : ''}
${openInterns ? `<section class="card"><h2>实习岗位（${openInterns}）</h2><ul>${positionList(rec.internships)}</ul></section>` : ''}
${majors.length ? `<section class="card"><h2>专业要求</h2><p>${majors.map((m) => esc(m)).join('<br>')}</p></section>` : ''}
${indLinks ? `<section class="card"><h2>同行业企业（${esc(industries[0])}）</h2><p class="rel">${indLinks}</p></section>` : ''}
${cityLinks ? `<section class="card"><h2>${esc(cities[0])} 同城招聘企业</h2><p class="rel">${cityLinks}</p></section>` : ''}`;

  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: '校招信息查询', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: '全部企业', item: `${SITE}/companies/` },
          { '@type': 'ListItem', position: 3, name: company, item: rec.url },
        ],
      },
      {
        '@type': 'Organization',
        name: company,
        ...(main.sourceUrl ? { sameAs: [main.sourceUrl] } : {}),
        description: `${company} ${years.join('、')} 校园招聘与实习岗位汇总，共 ${rec.total} 个在招岗位，工作地点：${cities.join('、')}。`,
      },
      {
        '@type': 'WebPage',
        '@id': rec.url,
        url: rec.url,
        name: `${company} 校招岗位与实习岗位汇总`,
        inLanguage: 'zh-CN',
        dateModified: `${rec.lastmod}T00:00:00+08:00`,
        isPartOf: { '@type': 'WebSite', '@id': `${SITE}/#website`, name: '校招信息查询', url: `${SITE}/` },
      },
      {
        '@type': 'ItemList',
        name: `${company} 在招岗位`,
        numberOfItems: rec.total,
        itemListElement: [...rec.jobs, ...rec.internships]
          .flatMap((r) => r.positions)
          .slice(0, 100)
          .map((p, i) => ({ '@type': 'ListItem', position: i + 1, name: p })),
      },
    ],
  };

  const desc = `${company} ${years.join('、')} 校园招聘与实习岗位汇总，共 ${rec.total} 个在招岗位，工作地点覆盖${cities.slice(0, 5).join('、') || '全国'}，投递截止 ${deadline}。`;
  await writeFile(path.join(OUT, `${rec.slug}.html`), pageShell(`${company} 校招岗位与实习岗位汇总`, desc, body, ld, rec.url), 'utf8');
}

// 企业索引页：按行业给出入口，顺带覆盖「XX行业 校招」这类长尾词
const industryFacets = [...byIndustry.entries()]
  .map(([name, list]) => ({ name, count: list.length }))
  .filter((f) => f.count >= 3)
  .sort((a, b) => b.count - a.count)
  .slice(0, 24);

const indexBody = `
<nav class="crumb"><a href="${SITE}/">校招信息查询</a> › 全部企业</nav>
<h1>全部企业（${records.length}）</h1>
<p class="meta">按企业名称浏览校招与实习岗位，仅收录仍有未截止岗位的企业。</p>
<input class="company-search" id="companySearch" type="search" placeholder="搜索企业名称…" autocomplete="off" aria-label="按企业名称搜索">
<p class="rel">按行业浏览：${industryFacets.map((f) => `<a href="${SITE}/?i=${encodeURIComponent(f.name)}">${esc(f.name)}（${f.count}）</a>`).join('')}</p>
<section class="card"><ul id="companyList" style="columns:2;column-gap:28px">${records.map((r) => `<li data-name="${esc(r.company.toLowerCase())}"><a href="${encodeURIComponent(r.slug)}">${esc(r.company)}</a> ${r.total}</li>`).join('')}</ul><p class="company-empty" id="companyEmpty">没有匹配的企业，请换个关键词。</p></section>
<script>
(function(){
  var input=document.getElementById('companySearch'),list=document.getElementById('companyList');
  var empty=document.getElementById('companyEmpty');
  var items=Array.prototype.slice.call(list.children);
  input.addEventListener('input',function(){
    var q=input.value.trim().toLowerCase(),shown=0;
    items.forEach(function(li){
      var hit=!q||li.getAttribute('data-name').indexOf(q)!==-1;
      li.style.display=hit?'':'none';
      if(hit)shown++;
    });
    empty.style.display=shown?'none':'block';
  });
})();
</script>`;
await writeFile(path.join(OUT, 'index.html'), pageShell('全部企业校招岗位索引', `共 ${records.length} 家企业的校招与实习岗位汇总，按企业名称与行业浏览。`, indexBody, {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'CollectionPage',
      name: '全部企业校招岗位索引',
      url: `${SITE}/companies/`,
      inLanguage: 'zh-CN',
      isPartOf: { '@type': 'WebSite', '@id': `${SITE}/#website`, name: '校招信息查询', url: `${SITE}/` },
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: '校招信息查询', item: `${SITE}/` },
        { '@type': 'ListItem', position: 2, name: '全部企业', item: `${SITE}/companies/` },
      ],
    },
  ],
}, `${SITE}/companies/`), 'utf8');

// 覆盖 dist/sitemap.xml：lastmod 用每家企业的真实更新时间，避免「全站同一天更新」的失真信号
const urls = [
  { loc: `${SITE}/`, lastmod: todayStr },
  { loc: `${SITE}/companies/`, lastmod: todayStr },
  { loc: `${SITE}/?view=internships`, lastmod: todayStr },
  { loc: `${SITE}/?view=soe`, lastmod: todayStr },
  { loc: `${SITE}/?view=dashboard`, lastmod: todayStr },
  ...records.map((r) => ({ loc: r.url, lastmod: r.lastmod })),
];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u.loc.replace(/&/g, '&amp;')}</loc><lastmod>${u.lastmod}</lastmod></url>`).join('\n')}
</urlset>`;
await writeFile(path.join(DIST, 'sitemap.xml'), sitemap, 'utf8');

// 供大模型整篇读取的精简索引（llms.txt 的「全文版」）：顶部企业与数据结构，控制体积
const topCompanies = [...records].sort((a, b) => b.total - a.total).slice(0, 200);
const llmsFull = `# 校招信息查询 · 全量索引

> 聚合 ${records.length} 家企业官方招聘公告的 26/27 届校招与实习岗位，默认仅展示未截止投递岗位。数据更新于 ${todayStr}。

## 站点

- 首页（校招汇总）：${SITE}/
- 实习汇总：${SITE}/?view=internships
- 全部企业索引：${SITE}/companies/
- 数据看板：${SITE}/?view=dashboard
- 央国企名录：${SITE}/?view=soe
- 求职资料（面试题库 / 面经）：${SITE}/?view=docs

## 常见问题

1. 收录范围：${records.length} 家企业、约 2.6 万条岗位记录，覆盖互联网、金融、制造、能源、医药、央国企与事业单位。
2. 数据来源：各企业官方招聘网站与官方公告，脚本抓取后合并去重，每家企业汇总为一个入口。
3. 更新频率：每日一次，页脚展示最后更新时间。
4. 使用成本：免费，无需注册登录。
5. 已截止岗位：默认隐藏，需在筛选里勾选「已截止」。
6. 联系方式：本站不收集投递简历，投递请前往企业官方渠道。

## 数据结构（JSON）

- ${SITE}/data/jobs.json：校招岗位（压缩格式 v2/v3，含 company / positions / cities / batches / gradYears / degrees / deadline / updatedAt / sourceUrl）
- ${SITE}/data/internships.json：实习岗位（同上）
- ${SITE}/data/facets.json：各筛选项实时计数
- ${SITE}/data/dashboard.json：行业 / 城市 / 批次 / 企业性质分布
- ${SITE}/data/soe.json：央国企与事业单位官方招聘入口
- ${SITE}/data/changelog.json：每日新增与变更统计
- ${SITE}/data/fetch-health.json：各来源抓取健康状态

## 岗位数量靠前的企业（共 ${records.length} 家，此处列前 ${topCompanies.length} 家）

${topCompanies.map((r) => `- ${r.company}：${r.total} 个在招岗位（校招 ${r.openJobs} / 实习 ${r.openInterns}）；城市：${r.cities.slice(0, 4).join('、') || '全国'}；截止：${r.deadline}；${r.url}`).join('\n')}

## 引用建议

引用本站数据时请注明「数据整理自校招信息查询（${SITE.replace('https://', '')}）」，并以企业官方最新公告为准。
`;
await writeFile(path.join(DIST, 'llms-full.txt'), llmsFull, 'utf8');

console.log(`企业页生成完成：${records.length} 家 → dist/companies/`);
console.log(`sitemap 收录 ${urls.length} 个地址；llms-full.txt 收录 ${topCompanies.length} 家企业`);
