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
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "Cần Node.js 18 trở lên: mã nguồn dùng fetch, FormData và Blob toàn cục." >&2
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
npm install --omit=dev

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

echo "==> Cấu hình Caddy"
read -rp "Tên đăng nhập cho trang quản trị: " ADMIN_USER
CADDY_HASH="$(caddy hash-password)"
sed -e "s#<DOMAIN>#$DOMAIN#" \
    -e "s#<USERNAME>#$ADMIN_USER#" \
    -e "s#<BCRYPT_HASH>#$CADDY_HASH#" \
    "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
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
                         curl -s https://$DOMAIN/api/health
  4. Dán vào Meta App:
     Callback URL       https://$DOMAIN/webhooks/facebook
     OAuth Redirect URI https://$DOMAIN/api/channels/meta/callback

Caddy tự xin chứng chỉ HTTPS ở lần truy cập đầu, với điều kiện DNS của
$DOMAIN đã trỏ đúng về máy này và cổng 80/443 đang mở.
EOF
