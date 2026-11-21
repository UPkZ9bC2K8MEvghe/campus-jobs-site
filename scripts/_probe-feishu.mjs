// 临时探针：验证飞书自建应用能否读取多维表格与文档
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const env = Object.fromEntries(
  (await readFile(path.join(ROOT, '.env.local'), 'utf8'))
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const APP_ID = env.FEISHU_APP_ID;
const APP_SECRET = env.FEISHU_APP_SECRET;
if (!APP_ID || !APP_SECRET) {
  console.log('请先在 .env.local 中填写 FEISHU_APP_ID / FEISHU_APP_SECRET');
  process.exit(1);
}
console.log('app_id:', APP_ID.slice(0, 8) + '…');

const BASE = 'https://open.feishu.cn';
const post = (p, body, token) => fetch(BASE + p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, json: await r.json() }));
const get = (p, token) => fetch(BASE + p, { headers: { Authorization: `Bearer ${token}` } })
  .then(async (r) => ({ status: r.status, json: await r.json() }));

const auth = await post('/open-apis/auth/v3/tenant_access_token/internal', { app_id: APP_ID, app_secret: APP_SECRET });
console.log('1) 获取 tenant_access_token:', auth.status, auth.json.code === 0 ? 'OK' : JSON.stringify(auth.json).slice(0, 200));
if (auth.json.code !== 0) process.exit(1);
const token = auth.json.tenant_access_token;

const BASE_TOKEN = 'GtSLbyyR3aCENOsJYC6cdlsVnih';
const app = await get(`/open-apis/bitable/v1/apps/${BASE_TOKEN}`, token);
console.log('2) 多维表格元信息:', app.status, app.json.code === 0 ? app.json.data.app.name : JSON.stringify(app.json).slice(0, 200));

const rec = await get(`/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/tblH4au5rnBcqHgJ/records?page_size=2`, token);
console.log('3) 岗位表读取:', rec.status, rec.json.code === 0
  ? `OK，命中 ${(rec.json.data.items || []).length} 条，字段 ${Object.keys((rec.json.data.items || [{}])[0].fields || {}).slice(0, 8).join(' / ')}`
  : JSON.stringify(rec.json).slice(0, 240));

for (const [name, t] of [['使用说明', 'Ev9zdpkcjomyNLxggUgcSNXwnDg'], ['面试题库', 'Qkg2dwnISo6Jlqx5O16cSt1tnId'], ['面经分享', 'UHNMd1JBWonKQFxONCecVMFfnNG']]) {
  const d = await get(`/open-apis/docx/v1/documents/${t}/raw_content`, token);
  console.log(`4) 文档「${name}」:`, d.status, d.json.code === 0 ? `OK，${(d.json.data.content || '').length} 字` : JSON.stringify(d.json).slice(0, 200));
}
