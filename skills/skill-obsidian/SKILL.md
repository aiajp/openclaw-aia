---
name: skill-obsidian
description: AIA Obsidian Vault連携。Weeklyノート優先で作業記録・タスク管理・ノート検索・PDCA記録を自動化する。
metadata:
  {
    "openclaw":
      {
        "emoji": "📓",
        "model": "claude-haiku-4-5",
        "requires": { "envs": ["OBSIDIAN_VAULT_PATH"] },
      },
  }
---

# Obsidian Vault連携（AIA Edition）

## Overview

AIA社内のObsidian Vault（`/home/ubuntu/obsidian-artifacts/`）と連携し、
ナレッジ管理・タスク管理・PDCA記録を自動化するスキル。

## ⚡ 最重要ルール: Weekly優先

**作業記録はWeeklyノートに追記する。Dailyは補助的な位置づけ。**

| 優先度 | ノート種別 | 用途 |
|--------|-----------|------|
| 🥇 **1st** | Weeklyノート（`05-Weekly/`） | 作業記録・タスク管理・PDCA — メインの記録先 |
| 🥈 2nd | Dailyノート（`04-Daily/`） | Weeklyが存在しない場合のフォールバック、または細かいメモ用 |

### 判定フロー

```
1. 今週のWeeklyノートが存在するか？
   → YES: Weeklyに追記する
   → NO: Dailyノートを作成して記録する
2. Weekly更新後は必ず git commit → git push する
```

### Weeklyノートのパス解決

```
VAULT_PATH = /home/ubuntu/obsidian-artifacts/
weekly_note = VAULT_PATH + "05-Weekly/" + YYYY + "/W" + WW + "-" + YYYY-MM-DD + ".md"

例: 05-Weekly/2026/W11-2026-03-09.md
```

WW = ISO週番号、YYYY-MM-DD = その週の月曜日の日付。
既存ファイルを `ls 05-Weekly/YYYY/` で確認してマッチさせる。

### Git Push（Weekly更新時は必須）

```bash
cd /home/ubuntu/obsidian-artifacts/
git add <更新ファイル>
git commit -m "📝 <変更サマリー>"
git push
```

**pushが認証エラーで失敗した場合**: コミットまで完了した旨とpush失敗を報告する。

## Vault構成

| パス | 用途 |
|------|------|
| `00-Inbox/` | 未整理メモ |
| `04-Daily/` | デイリーノート（`YYYY/MM-Month/YYYY-MM-DD.md`） |
| `05-Weekly/` | **週次タスク・PDCA（メイン記録先）** |
| `08-aia/` | AIA業務関連 |
| `08-aia/03-Product-Development/` | プロダクト開発記録 |
| `08-aia/07-Legal/` | 法務関連 |

## モデル割り当て

| 操作 | モデル | 理由 |
|------|--------|------|
| ノート検索・読み取り | `claude-haiku-4-5` | 軽量タスク、コスト最適化 |
| Weeklyノート追記 | `claude-haiku-4-5` | 定型的な書き込み |
| デイリーノート追記 | `claude-haiku-4-5` | 定型的な書き込み |
| タスク追加・完了マーク | `claude-haiku-4-5` | 軽量書き込み |
| 週次PDCA記録 | `claude-haiku-4-5` | 定型的な記録 |

## 操作分類（セキュリティ）

| 分類 | 操作 | 実行方式 | ログ |
|------|------|---------|------|
| 読み取り | ノート検索、内容読み取り | 自動実行 | 記録のみ |
| 読み取り | Vault構造の確認 | 自動実行 | 記録のみ |
| 軽量書き込み | Weeklyノート追記 | 自動実行 | 記録 + 結果通知 + git push |
| 軽量書き込み | デイリーノート追記 | 自動実行 | 記録 + 結果通知 |
| 軽量書き込み | タスク追加・完了マーク | 自動実行 | 記録 + 結果通知 |
| 軽量書き込み | 週次PDCA記録 | 自動実行 | 記録 + 結果通知 + git push |

**注意**: Obsidian操作はすべて読み取りまたは軽量書き込みに分類される。
ファイル削除・リネームは本スキルのスコープ外。

## アクション

### search — ノート検索

ファイル名またはコンテンツからノートを検索する。

```json
{
  "action": "search",
  "query": "検索キーワード",
  "scope": "name|content|all",
  "folder": "08-aia/"
}
```

### read — ノート読み取り

指定パスのノートを読み取る。

```json
{
  "action": "read",
  "path": "05-Weekly/2026/W11-2026-03-09.md"
}
```

### append_weekly — Weeklyノート追記（推奨）

今週のWeeklyノートに作業記録を追記する。更新後はgit push必須。

```json
{
  "action": "append_weekly",
  "content": "| 夕方 | OpenClaw skill-obsidian更新 | 🤝 OpenClaw | ✅ |",
  "section": "タイムライン（実績）",
  "day": "日曜 3/15"
}
```

### append_daily — デイリーノート追記（Weeklyが無い場合のフォールバック）

今日のデイリーノートに内容を追記する。ノートが存在しない場合は作成する。

```json
{
  "action": "append_daily",
  "content": "## 進捗\n- skill-obsidian 実装完了",
  "date": "2026-03-15"
}
```

### add_task — タスク追加

指定ノートにタスクを追加する。Weeklyノートへの追加を優先する。

```json
{
  "action": "add_task",
  "path": "05-Weekly/2026/W11-2026-03-09.md",
  "task": "skill-freee の二段階承認フロー実装",
  "priority": "high"
}
```

### complete_task — タスク完了

指定ノート内のタスクを完了マークにする（`- [ ]` → `- [x]`）。

```json
{
  "action": "complete_task",
  "path": "05-Weekly/2026/W11-2026-03-09.md",
  "task_text": "skill-obsidian 実装"
}
```

### record_pdca — 週次PDCA記録

Weeklyノートの週次振り返り（YWT）セクションに記録を追記する。更新後はgit push必須。

```json
{
  "action": "record_pdca",
  "week": "2026-W11",
  "plan": "OpenClaw AIA Skills実装",
  "do": "skill-obsidian, skill-claude-code, skill-freee 作成",
  "check": "セキュリティレビュー通過",
  "act": "次週: 統合テスト"
}
```

## 実装方式

Vault内のファイルは通常のMarkdownファイルのため、ファイルシステム操作で直接読み書きする。
obsidian-cliが利用可能な場合はリンク更新等に使用するが、必須ではない。

### ファイルパス解決

```
VAULT_PATH = /home/ubuntu/obsidian-artifacts/

# Weekly（優先）
weekly_note = VAULT_PATH + "05-Weekly/" + YYYY + "/W" + WW + "-" + YYYY-MM-DD + ".md"

# Daily（フォールバック）
daily_note = VAULT_PATH + "04-Daily/" + YYYY + "/MM-Month/" + YYYY-MM-DD + ".md"
```

## 監査ログ

全操作をローカルSQLiteに記録する。

| フィールド | 内容 |
|-----------|------|
| timestamp | ISO 8601 |
| action | search / read / append_weekly / append_daily / add_task / complete_task / record_pdca |
| path | 対象ファイルパス |
| user | akkey |
| result | success / failure |
| detail | 操作の詳細（検索クエリ、追記内容のサマリー等） |

## 注意事項

- `.obsidian/` 配下の設定ファイルは絶対に変更しない
- バイナリファイル（画像・PDF）の書き込みはスコープ外
- Vault全体のバックアップはGitHub同期（obsidian-artifacts リポジトリ）に依存
- **Weekly更新後のgit pushは必須**（認証エラー時はコミットまで完了した旨を報告）
