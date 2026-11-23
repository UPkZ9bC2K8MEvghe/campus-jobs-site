// 在 CI 部署前为 dist 下全部 HTML 注入 Cloudflare Web Analytics。
// 本地没有 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID 时直接跳过，不影响构建。
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const host = process.env.WEB_ANALYTICS_HOST || 'campus-jobs.pages.dev';
const dist = path.resolve(import.meta.dirname, '..', 'dist');

if (!token || !accountId) {
  console.log('未配置 Cloudflare 凭据，跳过 Web Analytics 注入（本地构建）');
  process.exit(0);
}

const api = async (pathname, options = {}) => {
  const res = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json();
  if (!res.ok || !body.success) {
    const message = (body.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`;
    throw new Error(`Cloudflare Web Analytics API 失败：${message}`);
  }
  return body.result;
};

const hasHost = (site) => (site.rules || []).some((rule) => rule.host === host && rule.inclusive !== false && !rule.is_paused);

let sites = await api(`/accounts/${accountId}/rum/site_info/list?per_page=50&order_by=created`);
let site = (sites || []).find(hasHost);
if (!site) {
  console.log(`创建 Web Analytics 站点：${host}`);
  site = await api(`/accounts/${accountId}/rum/site_info`, {
    method: 'POST',
    body: JSON.stringify({ host, auto_install: false }),
  });
}
if (!site?.snippet) throw new Error('Cloudflare 未返回 Web Analytics snippet');

const snippet = site.snippet
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>')
  .replaceAll('&quot;', '"')
  .replaceAll('&amp;', '&');

async function htmlFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await htmlFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

let injected = 0;
let skipped = 0;
for (const file of await htmlFiles(dist)) {
  const html = await readFile(file, 'utf8');
  if (html.includes('static.cloudflareinsights.com/beacon.min.js')) {
    skipped += 1;
    continue;
  }
  if (!/<\/body>/i.test(html)) {
    skipped += 1;
    continue;
  }
  await writeFile(file, html.replace(/<\/body>/i, `${snippet}\n</body>`), 'utf8');
  injected += 1;
}
console.log(`Web Analytics 已接入：site_tag=${site.site_tag || '(未返回)'}，注入 ${injected} 个 HTML，跳过 ${skipped} 个`);
