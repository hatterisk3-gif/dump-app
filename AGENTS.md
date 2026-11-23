# DUMP App Architecture & Editor Guide

## Architecture Overview
- **Frontend (Cloudflare Pages)**: `index.html`, `supplement.html`, `js/dump-boot.js`, `js/app.js`, `js/supplement.js`, `service-worker.js`, `manifest.json`, `version.json`
  - Auto-deployed from GitHub `main` (`dump-app.pages.dev`).
- **Database (Supabase)**: Project ID `nxtrrqkxcmkfjblbwleo` (`https://nxtrrqkxcmkfjblbwleo.supabase.co`)
  - Schema & RPC entrypoint: `supabase/schema.sql` (`public.dump_api(payload jsonb)`).
  - Tables: `public.inbox`, `public.data_records`, `public.config_records`, `public.sync_meta`.
- **Image Storage (Cloudflare R2 + Worker)**: Bucket `dump-app-media` / Worker `dump-media` (`https://dump-media.hatterisk3.workers.dev`)
  - Source & config: `cloudflare/dump-media-worker.js` and `cloudflare/wrangler.jsonc`.
  - Handles `POST /upload` and `GET / HEAD /img/<key>`.
- **Legacy / Auxiliary Backend (Google Apps Script)**: `gas/コード.js`
  - **NOT used for main DB (`INBOX` / `DATA` / `CONFIG`) or primary R2 image upload anymore.**
  - Only active for: `syncGanttCalendarEvent`, `deleteGanttCalendarEvent`, `syncAllGanttToCalendar`, `lookupJanProduct`, `getDumpImageById` (legacy Drive fallback), and `uploadDumpImageBegin/Chunk/Finish` (chunked fallback).

## File Map
- `index.html` — App HTML shell, inline styles, and `window.__DUMP_BUILD__`
- `js/dump-boot.js` — Boot sequence, `callAPI()` router (Supabase RPC / R2 Worker / GAS), cross-device sync, offline pending writes queue
- `js/app.js` — Main UI logic, tabs, organizer, tree/library, Gantt, diary, abstinence timer, image display & clipboard copy
- `js/supplement.js` & `supplement.html` — Supplement manager UI and logic
- `service-worker.js` — PWA offline cache (`CACHE_NAME = 'dump-app-vNNN'`) & background sync
- `version.json` — Build version (`{"build":"vNNN"}`); must match `index.html` and `service-worker.js`
- `supabase/schema.sql` — Supabase Postgres schema, RLS, indexes, triggers, and `public.dump_api` RPC source
- `cloudflare/dump-media-worker.js` & `cloudflare/wrangler.jsonc` — Cloudflare R2 media Worker & Wrangler config
- `gas/コード.js` — GAS auxiliary backend (Calendar sync, JAN lookup, legacy Drive fallback)

## Required Editing & Verification Rules
1. **Do NOT edit `gas/コード.js` for DB or normal image storage changes.** Edit `supabase/schema.sql` (DB/RPC), `cloudflare/dump-media-worker.js` (R2 media), and `js/dump-boot.js` / `js/app.js` (frontend).
2. **Always run syntax checks** after editing JS files:
   `node --check js/dump-boot.js && node --check js/app.js && node --check js/supplement.js && node --check service-worker.js && node --check cloudflare/dump-media-worker.js`
3. **Always keep the build version (`vNNN`) synchronized** across all 3 files when frontend assets change:
   - `version.json` (`{"build":"vNNN"}`)
   - `index.html` (`window.__DUMP_BUILD__ = 'vNNN';`)
   - `service-worker.js` (`const CACHE_NAME = 'dump-app-vNNN';`)
4. **Deployment**:
   - Frontend: `git add .` -> `git commit` -> `git push` (triggers Cloudflare Pages deploy).
   - Cloudflare R2 Worker (only when `cloudflare/` changed): `npx wrangler deploy --config cloudflare/wrangler.jsonc` (or Cloudflare MCP).
   - Supabase (only when `supabase/schema.sql` changed): `npx supabase db query --linked -f supabase/schema.sql` (or Supabase MCP `apply_migration` / `execute_sql`). Note: `supabase/schema.sql` uses idempotent DDL and `create or replace function`.
   - GAS (only when `gas/` changed): `clasp push` -> `clasp deploy -i AKfycbxP-ENobvgAGiVgXKgzLmKBLZn4_6KzZXwXXZAbDBqmSdLxiJOCf5whFrUv5ikUo5evvQ`.
