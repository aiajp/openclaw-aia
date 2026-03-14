# OpenClaw AIA Edition

OpenClaw（MIT License）をAIA株式会社の自社業務用にフォークしたエージェント常駐基盤。
フォーク元: https://github.com/openclaw/openclaw

## リポジトリ構成

```
├── SPEC.md                    # プロダクト仕様書
├── CLAUDE.md                  # 本ファイル（実装ガイド）
├── skills/
│   ├── skill-claude-code/     # Claude Codeセッション起動スキル
│   ├── skill-freee/           # freee API連携スキル
│   └── skill-obsidian/        # Obsidian Vault連携スキル
├── config/                    # AIA用設定ファイル
└── docs/
    └── setup.md               # EC2セットアップ手順
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

## ビルド・テスト

上流のREADMEおよび本家CLAUDE.mdのBuild/Test節を参照:
- `pnpm install` → `pnpm build` → `pnpm test`
- Node.js 22+ 必須
