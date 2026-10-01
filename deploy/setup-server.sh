#!/usr/bin/env bash
# Dựng máy chủ CRM trên Debian 13 sạch.
#
# Cách dùng, chạy bằng quyền root trên VM:
#   sudo bash setup-server.sh <domain> <git-repo-url>
#
# Script chỉ cài đặt và cấu hình. Nó không tự điền secret: sau khi chạy xong
# phải sửa /opt/facebook-crm/.env rồi khởi động lại dịch vụ.

set -euo pipefail

DOMAIN="${1:-}"
REPO_URL="${2:-}"
APP_DIR=/opt/facebook-crm
APP_USER=crm

if [[ -z "$DOMAIN" || -z "$REPO_URL" ]]; then
  echo "Cách dùng: sudo bash setup-server.sh <domain> <git-repo-url>" >&2
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "Script này cần chạy bằng root." >&2
  exit 1
fi

# Cloud Shell trông giống một máy Debian nhưng là container tạm: không có
# systemd, không mang IP công khai, và mất sạch khi đóng phiên. Cài ở đó thì
# script chạy được gần hết rồi mới chết, nên chặn ngay từ đầu.
if [[ -n "${CLOUD_SHELL:-}" || "$(hostname)" == cs-* || "$(hostname)" == cloudshell* ]]; then
  cat >&2 <<'EOF'
Đây là Google Cloud Shell, không phải máy chủ đích.

Cloud Shell không chạy systemd và không giữ /opt sau khi đóng phiên, nên
cài ở đây là công cốc. Hãy SSH vào VM rồi chạy lại:

  gcloud compute ssh crm-facebook --zone=asia-southeast1-c

Sau khi dấu nhắc đổi thành tên máy ảo thì mới chạy script này.
EOF
  exit 1
fi

if ! [[ -d /run/systemd/system ]]; then
  echo "Máy này không chạy systemd nên không cài dịch vụ được." >&2
  echo "Script cần một máy Linux thật, ví dụ VM Compute Engine." >&2
  exit 1
fi

echo "==> Cập nhật hệ thống và cài gói nền"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git gnupg debian-keyring debian-archive-keyring apt-transport-https

echo "==> Cài Node.js"
# Ưu tiên NodeSource để có bản LTS mới. Kho này có thể chưa hỗ trợ bản Debian
# mới nhất, nên khi hỏng thì quay về gói nodejs của chính Debian.
if curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs; then
  echo "    Cài từ NodeSource."
else
  echo "    NodeSource không dùng được, chuyển sang kho Debian."
  rm -f /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs npm
fi

NODE_MAJOR="$(node --version | sed 's/^v\([0-9]*\).*/\1/')"
echo "    Node $(node --version)"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  # package.json: engines.node >=22 (fetch/FormData/Blob toàn cục, node:test, fs.globSync…).
  # Kho Debian có thể chỉ có Node cũ hơn: cài Node 22 bằng tay (NodeSource/nvm) rồi chạy lại script.
  echo "Cần Node.js 22 trở lên (đang có $(node --version)). Xem package.json → engines." >&2
  exit 1
fi

echo "==> Cài Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  install -d -m 0755 /usr/share/keyrings
  if curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
       | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
     && curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
       > /etc/apt/sources.list.d/caddy-stable.list \
     && apt-get update -y \
     && apt-get install -y caddy; then
    echo "    Cài từ kho Cloudsmith."
  else
    echo "    Kho Cloudsmith không dùng được, chuyển sang gói của Debian."
    rm -f /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y
    apt-get install -y caddy
  fi
fi
caddy version

echo "==> Tạo người dùng dịch vụ"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"

echo "==> Lấy mã nguồn"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi

echo "==> Cài phụ thuộc"
cd "$APP_DIR"
# npm ci (không phải npm install): giữ nguyên package-lock.json, lần git pull sau không bị chặn.
npm ci --omit=dev

echo "==> Chuẩn bị thư mục dữ liệu"
mkdir -p "$APP_DIR/data/processed" "$APP_DIR/logs"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> Tạo tệp .env nếu chưa có"
if [[ ! -f "$APP_DIR/.env" ]]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  sed -i "s#^PUBLIC_BASE_URL=.*#PUBLIC_BASE_URL=https://$DOMAIN#" "$APP_DIR/.env"
  sed -i "s#^HOST=.*#HOST=127.0.0.1#" "$APP_DIR/.env"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
fi

echo "==> Cài dịch vụ systemd"
install -m 644 "$APP_DIR/deploy/facebook-crm.service" /etc/systemd/system/facebook-crm.service
systemctl daemon-reload
systemctl enable facebook-crm

echo "==> Tài khoản đăng nhập CRM (chủ shop)"
# Không còn Basic Auth ở Caddy: CRM tự hỏi đăng nhập. PUBLIC_BASE_URL là https nên
# chưa có tài khoản thì CRM trả 503 "Chưa cấu hình đăng nhập" (không mở toang).
if ! grep -qE '^CRM_LOGIN_USERS=.+' "$APP_DIR/.env"; then
  read -rp "Tên đăng nhập chủ shop (chữ thường, không dấu): " OWNER_USER
  echo "Mật khẩu chủ shop (≥ 8 ký tự), gõ xong bấm Enter:"
  OWNER_HASH="$(sudo -u "$APP_USER" node "$APP_DIR/app/auth.mjs" hash-password | grep -o 'scrypt\$[A-Za-z0-9_-]*\$[A-Za-z0-9_-]*' || true)"
  if [[ -z "$OWNER_USER" || -z "$OWNER_HASH" ]]; then
    echo "Chưa tạo được tài khoản chủ shop — tự thêm CRM_LOGIN_USERS vào $APP_DIR/.env (xem deploy/README.md)." >&2
  else
    sed -i '/^CRM_LOGIN_USERS=/d' "$APP_DIR/.env"
    echo "CRM_LOGIN_USERS=${OWNER_USER,,}:$OWNER_HASH" >> "$APP_DIR/.env"
  fi
fi
if ! grep -qE '^CRM_SESSION_SECRET=.+' "$APP_DIR/.env"; then
  sed -i '/^CRM_SESSION_SECRET=/d' "$APP_DIR/.env"
  echo "CRM_SESSION_SECRET=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")" >> "$APP_DIR/.env"
fi

echo "==> Cấu hình Caddy"
# Dựng ra tệp tạm và kiểm TRƯỚC, chỉ khi đạt mới thay tệp thật. Ghi thẳng rồi
# mới validate là khi hỏng để lại một /etc/caddy/Caddyfile sai: Caddy vẫn chạy
# bằng cấu hình cũ trong bộ nhớ nhưng chết ở lần reload hoặc reboot kế tiếp.
CADDY_NEW="$(mktemp)"
sed -e "s#<DOMAIN>#$DOMAIN#" \
    "$APP_DIR/deploy/Caddyfile" > "$CADDY_NEW"
if ! caddy validate --config "$CADDY_NEW" --adapter caddyfile; then
  echo "Cấu hình Caddy vừa dựng không hợp lệ. KHÔNG đụng tới /etc/caddy/Caddyfile đang chạy." >&2
  rm -f "$CADDY_NEW"
  exit 1
fi
# Máy có thể đang phục vụ site khác: giữ lại bản cũ trước khi thay.
if [[ -s /etc/caddy/Caddyfile ]]; then
  CADDY_BACKUP="/etc/caddy/Caddyfile.truoc-facebook-crm.$(date +%Y%m%d-%H%M%S)"
  cp /etc/caddy/Caddyfile "$CADDY_BACKUP"
  echo "    Đã lưu cấu hình Caddy cũ ở $CADDY_BACKUP"
fi
install -m 644 "$CADDY_NEW" /etc/caddy/Caddyfile
rm -f "$CADDY_NEW"
systemctl restart caddy
sleep 2
if ! systemctl is-active --quiet caddy; then
  echo "Caddy không khởi động được. Xem chi tiết: journalctl -xeu caddy.service" >&2
  exit 1
fi

cat <<EOF

==> Xong phần cài đặt.

Còn phải làm bằng tay:
  1. Sửa $APP_DIR/.env và điền META_APP_ID, META_APP_SECRET,
     META_GRAPH_VERSION, META_VERIFY_TOKEN.
  2. Khởi động dịch vụ:  systemctl start facebook-crm
  3. Kiểm tra:           systemctl status facebook-crm
                         curl -s http://127.0.0.1:8080/api/health
     (gọi API qua https://$DOMAIN khi chưa đăng nhập sẽ ra 401 — CRM tự chặn
      mọi đường trừ /login, /privacy, /q/*, /product-images và các webhook)
  4. Dán vào Meta App:
     Callback URL       https://$DOMAIN/webhooks/facebook
     OAuth Redirect URI https://$DOMAIN/api/channels/meta/callback

Caddy tự xin chứng chỉ HTTPS ở lần truy cập đầu, với điều kiện DNS của
$DOMAIN đã trỏ đúng về máy này và cổng 80/443 đang mở.
EOF
