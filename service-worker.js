const CACHE_NAME = 'dump-app-v445';
const PENDING_WRITES_CACHE = 'dump-pending-writes-v1';
const PENDING_WRITES_CACHE_URL = './__pending_inbox_writes.json';
/** activate 時に残す直前ビルド数（更新直後のネット失敗でも旧 index で開ける） */
const KEEP_PREVIOUS_CACHES = 2;
/**
 * アプリ本体は ./ から取る。Cloudflare Pages は /index.html を / へ 308 リダイレクトするため、
 * ./index.html を fetch すると「リダイレクト済み」応答になり、それを画面遷移に返すと
 * Chrome が ERR_FAILED（このサイトにアクセスできません）にする。
 */
const APP_SHELL_PATH = './';
const NAV_NETWORK_TIMEOUT_MS = 2500;
const ASSETS = [
  './manifest.json',
  './iztro.min.js',
  './splash-dark.png'
];

// レイアウト用 CDN（オペーク応答も cache.put できるよう専用扱い）
const RESILIENT_CDN_HOSTS = [
  'cdn.tailwindcss.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

function parseBuildNum(value) {
  const m = String(value || '').match(/v(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

function isResilientCdnRequest(request) {
  const url = request.url || '';
  return RESILIENT_CDN_HOSTS.some((host) => url.includes(host));
}

function networkFirstAsset(url) {
  return fetch(url, { cache: 'no-store' }).then((res) => {
    if (!res || !res.ok) throw new Error('asset fetch failed: ' + url);
    return res;
  });
}

/** リダイレクト経由の応答を作り直す（画面遷移に redirected 応答は使えない） */
async function cleanResponse(res) {
  if (!res || !res.redirected) return res;
  if (res.type === 'opaque' || res.type === 'opaqueredirect') return res;
  const body = await res.blob();
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers
  });
}

function appShellUrl() {
  return new URL(APP_SHELL_PATH, self.registration.scope).href;
}

/** / と /index.html（アプリ本体）への遷移か */
function isAppShellUrl(url) {
  try {
    const u = new URL(url);
    const scope = new URL(self.registration.scope);
    if (u.origin !== scope.origin) return false;
    return u.pathname === scope.pathname || u.pathname === scope.pathname + 'index.html';
  } catch (_) {
    return false;
  }
}

async function cacheHasIndex(cache) {
  return (
    (await cache.match('./index.html')) ||
    (await cache.match('index.html')) ||
    (await cache.match('./')) ||
    null
  );
}

async function findNewestCachedIndex() {
  try {
    const keys = await caches.keys();
    const ranked = keys
      .filter((k) => String(k).indexOf('dump-app-') === 0)
      .map((k) => ({ key: k, num: parseBuildNum(k) }))
      .filter((x) => x.num > 0)
      .sort((a, b) => b.num - a.num);

    for (const item of ranked) {
      try {
        const cache = await caches.open(item.key);
        const hit = await cacheHasIndex(cache);
        // 旧ビルドが保存した「リダイレクト済み」控えもここで無害化する
        if (hit) return await cleanResponse(hit);
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

async function putIndexInCache(res) {
  if (!res) return;
  try {
    const clean = await cleanResponse(res);
    if (!clean || !clean.ok) return;
    const cache = await caches.open(CACHE_NAME);
    await cache.put(APP_SHELL_PATH, clean.clone()).catch(() => {});
    await cache.put('./index.html', clean).catch(() => {});
  } catch (_) {}
}

/** respondWith に必ず Response を渡す（undefined/reject → ERR_FAILED の根本対策） */
function asResponse(value, fallback) {
  if (value && typeof value === 'object' && typeof value.status === 'number') return value;
  return fallback;
}

const RECOVERY_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DUMP 復旧</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0b1021;color:#e2e8f0;margin:0;padding:2rem;line-height:1.6}
  button{margin-top:1rem;padding:.75rem 1.25rem;font-weight:800;border-radius:.75rem;border:0;background:#0891b2;color:#fff;cursor:pointer}
  p{opacity:.9}
</style>
</head>
<body>
  <h1>アプリを開けませんでした</h1>
  <p>キャッシュが破損している可能性があります。下のボタンで修復して開き直します（保存データは消えません）。</p>
  <button type="button" id="fix">修復して開き直す</button>
  <script>
  document.getElementById('fix').onclick = async function () {
    try {
      if (window.caches && caches.keys) {
        var keys = await caches.keys();
        await Promise.all(keys.filter(function (k) { return String(k).indexOf('dump-app-') === 0; }).map(function (k) { return caches.delete(k); }));
      }
    } catch (e) {}
    try {
      if ('serviceWorker' in navigator) {
        var regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(function (r) { return r.unregister(); }));
      }
    } catch (e) {}
    location.href = './index.html?recovered=' + Date.now();
  };
  </script>
</body>
</html>`;

function recoveryResponse() {
  return new Response(RECOVERY_HTML, {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

async function precacheResilientCdn() {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.add(new Request('https://cdn.tailwindcss.com', { mode: 'no-cors' }));
  } catch (_) {}
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    let indexOk = false;
    try {
      const shell = await cleanResponse(await networkFirstAsset(APP_SHELL_PATH));
      await cache.put(APP_SHELL_PATH, shell.clone());
      await cache.put('./index.html', shell);
      indexOk = true;
    } catch (_) {}
    for (const path of ASSETS) {
      try {
        const res = await networkFirstAsset(path);
        await cache.put(path, res);
      } catch (_) {}
    }
    await precacheResilientCdn();

    // ネット取得に失敗しても、直前ビルドの index を新キャッシュへ引き継ぐ
    if (!indexOk) {
      try {
        const old = await findNewestCachedIndex();
        if (old) {
          await cache.put(APP_SHELL_PATH, old.clone());
          await cache.put('./index.html', old);
          indexOk = true;
        }
      } catch (_) {}
    }

    // index が無い状態では skipWaiting しない（旧 SW が画面を守り続ける）
    if (indexOk) {
      await self.skipWaiting();
    }
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try {
      const current = await caches.open(CACHE_NAME);
      const hasIndex = !!(await cacheHasIndex(current));
      const myNum = parseBuildNum(CACHE_NAME);
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => {
          if (key === CACHE_NAME || key === PENDING_WRITES_CACHE) return null;
          if (String(key).indexOf('dump-app-') !== 0) return null;
          if (!hasIndex) return null;
          const keyNum = parseBuildNum(key);
          // 直後の数世代は残し、更新レース中のキャッシュ欠落を防ぐ
          if (keyNum >= myNum - KEEP_PREVIOUS_CACHES) return null;
          return caches.delete(key);
        })
      );
    } catch (_) {}
    await self.clients.claim();
  })());
});

function dumpContentKey(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t\u3000]+/g, ' ')
    .trim()
    .toLowerCase();
}

async function postGas(gasUrl, payload) {
  const body = JSON.stringify(payload);
  if (body.length > 60000) return false;
  await fetch(gasUrl, {
    method: 'POST',
    body,
    keepalive: true,
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
  });
  return true;
}

async function flushPendingWritesFromCache() {
  try {
    const windowClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });
    if (windowClients.length > 0) return;

    const cache = await caches.open(PENDING_WRITES_CACHE);
    const res = await cache.match(PENDING_WRITES_CACHE_URL);
    if (!res) return;
    const data = await res.json();
    if (!data || !data.gasUrl || !Array.isArray(data.writes) || !data.writes.length) return;

    const seen = new Set();
    const contents = [];
    const replaceJobs = [];
    data.writes.forEach((job) => {
      if (!job || job.keepaliveSent) return;
      if (job.type === 'history_replace') {
        replaceJobs.push(job);
        return;
      }
      if (job.type !== 'dump_add') return;
      (job.addedChunks || []).forEach((c) => {
        const raw = String(c || '').trim();
        if (!raw) return;
        const key = dumpContentKey(raw);
        if (!key || seen.has(key)) return;
        seen.add(key);
        contents.push(raw);
      });
    });

    const tasks = [];
    if (contents.length) {
      tasks.push(postGas(data.gasUrl, { action: 'addManyInbox', contents }));
    }
    replaceJobs.slice(0, 3).forEach((job) => {
      const newContent = String(job.newContent || '').trim();
      if (!newContent) return;
      if (job.dumpId) {
        const action = job.dumpIsInbox === false ? 'updateDataRecord' : 'updateInbox';
        tasks.push(postGas(data.gasUrl, { action, id: String(job.dumpId), content: newContent }));
      }
      if (job.historyId && !String(job.historyId).startsWith('local-')) {
        const payload = JSON.stringify({
          content: newContent,
          folder: job.destFolder || 'INBOX',
          file: job.destFile || '未整理',
          updatedAt: new Date().toISOString()
        });
        tasks.push(postGas(data.gasUrl, {
          action: 'updateDataRecord',
          id: String(job.historyId),
          content: payload
        }));
      }
    });
    if (!tasks.length) return;
    await Promise.all(tasks);
  } catch (err) {
    console.warn('SW flush pending writes failed', err);
  }
}

self.addEventListener('sync', (e) => {
  if (e.tag === 'dump-pending-writes') {
    e.waitUntil(flushPendingWritesFromCache());
  }
});

self.addEventListener('message', (e) => {
  const data = e && e.data;
  if (!data || !data.type) return;
  if (data.type === 'SKIP_WAITING') {
    // index 未キャッシュのまま activate しない（クライアントからの催促でも同様）
    e.waitUntil((async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        if (await cacheHasIndex(cache)) {
          await self.skipWaiting();
        }
      } catch (_) {}
    })());
    return;
  }
  if (data.type === 'flush-pending-writes') {
    e.waitUntil(flushPendingWritesFromCache());
  }
});

/**
 * 画面遷移（HTML）: 短時間ネット優先、だめなら全世代キャッシュ、最後に復旧ページ。
 * reject / undefined / リダイレクト済み応答は返さない（いずれも ERR_FAILED になる）。
 */
async function handleNavigate(request) {
  const shell = isAppShellUrl(request.url);
  const cacheHitP = (shell
    ? findNewestCachedIndex()
    : caches.match(request).then((r) => cleanResponse(r)))
    .catch(() => null);

  // 本体は ./ を直接取得し、/index.html → / の 308 を SW 内で踏まない
  const netP = (shell ? fetch(appShellUrl(), { cache: 'no-store' }) : fetch(request))
    .then(async (net) => {
      if (!net) return null;
      // リダイレクトはブラウザに任せる（画面遷移では opaqueredirect をそのまま返してよい）
      if (net.type === 'opaqueredirect') return net;
      if (!net.ok) return shell ? null : net;
      const clean = await cleanResponse(net);
      if (shell) putIndexInCache(clean.clone());
      return clean;
    })
    .catch(() => null);

  // ネットが遅い／切れているとき、何秒も待たずにキャッシュへ倒す
  const raced = await Promise.race([
    netP.then((r) => (r ? { kind: 'net', r } : { kind: 'miss' })),
    new Promise((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), NAV_NETWORK_TIMEOUT_MS))
  ]);

  if (raced && raced.kind === 'net' && raced.r) return raced.r;

  const cached = await cacheHitP;
  if (cached) return cached;

  const lateNet = await netP;
  if (lateNet) return lateNet;

  try {
    const net2 = shell ? await fetch(appShellUrl()) : await fetch(request);
    if (net2) return await cleanResponse(net2);
  } catch (_) {}

  return recoveryResponse();
}

async function handleCdn(request) {
  const fallback = new Response('', { status: 504, statusText: 'CDN unavailable' });
  try {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    try {
      const res = await fetch(request);
      if (res) {
        cache.put(request, res.clone()).catch(() => {});
        return res;
      }
    } catch (_) {}
    return asResponse(cached, fallback);
  } catch (_) {
    return fallback;
  }
}

async function handleAsset(request) {
  const fallback = new Response('', { status: 504, statusText: 'Offline' });
  try {
    const net = await fetch(request, { cache: 'no-store' });
    if (net && net.ok && request.method === 'GET') {
      try {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, net.clone()).catch(() => {});
      } catch (_) {}
      return net;
    }
    if (net) return net;
  } catch (_) {}
  try {
    const cached = await caches.match(request);
    if (cached) return cached;
    const index = await findNewestCachedIndex();
    if (index && String(request.url || '').includes('index.html')) return index;
  } catch (_) {}
  return fallback;
}

self.addEventListener('fetch', (e) => {
  const request = e.request;
  if (!request || request.method === 'POST') return;
  if (String(request.url || '').includes('script.google.com')) return;

  const url = String(request.url || '');

  // 緊急回避: ?nosw=1 でキャッシュを使わずネット直通（壊れたSWから脱出用）
  if (url.includes('nosw=1') || url.includes('bypass_sw=1')) {
    e.respondWith(
      fetch(request, { cache: 'no-store' })
        .catch(() => recoveryResponse())
    );
    return;
  }

  // version / SW 本体は常にネット（失敗しても空で返す＝ERR_FAILED 防止）
  if (url.includes('version.json')) {
    e.respondWith(
      fetch(request, { cache: 'no-store' })
        .catch(() => new Response('{"build":"unknown"}', {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        }))
    );
    return;
  }
  if (url.includes('service-worker.js')) {
    e.respondWith(
      fetch(request, { cache: 'no-store' })
        .catch(() => new Response('// offline', {
          headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' }
        }))
    );
    return;
  }

  if (request.method === 'GET' && isResilientCdnRequest(request)) {
    e.respondWith(handleCdn(request).catch(() => new Response('', { status: 504 })));
    return;
  }

  // 画面を開くリクエストは専用の安全経路
  const isNavigate = request.mode === 'navigate' || isAppShellUrl(url);
  if (isNavigate) {
    e.respondWith(handleNavigate(request).catch(() => recoveryResponse()));
    return;
  }

  e.respondWith(handleAsset(request).catch(() => new Response('', { status: 504 })));
});
