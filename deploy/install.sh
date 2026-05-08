#!/bin/bash
# Dump Sniper V1 部署脚本
# 用法：sudo bash deploy/install.sh [安装路径，默认 /opt/dump-sniper-v1]

set -euo pipefail

INSTALL_DIR="${1:-/opt/dump-sniper-v1}"
SERVICE_USER="${SERVICE_USER:-ubuntu}"

echo "======================================"
echo "Dump Sniper V1 部署"
echo "======================================"
echo "安装路径: $INSTALL_DIR"
echo "运行用户: $SERVICE_USER"
echo ""

if [[ $EUID -ne 0 ]]; then
   echo "⚠️  此脚本需要 root 权限运行 (sudo)"
   exit 1
fi

# 1. 拷贝项目（假设当前在项目根目录）
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"

if [[ ! -d "$INSTALL_DIR" ]]; then
    echo "[1/6] 创建安装目录: $INSTALL_DIR"
    mkdir -p "$INSTALL_DIR"
fi

echo "[2/6] 拷贝项目文件"
rsync -a --exclude='node_modules' --exclude='data/*.db*' --exclude='logs/*' \
      --exclude='.env' --exclude='reports/*.md' \
      "$PROJECT_DIR/" "$INSTALL_DIR/"

mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/logs" "$INSTALL_DIR/reports"

echo "[3/6] 安装依赖（npm install）"
cd "$INSTALL_DIR"
sudo -u "$SERVICE_USER" npm install --omit=dev

echo "[4/6] 设置文件权限"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
chmod 600 "$INSTALL_DIR/.env" 2>/dev/null || true

# 5. 安装 systemd 服务
echo "[5/6] 配置 systemd 服务"
SERVICE_FILE="/etc/systemd/system/dump-sniper.service"
sed -e "s|/opt/dump-sniper-v1|$INSTALL_DIR|g" \
    -e "s|^User=ubuntu|User=$SERVICE_USER|" \
    -e "s|^Group=ubuntu|Group=$SERVICE_USER|" \
    "$INSTALL_DIR/deploy/dump-sniper.service" > "$SERVICE_FILE"

systemctl daemon-reload

# 6. logrotate
echo "[6/6] 配置 logrotate"
sed "s|/opt/dump-sniper-v1|$INSTALL_DIR|g" \
    "$INSTALL_DIR/deploy/logrotate.conf" > /etc/logrotate.d/dump-sniper

echo ""
echo "✅ 安装完成"
echo ""
echo "下一步："
echo "  1. 编辑配置文件：sudo -u $SERVICE_USER vim $INSTALL_DIR/.env"
echo "  2. 启动服务：    sudo systemctl start dump-sniper"
echo "  3. 开机自启：    sudo systemctl enable dump-sniper"
echo "  4. 查看状态：    sudo systemctl status dump-sniper"
echo "  5. 查看日志：    sudo journalctl -u dump-sniper -f"
echo "  6. 实时输出：    tail -f $INSTALL_DIR/logs/out.log"
echo ""
