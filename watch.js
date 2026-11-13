const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// AGY通信局のURL + ?target=DUMP を指定する
const GAS_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbw7y4G2ltoMtBtyu0fqqClXfzOloZMm4fe1bd3zk5epOAoa7glPOcwc_8vAJxIl3lBz/exec?target=DUMP';

const LOCK_FILE = path.join(__dirname, '.watch.lock');
const TASK_FILE = path.join(__dirname, '.ai_task.txt');
const DONE_FILE = path.join(__dirname, '.ai_task_done.txt');

let pendingImages = [];

// -------------------------------------------------------------------
// 🔒 二重起動防止ロック
// -------------------------------------------------------------------
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
    } catch (e) {
        console.warn('⚠️ ロックファイル作成警告:', e.message);
    }
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

// -------------------------------------------------------------------
// 🤖 エディタ（Antigravity IDE）へ指示を貼り付けて完了を待つ処理
// -------------------------------------------------------------------
async function runIDEAgent(promptText) {
    if (fs.existsSync(DONE_FILE)) fs.unlinkSync(DONE_FILE);

    // 1. プロンプトを .ai_task.txt に保存
    fs.writeFileSync(TASK_FILE, promptText, 'utf8');

    // 2. PowerShellでクリップボードにコピーし、そのまま Ctrl+V と Enter を押す
    const psScript = `
$text = Get-Content -Path "${TASK_FILE.replace(/\\/g, '\\\\')}" -Raw -Encoding UTF8
Set-Clipboard -Value $text
$wshell = New-Object -ComObject wscript.shell
$wshell.SendKeys('^v')
Start-Sleep -Milliseconds 400
$wshell.SendKeys('{ENTER}')
`;
    const psFile = path.join(__dirname, 'tmp_send.ps1');
    fs.writeFileSync(psFile, '\ufeff' + psScript, 'utf8');
    try {
        execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`);
    } catch (e) {
        console.warn('⚠️ キー送信エラー:', e.message);
    }
    try { fs.unlinkSync(psFile); } catch (e) { }

    console.log('📝 エディタ（Antigravity）に指示を送信しました！');

    // AIが .ai_task_done.txt を作成するまで最大30分待機
    let waitTime = 0;
    while (!fs.existsSync(DONE_FILE) && waitTime < 1800) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        waitTime++;
    }

    if (!fs.existsSync(DONE_FILE)) {
        console.log('⚠️ 待機タイムアウト（応答なし）のためスキップします。');
        try { fs.unlinkSync(TASK_FILE); } catch (e) { }
        return '';
    }

    console.log('✅ エディタでのAI処理が完了しました！');
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

    // 一時ファイルの削除
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

// -------------------------------------------------------------------
// 📡 GAS（スプレッドシート）との通信処理
// -------------------------------------------------------------------
async function fetchNextJob() {
    const response = await fetch(GAS_WEBAPP_URL, { method: 'GET' });
    if (!response.ok) throw new Error(`GAS HTTP ${response.status}`);
    const data = await response.json();

    if (data.rowIndex > 0) {
        const cmdStr = String(data.command || '').trim();
        if (cmdStr) return data;

        // 空行だった場合は「処理中」のまま残らないよう即座に完了返し
        await notifyJobComplete(data.rowIndex, '【スキップ】指示文が空でした。', '', []);
    }
    return null;
}

async function notifyJobComplete(rowIndex, summary, fullSummary, fileIds) {
    const updatePayload = {
        action: 'update',
        row: rowIndex,
        summary: summary,
        fullSummary: fullSummary || summary
    };
    if (fileIds && fileIds.length > 0) updatePayload.fileIds = fileIds;

    for (let i = 0; i < 5; i++) {
        try {
            const res = await fetch(GAS_WEBAPP_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updatePayload),
                redirect: 'manual'
            });
            if (res.status === 200 || res.status === 302 || res.type === 'opaqueredirect') {
                console.log(`🔔 完了通知をGASへ送信しました (row=${rowIndex})`);
                return true;
            }
        } catch (e) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    console.error(`❌ GASへの完了通知に失敗しました (row=${rowIndex})`);
    return false;
}

function getChangedFilesText() {
    try {
        const status = execSync('git status --porcelain', { cwd: __dirname }).toString().trim();
        if (!status) return '';
        const files = status.split('\n')
            .map(line => line.trim().split(/\s+/).pop())
            .filter(f => f && !f.startsWith('tmp_') && !['.ai_task.txt', '.ai_task_done.txt', '.watch.lock'].includes(f));
        return files.length > 0 ? `\n【変更ファイル】: ${files.join(', ')}` : '';
    } catch (e) {
        return '';
    }
}

// -------------------------------------------------------------------
// ⚙️ 1件の指示を実行するメインフロー
// -------------------------------------------------------------------
async function processJob(data) {
    const rowIndex = data.rowIndex;
    const rawCommand = String(data.command || '');
    let summaryForLine = '✅ 処理完了';
    let fullSummaryForEmail = '';
    let usedImageIds = [];

    console.log(`🤖 指示を処理開始 (row=${rowIndex}): "${rawCommand.slice(0, 60)}..."`);

    try {
        // 📸 画像URLの受信（一時保持）
        if (rawCommand.startsWith('[IMAGE_URL:')) {
            const urlMatch = rawCommand.match(/\[IMAGE_URL:\s*(.*?)\]/);
            if (urlMatch && urlMatch[1]) {
                const url = urlMatch[1];
                const idMatch = url.match(/id=([^&]+)/);
                pendingImages.push({ url, id: idMatch ? idMatch[1] : '' });
                console.log(`📸 画像をセットしました（現在 ${pendingImages.length} 枚）`);
                summaryForLine = `✅ ${pendingImages.length}枚目の画像をセットしました！続けてテキストで指示を送ってください。`;
            } else {
                summaryForLine = '【エラー】画像URLを解析できませんでした。';
            }
            fullSummaryForEmail = summaryForLine;
        }
        // 💬 テキスト指示の実行
        else {
            const cleanCommand = rawCommand.replace(/\r?\n/g, '、').replace(/"/g, '”');
            let imageContext = '';

            if (pendingImages.length > 0) {
                const urls = pendingImages.map(img => img.url).join('\n');
                imageContext = `【参考画像】以下のURLを確認して指示を実行してください:\n${urls}\n\n`;
                usedImageIds = pendingImages.map(img => img.id).filter(Boolean);
                pendingImages = [];
            }

            const isDeployCommand = /^\/?deploy$/i.test(cleanCommand.trim()) || cleanCommand.trim() === 'デプロイ';
            let modifyPrompt = '';

            if (isDeployCommand) {
                modifyPrompt = `「.agents/workflows/deploy.md」の手順に従ってデプロイ作業を実行してください。

【完了時の必須ルール】
すべてのデプロイコマンド（clasp push / git push / clasp deploy）が完了したら、必ず Node.js の \`fs.writeFileSync('.ai_task_done.txt', '🚀 DUMPの要約コミットとGitHub・GASへのデプロイが完了しました！\\n（コミット内容の要約）', 'utf8')\` を実行して「.ai_task_done.txt」を作成してください。`;
            } else {
                modifyPrompt = `${imageContext}${cleanCommand}

【完了時の必須ルール】
作業が完了したら、必ず Node.js の \`fs.writeFileSync('.ai_task_done.txt', '作業内容の要約レポート', 'utf8')\` を実行して「.ai_task_done.txt」を作成してください（このファイルの作成を合図にLINEへ完了通知が飛びます）。`;
            }

            const aiOutput = await runIDEAgent(modifyPrompt);
            const changedText = getChangedFilesText();
            const shortOut = aiOutput.length > 1500 ? aiOutput.slice(0, 1500) + '\n...(省略)' : aiOutput;
            const safeFullOut = aiOutput.length > 8000 ? aiOutput.slice(0, 8000) + '\n...(省略)' : aiOutput;

            if (aiOutput) {
                const isDeploy = rawCommand.toLowerCase().includes('deploy') || rawCommand.includes('デプロイ');
                const title = isDeploy ? '🚀 【DUMP デプロイ完了報告】' : '✅ 【DUMP 修正・作業報告】';
                summaryForLine = `${title}${changedText}\n\n${shortOut}`;
                fullSummaryForEmail = `${title}${changedText}\n\n${safeFullOut}`;
            } else {
                summaryForLine = '【スキップ】AIからの応答がなかったため通知を省略しました。';
                fullSummaryForEmail = summaryForLine;
            }
        }
    } catch (err) {
        console.error('❌ 処理エラー:', err.message);
        summaryForLine = `【エラー】${err.message}`;
        fullSummaryForEmail = summaryForLine;
    } finally {
        await notifyJobComplete(rowIndex, summaryForLine, fullSummaryForEmail, usedImageIds);
    }
}

// -------------------------------------------------------------------
// 🔄 常駐監視ループ
// -------------------------------------------------------------------
let isProcessing = false;
let pollCount = 0;

async function loop() {
    if (!isProcessing) {
        isProcessing = true;
        try {
            while (true) {
                const job = await fetchNextJob();
                if (!job) break;
                await processJob(job);
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        } catch (e) {
            console.warn(`⚠️ ポーリングエラー: ${e.message}`);
        } finally {
            isProcessing = false;
        }
    }
    pollCount++;
    if (pollCount % 30 === 0) console.log(`💓 待機中... (${pollCount}回)`);
    setTimeout(loop, 1000);
}

acquireWatchLock();
console.log('👀 DUMP用 AIブリッジ起動：LINEからの指示を待機中...');
loop();