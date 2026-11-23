// ==========================================
// サプリ管理アプリ (SuppleLog) 機能モジュール (完全版)
// ==========================================
const SUPPLE_MASTERS_KEY = 'dump_supple_masters_v1';
const SUPPLE_INTAKES_KEY = 'dump_supple_intakes_v1';
const SUPPLE_ROUTINES_KEY = 'dump_supple_routines_v1';
const SUPPLE_UPDATED_AT_KEY = 'dump_supple_updated_at';
const SUPPLE_DIRTY_KEY = 'dump_supple_dirty';
const SUPPLE_CLOUD_FOLDER = '__SYSTEM__';
const SUPPLE_CLOUD_FILE = 'supple_data';

// HTMLエスケープ関数（未定義エラーを完全防止）
function escapeHtml(str) {
  if (str == null) return '';
  if (typeof escapeHtmlText === 'function') return escapeHtmlText(str);
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const SUPPLE_PRESET_ICONS = [
  { id: 'preset_vitamin', label: 'ビタミン', emoji: '🍋', bg: '#451a03', color: '#fde047' },
  { id: 'preset_capsule', label: 'カプセル', emoji: '💊', bg: '#082f49', color: '#38bdf8' },
  { id: 'preset_tablet', label: 'タブレット', emoji: '⚪', bg: '#1e293b', color: '#cbd5e1' },
  { id: 'preset_protein', label: 'プロテイン', emoji: '🥛', bg: '#500724', color: '#f472b6' },
  { id: 'preset_fishoil', label: 'オメガ3', emoji: '🐟', bg: '#022c22', color: '#34d399' },
  { id: 'preset_herb', label: 'ハーブ', emoji: '🌿', bg: '#064e3b', color: '#6ee7b7' }
];

const SUPPLE_CATEGORIES = [
  { name: 'ビタミン', color: 'bg-amber-950/70 text-amber-300 border-amber-600/40', dot: '#f59e0b' },
  { name: 'ミネラル', color: 'bg-blue-950/70 text-blue-300 border-blue-600/40', dot: '#3b82f6' },
  { name: 'プロテイン', color: 'bg-pink-950/70 text-pink-300 border-pink-600/40', dot: '#ec4899' },
  { name: 'オメガ・脂肪酸', color: 'bg-emerald-950/70 text-emerald-300 border-emerald-600/40', dot: '#10b981' },
  { name: 'アミノ酸', color: 'bg-purple-950/70 text-purple-300 border-purple-600/40', dot: '#a855f7' },
  { name: 'その他', color: 'bg-slate-900 text-slate-300 border-slate-700', dot: '#94a3b8' }
];

const SUPPLE_DEFAULT_MASTERS = [
  { id: 'supple_1', name: 'ビタミンC 1000mg', barcode: '4987035265313', category: 'ビタミン', photo: 'preset_vitamin', dose: '1日2回 1カプセル', createdAt: new Date().toISOString() },
  { id: 'supple_2', name: 'マルチミネラル＆鉄', barcode: '4903301206132', category: 'ミネラル', photo: 'preset_tablet', dose: '1日1回 2粒', createdAt: new Date().toISOString() },
  { id: 'supple_3', name: 'オメガ3 DHA/EPA', barcode: '4987072016350', category: 'オメガ・脂肪酸', photo: 'preset_fishoil', dose: '食後 1カプセル', createdAt: new Date().toISOString() },
  { id: 'supple_4', name: 'ホエイプロテイン', barcode: '4902777323176', category: 'プロテイン', photo: 'preset_protein', dose: 'スプーン1杯（30g）', createdAt: new Date().toISOString() }
];

function getSuppleTodayStr(offsetDays = 0) {
  const d = new Date();
  if (offsetDays !== 0) d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function setSuppleSyncStatus(text, tone = 'normal') {
  const el = document.getElementById('supple-sync-status');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'text-[10px] font-bold mt-0.5 min-h-[14px] '
    + (tone === 'error' ? 'text-rose-400' : tone === 'ok' ? 'text-emerald-400' : 'text-cyan-500/80');
}

function handleSuppleStorageError(e) {
  console.warn('Supple localStorage write failed:', e);
  if (e && (e.name === 'QuotaExceededError' || String(e.message || '').toLowerCase().includes('quota'))) {
    setSuppleSyncStatus('端末容量上限: 画像が大きいか履歴が多いです', 'error');
  }
}

let suppleStoreReady = false;
let suppleCloudTimer = null;
let suppleSyncPromise = null;
let suppleLocalEditGen = 0;
let suppleDirty = false;
try { suppleDirty = localStorage.getItem(SUPPLE_DIRTY_KEY) === '1'; } catch (_) { }

function touchSuppleUpdatedAt(queueCloud = true) {
  suppleLocalEditGen++;
  suppleDirty = true;
  try {
    localStorage.setItem(SUPPLE_UPDATED_AT_KEY, new Date().toISOString());
    localStorage.setItem(SUPPLE_DIRTY_KEY, '1');
  } catch (_) { }
  if (queueCloud) queueSuppleCloudSync();
}

function clearSuppleDirty() {
  suppleDirty = false;
  try { localStorage.removeItem(SUPPLE_DIRTY_KEY); } catch (_) { }
}

function suppleLocalUpdatedAtMs() {
  try {
    const raw = localStorage.getItem(SUPPLE_UPDATED_AT_KEY);
    if (!raw) return 0;
    const ms = new Date(raw).getTime();
    return Number.isFinite(ms) ? ms : 0;
  } catch (_) {
    return 0;
  }
}

// 摂取履歴のロード：初期ダミーデータは一切入れず、ユーザーが登録したもののみ管理
function loadSuppleIntakes() {
  try {
    const d = localStorage.getItem(SUPPLE_INTAKES_KEY);
    if (d) {
      const list = JSON.parse(d);
      if (Array.isArray(list)) {
        // 過去のダミー初期データ（intake_1 〜 intake_9）があれば自動パージして消去
        return list.filter(item => item && !/^intake_[1-9]$/.test(item.id));
      }
    }
  } catch (e) { }
  return []; // 初期状態は完全に空
}

function saveSuppleIntakes(intakes, opts = {}) {
  try {
    localStorage.setItem(SUPPLE_INTAKES_KEY, JSON.stringify(intakes));
  } catch (e) {
    handleSuppleStorageError(e);
  }
  if (opts.touch !== false) touchSuppleUpdatedAt(opts.queueCloud !== false);
}

function normalizeSuppleMaster(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const stockNum = raw.stock !== '' && raw.stock != null ? Number(raw.stock) : null;
  const dailyNum = raw.dailyDose !== '' && raw.dailyDose != null ? Number(raw.dailyDose) : null;
  return {
    id: String(raw.id || ('supple_' + Date.now())),
    name: String(raw.name || '').trim(),
    barcode: String(raw.barcode || '').trim(),
    category: String(raw.category || 'その他'),
    photo: String(raw.photo || 'preset_capsule'),
    dose: String(raw.dose || ''),
    stock: (stockNum != null && Number.isFinite(stockNum) && stockNum >= 0) ? Math.round(stockNum * 100) / 100 : null,
    dailyDose: (dailyNum != null && Number.isFinite(dailyNum) && dailyNum > 0) ? Math.round(dailyNum * 100) / 100 : null,
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || ''
  };
}

function loadSuppleMasters() {
  try {
    const d = localStorage.getItem(SUPPLE_MASTERS_KEY);
    if (d) {
      const list = JSON.parse(d);
      if (Array.isArray(list)) return list.map(normalizeSuppleMaster).filter((m) => m && m.name);
    }
  } catch (e) { }
  return SUPPLE_DEFAULT_MASTERS.map(normalizeSuppleMaster);
}

function saveSuppleMasters(masters, opts = {}) {
  try {
    localStorage.setItem(SUPPLE_MASTERS_KEY, JSON.stringify(masters));
  } catch (e) {
    handleSuppleStorageError(e);
  }
  if (opts.touch !== false) touchSuppleUpdatedAt(opts.queueCloud !== false);
}

function loadSuppleRoutines() {
  try {
    const d = localStorage.getItem(SUPPLE_ROUTINES_KEY);
    if (d) {
      const list = JSON.parse(d);
      if (Array.isArray(list)) {
        return list.filter((r) => r && r.id && r.name && Array.isArray(r.items));
      }
    }
  } catch (_) { }
  return [];
}

function saveSuppleRoutines(routines, opts = {}) {
  try {
    localStorage.setItem(SUPPLE_ROUTINES_KEY, JSON.stringify(routines));
  } catch (e) {
    handleSuppleStorageError(e);
  }
  if (opts.touch !== false) touchSuppleUpdatedAt(opts.queueCloud !== false);
}

var suppleMasters = loadSuppleMasters();
var suppleIntakes = loadSuppleIntakes();
var suppleRoutines = loadSuppleRoutines();
var suppleIntakePicks = [];
var suppleChartPeriod = 7;
var suppleChartInstance = null;
var suppleHtml5QrScanner = null;
var suppleCurrentScannerTarget = 'intake';
var suppleTabInitialized = false;

async function ensureSuppleStore() {
  if (suppleStoreReady || typeof callAPI !== 'function') return;
  await callAPI('addConfigRecord', {
    folder: SUPPLE_CLOUD_FOLDER,
    file: SUPPLE_CLOUD_FILE
  }, { silent: true });
  suppleStoreReady = true;
}

function parseCloudSuppleSnapshot(row) {
  if (!row || row.content == null) return null;
  try {
    const payload = JSON.parse(row.content);
    if (!payload || !Array.isArray(payload.masters) || !Array.isArray(payload.intakes)) return null;
    const updatedAt = new Date(payload.updatedAt || 0).getTime();
    if (!Number.isFinite(updatedAt)) return null;
    return {
      cloudId: row.id != null ? String(row.id) : '',
      masters: payload.masters.map(normalizeSuppleMaster).filter((m) => m && m.name),
      intakes: payload.intakes.filter((i) => i && i.id && i.suppleId && i.date),
      routines: Array.isArray(payload.routines)
        ? payload.routines.filter((r) => r && r.id && r.name && Array.isArray(r.items))
        : [],
      updatedAt,
      updatedAtIso: new Date(updatedAt).toISOString()
    };
  } catch (_) {
    return null;
  }
}

async function fetchCloudSuppleSnapshot() {
  if (typeof callAPI !== 'function') return null;
  const items = await callAPI('getFolderFileItems', {
    folder: SUPPLE_CLOUD_FOLDER,
    file: SUPPLE_CLOUD_FILE
  }, { silent: true });
  if (!Array.isArray(items) || !items.length) return null;
  const parsed = items.map(parseCloudSuppleSnapshot).filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (!parsed.length) return null;
  parsed[0].extraIds = parsed.slice(1).map((p) => p.cloudId).filter(Boolean);
  return parsed[0];
}

function applySuppleDataFromCloud(snap) {
  if (!snap) return false;
  suppleMasters = snap.masters;
  suppleIntakes = snap.intakes;
  suppleRoutines = snap.routines || [];
  saveSuppleMasters(suppleMasters, { touch: false, queueCloud: false });
  saveSuppleIntakes(suppleIntakes, { touch: false, queueCloud: false });
  saveSuppleRoutines(suppleRoutines, { touch: false, queueCloud: false });
  try {
    if (snap.updatedAtIso) localStorage.setItem(SUPPLE_UPDATED_AT_KEY, snap.updatedAtIso);
  } catch (_) { }
  clearSuppleDirty();
  return true;
}

async function publishSuppleData(prefetched) {
  if (typeof callAPI !== 'function') return;
  await ensureSuppleStore();
  let localUpdatedAt = suppleLocalUpdatedAtMs();
  if (!localUpdatedAt) {
    const nowIso = new Date().toISOString();
    try { localStorage.setItem(SUPPLE_UPDATED_AT_KEY, nowIso); } catch (_) { }
    localUpdatedAt = new Date(nowIso).getTime();
  }
  const existing = prefetched === undefined ? await fetchCloudSuppleSnapshot() : prefetched;
  if (existing && existing.updatedAt > localUpdatedAt && !suppleDirty) {
    if (applySuppleDataFromCloud(existing)) renderSuppleAll();
    return;
  }
  const updatedAt = new Date(Math.max(localUpdatedAt, Date.now())).toISOString();
  try { localStorage.setItem(SUPPLE_UPDATED_AT_KEY, updatedAt); } catch (_) { }
  const payload = JSON.stringify({
    v: 1,
    updatedAt,
    masters: suppleMasters,
    intakes: suppleIntakes,
    routines: suppleRoutines
  });
  if (typeof upsertSystemSnapshotRecord === 'function') {
    await upsertSystemSnapshotRecord({
      cloudId: existing && existing.cloudId,
      extraIds: existing && existing.extraIds,
      folder: SUPPLE_CLOUD_FOLDER,
      file: SUPPLE_CLOUD_FILE,
      content: payload
    });
  } else {
    const res = await callAPI('addDataRecord', {
      folder: SUPPLE_CLOUD_FOLDER,
      file: SUPPLE_CLOUD_FILE,
      content: payload
    }, { silent: true });
    if (!res || !res.success) throw new Error('supple_sync_failed');
  }
  clearSuppleDirty();
}

function queueSuppleCloudSync() {
  if (suppleCloudTimer) clearTimeout(suppleCloudTimer);
  setSuppleSyncStatus('保存中…');
  suppleCloudTimer = setTimeout(() => {
    publishSuppleData()
      .then(() => {
        const t = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
        setSuppleSyncStatus('同期済み ' + t, 'ok');
      })
      .catch(() => {
        setSuppleSyncStatus('オフライン（端末に保存済み）', 'error');
      });
  }, 350);
}

async function syncSuppleData(options = {}) {
  if (typeof callAPI !== 'function') return null;
  const wantRender = options.render !== false;
  if (suppleSyncPromise) {
    try { await suppleSyncPromise; } catch (_) { }
    if (wantRender) renderSuppleAll();
    return;
  }
  if (wantRender) setSuppleSyncStatus('同期中…');
  suppleSyncPromise = (async () => {
    const startGen = suppleLocalEditGen;
    let cloud = null;
    try { cloud = await fetchCloudSuppleSnapshot(); } catch (_) { cloud = null; }
    const editedDuringFetch = suppleLocalEditGen !== startGen;
    const localUpdatedAt = suppleLocalUpdatedAtMs();
    if (suppleDirty || editedDuringFetch) {
      await publishSuppleData(cloud);
    } else if (cloud && (!localUpdatedAt || cloud.updatedAt > localUpdatedAt)) {
      if (applySuppleDataFromCloud(cloud) && wantRender) renderSuppleAll();
    } else if (!cloud && (suppleIntakes.length || suppleRoutines.length || localUpdatedAt > 0)) {
      await publishSuppleData(null);
    }
    const t = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    setSuppleSyncStatus('同期済み ' + t, 'ok');
  })();
  try {
    await suppleSyncPromise;
  } catch (e) {
    setSuppleSyncStatus('オフライン（端末のみ）', 'error');
  } finally {
    suppleSyncPromise = null;
  }
}

async function uploadSuppleMasterPhotoToDrive(masterId, dataUrl) {
  if (!masterId || !dataUrl || !dataUrl.startsWith('data:image/')) return;
  if (typeof uploadDumpImagePayload !== 'function') return;
  try {
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/i);
    if (!m) return;
    const mime = m[1] || 'image/jpeg';
    const rawB64 = m[2];
    const url = await uploadDumpImagePayload(rawB64, mime, null, 1, 1);
    if (!url || !url.startsWith('http')) return;
    const target = suppleMasters.find((item) => item.id === masterId);
    if (!target || target.photo !== dataUrl) return;
    target.photo = url;
    saveSuppleMasters(suppleMasters);
    renderSuppleAll();
  } catch (e) {
    console.warn('Supple photo Drive upload skipped/failed:', e);
  }
}

function syncSuppleFabVisibility() {
  const fab = document.getElementById('supple-fab-add');
  const suppleTab = document.getElementById('supplement-mode');
  const isSuppleActive = !!(suppleTab && suppleTab.classList.contains('active'));
  const anyModalOpen = ['modal-supple-intake', 'modal-supple-master', 'modal-supple-scanner'].some((id) => {
    const el = document.getElementById(id);
    return el && !el.classList.contains('hidden');
  });
  document.documentElement.classList.toggle('supple-modal-open', anyModalOpen);
  document.body.classList.toggle('supple-modal-open', anyModalOpen);
  if (fab) {
    fab.style.setProperty('display', (isSuppleActive && !anyModalOpen) ? 'flex' : 'none', 'important');
  }
}

function initSupplementTab() {
  syncSuppleFabVisibility();
  const _syncBtn = document.getElementById('cross-device-sync-btn');
  if (_syncBtn) _syncBtn.style.setProperty('display', 'none', 'important');

  if (!suppleTabInitialized) {
    initSuppleCategorySelector();
    initSupplePresetIcons();
    suppleTabInitialized = true;
  }
  const today = new Date();
  const badge = document.getElementById('supple-today-badge');
  if (badge) {
    badge.textContent = today.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric', weekday: 'short' });
  }
  renderSuppleAll();
  syncSuppleData({ render: true }).catch(() => { });
}

function renderSuppleAll() {
  renderSuppleLowStockBanner();
  renderSuppleSummary();
  renderSuppleChart();
  renderSuppleRoutines();
  renderSuppleMasterList();
  renderSuppleHistory();
  renderSuppleDropdownList();
}

function setSuppleChartPeriod(days) {
  suppleChartPeriod = days;
  const btn7 = document.getElementById('supple-btn-period-7');
  const btn30 = document.getElementById('supple-btn-period-30');
  if (btn7 && btn30) {
    if (days === 7) {
      btn7.className = "px-2.5 py-1 rounded-lg bg-cyan-900/60 text-cyan-200 shadow-xs transition-all";
      btn30.className = "px-2.5 py-1 rounded-lg text-slate-400 hover:text-slate-200 transition-all";
    } else {
      btn30.className = "px-2.5 py-1 rounded-lg bg-cyan-900/60 text-cyan-200 shadow-xs transition-all";
      btn7.className = "px-2.5 py-1 rounded-lg text-slate-400 hover:text-slate-200 transition-all";
    }
  }
  renderSuppleChart();
}

function renderSuppleSummary() {
  const todayStr = getSuppleTodayStr(0);
  const todayCount = suppleIntakes.filter(i => i.date === todayStr).length;
  const weekStartStr = getSuppleTodayStr(-6);
  const weekCount = suppleIntakes.filter(i => i.date && i.date >= weekStartStr && i.date <= todayStr).length;

  const elToday = document.getElementById('supple-stat-today');
  const elWeek = document.getElementById('supple-stat-week');
  const elCount = document.getElementById('supple-stat-count');
  const elHistCount = document.getElementById('supple-history-count');

  if (elToday) elToday.innerHTML = todayCount + '<span class="text-[10px] font-normal text-slate-400 ml-0.5">回</span>';
  if (elWeek) elWeek.innerHTML = weekCount + '<span class="text-[10px] font-normal text-slate-400 ml-0.5">回</span>';
  if (elCount) elCount.innerHTML = suppleMasters.length + '<span class="text-[10px] font-normal text-slate-400 ml-0.5">種</span>';
  if (elHistCount) elHistCount.textContent = '全 ' + suppleIntakes.length + ' 件';
}

function getSuppleChartPalette() {
  const theme = (document.documentElement && document.documentElement.dataset && document.documentElement.dataset.theme) || 'dark';
  if (theme === 'light') {
    return {
      line: '#059669',
      fillTop: 'rgba(16, 185, 129, 0.32)',
      fillBottom: 'rgba(16, 185, 129, 0.0)',
      pointBorder: '#ffffff',
      tick: '#475569',
      grid: 'rgba(148, 163, 184, 0.35)',
      tooltipBg: '#0f172a',
      tooltipText: '#f8fafc'
    };
  }
  if (theme === 'soft') {
    return {
      line: '#eab308',
      fillTop: 'rgba(234, 179, 8, 0.35)',
      fillBottom: 'rgba(234, 179, 8, 0.0)',
      pointBorder: '#231d17',
      tick: '#cbb89a',
      grid: 'rgba(219, 177, 110, 0.2)',
      tooltipBg: '#17130f',
      tooltipText: '#f6ead8'
    };
  }
  if (theme === 'soft-light') {
    return {
      line: '#0f766e',
      fillTop: 'rgba(15, 118, 110, 0.28)',
      fillBottom: 'rgba(15, 118, 110, 0.0)',
      pointBorder: '#f7f3ec',
      tick: '#6b5d4d',
      grid: 'rgba(154, 107, 47, 0.22)',
      tooltipBg: '#3d3429',
      tooltipText: '#f7f3ec'
    };
  }
  return {
    line: '#10b981',
    fillTop: 'rgba(16, 185, 129, 0.45)',
    fillBottom: 'rgba(16, 185, 129, 0.0)',
    pointBorder: '#0b1021',
    tick: '#64748b',
    grid: 'rgba(51, 65, 85, 0.25)',
    tooltipBg: '#02040a',
    tooltipText: '#f8fafc'
  };
}

function renderSuppleChart() {
  const canvas = document.getElementById('suppleIntakeChart');
  if (!canvas) return;
  if (typeof Chart === 'undefined') {
    if (typeof window.__ensureExternalScript === 'function') {
      window.__ensureExternalScript('https://cdn.jsdelivr.net/npm/chart.js', () => typeof Chart !== 'undefined')
        .then((ok) => { if (ok) renderSuppleChart(); });
    }
    return;
  }
  const ctx = canvas.getContext('2d');
  const palette = getSuppleChartPalette();
  const dates = [];
  const counts = [];

  for (let i = suppleChartPeriod - 1; i >= 0; i--) {
    const dateStr = getSuppleTodayStr(-i);
    const d = new Date();
    d.setDate(d.getDate() - i);
    const label = suppleChartPeriod === 7
      ? (d.getMonth() + 1) + '/' + d.getDate() + ' (' + ['日', '月', '火', '水', '木', '金', '土'][d.getDay()] + ')'
      : (d.getMonth() + 1) + '/' + d.getDate();
    dates.push(label);
    counts.push(suppleIntakes.filter(item => item.date === dateStr).length);
  }

  if (suppleChartInstance) {
    suppleChartInstance.destroy();
  }

  const gradient = ctx.createLinearGradient(0, 0, 0, 180);
  gradient.addColorStop(0, palette.fillTop);
  gradient.addColorStop(1, palette.fillBottom);

  suppleChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: dates,
      datasets: [{
        label: '摂取回数',
        data: counts,
        fill: true,
        backgroundColor: gradient,
        borderColor: palette.line,
        borderWidth: 2.5,
        pointBackgroundColor: palette.line,
        pointBorderColor: palette.pointBorder,
        pointBorderWidth: 2,
        pointRadius: suppleChartPeriod === 7 ? 4.5 : 3,
        tension: 0.35
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: palette.tooltipBg,
          titleColor: palette.tooltipText,
          bodyColor: palette.tooltipText,
          titleFont: { size: 11, weight: 'bold' },
          bodyFont: { size: 12 },
          padding: 8,
          cornerRadius: 10,
          displayColors: false,
          callbacks: {
            label: (c) => '摂取回数: ' + c.raw + ' 回'
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 9, weight: '600' }, color: palette.tick, maxRotation: 0, autoSkip: true, maxTicksLimit: suppleChartPeriod === 7 ? 7 : 8 }
        },
        y: {
          beginAtZero: true,
          suggestedMax: 4,
          ticks: { stepSize: 1, font: { size: 9 }, color: palette.tick },
          grid: { color: palette.grid, borderDash: [3, 3] }
        }
      }
    }
  });
}

function adjustSuppleStock(suppleId, delta) {
  const m = suppleMasters.find((item) => item.id === suppleId);
  if (!m || typeof m.stock !== 'number' || !Number.isFinite(m.stock)) return false;
  m.stock = Math.max(0, Math.round((m.stock + delta) * 100) / 100);
  m.updatedAt = new Date().toISOString();
  return true;
}

function getSuppleLowStockAlerts() {
  const alerts = [];
  suppleMasters.forEach((m) => {
    if (typeof m.stock !== 'number' || !Number.isFinite(m.stock)) return;
    const daily = typeof m.dailyDose === 'number' && m.dailyDose > 0 ? m.dailyDose : 0;
    const daysLeft = daily > 0 ? Math.floor(m.stock / daily) : null;
    if (m.stock <= 0 || (daysLeft !== null ? daysLeft <= 7 : m.stock <= 5)) {
      alerts.push({ master: m, stock: m.stock, daysLeft });
    }
  });
  return alerts;
}

function renderSuppleLowStockBanner() {
  const banner = document.getElementById('supple-low-stock-banner');
  const list = document.getElementById('supple-low-stock-list');
  if (!banner || !list) return;
  const alerts = getSuppleLowStockAlerts();
  if (!alerts.length) {
    banner.classList.add('hidden');
    list.innerHTML = '';
    return;
  }
  banner.classList.remove('hidden');
  list.innerHTML = alerts.map((a) => {
    const detail = a.stock <= 0
      ? '在庫切れ（残 0）'
      : (a.daysLeft != null ? `残り約 ${a.daysLeft} 日分（残 ${a.stock}）` : `残 ${a.stock}`);
    return `<div class="flex items-center justify-between gap-2">
      <span class="truncate">• ${escapeHtml(a.master.name)}: ${escapeHtml(detail)}</span>
      <button type="button" onclick="openSuppleMasterModal('${escapeHtml(a.master.id)}')"
        class="shrink-0 text-[10px] font-extrabold text-amber-200 underline">編集/補充</button>
    </div>`;
  }).join('');
}

function replenishSuppleStock(suppleId, amount, ev) {
  if (ev) ev.stopPropagation();
  const m = suppleMasters.find((item) => item.id === suppleId);
  if (!m) return;
  const cur = typeof m.stock === 'number' && Number.isFinite(m.stock) ? m.stock : 0;
  m.stock = Math.max(0, Math.round((cur + amount) * 100) / 100);
  m.updatedAt = new Date().toISOString();
  saveSuppleMasters(suppleMasters);
  renderSuppleAll();
}

function renderSuppleMasterList() {
  const container = document.getElementById('supple-master-list-container');
  const badge = document.getElementById('supple-master-list-badge');
  if (badge) badge.textContent = suppleMasters.length + '種';
  if (!container) return;
  if (!suppleMasters.length) {
    container.innerHTML = '<div class="text-xs text-slate-500 text-center py-3">登録されたサプリはまだありません</div>';
    return;
  }
  container.innerHTML = suppleMasters.map((m) => {
    const thumb = getSupplePhotoThumbHtml(m.photo, 28);
    const cat = SUPPLE_CATEGORIES.find(c => c.name === m.category) || SUPPLE_CATEGORIES[5];
    const hasStock = typeof m.stock === 'number' && Number.isFinite(m.stock);
    const daysLeft = hasStock && m.dailyDose > 0 ? Math.floor(m.stock / m.dailyDose) : null;
    const stockBadge = hasStock
      ? `<span class="text-[10px] font-extrabold px-1.5 py-0.5 rounded-md border ${m.stock <= 0 || (daysLeft != null && daysLeft <= 7) ? 'bg-amber-950/60 border-amber-600/50 text-amber-200' : 'bg-slate-800/80 border-slate-700 text-cyan-200'}">残 ${m.stock}${daysLeft != null ? ` (約${daysLeft}日)` : ''}</span>`
      : '';
    return `
      <div class="flex items-center justify-between gap-2 p-2.5 rounded-2xl bg-black/30 border border-cyan-900/40">
        <div class="flex items-center gap-2.5 min-w-0">
          ${thumb}
          <div class="min-w-0">
            <div class="text-xs font-extrabold text-slate-100 truncate">${escapeHtml(m.name)}</div>
            <div class="flex flex-wrap items-center gap-1 mt-0.5">
              <span class="text-[9px] font-semibold px-1.5 py-0.2 rounded-md ${cat.color}">${escapeHtml(m.category)}</span>
              ${stockBadge}
              ${m.dose ? `<span class="text-[9px] text-slate-400 truncate">${escapeHtml(m.dose)}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button type="button" onclick="replenishSuppleStock('${escapeHtml(m.id)}', 30, event)"
            class="px-2 py-1 rounded-lg bg-emerald-950/50 border border-emerald-700/50 text-emerald-300 text-[10px] font-extrabold hover:bg-emerald-900/50"
            title="残数を+30補充">+30</button>
          <button type="button" onclick="openSuppleMasterModal('${escapeHtml(m.id)}')"
            class="w-7 h-7 rounded-lg bg-slate-800/80 text-cyan-300 hover:bg-slate-700 text-xs font-bold"
            title="編集">✎</button>
          <button type="button" onclick="deleteSuppleMasterFromPicker('${escapeHtml(m.id)}', event)"
            class="w-7 h-7 rounded-lg text-rose-400 hover:text-rose-200 hover:bg-rose-950/50 text-xs"
            title="削除">🗑</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderSuppleRoutines() {
  const container = document.getElementById('supple-routines-list');
  if (container) {
    if (!suppleRoutines.length) {
      container.innerHTML = '<p class="text-[11px] text-slate-400 font-medium">よく飲む組み合わせを「＋ 選んで作成」→「⭐ この選択をセット保存」で登録できます</p>';
    } else {
      container.innerHTML = suppleRoutines.map((r) => {
        const names = (r.items || []).map((it) => {
          const m = suppleMasters.find((x) => x.id === it.suppleId);
          return m ? m.name + (it.qty > 1 ? '×' + it.qty : '') : '';
        }).filter(Boolean).join(' / ');
        return `
      <div class="inline-flex items-center gap-1 rounded-2xl bg-slate-900/85 border border-cyan-800/60 pl-3 pr-1.5 py-1.5 max-w-full">
        <button type="button" onclick="runSuppleRoutine('${escapeHtml(r.id)}')" class="text-left min-w-0 active:scale-95 transition">
          <span class="block text-xs font-extrabold text-cyan-100">⚡ ${escapeHtml(r.name)} <span class="text-[10px] text-emerald-300 font-bold">(${escapeHtml(r.timing || '随時')})</span></span>
          ${names ? `<span class="block text-[9px] text-slate-400 truncate max-w-[200px]">${escapeHtml(names)}</span>` : ''}
        </button>
        <button type="button" onclick="deleteSuppleRoutine('${escapeHtml(r.id)}', event)"
          class="w-6 h-6 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-slate-800 text-[11px] shrink-0"
          title="セットを削除" aria-label="セットを削除">✕</button>
      </div>
    `;
      }).join('');
    }
  }
  renderSuppleIntakeRoutines();
}

function renderSuppleIntakeRoutines() {
  const wrap = document.getElementById('supple-intake-routines-wrap');
  const listEl = document.getElementById('supple-intake-routines-list');
  if (!wrap || !listEl) return;
  if (!suppleRoutines.length) {
    wrap.classList.add('hidden');
    listEl.innerHTML = '';
    return;
  }
  wrap.classList.remove('hidden');
  listEl.innerHTML = suppleRoutines.map((r) => {
    const validCount = (r.items || []).filter((it) => suppleMasters.some((m) => m.id === it.suppleId)).length;
    const names = (r.items || []).map((it) => {
      const m = suppleMasters.find((x) => x.id === it.suppleId);
      return m ? m.name + (it.qty > 1 ? '×' + it.qty : '') : '';
    }).filter(Boolean).join(' / ');
    return `
      <div class="inline-flex items-center gap-1 rounded-xl bg-amber-950/45 border border-amber-600/50 pl-3 pr-1.5 py-1.5 max-w-full">
        <button type="button" onclick="applySuppleRoutineToIntakePicker('${escapeHtml(r.id)}')"
          class="text-left min-w-0 text-amber-100 hover:text-white transition active:scale-95">
          <span class="block text-xs font-extrabold">⚡ ${escapeHtml(r.name)} <span class="text-[10px] text-emerald-300 font-bold">(${escapeHtml(r.timing || '随時')}${validCount ? '・' + validCount + '種' : ''})</span></span>
          ${names ? `<span class="block text-[9px] text-amber-200/75 truncate max-w-[200px]">${escapeHtml(names)}</span>` : ''}
        </button>
        <button type="button" onclick="deleteSuppleRoutine('${escapeHtml(r.id)}', event)"
          class="w-6 h-6 rounded-lg text-amber-300/70 hover:text-rose-400 hover:bg-slate-800/80 text-[11px] shrink-0"
          title="セットを削除" aria-label="セットを削除">✕</button>
      </div>
    `;
  }).join('');
}

function applySuppleRoutineToIntakePicker(routineId) {
  const r = suppleRoutines.find((item) => item.id === routineId);
  if (!r) return;
  const validItems = (r.items || []).filter((it) => suppleMasters.some((m) => m.id === it.suppleId));
  if (!validItems.length) {
    alert('このセットに含まれるサプリが見つかりませんでした');
    return;
  }
  suppleIntakePicks = validItems.map((it) => ({
    id: it.suppleId,
    qty: Math.max(1, Math.min(99, parseInt(it.qty, 10) || 1))
  }));
  const timingEl = document.getElementById('supple-input-timing');
  if (timingEl && r.timing && Array.from(timingEl.options).some((o) => o.value === r.timing)) {
    timingEl.value = r.timing;
  }
  renderSuppleDropdownList();
}

function saveCurrentSuppleRoutine() {
  const picks = currentSuppleIntakePicks();
  if (!picks.length) {
    alert('セットにするサプリを1つ以上選択してください');
    return;
  }
  const timingEl = document.getElementById('supple-input-timing');
  const timing = timingEl ? timingEl.value : '夜';
  const defaultName = timing + 'セット';
  const name = prompt('クイックセットの名前を入力してください:', defaultName);
  if (!name || !name.trim()) return;
  const routine = {
    id: 'routine_' + Date.now(),
    name: name.trim().slice(0, 40),
    timing,
    items: picks.map((p) => ({ suppleId: p.id, qty: p.qty })),
    createdAt: new Date().toISOString()
  };
  suppleRoutines.push(routine);
  saveSuppleRoutines(suppleRoutines);
  renderSuppleRoutines();
  alert('「' + routine.name + '」をクイックセットに保存しました');
}

function runSuppleRoutine(routineId) {
  const r = suppleRoutines.find((item) => item.id === routineId);
  if (!r) return;
  const validItems = (r.items || []).filter((it) => suppleMasters.some((m) => m.id === it.suppleId));
  if (!validItems.length) {
    alert('このセットに含まれるサプリが見つかりませんでした');
    return;
  }
  const itemLines = validItems.map((it) => {
    const m = suppleMasters.find((x) => x.id === it.suppleId);
    const qty = Math.max(1, parseInt(it.qty, 10) || 1);
    return '・' + (m ? m.name : '不明') + ' × ' + qty;
  }).join('\n');
  const timingLabel = r.timing || '随時';
  if (!confirm('クイックセット「' + r.name + '」（' + timingLabel + '）を記録しますか？\n\n' + itemLines)) {
    return;
  }
  const today = getSuppleTodayStr(0);
  const now = Date.now();
  let stockUpdated = false;
  validItems.forEach((it, i) => {
    const qty = Math.max(1, parseInt(it.qty, 10) || 1);
    suppleIntakes.push({
      id: 'intake_' + now + '_' + i,
      date: today,
      suppleId: it.suppleId,
      qty,
      timing: r.timing || '随時',
      note: '⚡ ' + r.name,
      createdAt: new Date().toISOString()
    });
    if (adjustSuppleStock(it.suppleId, -qty)) stockUpdated = true;
  });
  if (stockUpdated) saveSuppleMasters(suppleMasters, { queueCloud: false });
  saveSuppleIntakes(suppleIntakes);
  renderSuppleAll();
  setSuppleSyncStatus('⚡ 「' + r.name + '」を記録しました（' + validItems.length + '種）', 'ok');
}

function deleteSuppleRoutine(routineId, ev) {
  if (ev) ev.stopPropagation();
  const r = suppleRoutines.find((item) => item.id === routineId);
  if (!r) return;
  if (!confirm('クイックセット「' + r.name + '」を削除しますか？')) return;
  suppleRoutines = suppleRoutines.filter((item) => item.id !== routineId);
  saveSuppleRoutines(suppleRoutines);
  renderSuppleRoutines();
}

// 摂取履歴の描画（編集・削除ボタン付き）
function renderSuppleHistory() {
  const container = document.getElementById('supple-history-container');
  if (!container) return;
  container.innerHTML = '';

  if (suppleIntakes.length === 0) {
    container.innerHTML = `
      <div class="bg-[#0b1021]/60 rounded-3xl p-6 text-center border border-cyan-900/30">
        <p class="text-xs font-bold text-slate-300">まだ摂取記録がありません</p>
        <p class="text-[11px] text-slate-500 mt-1">右下の「＋」ボタンから今日のサプリを記録しましょう</p>
      </div>
    `;
    return;
  }

  const grouped = {};
  const sorted = [...suppleIntakes].sort((a, b) => new Date(b.date) - new Date(a.date) || new Date(b.createdAt) - new Date(a.createdAt));
  sorted.forEach(item => {
    if (!grouped[item.date]) grouped[item.date] = [];
    grouped[item.date].push(item);
  });

  const todayStr = getSuppleTodayStr(0);
  const yesterdayStr = getSuppleTodayStr(-1);

  Object.keys(grouped).forEach(dateStr => {
    const items = grouped[dateStr];
    const dateObj = new Date(dateStr + 'T00:00:00');
    const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
    const dayOfWeek = dayNames[dateObj.getDay()];

    let dateLabel = (dateObj.getMonth() + 1) + '月' + dateObj.getDate() + '日 (' + dayOfWeek + ')';
    let badgeHtml = '';
    if (dateStr === todayStr) {
      badgeHtml = '<span class="text-[9px] font-extrabold px-1.5 py-0.2 rounded-sm bg-emerald-500 text-white">今日</span>';
    } else if (dateStr === yesterdayStr) {
      badgeHtml = '<span class="text-[9px] font-semibold px-1.5 py-0.2 rounded-sm bg-slate-800 text-slate-300">昨日</span>';
    }

    const dateGroupEl = document.createElement('div');
    dateGroupEl.className = 'bg-[#0b1021]/80 rounded-2xl p-3 sm:p-4 border border-cyan-900/40 space-y-2';
    dateGroupEl.innerHTML = `
      <div class="flex items-center justify-between pb-1.5 border-b border-cyan-950">
        <div class="flex items-center gap-2">
          <span class="font-extrabold text-cyan-50 text-xs sm:text-sm">${dateLabel}</span>
          ${badgeHtml}
        </div>
        <span class="text-[10px] font-semibold text-slate-400">${items.length} 回</span>
      </div>
      <div class="flex flex-wrap gap-2 pt-1" data-supple-chips="1"></div>
    `;

    container.appendChild(dateGroupEl);
    const chipsContainer = dateGroupEl.querySelector('[data-supple-chips]');

    items.forEach(item => {
      const s = suppleMasters.find(m => m.id === item.suppleId) || { name: '削除されたサプリ', category: 'その他', photo: 'preset_capsule' };
      const chip = document.createElement('div');
      chip.className = 'group inline-flex items-center gap-2 pl-2 pr-1.5 py-1 rounded-xl bg-slate-900/90 border border-cyan-900/50 hover:border-cyan-500 transition-all text-xs';

      const thumb = getSupplePhotoThumbHtml(s.photo, 22);
      const cat = SUPPLE_CATEGORIES.find(c => c.name === s.category) || SUPPLE_CATEGORIES[5];

      chip.innerHTML = `
        <div class="flex items-center gap-2 cursor-pointer" onclick="openSuppleEditModal('${escapeHtml(item.id)}')" title="クリックして編集">
          ${thumb}
          <div class="flex flex-col text-left">
            <div class="flex items-center gap-1">
              <span class="font-bold text-slate-100 hover:text-cyan-300 transition-colors">${escapeHtml(s.name)}</span>
              <span class="w-1.5 h-1.5 rounded-full" style="background-color: ${cat.dot};"></span>
            </div>
            <span class="text-[9px] text-slate-400">${intakeQtyOf(item)}個${item.timing ? '・' + escapeHtml(item.timing) : ''}${item.note ? '・' + escapeHtml(item.note) : ''}</span>
          </div>
        </div>
        <!-- アクションボタン（編集 ＆ 削除） -->
        <div class="flex items-center gap-0.5 ml-1 pl-1 border-l border-slate-800">
          <button type="button" onclick="openSuppleEditModal('${escapeHtml(item.id)}', event)" class="p-1 rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-slate-800 text-xs transition" title="この記録を編集">✎</button>
          <button type="button" onclick="deleteSuppleIntake('${escapeHtml(item.id)}', event)" class="p-1 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-slate-800 text-xs transition" title="この記録を削除">✕</button>
        </div>
      `;
      chipsContainer.appendChild(chip);
    });
  });
}

function getSupplePhotoThumbHtml(photoRef, size = 26) {
  if (!photoRef) {
    return '<div class="rounded-lg bg-slate-800 flex items-center justify-center text-xs" style="width:' + size + 'px;height:' + size + 'px;">💊</div>';
  }
  if (photoRef.startsWith('data:image') || photoRef.startsWith('http://') || photoRef.startsWith('https://')) {
    return '<img src="' + escapeHtml(photoRef) + '" class="rounded-lg object-cover border border-cyan-800 shrink-0" style="width:' + size + 'px;height:' + size + 'px;" />';
  }
  const preset = SUPPLE_PRESET_ICONS.find(p => p.id === photoRef) || SUPPLE_PRESET_ICONS[1];
  return '<div class="rounded-lg flex items-center justify-center shrink-0 text-xs border border-white/10" style="width:' + size + 'px;height:' + size + 'px;background-color:' + preset.bg + ';color:' + preset.color + ';">' + preset.emoji + '</div>';
}

// ◯ 摂取記録の削除
function deleteSuppleIntake(id, ev) {
  if (ev) ev.stopPropagation();
  const target = suppleIntakes.find(i => i.id === id);
  const s = target ? suppleMasters.find(m => m.id === target.suppleId) : null;
  const label = s ? '「' + s.name + '」の' : '';
  if (!confirm(label + '摂取記録を削除しますか？')) return false;
  if (target && adjustSuppleStock(target.suppleId, intakeQtyOf(target))) {
    saveSuppleMasters(suppleMasters, { queueCloud: false });
  }
  suppleIntakes = suppleIntakes.filter(i => i.id !== id);
  saveSuppleIntakes(suppleIntakes);
  renderSuppleAll();
  return true;
}

// ◯ 摂取したサプリ 新規登録モーダルを開く
function intakeQtyOf(item) {
  const n = parseInt(item && item.qty, 10);
  return n > 0 ? n : 1;
}

function setSuppleSubmitLabel(label) {
  const el = document.getElementById('supple-btn-submit-intake');
  if (el) el.textContent = label;
}

function openSuppleIntakeModal() {
  document.getElementById('supple-edit-intake-id').value = '';
  document.getElementById('supple-modal-title').textContent = '摂取したサプリの記録';
  document.getElementById('supple-modal-subtitle').textContent = '日付とサプリを選んで登録します';
  setSuppleSubmitLabel('✓ 登録する');
  document.getElementById('supple-btn-delete-record').classList.add('hidden');

  const dateEl = document.getElementById('supple-input-date');
  const noteEl = document.getElementById('supple-input-note');
  if (dateEl) dateEl.value = getSuppleTodayStr(0);
  if (noteEl) noteEl.value = '';

  suppleIntakePicks = [];
  renderSuppleIntakeRoutines();
  renderSuppleDropdownList();
  const modal = document.getElementById('modal-supple-intake');
  if (modal) {
    if (modal.parentElement !== document.body) document.body.appendChild(modal);
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    modal.style.setProperty('display', 'flex', 'important');
  }
  syncSuppleFabVisibility();
}

// ◯ 摂取記録の編集モーダルを開く
function openSuppleEditModal(intakeId, ev) {
  if (ev) ev.stopPropagation();
  const item = suppleIntakes.find(i => i.id === intakeId);
  if (!item) return;

  document.getElementById('supple-edit-intake-id').value = item.id;
  document.getElementById('supple-modal-title').textContent = '摂取記録の編集';
  document.getElementById('supple-modal-subtitle').textContent = '日付・サプリ・メモを変更できます';
  setSuppleSubmitLabel('✓ 更新する');
  document.getElementById('supple-btn-delete-record').classList.remove('hidden');

  const dateEl = document.getElementById('supple-input-date');
  const timingEl = document.getElementById('supple-input-timing');
  const noteEl = document.getElementById('supple-input-note');

  if (dateEl) dateEl.value = item.date;
  if (timingEl) timingEl.value = item.timing || '夜';
  if (noteEl) noteEl.value = item.note || '';

  suppleIntakePicks = [{ id: item.suppleId, qty: intakeQtyOf(item) }];
  renderSuppleIntakeRoutines();
  renderSuppleDropdownList();

  const modal = document.getElementById('modal-supple-intake');
  if (modal) {
    if (modal.parentElement !== document.body) document.body.appendChild(modal);
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    modal.style.setProperty('display', 'flex', 'important');
  }
  syncSuppleFabVisibility();
}

// サプリ関連の全モーダルを一括で閉じる
function closeSuppleAllModals() {
  closeSuppleIntakeModal();
  closeSuppleMasterModal();
  closeSupplementBarcodeScanner();
  ['modal-supple-intake', 'modal-supple-master', 'modal-supple-scanner'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.classList.add('hidden');
      el.classList.remove('flex');
      el.style.setProperty('display', 'none', 'important');
    }
  });
  syncSuppleFabVisibility();
}

function closeSuppleIntakeModal() {
  const modal = document.getElementById('modal-supple-intake');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    modal.style.setProperty('display', 'none', 'important');
  }
  syncSuppleFabVisibility();
}

// 編集モーダル内の「🗑️ 削除」ボタン
function deleteCurrentEditingIntake() {
  const editId = document.getElementById('supple-edit-intake-id').value;
  if (!editId) return;
  if (deleteSuppleIntake(editId)) {
    closeSuppleIntakeModal();
  }
}

// 登録または更新の送信
function currentSuppleIntakePicks() {
  return suppleIntakePicks
    .map((p) => ({ id: p.id, qty: Math.max(1, Math.min(99, parseInt(p.qty, 10) || 1)) }))
    .filter((p) => suppleMasters.some((m) => m.id === p.id));
}

function submitSuppleIntake() {
  const editId = document.getElementById('supple-edit-intake-id').value;
  const date = document.getElementById('supple-input-date').value;
  const timing = document.getElementById('supple-input-timing').value;
  const note = document.getElementById('supple-input-note').value.trim();
  const picks = currentSuppleIntakePicks();

  if (!date || !picks.length) {
    alert('日付と、1つ以上のサプリを選択してください');
    return;
  }

  let stockUpdated = false;
  if (editId) {
    const idx = suppleIntakes.findIndex(i => i.id === editId);
    const first = picks[0];
    if (idx !== -1) {
      const oldItem = suppleIntakes[idx];
      if (adjustSuppleStock(oldItem.suppleId, intakeQtyOf(oldItem))) stockUpdated = true;
      suppleIntakes[idx].date = date;
      suppleIntakes[idx].suppleId = first.id;
      suppleIntakes[idx].qty = first.qty;
      suppleIntakes[idx].timing = timing;
      suppleIntakes[idx].note = note;
      suppleIntakes[idx].updatedAt = new Date().toISOString();
      if (adjustSuppleStock(first.id, -first.qty)) stockUpdated = true;
    }
    const now = Date.now();
    picks.slice(1).forEach((p, i) => {
      suppleIntakes.push({
        id: 'intake_' + now + '_' + i,
        date: date,
        suppleId: p.id,
        qty: p.qty,
        timing: timing,
        note: note,
        createdAt: new Date().toISOString()
      });
      if (adjustSuppleStock(p.id, -p.qty)) stockUpdated = true;
    });
  } else {
    const now = Date.now();
    picks.forEach((p, i) => {
      suppleIntakes.push({
        id: 'intake_' + now + '_' + i,
        date: date,
        suppleId: p.id,
        qty: p.qty,
        timing: timing,
        note: note,
        createdAt: new Date().toISOString()
      });
      if (adjustSuppleStock(p.id, -p.qty)) stockUpdated = true;
    });
  }

  if (stockUpdated) saveSuppleMasters(suppleMasters, { queueCloud: false });
  saveSuppleIntakes(suppleIntakes);
  closeSuppleIntakeModal();
  renderSuppleAll();
}

function renderSuppleDropdownList() {
  const menu = document.getElementById('supple-pick-list');
  const summary = document.getElementById('supple-pick-summary');
  const idInput = document.getElementById('supple-selected-id');
  if (!menu) return;
  suppleIntakePicks = currentSuppleIntakePicks();
  if (idInput) idInput.value = suppleIntakePicks.length ? suppleIntakePicks[0].id : '';

  if (!suppleMasters.length) {
    menu.innerHTML = '<div class="text-xs text-slate-500 text-center py-4">登録されたサプリはまだありません</div>';
    if (summary) summary.textContent = '';
    return;
  }

  menu.innerHTML = suppleMasters.map((s) => {
    const pick = suppleIntakePicks.find((p) => p.id === s.id);
    const on = !!pick;
    const qty = pick ? pick.qty : 1;
    const thumb = getSupplePhotoThumbHtml(s.photo, 28);
    const cat = SUPPLE_CATEGORIES.find(c => c.name === s.category) || SUPPLE_CATEGORIES[5];
    const hasStock = typeof s.stock === 'number' && Number.isFinite(s.stock);
    return `
      <div class="flex items-center gap-1.5 px-2 py-2 rounded-xl ${on ? 'bg-emerald-950/40 border border-emerald-600/40' : 'hover:bg-slate-800/70 border border-transparent'}">
        <button type="button" onclick="toggleSuppleIntakePick('${escapeHtml(s.id)}')" class="flex-1 min-w-0 flex items-center gap-2 text-left">
          <span class="w-4 h-4 rounded border ${on ? 'bg-emerald-500 border-emerald-400 text-white' : 'border-slate-500 text-transparent'} flex items-center justify-center text-[10px] font-black shrink-0">${on ? '✓' : ''}</span>
          ${thumb}
          <span class="min-w-0">
            <span class="block text-xs font-bold text-slate-100 truncate">${escapeHtml(s.name)}</span>
            <span class="inline-flex items-center gap-1">
              <span class="text-[9px] font-semibold px-1.5 py-0.2 rounded-md ${cat.color}">${escapeHtml(s.category)}</span>
              ${hasStock ? `<span class="text-[9px] font-bold text-cyan-300/80">残${s.stock}</span>` : ''}
            </span>
          </span>
        </button>
        <div class="flex items-center gap-1 shrink-0 ${on ? '' : 'opacity-40 pointer-events-none'}">
          <button type="button" onclick="changeSuppleIntakeQty('${escapeHtml(s.id)}', -1, event)" class="w-6 h-6 rounded-lg bg-slate-800 border border-slate-600 text-slate-100 text-sm font-black" aria-label="個数を減らす">−</button>
          <span class="w-6 text-center text-xs font-black text-cyan-100">${qty}</span>
          <button type="button" onclick="changeSuppleIntakeQty('${escapeHtml(s.id)}', 1, event)" class="w-6 h-6 rounded-lg bg-slate-800 border border-slate-600 text-slate-100 text-sm font-black" aria-label="個数を増やす">＋</button>
        </div>
        <button type="button" onclick="event.stopPropagation(); openSuppleMasterModal('${escapeHtml(s.id)}')" class="w-7 h-7 rounded-lg text-cyan-300 hover:bg-slate-800 text-xs shrink-0" title="このサプリを編集" aria-label="このサプリを編集">✎</button>
        <button type="button" onclick="deleteSuppleMasterFromPicker('${escapeHtml(s.id)}', event)" class="w-7 h-7 rounded-lg text-rose-400 hover:text-rose-200 hover:bg-rose-950/50 text-xs shrink-0" title="このサプリを削除" aria-label="このサプリを削除">🗑</button>
      </div>
    `;
  }).join('');

  if (summary) {
    if (!suppleIntakePicks.length) {
      summary.textContent = 'サプリをタップして選び、個数を指定できます';
    } else {
      const total = suppleIntakePicks.reduce((sum, p) => sum + p.qty, 0);
      summary.textContent = suppleIntakePicks.length + '種を選択（合計 ' + total + '個）';
    }
  }
}

function toggleSuppleIntakePick(suppleId) {
  const idx = suppleIntakePicks.findIndex((p) => p.id === suppleId);
  if (idx >= 0) suppleIntakePicks.splice(idx, 1);
  else suppleIntakePicks.push({ id: suppleId, qty: 1 });
  renderSuppleDropdownList();
}

function changeSuppleIntakeQty(suppleId, delta, ev) {
  if (ev) ev.stopPropagation();
  const pick = suppleIntakePicks.find((p) => p.id === suppleId);
  if (!pick) return;
  pick.qty = Math.max(1, Math.min(99, (parseInt(pick.qty, 10) || 1) + delta));
  renderSuppleDropdownList();
}

function deleteSuppleMasterFromPicker(suppleId, ev) {
  if (ev) ev.stopPropagation();
  const s = suppleMasters.find((m) => m.id === suppleId);
  if (!s) return;
  if (!confirm('「' + s.name + '」をサプリ一覧から削除しますか？\n過去の摂取記録は残ります。')) return;
  suppleMasters = suppleMasters.filter((m) => m.id !== suppleId);
  saveSuppleMasters(suppleMasters);
  suppleIntakePicks = suppleIntakePicks.filter((p) => p.id !== suppleId);
  renderSuppleAll();
}

function selectSuppleForIntake(suppleId) {
  const s = suppleMasters.find(m => m.id === suppleId);
  if (!s) return;
  if (!suppleIntakePicks.some((p) => p.id === s.id)) {
    suppleIntakePicks.push({ id: s.id, qty: 1 });
  }
  renderSuppleDropdownList();
}

function toggleSuppleDropdown() { }

function closeSuppleDropdown() { }

function initSuppleCategorySelector() {
  const c = document.getElementById('supple-category-container');
  if (!c) return;
  c.innerHTML = '';
  SUPPLE_CATEGORIES.forEach((cat, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `supple-cat-btn py-1.5 px-2 rounded-xl text-xs font-bold border transition-all text-center flex items-center justify-center gap-1 ${idx === 0 ? 'bg-cyan-600 text-white border-cyan-500 shadow-sm' : 'bg-black/30 text-slate-400 border-cyan-900/40 hover:bg-slate-800'}`;
    btn.dataset.category = cat.name;
    btn.innerHTML = '<span class="w-1.5 h-1.5 rounded-full" style="background-color:' + cat.dot + '"></span> ' + cat.name;
    btn.onclick = () => selectSuppleCategory(cat.name);
    c.appendChild(btn);
  });
}

function selectSuppleCategory(catName) {
  document.getElementById('supple-master-category').value = catName;
  document.querySelectorAll('.supple-cat-btn').forEach(btn => {
    if (btn.dataset.category === catName) {
      btn.className = 'supple-cat-btn py-1.5 px-2 rounded-xl text-xs font-bold border transition-all text-center flex items-center justify-center gap-1 bg-cyan-600 text-white border-cyan-500 shadow-sm';
    } else {
      btn.className = 'supple-cat-btn py-1.5 px-2 rounded-xl text-xs font-bold border transition-all text-center flex items-center justify-center gap-1 bg-black/30 text-slate-400 border-cyan-900/40 hover:bg-slate-800';
    }
  });
}

function initSupplePresetIcons() {
  const c = document.getElementById('supple-preset-container');
  if (!c) return;
  c.innerHTML = '';
  SUPPLE_PRESET_ICONS.forEach((p, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'supple-preset-btn w-8 h-8 rounded-xl flex items-center justify-center text-sm border-2 transition-all hover:scale-105 active:scale-95';
    btn.style.backgroundColor = p.bg;
    btn.style.borderColor = idx === 0 ? '#06b6d4' : 'transparent';
    btn.title = p.label;
    btn.innerHTML = p.emoji;
    btn.onclick = () => selectSupplePresetIcon(p.id);
    c.appendChild(btn);
  });
}

function selectSupplePresetIcon(presetId) {
  document.getElementById('supple-master-photo-data').value = presetId;
  const preview = document.getElementById('supple-master-preview');
  const placeholder = document.getElementById('supple-master-placeholder');
  const clearBtn = document.getElementById('supple-btn-clear-photo');

  if (preview) { preview.classList.add('hidden'); preview.src = ''; }
  if (placeholder) {
    placeholder.classList.remove('hidden');
    const p = SUPPLE_PRESET_ICONS.find(item => item.id === presetId);
    if (p) placeholder.innerHTML = '<span class="text-xl">' + p.emoji + '</span>';
  }
  if (clearBtn) clearBtn.classList.remove('hidden');

  document.querySelectorAll('.supple-preset-btn').forEach((btn, idx) => {
    btn.style.borderColor = (SUPPLE_PRESET_ICONS[idx].id === presetId) ? '#06b6d4' : 'transparent';
  });
}

const SUPPLE_MAX_IMAGE_DIM = 200;
const SUPPLE_MAX_B64_LENGTH = 45000;

function applySupplePhotoDataUrl(b64, statusMsg) {
  document.getElementById('supple-master-photo-data').value = b64;
  const preview = document.getElementById('supple-master-preview');
  const placeholder = document.getElementById('supple-master-placeholder');
  const clearBtn = document.getElementById('supple-btn-clear-photo');

  if (preview) { preview.src = b64; preview.classList.remove('hidden'); }
  if (placeholder) placeholder.classList.add('hidden');
  if (clearBtn) clearBtn.classList.remove('hidden');
  document.querySelectorAll('.supple-preset-btn').forEach(btn => btn.style.borderColor = 'transparent');

  if (statusMsg) setSupplePasteStatus(statusMsg, 'success');
  else setSupplePasteStatus('', 'info');
}

function setSupplePasteStatus(msg, type = 'info') {
  const el = document.getElementById('supple-paste-status');
  if (!el) return;
  if (!msg) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.textContent = msg;
  el.classList.remove('hidden', 'text-cyan-300', 'text-emerald-300', 'text-rose-400');
  if (type === 'success') el.classList.add('text-emerald-300');
  else if (type === 'error') el.classList.add('text-rose-400');
  else el.classList.add('text-cyan-300');
}

function resizeAndApplySuppleImage(img) {
  const origW = img.naturalWidth || img.width;
  const origH = img.naturalHeight || img.height;
  if (!origW || !origH) return false;

  let maxDim = SUPPLE_MAX_IMAGE_DIM;
  let quality = 0.85;
  let b64 = '';
  let outW = origW;
  let outH = origH;

  for (let attempt = 0; attempt < 6; attempt++) {
    if (origW >= origH) {
      outW = maxDim;
      outH = Math.max(1, Math.round((origH * maxDim) / origW));
    } else {
      outH = maxDim;
      outW = Math.max(1, Math.round((origW * maxDim) / origH));
    }

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(img, 0, 0, outW, outH);
    b64 = canvas.toDataURL('image/jpeg', quality);

    if (b64.length <= SUPPLE_MAX_B64_LENGTH) break;
    if (quality > 0.55) {
      quality = Math.max(0.5, quality - 0.15);
    } else {
      maxDim = Math.max(96, Math.round(maxDim * 0.8));
    }
  }

  applySupplePhotoDataUrl(b64, '');
  return true;
}

function loadSuppleImageBlob(blob) {
  if (!blob) return;
  const reader = new FileReader();
  reader.onload = function (e) {
    loadSuppleImageSrc(e.target.result, false);
  };
  reader.readAsDataURL(blob);
}

function loadSuppleImageSrc(src, allowUrlFallback = true) {
  if (!src) return;
  const img = new Image();
  if (!src.startsWith('data:')) {
    img.crossOrigin = 'anonymous';
  }
  img.onload = function () {
    try {
      resizeAndApplySuppleImage(img);
    } catch (err) {
      if (allowUrlFallback && (src.startsWith('http://') || src.startsWith('https://'))) {
        applySupplePhotoDataUrl(src, '');
      } else {
        setSupplePasteStatus('画像の変換に失敗しました。別の画像を試してください。', 'error');
      }
    }
  };
  img.onerror = function () {
    if (allowUrlFallback && (src.startsWith('http://') || src.startsWith('https://'))) {
      applySupplePhotoDataUrl(src, '');
    } else {
      setSupplePasteStatus('画像の読み込みに失敗しました。画像そのものをコピーして貼り付けてください。', 'error');
    }
  };
  img.src = src;
}

function handleSupplePhotoUpload(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  loadSuppleImageBlob(file);
}

function clearSupplePhoto() {
  document.getElementById('supple-master-photo-data').value = '';
  const fCam = document.getElementById('supple-master-file-camera');
  if (fCam) fCam.value = '';
  const fGal = document.getElementById('supple-master-file-gallery');
  if (fGal) fGal.value = '';
  const pasteZone = document.getElementById('supple-paste-zone');
  if (pasteZone) pasteZone.innerHTML = '';
  setSupplePasteStatus('');
  const preview = document.getElementById('supple-master-preview');
  const placeholder = document.getElementById('supple-master-placeholder');
  const clearBtn = document.getElementById('supple-btn-clear-photo');

  if (preview) { preview.classList.add('hidden'); preview.src = ''; }
  if (placeholder) { placeholder.classList.remove('hidden'); placeholder.innerHTML = '<span class="text-lg">🖼️</span>'; }
  if (clearBtn) clearBtn.classList.add('hidden');
  document.querySelectorAll('.supple-preset-btn').forEach(btn => btn.style.borderColor = 'transparent');
}

function openSuppleMasterModal(editId = '') {
  const editTarget = editId ? suppleMasters.find((m) => m.id === editId) : null;
  const editIdEl = document.getElementById('supple-master-edit-id');
  if (editIdEl) editIdEl.value = editTarget ? editTarget.id : '';

  const titleEl = document.getElementById('supple-master-modal-title');
  const subtitleEl = document.getElementById('supple-master-modal-subtitle');
  const submitBtn = document.getElementById('supple-master-submit-btn');
  if (editTarget) {
    if (titleEl) titleEl.textContent = 'サプリを編集';
    if (subtitleEl) subtitleEl.textContent = '名前・バーコード・写真・残数を変更';
    if (submitBtn) submitBtn.textContent = '💾 変更を保存';
  } else {
    if (titleEl) titleEl.textContent = '新しいサプリを登録';
    if (subtitleEl) subtitleEl.textContent = 'バーコード・写真・名前・カテゴリを設定';
    if (submitBtn) submitBtn.textContent = '💾 サプリを登録';
  }

  document.getElementById('supple-master-name').value = editTarget ? (editTarget.name || '') : '';
  document.getElementById('supple-master-barcode').value = editTarget ? (editTarget.barcode || '') : '';
  document.getElementById('supple-master-dose').value = editTarget ? (editTarget.dose || '') : '';
  const stockEl = document.getElementById('supple-master-stock');
  if (stockEl) stockEl.value = (editTarget && typeof editTarget.stock === 'number') ? String(editTarget.stock) : '';
  const dailyEl = document.getElementById('supple-master-daily-dose');
  if (dailyEl) dailyEl.value = (editTarget && typeof editTarget.dailyDose === 'number') ? String(editTarget.dailyDose) : '';

  selectSuppleCategory((editTarget && editTarget.category) || 'ビタミン');
  clearSupplePhoto();
  if (editTarget && editTarget.photo) {
    if (editTarget.photo.startsWith('data:image') || editTarget.photo.startsWith('http://') || editTarget.photo.startsWith('https://')) {
      applySupplePhotoDataUrl(editTarget.photo, '');
    } else if (editTarget.photo.startsWith('preset_')) {
      selectSupplePresetIcon(editTarget.photo);
    }
  }
  const pasteZone = document.getElementById('supple-paste-zone');
  if (pasteZone) pasteZone.innerHTML = '';
  setSupplePasteStatus('');
  if (typeof setSuppleBarcodeLookupStatus === 'function') setSuppleBarcodeLookupStatus('');
  const modal = document.getElementById('modal-supple-master');
  if (modal) {
    if (modal.parentElement !== document.body) {
      document.body.appendChild(modal);
    }
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    modal.style.setProperty('display', 'flex', 'important');
  }
  const scrollBody = document.getElementById('supple-master-scroll-body');
  if (scrollBody) scrollBody.scrollTop = 0;
  syncSuppleFabVisibility();
}

// バーコード比較用に記号・空白を除去して正規化
function normalizeSuppleBarcode(code) {
  return String(code || '').replace(/[^\dA-Za-z]/g, '').trim();
}

// 登録済みマスタから同じバーコードを探す（なければ null、excludeId は除外）
function findSuppleMasterByBarcode(code, excludeId = '') {
  const target = normalizeSuppleBarcode(code);
  if (!target) return null;
  return suppleMasters.find(s => (!excludeId || s.id !== excludeId) && normalizeSuppleBarcode(s.barcode) === target) || null;
}

// バーコード入力欄のリアルタイム重複チェック
function checkSuppleMasterBarcodeDuplicate() {
  const input = document.getElementById('supple-master-barcode');
  if (!input) return null;
  const editId = (document.getElementById('supple-master-edit-id')?.value || '').trim();
  const val = input.value.trim();
  const dup = findSuppleMasterByBarcode(val, editId);
  if (dup) {
    if (typeof setSuppleBarcodeLookupStatus === 'function') {
      setSuppleBarcodeLookupStatus('⚠️ このバーコードは「' + dup.name + '」で登録済みのため、登録できません', 'warn');
    }
    return dup;
  }
  const statusEl = document.getElementById('supple-barcode-lookup-status');
  if (statusEl && (!val || statusEl.textContent.indexOf('登録済み') !== -1)) {
    if (typeof setSuppleBarcodeLookupStatus === 'function') setSuppleBarcodeLookupStatus('');
  }
  return null;
}

function closeSuppleMasterModal() {
  const modal = document.getElementById('modal-supple-master');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    modal.style.setProperty('display', 'none', 'important');
  }
  syncSuppleFabVisibility();
}

function submitSuppleMaster() {
  const editId = (document.getElementById('supple-master-edit-id')?.value || '').trim();
  const name = document.getElementById('supple-master-name').value.trim();
  const barcode = document.getElementById('supple-master-barcode').value.trim();
  const category = document.getElementById('supple-master-category').value;
  const photo = document.getElementById('supple-master-photo-data').value || 'preset_capsule';
  const dose = document.getElementById('supple-master-dose').value.trim();
  const stockRaw = (document.getElementById('supple-master-stock')?.value || '').trim();
  const dailyRaw = (document.getElementById('supple-master-daily-dose')?.value || '').trim();
  const stock = stockRaw !== '' && Number.isFinite(Number(stockRaw)) && Number(stockRaw) >= 0 ? Math.round(Number(stockRaw) * 100) / 100 : null;
  const dailyDose = dailyRaw !== '' && Number.isFinite(Number(dailyRaw)) && Number(dailyRaw) > 0 ? Math.round(Number(dailyRaw) * 100) / 100 : null;

  if (!name) {
    alert('サプリ名を入力してください');
    return;
  }

  if (barcode) {
    const exist = findSuppleMasterByBarcode(barcode, editId);
    if (exist) {
      // 重複バーコードは登録不可
      alert('バーコード「' + barcode + '」は既に「' + exist.name + '」に登録されているため、登録できません。');
      if (typeof setSuppleBarcodeLookupStatus === 'function') {
        setSuppleBarcodeLookupStatus('⚠️ このバーコードは「' + exist.name + '」で登録済みです', 'warn');
      }
      const input = document.getElementById('supple-master-barcode');
      if (input) input.focus();
      return;
    }
  }

  let savedId = editId;
  if (editId) {
    const idx = suppleMasters.findIndex((m) => m.id === editId);
    if (idx !== -1) {
      suppleMasters[idx] = {
        ...suppleMasters[idx],
        name,
        barcode,
        category,
        photo,
        dose,
        stock,
        dailyDose,
        updatedAt: new Date().toISOString()
      };
    } else {
      savedId = '';
    }
  }

  if (!savedId) {
    savedId = 'supple_' + Date.now();
    const newM = {
      id: savedId,
      name,
      barcode,
      category,
      photo,
      dose,
      stock,
      dailyDose,
      createdAt: new Date().toISOString()
    };
    suppleMasters.push(newM);
    selectSuppleForIntake(savedId);
  }

  saveSuppleMasters(suppleMasters);
  if (photo && photo.startsWith('data:image/')) {
    uploadSuppleMasterPhotoToDrive(savedId, photo);
  }

  closeSuppleMasterModal();
  renderSuppleAll();
}

let suppleAudioCtx = null;
let suppleScannerBusy = false;
let suppleScannerOpenSeq = 0;

function playSuppleBeep() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!suppleAudioCtx || suppleAudioCtx.state === 'closed') {
      suppleAudioCtx = new AudioCtx();
    }
    if (suppleAudioCtx.state === 'suspended') {
      suppleAudioCtx.resume().catch(() => { });
    }
    const osc = suppleAudioCtx.createOscillator();
    const gain = suppleAudioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1760, suppleAudioCtx.currentTime);
    gain.gain.setValueAtTime(0.2, suppleAudioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, suppleAudioCtx.currentTime + 0.12);
    osc.connect(gain);
    gain.connect(suppleAudioCtx.destination);
    osc.start();
    osc.stop(suppleAudioCtx.currentTime + 0.12);
    if (navigator.vibrate) navigator.vibrate(80);
  } catch (e) { }
}

async function openSuppleBarcodeScanner(target = 'intake') {
  suppleCurrentScannerTarget = target;
  suppleScannerBusy = false;
  const seq = ++suppleScannerOpenSeq;
  const modal = document.getElementById('modal-supple-scanner');
  const title = document.getElementById('supple-scanner-title');
  const subtitle = document.getElementById('supple-scanner-subtitle');
  document.getElementById('supple-scanner-manual-input').value = '';

  if (target === 'master') {
    title.textContent = 'サプリのバーコードを登録';
    subtitle.textContent = 'パッケージのバーコードを枠に合わせてください';
  } else {
    title.textContent = 'バーコードでサプリを選択';
    subtitle.textContent = '飲むサプリのバーコードをスキャンしてください';
  }

  if (modal) {
    if (modal.parentElement !== document.body) document.body.appendChild(modal);
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    modal.style.setProperty('display', 'flex', 'important');
  }
  syncSuppleFabVisibility();

  try {
    if (typeof Html5Qrcode === 'undefined' && typeof window.__ensureExternalScript === 'function') {
      await window.__ensureExternalScript('https://unpkg.com/html5-qrcode', () => typeof Html5Qrcode !== 'undefined');
    }
    if (seq !== suppleScannerOpenSeq) return;
    if (!suppleHtml5QrScanner && typeof Html5Qrcode !== 'undefined') {
      suppleHtml5QrScanner = new Html5Qrcode("supple-barcode-reader");
    }
    if (suppleHtml5QrScanner) {
      try { await suppleHtml5QrScanner.stop(); } catch (_) { }
      if (seq !== suppleScannerOpenSeq) return;
      const config = {
        fps: 15,
        qrbox: { width: 250, height: 150 },
        aspectRatio: 1.0,
        formatsToSupport: [
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.UPC_E,
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.QR_CODE
        ]
      };
      await suppleHtml5QrScanner.start(
        { facingMode: "environment" },
        config,
        (decodedText) => onSuppleBarcodeScanned(decodedText),
        () => { }
      );
      if (seq !== suppleScannerOpenSeq) {
        try { await suppleHtml5QrScanner.stop(); } catch (_) { }
      }
    }
  } catch (err) {
    if (seq === suppleScannerOpenSeq && subtitle) {
      subtitle.textContent = 'カメラ未検出：下の入力欄から番号を入力できます';
    }
  }
}

async function closeSupplementBarcodeScanner() {
  suppleScannerOpenSeq++;
  suppleScannerBusy = false;
  const modal = document.getElementById('modal-supple-scanner');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    modal.style.setProperty('display', 'none', 'important');
  }
  if (suppleHtml5QrScanner) {
    try { await suppleHtml5QrScanner.stop(); } catch (e) { }
  }
  syncSuppleFabVisibility();
}

let suppleBarcodeLookupSeq = 0;

function setSuppleBarcodeLookupStatus(msg, type = 'info') {
  const el = document.getElementById('supple-barcode-lookup-status');
  if (!el) return;
  if (!msg) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.textContent = msg;
  el.classList.remove('hidden', 'text-cyan-300', 'text-emerald-300', 'text-amber-300', 'text-rose-400');
  if (type === 'success') el.classList.add('text-emerald-300');
  else if (type === 'warn') el.classList.add('text-amber-300');
  else if (type === 'error') el.classList.add('text-rose-400');
  else el.classList.add('text-cyan-300');
}

async function lookupSuppleNameFromOpenFoodFactsDirect(code) {
  const candidates = [code];
  if (code.length === 13 && code.startsWith('0')) candidates.push(code.slice(1));
  for (const c of candidates) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(
        'https://world.openfoodfacts.org/api/v2/product/' + encodeURIComponent(c) + '.json?fields=product_name,product_name_ja,brands',
        { signal: controller.signal }
      );
      clearTimeout(timer);
      if (!resp.ok) continue;
      const json = await resp.json();
      if (json && json.status === 1 && json.product) {
        const p = json.product;
        const baseName = (p.product_name_ja || p.product_name || '').trim();
        const brand = (p.brands || '').split(',')[0].trim();
        let fullName = baseName;
        if (brand && baseName && !baseName.toLowerCase().includes(brand.toLowerCase())) {
          fullName = brand + ' ' + baseName;
        }
        const cleaned = (fullName || brand || '').replace(/\s+/g, ' ').trim();
        if (cleaned) return cleaned.slice(0, 80);
      }
    } catch (_) { }
  }
  return '';
}

async function lookupSuppleNameByBarcode(barcode, opts = {}) {
  const code = String(barcode || '').replace(/[^\dA-Za-z]/g, '').trim();
  if (!code) {
    if (opts.overwrite) setSuppleBarcodeLookupStatus('先にバーコード番号を入力してください', 'warn');
    return '';
  }
  const editId = (document.getElementById('supple-master-edit-id')?.value || '').trim();
  const dup = findSuppleMasterByBarcode(code, editId);
  if (dup) {
    setSuppleBarcodeLookupStatus('⚠️ このバーコードは「' + dup.name + '」で登録済みのため、登録できません', 'warn');
    return '';
  }
  const seq = ++suppleBarcodeLookupSeq;
  setSuppleBarcodeLookupStatus('🔍 バーコードから商品名を検索中...', 'info');

  let foundName = '';
  try {
    if (typeof callAPI === 'function') {
      const res = await callAPI('lookupJanProduct', { barcode: code }, { silent: true });
      if (res && res.success && res.name) {
        foundName = String(res.name).trim();
      }
    }
  } catch (_) { }

  if (!foundName && seq === suppleBarcodeLookupSeq) {
    foundName = await lookupSuppleNameFromOpenFoodFactsDirect(code);
  }

  if (seq !== suppleBarcodeLookupSeq) return '';

  const currentCode = (document.getElementById('supple-master-barcode')?.value || '').replace(/[^\dA-Za-z]/g, '').trim();
  if (currentCode && currentCode !== code) return '';

  if (!foundName) {
    setSuppleBarcodeLookupStatus('⚠️ 商品名が見つかりませんでした（手動で入力してください）', 'warn');
    return '';
  }

  const nameEl = document.getElementById('supple-master-name');
  if (nameEl) {
    if (!nameEl.value.trim() || opts.overwrite) {
      nameEl.value = foundName;
      setSuppleBarcodeLookupStatus('✅ 商品名を自動入力しました: ' + foundName, 'success');
    } else {
      setSuppleBarcodeLookupStatus('ℹ️ 取得候補: ' + foundName, 'info');
    }
  }
  return foundName;
}

function onSuppleBarcodeScanned(barcode) {
  if (suppleScannerBusy) return;
  suppleScannerBusy = true;
  playSuppleBeep();
  closeSupplementBarcodeScanner();

  if (suppleCurrentScannerTarget === 'master') {
    document.getElementById('supple-master-barcode').value = barcode;
    const editId = (document.getElementById('supple-master-edit-id')?.value || '').trim();
    const dup = findSuppleMasterByBarcode(barcode, editId);
    if (dup) {
      setSuppleBarcodeLookupStatus('⚠️ このバーコードは「' + dup.name + '」で登録済みのため、登録できません', 'warn');
    } else {
      lookupSuppleNameByBarcode(barcode, { overwrite: false });
    }
  } else {
    const matched = findSuppleMasterByBarcode(barcode);
    if (matched) {
      selectSuppleForIntake(matched.id);
    } else {
      if (confirm('バーコード「' + barcode + '」に一致するサプリは未登録です。新しくサプリを登録しますか？')) {
        openSuppleMasterModal();
        document.getElementById('supple-master-barcode').value = barcode;
        lookupSuppleNameByBarcode(barcode, { overwrite: false });
      }
    }
  }
}

function submitSuppleManualBarcode() {
  const val = document.getElementById('supple-scanner-manual-input').value.trim();
  if (!val) { alert('バーコード番号を入力してください'); return; }
  onSuppleBarcodeScanned(val);
}

function openSuppleJanGoogleImageSearch() {
  const code = (document.getElementById('supple-master-barcode').value || '').trim();
  const name = (document.getElementById('supple-master-name').value || '').trim();
  const query = code || name;
  if (!query) {
    alert('先にバーコード(JANコード)またはサプリ名を入力してください');
    return;
  }
  const url = 'https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(query);
  window.open(url, '_blank', 'noopener,noreferrer');
}

function extractSuppleImageFromClipboardData(cd) {
  if (!cd) return false;
  if (cd.items) {
    for (const item of cd.items) {
      if (item.type && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          loadSuppleImageBlob(file);
          return true;
        }
      }
    }
  }
  if (cd.files && cd.files.length > 0) {
    for (const file of cd.files) {
      if (file.type && file.type.startsWith('image/')) {
        loadSuppleImageBlob(file);
        return true;
      }
    }
  }
  const html = cd.getData ? cd.getData('text/html') : '';
  if (html) {
    const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m && m[1]) {
      loadSuppleImageSrc(m[1], true);
      return true;
    }
  }
  const text = (cd.getData ? cd.getData('text/plain') : '').trim();
  if (text && (text.startsWith('data:image/') || /^https?:\/\/.+\.(png|jpe?g|webp|gif|bmp|avif)(\?.*)?$/i.test(text) || /^https?:\/\//i.test(text))) {
    loadSuppleImageSrc(text, true);
    return true;
  }
  return false;
}

function handleSuppleImagePaste(ev) {
  const cd = ev.clipboardData || window.clipboardData;
  const handled = extractSuppleImageFromClipboardData(cd);
  if (handled) {
    ev.preventDefault();
    const pasteZone = document.getElementById('supple-paste-zone');
    if (pasteZone) pasteZone.innerHTML = '';
    return;
  }
  ev.preventDefault();
  const pasteZone = document.getElementById('supple-paste-zone');
  if (pasteZone) pasteZone.innerHTML = '';
  setSupplePasteStatus('クリップボードに画像が見つかりませんでした。画像をコピーしてから貼り付けてください。', 'error');
}

function handleSupplePasteZoneInput(el) {
  if (!el) return;
  const img = el.querySelector('img');
  if (img && img.src) {
    loadSuppleImageSrc(img.src, true);
  }
  el.innerHTML = '';
}

async function pasteSuppleImageFromClipboard() {
  if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
    setSupplePasteStatus('このブラウザはボタン貼付に未対応です。Ctrl+V またはギャラリーをご利用ください。', 'info');
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imgType = item.types.find(t => t.startsWith('image/'));
      if (imgType) {
        const blob = await item.getType(imgType);
        loadSuppleImageBlob(blob);
        return;
      }
    }
    if (typeof navigator.clipboard.readText === 'function') {
      const txt = (await navigator.clipboard.readText() || '').trim();
      if (txt && (txt.startsWith('data:image/') || txt.startsWith('http://') || txt.startsWith('https://'))) {
        loadSuppleImageSrc(txt, true);
        return;
      }
    }
    setSupplePasteStatus('クリップボードに画像がありません。画像検索で画像をコピーしてください。', 'error');
  } catch (err) {
    setSupplePasteStatus('クリップボードの読み取りが許可されませんでした。', 'error');
  }
}

(function initSuppleModalPasteShortcut() {
  const modal = document.getElementById('modal-supple-master');
  if (!modal) return;
  modal.addEventListener('paste', function (ev) {
    if (ev.target && ev.target.id === 'supple-paste-zone') return;
    const cd = ev.clipboardData || window.clipboardData;
    if (!cd || !cd.items) return;
    for (const item of cd.items) {
      if (item.type && item.type.startsWith('image/')) {
        ev.preventDefault();
        const file = item.getAsFile();
        if (file) loadSuppleImageBlob(file);
        return;
      }
    }
  });
})();
