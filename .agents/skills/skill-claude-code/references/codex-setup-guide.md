# Codex Setup for Claude Code

このガイドでは、Claude Code内でCodexを使えるようにするための完全なセットアップ手順を説明します。

## 前提条件

- Node.js 18.18以降
- ChatGPTアカウント（無料版でもOK）またはOpenAI API key
- Claude Code CLI

## セットアップ手順

### 1. Codexをインストール

```bash
sudo npm install -g @openai/codex
```

インストール確認:

```bash
codex --version
# codex-cli 0.117.0
```

### 2. Codexにログイン

```bash
codex login
```

ブラウザが開くので、ChatGPTアカウントでログインするか、API keyを入力します。

ログイン確認:

```bash
codex whoami
```

### 3. Claude Codeを起動してプラグインをセットアップ

```bash
claude
```

Claude Codeセッション内で以下を実行:

#### 3-1. プラグインマーケットプレイスを追加

```
/plugin marketplace add openai/codex-plugin-cc
```

#### 3-2. Codexプラグインをインストール

```
/plugin install codex@openai-codex
```

#### 3-3. プラグインをリロード

```
/reload-plugins
```

#### 3-4. セットアップを確認

```
/codex:setup
```

✅ "Codex is ready" と表示されればセットアップ完了！

## 使い方

### コードレビュー

```bash
# 現在の変更をレビュー
/codex:review

# mainブランチとの差分をレビュー
/codex:review --base main

# バックグラウンドでレビュー
/codex:review --background
```

### 批判的レビュー（設計判断を問う）

```bash
# 設計の妥当性を問う
/codex:adversarial-review challenge whether this was the right caching design

# 特定のリスク領域を重点的にチェック
/codex:adversarial-review --background look for race conditions and data loss scenarios
```

### Codexにタスクを委譲

```bash
# バグ調査を依頼
/codex:rescue investigate why the tests started failing

# 修正を依頼
/codex:rescue fix the failing test with the smallest safe patch

# 軽量モデルで高速実行
/codex:rescue --model gpt-5.4-mini investigate the flaky integration test

# バックグラウンドで実行
/codex:rescue --background investigate the regression
```

### ステータス管理

```bash
# 実行中のタスク確認
/codex:status

# 結果を取得
/codex:result

# タスクをキャンセル
/codex:cancel
```

## 設定ファイル（オプション）

プロジェクトルートに `.codex/config.toml` を作成すると、デフォルトのモデルや設定を変更できます:

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "xhigh"
```

## トラブルシューティング

### Codexが見つからない

```bash
which codex
# /usr/bin/codex
```

パスが表示されない場合は、再インストール:

```bash
sudo npm install -g @openai/codex
```

### 認証エラー

```bash
codex login
```

再度ログインを試みてください。

### プラグインが動作しない

```bash
/reload-plugins
/codex:setup
```

プラグインをリロードして、セットアップを再確認してください。

## リファレンス

- [Codex Plugin for Claude Code - GitHub](https://github.com/openai/codex-plugin-cc)
- [Codex CLI Documentation](https://developers.openai.com/codex/cli/)
- [Codex Configuration Reference](https://developers.openai.com/codex/config-reference)

## 使用料金

- Codexの使用はChatGPT subscriptionまたはOpenAI API使用量に加算されます
- [Codex Pricing](https://developers.openai.com/codex/pricing/)

## セキュリティ上の注意

- プラグインはローカルのCodex CLIを使用します（リモート接続ではありません）
- 既存のCodex認証情報とconfigを使用します
- リポジトリのチェックアウトとマシンローカル環境を使用します
