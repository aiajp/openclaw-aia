#!/usr/bin/env bash
# deploy-kanban-ec2.sh — Deploy kanban + synthagent-cli to EC2
#
# Usage:
#   ./scripts/deploy-kanban-ec2.sh
#
# Prerequisites:
#   - SSH access to EC2 (54.249.184.165)
#   - kanban built locally (npm run build in /Volumes/Dev_SSD/kanban)

set -euo pipefail

EC2_HOST="54.249.184.165"
EC2_USER="ubuntu"
SSH_KEY="/Volumes/Dev_SSD/openclaw-aia/.ssh-key-aia-openclaw.pem"
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=10"

KANBAN_LOCAL="/Volumes/Dev_SSD/kanban"
KANBAN_REMOTE="/home/ubuntu/kanban"
SYNTHAGENT_CLI_LOCAL="/Volumes/Dev_SSD/openclaw-aia/scripts/synthagent-cli"

echo "=== Kanban EC2 Deploy ==="

# ── 1. Verify SSH ────────────────────────────────────────────────
echo "[1/6] Checking SSH connectivity..."
if ! ssh $SSH_OPTS $EC2_USER@$EC2_HOST "echo ok" 2>/dev/null; then
  echo "SSH failed. Running SG auto-repair..."
  /Volumes/Dev_SSD/openclaw-aia/scripts/update-ssh-sg.sh
  sleep 3
  ssh $SSH_OPTS $EC2_USER@$EC2_HOST "echo ok" || { echo "SSH still failing."; exit 1; }
fi
echo "  SSH: OK"

# ── 2. Verify local build ───────────────────────────────────────
echo "[2/6] Checking local kanban build..."
if [[ ! -f "$KANBAN_LOCAL/dist/cli.js" ]]; then
  echo "  kanban not built. Building..."
  (cd "$KANBAN_LOCAL" && npm run build)
fi
echo "  Build: OK"

# ── 3. Sync kanban to EC2 ───────────────────────────────────────
echo "[3/6] Syncing kanban to EC2..."
rsync -az --delete \
  -e "ssh $SSH_OPTS" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='web-ui/node_modules' \
  --exclude='coverage' \
  "$KANBAN_LOCAL/" "$EC2_USER@$EC2_HOST:$KANBAN_REMOTE/"
echo "  Sync: OK"

# ── 4. Install deps + synthagent-cli on EC2 ─────────────────────
echo "[4/6] Installing dependencies on EC2..."
ssh $SSH_OPTS $EC2_USER@$EC2_HOST "mkdir -p ~/.local/bin"
scp $SSH_OPTS "$SYNTHAGENT_CLI_LOCAL" "$EC2_USER@$EC2_HOST:/home/ubuntu/.local/bin/synthagent-cli"

ssh $SSH_OPTS $EC2_USER@$EC2_HOST bash <<'REMOTE_SCRIPT'
set -euo pipefail

# Ensure .local/bin is in PATH
mkdir -p ~/.local/bin
if ! grep -q '.local/bin' ~/.profile 2>/dev/null; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.profile
fi
export PATH="$HOME/.local/bin:$PATH"

# Make synthagent-cli executable
chmod +x ~/.local/bin/synthagent-cli

# Ensure jq is available (required by synthagent-cli)
if ! command -v jq &>/dev/null; then
  sudo apt-get install -y jq
fi

# Ensure build-essential for node-pty
if ! dpkg -s build-essential &>/dev/null 2>&1; then
  sudo apt-get update && sudo apt-get install -y build-essential python3
fi

# Install kanban node deps
cd ~/kanban
npm install --production --ignore-scripts 2>&1 | tail -3
npm rebuild node-pty 2>&1 | tail -3

echo "Dependencies: OK"
REMOTE_SCRIPT
echo "  Install: OK"

# ── 5. Setup systemd service ────────────────────────────────────
echo "[5/6] Setting up systemd service..."
ssh $SSH_OPTS $EC2_USER@$EC2_HOST bash <<'REMOTE_SCRIPT'
set -euo pipefail

mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/kanban.service << 'EOF'
[Unit]
Description=Kanban Board Server (SynthAgent enabled)
After=network.target

[Service]
Type=simple
Environment="NODE_ENV=production"
Environment="KANBAN_RUNTIME_HOST=0.0.0.0"
Environment="KANBAN_RUNTIME_PORT=3484"
Environment="PATH=/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin"
EnvironmentFile=-/opt/kanban.env
ExecStart=/usr/bin/node /home/ubuntu/kanban/dist/cli.js --no-open
WorkingDirectory=/home/ubuntu/kanban
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable kanban
systemctl --user restart kanban

sleep 2
systemctl --user status kanban --no-pager || true

echo "Systemd: OK"
REMOTE_SCRIPT
echo "  Service: OK"

# ── 6. Add SG rule for port 3484 ────────────────────────────────
echo "[6/6] Updating security group for port 3484..."
CURRENT_IP=$(curl -s https://checkip.amazonaws.com)
SG_ID="sg-00453557f8d6518da"

# Check if rule already exists
existing=$(aws ec2 describe-security-groups \
  --region ap-northeast-1 \
  --group-ids "$SG_ID" \
  --query "SecurityGroups[0].IpPermissions[?FromPort==\`3484\`].IpRanges[].CidrIp" \
  --output text 2>/dev/null || true)

if echo "$existing" | grep -q "$CURRENT_IP"; then
  echo "  SG rule already exists for $CURRENT_IP"
else
  # Remove old 3484 rules
  old_cidrs=$(aws ec2 describe-security-groups \
    --region ap-northeast-1 \
    --group-ids "$SG_ID" \
    --query "SecurityGroups[0].IpPermissions[?FromPort==\`3484\`].IpRanges[].CidrIp" \
    --output text 2>/dev/null || true)
  for cidr in $old_cidrs; do
    aws ec2 revoke-security-group-ingress \
      --region ap-northeast-1 \
      --group-id "$SG_ID" \
      --protocol tcp --port 3484 --cidr "$cidr" 2>/dev/null || true
  done

  # Add new rule
  aws ec2 authorize-security-group-ingress \
    --region ap-northeast-1 \
    --group-id "$SG_ID" \
    --protocol tcp --port 3484 --cidr "${CURRENT_IP}/32" 2>/dev/null || true
  echo "  SG rule added: ${CURRENT_IP}/32 → 3484"
fi

echo ""
echo "=== Deploy Complete ==="
echo "Kanban UI: http://${EC2_HOST}:3484"
echo "Logs:      ssh $SSH_OPTS $EC2_USER@$EC2_HOST journalctl --user -u kanban -f"
