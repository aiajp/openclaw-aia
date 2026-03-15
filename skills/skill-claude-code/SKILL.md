---
name: skill-claude-code
description: EC2上でClaude Codeセッションを起動し、指定ディレクトリでタスクを実行して結果をSlackに返すスキル。
metadata:
  {
    "openclaw":
      {
        "emoji": "🖥️",
        "model": "claude-sonnet-4-6",
        "requires": { "bins": ["claude"], "config": ["channels.slack"] },
      },
  }
---

# Claude Code セッション管理（AIA Edition）

## Overview

EC2上でClaude Codeセッションを起動し、指定ディレクトリでタスクを実行する。
実行結果はSlackに返信する。

## 対象ディレクトリ

以下のディレクトリのみでClaude Codeセッションを起動できる（ホワイトリスト方式）。

| ディレクトリ | プロダクト |
|-------------|-----------|
| `/Volumes/Dev_SSD/rag-in-a-box/` | RAG-in-a-Box |
| `/Volumes/Dev_SSD/synthagent/` | SynthAgent |
| `/Volumes/Dev_SSD/openclaw-aia/` | OpenClaw AIA Edition |

**セキュリティ**: ホワイトリスト外のディレクトリでの実行は拒否する。

## モデル割り当て

| 操作 | モデル | 理由 |
|------|--------|------|
| セッション状態確認・ログ取得 | `claude-haiku-4-5` | 読み取り操作 |
| セッション起動・停止 | `claude-sonnet-4-6` | 判断タスク |
| タスク実行の委譲 | 委譲先のClaude Codeが自律的に選択 | — |
| git push の確認 | `claude-sonnet-4-6` | 確認プロンプト必要 |
| git force push | `claude-opus-4-6` | 不可逆操作 |

## 操作分類（セキュリティ）

| 分類 | 操作 | 実行方式 | ログ |
|------|------|---------|------|
| 軽量書き込み | セッション起動 | 自動実行 | 記録 + 結果通知 |
| 軽量書き込み | タスク実行（ローカル変更） | 自動実行 | 記録 + 結果通知 |
| 軽量書き込み | セッション停止 | 自動実行 | 記録 + 結果通知 |
| 読み取り | セッション状態確認 | 自動実行 | 記録のみ |
| 読み取り | 実行ログ取得 | 自動実行 | 記録のみ |
| 重要操作 | git push | 確認プロンプト | Slack確認 → 承認後実行 |
| 重要操作 | ブランチ削除 | 確認プロンプト | Slack確認 → 承認後実行 |
| 不可逆操作 | git force push | 二段階承認 | Slack確認 → 最終確認 → 実行 |

## アクション

### spawn — セッション起動

指定ディレクトリでClaude Codeセッションを起動し、タスクを実行する。

```json
{
  "action": "spawn",
  "workdir": "/Volumes/Dev_SSD/synthagent/",
  "task": "Phase 5のAPI設計を実装して",
  "background": true,
  "timeout": 600
}
```

**実行コマンド**:
```bash
cd <workdir> && claude --permission-mode bypassPermissions --print '<task>'
```

### status — セッション状態確認

実行中のセッションの状態を確認する。

```json
{
  "action": "status",
  "sessionId": "xxx-yyy-zzz"
}
```

### log — 実行ログ取得

セッションの出力ログを取得する。

```json
{
  "action": "log",
  "sessionId": "xxx-yyy-zzz",
  "tail": 50
}
```

### stop — セッション停止

実行中のセッションを停止する。

```json
{
  "action": "stop",
  "sessionId": "xxx-yyy-zzz"
}
```

### git_push — Git Push（確認プロンプト付き）

Claude Codeセッションの変更をリモートにプッシュする。
**この操作は必ずSlackで確認プロンプトを表示し、承認後に実行する。**

```json
{
  "action": "git_push",
  "workdir": "/Volumes/Dev_SSD/synthagent/",
  "branch": "feature/phase-5-api",
  "force": false
}
```

確認プロンプト例:
```
🔔 Git Push 確認
リポジトリ: /Volumes/Dev_SSD/synthagent/
ブランチ: feature/phase-5-api
変更ファイル: 5件
Force push: No

実行しますか？ (yes/no)
```

## 実行フロー

```
1. ユーザーがSlackでタスク指示
2. workdirがホワイトリストに含まれるか検証
3. Claude Codeセッションをバックグラウンドで起動
4. 起動通知をSlackに送信
5. セッション完了を待機（タイムアウト: 10分デフォルト）
6. 実行結果のサマリーをSlackに返信
7. git push が必要な場合は確認プロンプトを表示
```

## 安全対策

- **ディレクトリホワイトリスト**: 許可されたディレクトリ以外では起動不可
- **`--permission-mode bypassPermissions`**: PTY不要、非対話モードで実行
- **タイムアウト**: デフォルト600秒、最大1800秒
- **同時実行制限**: 同一ディレクトリでの同時セッションは1つまで
- **git操作の保護**: push/force-push/ブランチ削除は確認プロンプト必須

## 監査ログ

全操作をローカルSQLiteに記録する。

| フィールド | 内容 |
|-----------|------|
| timestamp | ISO 8601 |
| action | spawn / status / log / stop / git_push |
| workdir | 作業ディレクトリ |
| task | 実行タスクの概要 |
| sessionId | セッション識別子 |
| user | akkey |
| result | success / failure / timeout |
| duration | 実行時間（秒） |

## 完了通知

セッション完了時、以下の情報をSlackに通知する:

```
✅ Claude Code セッション完了
ディレクトリ: /Volumes/Dev_SSD/synthagent/
タスク: Phase 5のAPI設計を実装して
所要時間: 3分42秒
変更ファイル: src/api/routes.ts, src/api/handlers.ts (+3 files)
コミット: feat: implement Phase 5 API design
```
