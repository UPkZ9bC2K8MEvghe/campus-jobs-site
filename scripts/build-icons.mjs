// 用 Playwright 把 icon.svg 渲染为 PNG（192 / 512），供 PWA manifest 引用
// 仅生成一次的静态产物；浏览器不可用时跳过，仍可仅用 SVG 图标
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
let chromium;
try { ({ chromium } = await import('playwright')); } catch { console.log('未安装 playwright，跳过 PNG 图标生成'); process.exit(0); }

const svg = await readFile(path.join(ROOT, 'icon.svg'), 'utf8');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}</style></head><body><img id="i" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" style="width:512px;height:512px;display:block"></body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForTimeout(150);
  for (const size of [192, 512]) {
    await page.setViewportSize({ width: size, height: size });
    await page.evaluate((s) => { const img = document.getElementById('i'); img.style.width = s + 'px'; img.style.height = s + 'px'; }, size);
    const buf = await page.screenshot({ clip: { x: 0, y: 0, width: size, height: size }, omitBackground: false });
    await writeFile(path.join(ROOT, `icon-${size}.png`), buf);
    console.log(`生成 icon-${size}.png`);
  }
} finally {
  await browser.close();
}
