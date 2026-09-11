#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# parser-core 一键部署脚本（Oracle VPS / Ubuntu 22.04+）
#
#   ./deploy.sh                   构建并启动内核，健康检查
#   ./deploy.sh --tunnel <TOKEN>  额外安装 Cloudflare Tunnel 连接器
#   API_KEY=xxx ./deploy.sh       指定内核密钥（默认自动生成并打印）
#
# TOKEN 在 Cloudflare Zero Trust → Networks → Tunnels → 新建隧道后，
# 页面 "Choose your environment / Debian 64-bit" 里的一键命令末尾那串 ey... 即是。
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[ok]${NC} $*"; }
warn() { echo -e "${YELLOW}[!!]${NC} $*"; }
die()  { echo -e "${RED}[xx]${NC} $*"; exit 1; }

TUNNEL_TOKEN=""; KEEP_KEY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tunnel) TUNNEL_TOKEN="${2:-}"; shift 2 ;;
    --key)    KEEP_KEY="${2:-}"; shift 2 ;;
    *)        warn "忽略未知参数: $1"; shift ;;
  esac
done

# 1) Docker
if ! command -v docker >/dev/null 2>&1; then
  warn "未检测到 Docker，正在安装..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER" || true
  log "Docker 已安装（当前 shell 需重新登录才能免 sudo，本次继续用 sudo）"
fi
DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="sudo docker"

# 2) API Key
if [[ -n "${KEEP_KEY}" ]]; then
  API_KEY_VALUE="${KEEP_KEY}"
elif [[ -n "${API_KEY:-}" ]]; then
  API_KEY_VALUE="${API_KEY}"
elif [[ -f .env ]]; then
  API_KEY_VALUE="$(grep -E '^API_KEY=' .env | cut -d= -f2- || true)"
fi
if [[ -z "${API_KEY_VALUE:-}" ]]; then
  API_KEY_VALUE="$(openssl rand -hex 16)"
fi
echo "API_KEY=${API_KEY_VALUE}" > .env
chmod 600 .env
log "已写入 .env（密钥：${API_KEY_VALUE}）"

# 3) 构建启动
$DOCKER compose down --remove-orphans >/dev/null 2>&1 || true
$DOCKER compose up -d --build
log "容器已启动"

# 4) 健康检查（镜像首次构建较慢，最多等 90s）
for i in $(seq 1 30); do
  if curl -fsS --max-time 3 http://127.0.0.1:9000/health >/dev/null 2>&1; then
    log "内核健康检查通过：$(curl -fsS http://127.0.0.1:9000/health)"
    break
  fi
  [[ $i -eq 30 ]] && { $DOCKER compose logs --tail 40; die "内核启动失败，日志如上"; }
  sleep 3
done

# 5) 真实解析自检（YouTube 最易被风控，用它验证出口 IP 是否干净）
if command -v docker >/dev/null 2>&1; then
  TEST=$($DOCKER compose exec -T parser-core node -e "
    fetch('http://127.0.0.1:9000/api/json',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Api-Key ${API_KEY_VALUE}'},body:JSON.stringify({url:'https://www.youtube.com/shorts/V2qS_3BpmVk'})}).then(r=>r.text()).then(t=>console.log(t.slice(0,300))).catch(e=>console.log('ERR '+e.message))
  " 2>/dev/null || echo "自检跳过")
  log "自检返回：${TEST}"
fi

# 6) Cloudflare Tunnel
if [[ -n "${TUNNEL_TOKEN}" ]]; then
  if ! command -v cloudflared >/dev/null 2>&1; then
    warn "安装 cloudflared..."
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
      | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
      | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
    sudo apt-get update -qq && sudo apt-get install -y -qq cloudflared
  fi
  sudo cloudflared service install "${TUNNEL_TOKEN}"
  sudo systemctl enable --now cloudflared
  sleep 3
  sudo systemctl is-active --quiet cloudflared && log "cloudflared 已连接" || die "cloudflared 未启动：sudo systemctl status cloudflared"
fi

cat <<EOF

${GREEN}================ 完成 ================${NC}
内核地址（内网）: http://127.0.0.1:9000
健康检查        : curl http://127.0.0.1:9000/health
API_KEY         : ${API_KEY_VALUE}

Cloudflare Pages 需配置：
  COBALT_INSTANCE_URL = https://api-reverse.cineflowing.com
  COBALT_API_KEY      = ${API_KEY_VALUE}
配置后请重试部署（Retry deployment）使变量生效。
EOF
