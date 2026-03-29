#!/bin/bash
# update-ssh-sg.sh — EC2セキュリティグループのIP自動更新（SSH + Kanban UI）
# Usage: ./scripts/update-ssh-sg.sh [IP_ADDRESS]
#   引数なしの場合は現在のパブリックIPを自動検出

set -euo pipefail

SG_ID="sg-00453557f8d6518da"
REGION="ap-northeast-1"
PORTS=(22 3484)
DESCRIPTIONS=("Akkey SSH" "Akkey Kanban UI")

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

update_port() {
  local PORT=$1
  local DESC=$2

  EXISTING_CIDR=$(aws ec2 describe-security-groups \
    --group-ids "$SG_ID" \
    --query "SecurityGroups[0].IpPermissions[?FromPort==\`${PORT}\`].IpRanges[0].CidrIp" \
    --output text \
    --region "$REGION" 2>/dev/null)

  EXISTING_IP="${EXISTING_CIDR%/32}"

  if [ "$EXISTING_IP" = "$CURRENT_IP" ]; then
    echo "OK: ポート${PORT} は最新です (${CURRENT_IP}/32)"
    return
  fi

  echo "更新: ポート${PORT} ${EXISTING_CIDR:-なし} → ${CURRENT_IP}/32"

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
  if aws ec2 authorize-security-group-ingress \
    --group-id "$SG_ID" \
    --protocol tcp \
    --port "$PORT" \
    --cidr "${CURRENT_IP}/32" \
    --region "$REGION" \
    --tag-specifications "ResourceType=security-group-rule,Tags=[{Key=Description,Value=\"${DESC}\"}]" > /dev/null 2>&1; then
    echo "OK: ポート${PORT} 更新完了 (${CURRENT_IP}/32)"
  else
    echo "OK: ポート${PORT} ルール既存 (${CURRENT_IP}/32)"
  fi
}

for i in "${!PORTS[@]}"; do
  update_port "${PORTS[$i]}" "${DESCRIPTIONS[$i]}"
done
