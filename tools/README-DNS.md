# DUMP DNS Helper（禁欲タイマー連携）

Cloudflare Family DNS（`1.1.1.3` / `1.0.0.3` / `family.cloudflare-dns.com`）で成人向けサイトを遮断します。

## プラットフォーム別

| 環境 | やり方 |
|------|--------|
| **Windows PC** | ヘルパーで OS の DNS を自動切替（管理者権限） |
| **iPhone / iPad** | 構成プロファイル（`.mobileconfig`）を Safari でインストール |
| **Android** | 設定の「プライベート DNS」にホスト名を手入力 |

アプリからはスマホの DNS を直接書き換えられないため、スマホは**設定ガイド＋解除日数の管理**になります。

---

## Windows（PC）

### 重要

**`DumpDnsHelper.ps1` をダブルクリックしないでください。**  
Windows では `.ps1` がメモ帳に関連付けられているため、スクリプトではなくメモ帳が開きます。

必ず **`.cmd` ファイル** をダブルクリックしてください。

### 初回セットアップ

1. `tools` フォルダを開く
2. **`Install-DumpDnsHelper.cmd`** をダブルクリック
3. DUMP の禁欲タブ → **DNSをロック**

### 手動操作

| ファイル | 操作 |
|----------|------|
| `DumpDns-Lock.cmd` | DNS を 1.1.1.3 にロック |
| `DumpDns-Unlock.cmd` | 元の DNS に戻す |
| `Install-DumpDnsHelper.cmd` | プロトコル登録（初回） |

### 注意（Windows）

- DNS 変更には管理者権限（UAC）が必要です（「はい」を押す）
- **Chrome / Edge の「セキュア DNS（DoH）」が ON だと、OS の DNS ロックを迂回します**（設定でオフにしてください）
- VPN や会社管理アダプターでは効かない場合があります

---

## iPhone / iPad

1. **Safari** でアプリ内の「構成プロファイル」を開く（Chrome だとインストール案内が出ないことが多い）
2. 許可 → 設定 → 一般 → **VPNとデバイス管理** → ダウンロード済みプロファイルをインストール
3. アプリに戻り **「ロックした（記録）」** を押す

ファイル: `tools/DumpDns-Family-iOS.mobileconfig`  
解除: 同じ画面から「DUMP Family DNS」プロファイルを削除 → アプリで解除

---

## Android

1. 設定 → ネットワークとインターネット → **プライベート DNS**
2. 「プライベート DNS プロバイダのホスト名」に次を入力:

```text
family.cloudflare-dns.com
```

3. アプリで **「ロックした（記録）」** を押す  

解除: プライベート DNS を「自動」に戻す → アプリで解除

---

## 解除条件（アプリ側・共通）

最長と平均の **大きい方を＋1日超えたら** 解除確認が出ます。
