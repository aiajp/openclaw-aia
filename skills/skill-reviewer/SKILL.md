---
name: skill-reviewer
description: KANBANタスク完了時にGitHub PRを自動レビュー・マージするスキル。
metadata:
  {
    "openclaw":
      { "emoji": "🔍", "model": "claude-sonnet-4-6", "requires": { "config": ["channels.slack"] } },
  }
---

# PR Reviewer（AIA Edition）

## Overview

KANBANタスクが完了してPRが作成された時に、自動でコードレビューを実行する。
レビュー基準に基づいて approve/request changes を判定し、結果をSlackに通知する。

## トリガー

以下のキーワードでスキルが発動:

- 「review」「レビュー」「PR確認」「コードレビュー」

または KANBAN タスク完了時に自動発動（`autoReviewEnabled: true` のカード）

## アクション

| アクション        | 説明                           | 操作分類     |
| ----------------- | ------------------------------ | ------------ |
| `review`          | PRのdiffを取得してレビュー実行 | 読み取り     |
| `approve`         | レビュー通過 → gh pr merge     | 重要操作     |
| `request-changes` | 差し戻し → PRにコメント        | 軽量書き込み |
| `status`          | レビュー待ちPR一覧を表示       | 読み取り     |

## レビュー基準

### 必須チェック（Critical — 不合格で差し戻し）

1. **テスト**: 新規コードにテストがあること、既存テストが壊れていないこと
2. **型ヒント**: Python コードに型ヒントがあること（Any禁止）
3. **セキュリティ**: billing/auth 周りの変更は特に重点チェック
4. **tasks.md整合性**: 変更内容が tasks.md のタスク記述と一致すること

### 推奨チェック（Warning — コメントのみ）

5. **コーディング規約**: Ruff/Black 準拠
6. **不要ファイル**: デバッグ用ファイル、一時ファイルの混入
7. **PR構成**: 無関係なコミットの混入

### スキップ（チェックしない）

- Terraform ファイルの plan 結果（実行環境依存）
- パフォーマンス最適化の判断

## レビュー結果フォーマット

```
## PR Review: #{pr_number} — {title}

### 判定: ✅ Approve / ❌ Request Changes

### Critical
- [x] テスト: 4件追加、全パス
- [x] 型ヒント: OK
- [ ] セキュリティ: rate_limiter に未修正の競合条件あり ← 差し戻し理由

### Warning
- ⚠️ tasks.md が未更新

### Summary
{1-2行の総評}
```

## エンドポイント

- GitHub CLI: `gh pr view/diff/merge` via shell
- Kanban tRPC API: `http://localhost:3484/api/trpc/`
- Slack通知: channels.slack 経由

## 操作分類（セキュリティ）

| 分類         | 操作                       | 実行方式                    |
| ------------ | -------------------------- | --------------------------- |
| 読み取り     | PR diff 取得・レビュー実行 | 自動実行                    |
| 軽量書き込み | PRコメント（差し戻し）     | 自動実行 + 結果通知         |
| 重要操作     | PR merge                   | 確認プロンプト → 承認後実行 |
