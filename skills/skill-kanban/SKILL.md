---
name: skill-kanban
description: Kanbanボードの状態確認・タスク管理をSlackから操作するスキル。
metadata:
  {
    "openclaw":
      { "emoji": "📋", "model": "claude-haiku-4-5", "requires": { "config": ["channels.slack"] } },
  }
---

# Kanban ボード連携（AIA Edition）

## Overview

EC2上のKanbanボード (localhost:3484) の状態をSlackから確認・操作する。

## トリガー

以下のキーワードでスキルが発動:

- 「kanban」「カンバン」「ボード」「タスク状況」「進捗」

## アクション

| アクション | 説明                     | 操作分類     |
| ---------- | ------------------------ | ------------ |
| `status`   | ボード全体の状態を返す   | 読み取り     |
| `task`     | 特定タスクの詳細を返す   | 読み取り     |
| `start`    | バックログのタスクを開始 | 軽量書き込み |
| `stop`     | 進行中のタスクを停止     | 軽量書き込み |

## エンドポイント

- Kanban tRPC API: `http://localhost:3484/api/trpc/`
- WebSocket (状態通知): `ws://localhost:3484/api/runtime/ws`

## 操作分類（セキュリティ）

| 分類         | 操作           | 実行方式            |
| ------------ | -------------- | ------------------- |
| 読み取り     | ボード状態確認 | 自動実行            |
| 読み取り     | タスク詳細確認 | 自動実行            |
| 軽量書き込み | タスク開始     | 自動実行 + 結果通知 |
| 軽量書き込み | タスク停止     | 自動実行 + 結果通知 |
