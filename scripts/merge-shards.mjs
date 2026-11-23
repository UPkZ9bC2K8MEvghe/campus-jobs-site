/* 合并 CI 分片抓取产物 → 主数据文件
 * 输入：data/supplement.shard-i.json、data/fetch-health.shard-i.json（由 fetch-official.mjs --shard=i/n 产出）
 * 输出：data/supplement.json、data/fetch-health.json，并清理分片临时文件
 * 用法：node scripts/merge-shards.mjs（GitHub Actions deploy 阶段，本地也可手动调用）
 */
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');

async function readJSONSafe(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// ok / cached / skipped 均视为"无需担心"；参数为状态字符串
const isGood = (status) => status === 'ok' || status === 'cached' || status === 'skipped';

async function sendAlert(warnings, total) {
  const url = process.env.FETCH_ALERT_WEBHOOK;
  if (!url) return;
  const text = `【校招数据抓取告警】\n${warnings.join('\n')}\n本次补充岗位 ${total} 条`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }),
      signal: AbortSignal.timeout(10000),
    });
    console.log(res.ok ? '已推送 webhook 告警' : `webhook 告警失败：HTTP ${res.status}`);
  } catch (e) {
    console.log(`webhook 告警失败：${e.message}`);
  }
}

const listDir = await readdir(DATA_DIR);
const suppFiles = listDir.filter((f) => /^supplement\.shard-\d+\.json$/.test(f)).sort();
const healthFiles = listDir.filter((f) => /^fetch-health\.shard-\d+\.json$/.test(f)).sort();

if (!suppFiles.length) {
  console.log('未发现分片产物（supplement.shard-*.json），跳过合并');
} else {
  /* supplement：分片公司整段覆盖旧数据（与 --only 模式一致的合并规则），其余保留 */
  const prevRows = await readJSONSafe(path.join(DATA_DIR, 'supplement.json'), []);
  const shardRows = [];
  for (const f of suppFiles) {
    shardRows.push(...(await readJSONSafe(path.join(DATA_DIR, f), [])));
  }
  const shardCompanies = new Set(shardRows.map((r) => r.company));
  const seen = new Set();
  const merged = [];
  for (const r of [...prevRows.filter((r2) => !shardCompanies.has(r2.company)), ...shardRows]) {
    if (!seen.has(r.id)) { seen.add(r.id); merged.push(r); }
  }
  await writeFile(path.join(DATA_DIR, 'supplement.json'), JSON.stringify(merged), 'utf8');
  console.log(`supplement 合并完成：${merged.length} 条（分片覆盖 ${shardCompanies.size} 家企业、${shardRows.length} 条）`);

  /* health：sources 按 key 覆盖合并，warnings 拼接，history 追加一条，durationMs 取并行分片最大值 */
  const now = new Date().toISOString();
  const prevHealth = await readJSONSafe(path.join(DATA_DIR, 'fetch-health.json'), {});
  const sources = new Map((prevHealth.sources || []).map((s) => [s.key, s]));
  const warnings = [];
  let durationMs = 0;
  for (const f of healthFiles) {
    const h = await readJSONSafe(path.join(DATA_DIR, f), {});
    for (const s of h.sources || []) sources.set(s.key, s);
    warnings.push(...(h.warnings || []));
    durationMs = Math.max(durationMs, Number(h.durationMs) || 0);
  }
  const failed = [...sources.values()].filter((s) => !isGood(s.status)).length;
  const history = [
    ...(Array.isArray(prevHealth.history) ? prevHealth.history : []),
    { generatedAt: now, total: merged.length, warnings: warnings.length, failed },
  ].slice(-14);
  await writeFile(path.join(DATA_DIR, 'fetch-health.json'), JSON.stringify({
    generatedAt: now,
    durationMs,
    total: merged.length,
    warnings,
    history,
    sources: [...sources.values()],
  }, null, 2), 'utf8');
  console.log(`fetch-health 合并完成：${sources.size} 个源，${warnings.length} 条警告，失败 ${failed} 个`);

  /* 清理分片临时文件（逐个 unlink，非递归删除） */
  for (const f of [...suppFiles, ...healthFiles]) {
    await unlink(path.join(DATA_DIR, f)).catch(() => {});
  }
  console.log(`已清理 ${suppFiles.length + healthFiles.length} 个分片文件`);

  if (warnings.length) {
    console.log('\n⚠ 需要关注：');
    for (const w of warnings) console.log(`  - ${w}`);
    await sendAlert(warnings, merged.length);
  }
}
