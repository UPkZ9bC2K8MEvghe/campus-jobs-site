// 从正式站（Cloudflare Pages）拉取已发布的公开数据到 data/，供 GitHub Pages 镜像每日重建。
// 只同步站点实际发布的文件；supplement.json / fetch-health.json / docs-revisions.json
// 属于构建期数据（不对外发布，且 supplement 与 health.total 必须一致），保持仓库内原样。
// 用法: node scripts/sync-public-data.mjs
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SITE = (process.env.SYNC_SOURCE || 'https://campus-jobs.pages.dev').replace(/\/$/, '');
const SHARDS = 16;
const FILES = [
  'jobs.json', 'internships.json', 'facets.json', 'dashboard.json', 'soe.json',
  'changelog.json', 'docs.json', 'questions.json', 'reviews.json', 'external-hot.json',
  ...Array.from({ length: SHARDS }, (_, i) => `jobs-detail-${i}.json`),
  ...Array.from({ length: SHARDS }, (_, i) => `internships-detail-${i}.json`),
];
const TABLES = new Set(['jobs.json', 'internships.json']);

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function download(name) {
  let lastErr;
  for (let i = 1; i <= RETRIES; i++) {
    try {
      const res = await fetch(`${SITE}/data/${name}`, {
        headers: { 'User-Agent': 'campus-jobs-mirror-sync' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const payload = JSON.parse(text); // SPA 回退会返回 HTML，这里会直接抛错
      if (TABLES.has(name) && !(payload && payload.v === 2 && Array.isArray(payload.r))) {
        throw new Error('数据格式不是 v2 紧凑格式');
      }
      return text;
    } catch (e) {
      lastErr = e;
      if (i < RETRIES) await sleep(1500 * i);
    }
  }
  throw new Error(`${name} 下载失败（重试 ${RETRIES} 次）：${lastErr?.message || lastErr}`);
}

let changed = 0;
let same = 0;
const failed = [];
const CONCURRENCY = 6;
let cursor = 0;

async function worker() {
  while (cursor < FILES.length) {
    const name = FILES[cursor++];
    try {
      const text = await download(name);
      let prev = null;
      try { prev = await readFile(path.join(DATA, name), 'utf8'); } catch { /* 首次同步 */ }
      if (prev === text) {
        same += 1;
        continue;
      }
      await writeFile(path.join(DATA, name), text, 'utf8');
      changed += 1;
    } catch (e) {
      failed.push(e.message);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`同步源: ${SITE}`);
console.log(`同步完成：更新 ${changed} 个文件，未变化 ${same} 个，失败 ${failed.length} 个`);
for (const f of failed) console.error(`  ✗ ${f}`);
if (failed.length) process.exit(1);
