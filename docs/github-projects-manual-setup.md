# GitHub Projects 手動セットアップ手順

## 対象ボード

https://github.com/users/aiajp/projects/1

---

## 1. Status フィールドの修正

### 1-1. "Sprint Backlog" → "Ready" にリネーム

1. ボード右上の `...` → **Settings** を開く
   - または直接: https://github.com/users/aiajp/projects/1/settings
2. 左メニューから **Custom fields** を選択
3. **Status** フィールドをクリック
4. 「🎯 Sprint Backlog」の横の鉛筆アイコンをクリック
5. 名前を `🎯 Ready` に変更
6. **Save** をクリック

### 1-2. "Blocked" ステータスを追加

1. 同じ Status フィールドの設定画面で
2. 一番下の **+ Add option** をクリック
3. 名前: `🚫 Blocked`
4. 色: 赤系を選択
5. **Save** をクリック
6. ドラッグで「In Review」と「Done」の間に配置

### 完了後の Status 順序

```
📋 Backlog
🎯 Ready        ← "Sprint Backlog" からリネーム
🔄 In Progress
👀 In Review
🚫 Blocked       ← 新規追加
✅ Done
```

---

## 2. 古い Draft Issues の削除（12件）

1. ボードを開く: https://github.com/users/aiajp/projects/1
2. View を **Table** に切り替える（右上のテーブルアイコン）
3. 以下の12件のDraft Issueを1つずつ削除:

| #   | タイトル                         |
| --- | -------------------------------- |
| 1   | GitHub Actions CI/CD構築         |
| 2   | APIゲートウェイ設定              |
| 3   | calm3-22b API統合                |
| 4   | 認証システム実装 (Auth0/Cognito) |
| 5   | FAQ生成エージェント実装          |
| 6   | AWS環境セットアップ              |
| 7   | ドメイン設定 (aia.co.jp)         |
| 8   | SSL証明書設定                    |
| 9   | データベース設計 (PostgreSQL)    |
| 10  | エージェントテスト環境構築       |
| 11  | API仕様書作成 (OpenAPI)          |
| 12  | 開発者ガイド作成                 |

### 削除手順（各Issueに対して）

1. Issue行の右端の `...` をクリック
2. **Delete from project** を選択
3. 確認ダイアログで **Delete** をクリック

---

## 3. Board View のカラム順序確認

1. View を **Board** に切り替え
2. カラムが以下の順序で並んでいることを確認:

```
📋 Backlog → 🎯 Ready → 🔄 In Progress → 👀 In Review → 🚫 Blocked → ✅ Done
```

3. 順序が違う場合はカラムヘッダーをドラッグして並べ替え

---

## 4. （任意）ボードの説明を更新

1. Settings → **Description** に以下を入力:

```
AIA株式会社 スクラムボード
Sprint: 1週間 / 実効容量: 28pt
対象: synthagent, rag-in-a-box, openclaw-aia
```

---

## 所要時間の目安

- Status修正: 2分
- Draft Issues削除: 5分
- カラム確認: 1分
- **合計: 約8分**

---

## 次のステップ（この手順完了後）

Phase 1 残り（Claude Codeで実施）:

1. Issue Templates（`.github/ISSUE_TEMPLATE/`）を3リポジトリに配置
2. 既存タスク（Weeklyノート未完了分）をGitHub Issuesに移行
3. 移行したIssueをSprint Boardに追加
