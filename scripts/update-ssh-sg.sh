#!/bin/bash
# update-ssh-sg.sh — EC2 SSHセキュリティグループのIP自動更新
# Usage: ./scripts/update-ssh-sg.sh [IP_ADDRESS]
#   引数なしの場合は現在のパブリックIPを自動検出

set -euo pipefail

SG_ID="sg-00453557f8d6518da"
REGION="ap-northeast-1"
PORT=22
DESCRIPTION="Akkey SSH"

# 現在のIPを取得（引数があればそれを使用）
if [ -n "${1:-}" ]; then
  CURRENT_IP="$1"
else
  CURRENT_IP=$(curl -s -4 --max-time 5 ifconfig.me 2>/dev/null || curl -s --max-time 5 https://api.ipify.org 2>/dev/null)
fi

if [ -z "$CURRENT_IP" ]; then
  echo "ERROR: パブリックIPを取得できませんでした"
  exit 1
fi

echo "現在のIP: ${CURRENT_IP}"

# 既存のSSHルールのCIDRを取得
EXISTING_CIDR=$(aws ec2 describe-security-groups \
  --group-ids "$SG_ID" \
  --query "SecurityGroups[0].IpPermissions[?FromPort==\`${PORT}\`].IpRanges[0].CidrIp" \
  --output text \
  --region "$REGION" 2>/dev/null)

EXISTING_IP="${EXISTING_CIDR%/32}"

if [ "$EXISTING_IP" = "$CURRENT_IP" ]; then
  echo "OK: SGルールは最新です (${CURRENT_IP}/32)"
  exit 0
fi

echo "更新: ${EXISTING_CIDR:-なし} → ${CURRENT_IP}/32"

# 既存ルールを削除（存在する場合）
if [ -n "$EXISTING_CIDR" ] && [ "$EXISTING_CIDR" != "None" ]; then
  aws ec2 revoke-security-group-ingress \
    --group-id "$SG_ID" \
    --protocol tcp \
    --port "$PORT" \
    --cidr "$EXISTING_CIDR" \
    --region "$REGION" > /dev/null
fi

# 新しいルールを追加
aws ec2 authorize-security-group-ingress \
  --group-id "$SG_ID" \
  --protocol tcp \
  --port "$PORT" \
  --cidr "${CURRENT_IP}/32" \
  --region "$REGION" \
  --tag-specifications "ResourceType=security-group-rule,Tags=[{Key=Description,Value=\"${DESCRIPTION}\"}]" > /dev/null

echo "OK: SGルール更新完了 (${CURRENT_IP}/32)"
