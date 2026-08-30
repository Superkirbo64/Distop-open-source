#!/usr/bin/env bash
# Instalador reproducible de Distop para Ubuntu/Debian amd64 o arm64.
# Descárgalo junto a install-vps.sh.sha256 desde una release y verifica antes:
#   sha256sum -c install-vps.sh.sha256 && sudo bash install-vps.sh
set -Eeuo pipefail

VERSION="0.1.6"
IMAGE="ghcr.io/superkirbo64/distop"
INSTANCE_NAME="Mi comunidad Distop"
PUBLIC_URL=""
DIRECTORY_URL=""
INSTALL_TAILSCALE=true

usage() {
  cat <<'EOF'
Uso: sudo bash install-vps.sh [opciones]
  --version VERSION       Etiqueta de la imagen (por defecto 0.1.6)
  --image IMAGEN          Imagen OCI alternativa
  --name NOMBRE           Nombre inicial de la instancia
  --public-url HTTPS_URL  URL estable si ya tienes proxy/dominio
  --directory-url URL     Directorio global de Explorar
  --no-tailscale          No instalar Tailscale
  --help                  Mostrar esta ayuda
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --image) IMAGE="${2:-}"; shift 2 ;;
    --name) INSTANCE_NAME="${2:-}"; shift 2 ;;
    --public-url) PUBLIC_URL="${2:-}"; shift 2 ;;
    --directory-url) DIRECTORY_URL="${2:-}"; shift 2 ;;
    --no-tailscale) INSTALL_TAILSCALE=false; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Opción desconocida: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ "${EUID:-$(id -u)}" -eq 0 ] || { echo "Ejecuta este script con sudo." >&2; exit 1; }
[ -r /etc/os-release ] || { echo "No se pudo identificar el sistema." >&2; exit 1; }
# /etc/os-release define VERSION, NAME e ID. Sourcearlo aquí dentro pisaba la
# VERSION de Distop con la del sistema —"24.04.3 LTS (Noble Numbat)", con
# espacios y paréntesis— y la validación de tres líneas más abajo la rechazaba:
# el instalador moría con «VERSION no válida» en TODA máquina Ubuntu o Debian.
# Se leen en un subshell los dos únicos campos que hacen falta, para que un
# fichero que no controlamos no pueda volver a pisar nada nuestro.
OS_ID=$(. /etc/os-release && printf '%s' "${ID:-}")
OS_CODENAME=$(. /etc/os-release && printf '%s' "${VERSION_CODENAME:-}")
case "$OS_ID" in ubuntu|debian) ;; *) echo "Solo se admiten Ubuntu y Debian." >&2; exit 1 ;; esac
case "$(dpkg --print-architecture)" in amd64|arm64) ;; *) echo "Solo se admiten amd64 y arm64." >&2; exit 1 ;; esac
case "$VERSION" in *[!A-Za-z0-9._-]*|'') echo "VERSION no válida." >&2; exit 2 ;; esac
case "$IMAGE" in *[!a-z0-9./:_-]*|'') echo "IMAGEN no válida." >&2; exit 2 ;; esac
if [ -z "$INSTANCE_NAME" ] || [[ "$INSTANCE_NAME" == *$'\n'* ]] || [[ "$INSTANCE_NAME" == *=* ]]; then
  echo "NOMBRE no válido." >&2
  exit 2
fi
if [ -n "$PUBLIC_URL" ]; then case "$PUBLIC_URL" in https://*) ;; *) echo "PUBLIC_URL debe comenzar por https://" >&2; exit 2 ;; esac; fi
if [ -n "$DIRECTORY_URL" ]; then case "$DIRECTORY_URL" in https://*) ;; *) echo "DIRECTORY_URL debe comenzar por https://" >&2; exit 2 ;; esac; fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl openssl
if ! command -v docker >/dev/null 2>&1; then apt-get install -y docker.io; fi
systemctl enable --now docker

if $INSTALL_TAILSCALE && [ ! -x /usr/bin/tailscale ]; then
  CODENAME="$OS_CODENAME"
  [ -n "$CODENAME" ] || { echo "La versión no expone VERSION_CODENAME; usa --no-tailscale." >&2; exit 1; }
  install -d -m 0755 /usr/share/keyrings
  curl --fail --silent --show-error --location \
    "https://pkgs.tailscale.com/stable/${OS_ID}/${CODENAME}.noarmor.gpg" \
    --output /usr/share/keyrings/tailscale-archive-keyring.gpg
  curl --fail --silent --show-error --location \
    "https://pkgs.tailscale.com/stable/${OS_ID}/${CODENAME}.tailscale-keyring.list" \
    --output /etc/apt/sources.list.d/tailscale.list
  apt-get update
  apt-get install -y tailscale
fi

install -d -m 0750 /etc/distop
# /etc/distop se queda de root: el fichero de entorno lo lee el cliente de
# Docker en el host, antes de arrancar nada, y el contenedor nunca lo abre.
#
# /var/lib/distop NO puede quedarse de root. Se monta como /data y la imagen
# corre con USER node —uid 1000, sin privilegios (§22)—, y en un montaje de este
# tipo manda el dueño del host, no el chown que hizo el Dockerfile. Con root:root
# 0750, SQLite no podía ni crear app.db: «unable to open database file», reinicio
# en bucle, y una instalación de VPS que nunca llegó a levantar.
#
# Va el número y no el nombre a propósito: `node` es un usuario de la imagen,
# no del host, así que aquí no existe y `chown node` fallaría.
install -d -m 0750 -o 1000 -g 1000 /var/lib/distop
ENV_FILE=/etc/distop/distop.env

get_env() {
  [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 || true
}

upsert_env() {
  key="$1"
  value="$2"
  temporary="$(mktemp /etc/distop/distop.env.XXXXXX)"
  if [ -f "$ENV_FILE" ]; then grep -v "^${key}=" "$ENV_FILE" > "$temporary" || true; fi
  printf '%s=%s\n' "$key" "$value" >> "$temporary"
  install -m 0600 "$temporary" "$ENV_FILE"
  rm -f "$temporary"
}

AUTH_SECRET="$(get_env AUTH_SECRET)"
SETUP_CODE="$(get_env SETUP_CODE)"
[ -n "$AUTH_SECRET" ] || AUTH_SECRET="$(openssl rand -hex 32)"
[ -n "$SETUP_CODE" ] || SETUP_CODE="$(openssl rand -hex 4 | tr '[:lower:]' '[:upper:]')"

upsert_env AUTH_SECRET "$AUTH_SECRET"
upsert_env SETUP_CODE "$SETUP_CODE"
upsert_env PORT "5000"
upsert_env INSTANCE_NAME "$INSTANCE_NAME"
upsert_env DATABASE_PATH "/data/app.db"
upsert_env DEFAULT_STORAGE_PATH "/data/uploads"
upsert_env REGISTRATION_ENABLED "true"
upsert_env GUEST_MODE_ENABLED "true"
upsert_env TRUST_PROXY "true"
upsert_env NODE_ENV "production"
if [ -n "$PUBLIC_URL" ]; then upsert_env PUBLIC_URL "${PUBLIC_URL%/}"; fi
if [ -n "$DIRECTORY_URL" ]; then upsert_env DIRECTORY_URL "${DIRECTORY_URL%/}"; fi

cat > /etc/systemd/system/distop.service <<EOF
[Unit]
Description=Distop community server
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
Restart=always
RestartSec=5
TimeoutStopSec=45
ExecStartPre=-/usr/bin/docker rm -f distop
ExecStartPre=/usr/bin/docker pull ${IMAGE}:${VERSION}
ExecStart=/usr/bin/docker run --name distop --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop=ALL --security-opt=no-new-privileges --env-file=${ENV_FILE} --publish=127.0.0.1:5000:5000 --volume=/var/lib/distop:/data ${IMAGE}:${VERSION}
ExecStop=/usr/bin/docker stop --time=30 distop
ExecStopPost=-/usr/bin/docker rm -f distop

[Install]
WantedBy=multi-user.target
EOF

cat > /usr/local/sbin/distop-set-public-url <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
[ "${EUID:-$(id -u)}" -eq 0 ] || { echo "Ejecuta con sudo." >&2; exit 1; }
case "${1:-}" in https://*) ;; *) echo "Uso: sudo distop-set-public-url https://tu-url" >&2; exit 2 ;; esac
ENV_FILE=/etc/distop/distop.env
temporary="$(mktemp /etc/distop/distop.env.XXXXXX)"
grep -v '^PUBLIC_URL=' "$ENV_FILE" > "$temporary" || true
printf 'PUBLIC_URL=%s\n' "${1%/}" >> "$temporary"
install -m 0600 "$temporary" "$ENV_FILE"
rm -f "$temporary"
systemctl restart distop
echo "PUBLIC_URL guardada. Distop se reinició."
EOF
chmod 0755 /usr/local/sbin/distop-set-public-url

systemctl daemon-reload
systemctl enable --now distop

healthy=false
for _attempt in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:5000/health >/dev/null; then healthy=true; break; fi
  sleep 1
done
$healthy || { journalctl -u distop --no-pager -n 80 >&2; exit 1; }

echo
echo "Distop ${VERSION} está funcionando y sus datos viven en /var/lib/distop."
echo "Código para reclamar la instancia: ${SETUP_CODE}"
if $INSTALL_TAILSCALE; then
  echo
  echo "Falta autorizar tu cuenta de Tailscale (requiere tu navegador):"
  echo "  1. sudo tailscale up"
  echo "  2. abre el enlace que aparece e inicia sesión"
  echo "  3. sudo tailscale funnel --bg --yes 5000"
  echo "  4. sudo distop-set-public-url https://URL-QUE-MUESTRE-TAILSCALE"
fi
echo "Estado: sudo systemctl status distop"
echo "Logs:   sudo journalctl -u distop -f"
