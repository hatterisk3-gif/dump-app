# /deploy — 差分確認・検証・デプロイ実行

## 構成情報
- **フロントエンド (Cloudflare Pages)**: GitHub `main` への `git push` で自動デプロイ（`dump-app.pages.dev`）
- **データベース (Supabase)**: プロジェクト ID `nxtrrqkxcmkfjblbwleo` / 正本: `supabase/schema.sql`
- **画像ストレージ (Cloudflare R2 + Worker)**: バケット `dump-app-media` / Worker `dump-media` (`https://dump-media.hatterisk3.workers.dev`) / 正本: `cloudflare/dump-media-worker.js`, `cloudflare/wrangler.jsonc`
- **補助バックエンド (GAS)**: `gas/` 配下（デプロイID: `AKfycbxP-ENobvgAGiVgXKgzLmKBLZn4_6KzZXwXXZAbDBqmSdLxiJOCf5whFrUv5ikUo5evvQ`）

## 作業手順
1. **差分確認と影響範囲の特定**
   - `git status` と `git diff` を実行し、変更・未追跡ファイルをすべて確認してください。
2. **構文チェック＆ビルド番号（`vNNN`）の同期**
   - JSファイル（`js/dump-boot.js`, `js/app.js`, `js/supplement.js`, `service-worker.js`, `cloudflare/dump-media-worker.js`）に変更がある場合は `node --check <ファイル>` を実行し、構文エラーがないことを確認してください。
   - フロントエンド資産（`index.html`, `supplement.html`, `js/*.js`, `service-worker.js`）に変更があり、`HEAD` からビルド番号が上がっていない場合は、`version.json`・`index.html`（`window.__DUMP_BUILD__`）・`service-worker.js`（`CACHE_NAME`）の3箇所を同一の次番号（例: `v454` → `v455`）へ更新してください。
3. **変更対象に応じたバックエンドデプロイ（変更がある領域のみ実行）**
   - **`cloudflare/dump-media-worker.js` または `cloudflare/wrangler.jsonc` に変更がある場合**:
     - ターミナルで `npx wrangler deploy --config cloudflare/wrangler.jsonc` を実行する（または Cloudflare MCP `execute` でアカウント `e9846068fac92b0b42573b143b03e9b5` の Worker `dump-media` を更新する）。
     - デプロイ後、`https://dump-media.hatterisk3.workers.dev/` が HTTP 200 を返すことを確認する。
   - **`supabase/schema.sql` に変更がある場合**:
     - ターミナルで `npx supabase db query --linked -f supabase/schema.sql` を実行する（または Supabase MCP `apply_migration` / `execute_sql` でプロジェクト `nxtrrqkxcmkfjblbwleo` へ適用し、`get_advisors` (`security`) を確認する）。
   - **`gas/` 配下に変更がある場合**:
     - `clasp push`
     - `clasp deploy -i AKfycbxP-ENobvgAGiVgXKgzLmKBLZn4_6KzZXwXXZAbDBqmSdLxiJOCf5whFrUv5ikUo5evvQ`
     ※ `gas/` に変更がない場合はスキップしてください。
4. **Gitコミット＆GitHubプッシュ（Cloudflare Pages 自動デプロイ）**
   - 日本語で50文字以内の要約コミットメッセージ（フロントエンド変更時は末尾に `(vNNN)`）を作成し、以下を順番に実行してください：
     - `git add .`
     - `git commit -m "Manual: 【生成したコミットメッセージ】"`
     - `git push`
5. **完了報告**
   - デプロイ対象・コミットハッシュ・ビルド番号を添えて「🚀 AIによる要約コミットとデプロイが完了しました！」と報告してください。
