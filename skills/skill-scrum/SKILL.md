---
name: skill-scrum
description: GitHub Projectsベースのスプリント管理・自律タスク実行スキル。AI駆動のスクラムマスター。
metadata: { "openclaw": { "emoji": "🏃", "model": "claude-sonnet-4-6" } }
---

# Scrum Agent（AIA Edition）

## Overview

GitHub Projectsをデータ層として、AI駆動のスプリント運営を実現するスキル。
Sprint Planning、Task実行、Auto Review、Daily Standup、Sprint Reviewを自律的に実行する。

**設計方針**: GitHub Projectsが「管理基盤」、このスキルが「実行エンジン」。

## トリガー

以下のキーワードでスキルが発動:

- 「scrum」「スクラム」「sprint」「スプリント」
- 「backlog」「バックログ」「ready」
- 「standup」「スタンダップ」「日次報告」
- 「sprint review」「振り返り」「ベロシティ」
- 「task executor」「タスク実行」

## アクション

| アクション      | 説明                                         | 操作分類     | モデル                       |
| --------------- | -------------------------------------------- | ------------ | ---------------------------- |
| `status`        | Sprint Board の現在の状態を表示              | 読み取り     | haiku                        |
| `plan`          | Sprint Planning 提案を生成                   | 読み取り     | sonnet                       |
| `approve-plan`  | Sprint Planning を承認して Ready に移動      | 重要操作     | sonnet                       |
| `execute`       | Ready の Task を1つ拾って Claude Code で実行 | 重要操作     | opus(plan) / sonnet(execute) |
| `review`        | PR の Auto Review を実行                     | 読み取り     | opus                         |
| `standup`       | Daily Standup レポートを生成・投稿           | 読み取り     | haiku                        |
| `sprint-review` | Sprint Review レポートを生成                 | 読み取り     | sonnet                       |
| `decompose`     | Issue（親）を Task（Sub Issue）に分解提案    | 軽量書き込み | sonnet                       |

## 操作分類（セキュリティ）

| 分類         | 操作                                        | 実行方式               |
| ------------ | ------------------------------------------- | ---------------------- |
| 読み取り     | status, standup, sprint-review              | 自動実行               |
| 読み取り     | review（レビュー分析のみ）                  | 自動実行               |
| 軽量書き込み | decompose（Sub Issue作成提案）              | 自動実行 + 結果通知    |
| 重要操作     | approve-plan（Sprint Board変更）            | Slack確認 → 承認後実行 |
| 重要操作     | execute（Claude Code起動 + PR作成）         | 自動実行 + 結果通知    |
| 重要操作     | review → approve/reject（PRステータス変更） | 自動実行 + 結果通知    |

## GitHub Projects 設定

- **Project**: AIA Development Sprint Board (`PVT_kwHODKzSVM4BB5ON`)
- **対象リポジトリ**: synthagent, rag-in-a-box, openclaw-aia, aia-corporate-lp
- **Board Columns**: Backlog → Ready → In Progress → In Review → Done

### Issue / Task 階層

- **Issue（親, Label: Parent）**: 機能単位、FPの塊。Sprint Boardには載せない
- **Task（Sub Issue）**: 作業単位、数FP。Sprint Boardで管理・実行される

## Task Executor フロー

```
1. GitHub Projects API で "Ready" の Task（Sub Issue）を取得
   - フィルタ: label != "Parent"
2. Priority × Story Points で最優先の Task を1つ選択
3. Task の Model フィールドを読み取り（デフォルト: sonnet）
4. Task を "In Progress" に移動
5. Claude Code セッション起動:
   - Working dir: Task のリポジトリに対応するローカルパス（macOS/Linux自動判定）
   - Prompt: Task description + acceptance criteria + 親Issue コンテキスト
   - Model: 2フェーズ（Plan = opus / Execute = sonnet）または Task の Model 指定
   - iOS repos: プロンプトに xcodebuild ビルド検証指示を含む
6. [iOS] Post-execution xcodebuild 検証（セーフティネット）
7. Claude Code が PR を作成（"Closes #<task番号>"）
8. Task を "In Review" に移動
9. Auto Reviewer 起動（別セッション）
```

### iOS プロジェクト固有の処理

- `IOS_REPOS` に登録されたリポジトリは macOS 環境でのみ実行可能
- Claude Code へのプロンプトに `xcodebuild` によるビルド検証指示を自動付与
- 実行完了後にも `xcodebuild build` をセーフティネットとして実行
- ビルド失敗時は Slack + Issue コメントで警告（タスク自体は失敗扱いにしない）

## Auto Reviewer フロー

```
1. Slack通知（GitHub Actions scrum-auto-review-request.yml）を検知
2. PR の diff を取得 + リポジトリ全体のコンテキスト確認
3. Claude Code (--model opus) でレビュー実行
4. gh pr review → approve / request_changes
5. approve → auto-merge 待ち
   reject → scrum-retry.yml が検知 → リトライ or Blocked
```

## Cron ジョブ

| ジョブ          | スケジュール          | アクション                          |
| --------------- | --------------------- | ----------------------------------- |
| Sprint Planning | 毎週月曜 06:00 JST    | `plan` → Slack投稿 → Akkey承認待ち  |
| Task Executor   | 毎時                  | `execute` → Ready Task があれば実行 |
| Daily Standup   | 毎朝 08:00 JST (平日) | `standup` → Slack投稿               |
| Sprint Review   | 毎週日曜 20:00 JST    | `sprint-review` → Weeklyノート記入  |

## リポジトリ → ローカルパス マッピング

実行環境（macOS / Linux）を自動判定してパスを切り替える。

| リポジトリ             | EC2 (Linux)                   | Mac (darwin)                      | 備考                |
| ---------------------- | ----------------------------- | --------------------------------- | ------------------- |
| aiajp/synthagent       | /home/ubuntu/synthagent       | /Volumes/Dev_SSD/synthagent       |                     |
| aiajp/rag-in-a-box     | /home/ubuntu/rag-in-a-box     | /Volumes/Dev_SSD/rag-in-a-box     |                     |
| aiajp/openclaw-aia     | /home/ubuntu/openclaw-aia     | /Volumes/Dev_SSD/openclaw-aia     |                     |
| aiajp/aia-corporate-lp | /home/ubuntu/aia-corporate-lp | /Volumes/Dev_SSD/aia-corporate-lp |                     |
| aiajp/hibi             | — (macOS専用)                 | /Volumes/Dev_SSD/hibi             | iOS, xcodebuild必須 |

## 環境変数

| 変数                | 用途                                                               |
| ------------------- | ------------------------------------------------------------------ |
| `GITHUB_TOKEN`      | GitHub API / gh CLI 認証（Classic PAT: repo + project + workflow） |
| `ANTHROPIC_API_KEY` | Claude Code 実行用                                                 |

## 監査ログ

全操作をSQLiteに記録:

```sql
INSERT INTO audit_log (timestamp, skill, action, target, result, details)
VALUES (datetime('now'), 'scrum', 'execute', 'rag-in-a-box#42', 'success', '{"pr": 5, "model": "sonnet"}');
```
