---
description: 変更内容の差分分析・構文チェック・ビルド番号同期を行い、Supabase / Cloudflare R2 Worker / GAS / GitHub（Cloudflare Pages）へ適切にデプロイを完遂するワークフロー
---

# 役割
あなたは「dump-app」の優秀なデプロイ担当エージェントです。

# 構成情報
- **フロントエンド (Cloudflare Pages)**: GitHub `main` への `git push` で自動デプロイ（`dump-app.pages.dev`）
- **データベース (Supabase)**: プロジェクト ID `nxtrrqkxcmkfjblbwleo`（`https://nxtrrqkxcmkfjblbwleo.supabase.co` / 正本: `supabase/schema.sql`）
- **画像ストレージ (Cloudflare R2 + Worker)**: バケット `dump-app-media` / Worker `dump-media`（`https://dump-media.hatterisk3.workers.dev` / 正本: `cloudflare/dump-media-worker.js`, `cloudflare/wrangler.jsonc` / アカウント ID: `e9846068fac92b0b42573b143b03e9b5`）
- **補助バックエンド (GAS)**: `gas/` 配下（画像分割フォールバック・Drive旧画像取得・Googleカレンダー連携・JAN検索用。デプロイID: `AKfycbxP-ENobvgAGiVgXKgzLmKBLZn4_6KzZXwXXZAbDBqmSdLxiJOCf5whFrUv5ikUo5evvQ`）

# 作業手順
1. **差分確認と影響範囲の特定**
   - ターミナルで `git status` および `git diff` を実行し、変更（未追跡ファイルを含む）されたファイル一覧と差分を読み取ってください。
   - 以下のどの領域に変更があるかを判定します：
     - フロントエンド資産（`index.html`, `supplement.html`, `js/*.js`, `service-worker.js`, `manifest.json`）
     - Cloudflare R2 Worker（`cloudflare/dump-media-worker.js`, `cloudflare/wrangler.jsonc`）
     - Supabase スキーマ / RPC（`supabase/schema.sql`）
     - GAS（`gas/` 配下）

2. **フロントエンド構文チェック＆ビルドバージョン同期**
   - `js/*.js`・`service-worker.js`・`cloudflare/dump-media-worker.js` に変更がある場合は、`node --check <ファイルパス>` を実行し、構文エラーがないことを確認してください。
   - フロントエンド資産（`index.html`, `supplement.html`, `js/*.js`, `service-worker.js`）に変更があり、`HEAD` 時点からビルド番号（`vNNN`）がまだ上がっていない場合は、以下の3箇所を必ず同じ次番号（例: `v454` → `v455`）へ揃えて更新してください：
     - `version.json`: `{"build":"vNNN"}`
     - `index.html`: `window.__DUMP_BUILD__ = 'vNNN';`
     - `service-worker.js`: `const CACHE_NAME = 'dump-app-vNNN';`

3. **変更対象に応じたバックエンドデプロイ（条件付き実行）**
   - **Cloudflare R2 Worker (`cloudflare/` 配下) に変更がある場合のみ**:
     - Antigravity の Cloudflare MCP（`execute`）またはターミナルで `npx wrangler deploy --config cloudflare/wrangler.jsonc` を実行し、アカウント `e9846068fac92b0b42573b143b03e9b5` の Worker `dump-media`（R2バケット `dump-app-media` バインド `MEDIA_BUCKET`）を更新デプロイしてください。
     - デプロイ後、`https://dump-media.hatterisk3.workers.dev/` のヘルスチェックが HTTP 200 を返すことを確認してください。
   - **Supabase (`supabase/schema.sql`) に変更がある場合のみ**:
     - Antigravity の Supabase MCP（`apply_migration` / `execute_sql`）またはターミナルで `npx supabase db query --linked -f supabase/schema.sql` を実行してプロジェクト `nxtrrqkxcmkfjblbwleo` へ適用し、セキュリティエラーがないことを確認してください。
   - **GAS（`gas/` 配下）に変更がある場合のみ**:
     - `clasp push`
     - `clasp deploy -i AKfycbxP-ENobvgAGiVgXKgzLmKBLZn4_6KzZXwXXZAbDBqmSdLxiJOCf5whFrUv5ikUo5evvQ`
     ※ `gas/` に変更がない場合は、不要な空バージョン作成と待機時間を省くため `clasp` コマンドはスキップしてください。

4. **Gitコミット＆GitHubプッシュ（Cloudflare Pages 自動デプロイ）**
   - 変更内容を端的に表すコミットメッセージ（日本語で50文字以内、フロントエンド更新がある場合は末尾に `(vNNN)` を付与）を生成してください。
   - 以下のコマンドを順番にターミナルで実行してください：
     - `git add .`
     - `git commit -m "Manual: 【生成したコミットメッセージ】"`
     - `git push`

5. **完了報告**
   - デプロイした対象（GitHub / Cloudflare Pages、および実行した場合は Cloudflare R2 Worker / Supabase / GAS）とコミットハッシュ・ビルド番号を明記して、「🚀 AIによる要約コミットとデプロイが完了しました！」と報告してください。
