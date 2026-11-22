// 生成 RSS 订阅源 feeds.xml（零服务器成本，供聚合器抓取每日新增岗位）
// 数据来源：data/supplement.json（已合并去重的企业官方岗位），按更新时间倒序取最近 N 条
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SITE = 'https://campus-jobs.pages.dev/';
const MAX_ITEMS = 80;

const rfc822 = (d) => {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return date.toUTCString();
};

const xml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const supplement = JSON.parse(await readFile(path.join(ROOT, 'data', 'supplement.json'), 'utf8'));
let changelog = { generatedAt: '' };
try { changelog = JSON.parse(await readFile(path.join(ROOT, 'data', 'changelog.json'), 'utf8')); } catch { /* 忽略 */ }

const rows = [...supplement]
  .filter((r) => r.updatedAt)
  .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
  .slice(0, MAX_ITEMS);

const items = rows.map((r) => {
  const positions = (r.positions || []).slice(0, 6).join('、') || '岗位信息详见公告';
  const cities = (r.cities || []).slice(0, 4).join('、') || (r.nationwide ? '全国多地' : '未注明');
  const descParts = [`岗位：${positions}`, `地点：${cities}`];
  if (r.deadline) descParts.push(`截止：${r.deadline}`);
  if (r.degree?.length) descParts.push(`学历：${r.degree.join('/')}`);
  if (r.sourceName) descParts.push(`来源：${r.sourceName}`);
  const link = `${SITE}?job=${encodeURIComponent(r.id)}`;
  return `    <item>
      <title>${xml(r.company)}${r.positions?.length ? ` · ${xml(r.positions[0])}` : ''}</title>
      <link>${xml(link)}</link>
      <guid isPermaLink="false">${xml(r.id)}</guid>
      <pubDate>${rfc822(r.updatedAt)}</pubDate>
      <description>${xml(descParts.join('；'))}</description>
    </item>`;
}).join('\n');

const lastBuild = rfc822(changelog.generatedAt || new Date());

const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>校招信息查询 · 每日新增岗位</title>
    <link>${SITE}</link>
    <description>近 8000 家企业官方校招与实习岗位，按更新时间倒序。数据整理自企业官方招聘公告，每日更新。</description>
    <language>zh-CN</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
    <atom:link href="${SITE}feeds.xml" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;

await writeFile(path.join(ROOT, 'feeds.xml'), feed, 'utf8');
console.log(`feeds.xml 已生成：${rows.length} 条岗位 → feeds.xml`);
