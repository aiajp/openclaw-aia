---
name: skill-freee
description: freee APIと連携した経理・請求・経費の業務自動化。不可逆操作の二段階承認を厳格に実施する。
metadata:
  {
    "openclaw":
      {
        "emoji": "💴",
        "model": "claude-opus-4-6",
        "requires": { "config": ["skills.skill-freee.company_id"] },
      },
  }
---

# freee API連携（AIA Edition）

## Overview

freee APIと連携し、AIA株式会社の経理・請求・経費業務を自動化するスキル。
**不可逆操作の保護を最優先とし、操作分類に厳格に従うこと。**

## モデル割り当て

操作の重要度に応じて3段階のモデルを使い分ける。

| 操作分類 | モデル | 理由 |
|---------|--------|------|
| 読み取り（残高確認・一覧取得・レポート） | `claude-haiku-4-5` | 軽量タスク、コスト最適化 |
| 重要操作（仕訳登録・請求書作成） | `claude-sonnet-4-6` | 判断を伴う書き込み |
| 不可逆操作（請求書発行・送付・支払い実行） | `claude-opus-4-6` | 最重要、取り消し不可 |

## 操作分類（セキュリティ） — 4段階モデル厳守

### Tier 1: 読み取り — 自動実行

| 操作 | 実行方式 | モデル | ログ |
|------|---------|--------|------|
| 口座残高確認 | 自動実行 | `claude-haiku-4-5` | 記録のみ |
| 取引一覧取得 | 自動実行 | `claude-haiku-4-5` | 記録のみ |
| 勘定科目一覧 | 自動実行 | `claude-haiku-4-5` | 記録のみ |
| 請求書一覧取得 | 自動実行 | `claude-haiku-4-5` | 記録のみ |
| 経費精算一覧 | 自動実行 | `claude-haiku-4-5` | 記録のみ |
| 月次レポート生成 | 自動実行 | `claude-haiku-4-5` | 記録のみ |
| 取引先一覧 | 自動実行 | `claude-haiku-4-5` | 記録のみ |

### Tier 2: 軽量書き込み — 該当なし

freee操作には軽量書き込みに分類される操作はない。
書き込みは全て重要操作以上に分類する。

### Tier 3: 重要操作 — 確認プロンプト必須

| 操作 | 実行方式 | モデル | ログ |
|------|---------|--------|------|
| 仕訳登録 | **確認プロンプト** | `claude-sonnet-4-6` | 記録 + Slack通知 |
| 請求書作成（下書き） | **確認プロンプト** | `claude-sonnet-4-6` | 記録 + Slack通知 |
| 経費精算登録 | **確認プロンプト** | `claude-sonnet-4-6` | 記録 + Slack通知 |
| 取引先登録・更新 | **確認プロンプト** | `claude-sonnet-4-6` | 記録 + Slack通知 |

確認プロンプト例（仕訳登録）:
```
🔔 freee 仕訳登録 確認
日付: 2026-03-15
借方: 通信費 ¥5,500
貸方: 普通預金 ¥5,500
摘要: AWS EC2利用料（3月分）

登録しますか？ (yes/no)
```

### Tier 4: 不可逆操作 — 二段階承認必須

| 操作 | 実行方式 | モデル | ログ |
|------|---------|--------|------|
| 請求書発行（確定） | **二段階承認** | `claude-opus-4-6` | 記録 + Slack通知 + 承認記録 |
| 請求書送付 | **二段階承認** | `claude-opus-4-6` | 記録 + Slack通知 + 承認記録 |
| 支払い実行 | **二段階承認** | `claude-opus-4-6` | 記録 + Slack通知 + 承認記録 |
| 仕訳削除 | **二段階承認** | `claude-opus-4-6` | 記録 + Slack通知 + 承認記録 |

二段階承認フロー:
```
ステップ1: 内容確認
🔔 freee 請求書発行 確認（ステップ 1/2）
請求先: 株式会社〇〇
金額: ¥550,000（税込）
件名: SynthAgent開発費（2026年3月分）
期日: 2026-04-30

内容を確認してください。正しいですか？ (yes/no)

ステップ2: 最終確認
⚠️ freee 請求書発行 最終確認（ステップ 2/2）
この操作は取り消せません。
請求書番号 INV-2026-0042 を発行します。

本当に実行しますか？ (yes/no)
```

### 承認タイムアウト

| 項目 | 値 |
|------|-----|
| 確認プロンプト（Tier 3）の応答期限 | 5分 |
| 二段階承認ステップ1の応答期限 | 5分 |
| ステップ1承認後、ステップ2の応答期限 | 3分 |
| タイムアウト時の動作 | 操作キャンセル + ログ記録 |

- タイムアウトした場合、操作は自動的にキャンセルされ `approval_status: timeout` としてログに記録する
- ステップ1承認済み・ステップ2タイムアウトの場合も、操作は実行されない

## アクション

### get_balance — 口座残高確認

```json
{
  "action": "get_balance",
  "account_type": "bank|wallet|all"
}
```

### list_deals — 取引一覧

```json
{
  "action": "list_deals",
  "start_date": "2026-03-01",
  "end_date": "2026-03-31",
  "account_item": "通信費"
}
```

### list_invoices — 請求書一覧

```json
{
  "action": "list_invoices",
  "status": "draft|issued|paid|all",
  "start_date": "2026-03-01"
}
```

### create_deal — 仕訳登録（確認プロンプト必須）

```json
{
  "action": "create_deal",
  "issue_date": "2026-03-15",
  "type": "expense",
  "details": [
    {
      "account_item": "通信費",
      "tax_code": "tax_10",
      "amount": 5500,
      "description": "AWS EC2利用料（3月分）"
    }
  ],
  "payment": {
    "from_account": "普通預金",
    "date": "2026-03-15"
  }
}
```

### create_invoice — 請求書作成（確認プロンプト必須）

```json
{
  "action": "create_invoice",
  "partner": "株式会社〇〇",
  "issue_date": "2026-03-31",
  "due_date": "2026-04-30",
  "items": [
    {
      "name": "SynthAgent開発費",
      "quantity": 1,
      "unit_price": 500000,
      "tax_code": "tax_10"
    }
  ]
}
```

### issue_invoice — 請求書発行（二段階承認必須）

```json
{
  "action": "issue_invoice",
  "invoice_id": 12345
}
```

### send_invoice — 請求書送付（二段階承認必須）

```json
{
  "action": "send_invoice",
  "invoice_id": 12345,
  "method": "email"
}
```

### execute_payment — 支払い実行（二段階承認必須）

```json
{
  "action": "execute_payment",
  "deal_id": 67890,
  "amount": 55000,
  "from_account": "普通預金",
  "date": "2026-03-25"
}
```

### generate_report — 月次レポート

```json
{
  "action": "generate_report",
  "type": "pl|bs|trial_balance",
  "year": 2026,
  "month": 3
}
```

## クレデンシャル管理

- **環境変数から取得**: `FREEE_CLIENT_ID`, `FREEE_CLIENT_SECRET`, `FREEE_ACCESS_TOKEN`
- **エージェントに直接渡さない**: 環境変数経由のみ許可
- **EC2上**: `/opt/openclaw.env` に格納
- **ローカル開発**: `.env.local`（gitignore対象）
- **トークンリフレッシュ**: freee MCPサーバーが自動管理

## 監査ログ

**全操作**をローカルSQLiteに記録する。これは監査要件であり省略不可。

| フィールド | 内容 |
|-----------|------|
| timestamp | ISO 8601 |
| action | get_balance / list_deals / create_deal / issue_invoice / etc. |
| tier | read / important / irreversible |
| model | 使用したモデル名 |
| user | akkey |
| approval_status | auto / approved / rejected / pending |
| approval_step | 1 / 2（二段階承認の場合） |
| request_body | APIリクエストの概要（金額・取引先等。機密情報はマスク） |
| response_status | HTTP ステータスコード |
| result | success / failure / cancelled |
| freee_id | freee側で発番されたID（仕訳ID、請求書ID等） |

### ログの保護

- クレデンシャル（トークン、シークレット）はログに記録しない
- 口座番号は下4桁のみ記録
- ログファイルのパーミッション: 600（オーナーのみ読み書き）

## エラーハンドリング

| エラー | 対応 |
|--------|------|
| 認証エラー（401） | トークンリフレッシュを試行 → 失敗時はSlack通知 |
| 権限エラー（403） | Slack通知、操作中断 |
| レートリミット（429） | 指数バックオフでリトライ（最大3回） |
| バリデーションエラー（400） | エラー内容をSlack通知、操作中断 |
| サーバーエラー（5xx） | リトライ（最大2回） → 失敗時はSlack通知 |

## 注意事項

- freeeの会計年度・消費税設定はAIA株式会社の設定に依存する
- テスト環境（sandbox）での動作確認を推奨するが、本スキルは本番APIを使用する
- 月末・期末の操作は特に慎重に（確定申告への影響）
- 二段階承認でユーザーが「no」と回答した場合、操作を即座に中断しログに記録する
