const WRITE_ACTIONS = {
  addInbox: true,
  addManyInbox: true,
  moveInboxItem: true,
  moveInboxItems: true,
  addConfigRecord: true,
  deleteConfigRecord: true,
  updateConfigRecord: true,
  deleteDataRecord: true,
  deleteDataRecords: true,
  addDataRecord: true,
  addManyDataRecords: true,
  moveDataRecord: true,
  moveDataRecords: true,
  purgeInboxExactDuplicates: true,
  updateInbox: true,
  updateDataRecord: true,
  // 画像アップロードはシートを触らない。巨大POST＋Lockで他書き込みを塞がないよう WRITE 対象外
  batch: true
};

function withScriptLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function doPost(e) {
  let result = {};
  try {
    const params = JSON.parse(e.postData.contents);
    const run = function () {
      if (params.action === 'batch') {
        return runBatch(params.ops || []);
      }
      return dispatchAction(params);
    };
    // 同時書き込みで getLastRow() が衝突し、後着が上書き消失するのを防ぐ
    if (WRITE_ACTIONS[params.action]) {
      result = withScriptLock_(run);
    } else {
      result = run();
    }
  } catch (err) {
    result = { error: err.toString() };
  }

  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ status: "DUMP API is active" }))
    .setMimeType(ContentService.MimeType.JSON);
}

function dispatchAction(params) {
  const action = params.action;

  if (action === 'addInbox') {
    return { success: addInbox(params.content) };
  } else if (action === 'addManyInbox') {
    return addManyInbox(params.contents || []);
  } else if (action === 'getOrganizerData') {
    return getOrganizerData(!!params.fresh);
  } else if (action === 'getReviewOverview') {
    return getReviewOverview();
  } else if (action === 'moveInboxItem') {
    return moveInboxItem(params.id, params.folder, params.file);
  } else if (action === 'moveInboxItems') {
    return moveInboxItems(params.items || []);
  } else if (action === 'searchItems') {
    return searchItems(params.keyword);
  } else if (action === 'searchData') {
    return searchData(params.keyword);
  } else if (action === 'getConfigList') {
    return getConfigList();
  } else if (action === 'addConfigRecord') {
    return { success: addConfigRecord(params.folder, params.file) };
  } else if (action === 'deleteConfigRecord') {
    return { success: deleteConfigRecord(params.folder, params.file) };
  } else if (action === 'updateConfigRecord') {
    return { success: updateConfigRecord(params.oldFolder, params.oldFile, params.newFolder, params.newFile) };
  } else if (action === 'getFolderFileItems') {
    return getFolderFileItems(params.folder, params.file);
  } else if (action === 'getAllDataGrouped') {
    return getAllDataGrouped({
      includeSystem: !!params.includeSystem,
      includeTrash: !!params.includeTrash
    });
  } else if (action === 'getSyncStamp') {
    return getSyncStamp();
  } else if (action === 'deleteDataRecord') {
    return deleteDataRecords(params.id != null ? [params.id] : []);
  } else if (action === 'deleteDataRecords') {
    return deleteDataRecords(params.ids || []);
  } else if (action === 'addDataRecord') {
    return addDataRecord(params.folder, params.file, params.content);
  } else if (action === 'addManyDataRecords') {
    return addManyDataRecords(params.items || []);
  } else if (action === 'updateInbox') {
    return updateInbox(params.id, params.content);
  } else if (action === 'updateDataRecord') {
    return updateDataRecordContent(params.id, params.content, params.folder, params.file);
  } else if (action === 'moveDataRecord') {
    return { success: moveDataRecord(params.id, params.folder, params.file) };
  } else if (action === 'moveDataRecords') {
    return moveDataRecords(params.items || []);
  } else if (action === 'purgeInboxExactDuplicates') {
    return purgeInboxExactDuplicates();
  } else if (action === 'findExactContentsInData') {
    return findExactContentsInData(params.contents || []);
  } else if (action === 'uploadDumpImage') {
    return uploadDumpImage(params.data || params.dataUrl || '', params.mimeType, params.fileName);
  } else if (action === 'uploadDumpImageBegin') {
    return uploadDumpImageBegin(params.uploadId, params.total, params.mimeType, params.fileName, params.length);
  } else if (action === 'uploadDumpImageChunk') {
    return uploadDumpImageChunk(params.uploadId, params.index, params.total, params.chunk);
  } else if (action === 'uploadDumpImageFinish') {
    return uploadDumpImageFinish(params.uploadId);
  } else if (action === 'getDumpImageById') {
    return getDumpImageById(params.id || params.fileId);
  } else if (action === 'syncGanttCalendarEvent') {
    return syncGanttCalendarEvent(params.task);
  } else if (action === 'deleteGanttCalendarEvent') {
    return deleteGanttCalendarEvent(params.googleEventId);
  } else if (action === 'syncAllGanttToCalendar') {
    return syncAllGanttToCalendar(params.tasks || []);
  } else if (action === 'lookupJanProduct') {
    return lookupJanProduct(params.barcode || params.code || '');
  } else if (action === 'keepWarm') {
    return keepWarm();
  }

  return { error: 'Unknown action: ' + action };
}

function runBatch(ops) {
  const results = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] || {};
    try {
      results.push(dispatchAction(op));
    } catch (err) {
      results.push({ error: err.toString() });
    }
  }
  const hasError = results.some(function (r) { return r && r.error; });
  return { success: !hasError, results: results };
}

const CACHE_KEY_ORG = 'organizer_data_v1';
const CACHE_KEY_STAMP = 'sync_stamp_v1';
const CACHE_TTL_SEC = 600; // 45秒 -> 600秒 (10分)。書き込み時は invalidateCache() で即座に破棄されるため安全かつ高速
const CACHE_STAMP_TTL_SEC = 21600;
const DATA_TRASH_FOLDER = '🗑️ ゴミ箱';
const DATA_TRASH_FILE = '削除履歴';

/**
 * 高速な JST 日付フォーマット関数
 * Utilities.formatDate は Java ネイティブ RPC のためループ内で呼ぶと極めて遅い。
 * 純粋な JS で整形することで 100〜500件でも一瞬で完了する。
 */
function formatJstDate_(d) {
  if (!d) return '';
  const date = (d instanceof Date) ? d : new Date(d);
  if (isNaN(date.getTime())) return '';
  // JST は UTC+9
  const jst = new Date(date.getTime() + (9 * 60 + date.getTimezoneOffset()) * 60000);
  const Y = jst.getFullYear();
  const M = ('0' + (jst.getMonth() + 1)).slice(-2);
  const D = ('0' + jst.getDate()).slice(-2);
  const h = ('0' + jst.getHours()).slice(-2);
  const m = ('0' + jst.getMinutes()).slice(-2);
  return Y + '/' + M + '/' + D + ' ' + h + ':' + m;
}

/**
 * コールドスタート防止用ウォームアップ関数
 * GASエディタのトリガー（時間主導型: 5分ごと）に設定すると
 * インスタンス休止を防ぎ、リクエスト時の起動遅延（2〜3秒）を解消できます。
 */
function keepWarm() {
  const stamp = getSyncStamp();
  return { success: true, warm: true, stamp: stamp.stamp };
}

function invalidateCache() {
  try {
    const cache = CacheService.getScriptCache();
    cache.remove(CACHE_KEY_ORG);
    cache.put(CACHE_KEY_STAMP, String(Date.now()), CACHE_STAMP_TTL_SEC);
  } catch (e) {}
}

function getSyncStamp() {
  const cache = CacheService.getScriptCache();
  try {
    let stamp = cache.get(CACHE_KEY_STAMP);
    if (!stamp) {
      stamp = String(Date.now());
      cache.put(CACHE_KEY_STAMP, stamp, CACHE_STAMP_TTL_SEC);
    }
    // imageApi: クライアントが画像エンドポイントの有無を判別するため
    return { stamp: stamp, imageApi: 3 };
  } catch (e) {
    return { stamp: '0', imageApi: 3 };
  }
}

/** エディタから1回実行して Drive 権限を承認する */
function authorizeDumpDrive() {
  DriveApp.getRootFolder().getName();
  const folder = getDumpImagesFolder();
  return 'Drive OK: ' + folder.getName();
}

function getDumpImagesFolder() {
  const ssFile = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId());
  let parent = null;
  const parents = ssFile.getParents();
  if (parents.hasNext()) parent = parents.next();
  else parent = DriveApp.getRootFolder();
  const name = 'DUMP_IMAGES';
  const folders = parent.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return parent.createFolder(name);
}

/** 分割アップロードの一時置き場（CacheService は大容量でチャンクが消える） */
function getDumpImageUploadTempFolder() {
  const parent = getDumpImagesFolder();
  const name = '_upload_tmp';
  const folders = parent.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return parent.createFolder(name);
}

function dumpImageUploadSafeId_(uploadId) {
  return String(uploadId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
}

function dumpImageUploadPartName_(id, index) {
  return id + '__' + index + '.part';
}

function dumpImageUploadMetaName_(id) {
  return id + '__meta.json';
}

function findNamedFileInFolder_(folder, fileName) {
  const files = folder.getFilesByName(fileName);
  if (files.hasNext()) return files.next();
  return null;
}

function removeNamedFileInFolder_(folder, fileName) {
  const files = folder.getFilesByName(fileName);
  while (files.hasNext()) {
    try { files.next().setTrashed(true); } catch (e) {}
  }
}

function cleanupDumpImageUpload_(folder, id, total) {
  try { removeNamedFileInFolder_(folder, dumpImageUploadMetaName_(id)); } catch (e) {}
  const n = parseInt(total, 10) || 0;
  for (let i = 0; i < n; i++) {
    try { removeNamedFileInFolder_(folder, dumpImageUploadPartName_(id, i)); } catch (e) {}
  }
}

/**
 * ブラウザ→GAS Webアプリはリダイレクトがあり、大きい1本POSTだと本文が欠ける。
 * 分割は Drive 一時ファイルへ保存（Cache 追い出し対策）。
 */
function uploadDumpImageBegin(uploadId, total, mimeType, fileName, length) {
  const id = dumpImageUploadSafeId_(uploadId);
  const t = parseInt(total, 10);
  if (!id) return { success: false, error: 'no_id' };
  if (!(t > 0) || t > 64) return { success: false, error: 'bad_total' };
  try {
    const folder = getDumpImageUploadTempFolder();
    const meta = JSON.stringify({
      total: t,
      mimeType: mimeType || 'image/jpeg',
      fileName: fileName || 'dump.jpg',
      length: parseInt(length, 10) || 0,
      createdAt: Date.now()
    });
    folder.createFile(dumpImageUploadMetaName_(id), meta, MimeType.PLAIN_TEXT);
  } catch (e) {
    return { success: false, error: 'drive_write', message: String(e && e.message ? e.message : e) };
  }
  return { success: true, uploadId: id, chunked: true, storage: 'drive' };
}

function uploadDumpImageChunk(uploadId, index, total, chunk) {
  const id = dumpImageUploadSafeId_(uploadId);
  const i = parseInt(index, 10);
  const c = String(chunk || '');
  if (!id || !(i >= 0) || !c) return { success: false, error: 'bad_chunk' };
  // 古いクライアント(80KB)も通す。Drive一時ファイルなので Cache 上限は関係ない
  if (c.length > 100000) return { success: false, error: 'chunk_too_large' };
  try {
    const folder = getDumpImageUploadTempFolder();
    const partName = dumpImageUploadPartName_(id, i);
    folder.createFile(partName, c, MimeType.PLAIN_TEXT);
  } catch (e) {
    return { success: false, error: 'drive_write', message: String(e && e.message ? e.message : e) };
  }
  return { success: true, index: i, storage: 'drive' };
}

function uploadDumpImageFinish(uploadId) {
  const id = dumpImageUploadSafeId_(uploadId);
  if (!id) return { success: false, error: 'no_id' };
  const folder = getDumpImageUploadTempFolder();
  const prefix = id + '__';
  const metaName = dumpImageUploadMetaName_(id);
  const foundFiles = [];
  let metaFile = null;
  const partMap = {};

  const iter = folder.searchFiles("title contains '" + prefix + "' and trashed = false");
  while (iter.hasNext()) {
    const f = iter.next();
    const name = f.getName();
    if (name.indexOf(prefix) !== 0) continue;
    foundFiles.push(f);
    if (name === metaName) {
      metaFile = f;
    } else if (name.endsWith('.part')) {
      const idxStr = name.slice(prefix.length, -5);
      const idx = parseInt(idxStr, 10);
      if (idx >= 0 && String(idx) === idxStr) {
        partMap[idx] = f;
      }
    }
  }

  const trashAll = function () {
    for (let k = 0; k < foundFiles.length; k++) {
      try { foundFiles[k].setTrashed(true); } catch (e) {}
    }
  };

  if (!metaFile) {
    trashAll();
    return { success: false, error: 'expired' };
  }
  let meta;
  try {
    meta = JSON.parse(metaFile.getBlob().getDataAsString());
  } catch (e) {
    trashAll();
    return { success: false, error: 'bad_meta' };
  }
  const total = parseInt(meta.total, 10) || 0;
  if (!(total > 0)) {
    trashAll();
    return { success: false, error: 'bad_total' };
  }
  const b64Parts = [];
  for (let i = 0; i < total; i++) {
    const partFile = partMap[i];
    if (!partFile) {
      trashAll();
      return { success: false, error: 'missing_chunk', index: i };
    }
    b64Parts.push(partFile.getBlob().getDataAsString());
  }
  let result;
  try {
    result = uploadDumpImage(b64Parts.join(''), meta.mimeType, meta.fileName);
  } finally {
    trashAll();
  }
  return result;
}

/** コピー用: Drive 画像を base64 で返す（ブラウザ CORS を避ける） */
function getDumpImageById(fileId) {
  const id = String(fileId || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) return { success: false, error: 'no_id' };
  try {
    try {
      const thumb = UrlFetchApp.fetch(
        'https://drive.google.com/thumbnail?id=' + id + '&sz=w1200',
        { muteHttpExceptions: true, followRedirects: true }
      );
      if (thumb.getResponseCode() === 200) {
        const blob = thumb.getBlob();
        const bytes = blob.getBytes();
        if (bytes && bytes.length > 80) {
          return {
            success: true,
            id: id,
            mimeType: blob.getContentType() || 'image/jpeg',
            data: Utilities.base64Encode(bytes),
            via: 'thumb'
          };
        }
      }
    } catch (e0) {}
    const file = DriveApp.getFileById(id);
    const blob = file.getBlob();
    const bytes = blob.getBytes();
    if (!bytes || !bytes.length) return { success: false, error: 'empty' };
    if (bytes.length > 1400000) return { success: false, error: 'too_large' };
    return {
      success: true,
      id: id,
      mimeType: blob.getContentType() || 'image/jpeg',
      data: Utilities.base64Encode(bytes),
      via: 'file'
    };
  } catch (e) {
    return { success: false, error: 'drive_read', message: String(e && e.message ? e.message : e) };
  }
}

/** 入力タブの写真。base64 を Drive に保存し、閲覧用 URL を返す */
function uploadDumpImage(dataUrlOrBase64, mimeType, fileName) {
  const raw = String(dataUrlOrBase64 || '');
  if (!raw) return { success: false, error: 'empty' };
  let mime = mimeType || 'image/jpeg';
  let b64 = raw;
  const m = raw.match(/^data:([^;]+);base64,(.+)$/i);
  if (m) {
    mime = m[1] || mime;
    b64 = m[2];
  }
  b64 = String(b64 || '').replace(/\s+/g, '');
  if (!b64) return { success: false, error: 'empty' };
  // 分割後の結合想定。単発POST向けの上限よりやや広め
  if (b64.length > 2200000) return { success: false, error: 'too_large' };
  let bytes;
  try {
    bytes = Utilities.base64Decode(b64);
  } catch (e) {
    return { success: false, error: 'bad_base64' };
  }
  if (!bytes || !bytes.length) return { success: false, error: 'empty' };
  const safeName = String(fileName || ('dump-' + Date.now() + '.jpg'))
    .replace(/[\\\/:\*\?"<>\|]+/g, '_')
    .slice(0, 80);
  let file;
  try {
    const blob = Utilities.newBlob(bytes, mime, safeName);
    file = getDumpImagesFolder().createFile(blob);
  } catch (e) {
    return { success: false, error: 'drive_write', message: String(e && e.message ? e.message : e) };
  }
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    // 共有設定失敗でも閲覧 URL は返す（ドメイン制限など）
  }
  const id = file.getId();
  // thumbnail の方が <img> 埋め込みで安定（uc?export=view はブラウザで壊れやすい）
  return {
    success: true,
    id: id,
    url: 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1000',
    viewUrl: 'https://drive.google.com/file/d/' + id + '/view',
    thumb: 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1000'
  };
}

let _activeSpreadsheet = null;
const _sheetCache = {};

function getActiveSpreadsheet_() {
  if (!_activeSpreadsheet) {
    _activeSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  }
  return _activeSpreadsheet;
}

function getSheet(sheetName) {
  if (_sheetCache[sheetName]) return _sheetCache[sheetName];
  const ss = getActiveSpreadsheet_();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    if (sheetName === 'INBOX') sheet.getRange(1, 1, 1, 3).setValues([['ID', 'Timestamp', 'Content']]);
    else if (sheetName === 'DATA') sheet.getRange(1, 1, 1, 5).setValues([['ID', 'Timestamp', 'Folder', 'File', 'Content']]);
    else if (sheetName === 'CONFIG') {
      sheet.getRange(1, 1, 4, 2).setValues([
        ['Folder', 'File'],
        ['Inbox', 'タスク'],
        ['Inbox', '栽培自動化'],
        ['knowledge', '出荷先拡大戦略']
      ]);
    }
  }
  _sheetCache[sheetName] = sheet;
  return sheet;
}

function addInbox(content) {
  if (!content || !String(content).trim()) return false;
  const sheet = getSheet('INBOX');
  const id = Utilities.getUuid();
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, 3).setValues([[id, new Date(), content]]);
  invalidateCache();
  return true;
}

function addManyInbox(contents) {
  const rows = (contents || [])
    .filter(c => c && String(c).trim())
    .map(c => [Utilities.getUuid(), new Date(), c]);
  if (rows.length === 0) return { success: true, count: 0, ids: [] };
  const sheet = getSheet('INBOX');
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
  invalidateCache();
  return { success: true, count: rows.length, ids: rows.map(function (r) { return String(r[0]); }) };
}

function getOrganizerData(fresh) {
  const cache = CacheService.getScriptCache();
  if (!fresh) {
    try {
      const cached = cache.get(CACHE_KEY_ORG);
      if (cached) return JSON.parse(cached);
    } catch (e) {}
  }

  const inboxSheet = getSheet('INBOX');
  const configSheet = getSheet('CONFIG');
  const inboxRows = inboxSheet.getDataRange().getValues();
  const count = Math.max(inboxRows.length - 1, 0);
  const nextItem = count > 0 ? { id: inboxRows[1][0], content: inboxRows[1][2] } : null;

  const allInboxItems = [];
  for (let i = 1; i < inboxRows.length; i++) {
    if (inboxRows[i][0]) {
      allInboxItems.push({
        id: inboxRows[i][0],
        timestamp: inboxRows[i][1] || "",
        content: inboxRows[i][2]
      });
    }
  }

  const configRows = configSheet.getDataRange().getValues();
  const configMap = {};
  for (let i = 1; i < configRows.length; i++) {
    const folder = configRows[i][0];
    const file = configRows[i][1];
    if (folder) {
      if (!configMap[folder]) configMap[folder] = [];
      if (file && !configMap[folder].includes(file)) configMap[folder].push(file);
    }
  }

  const result = {
    count: count,
    nextItem: nextItem,
    config: configMap,
    inbox: allInboxItems
  };

  try {
    cache.put(CACHE_KEY_ORG, JSON.stringify(result), CACHE_TTL_SEC);
  } catch (e) {}

  return result;
}

function getReviewOverview() {
  const organizer = getOrganizerData();
  const pendingByFolder = {};
  const dataSheet = getSheet('DATA');
  const rows = dataSheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    const folder = rows[i][2];
    const file = rows[i][3];
    if (!folder || file !== '未整理') continue;
    if (!pendingByFolder[folder]) pendingByFolder[folder] = [];
    pendingByFolder[folder].push({
      id: rows[i][0],
      timestamp: formatJstDate_(rows[i][1]),
      content: rows[i][4]
    });
  }

  return {
    organizer: organizer,
    pendingByFolder: pendingByFolder
  };
}

function moveInboxItem(id, folder, file) {
  const moved = moveInboxItems([{ id: id, folder: folder, file: file }]);
  if (!moved.success || moved.count === 0) throw new Error('Item not found');
  // 全件再取得はタイムアウトしやすく、編集保存が失敗したように見えるため返さない
  return { success: true, count: moved.count };
}

function updateInbox(id, content) {
  if (!id || content == null || !String(content).trim()) return { success: false, error: 'invalid' };
  const sheet = getSheet('INBOX');
  const rows = sheet.getDataRange().getValues();
  const target = String(id);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === target) {
      sheet.getRange(i + 1, 2, 1, 2).setValues([[new Date(), content]]);
      invalidateCache();
      return { success: true, id: target };
    }
  }
  return { success: false, error: 'not_found' };
}

function updateDataRecordContent(id, content, folder, file) {
  if (!id || content == null || !String(content).trim()) return { success: false, error: 'invalid' };
  const sheet = getSheet('DATA');
  const rows = sheet.getDataRange().getValues();
  const target = String(id);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === target) {
      const nextFolder = folder || rows[i][2];
      const nextFile = file || rows[i][3];
      sheet.getRange(i + 1, 2, 1, 4).setValues([[new Date(), nextFolder, nextFile, content]]);
      invalidateCache();
      return { success: true, id: target };
    }
  }
  return { success: false, error: 'not_found' };
}

function moveInboxItems(items) {
  if (!items || items.length === 0) return { success: true, count: 0 };

  const byId = {};
  items.forEach(function (item) {
    if (item && item.id != null && item.id !== '') byId[String(item.id)] = item;
  });

  const inboxSheet = getSheet('INBOX');
  const dataSheet = getSheet('DATA');
  const inboxRows = inboxSheet.getDataRange().getValues();
  const toAppend = [];
  const keepRows = [];

  for (let i = 1; i < inboxRows.length; i++) {
    const rowId = inboxRows[i][0];
    const target = byId[String(rowId)];
    if (target) {
      toAppend.push([rowId, new Date(), target.folder, target.file, inboxRows[i][2]]);
    } else {
      keepRows.push([inboxRows[i][0], inboxRows[i][1], inboxRows[i][2]]);
    }
  }

  if (toAppend.length === 0) return { success: true, count: 0 };

  dataSheet.getRange(dataSheet.getLastRow() + 1, 1, toAppend.length, 5).setValues(toAppend);

  // deleteRow の連打はタイムアウトしやすいので、残行を一括書き戻す
  const lastRow = inboxSheet.getLastRow();
  if (lastRow > 1) {
    inboxSheet.getRange(2, 1, lastRow - 1, 3).clearContent();
  }
  if (keepRows.length > 0) {
    inboxSheet.getRange(2, 1, keepRows.length, 3).setValues(keepRows);
  }
  const excess = inboxSheet.getLastRow() - (1 + keepRows.length);
  if (excess > 0) {
    inboxSheet.deleteRows(2 + keepRows.length, excess);
  }

  invalidateCache();
  return { success: true, count: toAppend.length };
}

function isExcludedDataLocation(folder) {
  if (!folder) return true;
  const name = String(folder);
  return name === '__SYSTEM__' || name === '🗑️ ゴミ箱' || name.indexOf('ゴミ箱') !== -1;
}

function buildDataContentSet() {
  const dataSheet = getSheet('DATA');
  const rows = dataSheet.getDataRange().getValues();
  const contentSet = {};
  for (let i = 1; i < rows.length; i++) {
    const folder = rows[i][2];
    const content = rows[i][4];
    if (isExcludedDataLocation(folder)) continue;
    if (content == null || content === '') continue;
    contentSet[String(content).trim()] = true;
  }
  return contentSet;
}

function findExactContentsInData(contents) {
  if (!contents || contents.length === 0) return { matches: [] };
  const contentSet = buildDataContentSet();
  const matches = [];
  const seen = {};
  contents.forEach(function (content) {
    const key = String(content || '').trim();
    if (!key || seen[key]) return;
    if (contentSet[key]) {
      seen[key] = true;
      matches.push(key);
    }
  });
  return { matches: matches };
}

function purgeInboxExactDuplicates() {
  const contentSet = buildDataContentSet();
  const inboxSheet = getSheet('INBOX');
  const inboxRows = inboxSheet.getDataRange().getValues();
  const toTrash = [];
  const purgedContents = [];

  for (let i = 1; i < inboxRows.length; i++) {
    const id = inboxRows[i][0];
    const content = inboxRows[i][2];
    if (!id || content == null || content === '') continue;
    const key = String(content).trim();
    if (contentSet[key]) {
      toTrash.push({ id: id, folder: '🗑️ ゴミ箱', file: '削除履歴' });
      purgedContents.push(key);
    }
  }

  if (toTrash.length === 0) {
    return { success: true, count: 0, purgedContents: [] };
  }

  const moved = moveInboxItems(toTrash);
  return {
    success: !!moved.success,
    count: moved.count || 0,
    purgedContents: purgedContents
  };
}

function searchItems(keyword) {
  if (!keyword || !String(keyword).trim()) return [];
  const dataSheet = getSheet('DATA');
  const rows = dataSheet.getDataRange().getValues();
  const results = [];
  for (let i = 1; i < rows.length; i++) {
    const folder = rows[i][2];
    const file = rows[i][3];
    if (isExcludedDataLocation(folder)) continue;
    if (file && String(file) === '削除履歴') continue;
    const content = rows[i][4];
    if ((folder && String(folder).includes(keyword)) ||
        (file && String(file).includes(keyword)) ||
        (content && String(content).includes(keyword))) {
      const rawTs = rows[i][1];
      results.push({
        id: rows[i][0],
        timestamp: formatJstDate_(rawTs),
        sortKey: rawTs ? new Date(rawTs).getTime() : 0,
        folder: folder,
        file: file,
        content: content,
        isInbox: false
      });
    }
  }
  results.sort(function (a, b) { return (b.sortKey || 0) - (a.sortKey || 0); });
  return results.map(function (r) {
    delete r.sortKey;
    return r;
  });
}

function searchData(keyword) {
  if (!keyword || !String(keyword).trim()) return [];
  const results = [];

  const inboxSheet = getSheet('INBOX');
  const inboxRows = inboxSheet.getDataRange().getValues();
  for (let i = 1; i < inboxRows.length; i++) {
    const content = inboxRows[i][2];
    if (content && String(content).includes(keyword)) {
      const ts = inboxRows[i][1];
      results.push({
        id: inboxRows[i][0],
        timestamp: formatJstDate_(ts),
        sortKey: ts ? new Date(ts).getTime() : 0,
        folder: 'INBOX',
        file: '未整理',
        content: content,
        isInbox: true
      });
    }
  }

  const dataSheet = getSheet('DATA');
  const rows = dataSheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    const folder = rows[i][2];
    const file = rows[i][3];
    // ゴミ箱・システムは検索対象外（削除済みの再表示を防ぐ）
    if (isExcludedDataLocation(folder)) continue;
    if (file && String(file) === '削除履歴') continue;
    const content = rows[i][4];
    if ((folder && String(folder).includes(keyword)) ||
        (file && String(file).includes(keyword)) ||
        (content && String(content).includes(keyword))) {
      const rawTs = rows[i][1];
      results.push({
        id: rows[i][0],
        timestamp: formatJstDate_(rawTs),
        sortKey: rawTs ? new Date(rawTs).getTime() : 0,
        folder: folder,
        file: file,
        content: content,
        isInbox: false
      });
    }
  }
  results.sort(function (a, b) { return (b.sortKey || 0) - (a.sortKey || 0); });
  return results.map(function (r) {
    delete r.sortKey;
    return r;
  });
}

function getConfigList() {
  const sheet = getSheet('CONFIG');
  const rows = sheet.getDataRange().getValues();
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] || rows[i][1]) list.push({ folder: rows[i][0], file: rows[i][1] });
  }
  return list;
}

function addConfigRecord(folder, file) {
  if (!folder || !String(folder).trim()) return false;
  const fileValue = file == null ? '' : String(file).trim();
  const sheet = getSheet('CONFIG');
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, 2).setValues([[String(folder).trim(), fileValue]]);
  invalidateCache();
  return true;
}

function deleteConfigRecord(folder, file) {
  const sheet = getSheet('CONFIG');
  const rows = sheet.getDataRange().getValues();
  const fileValue = file == null ? '' : file;
  let changed = false;
  for (let i = rows.length - 1; i >= 1; i--) {
    if (rows[i][0] === folder && rows[i][1] === fileValue) {
      sheet.deleteRow(i + 1);
      changed = true;
    }
  }
  if (changed) invalidateCache();
  return true;
}

function updateConfigRecord(oldFolder, oldFile, newFolder, newFile) {
  if (!newFolder || !String(newFolder).trim()) return false;

  const oldFileValue = oldFile == null ? '' : oldFile;
  const newFolderValue = String(newFolder).trim();
  const newFileValue = newFile == null ? '' : String(newFile).trim();

  // ファイル指定ありのときは新ファイル名も必須
  if (oldFileValue !== '' && newFileValue === '') return false;

  const configSheet = getSheet('CONFIG');
  const configRows = configSheet.getDataRange().getValues();
  let changed = false;

  for (let i = 1; i < configRows.length; i++) {
    const matchFolder = configRows[i][0] === oldFolder;
    const matchFile = oldFileValue === ''
      ? true
      : configRows[i][1] === oldFileValue;
    if (matchFolder && matchFile) {
      const nextFile = oldFileValue === '' && newFileValue === ''
        ? configRows[i][1]
        : newFileValue;
      configSheet.getRange(i + 1, 1, 1, 2).setValues([[newFolderValue, nextFile]]);
      changed = true;
      if (oldFileValue !== '') break;
    }
  }

  const dataSheet = getSheet('DATA');
  const dataRows = dataSheet.getDataRange().getValues();
  for (let i = 1; i < dataRows.length; i++) {
    const matchFolder = dataRows[i][2] === oldFolder;
    const matchFile = oldFileValue === ''
      ? true
      : dataRows[i][3] === oldFileValue;
    if (matchFolder && matchFile) {
      const nextFile = oldFileValue === '' && newFileValue === ''
        ? dataRows[i][3]
        : newFileValue;
      dataSheet.getRange(i + 1, 3, 1, 2).setValues([[newFolderValue, nextFile]]);
      changed = true;
    }
  }

  if (changed) invalidateCache();
  return true;
}

function getFolderFileItems(folder, file) {
  const dataSheet = getSheet('DATA');
  const rows = dataSheet.getDataRange().getValues();
  const results = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][2] === folder && rows[i][3] === file) {
      results.push({
        id: rows[i][0],
        timestamp: formatJstDate_(rows[i][1]),
        content: rows[i][4]
      });
    }
  }
  return results;
}

/** DATA を1回読んで folder→file→items にまとめる（N回 getFolderFileItems の代替） */
function getAllDataGrouped(opts) {
  opts = opts || {};
  const includeSystem = !!opts.includeSystem;
  const includeTrash = !!opts.includeTrash;
  const dataSheet = getSheet('DATA');
  const rows = dataSheet.getDataRange().getValues();
  const grouped = {};
  const items = [];

  for (let i = 1; i < rows.length; i++) {
    const folder = rows[i][2];
    const file = rows[i][3];
    if (!folder) continue;
    const folderName = String(folder);
    if (!includeTrash && folderName.indexOf('ゴミ箱') !== -1) continue;
    if (!includeSystem && folderName === '__SYSTEM__') continue;

    const entry = {
      id: rows[i][0],
      timestamp: formatJstDate_(rows[i][1]),
      content: rows[i][4]
    };
    if (!grouped[folderName]) grouped[folderName] = {};
    if (!grouped[folderName][file]) grouped[folderName][file] = [];
    grouped[folderName][file].push(entry);
    items.push({
      id: entry.id,
      timestamp: entry.timestamp,
      content: entry.content,
      folder: folderName,
      file: file
    });
  }

  return { grouped: grouped, items: items };
}

function deleteDataRecord(id) {
  return deleteDataRecords([id]);
}

/** 物理削除（全件書き戻し）ではなくゴミ箱へ論理移動 */
function deleteDataRecords(ids) {
  if (!ids || ids.length === 0) return { success: true, count: 0 };
  const moves = [];
  ids.forEach(function (id) {
    if (id != null && id !== '') {
      moves.push({ id: id, folder: DATA_TRASH_FOLDER, file: DATA_TRASH_FILE });
    }
  });
  return moveDataRecords(moves);
}

function addDataRecord(folder, file, content) {
  if (!content || !String(content).trim()) return { success: false };
  const sheet = getSheet('DATA');
  const id = Utilities.getUuid();
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, 5).setValues([[id, new Date(), folder, file, content]]);
  invalidateCache();
  return { success: true, id: id };
}

function addManyDataRecords(items) {
  const rows = (items || [])
    .filter(function (item) { return item && item.content && String(item.content).trim(); })
    .map(function (item) {
      return [Utilities.getUuid(), new Date(), item.folder, item.file, item.content];
    });
  if (rows.length === 0) return { success: true, count: 0, ids: [] };
  const sheet = getSheet('DATA');
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
  invalidateCache();
  return { success: true, count: rows.length, ids: rows.map(function (r) { return String(r[0]); }) };
}

function moveDataRecord(id, folder, file) {
  return moveDataRecords([{ id: id, folder: folder, file: file }]).count > 0;
}

/** Folder/File 列を1回の setValues で更新（行ごとの API 連打を避ける） */
function moveDataRecords(items) {
  if (!items || items.length === 0) return { success: true, count: 0 };
  const byId = {};
  items.forEach(function (item) {
    if (item && item.id != null && item.id !== '') byId[String(item.id)] = item;
  });

  const dataSheet = getSheet('DATA');
  const rows = dataSheet.getDataRange().getValues();
  if (rows.length <= 1) return { success: true, count: 0 };

  const colCD = [];
  let count = 0;
  for (let i = 1; i < rows.length; i++) {
    const target = byId[String(rows[i][0])];
    if (target) {
      colCD.push([target.folder, target.file]);
      count++;
    } else {
      colCD.push([rows[i][2], rows[i][3]]);
    }
  }
  if (count === 0) return { success: true, count: 0 };

  dataSheet.getRange(2, 3, colCD.length, 2).setValues(colCD);
  invalidateCache();
  return { success: true, count: count };
}

/**
 * ===== ガント × Googleカレンダー連携 =====
 */
function parseGanttDateForCalendar_(str, addDays) {
  if (!str) return new Date();
  const parts = String(str).split('-');
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10) - 1;
  const d = parseInt(parts[2], 10) + (addDays || 0);
  return new Date(y, m, d);
}

function syncGanttCalendarEvent(task) {
  if (!task || !task.title) {
    return { success: false, error: 'task or title missing' };
  }
  try {
    const cal = CalendarApp.getDefaultCalendar();
    if (!cal) {
      return { success: false, error: 'デフォルトのGoogleカレンダーが見つかりません' };
    }
    const title = (task.done ? '【完了】' : '') + String(task.title).trim();
    const startDate = parseGanttDateForCalendar_(task.start, 0);
    const endDate = parseGanttDateForCalendar_(task.end || task.start, 1);
    const desc = '[DUMPガント連携]\nタスクID: ' + (task.id || '') + '\n期間: ' + (task.start || '') + ' 〜 ' + (task.end || '') + (task.done ? '\nステータス: 完了' : '');

    let event = null;
    if (task.googleEventId) {
      try {
        event = cal.getEventById(task.googleEventId);
      } catch (_) {
        event = null;
      }
    }

    if (event) {
      event.setTitle(title);
      event.setAllDayDates(startDate, endDate);
      event.setDescription(desc);
      return { success: true, googleEventId: event.getId(), updated: true };
    } else {
      const created = cal.createAllDayEvent(title, startDate, endDate, {
        description: desc
      });
      return { success: true, googleEventId: created.getId(), created: true };
    }
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

function deleteGanttCalendarEvent(googleEventId) {
  if (!googleEventId) return { success: true };
  try {
    const cal = CalendarApp.getDefaultCalendar();
    if (!cal) return { success: false, error: 'カレンダーが見つかりません' };
    const event = cal.getEventById(googleEventId);
    if (event) {
      event.deleteEvent();
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

function syncAllGanttToCalendar(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (t && t.title) {
      const res = syncGanttCalendarEvent(t);
      results.push({
        id: t.id,
        success: !!(res && res.success),
        googleEventId: res && res.googleEventId ? res.googleEventId : (t.googleEventId || ''),
        error: res && res.error
      });
    }
  }
  return { success: true, results: results };
}

function cleanJanProductName_(raw) {
  let s = String(raw || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  s = s.replace(/【[^】]*】/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s;
}

function lookupJanProduct(barcode) {
  const code = String(barcode || '').replace(/[^\dA-Za-z]/g, '').trim();
  if (!code) return { success: false, name: '', source: '' };

  const candidates = [code];
  if (code.length === 13 && code.charAt(0) === '0') {
    candidates.push(code.slice(1));
  }

  // 1. OpenFoodFacts API
  for (let i = 0; i < candidates.length; i++) {
    try {
      const url = 'https://world.openfoodfacts.org/api/v2/product/' + encodeURIComponent(candidates[i]) + '.json?fields=product_name,product_name_ja,brands';
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (res.getResponseCode() === 200) {
        const json = JSON.parse(res.getContentText() || '{}');
        if (json && json.status === 1 && json.product) {
          const p = json.product;
          const baseName = (p.product_name_ja || p.product_name || '').trim();
          const brand = (p.brands || '').split(',')[0].trim();
          let fullName = baseName;
          if (brand && baseName && baseName.toLowerCase().indexOf(brand.toLowerCase()) === -1) {
            fullName = brand + ' ' + baseName;
          }
          const cleaned = cleanJanProductName_(fullName || brand);
          if (cleaned) return { success: true, name: cleaned, source: 'openfoodfacts' };
        }
      }
    } catch (e) {}
  }

  // 2. UPCitemdb Trial API
  for (let i = 0; i < candidates.length; i++) {
    try {
      const url = 'https://api.upcitemdb.com/prod/trial/lookup?upc=' + encodeURIComponent(candidates[i]);
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (res.getResponseCode() === 200) {
        const json = JSON.parse(res.getContentText() || '{}');
        if (json && json.items && json.items.length > 0 && json.items[0].title) {
          const cleaned = cleanJanProductName_(json.items[0].title);
          if (cleaned) return { success: true, name: cleaned, source: 'upcitemdb' };
        }
      }
    } catch (e) {}
  }

  // 3. Yahoo!ショッピング検索 (国内JANコード向け)
  try {
    const url = 'https://shopping.yahoo.co.jp/search?p=' + encodeURIComponent(code);
    const res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DumpApp/1.0)' }
    });
    if (res.getResponseCode() === 200) {
      const html = res.getContentText() || '';
      const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (nextMatch && nextMatch[1]) {
        const data = JSON.parse(nextMatch[1]);
        const str = JSON.stringify(data);
        const nameMatch = str.match(/"name":"([^"]{4,120})"/);
        if (nameMatch && nameMatch[1]) {
          const cleaned = cleanJanProductName_(nameMatch[1]);
          if (cleaned && cleaned.indexOf('Yahoo') === -1) {
            return { success: true, name: cleaned, source: 'yahoo_shopping' };
          }
        }
      }
    }
  } catch (e) {}

  return { success: false, name: '', source: '' };
}
