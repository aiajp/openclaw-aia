# EC2 セットアップ手順

## インスタンス情報

| 項目                 | 値                                       |
| -------------------- | ---------------------------------------- |
| インスタンスID       | i-049ba110b475f2573                      |
| パブリックIP         | 54.249.184.165                           |
| インスタンスタイプ   | t3.medium                                |
| AMI                  | ami-04ae19f2563b23082 (Ubuntu 24.04 LTS) |
| ストレージ           | 20GB gp3                                 |
| リージョン           | ap-northeast-1                           |
| キーペア             | aia-openclaw-key                         |
| セキュリティグループ | sg-00453557f8d6518da (aia-openclaw-sg)   |

## SSH接続

```bash
ssh -i /Volumes/Dev_SSD/openclaw-aia/.ssh-key-aia-openclaw.pem ubuntu@54.249.184.165
```

## 初期設定手順（SSH接続後）

### 1. システムアップデート

```bash
sudo apt update && sudo apt upgrade -y
```

### 2. Node.js 22 LTS インストール

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

確認:

```bash
node --version  # v22.x.x
npm --version
```

### 3. OpenClaw AIA Edition インストール

```bash
npm install -g openclaw@latest
```

### 4. onboarding ウィザード実行

```bash
openclaw onboard --install-daemon
```

このコマンドで以下が設定される:

- systemd user service の作成
- 設定ディレクトリ `~/.openclaw/` の初期化
- Gateway デーモンの登録

### 5. 環境変数の設定

```bash
sudo tee /opt/openclaw.env << 'EOF'
# Anthropic API
ANTHROPIC_API_KEY=sk-ant-xxxxx

# Slack Bot
SLACK_BOT_TOKEN=xoxb-xxxxx
SLACK_APP_TOKEN=xapp-xxxxx

# OpenClaw
OPENCLAW_PORT=18789
OPENCLAW_LOG_LEVEL=info
EOF

sudo chmod 600 /opt/openclaw.env
```

### 6. Slack連携設定

`~/.openclaw/config.yaml` を編集:

```yaml
channels:
  slack:
    enabled: true
    allowFrom:
      - "AKKEY_SLACK_USER_ID"
    mentionPatterns:
      - "@openclaw"
```

### 7. Gateway デーモン起動

```bash
# lingering を有効化（ログアウト後もサービス維持）
sudo loginctl enable-linger ubuntu

# デーモン起動
systemctl --user start openclaw
systemctl --user enable openclaw

# 状態確認
systemctl --user status openclaw
```

### 8. 動作確認

```bash
# ポート確認
ss -tlnp | grep 18789

# ログ確認
journalctl --user -u openclaw -f
```

## 設定ファイルパス

| パス                      | 用途                  |
| ------------------------- | --------------------- |
| `/opt/openclaw.env`       | 環境変数（APIキー等） |
| `~/.openclaw/`            | 設定ディレクトリ      |
| `~/.openclaw/config.yaml` | メイン設定            |
| `~/.openclaw/skills/`     | スキル定義            |
| `~/.openclaw/logs/`       | ログディレクトリ      |

## Kanban ボードのデプロイ

### 自動デプロイ（推奨）

```bash
./scripts/deploy-kanban-ec2.sh
```

このスクリプトが以下を実行:

1. SSH疎通確認（失敗時はSG自動修復）
2. kanbanビルド済みファイルをrsync
3. `synthagent-cli` を `~/.local/bin/` に配置
4. `npm install --production` (node-pty等)
5. systemd user service 作成・起動
6. SGにポート3484を追加

### 手動デプロイ

```bash
# EC2にSSH
ssh -i .ssh-key-aia-openclaw.pem ubuntu@54.249.184.165

# kanbanディレクトリで
cd ~/kanban
npm install --production
node dist/cli.js --no-open --host 0.0.0.0 --port 3484
```

### SynthAgent環境変数の設定

```bash
sudo tee /opt/kanban.env << 'EOF'
SYNTHAGENT_BASE_URL=http://localhost:8000
SYNTHAGENT_API_KEY=sa_live_xxxxx
EOF
sudo chmod 600 /opt/kanban.env
```

### Kanban の設定パス

| パス                                     | 用途                             |
| ---------------------------------------- | -------------------------------- |
| `/home/ubuntu/kanban/`                   | kanbanインストール先             |
| `/home/ubuntu/.local/bin/synthagent-cli` | SynthAgent CLIアダプタ           |
| `/opt/kanban.env`                        | 環境変数（SynthAgent APIキー等） |

### ログ確認

```bash
journalctl --user -u kanban -f
```

## セキュリティグループ

| ポート | プロトコル | ソース            | 用途             |
| ------ | ---------- | ----------------- | ---------------- |
| 22     | TCP        | 182.249.49.134/32 | SSH              |
| 18789  | TCP        | 182.249.49.134/32 | OpenClaw Gateway |
| 3484   | TCP        | 182.249.49.134/32 | Kanban Web UI    |

> **注意**: IPアドレスが変わった場合はセキュリティグループのインバウンドルールを更新すること。

## トラブルシューティング

### SSH接続できない

- セキュリティグループのIPアドレスが現在のIPと一致しているか確認
- キーファイルのパーミッションが 600 か確認

### Gateway が起動しない

```bash
journalctl --user -u openclaw --no-pager -n 50
```

### Node.js バージョンが古い

```bash
sudo apt remove nodejs
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```
