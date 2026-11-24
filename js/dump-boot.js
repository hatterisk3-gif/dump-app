    let loaderDepth = 0;
    let loaderStartedAt = 0;
    const LOADER_STUCK_MS = 20000;
    const HISTORY_REPLACE_LOCK_STUCK_MS = 30000;
    const SUBMIT_INBOX_BUSY_STUCK_MS = 15000;
    let isSubmittingInbox = false;
    let historyReplaceLockStartedAt = 0;
    let submitInboxBusyStartedAt = 0;
    function isLoaderVisible() {
      return loaderDepth > 0;
    }
    // showLoader と hideLoader の対応が崩れると DUMP が永久に押せなくなるため、時間切れで強制解除する
    function checkStuckLoader() {
      if (loaderDepth > 0 && loaderStartedAt && (Date.now() - loaderStartedAt) > LOADER_STUCK_MS) {
        forceHideLoader();
        return true;
      }
      if (typeof checkStuckSubmitLocks === 'function' && checkStuckSubmitLocks()) {
        return true;
      }
      return false;
    }
    function forceHideLoader() {
      loaderDepth = 0;
      loaderStartedAt = 0;
      applyLoaderHidden();
    }
    function showLoader(text = "データを読み込み中...") {
      if (loaderDepth === 0) loaderStartedAt = Date.now();
      loaderDepth++;
      const loader = document.getElementById('global-loader');
      if (!loader) return;
      document.getElementById('global-loader-text').textContent = text;
      loader.classList.remove('opacity-0', 'pointer-events-none');
      loader.setAttribute('aria-hidden', 'false');
      document.body.classList.add('overflow-hidden');
      document.body.setAttribute('aria-busy', 'true');
      // DUMPボタンはローダーで無効化しない（入力画面を開いた／DUMP押下時に解除）
      const input = document.getElementById('input-content');
      if (input && !isCaptureOverlayOpen()) input.setAttribute('readonly', 'readonly');
    }

    function applyLoaderHidden() {
      const loader = document.getElementById('global-loader');
      if (loader) {
        loader.classList.add('opacity-0', 'pointer-events-none');
        loader.setAttribute('aria-hidden', 'true');
      }
      document.body.classList.remove('overflow-hidden');
      document.body.removeAttribute('aria-busy');
      const input = document.getElementById('input-content');
      if (input) {
        input.removeAttribute('readonly');
        input.removeAttribute('disabled');
      }
      if (typeof applySubmitInboxEnabledState === 'function') applySubmitInboxEnabledState();
    }

    function hideLoader() {
      loaderDepth = Math.max(0, loaderDepth - 1);
      if (loaderDepth > 0) return;
      loaderStartedAt = 0;
      applyLoaderHidden();
    }
    // ⚠️【必須設定】ここに発行したGASのウェブアプリURLを貼り付けてください
    const GAS_API_URL = "https://script.google.com/macros/s/AKfycbxP-ENobvgAGiVgXKgzLmKBLZn4_6KzZXwXXZAbDBqmSdLxiJOCf5whFrUv5ikUo5evvQ/exec";
    const R2_MEDIA_WORKER_URL = "https://dump-media.hatterisk3.workers.dev";
    const SUPABASE_URL = "https://nxtrrqkxcmkfjblbwleo.supabase.co";
    const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im54dHJycWt4Y21rZmpibGJ3bGVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU0NjEwMjAsImV4cCI6MjExMTAzNzAyMH0.Az8EYMaf1_3-AYqe7kf-lXU4UFswpcokD_J8kzL489o";
    const SUPABASE_RPC_URL = `${SUPABASE_URL}/rest/v1/rpc/dump_api`;
    const GAS_ONLY_ACTIONS = new Set([
      'uploadDumpImageBegin',
      'uploadDumpImageChunk',
      'uploadDumpImageFinish',
      'getDumpImageById',
      'syncGanttCalendarEvent',
      'deleteGanttCalendarEvent',
      'syncAllGanttToCalendar',
      'lookupJanProduct'
    ]);
    const SUPABASE_SWEEP_TABLES_BY_ACTION = {
      moveInboxItem: ['inbox'],
      moveInboxItems: ['inbox'],
      purgeInboxExactDuplicates: ['inbox'],
      deleteConfigRecord: ['config_records'],
      updateConfigRecord: ['config_records'],
      purgeSystemTrash: ['data_records'],
      batch: ['inbox', 'config_records']
    };

    function sweepSupabaseDeletedRows(action) {
      if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
      const tables = SUPABASE_SWEEP_TABLES_BY_ACTION[action];
      if (!Array.isArray(tables) || !tables.length) return;
      tables.forEach((table) => {
        fetch(`${SUPABASE_URL}/rest/v1/${table}?is_deleted=eq.true`, {
          method: 'DELETE',
          keepalive: true,
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
            'Prefer': 'return=minimal'
          }
        }).catch(() => { });
      });
    }
    function isApiFailure(res) {
      return !res || res.error || res.success === false;
    }

    /** 削除系: 対象が既に無い場合も成功扱い */
    function isDeleteResultOk(res) {
      if (!isApiFailure(res)) return true;
      if (!res) return false;
      if (res.error) return false;
      // 旧GAS: deleteDataRecord が { success: false }（count=0）を返していた
      if (res.success === false && (res.count === 0 || res.count == null) && !res.message) return true;
      return false;
    }

    function assertWriteResult(res, expectedCount) {
      if (isApiFailure(res)) {
        const err = new Error(res && res.message ? res.message : 'write');
        if (res && res.isTimeout) err.isTimeout = true;
        throw err;
      }
      if (expectedCount > 0 && typeof res.count === 'number' && res.count === 0) {
        throw new Error('write');
      }
      return res;
    }

    // ページを閉じたあとも書き込みが続く（Google Keep 相当）。本文はブラウザ上限 ~64KB
    const KEEPALIVE_WRITE_ACTIONS = new Set([
      'batch',
      'addInbox',
      'addManyInbox',
      'addDataRecord',
      'addManyDataRecords',
      'updateInbox',
      'updateDataRecord',
      'trashItems',
      'trashExactContents'
    ]);
    const KEEPALIVE_BODY_MAX = 60000;
    const DEFAULT_API_TIMEOUT_MS = 20000;

    async function callAPI(action, data = {}, options = {}) {
      const timeoutMs = Number(options.timeoutMs) || DEFAULT_API_TIMEOUT_MS;
      const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      let timer = null;
      if (controller && timeoutMs > 0) {
        timer = setTimeout(() => {
          try { controller.abort(); } catch (_) { }
        }, timeoutMs);
      }
      try {
        const useR2 = action === 'uploadDumpImage' && !!R2_MEDIA_WORKER_URL;
        const useGas = !useR2 && (GAS_ONLY_ACTIONS.has(action) || !SUPABASE_URL || !SUPABASE_ANON_KEY);
        const targetUrl = useR2
          ? `${R2_MEDIA_WORKER_URL}/upload`
          : (useGas ? GAS_API_URL : SUPABASE_RPC_URL);
        const body = (useR2 || useGas)
          ? JSON.stringify({ action, ...data })
          : JSON.stringify({ payload: { action, ...data } });
        const useKeepalive = options.keepalive === true
          || (options.keepalive !== false
            && KEEPALIVE_WRITE_ACTIONS.has(action)
            && body.length <= KEEPALIVE_BODY_MAX);
        const fetchOpts = {
          method: 'POST',
          body,
          keepalive: !!useKeepalive,
          headers: useR2
            ? { 'Content-Type': 'application/json' }
            : (useGas
                ? { 'Content-Type': 'text/plain;charset=UTF-8' }
                : {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_ANON_KEY,
                    'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
                  })
        };
        if (controller) {
          fetchOpts.signal = controller.signal;
        }
        const response = await fetch(targetUrl, fetchOpts);
        if (timer) { clearTimeout(timer); timer = null; }
        const text = await response.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch (parseErr) {
          console.error('API non-JSON response:', response.status, (text || '').slice(0, 200));
          if (!options.silent) alert('通信エラーが発生しました');
          return { error: true, message: 'invalid_json', status: response.status };
        }
        if (!useR2 && !useGas && (!response.ok || (json && json.code && json.message && !json.error))) {
          const msg = (json && json.message) ? String(json.message) : ('http_' + response.status);
          console.error('Supabase RPC error:', response.status, json);
          if (!options.silent) alert('通信エラーが発生しました');
          return { error: true, message: msg, status: response.status };
        }
        if (json && json.config && json.config['__SYSTEM__']) {
          delete json.config['__SYSTEM__'];
        }
        if (!useR2 && !useGas && !isApiFailure(json)) {
          sweepSupabaseDeletedRows(action);
        }
        return json;
      } catch (error) {
        if (timer) { clearTimeout(timer); timer = null; }
        const isTimeout = !!(error && (error.name === 'AbortError' || String(error.message).includes('timeout') || String(error.message).includes('aborted')));
        if (isTimeout) {
          console.warn(`callAPI timeout after ${timeoutMs}ms:`, action);
          return { error: true, message: 'timeout', isTimeout: true };
        }
        console.error("API Error:", error);
        if (!options.silent) alert("通信エラーが発生しました");
        return { error: true, message: String(error && error.message ? error.message : error) };
      }
    }

    function runInBackground(task, { onError } = {}) {
      Promise.resolve()
        .then(() => task())
        .catch((err) => {
          console.error('Background task failed:', err);
          if (typeof onError === 'function') onError(err);
        });
    }

    // 登録チェック削除の同期を直列化（連続削除で GAS が競合しやすい）
    let inputHistoryDeleteChain = Promise.resolve();
    let inputHistoryDeleteRunning = 0;
    const INPUT_HISTORY_DELETE_MAX_ATTEMPTS = 4;

    function showInputHistoryDeleteStatus(message, kind) {
      const status = document.getElementById('input-status');
      if (!status || !message) return;
      const color = kind === 'error'
        ? 'text-amber-300'
        : (kind === 'ok' ? 'text-emerald-400' : 'text-slate-300');
      status.textContent = message;
      status.className = `text-base mt-2 text-center font-bold ${color}`;
      if (kind === 'ok' || kind === 'error') {
        setTimeout(() => {
          if (status.textContent === message) status.textContent = '';
        }, kind === 'error' ? 4500 : 2800);
      }
    }

    function syncSpinMarkup() {
      return '<span class="sync-spin-inline" title="同期中" aria-label="同期中"></span>';
    }

    /** 「（同期中）」文言をくるくるアイコンに置き換えた HTML を返す */
    function withSyncSpinHtml(text) {
      const raw = String(text || '');
      const cleaned = raw
        .replace(/\s*[（(]\s*同期中\s*[）)]\s*/g, ' ')
        .replace(/\s*同期中[…\.]*\s*/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      return `${cleaned} ${syncSpinMarkup()}`.trim();
    }

    let syncGauge = null;
    const SYNC_GAUGE_HANDOFF_MS = 4000;
    const handedOffSyncJobIds = new Set();

    function syncGaugeEstimateMs(textLength) {
      const n = Math.max(0, Number(textLength) || 0);
      return Math.min(15000, Math.max(2500, 2200 + n * 3));
    }

    function handoffSyncGaugeToBackground(g) {
      if (!g || g.handedOff) return;
      g.handedOff = true;
      if (g.timer) {
        clearInterval(g.timer);
        g.timer = null;
      }
      g.jobs.forEach((j) => {
        if (!j.done) handedOffSyncJobIds.add(j.id);
      });
      if (typeof setCrossDeviceSyncStatus === 'function') {
        setCrossDeviceSyncStatus('クラウド同期中…', 'busy');
      }
      const msg = '✓ ' + g.accepted + '件を端末に保存済み（裏で同期中）';
      const el = g.el;
      if (el && el.isConnected) {
        el.className = 'text-sm sm:text-base mt-1 text-center font-bold text-emerald-400';
        el.textContent = msg;
        setTimeout(() => {
          if (el && el.textContent === msg) el.textContent = '';
        }, 1800);
      }
      if (syncGauge === g) syncGauge = null;
    }

    function paintSyncGauge() {
      const g = syncGauge;
      if (!g || !g.el || !g.el.isConnected) return;
      if (!g.photoProgressText && g.jobs.some((j) => !j.done && j.startedAt && (Date.now() - j.startedAt) >= SYNC_GAUGE_HANDOFF_MS)) {
        handoffSyncGaugeToBackground(g);
        return;
      }
      const sig = g.jobs.map((j) => j.id + ':' + (j.done ? (j.failed ? 'f' : 'd') : 'w')).join('|') + '|' + (g.label || '') + '|' + (g.undoHtml || '');
      if (g.paintSig !== sig) {
        g.paintSig = sig;
        const segs = g.jobs.map((j) => {
          const grow = Math.max(1, Math.round(j.estimateMs / 500));
          return '<span class="sync-eta-seg' + (j.failed ? ' is-failed' : '') + '" style="flex-grow:' + grow + '" data-sync-job="' + j.id + '"><span class="sync-eta-seg-fill"></span></span>';
        }).join('');
        g.el.className = 'text-sm sm:text-base mt-1 text-center font-bold text-emerald-400';
        g.el.innerHTML =
          '<span class="sync-eta">'
          + '<span class="sync-eta-label"></span>'
          + '<span class="sync-eta-track" role="progressbar" aria-valuemin="0" aria-valuemax="100">' + segs + '</span>'
          + '<span class="sync-eta-remain"></span>'
          + '</span>'
          + (g.undoHtml || '');
        const labelEl = g.el.querySelector('.sync-eta-label');
        if (labelEl) labelEl.textContent = g.label || '';
      }
      let remainMs = 0;
      let doneMs = 0;
      let totalMs = 0;
      let doneN = 0;
      let hasOverdueJob = false;
      const fills = g.el.querySelectorAll('.sync-eta-seg');
      g.jobs.forEach((j) => {
        totalMs += j.estimateMs;
        let pct = 0;
        if (j.done) {
          pct = 100;
          doneN += 1;
          doneMs += j.estimateMs;
        } else if (j.startedAt) {
          const elapsed = Date.now() - j.startedAt;
          if (elapsed > j.estimateMs) {
            if (elapsed > Math.max(j.estimateMs * 1.35, 7500)) {
              hasOverdueJob = true;
            }
            pct = Math.min(97, 92 + Math.round(((elapsed - j.estimateMs) / 10000) * 5));
            doneMs += j.estimateMs * 0.95;
            remainMs += 0;
          } else {
            pct = Math.min(92, Math.round((elapsed / j.estimateMs) * 92));
            doneMs += Math.min(j.estimateMs * 0.92, elapsed);
            remainMs += Math.max(0, j.estimateMs - elapsed);
          }
        } else {
          remainMs += j.estimateMs;
        }
        fills.forEach((seg) => {
          if (seg.getAttribute('data-sync-job') !== j.id) return;
          const fill = seg.querySelector('.sync-eta-seg-fill');
          if (fill) fill.style.width = pct + '%';
        });
      });
      const track = g.el.querySelector('.sync-eta-track');
      const remainEl = g.el.querySelector('.sync-eta-remain');
      const overall = totalMs ? Math.round((doneMs / totalMs) * 100) : 0;
      if (track) track.setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, overall))));
      if (remainEl) {
        const allDone = doneN === g.jobs.length && g.jobs.length > 0;
        const remainSec = Math.max(0, Math.ceil(remainMs / 1000));
        let timeText;
        if (allDone) {
          timeText = '完了';
        } else if (g.photoProgressText) {
          timeText = g.photoProgressText;
        } else if (hasOverdueJob) {
          timeText = 'クラウド同期中…';
        } else if (remainSec > 0) {
          timeText = '残り約' + remainSec + '秒';
        } else {
          timeText = 'まもなく完了';
        }
        remainEl.textContent = g.jobs.length > 1 ? (doneN + '/' + g.jobs.length + ' · ' + timeText) : timeText;
      }
    }

    function updateSyncGaugeImageProgress(jobId, text) {
      const g = syncGauge;
      if (!g) return;
      g.photoProgressText = text || '';
      if (typeof paintSyncGauge === 'function') paintSyncGauge();
    }

    function ensureSyncGauge(el) {
      if (syncGauge && syncGauge.el === el) return syncGauge;
      if (syncGauge && syncGauge.timer) clearInterval(syncGauge.timer);
      syncGauge = {
        el,
        jobs: [],
        accepted: 0,
        label: '',
        undoHtml: '',
        paintSig: '',
        sealToken: 0,
        hadFailure: false,
        failureText: '',
        timer: setInterval(paintSyncGauge, 200)
      };
      return syncGauge;
    }

    function sealSyncGauge(doneText, className) {
      const g = syncGauge;
      if (!g || g.jobs.some((j) => !j.done)) return;
      if (g.timer) {
        clearInterval(g.timer);
        g.timer = null;
      }
      paintSyncGauge();
      const token = ++g.sealToken;
      const text = doneText || ('✓ ' + g.accepted + '件の保存が完了しました');
      setTimeout(() => {
        if (syncGauge !== g || g.sealToken !== token || g.jobs.some((j) => !j.done)) return;
        g.el.className = className || 'text-sm sm:text-base mt-1 text-center font-bold text-emerald-400';
        g.el.textContent = text;
        syncGauge = null;
        setTimeout(() => {
          if (g.el && g.el.textContent === text) g.el.textContent = '';
        }, 2800);
      }, 280);
    }

    /** 同期中に追加した分は、同じゲージへ区切りを足す */
    function addSyncGaugeJob(el, opts) {
      if (!el) return '';
      opts = opts || {};
      const g = ensureSyncGauge(el);
      g.sealToken += 1;
      if (!g.timer) g.timer = setInterval(paintSyncGauge, 200);
      const id = String(opts.id || ('sg-' + Date.now()));
      if (g.jobs.some((j) => j.id === id)) return id;
      if (opts.historyId && g.jobs.some((j) => j.historyId && j.historyId === opts.historyId)) return id;
      const count = Math.max(1, Number(opts.count) || 1);
      const running = g.jobs.some((j) => !j.done);
      g.accepted += count;
      if (!g.jobs.length) g.label = opts.label || ('✓ ' + g.accepted + '件を受け付けました');
      else g.label = '✓ ' + g.accepted + '件を同期中';
      if (opts.undoHtml != null) g.undoHtml = opts.undoHtml;
      g.jobs.push({
        id,
        historyId: opts.historyId || '',
        count,
        estimateMs: Math.max(4000, Number(opts.estimateMs) || 10000),
        startedAt: running ? 0 : Date.now(),
        done: false,
        failed: false
      });
      g.paintSig = '';
      paintSyncGauge();
      return id;
    }

    function settleSyncGaugeJob(el, jobId, opts) {
      opts = opts || {};
      const wasHandedOff = !!(jobId && handedOffSyncJobIds.delete(jobId));
      const g = syncGauge;
      if (!g || (el && g.el !== el)) {
        if (wasHandedOff && !opts.failed) {
          if (handedOffSyncJobIds.size === 0 && typeof setCrossDeviceSyncStatus === 'function') {
            const stamp = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            setCrossDeviceSyncStatus('同期済み ' + stamp, 'ok');
          }
          return;
        }
        if (el && opts.doneText) {
          el.textContent = opts.doneText;
          if (opts.className) el.className = opts.className;
        }
        return;
      }
      const job = jobId ? g.jobs.find((j) => j.id === jobId) : g.jobs.find((j) => !j.done);
      if (!job) return;
      if (!job.done) {
        job.done = true;
        job.failed = !!opts.failed;
      }
      if (opts.failed) {
        g.hadFailure = true;
        g.failureText = opts.doneText || g.failureText;
      }
      const next = g.jobs.find((j) => !j.done);
      if (next && !next.startedAt) next.startedAt = Date.now();
      g.photoProgressText = '';
      g.paintSig = '';
      if (next) {
        paintSyncGauge();
        return;
      }
      const text = (g.hadFailure && g.jobs.every((j) => j.failed))
        ? (g.failureText || opts.doneText)
        : (g.jobs.length > 1
          ? ('✓ ' + g.accepted + '件の保存が完了しました')
          : (opts.doneText || ('✓ ' + g.accepted + '件の保存が完了しました')));
      const className = (g.hadFailure && g.jobs.every((j) => j.failed))
        ? (opts.className || 'text-base mt-2 text-center font-bold text-rose-400')
        : (opts.className || 'text-sm sm:text-base mt-1 text-center font-bold text-emerald-400');
      sealSyncGauge(text, className);
    }

    function dropSyncGaugeByHistory(historyId) {
      const g = syncGauge;
      if (!g || !historyId) return false;
      const removed = g.jobs.filter((j) => j.historyId && j.historyId === historyId);
      if (!removed.length) return false;
      removed.forEach((j) => handedOffSyncJobIds.delete(j.id));
      const removedCount = removed.reduce((n, j) => n + (j.count || 1), 0);
      g.jobs = g.jobs.filter((j) => j.historyId !== historyId);
      g.accepted = Math.max(0, g.accepted - removedCount);
      g.undoHtml = '';
      const next = g.jobs.find((j) => !j.done);
      if (next && !next.startedAt) next.startedAt = Date.now();
      if (!g.jobs.length) {
        if (g.timer) clearInterval(g.timer);
        syncGauge = null;
        return false;
      }
      if (!g.jobs.some((j) => !j.done)) {
        sealSyncGauge('✓ ' + g.accepted + '件の保存が完了しました', 'text-sm sm:text-base mt-1 text-center font-bold text-emerald-400');
        return true;
      }
      g.label = '✓ ' + g.accepted + '件を同期中';
      g.paintSig = '';
      paintSyncGauge();
      return true;
    }

    /** 受け付け後の残り時間バー。同期中の追加は区切りを足す */
    function startSyncEtaBar(el, label, estimateMs, jobId) {
      return addSyncGaugeJob(el, {
        id: jobId,
        label,
        estimateMs,
        count: 1
      });
    }

    function finishSyncEtaBar(el, doneText, className, jobId) {
      settleSyncGaugeJob(el, jobId, { doneText, className, failed: false });
    }

    const TEXT_UNDO_LIMIT = 80;
    const textUndoById = Object.create(null);

    function textUndoButtonsFor(textarea) {
      if (!textarea) return { undo: null, redo: null };
      if (textarea.id === 'input-content') {
        return {
          undo: document.getElementById('capture-undo-btn'),
          redo: document.getElementById('capture-redo-btn')
        };
      }
      if (textarea.id === 'check-blocks-editor') {
        return {
          undo: document.getElementById('check-blocks-undo-btn'),
          redo: document.getElementById('check-blocks-redo-btn')
        };
      }
      return { undo: null, redo: null };
    }

    function updateTextUndoButtons(textarea) {
      const store = textarea && textUndoById[textarea.id];
      const btns = textUndoButtonsFor(textarea);
      const dirty = !!(store && textarea && textarea.value !== store.last);
      if (btns.undo) btns.undo.disabled = !(store && (store.undo.length || dirty));
      if (btns.redo) btns.redo.disabled = !(store && store.redo.length);
    }

    function commitTextUndo(textarea) {
      const store = textarea && textUndoById[textarea.id];
      if (!store || store.applying) return;
      if (store.timer) {
        clearTimeout(store.timer);
        store.timer = null;
      }
      const value = textarea.value;
      if (value === store.last) {
        updateTextUndoButtons(textarea);
        return;
      }
      store.undo.push({
        value: store.last,
        start: store.selStart,
        end: store.selEnd
      });
      if (store.undo.length > TEXT_UNDO_LIMIT) store.undo.shift();
      store.last = value;
      store.selStart = textarea.selectionStart;
      store.selEnd = textarea.selectionEnd;
      store.redo = [];
      updateTextUndoButtons(textarea);
    }

    function ensureTextUndo(textarea) {
      if (!textarea || !textarea.id) return null;
      if (textUndoById[textarea.id]) return textUndoById[textarea.id];
      const store = {
        undo: [],
        redo: [],
        last: textarea.value,
        selStart: textarea.selectionStart || 0,
        selEnd: textarea.selectionEnd || 0,
        timer: null,
        applying: false,
        bound: false
      };
      textUndoById[textarea.id] = store;
      textarea.addEventListener('input', () => {
        if (store.applying) return;
        store.selStart = textarea.selectionStart;
        store.selEnd = textarea.selectionEnd;
        const delta = Math.abs(String(textarea.value || '').length - String(store.last || '').length);
        if (store.timer) clearTimeout(store.timer);
        if (delta > 24) commitTextUndo(textarea);
        else store.timer = setTimeout(() => commitTextUndo(textarea), 420);
        updateTextUndoButtons(textarea);
      });
      textarea.addEventListener('keydown', (ev) => {
        const mod = ev.ctrlKey || ev.metaKey;
        if (!mod || ev.altKey) return;
        const key = String(ev.key || '').toLowerCase();
        if (key === 'z') {
          ev.preventDefault();
          ev.stopPropagation();
          if (ev.shiftKey) redoTextareaUndo(textarea);
          else undoTextareaUndo(textarea);
        } else if (key === 'y') {
          ev.preventDefault();
          ev.stopPropagation();
          redoTextareaUndo(textarea);
        }
      });
      updateTextUndoButtons(textarea);
      return store;
    }

    function applyTextUndoValue(textarea, snap) {
      const store = textUndoById[textarea.id];
      if (!store) return;
      store.applying = true;
      textarea.value = snap.value;
      store.last = snap.value;
      store.applying = false;
      const pos = Math.min(String(snap.value || '').length, Number(snap.end != null ? snap.end : snap.value.length) || 0);
      try { textarea.setSelectionRange(pos, pos); } catch (_) { }
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      updateTextUndoButtons(textarea);
    }

    function undoTextareaUndo(textarea) {
      if (!textarea) return;
      const store = ensureTextUndo(textarea);
      if (!store) return;
      commitTextUndo(textarea);
      if (!store.undo.length) return;
      const current = {
        value: textarea.value,
        start: textarea.selectionStart,
        end: textarea.selectionEnd
      };
      const prev = store.undo.pop();
      store.redo.push(current);
      applyTextUndoValue(textarea, prev);
      textarea.focus();
    }

    function redoTextareaUndo(textarea) {
      if (!textarea) return;
      const store = ensureTextUndo(textarea);
      if (!store || !store.redo.length) return;
      if (store.timer) {
        clearTimeout(store.timer);
        store.timer = null;
      }
      const current = {
        value: textarea.value,
        start: textarea.selectionStart,
        end: textarea.selectionEnd
      };
      const next = store.redo.pop();
      store.undo.push(current);
      applyTextUndoValue(textarea, next);
      textarea.focus();
    }

    function textUndoRemember(textarea, previousValue) {
      if (!textarea) return;
      const store = ensureTextUndo(textarea);
      if (!store) return;
      if (store.timer) {
        clearTimeout(store.timer);
        store.timer = null;
      }
      const prev = previousValue != null ? String(previousValue) : store.last;
      if (prev === textarea.value) {
        store.last = textarea.value;
        updateTextUndoButtons(textarea);
        return;
      }
      store.undo.push({ value: prev, start: 0, end: 0 });
      if (store.undo.length > TEXT_UNDO_LIMIT) store.undo.shift();
      store.last = textarea.value;
      store.redo = [];
      updateTextUndoButtons(textarea);
    }

    function textUndoReset(textarea) {
      if (!textarea) return;
      const store = ensureTextUndo(textarea);
      if (!store) return;
      if (store.timer) {
        clearTimeout(store.timer);
        store.timer = null;
      }
      store.undo = [];
      store.redo = [];
      store.last = textarea.value;
      updateTextUndoButtons(textarea);
    }

    function undoCaptureInput() {
      undoTextareaUndo(document.getElementById('input-content'));
    }
    function redoCaptureInput() {
      redoTextareaUndo(document.getElementById('input-content'));
    }
    function undoBlocksEditor() {
      undoTextareaUndo(document.getElementById('check-blocks-editor'));
    }
    function redoBlocksEditor() {
      redoTextareaUndo(document.getElementById('check-blocks-editor'));
    }

    function enqueueInputHistoryDeleteSync(task, options) {
      options = options || {};
      const maxAttempts = Math.max(1, Number(options.maxAttempts) || INPUT_HISTORY_DELETE_MAX_ATTEMPTS);
      const label = options.label || '削除';
      const run = async () => {
        inputHistoryDeleteRunning++;
        let lastErr = null;
        try {
          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
              await task();
              lastErr = null;
              return;
            } catch (err) {
              lastErr = err;
              console.warn(`input history delete sync attempt ${attempt + 1}/${maxAttempts} failed`, err);
              if (attempt < maxAttempts - 1) {
                await new Promise((r) => setTimeout(r, 280 + attempt * 320));
              }
            }
          }
          if (lastErr) throw lastErr;
        } finally {
          inputHistoryDeleteRunning = Math.max(0, inputHistoryDeleteRunning - 1);
        }
      };
      const next = inputHistoryDeleteChain.then(run, run);
      inputHistoryDeleteChain = next.then(() => { }, () => { });
      next.catch((err) => {
        console.error('Input history delete sync failed after retries:', err);
        if (typeof options.onFinalFail === 'function') {
          options.onFinalFail(err);
        } else {
          showInputHistoryDeleteStatus(
            `${label}は端末に反映済みです。クラウド同期は後で再試行されます`,
            'error'
          );
        }
      });
      return next;
    }

    let crossDeviceSyncing = false;
    let crossDeviceLastPullAt = 0;
    let crossDeviceLastDeepAt = 0;
    let crossDeviceLastStoredRefreshAt = 0;
    let crossDeviceLastHistoryForceAt = 0;
    let crossDeviceLastStamp = '';
    let crossDevicePollTimer = null;
    const CROSS_DEVICE_MIN_GAP_MS = 1200;
    const CROSS_DEVICE_POLL_MS = 12000;
    const CROSS_DEVICE_DEEP_GAP_MS = 35000;
    const CROSS_DEVICE_STORED_REFRESH_GAP_MS = 25000;
    const CROSS_DEVICE_HISTORY_FORCE_GAP_MS = 16000;
    const ORGANIZER_SHARED_TTL_MS = 5000;
    let organizerDataShared = { data: null, fetchedAt: 0, promise: null };

    const pollSeenStamps = new Map();
    async function checkPollStampChanged(scopeKey) {
      try {
        const res = await callAPI('getSyncStamp', {}, { silent: true });
        const stamp = res && res.stamp != null ? String(res.stamp) : '';
        if (!stamp) return true;
        const prev = pollSeenStamps.get(scopeKey);
        pollSeenStamps.set(scopeKey, stamp);
        if (!prev) return true;
        return prev !== stamp;
      } catch (_) {
        return true;
      }
    }

    /** __SYSTEM__ スナップショットのインプレース更新（ゴミ箱肥大化防止） */
    async function upsertSystemSnapshotRecord({ cloudId, extraIds, folder, file, content }) {
      const targetId = cloudId ? String(cloudId) : '';
      const extras = Array.isArray(extraIds)
        ? extraIds.map((id) => String(id || '')).filter((id) => id && id !== targetId)
        : [];
      if (targetId) {
        const upd = await callAPI('updateDataRecord', {
          id: targetId,
          folder,
          file,
          content
        }, { silent: true });
        if (upd && upd.success && !upd.error) {
          if (extras.length) {
            callAPI('deleteDataRecords', { ids: extras }, { silent: true }).catch(() => { });
          }
          return { success: true, id: targetId };
        }
        if (!upd || upd.error !== 'not_found') {
          throw new Error('system_snapshot_update_failed');
        }
      }
      const addRes = await callAPI('addDataRecord', { folder, file, content }, { silent: true });
      if (!addRes || !addRes.success || !addRes.id) {
        throw new Error('system_snapshot_add_failed');
      }
      const newId = String(addRes.id);
      const toDel = (targetId ? [targetId, ...extras] : extras).filter((id) => id && id !== newId);
      if (toDel.length) {
        callAPI('deleteDataRecords', { ids: toDel }, { silent: true }).catch(() => { });
      }
      return { success: true, id: newId };
    }

    async function fetchOrganizerDataShared(options) {
      options = options || {};
      const fresh = !!options.fresh;
      const silent = options.silent !== false;
      const now = Date.now();
      if (!fresh && organizerDataShared.data && (now - organizerDataShared.fetchedAt) < ORGANIZER_SHARED_TTL_MS) {
        return organizerDataShared.data;
      }
      if (organizerDataShared.promise) return organizerDataShared.promise;
      organizerDataShared.promise = callAPI(
        'getOrganizerData',
        fresh ? { fresh: true } : {},
        { silent }
      ).then((data) => {
        if (data && !data.error) {
          organizerDataShared.data = data;
          organizerDataShared.fetchedAt = Date.now();
        }
        return data;
      }).finally(() => {
        organizerDataShared.promise = null;
      });
      return organizerDataShared.promise;
    }

    function applyOrganizerData(data) {
      if (!data || data.error) return;
      configData = data.config || {};

      const folderSelect = document.getElementById('direct-folder');
      if (folderSelect) {
        const currentVal = folderSelect.value;
        renderDirectFolderOptions(currentVal);
      }

      const badge = document.getElementById('badge-count');
      if (badge) {
        // 整理タブ廃止後は件数表示しない（ハブ／サブタブ間に数字が出るのを防ぐ）
        badge.textContent = String(data.count || 0);
        badge.classList.add('hidden');
        badge.setAttribute('hidden', '');
        badge.style.display = 'none';
      }
      const organizeMode = document.getElementById('organize-mode');
      const remain = document.getElementById('remain-count');
      if (remain && organizeMode && organizeMode.classList.contains('hidden')) {
        remain.textContent = String(data.count || 0);
      }

      if (data.config) {
        const folders = Object.keys(data.config);
        const statNotes = document.getElementById('stat-total-notes');
        if (statNotes) statNotes.textContent = folders.length.toString();
      }
      if (typeof updateDumpDepthDisplay === 'function') updateDumpDepthDisplay();
    }

    async function syncOrganizerQuick(options) {
      options = options || {};
      const data = await fetchOrganizerDataShared({ fresh: !!options.fresh, silent: true });
      applyOrganizerData(data);
      return data;
    }

    function getActiveTabId() {
      const el = document.querySelector('.tab-content.active');
      return el ? el.id : '';
    }

    function setCrossDeviceSyncStatus(text, kind) {
      const el = document.getElementById('cross-device-sync-status');
      if (el) {
        if (kind === 'busy') {
          el.innerHTML = withSyncSpinHtml(text || '同期中');
        } else {
          el.textContent = text || '';
        }
        el.className = kind === 'error'
          ? 'block text-[11px] text-rose-400/90 font-bold mt-0.5'
          : kind === 'busy'
            ? 'block text-[11px] text-amber-300/90 font-bold mt-0.5'
            : 'block text-[11px] text-cyan-600/80 font-bold mt-0.5';
      }
      const title = text ? String(text) : '他の端末と今すぐ同期';
      const fab = document.getElementById('cross-device-sync-btn');
      if (fab) {
        fab.classList.toggle('is-syncing', kind === 'busy');
        fab.title = title;
      }
      const cap = document.getElementById('capture-sync-btn');
      if (cap) {
        cap.classList.toggle('is-syncing', kind === 'busy');
        cap.title = kind === 'busy' ? '更新中…' : '最新に更新';
      }
    }

    function canSilentRefreshOrganize() {
      const mode = document.getElementById('organize-mode');
      if (!mode || !mode.classList.contains('active')) return false;
      if (typeof organizeSourceType === 'string' && organizeSourceType !== 'inbox') return false;
      return !(Array.isArray(organizeInboxItems) && organizeInboxItems.length > 0);
    }

    async function refreshVisibleTabAfterSync(force) {
      const tab = getActiveTabId();
      if (tab === 'organize-mode' && canSilentRefreshOrganize() && typeof loadOrganizeData === 'function') {
        await loadOrganizeData({ silent: true });
        return;
      }
      if (tab === 'gantt-mode' && typeof syncGanttLibrary === 'function') {
        await syncGanttLibrary({ render: true });
        return;
      }
      if (tab === 'search-mode' && currentSearchTabMode === 'input_history' && typeof showInputHistory === 'function') {
        await showInputHistory({ keepList: true });
        return;
      }
      if (tab === 'input-mode' && typeof paintInputTabHistory === 'function') {
        // クラウド分は pullCrossDeviceSync 側で取得済みなので、ここでは再描画のみ
        const history = typeof pruneStaleLocalInputHistory === 'function'
          ? pruneStaleLocalInputHistory()
          : getLocalInputHistory();
        paintInputTabHistory(history);
        return;
      }
      if (tab === 'tree-mode' && typeof syncTreeLibrary === 'function') {
        await syncTreeLibrary({ render: true });
      }
    }

    async function pullCrossDeviceDeepSync(options) {
      options = options || {};
      const tab = options.tab || getActiveTabId();
      const silent = !!options.silent;
      const tasks = [];
      if (typeof syncProfileBirthState === 'function') tasks.push(syncProfileBirthState());
      if (typeof syncGanttLibrary === 'function') {
        if (!(typeof ganttShouldProtectLocal === 'function' && ganttShouldProtectLocal())) {
          tasks.push(syncGanttLibrary({ render: tab === 'gantt-mode' && !silent }));
        } else if (typeof ganttDirty !== 'undefined' && ganttDirty && typeof queueGanttCloudSync === 'function') {
          queueGanttCloudSync();
        }
      }
      if (typeof syncAbstinenceTimerState === 'function') {
        tasks.push(syncAbstinenceTimerState({ render: tab === 'abstinence-mode' && !silent }));
      }
      if (typeof syncAbstinenceSlips === 'function') {
        tasks.push(syncAbstinenceSlips({ render: tab === 'abstinence-mode' && !silent }));
      }
      if (typeof syncFavorites === 'function') {
        tasks.push(syncFavorites());
      }
      if (typeof syncSuppleData === 'function') {
        tasks.push(syncSuppleData({ render: tab === 'supplement-mode' && !silent }));
      }
      if (typeof syncTreeLibrary === 'function') {
        // ツリー編集中／未送信は deep sync で上書きしない
        if (!(typeof treeShouldProtectLocalEdits === 'function' && treeShouldProtectLocalEdits())) {
          tasks.push(syncTreeLibrary({ render: tab === 'tree-mode' && !silent }));
        } else if (typeof treeLibraryDirty !== 'undefined' && treeLibraryDirty
          && typeof queueTreeLibraryCloudSync === 'function') {
          queueTreeLibraryCloudSync();
        }
      }
      await Promise.all(tasks);
      if (tab === 'gantt-mode' && !silent && typeof syncGanttLibrary === 'function') {
        if (!(typeof ganttShouldProtectLocal === 'function' && ganttShouldProtectLocal())) {
          await syncGanttLibrary({ render: true });
        }
      }
    }

    async function pullCrossDeviceSync(options) {
      options = options || {};
      const force = !!options.force;
      const light = options.light === true || options.reason === 'poll';
      const now = Date.now();
      if (crossDeviceSyncing) return false;
      if (isSubmittingInbox) return false;
      // DUMP／未同期書き込み中は自動同期を避ける（競合で同期中が伸び・DUMPが待たされる）
      if (!force && typeof inboxWriteRunning === 'number' && inboxWriteRunning > 0) return false;
      if (!force && typeof countPendingInboxWrites === 'function' && countPendingInboxWrites() > 0) return false;
      if (typeof isLoaderVisible === 'function' && isLoaderVisible() && !force) return false;
      if (!force && (now - crossDeviceLastPullAt) < CROSS_DEVICE_MIN_GAP_MS) return false;
      crossDeviceSyncing = true;
      crossDeviceLastPullAt = now;
      setCrossDeviceSyncStatus('同期中…', 'busy');
      try {
        const isManual = options.reason === 'manual';
        // ポーリングは安いスタンプだけで変化確認（不変なら organizer / history を呼ばない）
        if (light && !force && !isManual) {
          try {
            const stampRes = await callAPI('getSyncStamp', {}, { silent: true });
            const stamp = stampRes && stampRes.stamp != null ? String(stampRes.stamp) : '';
            if (stamp && crossDeviceLastStamp && stamp === crossDeviceLastStamp) {
              const keep = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
              setCrossDeviceSyncStatus('同期済み ' + keep, 'ok');
              return true;
            }
            if (stamp) crossDeviceLastStamp = stamp;
          } catch (stampErr) {
            // 旧 GAS 未対応時は通常同期へフォールバック
          }
        }
        if (force || isManual) {
          if (storedItemsCache) storedItemsCache.fetchedAt = 0;
          organizerDataShared.fetchedAt = 0;
        }
        // 保存済みデータの全件再取得は重いので手動同期のときだけ（自動同期で連発するとDUMP書き込みと競合する）
        if (isManual && typeof invalidateStoredItemsCache === 'function'
          && (now - crossDeviceLastStoredRefreshAt) >= CROSS_DEVICE_STORED_REFRESH_GAP_MS) {
          crossDeviceLastStoredRefreshAt = now;
          invalidateStoredItemsCache();
        }
        const tab = getActiveTabId();
        const fastTasks = [syncOrganizerQuick({ fresh: force || isManual })];
        if (typeof syncLiveInputDraftWithCloud === 'function') {
          fastTasks.push(syncLiveInputDraftWithCloud({ reason: options.reason || 'sync' }).catch(() => false));
        }
        if (typeof syncInputTabHistoryFromCloud === 'function') {
          // 編集の取りこぼしを減らすため、表示中／手動以外でも履歴は短間隔で強制取得
          const forceHistory = force || isManual || !light
            || (now - (crossDeviceLastHistoryForceAt || 0)) >= CROSS_DEVICE_HISTORY_FORCE_GAP_MS;
          if (forceHistory) crossDeviceLastHistoryForceAt = now;
          fastTasks.push(syncInputTabHistoryFromCloud({ force: forceHistory }));
        }
        const orgData = await Promise.all(fastTasks).then((results) => results[0]);
        if (typeof reconcileLocalHistoryWithDumpSources === 'function'
          && !(typeof hasPendingHistoryReplaceJobs === 'function' && hasPendingHistoryReplaceJobs())) {
          const healed = reconcileLocalHistoryWithDumpSources(orgData);
          if (healed && tab === 'input-mode' && typeof paintInputTabHistory === 'function') {
            paintInputTabHistory(getLocalInputHistory());
          }
        }
        if (!light) await refreshVisibleTabAfterSync(force);
        const stamp = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        // フル同期後にスタンプを更新（次回 poll の早期 return 用）
        if (!light || force || isManual) {
          try {
            const stampRes = await callAPI('getSyncStamp', {}, { silent: true });
            if (stampRes && stampRes.stamp != null) crossDeviceLastStamp = String(stampRes.stamp);
          } catch (_) { }
        }
        // 起動直後は履歴と整理データだけで足りる。ツリーやガントは開いたときに取る
        const runDeep = options.reason !== 'boot' && (force || isManual || (now - crossDeviceLastDeepAt) >= CROSS_DEVICE_DEEP_GAP_MS);
        if (runDeep) {
          crossDeviceLastDeepAt = now;
          if (isManual) {
            await pullCrossDeviceDeepSync({ tab, silent: false });
            setCrossDeviceSyncStatus('同期済み ' + stamp, 'ok');
          } else {
            setCrossDeviceSyncStatus('同期済み ' + stamp, 'ok');
            runInBackground(() => pullCrossDeviceDeepSync({ tab, silent: light }));
          }
        } else {
          setCrossDeviceSyncStatus('同期済み ' + stamp, 'ok');
        }
        return true;
      } catch (e) {
        setCrossDeviceSyncStatus('同期に失敗（端末内データを使用）', 'error');
        return false;
      } finally {
        crossDeviceSyncing = false;
      }
    }

    function requestCrossDeviceSync(options) {
      pullCrossDeviceSync(options || { force: true, reason: 'manual' })
        .catch(() => { });
    }

    function parseDumpBuildNum(value) {
      const m = String(value || '').match(/v(\d+)/i);
      return m ? parseInt(m[1], 10) : 0;
    }

    function waitForInstallingWorker(reg, timeoutMs) {
      return new Promise((resolve) => {
        if (!reg) {
          resolve(null);
          return;
        }
        if (reg.waiting) {
          resolve(reg.waiting);
          return;
        }
        let settled = false;
        const finish = (worker) => {
          if (settled) return;
          settled = true;
          resolve(worker || null);
        };
        const timer = setTimeout(() => finish(reg.waiting || null), timeoutMs);
        const watch = (worker) => {
          if (!worker) return;
          const onState = () => {
            if (worker.state === 'installed') {
              clearTimeout(timer);
              finish(worker);
            } else if (worker.state === 'redundant') {
              clearTimeout(timer);
              finish(reg.waiting || null);
            }
          };
          if (worker.state === 'installed') {
            clearTimeout(timer);
            finish(worker);
            return;
          }
          worker.addEventListener('statechange', onState);
        };
        if (reg.installing) watch(reg.installing);
        reg.addEventListener('updatefound', () => watch(reg.installing), { once: true });
      });
    }

    async function applyLatestAppBuildIfAny() {
      let remote = '';
      try {
        const res = await fetch('./version.json?ts=' + Date.now(), { cache: 'no-store' });
        if (res && res.ok) {
          const data = await res.json();
          remote = data && data.build ? String(data.build) : '';
        }
      } catch (_) { }
      const local = String(window.__DUMP_BUILD__ || '');
      const remoteN = parseDumpBuildNum(remote);
      const localN = parseDumpBuildNum(local);
      if (!remoteN || remoteN <= localN) return 'current';
      if (!('serviceWorker' in navigator)) {
        if (typeof allowAutoReload !== 'function' || allowAutoReload()) location.reload();
        return 'reloading';
      }
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg && typeof reg.update === 'function') await reg.update();
        const worker = await waitForInstallingWorker(reg, 8000);
        if (worker) {
          try { sessionStorage.setItem('sw_update_reload', '1'); } catch (_) { }
          worker.postMessage({ type: 'SKIP_WAITING' });
          return 'reloading';
        }
      } catch (_) { }
      if (typeof allowAutoReload !== 'function' || allowAutoReload()) location.reload();
      return 'reloading';
    }

    let dumpLatestUpdateRunning = false;

    function raceTimeout(promise, ms) {
      return Promise.race([
        Promise.resolve(promise).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), ms))
      ]);
    }

    /** 「最新」用: 同期後にアプリをいったん落として立ち上げ直す */
    async function hardRestartDumpApp() {
      try {
        sessionStorage.setItem('sw_update_reload', '1');
        sessionStorage.setItem('dump_manual_hard_restart', '1');
      } catch (_) { }

      // reg.update() を await すると返ってこずリロード不能になる端末があるので待たない
      try {
        if ('serviceWorker' in navigator) {
          const reg = await raceTimeout(navigator.serviceWorker.getRegistration(), 400);
          if (reg) {
            const worker = reg.waiting || reg.installing || null;
            if (worker) {
              try { worker.postMessage({ type: 'SKIP_WAITING' }); } catch (_) { }
            }
            try {
              if (typeof reg.update === 'function') void reg.update();
            } catch (_) { }
          }
        }
      } catch (_) { }

      // ユーザー操作の再起動はループガード対象外で必ずリロード
      try {
        location.reload();
        return;
      } catch (_) { }
      try {
        location.href = String(location.href);
      } catch (_) { }
    }

    async function updateDumpToLatest() {
      if (dumpLatestUpdateRunning) return;
      if (typeof isSubmittingInbox !== 'undefined' && isSubmittingInbox) {
        setCrossDeviceSyncStatus('保存中のため、少し待ってから更新してください', 'error');
        return;
      }
      // 自動同期中でも止めてしまわず、短く待ってから続行（以前は return だけでリロードされなかった）
      if (crossDeviceSyncing) {
        setCrossDeviceSyncStatus('更新中…', 'busy');
        const waitStart = Date.now();
        while (crossDeviceSyncing && Date.now() - waitStart < 4000) {
          await new Promise((r) => setTimeout(r, 120));
        }
      }
      dumpLatestUpdateRunning = true;
      const status = document.getElementById('input-status');
      const paint = (text, kind) => {
        setCrossDeviceSyncStatus(text, kind);
        if (!status) return;
        status.textContent = text || '';
        status.className = 'text-sm sm:text-base mt-1 text-center font-bold min-h-[18px] '
          + (kind === 'error' ? 'text-rose-300' : kind === 'busy' ? 'text-amber-300' : 'text-cyan-300');
      };
      paint('最新へ更新中…', 'busy');
      try {
        await raceTimeout(pullCrossDeviceSync({ force: true, reason: 'manual' }), 12000);
        if (typeof syncFavorites === 'function') {
          try { await raceTimeout(syncFavorites(), 4000); } catch (_) { }
        }
        if (typeof refreshCheckBlocksListIfVisible === 'function') refreshCheckBlocksListIfVisible();
        // 版の差が無くても、毎回アプリを再起動して表示・SWを立て直す
        paint('アプリを再起動します…', 'busy');
        try { await raceTimeout(applyLatestAppBuildIfAny(), 1500); } catch (_) { }
        await hardRestartDumpApp();
      } catch (_) {
        paint('更新に失敗したため、再起動します…', 'error');
        try { await hardRestartDumpApp(); } catch (__) {
          try { location.reload(); } catch (___) { }
        }
      } finally {
        // リロードされない場合だけ解除
        setTimeout(() => {
          dumpLatestUpdateRunning = false;
          const cap = document.getElementById('capture-sync-btn');
          if (cap) cap.classList.remove('is-syncing');
        }, 2500);
      }
    }
    window.updateDumpToLatest = updateDumpToLatest;
    window.hardRestartDumpApp = hardRestartDumpApp;

    function startCrossDevicePoll() {
      if (crossDevicePollTimer) return;
      crossDevicePollTimer = setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        checkStuckLoader();
        if (typeof refreshSubmitInboxAvailability === 'function') refreshSubmitInboxAvailability();
        requestCrossDeviceSync({ force: false, light: true, reason: 'poll' });
      }, CROSS_DEVICE_POLL_MS);
    }

    function stopCrossDevicePoll() {
      if (!crossDevicePollTimer) return;
      clearInterval(crossDevicePollTimer);
      crossDevicePollTimer = null;
    }

    function startCrossDeviceSyncWatchers() {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          requestCrossDeviceSync({ force: true, reason: 'visible' });
          if (typeof syncLiveInputDraftWithCloud === 'function') {
            syncLiveInputDraftWithCloud({ reason: 'visible' }).catch(() => { });
          }
          if (typeof resumePendingInboxWrites === 'function') resumePendingInboxWrites({ silent: false });
          startCrossDevicePoll();
          if (typeof startTreeLibraryPoll === 'function') startTreeLibraryPoll();
          if (typeof startFavoritesPoll === 'function') startFavoritesPoll();
          if (typeof syncFavorites === 'function') syncFavorites().catch(() => { });
          if (typeof syncTreeLibrary === 'function') {
            syncTreeLibrary({
              render: !!(document.getElementById('tree-mode')
                && document.getElementById('tree-mode').classList.contains('active'))
            }).catch(() => { });
          }
          if (typeof syncGanttLibrary === 'function') {
            syncGanttLibrary({
              render: !!(document.getElementById('gantt-mode')
                && document.getElementById('gantt-mode').classList.contains('active'))
            }).catch(() => { });
          }
        } else {
          // 即閉じ／他アプリへ切替でも INBOX 書き込みを届ける（Keep 相当）
          flushPendingWritesOnLeave();
          stopCrossDevicePoll();
          if (typeof stopTreeLibraryPoll === 'function') stopTreeLibraryPoll();
          if (typeof stopFavoritesPoll === 'function') stopFavoritesPoll();
          if (typeof publishFavorites === 'function') publishFavorites().catch(() => { });
          if (typeof publishTreeLibrary === 'function') {
            publishTreeLibrary().catch(() => { });
          }
          if (typeof publishGanttLibrary === 'function') {
            publishGanttLibrary().catch(() => { });
          }
        }
      });
      window.addEventListener('focus', () => {
        requestCrossDeviceSync({ force: true, reason: 'focus' });
      });
      window.addEventListener('pageshow', (ev) => {
        if (ev && ev.persisted) {
          if (typeof window.__dismissBootSplash === 'function') window.__dismissBootSplash(true);
          requestCrossDeviceSync({ force: true, reason: 'pageshow' });
          if (typeof syncLiveInputDraftWithCloud === 'function') {
            syncLiveInputDraftWithCloud({ reason: 'pageshow' }).catch(() => { });
          }
          if (typeof resumePendingInboxWrites === 'function') resumePendingInboxWrites({ silent: false });
        }
      });
      window.addEventListener('online', () => {
        requestCrossDeviceSync({ force: true, reason: 'online' });
        if (typeof syncLiveInputDraftWithCloud === 'function') {
          syncLiveInputDraftWithCloud({ reason: 'online' }).catch(() => { });
        }
        if (typeof resumePendingInboxWrites === 'function') resumePendingInboxWrites({ silent: false });
        if (typeof syncTreeLibrary === 'function') syncTreeLibrary({ render: false }).catch(() => { });
        if (typeof syncGanttLibrary === 'function') syncGanttLibrary({ render: false }).catch(() => { });
        if (typeof syncFavorites === 'function') syncFavorites().catch(() => { });
      });
      window.addEventListener('pagehide', () => {
        flushPendingWritesOnLeave();
        if (typeof publishTreeLibrary === 'function') publishTreeLibrary().catch(() => { });
        if (typeof publishGanttLibrary === 'function') publishGanttLibrary().catch(() => { });
        if (typeof publishFavorites === 'function') publishFavorites().catch(() => { });
      });
      // Page Lifecycle: フリーズ／閉じる直前にも送出
      window.addEventListener('freeze', () => {
        flushPendingWritesOnLeave();
      });
      window.addEventListener('beforeunload', () => {
        if (typeof flushLiveInputDraftOnLeave === 'function') {
          try { flushLiveInputDraftOnLeave(); } catch (_) { }
        }
      });
      startCrossDevicePoll();
      if (typeof startTreeLibraryPoll === 'function') startTreeLibraryPoll();
      if (typeof startFavoritesPoll === 'function') startFavoritesPoll();
      // お気に入り・ツリー・ガントの先読みは、最初の操作が終わってから
      const preloadSideLibraries = () => {
        if (typeof syncFavorites === 'function') syncFavorites().catch(() => { });
        if (typeof syncTreeLibrary === 'function') syncTreeLibrary({ render: false }).catch(() => { });
        if (typeof syncGanttLibrary === 'function') syncGanttLibrary({ render: false }).catch(() => { });
      };
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(preloadSideLibraries, { timeout: 2800 });
      } else {
        setTimeout(preloadSideLibraries, 2000);
      }
    }

    let inboxWriteChain = Promise.resolve();
    let inboxWriteRunning = 0;
    const cancelledDumpHistoryIds = new Set();
    function enqueueInboxWrite(task, { onError, historyId } = {}) {
      const run = async () => {
        inboxWriteRunning++;
        try {
          if (historyId && cancelledDumpHistoryIds.has(historyId)) return;
          return await task();
        } finally {
          inboxWriteRunning = Math.max(0, inboxWriteRunning - 1);
        }
      };
      const next = inboxWriteChain.then(run, run);
      inboxWriteChain = next.then(() => { }, () => { });
      next.catch((err) => {
        console.error('Inbox save failed:', err);
        if (typeof onError === 'function') onError(err);
      }).finally(() => {
        if (typeof applySubmitInboxEnabledState === 'function') applySubmitInboxEnabledState();
      });
    }
    async function flushInboxWriteChain() {
      if (inboxWriteRunning > 0) return;
      await inboxWriteChain;
    }

    const INPUT_PENDING_WRITES_KEY = 'input_pending_writes';
    const MAX_PENDING_INBOX_WRITES = 24;
    const MAX_PENDING_WRITE_ATTEMPTS = 12;
    const pendingWriteRunningIds = new Set();
    const pendingWriteQueuedIds = new Set();
    let pendingWriteResumeToken = 0;

    function markPendingWriteQueued(jobId) {
      if (jobId != null) pendingWriteQueuedIds.add(String(jobId));
    }
    function clearPendingWriteQueued(jobId) {
      if (jobId != null) pendingWriteQueuedIds.delete(String(jobId));
    }
    function isPendingWriteAlreadyQueued(jobId) {
      if (jobId == null) return false;
      const id = String(jobId);
      return pendingWriteQueuedIds.has(id) || pendingWriteRunningIds.has(id);
    }

    function makePendingWriteId() {
      return `pw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    function getPendingInboxWrites() {
      try {
        const raw = JSON.parse(localStorage.getItem(INPUT_PENDING_WRITES_KEY) || '[]');
        return Array.isArray(raw) ? raw.filter((j) => j && j.id && j.type) : [];
      } catch (e) {
        return [];
      }
    }

    function sanitizePendingJobForStorage(job) {
      if (!job) return job;
      if (!job.pendingImages) return job;
      const copy = { ...job };
      delete copy.pendingImages;
      return copy;
    }

    function savePendingInboxWrites(writes) {
      try {
        const safeList = (writes || []).slice(0, MAX_PENDING_INBOX_WRITES).map(sanitizePendingJobForStorage);
        localStorage.setItem(
          INPUT_PENDING_WRITES_KEY,
          JSON.stringify(safeList)
        );
      } catch (e) {
        console.warn('savePendingInboxWrites failed', e);
      }
    }

    function addPendingInboxWrite(job) {
      if (!job || !job.id) return;
      const list = getPendingInboxWrites().filter((j) => {
        if (!j || j.id === job.id) return false;
        if (job.type === 'history_replace' && j.type === 'history_replace'
          && job.pendingReplace && j.pendingReplace
          && String(j.pendingReplace.id) === String(job.pendingReplace.id)) return false;
        if (job.type === 'dump_add' && j.type === 'dump_add'
          && job.historyId && j.historyId === job.historyId) return false;
        return true;
      });
      list.unshift({
        ...job,
        attempts: Number(job.attempts) || 0,
        createdAt: job.createdAt || new Date().toISOString()
      });
      savePendingInboxWrites(list);
      schedulePendingWriteBackgroundSync();
    }

    function removePendingInboxWrite(jobId) {
      if (!jobId) return;
      const next = getPendingInboxWrites().filter((j) => j.id !== jobId);
      if (next.length !== getPendingInboxWrites().length) {
        savePendingInboxWrites(next);
        schedulePendingWriteBackgroundSync();
      }
    }

    function markPendingWritesKeepaliveSent(jobIds) {
      const idSet = new Set((jobIds || []).map(String).filter(Boolean));
      if (!idSet.size) return;
      let changed = false;
      const next = getPendingInboxWrites().map((j) => {
        if (!j || !idSet.has(String(j.id)) || j._keepaliveSent) return j;
        changed = true;
        return { ...j, _keepaliveSent: true, keepaliveSentAt: new Date().toISOString() };
      });
      if (changed) savePendingInboxWrites(next);
    }

    const PENDING_WRITES_CACHE = 'dump-pending-writes-v1';
    const PENDING_WRITES_CACHE_URL = './__pending_inbox_writes.json';
    let pendingWriteSyncTimer = null;

    function collectKeepaliveDumpChunks(writes) {
      const chunks = [];
      const jobIds = [];
      (writes || []).forEach((job) => {
        if (!job || job.type !== 'dump_add' || job.directFolder) return;
        // 実行中は callAPI(keepalive) に任せる（ここで重ねると二重化）
        if (pendingWriteRunningIds.has(job.id)) return;
        if (job._keepaliveSent) return;
        const parts = (job.addedChunks || []).filter((c) => c && String(c).trim());
        if (!parts.length) return;
        parts.forEach((c) => chunks.push(String(c)));
        jobIds.push(job.id);
      });
      // 同一本文は1回だけ送る
      const seen = new Set();
      const unique = [];
      chunks.forEach((c) => {
        const key = typeof dumpContentKey === 'function' ? dumpContentKey(c) : c;
        if (!key || seen.has(key)) return;
        seen.add(key);
        unique.push(c);
      });
      return { contents: unique, jobIds };
    }

    async function mirrorPendingWritesForServiceWorker() {
      if (!('caches' in window) || (!GAS_API_URL && !SUPABASE_RPC_URL)) return;
      try {
        const writes = getPendingInboxWrites().filter((j) => {
          if (!j) return false;
          if (j.type === 'dump_add' && !j.directFolder) return true;
          if (j.type === 'history_replace') return true;
          return false;
        });
        const cache = await caches.open(PENDING_WRITES_CACHE);
        const payload = {
          gasUrl: GAS_API_URL,
          supabaseRpcUrl: SUPABASE_RPC_URL,
          supabaseAnonKey: SUPABASE_ANON_KEY,
          updatedAt: Date.now(),
          writes: writes.map((j) => {
            if (j.type === 'history_replace') {
              return {
                id: j.id,
                type: j.type,
                newContent: j.newContent,
                destFolder: j.destFolder || 'INBOX',
                destFile: j.destFile || '未整理',
                dumpId: j.preResolvedDumpId || (j.pendingReplace && j.pendingReplace.dumpId) || '',
                dumpIsInbox: j.preResolvedDumpIsInbox != null
                  ? j.preResolvedDumpIsInbox
                  : (j.pendingReplace && j.pendingReplace.dumpIsInbox),
                historyId: j.pendingReplace && j.pendingReplace.id,
                keepaliveSent: !!j._keepaliveSent
              };
            }
            return {
              id: j.id,
              type: j.type,
              addedChunks: (j.addedChunks || []).slice(),
              keepaliveSent: !!j._keepaliveSent
            };
          })
        };
        await cache.put(
          PENDING_WRITES_CACHE_URL,
          new Response(JSON.stringify(payload), {
            headers: { 'Content-Type': 'application/json' }
          })
        );
      } catch (e) {
        console.warn('mirror pending writes for SW failed', e);
      }
    }

    function schedulePendingWriteBackgroundSync() {
      if (pendingWriteSyncTimer) clearTimeout(pendingWriteSyncTimer);
      pendingWriteSyncTimer = setTimeout(() => {
        pendingWriteSyncTimer = null;
        mirrorPendingWritesForServiceWorker().then(() => {
          if (!('serviceWorker' in navigator)) return;
          return navigator.serviceWorker.ready.then((reg) => {
            if (reg && reg.sync && typeof reg.sync.register === 'function') {
              return reg.sync.register('dump-pending-writes').catch(() => { });
            }
          });
        }).catch(() => { });
      }, 120);
    }

    function bumpPendingInboxWriteAttempt(jobId) {
      if (!jobId) return 0;
      let attempts = 0;
      const next = getPendingInboxWrites().map((j) => {
        if (j.id !== jobId) return j;
        attempts = (Number(j.attempts) || 0) + 1;
        return { ...j, attempts, lastAttemptAt: new Date().toISOString() };
      });
      savePendingInboxWrites(next);
      return attempts;
    }

    function countPendingInboxWrites() {
      return getPendingInboxWrites().length;
    }

    function showPendingWriteStatus(message, tone) {
      const status = document.getElementById('input-status');
      if (!status) return;
      status.textContent = message;
      if (tone === 'error') {
        status.className = 'text-base mt-2 text-center font-bold text-rose-400';
      } else if (tone === 'busy') {
        status.className = 'text-base mt-2 text-center font-bold text-cyan-300';
      } else {
        status.className = 'text-base mt-2 text-center font-bold text-emerald-400';
      }
    }

    async function trashExactDumpContentsInScope(contents, scope) {
      const list = (contents || []).map((c) => String(c || '').trim()).filter(Boolean);
      if (!list.length) return 0;
      let trashed = 0;
      const seenIds = new Set();
      for (const content of list) {
        let hits = [];
        try {
          hits = await findExactDumpHitsOnServer(content, scope || { inbox: true, anywhere: false });
        } catch (e) {
          console.warn('trashExactDumpContentsInScope scan failed', e);
          hits = [];
        }
        for (const hit of hits || []) {
          if (!hit || hit.id == null || isTempId(hit.id)) continue;
          const id = String(hit.id);
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          await trashDumpMatch(hit);
          trashed += 1;
        }
        if (hits && hits.length) {
          forgetDumpedItemsByContents([content], { includeStored: true });
        }
      }
      return trashed;
    }

    async function filterDumpChunksMissingOnServer(chunks, scope) {
      const list = (chunks || []).map((c) => String(c || '').trim()).filter(Boolean);
      if (!list.length) return [];
      scope = scope || { inbox: true, anywhere: true };

      // INBOX: 1回の organizer 取得でまとめて判定（件ごとの fresh 取得は遅い）
      if (scope.inbox !== false && !scope.folder) {
        try {
          const data = typeof fetchOrganizerDataShared === 'function'
            ? await fetchOrganizerDataShared({ fresh: true })
            : await callAPI('getOrganizerData', { fresh: true }, { silent: true });
          const existing = new Set();
          (data && Array.isArray(data.inbox) ? data.inbox : []).forEach((row) => {
            const key = dumpContentKey(row && row.content);
            if (key) existing.add(key);
          });
          return list.filter((c) => !existing.has(dumpContentKey(c)));
        } catch (e) {
          console.warn('bulk inbox missing check failed; writing all', e);
          return list;
        }
      }

      // 直接保存先: ファイル単位で1回取得
      if (scope.folder && scope.file) {
        try {
          const items = await callAPI('getFolderFileItems', {
            folder: scope.folder,
            file: scope.file
          }, { silent: true });
          const existing = new Set();
          (Array.isArray(items) ? items : []).forEach((row) => {
            const key = dumpContentKey(row && row.content);
            if (key) existing.add(key);
          });
          return list.filter((c) => !existing.has(dumpContentKey(c)));
        } catch (e) {
          console.warn('bulk folder missing check failed; writing all', e);
          return list;
        }
      }

      const missing = [];
      for (const content of list) {
        const hits = await findExactDumpHitsOnServer(content, scope);
        if (!hits.length) missing.push(content);
      }
      return missing;
    }

    function isInputHistoryStoreReadyLocally() {
      if (inputHistoryStoreEnsured) return true;
      try {
        if (localStorage.getItem('input_history_cloud_migrated') === 'true'
          || localStorage.getItem('input_history_store_ready') === '1'
          || (cloudInputHistoryCache && cloudInputHistoryCache.live)) {
          inputHistoryStoreEnsured = true;
          return true;
        }
      } catch (_) { }
      return false;
    }

    function markInputHistoryStoreReady() {
      inputHistoryStoreEnsured = true;
      try { localStorage.setItem('input_history_store_ready', '1'); } catch (_) { }
    }

    function buildInputHistoryCloudItems(contents, folder, file) {
      const chunks = (contents || [])
        .filter((c) => c && String(c).trim())
        .filter((c) => typeof isUsableInputHistoryContent === 'function' ? isUsableInputHistoryContent(c) : true);
      if (!chunks.length) return [];
      chunks.forEach((content) => {
        if (typeof clearInputHistoryTombstoneForContent === 'function') {
          clearInputHistoryTombstoneForContent(content);
        }
      });
      return chunks.map((content) => {
        const encoded = typeof encodeInputHistoryPayload === 'function'
          ? encodeInputHistoryPayload(content, folder, file)
          : '';
        if (!encoded) return null;
        return { folder: '__SYSTEM__', file: 'input_history', content: encoded };
      }).filter(Boolean);
    }

    /** 登録チェックのクラウド同期は DUMP 本体と切り離す（「同期中」が長く残るのを防ぐ） */
    function enqueueInputHistoryCloudSync(contents, folder, file) {
      const chunks = (contents || []).filter((c) => c && String(c).trim());
      if (!chunks.length) return;
      runInBackground(async () => {
        await syncInputHistoryToCloud(chunks, folder, file);
      }, {
        onError: (err) => console.warn('deferred input history cloud sync failed', err)
      });
    }

    async function reverseHistoryReplaceOnServer(job) {
      if (!job) return;
      let dumpId = (job.preResolvedDumpId && !isTempId(job.preResolvedDumpId)
        ? String(job.preResolvedDumpId)
        : '')
        || (job.pendingReplace && job.pendingReplace.dumpId && !isTempId(job.pendingReplace.dumpId)
          ? String(job.pendingReplace.dumpId)
          : '');
      const oldContent = String(job.oldContent || '').trim();
      const newContent = String(job.newContent || '').trim();
      const contentUnchanged = dumpContentEquals(oldContent, newContent);

      if (!dumpId && typeof findExactDumpHitsOnServer === 'function') {
        try {
          const hits = await findExactDumpHitsOnServer(newContent || oldContent, {
            inbox: !!job.isInboxDest,
            folder: job.isInboxDest ? null : job.destFolder,
            file: job.isInboxDest ? null : job.destFile,
            anywhere: true
          });
          if (hits && hits[0] && hits[0].id && !isTempId(hits[0].id)) {
            dumpId = String(hits[0].id);
          }
        } catch (e) {
          console.warn('reverse dumpId lookup failed', e);
        }
      }

      if (dumpId) {
        if (!contentUnchanged && oldContent) {
          await updateDumpByKnownId(dumpId, oldContent, !!job.origInbox);
        }
        if (job.destChanged && typeof moveDumpMatchToDest === 'function') {
          await moveDumpMatchToDest(
            {
              id: dumpId,
              content: oldContent || newContent,
              isInbox: !!job.isInboxDest,
              folder: job.destFolder,
              file: job.destFile
            },
            job.origFolder,
            job.origFile,
            !!job.origInbox
          );
        }
      }
      const histId = job.pendingReplace && job.pendingReplace.id;
      if (histId && typeof isLocalOnlyHistoryId === 'function' && !isLocalOnlyHistoryId(histId)
        && typeof encodeInputHistoryPayload === 'function') {
        const payload = encodeInputHistoryPayload(
          oldContent || newContent,
          job.origFolder || 'INBOX',
          job.origFile || '未整理',
          new Date().toISOString()
        );
        if (payload) {
          await callAPI('updateDataRecord', { id: String(histId), content: payload }, { silent: true });
        }
      }
    }

    async function executeHistoryReplaceJob(job) {
      if (job.historyId && cancelledDumpHistoryIds.has(job.historyId)) {
        return { cancelled: true };
      }
      if (job.pendingImages && job.pendingImages.length) {
        try {
          const byId = await uploadPendingImagesForJob(job.pendingImages, (info) => {
            const extra = '写真 ' + info.index + '/' + info.total + (info.phase ? ' ' + info.phase : '');
            if (typeof updateSyncGaugeImageProgress === 'function') {
              updateSyncGaugeImageProgress(job.id, extra);
            }
          });
          if (byId) {
            job.newContent = replaceDumpImagePlaceholders(job.newContent, byId);
            replaceImagePlaceholdersInLocalHistoryAndCache(byId);
          }
          job.pendingImages.forEach((img) => {
            if (img && img.blobUrl && String(img.blobUrl).indexOf('blob:') === 0) {
              try { URL.revokeObjectURL(img.blobUrl); } catch (_) { }
            }
            localPendingImagesMap.delete(img.id);
          });
          delete job.pendingImages;
          if (typeof updateSyncGaugeImageProgress === 'function') {
            updateSyncGaugeImageProgress(job.id, '保存中…');
          }
        } catch (imgErr) {
          console.warn('Background history replace image upload failed', imgErr);
          if (typeof updateSyncGaugeImageProgress === 'function') {
            updateSyncGaugeImageProgress(job.id, '');
          }
          const code = String((imgErr && (imgErr.code || imgErr.message)) || '');
          throw Object.assign(new Error('image_upload_failed: ' + code), { code, isImageError: true });
        }
      }
      const pendingReplace = job.pendingReplace;
      const oldContent = String(job.oldContent || '').trim();
      const newContent = String(job.newContent || '').trim();
      const destFolder = job.destFolder || 'INBOX';
      const destFile = job.destFile || '未整理';
      const isInboxDest = !!job.isInboxDest;
      if (!pendingReplace || !newContent) throw new Error('invalid_job');
      try {
        const stored = getPendingInboxWrites().find((j) => j && j.id === job.id);
        if (stored && stored._keepaliveSent) job._keepaliveSent = true;
      } catch (_) { }

      const preferredDumpId = job.preResolvedDumpId || pendingReplace.dumpId || '';
      const preferredIsInbox = job.preResolvedDumpIsInbox != null
        ? job.preResolvedDumpIsInbox
        : pendingReplace.dumpIsInbox;

      // dumpId が無い／仮IDのときは旧本文から実IDを拾って上書きする（新規追加にしない）
      let resolvedDumpId = preferredDumpId && !isTempId(preferredDumpId) ? String(preferredDumpId) : '';
      let resolvedIsInbox = preferredIsInbox;
      if (!resolvedDumpId && oldContent) {
        try {
          const oldHits = await withTimeout(
            findExactDumpHitsOnServer(oldContent, {
              inbox: true,
              folder: job.origInbox ? null : job.origFolder,
              file: job.origInbox ? null : job.origFile,
              anywhere: true
            }),
            6000,
            'resolve_old_dump'
          );
          if (oldHits && oldHits[0] && oldHits[0].id && !isTempId(oldHits[0].id)) {
            resolvedDumpId = String(oldHits[0].id);
            resolvedIsInbox = !!(oldHits[0].isInbox || historyDestIsInbox(oldHits[0].folder));
            job.preResolvedDumpId = resolvedDumpId;
            job.preResolvedDumpIsInbox = resolvedIsInbox;
            pendingReplace.dumpId = resolvedDumpId;
            pendingReplace.dumpIsInbox = resolvedIsInbox;
          }
        } catch (e) {
          console.warn('resolve dump id from old content failed', e);
        }
      }

      const contentUnchanged = dumpContentEquals(oldContent, newContent);

      // dumpId がある場合は先に ID 上書き（ネットワーク重いスマホ向け）
      if (resolvedDumpId) {
        const byId = await updateDumpByKnownId(resolvedDumpId, newContent, resolvedIsInbox);
        if (byId.success) {
          if (!contentUnchanged) {
            forgetDumpedItemsByContents([oldContent], { includeStored: true });
          }
          rememberDumpedItems([{
            id: resolvedDumpId,
            content: newContent,
            timestamp: new Date().toISOString(),
            folder: isInboxDest ? '📥 INBOX' : destFolder,
            file: isInboxDest ? '未整理' : destFile,
            isInbox: isInboxDest
          }]);
          if (!contentUnchanged) {
            // 旧重複の掃除は同期待ちから外し、バックグラウンド非同期で処理（保存完了ゲージをブロックしない）
            void (async () => {
              try {
                const oldHits = await withTimeout(
                  findExactDumpHitsOnServer(oldContent, {
                    inbox: true,
                    folder: job.origInbox ? null : job.origFolder,
                    file: job.origInbox ? null : job.origFile,
                    anywhere: true
                  }),
                  6000,
                  'old_hits'
                );
                await trashExactDumpHits(oldHits, resolvedDumpId);
              } catch (e) {
                console.warn('cleanup old hits after id-update failed', e);
              }
            })();
          }
          await finalizeInputHistoryReplaceCloud(oldContent, newContent, pendingReplace, destFolder, destFile);
          if (job.destChanged && typeof moveDumpMatchToDest === 'function') {
            try {
              await moveDumpMatchToDest(
                {
                  id: resolvedDumpId,
                  isInbox: job.origInbox,
                  folder: job.origFolder,
                  file: job.origFile
                },
                destFolder,
                destFile,
                isInboxDest
              );
            } catch (e) {
              console.warn('move dump after history edit', e);
            }
          }
          if (typeof syncFavoriteAfterEdit === 'function') {
            syncFavoriteAfterEdit({
              oldId: resolvedDumpId,
              newId: resolvedDumpId,
              oldContent,
              newContent,
              folder: destFolder,
              file: destFile,
              isInbox: isInboxDest
            });
          }
          if (typeof updateBadge === 'function') updateBadge();
          return { savedMatch: { id: resolvedDumpId, isInbox: isInboxDest }, updatedInPlace: true, byId: true };
        }
      }

      const verifyScope = {
        inbox: isInboxDest,
        folder: isInboxDest ? null : destFolder,
        file: isInboxDest ? null : destFile,
        anywhere: !isInboxDest
      };
      let alreadySaved = [];
      try {
        alreadySaved = await withTimeout(
          findExactDumpHitsOnServer(newContent, verifyScope),
          6000,
          'already_saved'
        );
      } catch (e) {
        console.warn('alreadySaved scan timed out', e);
        // タイムアウト時に新規追加へ進むと他端末保存と二重になるので、短い再試行を1回
        try {
          alreadySaved = await withTimeout(
            findExactDumpHitsOnServer(newContent, verifyScope),
            8000,
            'already_saved_retry'
          );
        } catch (e2) {
          console.warn('alreadySaved retry failed', e2);
        }
      }
      let syncedMatch = null;
      if (alreadySaved.length && resolvedDumpId) {
        syncedMatch = alreadySaved.find((hit) => String(hit.id) === String(resolvedDumpId)) || null;
      } else if (alreadySaved.length === 1) {
        syncedMatch = alreadySaved[0];
      } else if (alreadySaved.length > 1) {
        // 同一本文が複数ある場合も新規追加せず先頭を採用（増殖停止）
        syncedMatch = alreadySaved[0];
      }
      if (syncedMatch && dumpContentEquals(syncedMatch.content, newContent)) {
        if (!dumpContentEquals(oldContent, newContent)) {
          const oldHits = await findExactDumpHitsOnServer(oldContent, {
            inbox: true,
            folder: job.origInbox ? null : job.origFolder,
            file: job.origInbox ? null : job.origFile,
            anywhere: true
          });
          await trashExactDumpHits(oldHits, syncedMatch.id);
        }
        if (!contentUnchanged) forgetDumpedItemsByContents([oldContent], { includeStored: true });
        rememberDumpedItems([{
          id: syncedMatch.id,
          content: newContent,
          timestamp: new Date().toISOString(),
          folder: syncedMatch.isInbox ? '📥 INBOX' : (syncedMatch.folder || destFolder),
          file: syncedMatch.isInbox ? '未整理' : (syncedMatch.file || destFile),
          isInbox: !!syncedMatch.isInbox
        }]);
        await finalizeInputHistoryReplaceCloud(oldContent, newContent, pendingReplace, destFolder, destFile);
        if (typeof syncFavoriteAfterEdit === 'function') {
          syncFavoriteAfterEdit({
            oldId: resolvedDumpId || pendingReplace.dumpId || syncedMatch.id,
            newId: syncedMatch.id,
            oldContent,
            newContent,
            folder: syncedMatch.isInbox ? 'INBOX' : (syncedMatch.folder || destFolder),
            file: syncedMatch.isInbox ? '未整理' : (syncedMatch.file || destFile),
            isInbox: !!syncedMatch.isInbox
          });
        }
        if (typeof updateBadge === 'function') updateBadge();
        return { savedMatch: syncedMatch, updatedInPlace: true, alreadySynced: true };
      }

      let match = null;
      if (job.preResolvedDumpId && !isTempId(job.preResolvedDumpId)) {
        match = await resolveDumpByIdFresh(job.preResolvedDumpId, job.preResolvedDumpIsInbox);
      }
      if (!match) {
        match = await resolvePendingDumpMatch(pendingReplace, { flush: false });
      }

      const result = await replaceStoredDumpOnServer({
        oldContent,
        newContent,
        destFolder,
        destFile,
        isInboxDest,
        pendingReplace,
        preResolvedMatch: match
      });
      if (result && result.keptId && !isTempId(result.keptId)) {
        pendingReplace.dumpId = String(result.keptId);
        pendingReplace.dumpIsInbox = isInboxDest;
        if (typeof bindDumpIdsToContents === 'function') {
          bindDumpIdsToContents([{
            id: String(result.keptId),
            content: newContent,
            isInbox: isInboxDest
          }], {
            folder: destFolder,
            file: destFile,
            isInbox: isInboxDest
          });
        }
      }
      const verifyHits = await findExactDumpHitsOnServer(newContent, {
        inbox: isInboxDest,
        folder: isInboxDest ? null : destFolder,
        file: isInboxDest ? null : destFile,
        anywhere: !isInboxDest
      });
      if (!verifyHits.length) throw new Error('write');

      if (!contentUnchanged) forgetDumpedItemsByContents([oldContent], { includeStored: true });
      const savedMatch = verifyHits[0];
      const updatedInPlace = !!(result && result.updatedInPlace);
      const savedIsInbox = updatedInPlace && savedMatch ? !!savedMatch.isInbox : isInboxDest;
      const savedFolder = savedIsInbox
        ? '📥 INBOX'
        : (updatedInPlace && savedMatch ? (savedMatch.folder || destFolder) : destFolder);
      const savedFile = savedIsInbox
        ? '未整理'
        : (updatedInPlace && savedMatch ? (savedMatch.file || destFile) : destFile);
      const savedId = (savedMatch && savedMatch.id && !isTempId(savedMatch.id))
        ? String(savedMatch.id)
        : ((result && result.keptId) ? String(result.keptId) : makeTempId());
      if (savedId && !isTempId(savedId)) {
        pendingReplace.dumpId = savedId;
        pendingReplace.dumpIsInbox = savedIsInbox;
      }
      rememberDumpedItems([{
        id: savedId,
        content: newContent,
        timestamp: new Date().toISOString(),
        folder: savedFolder,
        file: savedFile,
        isInbox: savedIsInbox
      }]);
      if (typeof invalidateStoredItemsCache === 'function') {
        invalidateStoredItemsCache({
          ids: savedMatch && savedMatch.id ? [savedMatch.id] : [],
          contents: [oldContent]
        });
      }
      await finalizeInputHistoryReplaceCloud(oldContent, newContent, pendingReplace, destFolder, destFile);
      if (typeof syncFavoriteAfterEdit === 'function') {
        syncFavoriteAfterEdit({
          oldId: pendingReplace.dumpId || resolvedDumpId || savedId,
          newId: savedId,
          oldContent,
          newContent,
          folder: savedFolder,
          file: savedFile,
          isInbox: savedIsInbox
        });
      }
      if (typeof updateBadge === 'function') updateBadge();
      return { savedMatch, updatedInPlace };
    }

    function bindDumpIdsToContents(pairs, meta) {
      meta = meta || {};
      const list = (pairs || []).filter((p) => p && p.id && p.content && !isTempId(p.id));
      if (!list.length) return;
      const byContent = new Map();
      list.forEach((p) => {
        const key = dumpContentKey(p.content);
        if (key) byContent.set(key, p);
      });
      // 仮IDを落として実IDで覚え直す
      forgetDumpedItemsByContents(list.map((p) => p.content), { includeStored: true });
      rememberDumpedItems(list.map((p) => ({
        id: String(p.id),
        content: p.content,
        timestamp: new Date().toISOString(),
        folder: meta.isInbox ? '📥 INBOX' : (meta.folder || 'INBOX'),
        file: meta.isInbox ? '未整理' : (meta.file || '未整理'),
        isInbox: !!meta.isInbox
      })));
      const local = getLocalInputHistory();
      let changed = false;
      local.forEach((e) => {
        if (!e || !e.content) return;
        const hit = byContent.get(dumpContentKey(e.content));
        if (!hit) return;
        if (String(e.dumpId || '') !== String(hit.id)) {
          e.dumpId = String(hit.id);
          e.dumpIsInbox = meta.isInbox != null ? !!meta.isInbox : !!hit.isInbox;
          changed = true;
        }
      });
      if (changed) cacheLocalInputHistory(local);
      if (pendingInputHistoryReplace && pendingInputHistoryReplace.content) {
        const hit = byContent.get(dumpContentKey(pendingInputHistoryReplace.content));
        if (hit) {
          pendingInputHistoryReplace.dumpId = String(hit.id);
          pendingInputHistoryReplace.dumpIsInbox = meta.isInbox != null
            ? !!meta.isInbox
            : !!hit.isInbox;
        }
      }
    }

    async function resolveDumpIdsForContents(contents, scope) {
      const chunks = (contents || []).filter((c) => c && String(c).trim());
      const pairs = [];
      for (const content of chunks) {
        try {
          const hits = await findExactDumpHitsOnServer(content, scope || { inbox: true, anywhere: true });
          if (hits && hits[0] && hits[0].id) {
            pairs.push({ id: String(hits[0].id), content, isInbox: !!hits[0].isInbox });
          }
        } catch (e) {
          console.warn('resolveDumpIdsForContents failed', e);
        }
      }
      return pairs;
    }

    async function waitForPendingDumpWrites(content, timeoutMs) {
      const limit = Math.max(500, Number(timeoutMs) || 10000);
      const start = Date.now();
      const matchContent = (job) => {
        if (!job || job.type !== 'dump_add') return false;
        return (job.addedChunks || []).some((c) => dumpContentEquals(c, content));
      };
      while (Date.now() - start < limit) {
        const stillQueued = getPendingInboxWrites().some(matchContent);
        if (!stillQueued) return true;
        await new Promise((r) => setTimeout(r, 180));
      }
      return false;
    }

    async function executeDumpAddJob(job) {
      if (job.historyId && cancelledDumpHistoryIds.has(job.historyId)) return;
      if (job.pendingImages && job.pendingImages.length) {
        try {
          const byId = await uploadPendingImagesForJob(job.pendingImages, (info) => {
            const extra = '写真 ' + info.index + '/' + info.total + (info.phase ? ' ' + info.phase : '');
            if (typeof updateSyncGaugeImageProgress === 'function') {
              updateSyncGaugeImageProgress(job.id, extra);
            }
          });
          if (byId) {
            job.addedChunks = (job.addedChunks || []).map((chunk) => replaceDumpImagePlaceholders(chunk, byId));
            if (job.replaceDupChunks) {
              job.replaceDupChunks = job.replaceDupChunks.map((chunk) => replaceDumpImagePlaceholders(chunk, byId));
            }
            replaceImagePlaceholdersInLocalHistoryAndCache(byId);
          }
          job.pendingImages.forEach((img) => {
            if (img && img.blobUrl && String(img.blobUrl).indexOf('blob:') === 0) {
              try { URL.revokeObjectURL(img.blobUrl); } catch (_) { }
            }
            localPendingImagesMap.delete(img.id);
          });
          delete job.pendingImages;
          if (typeof updateSyncGaugeImageProgress === 'function') {
            updateSyncGaugeImageProgress(job.id, '保存中…');
          }
        } catch (imgErr) {
          console.warn('Background dump add image upload failed', imgErr);
          if (typeof updateSyncGaugeImageProgress === 'function') {
            updateSyncGaugeImageProgress(job.id, '');
          }
          const code = String((imgErr && (imgErr.code || imgErr.message)) || '');
          throw Object.assign(new Error('image_upload_failed: ' + code), { code, isImageError: true });
        }
      }
      // 閉じたあとの keepalive フラグをストレージから反映
      try {
        const stored = getPendingInboxWrites().find((j) => j && j.id === job.id);
        if (stored && stored._keepaliveSent) job._keepaliveSent = true;
      } catch (_) { }
      let addedChunks = (job.addedChunks || []).filter((c) => c && String(c).trim());
      if (!addedChunks.length) throw new Error('invalid_job');
      const destFolder = job.destFolder || 'INBOX';
      const destFile = job.destFile || '未整理';
      const isInboxDest = !!job.isInboxDest;
      const directFolder = job.directFolder || '';
      const originalChunks = addedChunks.slice();
      const replaceDupKeys = new Set(
        (job.replaceDupChunks || []).map((c) => dumpContentKey(c)).filter(Boolean)
      );
      const scope = directFolder
        ? { inbox: false, folder: directFolder, file: destFile, anywhere: false }
        : { inbox: isInboxDest, folder: isInboxDest ? null : destFolder, file: isInboxDest ? null : destFile, anywhere: false };
      // 初回はローカル重複チェック済みなので、受信箱の全件取得を待たない。
      // 再送や、閉じる直前に送った分の確認があるときだけサーバー既存を見る。
      const needServerDupCheck = Number(job.attempts) > 0 || !!job._keepaliveSent;
      if (needServerDupCheck) {
        const missing = await filterDumpChunksMissingOnServer(addedChunks, scope);
        const missingKeys = new Set(missing.map((c) => dumpContentKey(c)).filter(Boolean));
        // 置き換え対象はサーバーに残っていても捨てて書き直す
        addedChunks = addedChunks.filter((c) => {
          const key = dumpContentKey(c);
          return missingKeys.has(key) || replaceDupKeys.has(key);
        });
      }

      let purgedInboxCount = 0;
      let replacedDupCount = 0;
      let returnedIds = [];
      if (!addedChunks.length) {
        // keepalive 等で既に保存済み → ID紐付けは短時間・裏で（再送中表示を伸ばさない）
        runInBackground(async () => {
          try {
            const pairs = await withTimeout(
              resolveDumpIdsForContents(originalChunks, scope),
              1200,
              'resume_bind_ids'
            ).catch(() => []);
            bindDumpIdsToContents(pairs, {
              folder: destFolder,
              file: destFile,
              isInbox: isInboxDest
            });
          } catch (e) {
            console.warn('bind ids for already-synced dump failed', e);
          }
        });
        enqueueInputHistoryCloudSync(job.addedChunks || originalChunks, destFolder, destFile);
        if (job.pendingReplaceId) {
          enqueueInputHistoryDeleteSync(async () => {
            await removeInputHistoryEntry(job.pendingReplaceId);
          }, { label: '履歴整理' });
        }
        if (typeof updateBadge === 'function') updateBadge();
        return { purgedInboxCount: 0, replacedDupCount: 0, alreadySynced: true };
      }

      const toReplace = addedChunks.filter((c) => replaceDupKeys.has(dumpContentKey(c)));
      if (toReplace.length) {
        try {
          replacedDupCount = await trashExactDumpContentsInScope(toReplace, scope);
        } catch (e) {
          console.warn('trash exact dups before dump failed', e);
        }
      }

      const ops = [];
      let mainOpIndex = 0;
      let historyStoreOpIndex = -1;
      let historyWriteOpIndex = -1;

      if (directFolder) {
        if (!configData[directFolder]) configData[directFolder] = [];
        if (!configData[directFolder].includes(destFile)) {
          configData[directFolder].push(destFile);
          ops.push({ action: 'addConfigRecord', folder: directFolder, file: destFile });
        }
        mainOpIndex = ops.length;
        ops.push({
          action: 'addManyDataRecords',
          items: addedChunks.map((content) => ({ folder: directFolder, file: destFile, content }))
        });
      } else {
        mainOpIndex = ops.length;
        ops.push({ action: 'addManyInbox', contents: addedChunks });
      }

      const historyItems = buildInputHistoryCloudItems(addedChunks, destFolder, destFile);
      if (historyItems.length > 0) {
        if (!isInputHistoryStoreReadyLocally()) {
          historyStoreOpIndex = ops.length;
          ops.push({ action: 'addConfigRecord', folder: '__SYSTEM__', file: 'input_history' });
        }
        historyWriteOpIndex = ops.length;
        ops.push({ action: 'addManyDataRecords', items: historyItems });
      }

      let historySyncedInBatch = false;
      if (ops.length === 1) {
        const single = ops[0];
        const writeRes = await callAPI(single.action, single, { silent: true });
        assertWriteResult(writeRes, addedChunks.length);
        returnedIds = Array.isArray(writeRes && writeRes.ids) ? writeRes.ids.map(String) : [];
      } else {
        const batchRes = await callAPI('batch', { ops }, { silent: true });
        if (isApiFailure(batchRes) || !Array.isArray(batchRes && batchRes.results)) {
          assertWriteResult(batchRes, addedChunks.length);
        }
        const mainRes = batchRes.results[mainOpIndex];
        assertWriteResult(mainRes, addedChunks.length);
        returnedIds = Array.isArray(mainRes && mainRes.ids) ? mainRes.ids.map(String) : [];
        if (historyStoreOpIndex >= 0 && !isApiFailure(batchRes.results[historyStoreOpIndex])) {
          markInputHistoryStoreReady();
        }
        if (historyWriteOpIndex >= 0 && !isApiFailure(batchRes.results[historyWriteOpIndex])) {
          historySyncedInBatch = true;
          markInputHistoryStoreReady();
          if (typeof invalidateCloudInputHistoryCache === 'function') {
            invalidateCloudInputHistoryCache();
          }
        }
      }

      if (directFolder) {
        // purge は本体完了後に裏で（同期中を伸ばさない）
        runInBackground(async () => {
          try { await purgeInboxExactDuplicatesIfEnabled(); } catch (_) { }
        });
      }

      if (job.historyId && cancelledDumpHistoryIds.has(job.historyId)) {
        const matches = await findExactItemsForUndo(destFolder, destFile, addedChunks);
        if (matches.length) await trashItemsForUndo(matches);
        return { cancelled: true, purgedInboxCount, replacedDupCount };
      }

      // 実IDを登録チェック／編集に紐付け（直後の編集上書きのため）
      try {
        let pairs = [];
        if (returnedIds.length === addedChunks.length) {
          pairs = addedChunks.map((content, i) => ({
            id: returnedIds[i],
            content,
            isInbox: isInboxDest
          }));
          bindDumpIdsToContents(pairs, {
            folder: destFolder,
            file: destFile,
            isInbox: isInboxDest
          });
        } else {
          // IDが返らない旧GAS向け。本体完了を待たせない
          runInBackground(async () => {
            try {
              const found = await withTimeout(
                resolveDumpIdsForContents(addedChunks, scope),
                1500,
                'resolve_ids'
              ).catch(() => []);
              bindDumpIdsToContents(found, {
                folder: destFolder,
                file: destFile,
                isInbox: isInboxDest
              });
            } catch (e) {
              console.warn('bindDumpIds after dump failed', e);
            }
          });
        }
      } catch (e) {
        console.warn('bindDumpIds after dump failed', e);
      }

      // batch 内で履歴書き込みに失敗した場合のみフォールバック同期
      if (!historySyncedInBatch && historyItems.length > 0) {
        enqueueInputHistoryCloudSync(addedChunks, destFolder, destFile);
      }
      if (job.pendingReplaceId) {
        enqueueInputHistoryDeleteSync(async () => {
          await removeInputHistoryEntry(job.pendingReplaceId);
        }, { label: '履歴整理' });
      }
      if (typeof updateBadge === 'function') updateBadge();
      return { purgedInboxCount, replacedDupCount };
    }

    async function executePendingInboxWriteJob(job) {
      if (!job || !job.type) throw new Error('invalid_job');
      if (job.type === 'history_replace') return executeHistoryReplaceJob(job);
      if (job.type === 'dump_add') return executeDumpAddJob(job);
      throw new Error('unknown_job');
    }

    function dispatchKeepalivePost(bodyObj) {
      if (!bodyObj) return false;
      try {
        const obj = typeof bodyObj === 'string' ? JSON.parse(bodyObj) : bodyObj;
        const action = obj && obj.action ? String(obj.action) : '';
        const useSupabase = !!(SUPABASE_RPC_URL && SUPABASE_ANON_KEY && !GAS_ONLY_ACTIONS.has(action));
        if (useSupabase) {
          const sbBody = JSON.stringify({ payload: obj });
          if (sbBody.length > KEEPALIVE_BODY_MAX) return false;
          fetch(SUPABASE_RPC_URL, {
            method: 'POST',
            body: sbBody,
            keepalive: true,
            headers: {
              'Content-Type': 'application/json',
              'apikey': SUPABASE_ANON_KEY,
              'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
            }
          }).catch(() => { });
          return true;
        }
        if (!GAS_API_URL) return false;
        const body = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
        if (body.length > KEEPALIVE_BODY_MAX) return false;
        let dispatched = false;
        try {
          if (typeof navigator.sendBeacon === 'function') {
            const blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
            dispatched = !!navigator.sendBeacon(GAS_API_URL, blob);
          }
        } catch (_) { }
        if (!dispatched) {
          fetch(GAS_API_URL, {
            method: 'POST',
            body,
            keepalive: true,
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
          }).catch(() => { });
        }
        return true;
      } catch (e) {
        console.warn('keepalive post failed', e);
        return false;
      }
    }

    function tryKeepaliveHistoryReplaceJobs() {
      if (!GAS_API_URL && !SUPABASE_RPC_URL) return 0;
      const writes = getPendingInboxWrites().filter((job) => {
        if (!job || job.type !== 'history_replace') return false;
        if (pendingWriteRunningIds.has(job.id)) return false;
        if (job._keepaliveSent) return false;
        return true;
      });
      if (!writes.length) return 0;
      let sent = 0;
      for (const job of writes.slice(0, 3)) {
        const newContent = String(job.newContent || '').trim();
        if (!newContent) continue;
        const dumpId = job.preResolvedDumpId
          || (job.pendingReplace && job.pendingReplace.dumpId)
          || '';
        const preferInbox = job.preResolvedDumpIsInbox != null
          ? job.preResolvedDumpIsInbox
          : (job.pendingReplace && job.pendingReplace.dumpIsInbox);
        let ok = false;
        if (dumpId && !(typeof isTempId === 'function' && isTempId(dumpId))) {
          const action = preferInbox === false ? 'updateDataRecord' : 'updateInbox';
          ok = dispatchKeepalivePost({ action, id: String(dumpId), content: newContent }) || ok;
          if (action === 'updateInbox') {
            // INBOX で無い場合のフォールバック
            dispatchKeepalivePost({ action: 'updateDataRecord', id: String(dumpId), content: newContent });
          }
        }
        const histId = job.pendingReplace && job.pendingReplace.id;
        if (histId && typeof isLocalOnlyHistoryId === 'function' && !isLocalOnlyHistoryId(histId)
          && typeof encodeInputHistoryPayload === 'function') {
          const payload = encodeInputHistoryPayload(
            newContent,
            job.destFolder || 'INBOX',
            job.destFile || '未整理',
            new Date().toISOString()
          );
          if (payload) {
            ok = dispatchKeepalivePost({
              action: 'updateDataRecord',
              id: String(histId),
              content: payload
            }) || ok;
          }
        }
        if (ok) {
          markPendingWritesKeepaliveSent([job.id]);
          sent += 1;
        }
      }
      return sent;
    }

    function tryKeepalivePendingInboxWrite() {
      if (!GAS_API_URL && !SUPABASE_RPC_URL) return 0;
      let sent = tryKeepaliveHistoryReplaceJobs();
      const writes = getPendingInboxWrites();
      if (!writes.length) {
        if (sent) {
          mirrorPendingWritesForServiceWorker();
          schedulePendingWriteBackgroundSync();
        }
        return sent;
      }
      const { contents, jobIds } = collectKeepaliveDumpChunks(writes);
      if (!contents.length || !jobIds.length) {
        if (sent) {
          mirrorPendingWritesForServiceWorker();
          schedulePendingWriteBackgroundSync();
        }
        return sent;
      }
      try {
        const body = JSON.stringify({ action: 'addManyInbox', contents });
        if (body.length > KEEPALIVE_BODY_MAX) {
          // 大きい場合は先頭ジョブだけ分割送信
          for (const job of writes) {
            if (!job || job.type !== 'dump_add' || job.directFolder) continue;
            if (pendingWriteRunningIds.has(job.id) || job._keepaliveSent) continue;
            const parts = (job.addedChunks || []).filter((c) => c && String(c).trim());
            if (!parts.length) continue;
            const one = { action: 'addManyInbox', contents: parts };
            if (!dispatchKeepalivePost(one)) continue;
            markPendingWritesKeepaliveSent([job.id]);
            sent++;
            if (sent >= 4) break;
          }
          mirrorPendingWritesForServiceWorker();
          schedulePendingWriteBackgroundSync();
          return sent;
        }
        if (dispatchKeepalivePost(body)) {
          markPendingWritesKeepaliveSent(jobIds);
          sent += jobIds.length;
        }
        mirrorPendingWritesForServiceWorker();
        schedulePendingWriteBackgroundSync();
        return sent;
      } catch (e) {
        console.warn('keepalive pending write failed', e);
        schedulePendingWriteBackgroundSync();
        return sent;
      }
    }

    function flushPendingWritesOnLeave() {
      if (typeof flushLiveInputDraftOnLeave === 'function') {
        try { flushLiveInputDraftOnLeave(); } catch (_) { }
      }
      tryKeepalivePendingInboxWrite();
      try { mirrorPendingWritesForServiceWorker(); } catch (_) { }
      schedulePendingWriteBackgroundSync();
      if (typeof flushLocalInputHistoryCache === 'function') {
        try { flushLocalInputHistoryCache(); } catch (_) { }
      }
    }

    function resumePendingInboxWrites(options) {
      options = options || {};
      const writes = getPendingInboxWrites();
      if (!writes.length) return 0;
      const token = ++pendingWriteResumeToken;
      const toResume = writes.filter((job) => {
        if (!job || !job.id) return false;
        if (isPendingWriteAlreadyQueued(job.id)) return false;
        if ((Number(job.attempts) || 0) >= MAX_PENDING_WRITE_ATTEMPTS) {
          removePendingInboxWrite(job.id);
          clearPendingWriteQueued(job.id);
          return false;
        }
        return true;
      });
      if (!toResume.length) return 0;

      const showStatus = !options.silent && typeof isCaptureOverlayOpen === 'function' && isCaptureOverlayOpen();
      if (showStatus) {
        showPendingWriteStatus(`未同期 ${toResume.length}件を送信中…`, 'busy');
        // 表示は短く。実処理は裏で続行（長い「送信中」で固まったように見せない）
        setTimeout(() => {
          const status = document.getElementById('input-status');
          if (status && /未同期 .*送信中/.test(status.textContent || '')) {
            status.textContent = '';
          }
        }, 1400);
      }
      if (typeof ensureSubmitInboxReady === 'function') {
        ensureSubmitInboxReady({ force: true, reason: 'resume_pending' });
      }
      toResume.forEach((job) => {
        // 再送時のみサーバー重複チェック（keepalive 済みの二重書き込み防止）
        job._resumeCheck = true;
        markPendingWriteQueued(job.id);
        enqueueInboxWrite(async () => {
          if (token !== pendingWriteResumeToken && pendingWriteRunningIds.has(job.id)) return;
          pendingWriteRunningIds.add(job.id);
          try {
            await executePendingInboxWriteJob(job);
            removePendingInboxWrite(job.id);
            if (showStatus && token === pendingWriteResumeToken) {
              const left = countPendingInboxWrites();
              if (left === 0) {
                showPendingWriteStatus('✓ 未同期の保存が完了しました', 'ok');
                setTimeout(() => {
                  const status = document.getElementById('input-status');
                  if (status && status.textContent.includes('未同期の保存が完了')) status.textContent = '';
                }, 1800);
              }
            }
          } finally {
            pendingWriteRunningIds.delete(job.id);
            clearPendingWriteQueued(job.id);
            if (typeof ensureSubmitInboxReady === 'function') {
              ensureSubmitInboxReady({ force: true, reason: 'resume_pending_done' });
            }
            if (typeof countPendingInboxWrites === 'function' && countPendingInboxWrites() === 0
              && typeof syncInputTabHistoryFromCloud === 'function') {
              runInBackground(() => syncInputTabHistoryFromCloud({ force: true }));
            }
          }
        }, {
          onError: (err) => {
            clearPendingWriteQueued(job.id);
            const attempts = bumpPendingInboxWriteAttempt(job.id);
            console.warn('Pending inbox write failed', job.type, job.id, err);
            if (attempts >= MAX_PENDING_WRITE_ATTEMPTS) {
              removePendingInboxWrite(job.id);
              if (showStatus) {
                showPendingWriteStatus('同期に失敗しました。通信環境を確認してください', 'error');
              }
            } else if (showStatus) {
              showPendingWriteStatus(`同期を再試行中…（${attempts}/${MAX_PENDING_WRITE_ATTEMPTS}）`, 'busy');
            }
          }
        });
      });
      return toResume.length;
    }
    function isUndoInboxDest(folder) {
      return typeof historyDestIsInbox === 'function'
        ? historyDestIsInbox(folder)
        : (!folder || folder === 'INBOX' || String(folder).indexOf('INBOX') !== -1);
    }
    async function findExactItemsForUndo(folder, file, contents) {
      const wanted = (contents || []).map((c) => String(c));
      const remaining = wanted.slice();
      const found = [];
      if (!remaining.length) return found;
      if (isUndoInboxDest(folder)) {
        const data = await callAPI('getOrganizerData', { fresh: true }, { silent: true });
        const inbox = (data && Array.isArray(data.inbox)) ? data.inbox : [];
        for (let i = inbox.length - 1; i >= 0 && remaining.length; i--) {
          const item = inbox[i];
          if (!item || item.id == null || item.content == null) continue;
          let idx = -1;
          for (let j = remaining.length - 1; j >= 0; j--) {
            if (dumpContentEquals(remaining[j], item.content)) { idx = j; break; }
          }
          if (idx < 0) continue;
          found.push({ id: String(item.id), content: item.content, isInbox: true });
          remaining.splice(idx, 1);
        }
      } else {
        const items = await callAPI('getFolderFileItems', {
          folder,
          file: file || '未整理'
        }, { silent: true });
        const list = Array.isArray(items) ? items : [];
        for (let i = list.length - 1; i >= 0 && remaining.length; i--) {
          const item = list[i];
          if (!item || item.id == null || item.content == null) continue;
          const idx = remaining.lastIndexOf(String(item.content));
          if (idx < 0) continue;
          found.push({ id: String(item.id), content: item.content, isInbox: false });
          remaining.splice(idx, 1);
        }
      }
      return found;
    }
    async function trashItemsForUndo(matches) {
      const inboxMoves = [];
      const dataDeletes = [];
      (matches || []).forEach((m) => {
        if (!m || m.id == null) return;
        if (m.isInbox) inboxMoves.push({ id: m.id, folder: '🗑️ ゴミ箱', file: '削除履歴' });
        else dataDeletes.push(m.id);
      });
      const ops = [];
      if (inboxMoves.length) ops.push({ action: 'moveInboxItems', items: inboxMoves });
      if (dataDeletes.length) ops.push({ action: 'deleteDataRecords', ids: dataDeletes });
      if (!ops.length) return { trashed: 0 };
      const res = await callBatch(ops, { silent: true });
      if (isApiFailure(res)) throw new Error('undo_trash');
      return { trashed: inboxMoves.length + dataDeletes.length };
    }
    function stripLocalHistoryForUndo(folder, file, contents) {
      const drop = new Set((contents || []).map((c) => String(c)));
      if (!drop.size || typeof getLocalInputHistory !== 'function') return;
      const destFolder = typeof normalizeHistoryFolder === 'function'
        ? normalizeHistoryFolder(folder)
        : (folder || 'INBOX');
      const destFile = file || '未整理';
      const kept = getLocalInputHistory().filter((e) => {
        if (!e || !drop.has(String(e.content || ''))) return true;
        const ef = typeof normalizeHistoryFolder === 'function'
          ? normalizeHistoryFolder(e.folder)
          : (e.folder || 'INBOX');
        return !(ef === destFolder && (e.file || '未整理') === destFile);
      });
      if (typeof cacheLocalInputHistory === 'function') cacheLocalInputHistory(kept);
      if (typeof paintInputTabHistory === 'function') paintInputTabHistory(kept);
    }

    function bumpBadgeOptimistic(delta) {
      const badge = document.getElementById('badge-count');
      if (!badge) return;
      const current = parseInt(badge.textContent, 10) || 0;
      const next = Math.max(0, current + (delta || 0));
      badge.textContent = String(next);
      badge.classList.add('hidden');
      badge.setAttribute('hidden', '');
      badge.style.display = 'none';
    }

    function setOrganizeSyncStatus(text) {
      const el = document.getElementById('organize-sync-status');
      if (!el) return;
      el.textContent = text || '';
      el.classList.toggle('hidden', !text);
    }

    function isTempId(id) {
      return String(id || '').startsWith('temp-');
    }

    function makeTempId() {
      return `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    }
    async function callBatch(ops, options = {}) {
      if (!ops || ops.length === 0) return { success: true, results: [] };
      if (ops.length === 1) {
        const only = ops[0];
        const { action, ...data } = only;
        const result = await callAPI(action, data, options);
        const failed = !!(result && result.error);
        return { success: !failed, results: [result], error: failed };
      }
      const result = await callAPI('batch', { ops }, options);
      if (result && result.error) return { success: false, results: [], error: true, message: result.message };
      const results = result && Array.isArray(result.results) ? result.results : [];
      const hasErr = results.some((r) => r && r.error);
      // batch 全体が success:false の場合も失敗扱い
      const failed = hasErr || (result && result.success === false);
      return { success: !failed, results, error: failed };
    }

    function chunkArray(arr, size) {
      const list = Array.isArray(arr) ? arr : [];
      const out = [];
      const n = Math.max(1, size || 25);
      for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
      return out;
    }

    /** まとめて削除用: 大量件数を分割して GAS タイムアウトを避ける */
    async function syncBulkTrashMoves(inboxMoves, dataMoves, options = {}) {
      const CHUNK = 25;
      for (const chunk of chunkArray(inboxMoves, CHUNK)) {
        const res = await callAPI('moveInboxItems', { items: chunk }, options);
        if (res && res.error) throw new Error('inbox_move');
      }
      for (const chunk of chunkArray(dataMoves, CHUNK)) {
        const res = await callAPI('moveDataRecords', { items: chunk }, options);
        if (res && res.error) throw new Error('data_move');
      }
    }

    function logOperation(type, description, payload) {
      let history = JSON.parse(localStorage.getItem('operation_history') || '[]');
      const id = Date.now().toString() + Math.random().toString(36).substring(2, 7);
      history.unshift({
        id: id,
        timestamp: new Date().toISOString(),
        type: type,
        description: description,
        payload: payload
      });
      if (history.length > 30) history = history.slice(0, 30);
      localStorage.setItem('operation_history', JSON.stringify(history));
      refreshOperationHistoryIfVisible();
      return id;
    }

    function syncUndoButtonHtml(historyId) {
      if (!historyId) return '';
      return `<button type="button" onclick="document.getElementById('input-status').innerHTML=''; undoOperation('${historyId}', true)" class="mt-1 px-3 py-1 bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm font-normal rounded-full border border-gray-600 transition-colors shadow-lg active:scale-95 inline-flex items-center gap-1"><span class="text-lg leading-none -mt-0.5">↺</span> 取り消す</button>`;
    }

    const appliedHistoryOpIds = new Set();
    function markHistoryOpApplied(historyId) {
      if (historyId) appliedHistoryOpIds.add(String(historyId));
    }
    function historyOpWasApplied(historyId) {
      return !!(historyId && appliedHistoryOpIds.has(String(historyId)));
    }
    function clearHistoryOpApplied(historyId) {
      if (historyId) appliedHistoryOpIds.delete(String(historyId));
    }

    function rollbackLoggedOperation(historyId) {
      if (!historyId) return;
      const history = JSON.parse(localStorage.getItem('operation_history') || '[]');
      const next = history.filter((h) => h.id !== historyId);
      localStorage.setItem('operation_history', JSON.stringify(next));
      refreshOperationHistoryIfVisible();
    }

    function restoreOperationHistoryEntry(op, opIndex) {
      if (!op) return;
      const history = JSON.parse(localStorage.getItem('operation_history') || '[]');
      const idx = Math.min(Math.max(0, opIndex || 0), history.length);
      history.splice(idx, 0, op);
      localStorage.setItem('operation_history', JSON.stringify(history.slice(0, 30)));
    }

    function refreshOperationHistoryIfVisible() {
      if (typeof showOperationHistory === 'function' && typeof currentSearchTabMode !== 'undefined' && currentSearchTabMode === 'operation_history') {
        showOperationHistory();
      }
    }

    function restoreInputAfterUndoAdd(p, skipConfirm, gaugeKept) {
      if (!skipConfirm) return;
      const textarea = document.getElementById('input-content');
      if (textarea && p.contents && p.contents.length) {
        const textToRestore = p.contents.join('\n\n');
        if (textarea.value) textarea.value = textToRestore + '\n\n' + textarea.value;
        else textarea.value = textToRestore;
        textarea.focus();
        if (typeof syncInputTabHistoryLock === 'function') syncInputTabHistoryLock();
        if (!pendingInputHistoryReplace && typeof onLiveInputDraftChanged === 'function') {
          onLiveInputDraftChanged({ immediateCloud: true, reason: 'undo_add_restore' });
        }
      }
      if (gaugeKept) return;
      const status = document.getElementById('input-status');
      if (status) {
        status.className = 'text-base mt-2 text-center text-emerald-400 font-bold drop-shadow-md';
        status.textContent = '操作を取り消し、入力内容を復元しました';
        setTimeout(() => {
          if (status.textContent.includes('取り消し')) status.textContent = '';
        }, 2500);
      }
    }

    function applyOptimisticUndoAdd(op, historyId, skipConfirm) {
      const p = op.payload;
      cancelledDumpHistoryIds.add(historyId);
      const gaugeKept = typeof dropSyncGaugeByHistory === 'function' && dropSyncGaugeByHistory(historyId);
      if (typeof forgetDumpedItemsByContents === 'function') {
        forgetDumpedItemsByContents(p.contents || []);
      }
      stripLocalHistoryForUndo(p.folder, p.file, p.contents || []);
      if (isUndoInboxDest(p.folder) && (p.contents || []).length) {
        bumpBadgeOptimistic(-(p.contents || []).length);
      }
      if (typeof invalidateStoredItemsCache === 'function') {
        invalidateStoredItemsCache({ contents: p.contents || [] });
      }
      restoreInputAfterUndoAdd(p, skipConfirm, gaugeKept);
      if (typeof loadOrganizeData === 'function') {
        const organizeMode = document.getElementById('organize-mode');
        if (organizeMode && organizeMode.classList.contains('active')) {
          loadOrganizeData({ silent: true }).catch(() => { });
        }
      }
    }

    function rollbackOptimisticUndoAdd(op, historyId, skipConfirm) {
      const p = op.payload;
      cancelledDumpHistoryIds.delete(historyId);
      if (typeof rememberDumpedItems === 'function') {
        const isInbox = isUndoInboxDest(p.folder);
        rememberDumpedItems((p.contents || []).map((content) => ({
          id: makeTempId(),
          content,
          timestamp: new Date().toISOString(),
          folder: isInbox ? '📥 INBOX' : p.folder,
          file: p.file || '未整理',
          isInbox: isInbox,
          _pending: true
        })));
      }
      if (isUndoInboxDest(p.folder) && (p.contents || []).length) {
        bumpBadgeOptimistic((p.contents || []).length);
      }
      if (typeof appendLocalInputHistory === 'function') {
        appendLocalInputHistory(p.contents || [], p.folder, p.file || '未整理');
        if (typeof paintInputTabHistory === 'function') {
          paintInputTabHistory(typeof getLocalInputHistory === 'function' ? getLocalInputHistory() : []);
        }
      }
      if (skipConfirm) {
        const status = document.getElementById('input-status');
        if (status) {
          status.className = 'text-base mt-2 text-center font-bold text-rose-400';
          status.textContent = '取り消しに失敗しました。内容を確認してください';
        }
      }
    }

    async function syncUndoAddToServer(op, historyId) {
      const p = op.payload;
      await flushInboxWriteChain();
      if (!cancelledDumpHistoryIds.has(historyId)) return;
      const matches = await findExactItemsForUndo(p.folder, p.file, p.contents || []);
      if (matches.length) await trashItemsForUndo(matches);
      if (typeof updateBadge === 'function') updateBadge();
      cancelledDumpHistoryIds.delete(historyId);
    }

    function deleteContentsFromUndoPayload(p) {
      if (!p) return [];
      if (Array.isArray(p.contents) && p.contents.length) {
        return p.contents.map((c) => String(c || '')).filter((c) => dumpContentKey(c));
      }
      if (p.content != null && dumpContentKey(p.content)) return [String(p.content)];
      return [];
    }

    // 取り消し後に、遅れて届く削除が同じ本文を再度ゴミ箱へ入れないようにする
    const undoTrashShieldKeys = new Set();

    function shieldDumpContentFromTrash(content) {
      const key = dumpContentKey(content);
      if (!key) return;
      undoTrashShieldKeys.add(key);
      if (typeof markInputHistoryResurrected === 'function') markInputHistoryResurrected(content);
      if (typeof clearPendingInputHistoryDelete === 'function') clearPendingInputHistoryDelete('', content);
      if (typeof clearInputHistoryTombstoneForContent === 'function') clearInputHistoryTombstoneForContent(content);
      if (typeof unsuppressReplacedHistoryContent === 'function') unsuppressReplacedHistoryContent(content);
      if (typeof forgetRecentDumpTrash === 'function') forgetRecentDumpTrash({ contents: [content] });
    }

    function unshieldDumpContentFromTrash(content) {
      const key = dumpContentKey(content);
      if (key) undoTrashShieldKeys.delete(key);
    }

    function isDumpContentShieldedFromTrash(content) {
      const key = dumpContentKey(content);
      return !!(key && undoTrashShieldKeys.has(key));
    }

    function isRestoreMoveOk(res) {
      if (!res || res.error || res.success === false) return false;
      if (typeof res.count === 'number' && res.count <= 0) return false;
      return true;
    }

    function undoRestoreDestIsInbox(folder, file) {
      if (isUndoInboxDest(folder)) return true;
      const f = String(folder || '');
      const fileName = file || '未整理';
      return (f === 'INBOX' || f === '📥 INBOX') && (fileName === '未整理' || !file);
    }

    function applyOptimisticUndoDelete(op) {
      const p = op.payload || {};
      const contents = deleteContentsFromUndoPayload(p);
      if (!contents.length) return;
      contents.forEach((content) => shieldDumpContentFromTrash(content));
      if (typeof forgetRecentDumpTrash === 'function') {
        forgetRecentDumpTrash({ ids: [p.id, p.dumpId], contents });
      }
      contents.forEach((content) => {
        if (typeof clearInputHistoryTombstoneForContent === 'function') {
          clearInputHistoryTombstoneForContent(content);
        }
        if (typeof unsuppressReplacedHistoryContent === 'function') {
          unsuppressReplacedHistoryContent(content);
        }
      });
      if (typeof persistHistoryTombstones === 'function') persistHistoryTombstones();

      const folder = p.oldFolder || 'INBOX';
      const file = p.oldFile || '未整理';
      const toInbox = undoRestoreDestIsInbox(folder, file);
      const histFolder = toInbox ? 'INBOX' : (typeof normalizeHistoryFolder === 'function' ? normalizeHistoryFolder(folder) : folder);
      const histFile = toInbox ? '未整理' : file;

      if (typeof appendLocalInputHistory === 'function') {
        appendLocalInputHistory(contents, histFolder, histFile);
      }
      if (typeof enqueueInputHistoryCloudSync === 'function') {
        enqueueInputHistoryCloudSync(contents, histFolder, histFile);
      }
      if (typeof rememberDumpedItems === 'function') {
        rememberDumpedItems(contents.map((content) => ({
          id: makeTempId(),
          content,
          timestamp: new Date().toISOString(),
          folder: toInbox ? '📥 INBOX' : histFolder,
          file: histFile,
          isInbox: toInbox,
          _pending: true
        })));
      }
      if (toInbox && typeof bumpBadgeOptimistic === 'function') {
        bumpBadgeOptimistic(contents.length);
      }
      if (typeof paintInputTabHistory === 'function') {
        paintInputTabHistory(typeof getLocalInputHistory === 'function' ? getLocalInputHistory() : [], { force: true });
      }
      if (typeof refreshCheckBlocksListIfVisible === 'function') refreshCheckBlocksListIfVisible();
      if (typeof renderInputHistoryView === 'function' && typeof currentSearchTabMode !== 'undefined' && currentSearchTabMode === 'input_history') {
        renderInputHistoryView();
      }
    }

    async function revokeInputHistoryTombstonesForContents(contents) {
      const keys = new Set((contents || []).map((c) => dumpContentKey(c)).filter(Boolean));
      if (!keys.size) return;
      (contents || []).forEach((c) => {
        if (typeof clearInputHistoryTombstoneForContent === 'function') clearInputHistoryTombstoneForContent(c);
      });
      if (typeof persistHistoryTombstones === 'function') persistHistoryTombstones();
      try {
        const items = await callAPI('getFolderFileItems', {
          folder: '__SYSTEM__',
          file: 'input_history'
        }, { silent: true });
        const ids = [];
        (Array.isArray(items) ? items : []).forEach((row) => {
          if (!row || row.id == null || row.content == null) return;
          const ts = typeof parseInputHistoryTombstonePayload === 'function'
            ? parseInputHistoryTombstonePayload(row.content)
            : null;
          if (!ts) return;
          const ck = String(ts.contentKey || dumpContentKey(ts.content || '') || '');
          if (ck && keys.has(ck)) ids.push(String(row.id));
        });
        if (ids.length === 1) {
          await callAPI('deleteDataRecord', { id: ids[0] }, { silent: true });
        } else if (ids.length > 1) {
          await callAPI('deleteDataRecords', { ids }, { silent: true });
        }
        if (ids.length && typeof invalidateCloudInputHistoryCache === 'function') {
          invalidateCloudInputHistoryCache();
        }
      } catch (e) {
        console.warn('revoke input history tombstones failed', e);
      }
    }

    async function restoreOneDeletedContentToServer(content, oldFolder, oldFile, preferredId) {
      const toInbox = undoRestoreDestIsInbox(oldFolder, oldFile);
      const destFolder = toInbox ? 'INBOX' : oldFolder;
      const destFile = toInbox ? '未整理' : (oldFile || '未整理');
      let trashId = preferredId && !isTempId(preferredId) ? String(preferredId) : '';

      if (!trashId) {
        try {
          const trashItems = await callAPI('getFolderFileItems', {
            folder: '🗑️ ゴミ箱',
            file: '削除履歴'
          }, { silent: true });
          const hit = (Array.isArray(trashItems) ? trashItems : []).find(
            (r) => r && r.id != null && dumpContentEquals(r.content, content)
          );
          if (hit) trashId = String(hit.id);
        } catch (e) {
          console.warn('trash lookup for undo failed', e);
        }
      }

      if (toInbox) {
        const res = await callAPI('addInbox', { content }, { silent: true });
        if (isApiFailure(res)) throw new Error('restore_inbox');
        if (!(await dumpContentIsVisible(content, destFolder, destFile))) {
          throw new Error('restore_inbox_missing');
        }
        // 検索に出るコピーができたあとで、ゴミ箱側の同一本文を隠す
        if (trashId) {
          try {
            await callAPI('moveDataRecord', {
              id: trashId,
              folder: '__SYSTEM__',
              file: 'restored_trash'
            }, { silent: true });
          } catch (_) { }
        }
        return { toInbox: true };
      }

      if (trashId) {
        const moved = await callAPI('moveDataRecord', {
          id: trashId,
          folder: destFolder,
          file: destFile
        }, { silent: true });
        if (isRestoreMoveOk(moved) && await dumpContentIsVisible(content, destFolder, destFile)) {
          return { toInbox: false, moved: true, id: trashId };
        }
      }

      const added = await callAPI('addDataRecord', {
        folder: destFolder,
        file: destFile,
        content
      }, { silent: true });
      if (isApiFailure(added)) throw new Error('restore_data');
      if (!(await dumpContentIsVisible(content, destFolder, destFile))) {
        throw new Error('restore_data_missing');
      }
      return { toInbox: false, moved: false };
    }

    async function dumpContentIsVisible(content, folder, file) {
      const toInbox = undoRestoreDestIsInbox(folder, file);
      try {
        if (toInbox) {
          const data = await callAPI('getOrganizerData', { fresh: true }, { silent: true });
          const inbox = data && Array.isArray(data.inbox) ? data.inbox : [];
          if (inbox.some((item) => item && dumpContentEquals(item.content, content))) return true;
        } else if (folder) {
          const items = await callAPI('getFolderFileItems', {
            folder,
            file: file || '未整理'
          }, { silent: true });
          if ((Array.isArray(items) ? items : []).some((item) => item && dumpContentEquals(item.content, content))) {
            return true;
          }
        }
        const keyword = typeof searchKeywordForDump === 'function'
          ? searchKeywordForDump(content)
          : String(content || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!keyword) return false;
        const results = await callAPI('searchData', { keyword }, { silent: true });
        return (Array.isArray(results) ? results : []).some((row) => {
          if (!row || !dumpContentEquals(row.content, content)) return false;
          if (typeof isNonUserDumpItem === 'function' && isNonUserDumpItem(row)) return false;
          return true;
        });
      } catch (e) {
        console.warn('restore visibility check failed', e);
        return true;
      }
    }

    async function syncUndoDeleteToServer(op) {
      const p = op.payload || {};
      const contents = deleteContentsFromUndoPayload(p);
      if (!contents.length) throw new Error('empty_content');
      contents.forEach((content) => shieldDumpContentFromTrash(content));
      const oldFolder = p.oldFolder || 'INBOX';
      const oldFile = p.oldFile || '未整理';
      const preferredId = p.id || p.dumpId || null;

      await revokeInputHistoryTombstonesForContents(contents);

      for (let i = 0; i < contents.length; i++) {
        // 複数件ログでは先頭だけ id がある場合がある
        const id = i === 0 ? preferredId : null;
        await restoreOneDeletedContentToServer(contents[i], oldFolder, oldFile, id);
      }

      if (typeof invalidateStoredItemsCache === 'function') {
        invalidateStoredItemsCache({ contents });
      }
      if (typeof updateBadge === 'function') updateBadge();
    }

    async function syncUndoOtherToServer(op) {
      const p = op.payload || {};
      if (op.type === 'DELETE') {
        await syncUndoDeleteToServer(op);
        return;
      }
      if (op.type === 'MOVE' || op.type === 'MOVE_EDIT') {
        const isMoveEdit = op.type === 'MOVE_EDIT';
        const contentToSearch = isMoveEdit ? (p.newContent || p.content) : p.content;
        const contentToRestore = isMoveEdit ? (p.oldContent || p.content) : p.content;
        const origFolder = p.oldFolder || 'INBOX';
        const origFile = p.oldFile || '未整理';
        const isOrigInbox = undoRestoreDestIsInbox(origFolder, origFile);
        const newFolder = p.newFolder || 'INBOX';
        const newFile = p.newFile || '未整理';
        const isNewInbox = undoRestoreDestIsInbox(newFolder, newFile);

        let match = null;
        if (p.dumpId && !isTempId(p.dumpId)) {
          try {
            match = await resolveDumpByIdFresh(p.dumpId, isNewInbox);
          } catch (e) {
            console.warn('resolve dump by id for undo failed', e);
          }
        }
        if (!match && typeof findExactDumpHitsOnServer === 'function') {
          try {
            const hits = await findExactDumpHitsOnServer(contentToSearch, {
              inbox: isNewInbox,
              folder: isNewInbox ? null : newFolder,
              file: isNewInbox ? null : newFile,
              anywhere: true
            });
            if (hits && hits.length > 0) {
              match = hits.find((h) => {
                const hf = normalizeHistoryFolder(h.folder);
                const nf = normalizeHistoryFolder(newFolder);
                return hf === nf && (h.file || '未整理') === newFile;
              }) || hits[0];
            }
          } catch (e) {
            console.warn('findExactDumpHitsOnServer for undo failed', e);
          }
        }

        // 移動先の既存レコードを元の場所へ戻す
        if (match && match.id && !isTempId(match.id)) {
          if (isMoveEdit && !dumpContentEquals(contentToSearch, contentToRestore)) {
            try {
              await updateDumpByKnownId(match.id, contentToRestore, match.isInbox);
            } catch (_) { }
            match.content = contentToRestore;
          }
          const moved = await moveDumpMatchToDest(match, origFolder, origFile, isOrigInbox);
          if (!moved) throw new Error('undo_move_failed');
          if (typeof updateBadge === 'function') updateBadge();
          return;
        }

        // 移動先に見つからない場合、すでに元の場所に戻っていないか確認（二重作成の防止）
        if (typeof findExactDumpHitsOnServer === 'function') {
          try {
            const origHits = await findExactDumpHitsOnServer(contentToRestore, {
              inbox: isOrigInbox,
              folder: isOrigInbox ? null : origFolder,
              file: isOrigInbox ? null : origFile,
              anywhere: false
            });
            if (origHits && origHits.length > 0) {
              if (typeof updateBadge === 'function') updateBadge();
              return;
            }
          } catch (_) { }
        }

        // どこにもない場合のみ復元
        const ops = [];
        if (isOrigInbox) {
          ops.push({ action: 'addInbox', content: contentToRestore });
        } else {
          ops.push({ action: 'addDataRecord', folder: origFolder, file: origFile, content: contentToRestore });
        }
        const batchRes = await callBatch(ops, { silent: true });
        if (isApiFailure(batchRes) || (batchRes && batchRes.success === false)) {
          throw new Error('undo_move');
        }
        if (typeof updateBadge === 'function') updateBadge();
        return;
      }
      if (op.type === 'EDIT') {
        const destFolder = p.folder || 'INBOX';
        const destFile = p.file || '未整理';
        const isInbox = undoRestoreDestIsInbox(destFolder, destFile);

        // IDがあれば上書き更新で戻す（新規追加による二重化を防止）
        if (p.dumpId && !isTempId(p.dumpId)) {
          const byId = await updateDumpByKnownId(p.dumpId, p.oldContent, isInbox);
          if (byId && byId.success) {
            if (typeof updateBadge === 'function') updateBadge();
            return;
          }
        }

        const keyword = typeof searchKeywordForDump === 'function'
          ? searchKeywordForDump(p.newContent)
          : String(p.newContent || '').slice(0, 80);
        const results = keyword
          ? await callAPI('searchData', { keyword }, { silent: true })
          : [];
        const ops = [];
        if (results && results.length > 0) {
          const match = results.find((r) => {
            if (!r || !dumpContentEquals(r.content, p.newContent)) return false;
            const rf = typeof normalizeHistoryFolder === 'function'
              ? normalizeHistoryFolder(r.folder)
              : String(r.folder || '');
            const pf = typeof normalizeHistoryFolder === 'function'
              ? normalizeHistoryFolder(p.folder)
              : String(p.folder || '');
            return rf === pf && (r.file || '未整理') === (p.file || '未整理');
          });
          if (match) {
            // 見つかったらID上書きを試行
            const byId = await updateDumpByKnownId(match.id, p.oldContent, !!match.isInbox);
            if (byId && byId.success) {
              if (typeof updateBadge === 'function') updateBadge();
              return;
            }
            if (match.isInbox) {
              ops.push({ action: 'moveInboxItems', items: [{ id: match.id, folder: '🗑️ ゴミ箱', file: '削除履歴' }] });
            } else {
              ops.push({ action: 'deleteDataRecords', ids: [match.id] });
            }
          }
        }
        if (undoRestoreDestIsInbox(p.folder, p.file)) {
          ops.push({ action: 'addInbox', content: p.oldContent });
        } else {
          ops.push({ action: 'addDataRecord', folder: p.folder, file: p.file || '未整理', content: p.oldContent });
        }
        const batchRes = await callBatch(ops, { silent: true });
        if (isApiFailure(batchRes) || (batchRes && batchRes.success === false)) {
          throw new Error('undo_edit');
        }
        if (typeof updateBadge === 'function') updateBadge();
      }
    }

    async function undoOperation(historyId, skipConfirm = false) {
      const history = JSON.parse(localStorage.getItem('operation_history') || '[]');
      const opIndex = history.findIndex((h) => h.id === historyId);
      if (opIndex === -1) {
        alert('履歴が見つかりません。');
        return;
      }
      const op = history[opIndex];
      const p = op.payload;

      if (!skipConfirm) {
        if (!confirm(`「${op.description}」を取り消しますか？\n※注意: 同じテキストが複数存在する場合、意図しないデータが対象になる可能性があります。`)) return;
      } else {
        const status = document.getElementById('input-status');
        if (status) {
          status.className = 'text-base mt-2 text-center text-cyan-300/90 font-bold drop-shadow-md';
          status.textContent = '取り消し中...';
        }
      }

      history.splice(opIndex, 1);
      localStorage.setItem('operation_history', JSON.stringify(history));
      refreshOperationHistoryIfVisible();

      if (op.type === 'ADD') {
        applyOptimisticUndoAdd(op, historyId, skipConfirm);
        runInBackground(async () => {
          try {
            await syncUndoAddToServer(op, historyId);
          } catch (err) {
            cancelledDumpHistoryIds.delete(historyId);
            restoreOperationHistoryEntry(op, opIndex);
            rollbackOptimisticUndoAdd(op, historyId, skipConfirm);
            refreshOperationHistoryIfVisible();
            console.error('undo failed', err);
            alert('取り消しに失敗しました');
          }
        });
        return;
      }

      if (op.type === 'DELETE') {
        applyOptimisticUndoDelete(op);
        runInBackground(async () => {
          try {
            await syncUndoDeleteToServer(op);
            if (!skipConfirm) alert('操作を取り消しました。');
            else {
              const status = document.getElementById('input-status');
              if (status) {
                status.className = 'text-base mt-2 text-center text-emerald-400 font-bold drop-shadow-md';
                status.textContent = '削除を取り消しました';
                setTimeout(() => {
                  if (status.textContent.includes('取り消')) status.textContent = '';
                }, 2500);
              }
            }
          } catch (err) {
            restoreOperationHistoryEntry(op, opIndex);
            rollbackOptimisticUndoDelete(op);
            refreshOperationHistoryIfVisible();
            console.error('undo failed', err);
            alert('取り消しに失敗しました');
          }
        });
        return;
      }

      if (op.type === 'MOVE' || op.type === 'MOVE_EDIT' || op.type === 'EDIT') {
        applyOptimisticUndoHistoryLaneMove(op, historyId, skipConfirm);
        runInBackground(async () => {
          try {
            if (historyOpWasApplied(historyId)) {
              await syncUndoOtherToServer(op);
            }
            clearHistoryOpApplied(historyId);
            if (!skipConfirm) alert('操作を取り消しました。');
            else {
              const status = document.getElementById('input-status');
              if (status && !String(status.innerHTML || '').includes('取り消す')) {
                const msg = op.type === 'EDIT' ? '編集を取り消しました' : '場所の移動を取り消しました';
                status.className = 'text-base mt-2 text-center text-emerald-400 font-bold drop-shadow-md';
                status.textContent = msg;
                setTimeout(() => {
                  if (status.textContent.includes('取り消')) status.textContent = '';
                }, 2500);
              }
            }
          } catch (err) {
            cancelledDumpHistoryIds.delete(historyId);
            restoreOperationHistoryEntry(op, opIndex);
            refreshOperationHistoryIfVisible();
            console.error('undo failed', err);
            alert('取り消しに失敗しました');
          }
        });
        return;
      }

      runInBackground(async () => {
        try {
          await syncUndoOtherToServer(op);
          if (!skipConfirm) alert('操作を取り消しました。');
        } catch (err) {
          restoreOperationHistoryEntry(op, opIndex);
          refreshOperationHistoryIfVisible();
          console.error('undo failed', err);
          alert('取り消しに失敗しました');
        }
      });
    }

    function applyOptimisticUndoHistoryLaneMove(op, historyId, skipConfirm) {
      const p = (op && op.payload) || {};
      if (historyId) cancelledDumpHistoryIds.add(historyId);
      const gaugeKept = typeof dropSyncGaugeByHistory === 'function' && dropSyncGaugeByHistory(historyId);
      try {
        getPendingInboxWrites().forEach((j) => {
          if (!j) return;
          if ((historyId && j.historyId === historyId) || (p.replaceJobId && j.id === p.replaceJobId)) {
            removePendingInboxWrite(j.id);
            clearPendingWriteQueued(j.id);
            pendingWriteRunningIds.delete(j.id);
          }
        });
      } catch (_) { }

      const currentContent = op.type === 'MOVE_EDIT' || op.type === 'EDIT'
        ? String(p.newContent || p.content || '')
        : String(p.content || '');
      const restoreContent = op.type === 'MOVE_EDIT' || op.type === 'EDIT'
        ? String(p.oldContent || p.content || '')
        : String(p.content || '');
      const restoreFolder = op.type === 'EDIT'
        ? (p.folder || 'INBOX')
        : (p.oldFolder || 'INBOX');
      const restoreFile = op.type === 'EDIT'
        ? (p.file || '未整理')
        : (p.oldFile || '未整理');
      const restoreInbox = historyDestIsInbox(restoreFolder);

      // 移動先のキャッシュを除去（移動先と移動元の2つが表示されるのを防ぐ）
      const destFolderToClean = normalizeHistoryFolder(op.type === 'EDIT' ? (p.folder || 'INBOX') : (p.newFolder || 'INBOX'));
      const destFileToClean = (op.type === 'EDIT' ? p.file : p.newFile) || '未整理';
      const cleanFilter = (item) => {
        if (!item) return false;
        if (p.dumpId && !isTempId(p.dumpId) && String(item.id) === String(p.dumpId)) {
          return false;
        }
        const itemFolder = normalizeHistoryFolder(item.folder);
        const itemFile = item.file || '未整理';
        if (itemFolder === destFolderToClean && itemFile === destFileToClean && dumpContentEquals(item.content, currentContent)) {
          return false;
        }
        return true;
      };
      if (typeof storedItemsCache !== 'undefined' && Array.isArray(storedItemsCache.items)) {
        storedItemsCache.items = storedItemsCache.items.filter(cleanFilter);
      }
      if (typeof pendingDumpCache !== 'undefined' && Array.isArray(pendingDumpCache)) {
        pendingDumpCache = pendingDumpCache.filter(cleanFilter);
      }

      if (restoreContent && typeof applyOptimisticInputHistoryReplace === 'function') {
        applyOptimisticInputHistoryReplace(
          {
            id: p.historyEntryId,
            content: currentContent || restoreContent,
            dumpId: p.dumpId || '',
            dumpIsInbox: p.dumpIsInbox
          },
          restoreContent,
          currentContent || restoreContent,
          restoreFolder,
          restoreFile
        );
      }
      if (restoreContent && typeof rememberDumpedItems === 'function') {
        rememberDumpedItems([{
          id: p.dumpId && !(typeof isTempId === 'function' && isTempId(p.dumpId)) ? String(p.dumpId) : undefined,
          content: restoreContent,
          folder: restoreInbox ? '📥 INBOX' : restoreFolder,
          file: restoreInbox ? '未整理' : restoreFile,
          isInbox: restoreInbox
        }]);
      }
      if (p.dumpId && !isTempId(p.dumpId) && typeof patchStoredDumpById === 'function') {
        patchStoredDumpById(p.dumpId, {
          content: restoreContent,
          folder: restoreInbox ? '📥 INBOX' : restoreFolder,
          file: restoreInbox ? '未整理' : restoreFile,
          isInbox: restoreInbox
        });
      }
      if (typeof paintInputTabHistory === 'function') {
        paintInputTabHistory(typeof getLocalInputHistory === 'function' ? getLocalInputHistory() : [], {
          force: true,
          skipDupSchedule: true
        });
      }
      if (skipConfirm && !gaugeKept) {
        const status = document.getElementById('input-status');
        if (status) {
          status.className = 'text-base mt-2 text-center text-emerald-400 font-bold drop-shadow-md';
          status.textContent = op.type === 'EDIT' ? '編集を取り消しました' : '場所の移動を取り消しました';
          setTimeout(() => {
            if (status.textContent.includes('取り消')) status.textContent = '';
          }, 2500);
        }
      }
    }
    async function deleteConfigAndMoveToTrash(folder, file = null) {
      const typeStr = file ? "ファイル" : "フォルダ";
      const name = file ? file : folder;
      if (!confirm(`本当に${typeStr}「${name}」を削除しますか？\n（中のデータはすべて「ゴミ箱」に移動されます）`)) return false;

      showLoader(`${typeStr}を削除中...`);
      try {
        const trashMoves = [];
        const configDeletes = [];
        if (file) {
          const items = await callAPI('getFolderFileItems', { folder, file }) || [];
          items.forEach(item => {
            trashMoves.push({ id: item.id, folder: '🗑️ ゴミ箱', file: '削除履歴' });
          });
          configDeletes.push({ action: 'deleteConfigRecord', folder, file });
        } else {
          const files = configData[folder] || [];
          const itemLists = await callBatch(
            files.map(f => ({ action: 'getFolderFileItems', folder, file: f }))
          );
          (itemLists.results || []).forEach(items => {
            if (!Array.isArray(items)) return;
            items.forEach(item => {
              trashMoves.push({ id: item.id, folder: '🗑️ ゴミ箱', file: '削除履歴' });
            });
          });
          files.forEach(f => configDeletes.push({ action: 'deleteConfigRecord', folder, file: f }));
          configDeletes.push({ action: 'deleteConfigRecord', folder, file: '' });
        }
        const ops = [];
        if (trashMoves.length) ops.push({ action: 'moveDataRecords', items: trashMoves });
        ops.push(...configDeletes);
        if (ops.length) await callBatch(ops);
        const data = await callAPI('getOrganizerData');
        if (!data.error) configData = data.config || {};
        hideLoader();
        return true;
      } catch (e) {
        hideLoader();
        alert("エラーが発生しました");
        return false;
      }
    }
