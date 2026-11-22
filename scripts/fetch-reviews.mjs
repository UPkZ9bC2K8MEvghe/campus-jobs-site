// 聚合企业面经 / 待遇参考 → data/reviews.json
//
// 当前数据源：本站已整理的公开面经分享库（data/docs.json → experience），按公司名索引。
// 脚本预留外部公开源接入：设置环境变量 REVIEW_SOURCES=https://a,https://b 即可在抓取时
// 额外拉取公开面经文本并合并（带超时，失败不影响主流程）。UGC 留待后期。
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TIMEOUT_MS = 6000;

const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// 拉取 jobs 中的全部企业名，用于在面经标题里做最长匹配，保证 key 与岗位数据一致
const supplement = JSON.parse(await readFile(path.join(ROOT, 'data', 'supplement.json'), 'utf8'));
const companyNames = [...new Set(supplement.map((r) => r.company))].sort((a, b) => b.length - a.length);

// 先取标题里的候选公司 token（去掉“面经分享”前缀后按空格切），用于简称/全称双向匹配
const candidatesOf = (title) => {
  const cleaned = title.replace(/^面经分享[\s·•\-]*/, '').trim();
  return cleaned.split(/[\s·•\-]+/).filter((t) => t.length >= 2).slice(0, 3);
};
const matchCompany = (text) => {
  const candidates = candidatesOf(text);
  // 1) 精确包含（最长企业名优先）
  for (const name of companyNames) {
    if (name.length >= 2 && text.includes(name)) return name;
  }
  // 2) 简称 ↔ 全称 双向前缀（如“阿里” ↔ “阿里巴巴集团”）
  for (const name of companyNames) {
    if (name.length < 2) continue;
    for (const c of candidates) {
      if (c.length < 2) continue;
      if (name.startsWith(c) || c.startsWith(name)) return name;
    }
  }
  return '';
};

const reviews = {}; // company -> [{title, snippet, source, url}]
const push = (company, entry) => {
  if (!company) return;
  (reviews[company] ||= []).push(entry);
};

// 1) 本站面经分享库（docs.experience）按 <h2> 切块
const docs = JSON.parse(await readFile(path.join(ROOT, 'data', 'docs.json'), 'utf8'));
const html = docs.experience.html;
const h2Re = /<h2>([\s\S]*?)<\/h2>/g;
const blocks = [...html.matchAll(h2Re)];
for (let i = 0; i < blocks.length; i++) {
  const title = strip(blocks[i][1]);
  const blockStart = blocks[i].index + blocks[i][0].length;
  const blockEnd = i + 1 < blocks.length ? blocks[i + 1].index : html.length;
  const body = strip(html.slice(blockStart, blockEnd));
  const company = matchCompany(title);
  push(company, {
    title: title.replace(/^面经分享[\s·•\-]*/, '').trim() || title,
    snippet: body.slice(0, 200),
    source: '本站面经分享 · 整理自公开分享',
    url: '',
  });
}

// 2) 可选：外部公开源（REVIEW_SOURCES），带超时，失败静默跳过
const ext = process.env.REVIEW_SOURCES ? process.env.REVIEW_SOURCES.split(',').map((s) => s.trim()).filter(Boolean) : [];
for (const url of ext) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'campus-jobs/1.0' } });
    clearTimeout(timer);
    if (!res.ok) continue;
    const text = await res.text();
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const company = matchCompany(line);
      if (company) push(company, { title: line.slice(0, 80), snippet: '', source: '公开网络面经', url });
    }
  } catch { /* 外部源失败不影响主流程 */ }
}

// 每个企业最多保留 6 条，避免单文件过大
for (const k of Object.keys(reviews)) reviews[k] = reviews[k].slice(0, 6);

const out = {
  generatedAt: new Date().toISOString(),
  source: '本站面经分享（整理自公开分享）；外部源可选（REVIEW_SOURCES）',
  companyCount: Object.keys(reviews).length,
  reviews,
};
await writeFile(path.join(ROOT, 'data', 'reviews.json'), JSON.stringify(out), 'utf8');
console.log(`reviews.json 已生成：${out.companyCount} 家企业有面经 → data/reviews.json`);
