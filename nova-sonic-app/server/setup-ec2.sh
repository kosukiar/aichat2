#!/bin/bash
# EC2 セットアップスクリプト (Amazon Linux 2023 / Ubuntu)
# Usage: ssh into EC2, then run this script

set -e

echo "=== Installing Node.js 20 ==="
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - 2>/dev/null || \
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo yum install -y nodejs 2>/dev/null || sudo apt-get install -y nodejs

echo "=== Cloning repository ==="
git clone git@ssh.gitlab.aws.dev:kosukiar/aichat2.git
cd aichat2/nova-sonic-app

echo "=== Installing dependencies ==="
npm install --production

echo "=== Creating systemd service ==="
sudo tee /etc/systemd/system/nova-sonic.service > /dev/null <<EOF
[Unit]
Description=Nova Sonic WebSocket Server
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$(pwd)
Environment=PORT=3001
Environment=AWS_REGION=ap-northeast-1
ExecStart=/usr/bin/node server/index.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable nova-sonic
sudo systemctl start nova-sonic

echo "=== Done! Server running on port 3001 ==="
echo "Check status: sudo systemctl status nova-sonic"
echo "View logs: sudo journalctl -u nova-sonic -f"
