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
Claude API（claude-sonnet-4-5 / claude-haiku-4-5）
    ↓
Skills（ツール群）
    ├── Claude Code起動
    ├── freee MCP
    └── Obsidian連携
```

---

## インフラ

| 項目 | 内容 |
|------|------|
| ホスティング | AWS EC2 |
| インスタンスサイズ | t3.medium（4GB RAM）以上 |
| OS | Ubuntu 24.04 |
| Node.js | v22 LTS（22.16+） |
| 常駐方式 | systemd user service |
| リージョン | ap-northeast-1（東京） |

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
- SynthAgent連携

---

## セキュリティ設計

### 認証
- Slack allowFrom: Akkeyのユーザーのみ
- EC2セキュリティグループ: 最小権限

### 操作分類

| 分類 | 例 | 実行方式 |
|------|-----|---------|
| 読み取り | Obsidian検索、freee残高確認 | 自動実行 |
| 軽量書き込み | Obsidianメモ追記、Claude Code起動 | 自動実行 |
| 重要操作 | freee仕訳登録、GitHub push | 確認プロンプト |
| 不可逆操作 | freee請求書発行、支払い実行 | 二段階承認 |

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

## 参考

- OpenClaw本家: https://github.com/openclaw/openclaw
- ライセンス: MIT
- AIA GitHub: https://github.com/aiajp
