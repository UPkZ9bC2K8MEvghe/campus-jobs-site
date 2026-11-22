// 构建静态产物到 dist/，供 Cloudflare Pages 直接发布（避免把 node_modules 传上去）
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const FILES = ['index.html', 'sw.js', 'manifest.webmanifest', 'feeds.xml', 'icon.svg', 'icon-192.png', 'icon-512.png', '_headers', 'robots.txt', 'sitemap.xml', 'llms.txt', 'assets', 'data'];

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

for (const name of FILES) {
  const from = path.join(ROOT, name);
  try {
    await stat(from);
  } catch {
    continue; // 可选文件不存在就跳过
  }
  await cp(from, path.join(DIST, name), { recursive: true });
}

console.log(`构建完成：${FILES.join(' / ')} → dist/`);
