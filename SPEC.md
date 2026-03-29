# OpenClaw AIA Edition — SPEC.md

## 概要

OpenClaw（MIT License）をAIA株式会社の自社業務用にフォークしたエージェント常駐基盤。
エンタープライズ向けではなく、AIA社内の自律的な業務遂行・連続開発を目的とする。

---

## 目的

- Akkeyがどこからでも（スマホ含む）Slackでエージェントに指示できる
- 24時間常駐エージェントが自律的に業務・開発タスクを実行する
- 「器がない」問題を解消し、AIA組織の連続稼働を実現する

---

## アーキテクチャ

```
Akkey（Slack）
    ↓
OpenClaw Gateway（EC2常駐）
    ↓
Claude API（タスク別モデル割り当て）
    ├── claude-haiku-4-5  … 軽量タスク
    ├── claude-sonnet-4-6 … 判断タスク
    └── claude-opus-4-6   … 重要・不可逆タスク（デフォルト）
    ↓
Skills（ツール群）
    ├── Claude Code起動
    ├── freee MCP
    └── Obsidian連携
```

---

## インフラ

| 項目               | 内容                     |
| ------------------ | ------------------------ |
| ホスティング       | AWS EC2                  |
| インスタンスサイズ | t3.medium（4GB RAM）以上 |
| OS                 | Ubuntu 24.04             |
| Node.js            | v22 LTS（22.16+）        |
| 常駐方式           | systemd user service     |
| リージョン         | ap-northeast-1（東京）   |

---

## メッセージングチャンネル

### Phase 1

- **Slack**（メイン）
  - allowFrom: AkkeyのユーザーID
  - メンション形式: `@openclaw`

### Phase 2以降（検討）

- LINE
- Telegram

---

## Skills（優先順位順）

### Phase 1

#### 1. Claude Code起動 (`skill-claude-code`)

- Claude CodeセッションをEC2上で起動する
- 指定ディレクトリでタスクを実行させる
- 実行結果をSlackに返信する
- 対象ディレクトリ:
  - `/Volumes/Dev_SSD/rag-in-a-box/`
  - `/Volumes/Dev_SSD/synthagent/`
  - `/Volumes/Dev_SSD/aia-company/`

#### 2. freee MCP (`skill-freee`)

- freee APIと連携した業務自動化
- **不可逆操作の保護（必須）**:
  - 仕訳登録 → 確認プロンプト必須
  - 請求書発行 → 確認プロンプト必須
  - 支払い実行 → 二段階承認必須
- 読み取り系（残高確認・一覧取得）は自動実行OK

#### 3. Obsidian連携 (`skill-obsidian`)

- Vault: `/Users/akkey/Documents/Artifacts/`
- 対応操作:
  - デイリーノートへの追記
  - タスク追加・完了マーク
  - ノート検索・読み取り
  - 週次PDCAへの記録

### Phase 2（将来）

- GitHub操作
- AIA組織エージェント（7部門）への委譲

### Kanban統合（aiajp/kanban フォーク, Apache-2.0）

SynthAgentをClaude Code / Codex / Clineと同列でオーケストレーション可能にするため、
kanbanのエージェントカタログ機構を `src/core/` に統合。

- `src/core/api-contract.ts` — RuntimeAgentId 型定義（"synthagent" 追加）
- `src/core/agent-catalog.ts` — エージェントカタログ + SynthAgentエントリ
- `src/core/home-agent-session.ts` — サイドバーセッション管理

コアへの追加理由: kanbanボードからのエージェント起動・管理に必須の型とレジストリ。
OpenClaw本体のコアモジュールは変更せず、新規ファイルとして追加。

---

## モデル割り当て

タスクの重要度・不可逆性に応じて3段階でモデルを使い分ける。

| Tier     | モデル              | 用途                     | 操作例                                                                   |
| -------- | ------------------- | ------------------------ | ------------------------------------------------------------------------ |
| Light    | `claude-haiku-4-5`  | 軽量・読み取り・定型     | Obsidian記録・読み取り、確認・検索系操作、定期チェック（heartbeat）      |
| Standard | `claude-sonnet-4-6` | 判断・実行               | Claude Code起動・管理、GitHub操作、freee書き込み（仕訳登録・請求書作成） |
| Critical | `claude-opus-4-6`   | 重要・不可逆・デフォルト | freee仕訳登録・請求書発行、二段階承認が必要な操作、未分類タスク          |

### 割り当てルール

1. **デフォルトモデル**: `claude-opus-4-6`（未分類・判断が難しいタスクは最上位で処理）
2. **スキル別オーバーライド**: 各スキルの SKILL.md でモデルを指定可能
3. **操作分類との対応**:
   - 読み取り・軽量書き込み → `claude-haiku-4-5`
   - 重要操作 → `claude-sonnet-4-6`
   - 不可逆操作 → `claude-opus-4-6`

### コスト最適化の方針

- heartbeat・ヘルスチェック等の定期タスクは必ず `haiku` を使用
- Obsidian検索・ノート読み取りは `haiku` で十分
- freee読み取り（残高確認・一覧取得）は `haiku` で処理
- freee書き込み（仕訳・請求書・支払い）は `opus` で慎重に処理

### Kanbanタスクのモデル分離（2フェーズ実行）

SDDタスクをKanbanで実行する際、`orchestrate` アクションで2フェーズに分離可能:

| フェーズ       | モデル                  | 目的                                           |
| -------------- | ----------------------- | ---------------------------------------------- |
| Plan           | `claude-opus-4-6`       | コードベース調査・実装計画作成（読み取り専用） |
| Execute        | `claude-sonnet-4-6`     | 計画に従った実装（コスト1/5、レスポンス高速）  |
| Review         | `claude-opus-4-6` (API) | PR差分のセマンティックレビュー（EC2負荷ゼロ）  |
| Fix (リトライ) | `claude-sonnet-4-6`     | レビュー指摘に基づく修正（最大2回）            |

従来の `start` アクション（全工程Opus単一セッション）も引き続き利用可能。

---

## セキュリティ設計

### 認証

- Slack allowFrom: Akkeyのユーザーのみ
- EC2セキュリティグループ: 最小権限

### 操作分類

| 分類         | 例                                | 実行方式       |
| ------------ | --------------------------------- | -------------- |
| 読み取り     | Obsidian検索、freee残高確認       | 自動実行       |
| 軽量書き込み | Obsidianメモ追記、Claude Code起動 | 自動実行       |
| 重要操作     | freee仕訳登録、GitHub push        | 確認プロンプト |
| 不可逆操作   | freee請求書発行、支払い実行       | 二段階承認     |

### 監査ログ

- 全操作をローカルSQLiteに記録
- 将来的にCloudWatch連携（Phase 2）

---

## 除外する機能（スコープ外）

OpenClawの以下機能はAIA版では不要のため実装しない：

- WhatsApp / Telegram / Discord / iMessage連携
- マルチテナント対応
- ClawHub（スキルマーケット）
- 音声（speak/listen）
- Canvas
- マルチユーザー対応

---

## ディレクトリ構成

```
/Volumes/Dev_SSD/openclaw-aia/
├── SPEC.md          # 本ファイル
├── CLAUDE.md        # Claude Code向け実装ガイド
├── skills/
│   ├── skill-claude-code/
│   │   └── SKILL.md
│   ├── skill-freee/
│   │   └── SKILL.md
│   └── skill-obsidian/
│       └── SKILL.md
├── config/
│   └── openclaw.yaml  # AIA用設定
└── docs/
    └── setup.md       # EC2セットアップ手順
```

---

## ロードマップ

### Week 1

- [ ] OpenClawフォーク → `aiajp/openclaw-aia`
- [ ] EC2セットアップ（Ubuntu 24.04 + Node.js 22）
- [ ] Slack連携確認（疎通テスト）
- [ ] 不要チャンネルの除去

### Week 2

- [ ] `skill-claude-code` 実装
- [ ] `skill-obsidian` 実装
- [ ] 基本的な動作確認

### Week 3

- [ ] `skill-freee` 実装
- [ ] 不可逆操作の承認フロー実装
- [ ] 監査ログ実装

### Week 4

- [ ] 統合テスト
- [ ] 運用開始

---

## コア変更履歴

### 2026-03-28: Card tags and priority (api-contract.ts, task-board-mutations.ts)

**変更箇所**: `kanban/src/core/api-contract.ts`, `kanban/src/core/task-board-mutations.ts`
**理由**: KANBANカードに優先順位タグを付けて分類・フィルタリングするため
**内容**: `RuntimeBoardCard` に `tags: string[]` と `priority: "low"|"medium"|"high"|"critical"` をオプショナルで追加
**影響**: 既存カードはフィールド未設定のまま動作（後方互換）

### 2026-03-28: Review trigger hook (runtime-state-hub.ts)

**変更箇所**: `kanban/src/server/runtime-state-hub.ts` — `broadcastTaskReadyForReview`
**理由**: KANBANタスクが `awaiting_review` に遷移した際に、外部スクリプト（PR自動レビュー）を起動するため
**内容**: 環境変数 `KANBAN_REVIEW_TRIGGER_SCRIPT` が設定されている場合、非ブロッキングでスクリプトを spawn
**影響**: 環境変数未設定時は既存動作と完全に同一（副作用なし）

## 参考

- OpenClaw本家: https://github.com/openclaw/openclaw
- ライセンス: MIT
- AIA GitHub: https://github.com/aiajp
