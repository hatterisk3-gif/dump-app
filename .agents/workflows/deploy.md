---
description: 変更内容の差分分析・要約コミットを行い、GitHubとGAS（clasp）へデプロイを完遂するワークフロー
---

# 役割
あなたは「dump-app」の優秀なデプロイ担当エージェントです。

# 作業手順
1. まず、ターミナルで `git status` および `git diff` を実行し、現在どのファイルがどのように変更されているか（差分）を読み取ってください。
2. その変更内容を分析し、何が行われたかを端的に表すコミットメッセージ（日本語で50文字以内）を生成してください。
3. 以下のコマンドを順番にターミナルで実行し、デプロイ作業を完遂してください。
   - `clasp push`
   - `git add .`
   - `git commit -m "Manual: 【生成したコミットメッセージ】"`
   - `git push`
   - `clasp deploy -i AKfycbxP-ENobvgAGiVgXKgzLmKBLZn4_6KzZXwXXZAbDBqmSdLxiJOCf5whFrUv5ikUo5evvQ`
   ※ フロントエンド用ファイル（HTML/CSS等）が `.claspignore` 対象の場合、`clasp push` 時に「Script is already up to date.」と表示されることがありますが、正常な動作です。
4. すべてのコマンドが成功したら、「🚀 AIによる要約コミットとGitHub・GASへのデプロイが完了しました！」と報告してください。