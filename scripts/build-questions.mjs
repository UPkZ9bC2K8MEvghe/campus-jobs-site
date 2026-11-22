// 从 data/docs.json 的 interview 文档抽取结构化题库，生成 data/questions.json
// 供企业详情按岗位关键词推荐「常见面试题」（来源标注：本站面试题库）
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const docs = JSON.parse(await readFile(path.join(ROOT, 'data', 'docs.json'), 'utf8'));
const html = docs.interview.html;

const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// 扫描 h1（分类）/ h2（题目），收集每个题目到下一个标题之间的正文作为答案
const questions = [];
let category = '';
let cursor = 0;
const tagRe = /<(h[12])>([\s\S]*?)<\/\1>/g;
const matches = [...html.matchAll(tagRe)];
for (let i = 0; i < matches.length; i++) {
  const m = matches[i];
  const tag = m[1];
  const text = strip(m[2]);
  if (tag === 'h1') { category = text; continue; }
  if (tag === 'h2') {
    const q = text;
    const blockStart = m.index + m[0].length;
    const blockEnd = i + 1 < matches.length ? matches[i + 1].index : html.length;
    const block = html.slice(blockStart, blockEnd);
    const a = strip(block).slice(0, 220);
    const id = `q${i}`;
    // 跳过非题目型标题（如“面试准备建议”）
    if (!/^\d+\./.test(q)) continue;
    questions.push({ id, category, q, a, snippet: a });
  }
}

const out = {
  generatedAt: new Date().toISOString(),
  source: '本站面试题库 · 求职资料 / 面试题库（整理公开常见面试题）',
  total: questions.length,
  questions,
};
await writeFile(path.join(ROOT, 'data', 'questions.json'), JSON.stringify(out), 'utf8');
console.log(`questions.json 已生成：${questions.length} 道题 → data/questions.json`);
