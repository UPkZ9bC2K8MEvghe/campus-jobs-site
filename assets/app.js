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
  const ALL_VIEWS = new Set(['jobs', 'internships', 'apps', 'events', 'dashboard', 'soe', 'docs']);
  const QUICK_FILTERS = [
    { key: 'open', label: '未截止' },
    { key: 'official', label: '官网直招' },
    { key: 'soe', label: '央国企' },
    { key: 'private', label: '民企' },
    { key: 'fav', label: '我的收藏' },
  ];
  const STATUS_LABELS = {
    urgent: '7 天内截止', asap: '尽快投递', test: '有笔试', over: '已截止',
    open: '只看未截止', official: '只看官网', soe: '只看央国企', private: '只看民企', fav: '只看收藏',
  };
  const FILTER_GROUPS = ['years', 'cities', 'batches', 'industries', 'ownership', 'degrees'];
  // F1 投递进度：本地状态机（仅存本机 localStorage）
  const APPS_KEY = 'campus-jobs-apps';
  const PROFILE_KEY = 'campus-jobs-profile';
  const APP_STATUSES = [
    { key: 'saved', label: '已收藏' },
    { key: 'applied', label: '已投递' },
    { key: 'test', label: '笔试' },
    { key: 'interview', label: '面试' },
    { key: 'offer', label: 'Offer' },
    { key: 'rejected', label: '已拒' },
  ];
  const APP_STATUS_LABELS = Object.fromEntries(APP_STATUSES.map((s) => [s.key, s.label]));
  const COMPARE_MAX = 4; // F3 岗位对比上限

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
    facets: null, dashboard: null, soe: null, docs: null, changelog: null, events: null,
    reviews: null, questions: null,
  };
  const ui = {
    filtered: [], rendered: 0, observer: null, current: null, soeFiltered: [],
    filtersView: null, eventSchool: '',
    compare: new Set(),       // F3 对比集合（内存态）
    deferredPrompt: null,     // F12 PWA 安装提示
  };
  const favorites = new Set();
  const apps = {};            // F1 { id: {status, appliedAt, note, updatedAt} }
  const profile = { major: '', majorOnly: false }; // F9

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
    eventsPane: $('eventsPane'), eventsList: $('eventsList'), eventsTotal: $('eventsTotal'),
    eventsSchools: $('eventsSchools'), eventsSchoolChips: $('eventsSchoolChips'), countEvents: $('countEvents'),
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
    // 新增功能元素（F1/F3/F5/F9/F11/F12）
    appsPane: $('appsPane'), appsList: $('appsList'), appsStats: $('appsStats'), countApps: $('countApps'),
    exportFavIcs: $('exportFavIcs'), exportEventsIcs: $('exportEventsIcs'), clearApps: $('clearApps'),
    majorInput: $('majorInput'), majorOnly: $('majorOnly'),
    shareBtn: $('shareBtn'),
    compareBar: $('compareBar'), compareCount: $('compareCount'), compareOpen: $('compareOpen'), compareClear: $('compareClear'),
    installBanner: $('installBanner'), installBtn: $('installBtn'), installDismiss: $('installDismiss'),
    toast: $('toast'),
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

  /* ---------- 通用辅助 ---------- */
  let toastTimer = null;
  function toast(msg) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 1800);
  }
  // 公司名归一化：去掉括号附注、股份/集团/有限公司等后缀，用于宣讲会↔岗位、面经匹配
  function companyKey(name) {
    return String(name || '')
      .replace(/[（(].*?[)）]/g, '')
      .replace(/(股份有限公司|有限责任公司|有限公司|集团公司|集团|控股|公司|总公司)$/g, '')
      .replace(/\s+/g, '').trim();
  }
  function allRows() { return [...(cache.jobs || []), ...(cache.internships || [])]; }
  // 在两个列表里按公司名查找（先精确，后归一化包含）
  function findRowsByCompany(company) {
    if (!company) return [];
    const key = companyKey(company);
    const exact = allRows().filter((r) => r.company === company);
    if (exact.length) return exact;
    return allRows().filter((r) => companyKey(r.company) === key || (key && companyKey(r.company).includes(key)));
  }

  /* ---------- 状态持久化 ---------- */
  function loadFavorites() {
    try { for (const id of JSON.parse(localStorage.getItem(FAV_KEY) || '[]')) favorites.add(id); } catch { /* ignore */ }
  }

  function saveFavorites() {
    try { localStorage.setItem(FAV_KEY, JSON.stringify([...favorites])); } catch { /* ignore */ }
  }

  /* F1 投递进度（本机存储） */
  function loadApps() {
    try { Object.assign(apps, JSON.parse(localStorage.getItem(APPS_KEY) || '{}')); } catch { /* ignore */ }
  }
  function saveApps() { try { localStorage.setItem(APPS_KEY, JSON.stringify(apps)); } catch { /* ignore */ } }
  function getApp(id) { return apps[id] || null; }
  function appStatusOf(id) { return apps[id]?.status || (favorites.has(id) ? 'saved' : ''); }
  function setAppStatus(id, status) {
    const rec = apps[id] || { status: 'saved', appliedAt: '', note: '', updatedAt: '' };
    rec.status = status;
    rec.updatedAt = new Date().toISOString();
    if (status === 'applied' && !rec.appliedAt) rec.appliedAt = todayStr();
    apps[id] = rec;
    saveApps();
    updateAppsCount();
  }
  function setAppNote(id, note) {
    const rec = apps[id] || { status: 'saved', appliedAt: '', note: '', updatedAt: '' };
    rec.note = note; rec.updatedAt = new Date().toISOString();
    apps[id] = rec; saveApps();
  }
  const NOTE_PLACEHOLDER = '点击添加备注（笔试时间 / 面试轮次 / HR 联系方式等）';
  // 统一备注字段绑定：聚焦清空占位符、输入防抖保存、失焦兜底保存
  function bindNoteField(note, id) {
    if (!note) return;
    let timer = null;
    const flush = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      setAppNote(id, note.textContent.trim());
    };
    note.addEventListener('focus', () => {
      if (note.dataset.empty === 'true') { note.textContent = ''; note.dataset.empty = 'false'; }
    });
    note.addEventListener('input', () => {
      note.dataset.empty = note.textContent.trim() ? 'false' : 'true';
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 400);
    });
    note.addEventListener('blur', () => {
      if (timer) { clearTimeout(timer); timer = null; }
      const v = note.textContent.trim();
      if (!v) { note.textContent = NOTE_PLACEHOLDER; note.dataset.empty = 'true'; }
      setAppNote(id, v);
    });
  }
  // 刷新/关闭页面前，把正在编辑（未失焦）的备注同步落盘，避免丢失
  function flushActiveNote() {
    const el0 = document.activeElement;
    if (el0 && el0.classList && el0.classList.contains('app-note')) {
      setAppNote(el0.dataset.note, el0.textContent.trim());
    }
  }
  function clearApps() {
    for (const k of Object.keys(apps)) delete apps[k];
    saveApps(); updateAppsCount();
    if (state.view === 'apps') renderApps();
  }
  function updateAppsCount() {
    if (el.countApps) el.countApps.textContent = Object.keys(apps).length || '';
  }

  /* F9 我的专业（本机存储） */
  function loadProfile() {
    try {
      const p = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
      if (p) { profile.major = p.major || ''; profile.majorOnly = !!p.majorOnly; }
    } catch { /* ignore */ }
  }
  function saveProfile() { try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch { /* ignore */ } }

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
    state.view = ALL_VIEWS.has(p.get('view')) ? p.get('view') : 'jobs';
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
    el.eventsPane.hidden = state.view !== 'events';
    el.docsPane.hidden = state.view !== 'docs';
    el.appsPane.hidden = state.view !== 'apps';
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
    events: ['高校宣讲会日历 · 校招信息查询', '汇总北京大学、北京航空航天大学、北京理工大学等高校就业网公开的宣讲会与招聘会信息，按时间与学校浏览。'],
    docs: ['求职资料 · 校招信息查询', '使用说明、面试题库与面经分享，帮助应届生完成校招投递准备。'],
    apps: ['我的投递 · 校招信息查询', '在收藏基础上跟踪投递进度：已收藏 → 已投递 → 笔试/面试 → Offer → 已拒，记录投递时间与备注，按截止时间排序，数据仅保存在本机浏览器。'],
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
    else if (view === 'events') await renderEvents();
    else if (view === 'docs') renderDocs();
    else if (view === 'apps') await renderApps();
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
    if (state.status.has('private') && row.ownership !== '民企') return false;
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
    // F9 只看专业匹配：输入专业后只保留有命中的岗位
    if (profile.majorOnly && !matchScore(row)) return false;
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
    const score = matchScore(row);
    const appSt = appStatusOf(row.id);
    return `<article class="job-card" data-id="${esc(row.id)}" tabindex="0">
      <div class="job-card-top">
        <span class="job-company">${highlight(row.company)}</span>
        ${row.source === 'official' ? '<span class="badge official">官网</span>' : ''}
        <span class="badge ownership">${esc(row.ownership)}</span>
        ${score ? matchBadge(score) : ''}
        ${appSt && appSt !== 'saved' ? `<span class="badge st-${appSt}">${APP_STATUS_LABELS[appSt]}</span>` : ''}
        ${row.positions.length > 1 ? `<span class="badge positions">${row.positions.length} 个岗位</span>` : ''}
        ${yearLabels ? `<span class="badge year">${esc(yearLabels)}</span>` : ''}
        <span class="deadline ${meta.cls}">${esc(meta.text)}</span>
        <button class="compare-toggle${ui.compare.has(row.id) ? ' active' : ''}" data-compare="${esc(row.id)}" aria-label="加入对比" title="加入对比">⇄</button>
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
    if (!favorites.has(id)) {
      favorites.add(id);
      // F1：收藏即建立投递记录（状态“已收藏”），记录与备注独立于收藏保留
      if (!apps[id]) { apps[id] = { status: 'saved', appliedAt: '', note: '', updatedAt: new Date().toISOString() }; saveApps(); }
      // F2：首次收藏时请求通知权限，用于截止提醒
      if (!sessionStorage.getItem('notif-asked')) { sessionStorage.setItem('notif-asked', '1'); ensureNotificationPermission(); }
    } else {
      favorites.delete(id);
    }
    saveFavorites();
    updateAppsCount();
    for (const btn of document.querySelectorAll(`.fav-btn[data-fav="${id}"]`)) {
      const active = favorites.has(id);
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
      btn.title = active ? '取消收藏' : '收藏';
    }
    if (ui.current && ui.current.id === id) syncDrawerFav();
    renderQuickFilters();
    if (state.status.has('fav')) renderResults();
    if (state.view === 'apps') renderApps();
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
      // 官网正文也已移到详情分片，所有来源统一按需加载。
      const detail = await loadDetail(tab, row.id);
      renderDrawerBody({ ...row, ...detail }, tab);
    } catch (e) {
      const msg = /Failed to fetch|NetworkError|503/.test(e.message) ? '网络请求失败，请检查网络后重试' : e.message;
      el.drawerBody.innerHTML = `<div class="empty">详情加载失败：${esc(msg)}<button class="retry-btn" type="button">重试</button></div>`;
      el.drawerBody.querySelector('.retry-btn').addEventListener('click', () => openDrawer(row, tab, { history: false }));
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
    const positions = r.positions || [];
    const POSITION_PAGE_SIZE = 50;
    const positionPageHtml = (page) => positions
      .slice(page * POSITION_PAGE_SIZE, (page + 1) * POSITION_PAGE_SIZE)
      .map((p) => `<div>· ${esc(p)}</div>`).join('');
    const positionPager = positions.length > POSITION_PAGE_SIZE
      ? `<div style="display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap">
          <button class="copy-btn" type="button" id="positionPrev">上一页</button>
          <span id="positionPage" class="muted"></span>
          <button class="copy-btn" type="button" id="positionNext">下一页</button>
        </div>`
      : '';

    el.drawerBody.innerHTML = `
      ${appStatusSectionHtml(r)}
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
        ${row('招聘岗位', positions.length ? `<div id="positionList">${positionPageHtml(0)}</div>${positionPager}` : '—')}
        ${row('工作地点', `${esc((r.cities || []).join(' / ') || '未注明')}${r.nationwide ? ' <span class="badge">含全国多地</span>' : ''}`)}
        ${row('截止时间', `${esc(r.deadline || r.deadlineText || '未注明')} <span class="deadline ${meta.cls}">${esc(meta.text)}</span>`)}
        ${row('更新时间', esc(r.updatedAt || '—'))}
        ${row('公告来源', r.sourceName ? `<a href="${esc(r.sourceUrl || '#')}" target="_blank" rel="noopener">${esc(r.sourceName)} ↗</a>` : esc(r.source || '—'))}
      </dl></section>
      ${r.note ? `<section class="detail-section"><h3>备注</h3><div class="note-box">${esc(r.note)}</div>${noteLinks ? `<div style="margin-top:8px">${noteLinks}</div>` : ''}</section>` : ''}
    `;
    if (positions.length > POSITION_PAGE_SIZE) {
      let currentPage = 0;
      const pageCount = Math.ceil(positions.length / POSITION_PAGE_SIZE);
      const updatePositions = () => {
        $('positionList').innerHTML = positionPageHtml(currentPage);
        $('positionPage').textContent = `第 ${currentPage + 1} / ${pageCount} 页 · 共 ${positions.length} 个岗位`;
        $('positionPrev').disabled = currentPage === 0;
        $('positionNext').disabled = currentPage === pageCount - 1;
      };
      $('positionPrev').addEventListener('click', () => {
        if (currentPage > 0) { currentPage -= 1; updatePositions(); }
      });
      $('positionNext').addEventListener('click', () => {
        if (currentPage < pageCount - 1) { currentPage += 1; updatePositions(); }
      });
      updatePositions();
    }
    $('copyEmail')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(r.apply.email); $('copyEmail').textContent = '已复制'; }
      catch { $('copyEmail').textContent = '复制失败，请手动选择'; }
    });
    $('exportIcs')?.addEventListener('click', () => {
      downloadFile(`${r.company}-投递截止.ics`, buildIcs(r), 'text/calendar;charset=utf-8');
    });
    // F1 投递进度区交互
    bindDrawerAppStatus(r);
    // F4/F7/F8/F10 异步加载并追加：相似推荐 / 近期宣讲会 / 面试题 / 面经
    renderDrawerExtras(r, tab);
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

  /* ---------- 宣讲会日历 ---------- */
  const EVENT_WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function eventDayLabel(date, today) {
    const d = new Date(`${date}T00:00:00`);
    const diff = Math.round((d - new Date(`${today}T00:00:00`)) / 86400000);
    const base = `${d.getMonth() + 1}月${d.getDate()}日 ${EVENT_WEEK[d.getDay()]}`;
    if (diff === 0) return `${base} · 今天`;
    if (diff === 1) return `${base} · 明天`;
    return diff > 1 ? `${base} · 还有 ${diff} 天` : base;
  }

  async function renderEvents() {
    try {
      if (!cache.events) cache.events = await loadJSON('events.json');
    } catch (err) {
      el.eventsList.innerHTML = `<div class="empty"><strong>宣讲会加载失败</strong>${esc(err.message)}</div>`;
      return;
    }
    const data = cache.events;
    const all = data.events || [];
    el.countEvents.textContent = all.length || '';
    el.eventsTotal.textContent = all.length;
    el.eventsSchools.textContent = new Set(all.map((e) => e.schoolKey)).size;
    // F7 宣讲会 ↔ 岗位联动：预加载岗位列表以统计同企业岗位数
    await Promise.all([loadTab('jobs').catch(() => {}), loadTab('internships').catch(() => {})]);

    el.eventsSchoolChips.innerHTML = '';
    const mk = (label, key, count) => chip(label, count, ui.eventSchool === key, () => {
      ui.eventSchool = ui.eventSchool === key ? '' : key;
      renderEvents();
    }, 'chip-sm');
    el.eventsSchoolChips.appendChild(mk('全部高校', '', all.length));
    for (const s of data.schools || []) {
      const n = all.filter((e) => e.schoolKey === s.key).length;
      if (n) el.eventsSchoolChips.appendChild(mk(s.name, s.key, n));
    }

    const rows = ui.eventSchool ? all.filter((e) => e.schoolKey === ui.eventSchool) : all;
    if (!rows.length) {
      el.eventsList.innerHTML = '<div class="empty">近期暂无宣讲会，秋招结束后会逐步更新。</div>';
      return;
    }
    const today = data.today || new Date().toISOString().slice(0, 10);
    const groups = new Map();
    for (const e of rows) {
      if (!groups.has(e.date)) groups.set(e.date, []);
      groups.get(e.date).push(e);
    }
    el.eventsList.innerHTML = [...groups.entries()].map(([date, list]) => `
      <section class="event-day">
        <h3>${esc(eventDayLabel(date, today))}<span>${list.length} 场</span></h3>
        <div class="event-items">
          ${list.map((e) => {
            const n = findRowsByCompany(e.company).length;
            return `<a class="event-item" href="${esc(e.url)}" target="_blank" rel="noopener">
            <div class="event-time">${esc(e.start.slice(11, 16))}${e.end ? `–${esc(e.end.slice(11, 16))}` : ''}</div>
            <div class="event-main">
              <div class="event-title">${esc(e.title)}</div>
              <div class="event-meta">${esc(e.company || '—')} · ${esc(e.place || (e.online ? '线上' : '地点待定'))}</div>
              ${n ? `<div class="event-link-badge"><button type="button" data-company="${esc(e.company)}">该企业 ${n} 个校招岗位 →</button></div>` : ''}
            </div>
            <span class="event-school">${esc(e.school)}</span>
          </a>`;
          }).join('')}
        </div>
      </section>
    `).join('');
    // F7：点击徽章跳转到岗位列表并按企业名筛选
    el.eventsList.querySelectorAll('.event-link-badge button').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        state.q = btn.dataset.company;
        el.searchInput.value = state.q;
        el.searchClear.style.display = state.q ? 'block' : 'none';
        switchView('jobs');
      });
    });
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

    // F6 今日新发布：来自 changelog 的新增记录，点击可打开岗位详情
    const addedList = (cache.changelog.added || []).slice(0, 40).map((it) => {
      const meta = it.deadline ? deadlineMeta({ deadline: it.deadline }) : { text: '', cls: '' };
      return `<div class="rec-item" data-added="${esc(it.id)}"><span>${esc(it.company)} <span class="rec-sub">${esc((it.positions || []).slice(0, 2).join('/') || '')}</span></span>${it.deadline ? `<span class="deadline ${meta.cls}">${esc(meta.text)}</span>` : ''}</div>`;
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
      ${addedList ? `<div class="dash-card" style="margin-top:16px"><h3>本次新发布岗位（${addedN} 条）<span class="section-source">点击查看详情 · 订阅 feeds.xml 可每日自动获取</span></h3><div class="rec-list">${addedList}</div></div>` : ''}
      <p class="muted dash-tip">提示：点击「即将截止」的公司可直接打开岗位详情。数据生成于 ${esc(el.lastUpdated.textContent)}。</p>
    `;
    el.dashboardPane.querySelectorAll('.cd-row').forEach((row) => {
      row.addEventListener('click', () => {
        const found = findRowById(row.dataset.id);
        if (found) openDrawer(found.row, found.tab);
      });
    });
    el.dashboardPane.querySelectorAll('.rec-item[data-added]').forEach((it) => {
      it.addEventListener('click', () => openJobById(it.dataset.added));
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

  /* ---------- 新增功能：投递 / 对比 / 推荐 / 匹配 / 面经 / 日历 / PWA ---------- */

  /* ---- F9 专业匹配 ---- */
  function majorTokens() {
    return (profile.major || '').toLowerCase().split(/[\s,，、/／]+/).filter((t) => t.length >= 2);
  }
  function matchScore(row) {
    const tokens = majorTokens();
    if (!tokens.length) return 0;
    const hay = [row.majors || '', (row.positions || []).join(' '), row.note || '', (row.industries || []).join(' '), row.sm || '']
      .join(' ').toLowerCase();
    let hit = 0;
    for (const t of tokens) if (hay.includes(t)) hit++;
    return Math.round((hit / tokens.length) * 100);
  }
  function matchBadge(score) {
    if (!score) return '';
    const cls = score >= 70 ? 'match-high' : score >= 40 ? 'match-mid' : 'match-low';
    return `<span class="badge ${cls}">匹配 ${score}%</span>`;
  }

  /* ---- F1 我的投递视图 ---- */
  async function renderApps() {
    await Promise.all([loadTab('jobs').catch(() => {}), loadTab('internships').catch(() => {})]);
    const rows = Object.keys(apps).map((id) => findRowById(id)?.row).filter(Boolean);
    const rank = (r) => { const d = daysUntil(r.deadline); if (d == null) return 2; return d < 0 ? 3 : d <= 7 ? 0 : 1; };
    rows.sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      const da = daysUntil(a.deadline), db = daysUntil(b.deadline);
      if (da != null && db != null) return da - db;
      return (b.updatedAt || '').localeCompare(a.updatedAt || '');
    });
    const counts = Object.fromEntries(APP_STATUSES.map((s) => [s.key, 0]));
    for (const r of rows) { const st = appStatusOf(r.id); if (counts[st] != null) counts[st]++; }
    if (el.appsStats) el.appsStats.innerHTML = APP_STATUSES.map((s) => `<span class="app-stat"><b>${counts[s.key]}</b>${s.label}</span>`).join('');
    if (!rows.length) {
      el.appsList.innerHTML = `<div class="empty"><strong>还没有投递记录</strong>先在「校招汇总 / 实习汇总」里收藏感兴趣的岗位，再来这里跟踪进度。<div style="margin-top:10px"><button class="copy-btn primary" id="goJobsBtn">去看看岗位</button></div></div>`;
      const g = document.getElementById('goJobsBtn');
      if (g) g.addEventListener('click', () => switchView('jobs'));
      return;
    }
    el.appsList.innerHTML = `<div class="app-list">${rows.map(appCardHtml).join('')}</div>`;
    bindAppCards();
  }
  function appCardHtml(row) {
    const st = appStatusOf(row.id);
    const rec = getApp(row.id);
    const meta = deadlineMeta(row);
    const positions = (row.positions || []).slice(0, 4).join(' / ') || '岗位详见公告';
    const statusPick = APP_STATUSES.map((s) => `<button type="button" data-status="${s.key}" class="${s.key === st ? 'active' : ''}">${s.label}</button>`).join('');
    const cityText = (row.cities || []).slice(0, 3).join('/') || (row.nationwide ? '全国多地' : '—');
    return `<div class="app-card" data-id="${esc(row.id)}" tabindex="0">
      <div class="app-card-top">
        <span class="company">${esc(row.company)}</span>
        <span class="badge ownership">${esc(row.ownership)}</span>
        ${st ? `<span class="badge st-${st}">${APP_STATUS_LABELS[st]}</span>` : ''}
        <span class="deadline ${meta.cls}">${esc(meta.text)}</span>
      </div>
      <div class="job-positions" style="margin:0">${esc(positions)}</div>
      <div class="app-card-meta">
        <span>城市 <b>${esc(cityText)}</b></span>
        <span>学历 <b>${esc((row.degree || []).join('/') || '—')}</b></span>
        ${rec?.appliedAt ? `<span>投递于 <b>${rec.appliedAt}</b></span>` : ''}
      </div>
      <div class="app-status-pick">${statusPick}</div>
      <div class="app-note" contenteditable="true" data-note="${esc(row.id)}" data-empty="${rec?.note ? 'false' : 'true'}">${esc(rec?.note || NOTE_PLACEHOLDER)}</div>
    </div>`;
  }
  function bindAppCards() {
    el.appsList.querySelectorAll('.app-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.app-status-pick') || e.target.closest('.app-note')) return;
        const found = findRowById(card.dataset.id);
        if (found) openDrawer(found.row, found.tab);
      });
      card.querySelectorAll('.app-status-pick button').forEach((btn) => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); setAppStatus(card.dataset.id, btn.dataset.status); renderApps(); });
      });
      const note = card.querySelector('.app-note');
      if (note) bindNoteField(note, note.dataset.note);
    });
  }

  /* ---- F1 详情抽屉内的投递进度区 ---- */
  function appStatusSectionHtml(r) {
    const st = appStatusOf(r.id);
    const rec = getApp(r.id);
    const pick = APP_STATUSES.map((s) => `<button type="button" class="app-pick ${s.key === st ? 'active' : ''}" data-status="${s.key}">${s.label}</button>`).join('');
    return `<section class="detail-section" style="background:#f8f9fb;border-radius:10px;padding:10px 12px">
      <h3 style="margin:0 0 6px">投递进度</h3>
      <div class="app-status-pick">${pick}</div>
      <div class="app-note" contenteditable="true" data-note="${esc(r.id)}" data-empty="${rec?.note ? 'false' : 'true'}" style="margin-top:6px">${esc(rec?.note || NOTE_PLACEHOLDER)}</div>
    </section>`;
  }
  function bindDrawerAppStatus(r) {
    el.drawerBody.querySelectorAll('.app-pick').forEach((btn) => {
      btn.addEventListener('click', () => {
        setAppStatus(r.id, btn.dataset.status);
        el.drawerBody.querySelectorAll('.app-pick').forEach((b) => b.classList.toggle('active', b.dataset.status === btn.dataset.status));
        updateAppsCount();
        if (state.view === 'apps') renderApps();
      });
    });
    const note = el.drawerBody.querySelector(`.app-note[data-note="${CSS.escape ? CSS.escape(r.id) : r.id}"]`);
    if (note) bindNoteField(note, r.id);
  }

  /* ---- F3 岗位对比 ---- */
  function toggleCompare(id) {
    if (ui.compare.has(id)) ui.compare.delete(id);
    else {
      if (ui.compare.size >= COMPARE_MAX) { toast(`最多对比 ${COMPARE_MAX} 个岗位`); return; }
      ui.compare.add(id);
    }
    renderCompareBar();
    document.querySelectorAll(`.compare-toggle[data-compare="${CSS.escape ? CSS.escape(id) : id}"]`).forEach((b) => b.classList.toggle('active', ui.compare.has(id)));
  }
  function renderCompareBar() {
    if (!el.compareBar) return;
    const n = ui.compare.size;
    el.compareBar.hidden = n === 0;
    if (el.compareCount) el.compareCount.textContent = n;
  }
  function openCompareModal() {
    if (ui.compare.size < 2) { toast('至少勾选 2 个岗位'); return; }
    const rows = [...ui.compare].map((id) => findRowById(id)?.row).filter(Boolean);
    if (rows.length < 2) { toast('请先加载岗位列表'); return; }
    const cols = Math.min(4, rows.length);
    const cells = rows.map((r) => {
      const meta = deadlineMeta(r);
      return `<div class="compare-cell">
        <h4>${esc(r.company)}</h4>
        <div class="cc-meta">
          <span>地点：${esc((r.cities || []).join(' / ') || (r.nationwide ? '全国多地' : '—'))}</span>
          <span>学历：${esc((r.degree || []).join('/') || '—')}</span>
          <span>届次：${esc((r.gradYears || []).map((y) => y + '届').join('/') || (r.gradUnlimited ? '不限届' : '—'))}</span>
          <span>行业：${esc((r.industries || []).join('/') || '—')}</span>
          <span>截止：${esc(r.deadline || r.deadlineText || '—')} · ${esc(meta.text)}</span>
          ${r.writtenTest ? '<span>有笔试</span>' : ''}
        </div>
        <div class="cc-positions">${esc((r.positions || []).slice(0, 30).join('\n') || '岗位详见公告')}</div>
        <div class="cc-actions">
          <button class="copy-btn primary" data-open="${esc(r.id)}">查看详情</button>
          <button class="copy-btn" data-rm="${esc(r.id)}">移出对比</button>
        </div>
      </div>`;
    }).join('');
    const overlay = document.createElement('div');
    overlay.className = 'compare-overlay';
    overlay.innerHTML = `<div class="compare-modal" role="dialog" aria-modal="true">
      <div class="compare-head"><h3>岗位对比（${rows.length} 个）</h3><button class="drawer-close" id="cmpClose" aria-label="关闭">×</button></div>
      <div class="compare-body"><div class="compare-grid cols-${cols}">${cells}</div></div>
    </div>`;
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    const close = () => { overlay.remove(); document.body.style.overflow = ''; };
    overlay.querySelector('#cmpClose').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => { const f = findRowById(b.dataset.open); if (f) { close(); openDrawer(f.row, f.tab); } }));
    overlay.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { toggleCompare(b.dataset.rm); close(); }));
  }

  /* ---- F4 相似推荐 + F7 宣讲会 + F8 面试题 + F10 面经（详情抽屉扩展） ---- */
  function recSectionHtml(title, rows) {
    const items = rows.map((r) => {
      const meta = deadlineMeta(r);
      return `<div class="rec-item" data-rec="${esc(r.id)}"><span>${esc(r.company)} <span class="rec-sub">${esc((r.positions || []).slice(0, 2).join('/') || '')}</span></span><span class="deadline ${meta.cls}">${esc(meta.text)}</span></div>`;
    }).join('');
    return `<section class="detail-section"><h3>${esc(title)}</h3><div class="rec-list">${items}</div></section>`;
  }
  function appendDrawerSection(html, bindFn) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    el.drawerBody.appendChild(tpl.content);
    if (bindFn) bindFn();
  }
  async function renderDrawerExtras(r, tab) {
    await Promise.all([
      loadTab('jobs').catch(() => {}), loadTab('internships').catch(() => {}),
      loadJSON('events.json').then((d) => { cache.events = d; }).catch(() => {}),
      loadJSON('questions.json').then((d) => { cache.questions = d; }).catch(() => {}),
      loadJSON('reviews.json').then((d) => { cache.reviews = d; }).catch(() => {}),
    ]);
    // 异步返回时若用户已切换到其它岗位，则放弃追加，避免内容串抽屉
    if (!ui.current || ui.current.id !== r.id) return;
    const all = allRows();

    // F4 同企业其他岗位
    const rk = companyKey(r.company);
    const sameCompany = all.filter((x) => x.id !== r.id && companyKey(x.company) && companyKey(x.company) === rk).slice(0, 6);
    // F4 相似岗位：同行业 + 同城市 + 同学历 + 同届次加权
    const sim = all.filter((x) => x.id !== r.id && companyKey(x.company) !== rk)
      .map((x) => {
        let score = 0;
        if ((r.industries || []).some((i) => x.industries.includes(i))) score += 2;
        if ((r.cities || []).some((c) => x.cities.includes(c)) || (r.nationwide && x.nationwide)) score += 2;
        if ((r.degree || []).some((d) => x.degree.includes(d))) score += 1;
        if ((r.gradYears || []).some((y) => x.gradYears.includes(y))) score += 1;
        return { x, score };
      })
      .filter((o) => o.score >= 3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((o) => o.x);

    let html = '';
    if (sameCompany.length) html += recSectionHtml('同企业其他岗位', sameCompany);
    if (sim.length) html += recSectionHtml('相似岗位推荐', sim);

    // F7 近期宣讲会（同企业）
    const evs = (cache.events?.events || []).filter((e) => companyKey(e.company) && (companyKey(e.company) === rk || e.company.includes(r.company) || r.company.includes(e.company))).slice(0, 4);
    if (evs.length) {
      const items = evs.map((e) => `<div class="rec-item" data-ev="${esc(e.url || '')}"><span>${esc(e.title)} <span class="rec-sub">${esc(e.school || '')} · ${esc(e.start ? e.start.slice(5, 16).replace('T', ' ') : e.date)}</span></span><span class="rec-sub">${esc(e.place || (e.online ? '线上' : ''))}</span></div>`).join('');
      html += `<section class="detail-section"><h3>近期宣讲会<span class="section-source">${esc(cache.events?.today ? '数据更新于 ' + cache.events.today : '')}</span></h3><div class="rec-list">${items}</div></section>`;
    }

    // F8 面试准备：题库是通用综合题，按岗位方向精选并明确标注非企业真题
    const qRec = recommendQuestions(r);
    if (qRec.list.length) {
      const trackNote = qRec.track ? `${qRec.track.key}方向` : '综合方向';
      const list = qRec.list.map((q) => `<div class="q-item"><div class="qq">${esc(q.q)}</div><div class="qa">${esc(q.a || '')}</div></div>`).join('');
      html += `<section class="detail-section"><h3>面试准备 · 通用综合题<span class="section-source">通用题库 · 非该企业真题 · ${esc(trackNote)}</span></h3>${list}</section>`;
    }

    // F10 面经 / 待遇参考
    const reviews = cache.reviews?.reviews?.[r.company] || [];
    if (reviews.length) {
      const list = reviews.map((rv) => `<div class="review-item"><div class="rv-title">${esc(rv.title)}</div>${rv.snippet ? `<div class="rv-snippet">${esc(rv.snippet)}</div>` : ''}<div class="rv-source">${esc(rv.source || cache.reviews.source || '')}</div></div>`).join('');
      html += `<section class="detail-section"><h3>面经 / 待遇参考<span class="section-source">${esc(cache.reviews?.source || '')}</span></h3>${list}</section>`;
    }

    if (html) {
      appendDrawerSection(html, () => {
        el.drawerBody.querySelectorAll('.rec-item[data-rec]').forEach((it) => {
          it.addEventListener('click', () => { const f = findRowById(it.dataset.rec); if (f) openDrawer(f.row, f.tab, { history: false }); });
        });
        el.drawerBody.querySelectorAll('.rec-item[data-ev]').forEach((it) => {
          it.addEventListener('click', () => { if (it.dataset.ev) window.open(it.dataset.ev, '_blank', 'noopener'); });
        });
      });
    }
  }
  // F8：题库只有通用综合题，按岗位方向挑类别，并用公司名做稳定偏移，避免所有公司看到同样 3 道题
  const INTERVIEW_TRACKS = [
    { key: '产品', re: /产品经理|产品专员|产品运营|产品/, cats: ['🎯 个人能力类', '🔧 问题解决类', '👥 团队合作类'] },
    { key: '设计', re: /设计|视觉|交互|美术|UI|UX/i, cats: ['🎯 个人能力类', '📚 学习成长类', '💬 其他常见问题'] },
    { key: '技术', re: /开发|研发|算法|测试|运维|数据|后端|前端|客户端|嵌入式|硬件|电子|电气|机械|结构|工艺|仿真|网络安全/i, cats: ['🔧 问题解决类', '📚 学习成长类', '🎯 个人能力类'] },
    { key: '运营', re: /运营|内容|新媒体|编辑|用户增长/, cats: ['💼 工作态度类', '👥 团队合作类', '🔧 问题解决类'] },
    { key: '市场销售', re: /市场|销售|商务|客户|渠道|营销/, cats: ['🌟 价值观念类', '🎯 个人能力类', '💬 其他常见问题'] },
    { key: '财务', re: /财务|会计|审计|税务|资金|金融|风控|理财|投资|证券|基金|银行|保险/, cats: ['💼 工作态度类', '🌟 价值观念类', '🔧 问题解决类'] },
    { key: '人力行政', re: /人力资源|人力|人事|行政|法务/, cats: ['👥 团队合作类', '💼 工作态度类', '🌟 价值观念类'] },
  ];
  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  }
  function interviewTrack(r) {
    const pos = (r.positions || []).filter(Boolean);
    if (!pos.length) return null;
    let best = null;
    let bestCount = 0;
    for (const t of INTERVIEW_TRACKS) {
      const cnt = pos.filter((p) => t.re.test(p)).length;
      if (cnt > bestCount) { bestCount = cnt; best = t; }
    }
    // 该方向岗位占比不足 35% 时视为「综合」，不给多岗位企业乱贴方向标签
    return best && bestCount / pos.length >= 0.35 ? best : null;
  }
  function recommendQuestions(r) {
    const all = cache.questions?.questions || [];
    if (!all.length) return { list: [], track: null };
    const track = interviewTrack(r);
    const cats = track ? track.cats : ['📋 基础信息类', '🚀 职业规划类', '🎯 个人能力类'];
    const byCat = new Map();
    for (const q of all) {
      if (!byCat.has(q.category)) byCat.set(q.category, []);
      byCat.get(q.category).push(q);
    }
    const seed = hashStr(String(r.company || r.id || ''));
    const list = [];
    const seen = new Set();
    cats.forEach((cat, i) => {
      const pool = byCat.get(cat) || [];
      if (!pool.length) return;
      const q = pool[(seed + i) % pool.length];
      if (q && !seen.has(q.id)) { seen.add(q.id); list.push(q); }
    });
    return { list, track };
  }

  /* ---- F11 批量日历 ICS ---- */
  function icsVEvent(row) {
    if (!row.deadline) return null;
    const [y, m, d] = row.deadline.split('-').map(Number);
    const start = `${y}${pad2(m)}${pad2(d)}`;
    const next = new Date(y, m - 1, d + 1);
    const end = `${next.getFullYear()}${pad2(next.getMonth() + 1)}${pad2(next.getDate())}`;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const desc = [...(row.positions || []).slice(0, 6), row.apply && row.apply.url].filter(Boolean).join('\n');
    return [
      'BEGIN:VEVENT',
      `UID:${row.id}@campus-jobs`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${end}`,
      `SUMMARY:${icsEsc(`${row.company} 投递截止`)}`,
      `DESCRIPTION:${icsEsc(desc)}`,
      'BEGIN:VALARM', 'TRIGGER:-P3D', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc('还有 3 天截止')}`, 'END:VALARM',
      'END:VEVENT',
    ];
  }
  function icsEsc(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;'); }
  function wrapCalendar(events, prodName) {
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//campus-jobs//${prodName}//CN`, 'CALSCALE:GREGORIAN', ...events, 'END:VCALENDAR'].join('\r\n');
  }
  function buildBulkIcs(rows, prodName) {
    const events = rows.map(icsVEvent).filter(Boolean);
    return events.length ? wrapCalendar(events, prodName) : '';
  }
  function buildEventsIcs(list) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const dt = (s) => { const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s || ''); return m ? `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}00` : ''; };
    const evs = list.flatMap((e, i) => {
      const ds = dt(e.start), de = dt(e.end);
      const lines = ['BEGIN:VEVENT', `UID:ev${i}@campus-jobs`, `DTSTAMP:${stamp}`];
      if (ds) lines.push(`DTSTART:${ds}`);
      if (de) lines.push(`DTEND:${de}`);
      lines.push(`SUMMARY:${icsEsc(e.title || '宣讲会')}`);
      lines.push(`DESCRIPTION:${icsEsc([e.company, e.place, e.school].filter(Boolean).join(' · '))}`);
      if (e.url) lines.push(`URL:${icsEsc(e.url)}`);
      lines.push('END:VEVENT');
      return lines;
    });
    return evs.length ? wrapCalendar(evs, 'EVENTS') : '';
  }
  function exportFavoriteIcs() {
    const rows = [...favorites].map((id) => findRowById(id)?.row).filter(Boolean);
    const ics = buildBulkIcs(rows, 'FAVORITES');
    if (!ics) { toast('暂无可导出的截止日期'); return; }
    downloadFile(`校招投递截止_${todayStr()}.ics`, ics, 'text/calendar;charset=utf-8');
    toast('已导出收藏岗位日历');
  }
  function exportEventsIcsFile() {
    if (!cache.events) { toast('宣讲会数据未加载'); return; }
    const ics = buildEventsIcs(cache.events.events || []);
    if (!ics) { toast('暂无可导出的宣讲会'); return; }
    downloadFile(`宣讲会日历_${todayStr()}.ics`, ics, 'text/calendar;charset=utf-8');
    toast('已导出宣讲会日历');
  }

  /* ---- F2 截止提醒 ---- */
  async function ensureNotificationPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    try { const res = await Notification.requestPermission(); return res === 'granted'; } catch { return false; }
  }
  async function checkDeadlineReminders() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    await Promise.all([loadTab('jobs').catch(() => {}), loadTab('internships').catch(() => {})]);
    const today = todayStr();
    const done = new Set(JSON.parse(sessionStorage.getItem(`notified-${today}`) || '[]'));
    const due = allRows().filter((r) => favorites.has(r.id) && !r.expired && (() => { const d = daysUntil(r.deadline); return d != null && d >= 0 && d <= 3; })());
    for (const r of due) {
      if (done.has(r.id)) continue;
      done.add(r.id);
      try { new Notification(`${r.company} 即将截止`, { body: `${daysUntil(r.deadline)} 天后截止（${r.deadline}），点击查看`, tag: r.id }); } catch { /* ignore */ }
    }
    sessionStorage.setItem(`notified-${today}`, JSON.stringify([...done]));
  }

  /* ---- F12 PWA ---- */
  async function prefetchFavoriteDetails() {
    try {
      await Promise.all([loadTab('jobs').catch(() => {}), loadTab('internships').catch(() => {})]);
      const shards = new Set();
      for (const id of favorites) shards.add(shardOf(id));
      for (const shard of shards) {
        try { await loadJSON(`jobs-detail-${shard}.json`); } catch { /* ignore */ }
        try { await loadJSON(`internships-detail-${shard}.json`); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
  function setupInstallPrompt() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      ui.deferredPrompt = e;
      if (el.installBanner && !sessionStorage.getItem('install-dismissed')) el.installBanner.hidden = false;
    });
    el.installBtn?.addEventListener('click', async () => {
      const p = ui.deferredPrompt;
      if (!p) return;
      p.prompt();
      await p.userChoice;
      ui.deferredPrompt = null;
      if (el.installBanner) el.installBanner.hidden = true;
    });
    el.installDismiss?.addEventListener('click', () => {
      sessionStorage.setItem('install-dismissed', '1');
      if (el.installBanner) el.installBanner.hidden = true;
    });
    window.addEventListener('appinstalled', () => { if (el.installBanner) el.installBanner.hidden = true; });
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
      else if (state.view === 'events') await renderEvents();
      else if (state.view === 'docs') renderDocs();
      else if (state.view === 'apps') await renderApps();
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
      const cmpBtn = e.target.closest('.compare-toggle');
      if (cmpBtn) { e.stopPropagation(); toggleCompare(cmpBtn.dataset.compare); return; }
      const favBtn = e.target.closest('.fav-btn');
      if (favBtn) { e.stopPropagation(); toggleFavorite(favBtn.dataset.fav); return; }
      const card = e.target.closest('.job-card');
      if (!card) return;
      const row = ui.filtered.find((r) => r.id === card.dataset.id);
      if (row) openDrawer(row, state.view);
    });
    el.cardList.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('.fav-btn') || e.target.closest('.compare-toggle')) return;
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

    // F5 复制当前筛选链接
    el.shareBtn?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(location.href); toast('筛选链接已复制'); }
      catch { toast('复制失败，请手动复制地址栏'); }
    });
    // F3 岗位对比栏
    el.compareOpen?.addEventListener('click', openCompareModal);
    el.compareClear?.addEventListener('click', () => {
      ui.compare.clear();
      renderCompareBar();
      document.querySelectorAll('.compare-toggle').forEach((b) => b.classList.remove('active'));
    });
    // F1 / F11 我的投递工具
    el.exportFavIcs?.addEventListener('click', exportFavoriteIcs);
    el.exportEventsIcs?.addEventListener('click', exportEventsIcsFile);
    el.clearApps?.addEventListener('click', () => { if (window.confirm('确定清空全部投递记录？此操作不可恢复。')) clearApps(); });
    // F9 我的专业
    el.majorInput?.addEventListener('input', () => {
      profile.major = el.majorInput.value; saveProfile();
      if (LIST_VIEWS.has(state.view)) renderResults();
    });
    el.majorOnly?.addEventListener('change', () => {
      profile.majorOnly = el.majorOnly.checked; saveProfile();
      if (LIST_VIEWS.has(state.view)) renderResults();
    });
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
    loadApps();
    loadProfile();
    updateAppsCount();
    // F1：刷新/关页前把正在编辑的备注落盘，避免未失焦就丢失
    window.addEventListener('beforeunload', flushActiveNote);
    if (el.majorInput) el.majorInput.value = profile.major;
    if (el.majorOnly) el.majorOnly.checked = profile.majorOnly;
    readState();
    el.searchInput.value = state.q;
    el.searchClear.style.display = state.q ? 'block' : 'none';
    el.sortSelect.value = state.sort;
    bindEvents();
    applyView();
    loadJSON('events.json')
      .then((d) => { cache.events = d; el.countEvents.textContent = (d.events || []).length || ''; })
      .catch(() => { /* 宣讲会为增量模块，失败不影响主列表 */ });

    if (LIST_VIEWS.has(state.view)) {
      try { await loadTab(state.view); renderFilters(); renderResults(); }
      catch (err) { el.cardList.innerHTML = `<div class="empty"><strong>数据加载失败</strong>${esc(err.message)}</div>`; el.loading.textContent = ''; }
    } else if (state.view === 'dashboard') await renderDashboard();
    else if (state.view === 'soe') await renderSOE();
    else if (state.view === 'events') await renderEvents();
    else if (state.view === 'docs') renderDocs();
    else if (state.view === 'apps') await renderApps();

    const jobId = new URLSearchParams(location.search).get('job');
    if (jobId) await openJobById(jobId, { history: false });

    writeState();
    loadChangelog();

    // F12 离线可用：预取已收藏岗位的详情分片，断网时也能查看收藏详情
    prefetchFavoriteDetails();
    // F2 截止提醒：对临近截止的收藏岗位弹出浏览器通知
    checkDeadlineReminders();
    // F12 PWA：监听安装提示
    setupInstallPrompt();

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
