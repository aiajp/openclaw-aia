# OpenClaw AIA Edition

OpenClaw（MIT License）をAIA株式会社の自社業務用にフォークしたエージェント常駐基盤。
フォーク元: https://github.com/openclaw/openclaw

## リポジトリ構成

```
├── SPEC.md                    # プロダクト仕様書
├── CLAUDE.md                  # 本ファイル（実装ガイド）
├── src/
│   └── core/                  # kanban統合（エージェントカタログ）
│       ├── api-contract.ts    # RuntimeAgentId型定義
│       ├── agent-catalog.ts   # エージェントカタログ（SynthAgent含む）
│       └── home-agent-session.ts  # セッション管理
├── extensions/
│   └── synthagent-acp/        # SynthAgent ACP Backendプラグイン
│       ├── openclaw.plugin.json
│       ├── index.ts
│       └── src/
│           ├── service.ts     # プラグインサービス（start/stop）
│           └── runtime.ts     # AcpRuntime実装（HTTP→ACP変換）
├── scripts/
│   └── synthagent-cli         # kanban用CLIアダプタ
├── skills/
│   ├── skill-claude-code/     # Claude Codeセッション起動スキル
│   ├── skill-freee/           # freee API連携スキル
│   ├── skill-obsidian/        # Obsidian Vault連携スキル
│   ├── skill-scrum/           # AI駆動スクラムエージェント（GitHub Projects連携）
│   │   ├── SKILL.md           # スキル定義・トリガー・アクション
│   │   ├── handler.ts         # メインハンドラー（7アクション）
│   │   └── lib/
│   │       ├── github-projects.ts  # GitHub Projects v2 GraphQL APIラッパー
│   │       ├── task-executor.ts    # Ready Task → Claude Code → PR作成
│   │       ├── auto-reviewer.ts    # Claude Code opus でPRレビュー
│   │       ├── sprint-planner.ts   # Sprint Planning提案・承認
│   │       ├── daily-standup.ts    # Daily Standupレポート
│   │       └── sprint-review.ts    # Sprint Reviewレポート・ベロシティ
│   ├── skill-kanban/          # (廃止予定) Kanbanボード連携 → skill-scrumに移行
│   └── skill-reviewer/        # PRレビュー → skill-scrum/auto-reviewerに統合予定
├── config/                    # AIA用設定ファイル
└── docs/
    ├── setup.md               # EC2セットアップ手順
    ├── architecture-integration.md  # 3システム統合アーキテクチャ
    └── SDD-scrum-agent.md     # スクラムエージェントSDD
```

## Skills実装方針

各スキルは `skills/<skill-name>/SKILL.md` にスキル定義を記述する。
OpenClawのスキルフレームワークに準拠し、以下の構造で実装:

- **SKILL.md**: スキルのメタデータ、トリガー条件、パラメータ定義
- **index.ts**: スキルのエントリポイント
- **handler.ts**: ビジネスロジック

### 実装優先順位
1. `skill-claude-code` — EC2上でClaude Codeセッションを起動・管理
2. `skill-freee` — freee APIとの連携（不可逆操作保護必須）
3. `skill-obsidian` — Obsidian Vaultの読み書き

## EC2デプロイ

ホスト: `43.207.98.175` (ap-northeast-1, t3.medium)

```bash
# SSH接続
ssh -i /Volumes/Dev_SSD/openclaw-aia/.ssh-key-aia-openclaw.pem ubuntu@43.207.98.175

# 詳細手順は docs/setup.md を参照
```

## セキュリティ方針 — 4段階操作分類

すべてのスキル実装は以下の操作分類に従うこと:

| 分類 | 例 | 実行方式 | 実装要件 |
|------|-----|---------|----------|
| 読み取り | Obsidian検索、freee残高確認 | 自動実行 | ログ記録のみ |
| 軽量書き込み | Obsidianメモ追記、Claude Code起動 | 自動実行 | ログ記録 + 結果通知 |
| 重要操作 | freee仕訳登録、GitHub push | 確認プロンプト | Slack確認メッセージ → 承認後実行 |
| 不可逆操作 | freee請求書発行、支払い実行 | 二段階承認 | 内容確認 → 最終確認 → 実行 |

## 触ってはいけないファイル・設定

- `/.ssh-key-aia-openclaw.pem` — SSH秘密鍵（gitignore対象）
- `/opt/openclaw.env` — EC2上の環境変数（APIキー含む）
- OpenClaw本体のコアモジュール（`src/core/`, `src/gateway/`）は原則変更しない
  - カスタマイズはskills/、config/、docs/に集約する
- `.github/workflows/` — 上流のCIをそのまま維持

## 開発時の注意

- 上流（openclaw/openclaw）の更新を定期的にマージする想定
- AIA固有の変更はskills/、config/、docs/に集約する
- コアへの変更が必要な場合はSPEC.mdに理由を記録してからPR
- 監査ログ（SQLite）は全操作で記録すること

## SynthAgent連携

SynthAgentはCLIではなくFastAPI HTTPサーバー。2つの統合パスがある:

### パス1: OpenClaw Gateway経由（推奨）

`extensions/synthagent-acp/` — ACP Runtime Backendプラグイン。
Gateway→SynthAgent HTTP APIをネイティブに接続。

```yaml
# openclaw.yaml での設定例
agents:
  list:
    - id: synthagent
      runtime:
        type: acp
        acp:
          backend: synthagent-acp
          mode: oneshot
```

### パス2: Kanbanボード経由

`scripts/synthagent-cli` — CLIアダプタ。kanbanのPTYモデルとの橋渡し。

```bash
./scripts/synthagent-cli "Hello, SynthAgent"
```

### 共通環境変数

```bash
export SYNTHAGENT_BASE_URL=http://localhost:8000
export SYNTHAGENT_API_KEY=sa_live_xxx
```

### SynthAgent APIエンドポイント

- `POST /v1/agent/chat/stream` — SSEストリーミング（ACP Backend使用）
- `POST /v1/agent/chat` — 同期チャット（CLIアダプタのフォールバック）
- `POST /v1/a2a/invoke` — Agent-to-Agent プロトコル（将来）
- `GET /health`, `GET /ready` — ヘルスチェック

## ビルド・テスト

上流のREADMEおよび本家CLAUDE.mdのBuild/Test節を参照:
- `pnpm install` → `pnpm build` → `pnpm test`
- Node.js 22+ 必須
