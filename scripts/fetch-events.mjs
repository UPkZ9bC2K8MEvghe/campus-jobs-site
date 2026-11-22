/* 抓取高校就业网公开的宣讲会/招聘会日历，输出 data/events.json
 *
 * 7 所高校使用同一套就业系统，公开接口为：
 *   POST {base}/f/recruitmentFair/ajax_frontRecruitfair
 *   fairType=1 校内招聘会 / 3 空中宣讲会
 * 只保留未结束、且开始时间在未来 90 天内的场次。
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const SCHOOLS = [
  { key: 'bit', name: '北京理工大学', city: '北京', base: 'https://career.bit.edu.cn' },
  { key: 'buaa', name: '北京航空航天大学', city: '北京', base: 'https://career.buaa.edu.cn' },
  { key: 'pku', name: '北京大学', city: '北京', base: 'https://scc.pku.edu.cn' },
  { key: 'bnu', name: '北京师范大学', city: '北京', base: 'https://career.bnu.edu.cn' },
  { key: 'ustb', name: '北京科技大学', city: '北京', base: 'https://job.ustb.edu.cn' },
  { key: 'bjtu', name: '北京交通大学', city: '北京', base: 'https://job.bjtu.edu.cn' },
  { key: 'dlut', name: '大连理工大学', city: '大连', base: 'https://job.dlut.edu.cn' },
];

const PAGE_SIZE = 100;
const MAX_PAGES = 8;
const HORIZON_DAYS = 90;

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function parseTime(s) {
  const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` : '';
}

async function fetchFairPage(base, fairType, pageNo) {
  const body = new URLSearchParams({ fairType, pageNo: String(pageNo), pageSize: String(PAGE_SIZE), title: '' });
  const res = await fetch(`${base}/f/recruitmentFair/ajax_frontRecruitfair`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${base}/frontpage/x/html/recruitmentFairList.html?type=${fairType}`,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.state !== 1 || !json.object) throw new Error(json.msg || '接口返回异常');
  return json.object;
}

async function collectSchool(school) {
  const now = Date.now();
  const horizon = now + HORIZON_DAYS * 86400000;
  const out = [];
  const seen = new Set();

  for (const fairType of ['1', '3']) {
    for (let p = 1; p <= MAX_PAGES; p++) {
      let obj;
      try {
        obj = await fetchFairPage(school.base, fairType, p);
      } catch (e) {
        console.warn(`  ${school.name} 第 ${p} 页失败：${e.message}`);
        break;
      }
      const list = obj.list || [];
      if (!list.length) break;
      for (const it of list) {
        const start = parseTime(it.startTime);
        const end = parseTime(it.endTime) || start;
        if (!start || seen.has(it.id)) continue;
        const startMs = new Date(start).getTime();
        const endMs = new Date(end).getTime();
        if (it.isExpired === '1' || !(endMs >= now)) continue;
        if (startMs > horizon) continue;
        seen.add(it.id);
        out.push({
          id: `evt_${school.key}_${it.id}`,
          school: school.name,
          schoolKey: school.key,
          schoolCity: school.city,
          title: String(it.title || '').trim(),
          company: String(it.corporationinfo?.name || '').trim(),
          start,
          end,
          date: start.slice(0, 10),
          place: String(it.place || it.fieldExport || '').trim(),
          online: fairType === '3',
          url: it.url ? new URL(it.url, school.base).href : school.base,
        });
      }
      if (p >= (obj.totalPage || 1)) break;
      // 列表按时间倒序时，出现已过期页即可提前停止
      if (list.every((x) => x.isExpired === '1')) break;
    }
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }));
  return out;
}

const results = await mapLimit(SCHOOLS, 3, async (s) => {
  const rows = await collectSchool(s);
  console.log(`${s.name}：${rows.length} 场未结束宣讲会`);
  return rows;
});

const events = results
  .flat()
  .filter((e) => e.title)
  .sort((a, b) => a.start.localeCompare(b.start));

const payload = {
  v: 1,
  generatedAt: new Date().toISOString(),
  today: ymd(new Date()),
  horizonDays: HORIZON_DAYS,
  schools: SCHOOLS.map(({ key, name, city, base }) => ({ key, name, city, url: `${base}/frontpage/${key}/html/recruitmentFairList.html?type=1` })),
  count: events.length,
  events,
};

await writeFile(path.join(DATA_DIR, 'events.json'), JSON.stringify(payload), 'utf8');
console.log(`完成：${events.length} 场宣讲会，覆盖 ${SCHOOLS.length} 所高校 → data/events.json`);
