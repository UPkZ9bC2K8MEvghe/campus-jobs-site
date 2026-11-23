// 仅用于 GitHub Pages 镜像构建：把 dist/ 里的 canonical / sitemap / feeds 等绝对地址
// 从 Cloudflare 正式站替换为 GitHub Pages 地址，避免镜像站被判定为重复内容。
// 源文件与 Cloudflare 部署流程都不受影响。
// 用法: SITE_URL=https://<user>.github.io/<repo> node scripts/rewrite-site-url.mjs
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OLD = (process.env.SITE_OLD || 'https://campus-jobs.pages.dev').replace(/\/$/, '');
const NEW = (process.env.SITE_URL || '').replace(/\/$/, '');
if (!NEW) {
  console.error('缺少 SITE_URL，例如 SITE_URL=https://user.github.io/repo');
  process.exit(1);
}

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const EXTS = new Set(['.html', '.xml', '.txt', '.webmanifest', '.js', '.css']);

let files = 0;
let hits = 0;

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full);
      continue;
    }
    if (!EXTS.has(path.extname(entry.name))) continue;
    const text = await readFile(full, 'utf8');
    if (!text.includes(OLD)) continue;
    const next = text.split(OLD).join(NEW);
    await writeFile(full, next);
    files += 1;
    hits += text.split(OLD).length - 1;
  }
}

await walk(DIST);
console.log(`站点地址已改写: ${files} 个文件 / ${hits} 处 ${OLD} -> ${NEW}`);
