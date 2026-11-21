/* 校招信息查询站 —— 原生 JS 单页应用 */
(() => {
  'use strict';

  const DATA_BASE = 'data/';
  const PAGE_SIZE = 60;
  const DETAIL_SHARDS = 16; // 必须与 scripts/export-data.mjs 的 SHARD_COUNT 一致
  const NATIONWIDE = '__nationwide__';
  const STORAGE_KEY = 'campus-jobs-state-v2';
  const FAV_KEY = 'campus-jobs-favorites';
  const LIST_VIEWS = new Set(['jobs', 'internships']);
  const QUICK_FILTERS = [
    { key: 'open', label: '未截止' },
    { key: 'official', label: '官网直招' },
    { key: 'soe', label: '央国企' },
    { key: 'fav', label: '我的收藏' },
  ];
  const STATUS_LABELS = {
    urgent: '7 天内截止', asap: '尽快投递', test: '有笔试', over: '已截止',
    open: '只看未截止', official: '只看官网', soe: '只看央国企', fav: '只看收藏',
  };
  const FILTER_GROUPS = ['years', 'cities', 'batches', 'industries', 'ownership', 'degrees'];

  const state = {
    view: 'jobs',
    doc: 'interview',
    years: new Set(),
    cities: new Set(),
    batches: new Set(),
    industries: new Set(),
    ownership: new Set(),
    degrees: new Set(),
    status: new Set(),
    q: '',
    sort: 'updated',
  };

  const cache = {
    jobs: null, internships: null,
    detail: { jobs: [], internships: [] },
    facets: null, dashboard: null, soe: null, docs: null, changelog: null,
  };
  const ui = { filtered: [], rendered: 0, observer: null, current: null, soeFiltered: [], filtersView: null };
  const favorites = new Set();

  const $ = (id) => document.getElementById(id);
  const el = {
    searchBox: $('searchBox'),
    searchInput: $('searchInput'),
    searchClear: $('searchClear'),
    tabs: [...document.querySelectorAll('.tab')],
    subTabs: [...document.querySelectorAll('.sub-tab')],
    docsSubTabs: $('docsSubTabs'),
    countJobs: $('countJobs'), countInternships: $('countInternships'),
    listPane: $('listPane'),
    dashboardPane: $('dashboardPane'), soePane: $('soePane'), docsPane: $('docsPane'),
    sidebar: $('sidebar'), filterToggle: $('filterToggle'), activeCount: $('activeCount'),
    mobileCount: $('mobileCount'), sidebarDone: $('sidebarDone'), resetFilters: $('resetFilters'),
    resultCount: $('resultCount'), activeFilters: $('activeFilters'), sortSelect: $('sortSelect'),
    quickFilters: $('quickFilters'),
    cardList: $('cardList'), sentinel: $('sentinel'), loading: $('loading'),
    footerTotal: $('footerTotal'), lastUpdated: $('lastUpdated'), changelogNote: $('changelogNote'),
    drawer: $('drawer'), drawerMask: $('drawerMask'), drawerTitle: $('drawerTitle'),
    drawerSub: $('drawerSub'), drawerBody: $('drawerBody'), drawerClose: $('drawerClose'), drawerFav: $('drawerFav'),
    years: $('filter-years'), cities: $('filter-cities'), cityMoreList: $('cityMoreList'),
    batches: $('filter-batches'), industries: $('filter-industries'),
    ownership: $('filter-ownership'), degrees: $('filter-degree'), status: $('filter-status'),
    soeGrid: $('soeGrid'), soeTotal: $('soeTotal'), docBody: $('docBody'),
  };

  /* ---------- 工具 ---------- */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 与导出脚本同款分片哈希，保证 id 落到同一分片文件
  const shardOf = (id) => {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return h % DETAIL_SHARDS;
  };

  // 解码列表紧凑格式（scripts/export-data.mjs 的 encodeRows），列顺序必须一致
  function decodeRows(payload) {
    if (Array.isArray(payload)) return payload; // 兼容旧格式
    if (!payload || payload.v !== 2 || !Array.isArray(payload.r)) return [];
    const { d, r } = payload;
    const pick = (k, i) => (i >= 0 && d[k][i] !== undefined ? d[k][i] : '');
    const list = (k, arr) => (arr || []).map((i) => pick(k, i)).filter((v) => v !== '');
    return r.map((a) => {
      const row = {
        id: a[0],
        company: a[1],
        ownership: pick('o', a[2]),
        industries: list('i', a[3]),
        positions: a[4] || [],
        cities: list('c', a[5]),
        nationwide: !!a[6],
        gradYears: a[7] || [],
        gradUnlimited: !!a[8],
        batches: list('b', a[9]),
        degree: list('g', a[10]),
        writtenTest: a[11] === 1 ? true : a[11] === 0 ? false : null,
        deadline: a[12] === undefined ? null : a[12],
        deadlineText: a[13] || '',
        updatedAt: a[14] || '',
        sm: a[15] || '',
      };
      if (a[16]) row.source = a[16];
      if (a[17]) row.sourceName = a[17];
      if (a[18]) row.sourceUrl = a[18];
      if (a[19]) row.apply = { url: a[19] };
      if (a[20]) row.note = a[20];
      if (a[21]) row.majors = a[21];
      const dd = daysUntil(row.deadline);
      row.expired = dd != null && dd < 0;
      return row;
    });
  }
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const [y, m, d] = dateStr.split('-').map(Number);
    const target = new Date(y, m - 1, d);
    const now = new Date();
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((target - base) / 86400000);
  }

  function deadlineMeta(row) {
    const days = daysUntil(row.deadline);
    if (days == null) {
      if (/尽快/.test(row.deadlineText || '')) return { cls: 'asap', text: '尽快投递', days: null };
      return { cls: '', text: row.deadlineText || '截止待定', days: null };
    }
    if (days < 0) return { cls: 'over', text: '已截止', days };
    if (days <= 7) return { cls: 'urgent', text: days === 0 ? '今天截止' : `剩 ${days} 天`, days };
    return { cls: '', text: `截止 ${row.deadline.slice(5)}`, days };
  }

  function searchText(row) {
    if (row.__s) return row.__s;
    row.__s = [row.company, (row.positions || []).join(' '), row.cities.join(' '), row.industries.join(' '), row.sm || '', row.note || '']
      .join(' ').toLowerCase();
    return row.__s;
  }

  /* ---------- 状态持久化 ---------- */
  function loadFavorites() {
    try { for (const id of JSON.parse(localStorage.getItem(FAV_KEY) || '[]')) favorites.add(id); } catch { /* ignore */ }
  }

  function saveFavorites() {
    try { localStorage.setItem(FAV_KEY, JSON.stringify([...favorites])); } catch { /* ignore */ }
  }

  // 收藏 / 深链共用的 job 参数，避免整段 URL 重建时丢失
  function syncJobParam(id) {
    const p = new URLSearchParams(location.search);
    if (id) p.set('job', id); else p.delete('job');
    const url = p.toString() ? `?${p}` : location.pathname;
    history.replaceState(null, '', url);
  }

  function writeState(push = false) {
    const params = new URLSearchParams();
    params.set('view', state.view);
    if (state.view === 'docs') params.set('doc', state.doc);
    if (state.q.trim()) params.set('q', state.q.trim());
    if (LIST_VIEWS.has(state.view)) {
      if (state.years.size) params.set('y', [...state.years].join(','));
      if (state.cities.size) params.set('c', [...state.cities].join(','));
      if (state.batches.size) params.set('b', [...state.batches].join(','));
      if (state.industries.size) params.set('i', [...state.industries].join(','));
      if (state.ownership.size) params.set('o', [...state.ownership].join(','));
      if (state.degrees.size) params.set('d', [...state.degrees].join(','));
      if (state.status.size) params.set('st', [...state.status].join(','));
      if (state.sort !== 'updated') params.set('sort', state.sort);
    }
    if (ui.current) params.set('job', ui.current.id);
    const url = params.toString() ? `?${params}` : location.pathname;
    if (push) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        view: state.view, doc: state.doc, q: state.q, sort: state.sort,
        years: [...state.years], cities: [...state.cities], batches: [...state.batches],
        industries: [...state.industries], ownership: [...state.ownership],
        degrees: [...state.degrees], status: [...state.status],
      }));
    } catch { /* ignore */ }
  }

  function parseUrlState() {
    const p = new URLSearchParams(location.search);
    state.view = ['jobs', 'internships', 'dashboard', 'soe', 'docs'].includes(p.get('view')) ? p.get('view') : 'jobs';
    state.doc = ['usage', 'interview', 'experience'].includes(p.get('doc')) ? p.get('doc') : 'interview';
    state.q = p.get('q') || '';
    state.years = new Set((p.get('y') || '').split(',').filter(Boolean));
    state.cities = new Set((p.get('c') || '').split(',').filter(Boolean));
    state.batches = new Set((p.get('b') || '').split(',').filter(Boolean));
    state.industries = new Set((p.get('i') || '').split(',').filter(Boolean));
    state.ownership = new Set((p.get('o') || '').split(',').filter(Boolean));
    state.degrees = new Set((p.get('d') || '').split(',').filter(Boolean));
    state.status = new Set((p.get('st') || '').split(',').filter(Boolean));
    state.sort = p.get('sort') || 'updated';
    return [...p.keys()].length > 0;
  }

  function readState() {
    if (parseUrlState()) return true;
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (s) {
        Object.assign(state, {
          view: s.view || 'jobs', doc: s.doc || 'interview', q: s.q || '', sort: s.sort || 'updated',
          years: new Set(s.years || []), cities: new Set(s.cities || []), batches: new Set(s.batches || []),
          industries: new Set(s.industries || []), ownership: new Set(s.ownership || []),
          degrees: new Set(s.degrees || []), status: new Set(s.status || []),
        });
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  /* ---------- 视图切换 ---------- */
  function applyView() {
    const isList = LIST_VIEWS.has(state.view);
    el.listPane.hidden = !isList;
    el.dashboardPane.hidden = state.view !== 'dashboard';
    el.soePane.hidden = state.view !== 'soe';
    el.docsPane.hidden = state.view !== 'docs';
    el.docsSubTabs.hidden = state.view !== 'docs';
    el.searchBox.style.display = (isList || state.view === 'soe') ? '' : 'none';

    for (const t of el.tabs) t.setAttribute('aria-selected', String(t.dataset.view === state.view));
    for (const t of el.subTabs) t.setAttribute('aria-selected', String(t.dataset.doc === state.doc));

    el.searchInput.placeholder = state.view === 'soe' ? '搜索公司名称…' : '搜索公司、岗位、专业、城市…';
    syncMeta();
  }

  // 每个板块使用独立的标题与描述，便于搜索引擎与分享卡片识别
  const VIEW_META = {
    jobs: ['校招信息查询 · 26/27 届校招岗位汇总', '近 8000 家企业校招岗位，按城市、届次、批次、行业、企业性质、学历筛选，默认只显示未截止投递的岗位，每日更新。'],
    internships: ['实习岗位汇总 · 校招信息查询', '近 2000 家企业的实习岗位，按城市、届次、行业、学历筛选，默认只显示未截止投递的岗位。'],
    dashboard: ['数据看板 · 校招信息查询', '校招与实习岗位的行业、城市、批次、企业性质分布统计，基于企业官方招聘公告整理。'],
    soe: ['央国企名录 · 校招信息查询', '央国企与事业单位官方招聘官网入口名录，可直接跳转企业官方招聘页面。'],
    docs: ['求职资料 · 校招信息查询', '使用说明、面试题库与面经分享，帮助应届生完成校招投递准备。'],
  };

  function syncMeta() {
    const [title, desc] = VIEW_META[state.view] || VIEW_META.jobs;
    document.title = title;
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', desc);
  }

  async function switchView(view) {
    if (view === state.view) return;
    if (el.drawer.classList.contains('open')) closeDrawer();
    state.view = view;
    if (view === 'docs') state.doc = state.doc || 'interview';
    applyView();
    writeState(true);
    if (view === 'dashboard') await renderDashboard();
    else if (view === 'soe') await renderSOE();
    else if (view === 'docs') renderDocs();
    else {
      await loadTab(view);
      renderFilters();
      renderResults();
    }
    window.scrollTo({ top: 0 });
  }

  /* ---------- 加载 ---------- */
  async function loadJSON(name) {
    const res = await fetch(`${DATA_BASE}${name}`);
    if (!res.ok) throw new Error(`${name} 加载失败: ${res.status}`);
    return res.json();
  }

  async function loadFacets() {
    if (cache.facets) return cache.facets;
    cache.facets = await loadJSON('facets.json');
    const openJobs = cache.facets.jobs.open ?? cache.facets.jobs.total;
    const openInterns = cache.facets.internships.open ?? cache.facets.internships.total;
    el.countJobs.textContent = openJobs;
    el.countInternships.textContent = openInterns;
    el.footerTotal.textContent = (openJobs + openInterns).toLocaleString('zh-CN');
    return cache.facets;
  }

  // 列表计数只算未截止岗位，与默认展示口径一致
  const openCount = (rows) => rows.filter((r) => !r.expired).length;

  async function loadTab(tab) {
    if (cache[tab]) return cache[tab];
    el.loading.textContent = '正在加载数据…';
    const raw = await loadJSON(`${tab}.json`);
    cache[tab] = decodeRows(raw);
    if (tab === 'jobs') {
      el.countJobs.textContent = openCount(cache.jobs);
      const internN = cache.internships ? openCount(cache.internships) : (cache.facets.internships.open ?? cache.facets.internships.total);
      el.footerTotal.textContent = (openCount(cache.jobs) + internN).toLocaleString('zh-CN');
    }
    if (tab === 'internships') {
      el.countInternships.textContent = openCount(cache.internships);
      const jobN = cache.jobs ? openCount(cache.jobs) : (cache.facets.jobs.open ?? cache.facets.jobs.total);
      el.footerTotal.textContent = (jobN + openCount(cache.internships)).toLocaleString('zh-CN');
    }
    return cache[tab];
  }

  async function loadDetail(tab, id) {
    const shard = shardOf(id);
    const bucket = cache.detail[tab];
    if (!bucket[shard]) bucket[shard] = await loadJSON(`${tab}-detail-${shard}.json`);
    return bucket[shard][id] || {};
  }

  /* ---------- 筛选面板 ---------- */
  function chip(label, count, active, onClick, extraClass = '', meta = null) {
    const btn = document.createElement('button');
    btn.className = `chip ${extraClass}`.trim();
    btn.type = 'button';
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.innerHTML = `${esc(label)}${count != null ? `<span class="chip-count">${count}</span>` : ''}`;
    if (meta) {
      if (meta.group) btn.dataset.group = meta.group;
      if (meta.value != null) btn.dataset.value = meta.value;
    }
    btn.addEventListener('click', onClick);
    return btn;
  }

  function toggle(set, value) { if (set.has(value)) set.delete(value); else set.add(value); onFilterChange(); }

  function fillChips(container, items, selected, { limit = Infinity, group = '' } = {}) {
    container.innerHTML = '';
    for (const item of items.slice(0, limit)) {
      container.appendChild(chip(item.name, item.count, selected.has(item.name), () => toggle(selected, item.name), '', { group, value: item.name }));
    }
    if (items.length > limit) {
      container.appendChild(chip(`更多 ${items.length - limit} 项`, null, items.slice(limit).some((r) => selected.has(r.name)), () => {
        container.innerHTML = '';
        fillChips(container, items, selected, { group });
        container.appendChild(chip('收起', null, false, () => { container.innerHTML = ''; fillChips(container, items, selected, { limit, group }); }));
      }, 'more'));
    }
  }

  function renderFilters() {
    const facets = cache.facets[state.view];
    el.years.innerHTML = '';
    for (const y of [...facets.gradYears].sort((a, b) => b - a)) {
      el.years.appendChild(chip(`${String(y).slice(2)}届`, null, state.years.has(String(y)), () => toggle(state.years, String(y)), '', { group: 'years', value: String(y) }));
    }
    el.years.appendChild(chip('不限届', null, state.years.has('unlimited'), () => toggle(state.years, 'unlimited'), '', { group: 'years', value: 'unlimited' }));

    el.cities.innerHTML = '';
    const nationwideCount = (cache[state.view] || []).filter((r) => r.nationwide).length;
    if (nationwideCount) el.cities.appendChild(chip('全国多地', nationwideCount, state.cities.has(NATIONWIDE), () => toggle(state.cities, NATIONWIDE), '', { group: 'cities', value: NATIONWIDE }));
    for (const city of facets.cities.slice(0, 9)) {
      el.cities.appendChild(chip(city.name, city.count, state.cities.has(city.name), () => toggle(state.cities, city.name), '', { group: 'cities', value: city.name }));
    }
    const moreBtn = chip(`全部 ${facets.cities.length} 个城市`, null, false, () => {
      const open = el.cityMoreList.classList.toggle('open');
      moreBtn.textContent = open ? '收起城市列表' : `全部 ${facets.cities.length} 个城市`;
      if (open) { renderCityList(''); document.querySelector('.city-search')?.focus(); }
    }, 'more');
    el.cities.appendChild(moreBtn);

    if (!document.querySelector('.city-search')) {
      const search = document.createElement('input');
      search.className = 'city-search';
      search.placeholder = '输入城市名过滤…';
      search.style.display = 'none';
      search.addEventListener('input', () => renderCityList(search.value));
      el.cityMoreList.parentElement.insertBefore(search, el.cityMoreList);
    }

    fillChips(el.batches, facets.batches, state.batches, { limit: 8, group: 'batches' });
    fillChips(el.industries, facets.industries, state.industries, { limit: 9, group: 'industries' });
    fillChips(el.ownership, facets.ownership, state.ownership, { limit: 9, group: 'ownership' });
    fillChips(el.degrees, facets.degree, state.degrees, { limit: 6, group: 'degrees' });

    el.status.innerHTML = '';
    for (const item of [
      { name: 'urgent', label: '7 天内截止' }, { name: 'asap', label: '尽快投递' },
      { name: 'test', label: '有笔试' }, { name: 'over', label: '已截止' },
    ]) {
      el.status.appendChild(chip(item.label, null, state.status.has(item.name), () => toggle(state.status, item.name), '', { group: 'status', value: item.name }));
    }
    ui.filtersView = state.view;
    applyDynamicCounts();
    renderQuickFilters();
    updateActiveCount();
  }

  function renderCityList(keyword) {
    const facets = cache.facets[state.view];
    const list = keyword ? facets.cities.filter((c) => c.name.includes(keyword)) : facets.cities;
    el.cityMoreList.innerHTML = '';
    for (const city of list.slice(0, 400)) {
      el.cityMoreList.appendChild(chip(city.name, city.count, state.cities.has(city.name), () => toggle(state.cities, city.name), '', { group: 'cities', value: city.name }));
    }
    if (!list.length) { const p = document.createElement('p'); p.style.cssText = 'color:#7a8293;font-size:12px;margin:4px 0'; p.textContent = '没有匹配的城市'; el.cityMoreList.appendChild(p); }
    const search = document.querySelector('.city-search');
    if (search) search.style.display = el.cityMoreList.classList.contains('open') ? 'block' : 'none';
    if (el.cityMoreList.classList.contains('open')) applyDynamicCounts();
  }

  function renderQuickFilters() {
    if (!el.quickFilters) return;
    el.quickFilters.innerHTML = '';
    for (const f of QUICK_FILTERS) {
      const count = f.key === 'fav' ? favorites.size : null;
      el.quickFilters.appendChild(chip(f.label, count, state.status.has(f.key), () => toggle(state.status, f.key), 'quick'));
    }
  }

  const GROUP_PICK = {
    years: (r) => [...r.gradYears.map(String), ...(r.gradUnlimited ? ['unlimited'] : [])],
    cities: (r) => [...r.cities, ...(r.nationwide ? [NATIONWIDE] : [])],
    batches: (r) => r.batches,
    industries: (r) => r.industries,
    ownership: (r) => [r.ownership],
    degrees: (r) => r.degree,
  };

  // 计算某组选项时排除该组已选条件，得到“选了这个之后还剩多少”
  function applyDynamicCounts() {
    if (!cache.facets || !cache[state.view]) return;
    const containers = {
      years: el.years, cities: el.cities, batches: el.batches,
      industries: el.industries, ownership: el.ownership, degrees: el.degrees,
    };
    const sets = {
      years: state.years, cities: state.cities, batches: state.batches,
      industries: state.industries, ownership: state.ownership, degrees: state.degrees,
    };
    for (const group of FILTER_GROUPS) {
      const map = new Map();
      for (const row of cache[state.view]) {
        if (!matchRow(row, group)) continue;
        for (const v of GROUP_PICK[group](row)) map.set(v, (map.get(v) || 0) + 1);
      }
      const targets = [containers[group]];
      if (group === 'cities') targets.push(el.cityMoreList);
      for (const container of targets) {
        for (const btn of container.querySelectorAll('.chip[data-group]')) {
          const value = btn.dataset.value;
          const n = map.get(value) || 0;
          btn.setAttribute('aria-pressed', sets[group].has(value) ? 'true' : 'false');
          const cnt = btn.querySelector('.chip-count');
          if (cnt) cnt.textContent = String(n);
          btn.classList.toggle('zero', n === 0 && !sets[group].has(value));
        }
      }
    }
    // 投递状态由快捷筛选和侧栏共用，同步高亮
    for (const btn of el.status.querySelectorAll('.chip[data-group="status"]')) {
      btn.setAttribute('aria-pressed', state.status.has(btn.dataset.value) ? 'true' : 'false');
    }
  }

  function updateActiveCount() {
    const n = state.years.size + state.cities.size + state.batches.size + state.industries.size + state.ownership.size + state.degrees.size + state.status.size;
    el.activeCount.textContent = n ? n : '';
  }

  /* ---------- 筛选匹配 ---------- */
  // exclude: 统计某组选项计数时跳过该组已选条件（动态计数用）
  function matchRow(row, exclude = '') {
    // 默认不展示已截止岗位，只有主动勾选“已截止”时才显示
    if (row.expired && !state.status.has('over')) return false;
    if (exclude !== 'years' && state.years.size) {
      const hitYear = row.gradYears.some((y) => state.years.has(String(y)));
      const hitUnlimited = state.years.has('unlimited') && row.gradUnlimited;
      if (!hitYear && !hitUnlimited) return false;
    }
    if (exclude !== 'cities' && state.cities.size) {
      const selected = [...state.cities].filter((c) => c !== NATIONWIDE);
      let hit = row.cities.some((c) => selected.some((sel) => c === sel || c.includes(sel) || sel.includes(c)));
      if (!hit && state.cities.has(NATIONWIDE) && row.nationwide) hit = true;
      if (!hit) return false;
    }
    if (exclude !== 'batches' && state.batches.size && !row.batches.some((b) => state.batches.has(b))) return false;
    if (exclude !== 'industries' && state.industries.size && !row.industries.some((i) => state.industries.has(i))) return false;
    if (exclude !== 'ownership' && state.ownership.size && !state.ownership.has(row.ownership)) return false;
    if (exclude !== 'degrees' && state.degrees.size && !row.degree.some((d) => state.degrees.has(d))) return false;

    // 排除型快捷条件：无论其他状态如何都单独生效
    const meta = state.status.size ? deadlineMeta(row) : null;
    if (state.status.has('open') && meta.days != null && meta.days < 0) return false;
    if (state.status.has('official') && row.source !== 'official') return false;
    if (state.status.has('soe') && row.ownership !== '央国企') return false;
    if (state.status.has('fav') && !favorites.has(row.id)) return false;

    const includeStatus = ['urgent', 'over', 'asap', 'test'].filter((k) => state.status.has(k));
    if (includeStatus.length) {
      let hit = false;
      for (const key of includeStatus) {
        if (key === 'urgent' && meta.days != null && meta.days >= 0 && meta.days <= 7) hit = true;
        if (key === 'over' && meta.days != null && meta.days < 0) hit = true;
        if (key === 'asap' && meta.days == null && /尽快/.test(row.deadlineText || '')) hit = true;
        if (key === 'test' && row.writtenTest === true) hit = true;
      }
      if (!hit) return false;
    }

    // 多关键词：空格分隔后要求全部命中
    const q = state.q.trim().toLowerCase();
    if (q) {
      const text = searchText(row);
      const tokens = q.split(/\s+/).filter(Boolean);
      if (!tokens.every((t) => text.includes(t))) return false;
    }
    return true;
  }

  function highlight(text) {
    const safe = esc(text);
    const tokens = state.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return safe;
    const pattern = tokens.map((t) => escRe(esc(t))).sort((a, b) => b.length - a.length).join('|');
    try { return safe.replace(new RegExp(`(${pattern})`, 'gi'), '<mark>$1</mark>'); } catch { return safe; }
  }

  function sortRows(rows) {
    const copy = rows.slice();
    if (state.sort === 'company') copy.sort((a, b) => a.company.localeCompare(b.company, 'zh'));
    else if (state.sort === 'deadline') {
      const group = (r) => { const d = daysUntil(r.deadline); if (d == null) return 1; return d >= 0 ? 0 : 2; };
      copy.sort((a, b) => {
        const ga = group(a), gb = group(b);
        if (ga !== gb) return ga - gb;
        if (ga === 0) { const diff = daysUntil(a.deadline) - daysUntil(b.deadline); if (diff) return diff; }
        return (b.updatedAt || '').localeCompare(a.updatedAt || '');
      });
    } else copy.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') || a.company.localeCompare(b.company, 'zh'));
    return copy;
  }

  /* ---------- 列表渲染 ---------- */
  function cardHtml(row) {
    const meta = deadlineMeta(row);
    const years = row.gradUnlimited ? ['不限届', ...row.gradYears.map((y) => `${y}届`)] : row.gradYears.map((y) => `${y}届`);
    const yearLabels = years.slice(0, 3).join(' · ');
    const cities = row.cities.length ? row.cities.slice(0, 3).join(' / ') : (row.nationwide ? '全国多地' : '未注明');
    const cityText = row.nationwide && row.cities.length ? `${cities} 等 · 全国多地` : cities;
    // 同公司已合并成一条，岗位可能很多，卡片上只列前几个
    const positionText = row.positions.length
      ? (row.positions.length > 4
        ? `${row.positions.slice(0, 4).join(' / ')} 等 ${row.positions.length} 个岗位`
        : row.positions.join(' / '))
      : '岗位信息详见公告';
    return `<article class="job-card" data-id="${esc(row.id)}" tabindex="0">
      <div class="job-card-top">
        <span class="job-company">${highlight(row.company)}</span>
        ${row.source === 'official' ? '<span class="badge official">官网</span>' : ''}
        <span class="badge ownership">${esc(row.ownership)}</span>
        ${row.positions.length > 1 ? `<span class="badge positions">${row.positions.length} 个岗位</span>` : ''}
        ${yearLabels ? `<span class="badge year">${esc(yearLabels)}</span>` : ''}
        <span class="deadline ${meta.cls}">${esc(meta.text)}</span>
        <button class="fav-btn${favorites.has(row.id) ? ' active' : ''}" data-fav="${esc(row.id)}" aria-pressed="${favorites.has(row.id)}" aria-label="收藏岗位" title="${favorites.has(row.id) ? '取消收藏' : '收藏'}">★</button>
      </div>
      <div class="job-positions">${highlight(positionText)}</div>
      <div class="job-meta">
        <span>城市 <b>${highlight(cityText)}</b></span>
        ${row.batches.length ? `<span>批次 <b>${esc(row.batches.slice(0, 2).join(' / '))}</b></span>` : ''}
        ${row.degree.length ? `<span>学历 <b>${esc(row.degree.join('/'))}</b></span>` : ''}
        ${row.writtenTest ? '<span class="badge test">有笔试</span>' : ''}
        ${row.industries.length ? `<span>${esc(row.industries.slice(0, 2).join(' / '))}</span>` : ''}
      </div>
    </article>`;
  }

  function renderPage() {
    const next = ui.filtered.slice(ui.rendered, ui.rendered + PAGE_SIZE);
    if (!next.length) return;
    const frag = document.createElement('div');
    frag.innerHTML = next.map(cardHtml).join('');
    while (frag.firstChild) el.cardList.appendChild(frag.firstChild);
    ui.rendered += next.length;
    el.loading.textContent = ui.rendered >= ui.filtered.length ? '' : '继续下滑加载更多…';
  }

  function renderResults() {
    const rows = sortRows((cache[state.view] || []).filter(matchRow));
    ui.filtered = rows;
    ui.rendered = 0;
    el.cardList.innerHTML = '';
    el.loading.textContent = '';
    el.resultCount.innerHTML = `筛选后 <b>${rows.length}</b> 条 / 共 ${(cache[state.view] || []).length} 条`;
    el.mobileCount.textContent = `${rows.length} 条`;
    renderActiveTags();
    if (!rows.length) {
      el.cardList.innerHTML = `<div class="empty"><strong>没有符合条件的岗位</strong>试试减少筛选条件，或者加选「全国多地」——很多企业只在公告里写代表性城市。<div><button id="emptyNationwide">加选「全国多地」</button></div></div>`;
      $('emptyNationwide')?.addEventListener('click', () => { state.cities.add(NATIONWIDE); onFilterChange(); });
      return;
    }
    renderPage();
  }

  function renderActiveTags() {
    const groups = [
      ['years', state.years, (v) => (v === 'unlimited' ? '不限届' : `${String(v).slice(2)}届`)],
      ['cities', state.cities, (v) => (v === NATIONWIDE ? '全国多地' : v)],
      ['batches', state.batches, (v) => v], ['industries', state.industries, (v) => v],
      ['ownership', state.ownership, (v) => v], ['degrees', state.degrees, (v) => v],
      ['status', state.status, (v) => STATUS_LABELS[v] || v],
    ];
    el.activeFilters.innerHTML = '';
    for (const [, set, label] of groups) {
      for (const value of set) {
        const tag = document.createElement('span');
        tag.className = 'active-tag';
        tag.innerHTML = `${esc(label(value))}<button aria-label="移除">×</button>`;
        tag.querySelector('button').addEventListener('click', () => { set.delete(value); onFilterChange(); });
        el.activeFilters.appendChild(tag);
      }
    }
  }

  function onFilterChange() {
    writeState();
    if (LIST_VIEWS.has(state.view)) {
      // 同一视图内只更新 chip 状态与计数，避免整块筛选面板重绘
      if (ui.filtersView === state.view && cache.facets) {
        applyDynamicCounts();
        renderQuickFilters();
      } else {
        renderFilters();
      }
      renderResults();
      if (el.cityMoreList.classList.contains('open')) renderCityList(document.querySelector('.city-search')?.value || '');
      updateActiveCount();
    } else if (state.view === 'soe') renderSOE();
  }

  function toggleFavorite(id) {
    if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
    saveFavorites();
    for (const btn of document.querySelectorAll(`.fav-btn[data-fav="${id}"]`)) {
      const active = favorites.has(id);
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
      btn.title = active ? '取消收藏' : '收藏';
    }
    if (ui.current && ui.current.id === id) syncDrawerFav();
    renderQuickFilters();
    if (state.status.has('fav')) renderResults();
  }

  function syncDrawerFav() {
    if (!el.drawerFav) return;
    const active = !!ui.current && favorites.has(ui.current.id);
    el.drawerFav.classList.toggle('active', active);
    el.drawerFav.textContent = active ? '★' : '☆';
    el.drawerFav.setAttribute('aria-pressed', String(active));
    el.drawerFav.title = active ? '取消收藏' : '收藏';
  }

  /* ---------- 详情抽屉 ---------- */
  async function openDrawer(row, tab, { history: historyMode = true } = {}) {
    ui.current = row;
    el.drawerTitle.textContent = row.company;
    const sub = [row.ownership, (row.industries || []).join(' / ')].filter(Boolean).join(' · ');
    el.drawerSub.textContent = sub;
    el.drawerBody.innerHTML = '<div class="loading">加载详情…</div>';
    el.drawer.classList.add('open');
    el.drawerMask.classList.add('open');
    document.body.style.overflow = 'hidden';
    syncDrawerFav();
    if (historyMode) syncJobParam(row.id);

    try {
      if (row.source === 'official') {
        renderDrawerBody(row, tab);
      } else {
        const detail = await loadDetail(tab, row.id);
        renderDrawerBody({ ...row, ...detail }, tab);
      }
    } catch (e) {
      el.drawerBody.innerHTML = `<div class="empty">详情加载失败：${esc(e.message)}</div>`;
    }
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function buildIcs(row) {
    const [y, m, d] = row.deadline.split('-').map(Number);
    const start = `${y}${pad2(m)}${pad2(d)}`;
    const next = new Date(y, m - 1, d + 1);
    const end = `${next.getFullYear()}${pad2(next.getMonth() + 1)}${pad2(next.getDate())}`;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const escIcs = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
    const desc = [...(row.positions || []).slice(0, 6), row.apply && row.apply.url].filter(Boolean).join('\n');
    return [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//campus-jobs//CN', 'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      `UID:${row.id}@campus-jobs`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${end}`,
      `SUMMARY:${escIcs(`${row.company} 投递截止`)}`,
      `DESCRIPTION:${escIcs(desc)}`,
      'BEGIN:VALARM', 'TRIGGER:-P3D', 'ACTION:DISPLAY', `DESCRIPTION:${escIcs('还有 3 天截止')}`, 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
  }

  function downloadFile(name, content, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function renderDrawerBody(r, tab) {
    const meta = deadlineMeta(r);
    const years = r.gradUnlimited ? ['不限届', ...r.gradYears.map((y) => `${y}届`)] : r.gradYears.map((y) => `${y}届`);
    const links = [];
    if (r.announce && r.announce.url) links.push(`<a class="link-btn" href="${esc(r.announce.url)}" target="_blank" rel="noopener">查看公告原文 ↗</a>`);
    if (r.apply && r.apply.url) {
      links.push(`<a class="link-btn primary" href="${esc(r.apply.url)}" target="_blank" rel="noopener">${r.apply.email ? '投递邮箱' : '立即投递 ↗'}</a>`);
      if (r.apply.email) links.push(`<button class="copy-btn" id="copyEmail">复制邮箱</button>`);
    }
    const noteLinks = (r.noteLinks || []).map((l) => `<a class="link-btn" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join('');
    const row = (label, value) => value ? `<div class="detail-row"><dt>${esc(label)}</dt><dd>${value}</dd></div>` : '';
    const tags = (list) => list.length ? `<span class="detail-tags">${list.map((x) => `<span class="badge">${esc(x)}</span>`).join('')}</span>` : '—';
    const icsBtn = r.deadline ? '<button class="copy-btn" id="exportIcs">导出日历 (.ics)</button>' : '';

    el.drawerBody.innerHTML = `
      <section class="detail-section"><h3>投递入口</h3>${links.length || icsBtn ? `${links.join('')}${icsBtn}` : '<span style="color:#7a8293;font-size:13px">公告未提供直接链接</span>'}</section>
      <section class="detail-section"><h3>基本信息</h3><dl class="detail-rows">
        ${row('企业性质', esc(r.ownership))}
        ${row('行业分类', tags(r.industries || []))}
        ${row('届次', tags(years))}
        ${row('批次', tags(r.batches || []))}
        ${row('学历要求', tags(r.degree || []))}
        ${row('专业要求', esc(r.majors || '—'))}
        ${row('是否笔试', r.writtenTest === true ? '有笔试' : r.writtenTest === false ? '无笔试' : '未注明')}
      </dl></section>
      <section class="detail-section"><h3>岗位与地点</h3><dl class="detail-rows">
        ${row('招聘岗位', (r.positions || []).length ? r.positions.map((p) => `<div>· ${esc(p)}</div>`).join('') : '—')}
        ${row('工作地点', `${esc((r.cities || []).join(' / ') || '未注明')}${r.nationwide ? ' <span class="badge">含全国多地</span>' : ''}`)}
        ${row('截止时间', `${esc(r.deadline || r.deadlineText || '未注明')} <span class="deadline ${meta.cls}">${esc(meta.text)}</span>`)}
        ${row('更新时间', esc(r.updatedAt || '—'))}
        ${row('公告来源', r.sourceName ? `<a href="${esc(r.sourceUrl || '#')}" target="_blank" rel="noopener">${esc(r.sourceName)} ↗</a>` : esc(r.source || '—'))}
      </dl></section>
      ${r.note ? `<section class="detail-section"><h3>备注</h3><div class="note-box">${esc(r.note)}</div>${noteLinks ? `<div style="margin-top:8px">${noteLinks}</div>` : ''}</section>` : ''}
    `;
    $('copyEmail')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(r.apply.email); $('copyEmail').textContent = '已复制'; }
      catch { $('copyEmail').textContent = '复制失败，请手动选择'; }
    });
    $('exportIcs')?.addEventListener('click', () => {
      downloadFile(`${r.company}-投递截止.ics`, buildIcs(r), 'text/calendar;charset=utf-8');
    });
  }

  function closeDrawer() {
    el.drawer.classList.remove('open');
    el.drawerMask.classList.remove('open');
    document.body.style.overflow = '';
    ui.current = null;
    syncDrawerFav();
    syncJobParam(null);
  }

  function findRowById(id) {
    for (const tab of ['jobs', 'internships']) {
      const row = cache[tab]?.find((r) => r.id === id);
      if (row) return { row, tab };
    }
    return null;
  }

  async function openJobById(id, opts) {
    const found = findRowById(id);
    if (found) return openDrawer(found.row, found.tab, opts);
    for (const tab of ['jobs', 'internships']) {
      try {
        await loadTab(tab);
        const hit = cache[tab] && cache[tab].find((r) => r.id === id);
        if (hit) return openDrawer(hit, tab, opts);
      } catch { /* 忽略，继续找下个列表 */ }
    }
    closeDrawer();
  }

  /* ---------- 看板 ---------- */
  async function renderDashboard() {
    if (!cache.dashboard) cache.dashboard = await loadJSON('dashboard.json');
    if (!cache.changelog) {
      try { cache.changelog = await loadJSON('changelog.json'); } catch { cache.changelog = { addedCount: 0 }; }
    }
    const d = cache.dashboard;
    const c = d.cards;
    el.lastUpdated.textContent = new Date(d.generatedAt).toLocaleString('zh-CN');
    const addedN = cache.changelog.addedCount || 0;

    const cards = [
      ['校招岗位', c.jobsTotal, 'var(--brand)'],
      ['实习岗位', c.internTotal, '#6b3fd4'],
      ['26 届可投', c.grad26, 'var(--ok)'],
      ['27 届可投', c.grad27, 'var(--brand)'],
      ['央国企', c.soe, 'var(--warn)'],
      ['外企', c.foreign, '#0ea5e9'],
      ['7 天内截止', c.upcoming7, 'var(--danger)'],
      ['本周更新', c.updatedThisWeek, 'var(--ok)'],
    ];
    if (addedN) cards.push(['本次抓取新增', addedN, '#0891b2']);

    const wc = (items) => {
      const max = items[0]?.count || 1;
      const colors = ['#2b59ff', '#6b3fd4', '#0ea5e9', '#067647', '#d97706', '#d92d20', '#0891b2', '#7c3aed'];
      return items.map((it, i) => {
        const size = 12 + (it.count / max) * 22;
        return `<span class="wc-word" style="font-size:${size.toFixed(1)}px;color:${colors[i % colors.length]}" title="${it.name}: ${it.count}">${esc(it.name)}</span>`;
      }).join('');
    };

    const countdown = d.upcoming.map((u) => {
      const meta = { text: u.days === 0 ? '今天截止' : `剩 ${u.days} 天`, cls: u.days <= 1 ? 'urgent' : '' };
      return `<div class="cd-row" data-id="${esc(u.id)}"><span class="cd-company">${esc(u.company)}</span><span class="deadline ${meta.cls}">${esc(meta.text)}</span><span class="cd-date">${esc(u.deadline)}</span></div>`;
    }).join('');

    el.dashboardPane.innerHTML = `
      <div class="dash-grid">
        ${cards.map(([label, val, color]) => `<div class="stat-card" style="--accent:${color}"><div class="stat-val">${val.toLocaleString('zh-CN')}</div><div class="stat-label">${esc(label)}</div></div>`).join('')}
      </div>
      <div class="dash-row">
        <div class="dash-card"><h3>即将截止倒计时</h3><div class="cd-list">${countdown || '<p class="muted">暂无</p>'}</div></div>
        <div class="dash-card"><h3>岗位词云</h3><div class="wordcloud">${wc(d.positions)}</div></div>
        <div class="dash-card"><h3>城市词云</h3><div class="wordcloud">${wc(d.cities)}</div></div>
      </div>
      <p class="muted dash-tip">提示：点击「即将截止」的公司可直接打开岗位详情。数据生成于 ${esc(el.lastUpdated.textContent)}。</p>
    `;
    el.dashboardPane.querySelectorAll('.cd-row').forEach((row) => {
      row.addEventListener('click', () => {
        const found = findRowById(row.dataset.id);
        if (found) openDrawer(found.row, found.tab);
      });
    });
  }

  /* ---------- 名录 ---------- */
  async function renderSOE() {
    if (!cache.soe) cache.soe = await loadJSON('soe.json');
    el.soeTotal.textContent = cache.soe.length;
    const q = state.view === 'soe' ? state.q.trim().toLowerCase() : '';
    const list = q ? cache.soe.filter((s) => s.company.toLowerCase().includes(q)) : cache.soe;
    ui.soeFiltered = list;
    el.soeGrid.innerHTML = list.map((s) =>
      s.url
        ? `<a class="soe-card" href="${esc(s.url)}" target="_blank" rel="noopener"><span class="soe-name">${highlight(s.company)}</span><span class="soe-go">访问官网 ↗</span></a>`
        : `<div class="soe-card soe-card--nolink"><span class="soe-name">${highlight(s.company)}</span><span class="soe-go muted">暂无链接</span></div>`
    ).join('') || `<div class="empty">没有匹配「${esc(q)}」的公司</div>`;
  }

  /* ---------- 资料 ---------- */
  async function renderDocs() {
    if (!cache.docs) cache.docs = await loadJSON('docs.json');
    const doc = cache.docs[state.doc];
    el.docBody.innerHTML = doc
      ? `<h2 class="doc-title">${esc(doc.title)}</h2><div class="doc-content">${doc.html}</div>`
      : '<div class="empty">文档加载失败</div>';
  }

  /* ---------- 事件 ---------- */
  let searchTimer = null;

  async function onPopState() {
    parseUrlState();
    el.searchInput.value = state.q;
    el.searchClear.style.display = state.q ? 'block' : 'none';
    el.sortSelect.value = state.sort;
    applyView();
    try {
      if (LIST_VIEWS.has(state.view)) {
        await loadTab(state.view);
        renderFilters();
        renderResults();
      } else if (state.view === 'dashboard') await renderDashboard();
      else if (state.view === 'soe') await renderSOE();
      else if (state.view === 'docs') renderDocs();
    } catch (err) {
      el.cardList.innerHTML = `<div class="empty"><strong>数据加载失败</strong>${esc(err.message)}</div>`;
    }
    const jobId = new URLSearchParams(location.search).get('job');
    if (jobId) await openJobById(jobId, { history: false });
    else if (el.drawer.classList.contains('open')) closeDrawer();
    writeState();
    window.scrollTo({ top: 0 });
  }

  function bindEvents() {
    window.addEventListener('popstate', onPopState);
    for (const tab of el.tabs) tab.addEventListener('click', () => { if (state.view !== tab.dataset.view) switchView(tab.dataset.view); });
    for (const t of el.subTabs) t.addEventListener('click', () => { state.doc = t.dataset.doc; applyView(); writeState(); renderDocs(); });

    el.searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.q = el.searchInput.value;
        el.searchClear.style.display = state.q ? 'block' : 'none';
        writeState();
        if (LIST_VIEWS.has(state.view)) {
          if (ui.filtersView === state.view) applyDynamicCounts();
          renderResults();
        } else if (state.view === 'soe') renderSOE();
      }, 120);
    });
    el.searchClear.addEventListener('click', () => {
      el.searchInput.value = ''; state.q = ''; el.searchClear.style.display = 'none';
      writeState();
      if (LIST_VIEWS.has(state.view)) {
        if (ui.filtersView === state.view) applyDynamicCounts();
        renderResults();
      } else if (state.view === 'soe') renderSOE();
      el.searchInput.focus();
    });

    el.resetFilters.addEventListener('click', () => {
      state.years.clear(); state.cities.clear(); state.batches.clear(); state.industries.clear();
      state.ownership.clear(); state.degrees.clear(); state.status.clear(); state.q = ''; state.sort = 'updated';
      el.searchInput.value = ''; el.searchClear.style.display = 'none'; el.sortSelect.value = 'updated';
      el.cityMoreList.classList.remove('open'); onFilterChange();
    });
    el.sortSelect.addEventListener('change', () => { state.sort = el.sortSelect.value; writeState(); renderResults(); });

    el.cardList.addEventListener('click', (e) => {
      const favBtn = e.target.closest('.fav-btn');
      if (favBtn) { e.stopPropagation(); toggleFavorite(favBtn.dataset.fav); return; }
      const card = e.target.closest('.job-card');
      if (!card) return;
      const row = ui.filtered.find((r) => r.id === card.dataset.id);
      if (row) openDrawer(row, state.view);
    });
    el.cardList.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('.fav-btn')) return;
      const card = e.target.closest('.job-card');
      if (!card) return;
      e.preventDefault();
      const row = ui.filtered.find((r) => r.id === card.dataset.id);
      if (row) openDrawer(row, state.view);
    });
    el.drawerFav.addEventListener('click', () => { if (ui.current) toggleFavorite(ui.current.id); });

    el.drawerClose.addEventListener('click', closeDrawer);
    el.drawerMask.addEventListener('click', () => {
      if (el.sidebar.classList.contains('open')) { el.sidebar.classList.remove('open'); el.drawerMask.classList.remove('open'); document.body.style.overflow = ''; return; }
      closeDrawer();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { if (el.drawer.classList.contains('open')) closeDrawer(); else if (el.sidebar.classList.contains('open')) closeSidebar(); }
    });

    el.filterToggle.addEventListener('click', () => { el.sidebar.classList.add('open'); el.drawerMask.classList.add('open'); document.body.style.overflow = 'hidden'; });
    el.sidebarDone.addEventListener('click', closeSidebar);

    ui.observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) renderPage(); }, { rootMargin: '600px 0px' });
    ui.observer.observe(el.sentinel);
  }

  function closeSidebar() { el.sidebar.classList.remove('open'); el.drawerMask.classList.remove('open'); document.body.style.overflow = ''; }

  /* ---------- 初始化 ---------- */
  async function loadChangelog() {
    try {
      const log = await loadJSON('changelog.json');
      const added = (log.added || []).length;
      const removed = (log.removed || []).length;
      el.changelogNote.textContent = added || removed ? ` · 本次更新 +${added}${removed ? ` / -${removed}` : ''}` : '';
    } catch { el.changelogNote.textContent = ''; }
  }

  async function init() {
    try { await loadFacets(); }
    catch (err) { el.listPane.innerHTML = `<div class="empty"><strong>数据加载失败</strong>${esc(err.message)}<br>请通过本地服务器打开页面。</div>`; return; }

    loadFavorites();
    readState();
    el.searchInput.value = state.q;
    el.searchClear.style.display = state.q ? 'block' : 'none';
    el.sortSelect.value = state.sort;
    bindEvents();
    applyView();

    if (LIST_VIEWS.has(state.view)) {
      try { await loadTab(state.view); renderFilters(); renderResults(); }
      catch (err) { el.cardList.innerHTML = `<div class="empty"><strong>数据加载失败</strong>${esc(err.message)}</div>`; el.loading.textContent = ''; }
    } else if (state.view === 'dashboard') await renderDashboard();
    else if (state.view === 'soe') await renderSOE();
    else if (state.view === 'docs') renderDocs();

    const jobId = new URLSearchParams(location.search).get('job');
    if (jobId) await openJobById(jobId, { history: false });

    writeState();
    loadChangelog();

    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      const hadController = !!navigator.serviceWorker.controller;
      // updateViaCache: none 让 sw.js 每次都绕过 HTTP 缓存校验，避免旧缓存长期驻留
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => { /* 离线缓存非关键路径 */ });
      if (hadController) {
        let reloaded = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (reloaded) return;
          reloaded = true;
          if (!sessionStorage.getItem('sw-reloaded')) {
            sessionStorage.setItem('sw-reloaded', '1');
            location.reload();
          }
        });
      }
    }
  }

  init();
})();
