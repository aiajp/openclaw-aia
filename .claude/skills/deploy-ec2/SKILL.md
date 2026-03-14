---
name: deploy-ec2
description: Deploy latest OpenClaw AIA build to EC2 — git pull, pnpm install, build, restart systemd service
disable-model-invocation: true
---

# Deploy to EC2

EC2上のOpenClaw AIAを最新版にデプロイする。

## Parameters

- `branch` (optional): デプロイするブランチ名。デフォルト: `main`
- `skip-build` (optional): ビルドをスキップする（設定変更のみの場合）

## Pre-flight Checks

1. ローカルの `main` ブランチに未コミットの変更がないことを確認
2. リモートとローカルが同期していることを確認
3. EC2への SSH 接続が可能であることを確認

## Deployment Steps

SSH接続先: `ubuntu@43.207.98.175`
SSH鍵: `/Volumes/Dev_SSD/openclaw-aia/.ssh-key-aia-openclaw.pem`

```bash
# 1. SSH接続
ssh -i /Volumes/Dev_SSD/openclaw-aia/.ssh-key-aia-openclaw.pem ubuntu@43.207.98.175 << 'DEPLOY'

# 2. ディレクトリ移動
cd ~/openclaw-aia

# 3. 最新コード取得
git fetch origin
git checkout ${branch:-main}
git pull origin ${branch:-main}

# 4. 依存関係インストール
pnpm install --frozen-lockfile

# 5. ビルド（skip-buildフラグがない場合）
pnpm build

# 6. systemdサービス再起動
systemctl --user restart openclaw

# 7. ヘルスチェック（10秒待機後）
sleep 10
systemctl --user status openclaw --no-pager

DEPLOY
```

## Post-deploy Verification

- `systemctl --user status openclaw` でサービスが active(running) であること
- Slackで `@openclaw ping` を送信して応答を確認

## Rollback

問題が発生した場合:
```bash
ssh -i /Volumes/Dev_SSD/openclaw-aia/.ssh-key-aia-openclaw.pem ubuntu@43.207.98.175 << 'ROLLBACK'
cd ~/openclaw-aia
git checkout HEAD~1
pnpm install --frozen-lockfile
pnpm build
systemctl --user restart openclaw
ROLLBACK
```

## Security

- このスキルはユーザーが明示的に `/deploy-ec2` で呼び出した場合のみ実行する
- SSH鍵のパスをログに出力しない
- デプロイ結果のみをSlackに通知する
