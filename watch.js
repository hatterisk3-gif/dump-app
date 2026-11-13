const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 🌟 DUMP専用ターゲット指定付きURL
const GAS_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbw7y4G2ltoMtBtyu0fqqClXfzOloZMm4fe1bd3zk5epOAoa7glPOcwc_8vAJxIl3lBz/exec?target=DUMP';

const LOCK_FILE = path.join(__dirname, '.watch.lock');
const TASK_FILE = path.join(__dirname, '.ai_task.txt');
const DONE_FILE = path.join(__dirname, '.ai_task_done.txt');

// 🌟 画像URL・ID・ローカル保存パスを一時記憶する配列
let pendingImages = [];

function isPidAlive(pid) {
    if (!pid || !Number.isFinite(pid)) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

function acquireWatchLock() {
    try {
        if (fs.existsSync(LOCK_FILE)) {
            const prev = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
            if (isPidAlive(prev) && prev !== process.pid) {
                console.error(`❌ 別の watch.js が起動中です (pid=${prev})。`);
                process.exit(1);
            }
        }
        fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
    } catch (e) { }
}

function releaseWatchLock() {
    try {
        if (fs.existsSync(LOCK_FILE)) {
            const cur = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
            if (!cur || cur === process.pid) fs.unlinkSync(LOCK_FILE);
        }
    } catch (e) { }
}

process.on('exit', releaseWatchLock);
process.on('SIGINT', () => { releaseWatchLock(); process.exit(0); });
process.on('SIGTERM', () => { releaseWatchLock(); process.exit(0); });

// 📸 Googleドライブの画像をローカルにダウンロードする関数（エディタAIが確実に読めるようにする）
async function downloadImageToLocal(url, index) {
    try {
        const res = await fetch(url, { redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        const fileName = `line_image_${Date.now()}_${index}.jpg`;
        const filePath = path.join(__dirname, fileName);
        fs.writeFileSync(filePath, buffer);
        console.log(`📥 画像をローカルに保存しました: ${fileName}`);
        return fileName;
    } catch (e) {
        console.warn(`⚠️ 画像のローカル保存に失敗（URL参照にフォールバックします）: ${e.message}`);
        return null;
    }
}

// 🤖 エディタ（Antigravity）を最前面に出して指示を貼り付け・送信する関数
async function runAIAgent(promptText) {
    if (fs.existsSync(DONE_FILE)) fs.unlinkSync(DONE_FILE);
    fs.writeFileSync(TASK_FILE, promptText, 'utf8');

    const windowKeyword = path.basename(__dirname); // "dump-app"

    // 2. 該当フォルダ名のウィンドウを最前面に出し、右下のチャット入力欄を自動クリックして Ctrl+V → Enter
    const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
}
"@

$text = Get-Content -Path "${TASK_FILE.replace(/\\/g, '\\\\')}" -Raw -Encoding UTF8
Set-Clipboard -Value $text

$proc = Get-Process | Where-Object { $_.MainWindowTitle -like "*${windowKeyword}*" } | Select-Object -First 1

if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
  $hWnd = $proc.MainWindowHandle
  [Win32]::ShowWindowAsync($hWnd, 9) | Out-Null
  Start-Sleep -Milliseconds 200
  [Win32]::SetForegroundWindow($hWnd) | Out-Null
  Start-Sleep -Milliseconds 400

  # ウィンドウの四隅の座標を取得し、右下（チャット入力欄）を計算して自動クリック
  $rect = New-Object Win32+RECT
  [Win32]::GetWindowRect($hWnd, [ref]$rect) | Out-Null
  $clickX = $rect.Right - 180
  $clickY = $rect.Bottom - 85

  [Win32]::SetCursorPos($clickX, $clickY) | Out-Null
  Start-Sleep -Milliseconds 150
  # 左クリック (MOUSEEVENTF_LEFTDOWN = 0x02, MOUSEEVENTF_LEFTUP = 0x04)
  [Win32]::mouse_event(0x02, 0, 0, 0, 0)
  [Win32]::mouse_event(0x04, 0, 0, 0, 0)
  Start-Sleep -Milliseconds 300

  $wshell = New-Object -ComObject wscript.shell
  $wshell.SendKeys('^v')
  Start-Sleep -Milliseconds 400
  $wshell.SendKeys('{ENTER}')
} else {
  Write-Warning "対象のウィンドウ (*${windowKeyword}*) が見つかりませんでした。"
}
`;

    const psFile = path.join(__dirname, 'tmp_send.ps1');
    fs.writeFileSync(psFile, '\ufeff' + psScript, 'utf8');
    try {
        execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`);
    } catch (e) {
        console.warn('⚠️ キー送信エラー:', e.message);
    }
    try { fs.unlinkSync(psFile); } catch (e) { }

    console.log(`📝 エディタ（${windowKeyword}）を最前面に出して指示を送信しました！`);

    let waitTime = 0;
    while (!fs.existsSync(DONE_FILE) && waitTime < 1800) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        waitTime++;
    }

    if (!fs.existsSync(DONE_FILE)) {
        console.log('⚠️ 待機時間を超えましたが、不要なタイムアウト報告はスキップします。');
        try { fs.unlinkSync(TASK_FILE); } catch (e) { }
        return '';
    }

    console.log('✅ IDEでのAI処理が完了しました！');
    let aiReportText = '';
    for (let r = 0; r < 5; r++) {
        try {
            if (fs.existsSync(DONE_FILE)) {
                aiReportText = fs.readFileSync(DONE_FILE, 'utf8').trim();
                break;
            }
        } catch (e) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    for (let r = 0; r < 3; r++) {
        try {
            if (fs.existsSync(TASK_FILE)) fs.unlinkSync(TASK_FILE);
            if (fs.existsSync(DONE_FILE)) fs.unlinkSync(DONE_FILE);
            break;
        } catch (e) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    return aiReportText;
}

async function fetchGasJson(options) {
    const response = await fetch(GAS_WEBAPP_URL, options);
    if (!response.ok) throw new Error(`GAS HTTP ${response.status}`);
    const text = await response.text();
    return JSON.parse(text);
}

async function fetchNextJob() {
    const data = await fetchGasJson({ method: 'GET' });
    if (data.rowIndex > 0) {
        const cmdStr = String(data.command || '').trim();
        if (cmdStr) {
            return data;
        } else {
            await notifyJobComplete(data.rowIndex, '【スキップ】指示文が空のためスキップしました。', '指示文が空のためスキップしました。', []);
            return null;
        }
    }
    return null;
}

let lastNotifiedRow = null;
let lastNotifiedTime = 0;

async function notifyJobComplete(rowIndex, summary, fullSummary, fileIds) {
    const now = Date.now();
    if (lastNotifiedRow === rowIndex && (now - lastNotifiedTime) < 15000) return true;
    lastNotifiedRow = rowIndex;
    lastNotifiedTime = now;

    const updatePayload = {
        action: 'update',
        row: rowIndex,
        summary: summary,
        fullSummary: fullSummary || summary
    };
    if (fileIds && fileIds.length > 0) updatePayload.fileIds = fileIds;

    for (let retries = 5; retries > 0; retries--) {
        try {
            const res = await fetch(GAS_WEBAPP_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updatePayload),
                redirect: 'manual'
            });
            if (res.status === 200 || res.status === 302 || res.type === 'opaqueredirect') {
                console.log(`🔔 完了通知をGASへ送信しました。(row=${rowIndex})`);
                return true;
            }
        } catch (e) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    return false;
}

function cleanupTempFiles() {
    try {
        const files = fs.readdirSync(__dirname);
        files.forEach(file => {
            const lowerFile = file.toLowerCase();
            if (lowerFile.startsWith('line_image_') || lowerFile.startsWith('tmp_')) {
                try { fs.unlinkSync(path.join(__dirname, file)); } catch (e) { }
            }
        });
    } catch (e) { }
}

function collectGitDiffSummary() {
    let fileChangesText = '';
    let changedFilesList = new Set();
    try {
        const statusOut = execSync('git status --porcelain', { cwd: __dirname, env: { ...process.env, GIT_PAGER: 'cat' } }).toString().trim();
        let modified = new Set(), added = new Set(), deleted = new Set();
        if (statusOut) {
            statusOut.split('\n').forEach(line => {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 2) {
                    const status = parts[0].charAt(0);
                    const file = parts[parts.length - 1];
                    if (file.startsWith('tmp_') || file.startsWith('line_image_') || file === '.ai_task.txt' || file === '.ai_task_done.txt' || file === '.watch.lock') return;
                    changedFilesList.add(file);
                    if (status === 'A' || status === '?') added.add(file);
                    else if (status === 'D') deleted.add(file);
                    else modified.add(file);
                }
            });
        }
        if (modified.size > 0) fileChangesText += `\n【変更】: ${Array.from(modified).join(', ')}`;
        if (added.size > 0) fileChangesText += `\n【追加】: ${Array.from(added).join(', ')}`;
        if (deleted.size > 0) fileChangesText += `\n【削除】: ${Array.from(deleted).join(', ')}`;
    } catch (e) { }
    return { summaryText: fileChangesText, changedFiles: Array.from(changedFilesList) };
}

async function processJob(data) {
    const rowIndex = data.rowIndex;
    const rawCommand = data.command;
    let summaryForLine = '✅ 処理完了';
    let fullSummaryForEmail = '';
    let usedImageIds = [];

    console.log(`🤖 DUMP指示を処理開始 (row=${rowIndex}): "${String(rawCommand).slice(0, 80)}"`);

    try {
        // 📸 1. 画像受信モード
        if (String(rawCommand).startsWith('[IMAGE_URL:')) {
            const urlMatch = String(rawCommand).match(/\[IMAGE_URL:\s*(.*?)\]/);
            if (urlMatch && urlMatch[1]) {
                const url = urlMatch[1];
                let id = '';
                const idMatch = url.match(/id=([^&]+)/);
                if (idMatch && idMatch[1]) id = idMatch[1];

                const localFile = await downloadImageToLocal(url, pendingImages.length + 1);
                pendingImages.push({ url, id, localFile });
                console.log(`📸 DUMP用画像を受信しました（現在 ${pendingImages.length} 枚待機中）`);
                summaryForLine = `✅ [DUMP] ${pendingImages.length}枚目の画像をセットしました！続けて「Dump 〇〇して」と指示を送ってください。`;
                fullSummaryForEmail = summaryForLine;
            }
        }
        // 💬 2. テキスト指示モード
        else {
            const cleanCommand = String(rawCommand).replace(/\r?\n/g, '、').replace(/"/g, '”');
            let imageContext = '';

            if (pendingImages.length > 0) {
                const fileRefs = pendingImages
                    .map(img => img.localFile ? `./${img.localFile} (URL: ${img.url})` : img.url)
                    .join('\n');
                imageContext = `【重要】ワークスペース内に保存された以下の画像ファイル（またはURL）を視覚的に確認し、参考資料として指示を実行してください。\n参照画像:\n${fileRefs}\n\n`;
                usedImageIds = pendingImages.map(img => img.id).filter(id => id !== '');
                pendingImages = [];
            }

            const isSlashDeploy = /^\/deploy\b/i.test(cleanCommand.trim());
            const modifyPrompt = isSlashDeploy
                ? `/deploy\n\n※デプロイ処理がすべて完了したら、必ず最後に Node.js の \`fs.writeFileSync('.ai_task_done.txt', 'デプロイ完了レポート本文', 'utf8')\` を実行して「.ai_task_done.txt」を作成してください。`
                : `${imageContext}${cleanCommand}
【最後に行うことのリスト】
 1.修正したら、個所が正しく動作するか自律的にテスト・再修正してください。
 2.テストや検証用にスクリプトを作成する場合は、必ず 'tmp_' から始まるファイル名を使用してください。
 3.システム動作に関係のない一時ファイルは削除してください。
 4.必ず Node.js の \`fs.writeFileSync('.ai_task_done.txt', 'レポート本文', 'utf8')\` を使って詳細の解説レポートを記した「 .ai_task_done.txt 」を作成すること。`;

            const rawAiOutput = await runAIAgent(modifyPrompt);
            const aiOutput = (rawAiOutput && rawAiOutput !== '完了') ? rawAiOutput : 'AI処理が完了しました。';

            cleanupTempFiles();
            const diffInfo = collectGitDiffSummary();
            const shortAiOutput = aiOutput.length > 1500 ? aiOutput.slice(0, 1500) + '\n...(以下省略)' : aiOutput;

            if (isSlashDeploy) {
                summaryForLine = `🚀 【DUMP デプロイ完了】\n${diffInfo.summaryText}\n\n${shortAiOutput}`;
            } else {
                summaryForLine = `🛠️ 【DUMP 修正完了】\n${diffInfo.summaryText}\n\n${shortAiOutput}`;
            }
            fullSummaryForEmail = summaryForLine;
        }
    } catch (err) {
        console.error('❌ 処理エラー:', err.message);
        summaryForLine = `【エラー】${err.message}`;
        fullSummaryForEmail = summaryForLine;
    } finally {
        await notifyJobComplete(rowIndex, summaryForLine, fullSummaryForEmail, usedImageIds);
    }
}

async function drainQueue() {
    while (true) {
        let job = null;
        try { job = await fetchNextJob(); } catch (e) { break; }
        if (!job) break;
        await processJob(job);
        await new Promise(resolve => setTimeout(resolve, 1500));
    }
}

let isProcessing = false;
async function loop() {
    if (!isProcessing) {
        isProcessing = true;
        try { await drainQueue(); } finally { isProcessing = false; }
    }
    setTimeout(loop, 1000);
}

acquireWatchLock();
console.log('👀 DUMP用 AIブリッジ起動：LINEからの指示・画像を待機中...');
loop();