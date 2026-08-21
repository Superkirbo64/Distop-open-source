#!/data/data/com.termux/files/usr/bin/bash
# Instancia Distop dentro de Termux (Android) — §5, §29.3.
#
# Android no deja que una app normal ejecute un servidor; Termux sí puede.
# Este script descarga el paquete de la instancia desde la última release de
# GitHub y la arranca en el teléfono. La app Distop del mismo teléfono la
# detecta sola en http://127.0.0.1:5000.
#
#   curl -sL https://github.com/Superkirbo64/Distop-open-source/releases/latest/download/termux-host.sh | bash
#
# Honestidad por delante: la comunidad vive mientras Termux siga abierto.
# Android mata procesos en segundo plano y esto gasta batería; para una
# comunidad seria, un PC encendido es mejor anfitrión.
set -e

REPO="Superkirbo64/Distop-open-source"
DIR="$HOME/distop"
DATA="$HOME/distop-data"

echo "— Preparando Node…"
pkg install -y nodejs curl unzip >/dev/null 2>&1 || pkg install -y nodejs curl unzip
# El túnel público: en Termux el binario oficial de Cloudflare no corre (bionic),
# pero el paquete de Termux sí. Con él, "Crear enlace público" funciona igual.
pkg install -y cloudflared >/dev/null 2>&1 || true

MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 24 ]; then
  echo "Distop necesita Node 24 o más nuevo y Termux trae la $MAJOR."
  echo "Actualiza los paquetes de Termux (pkg upgrade) y reintenta."
  exit 1
fi

echo "— Descargando la instancia…"
mkdir -p "$DIR"
cd "$DIR"
curl -sL "https://github.com/$REPO/releases/latest/download/distop-host-bundle.zip" -o bundle.zip
unzip -oq bundle.zip
rm bundle.zip

mkdir -p "$DATA"
export PORT=5000
export DATABASE_PATH="$DATA/app.db"
export DEFAULT_STORAGE_PATH="$DATA/uploads"

# Que Android no duerma el proceso mientras la instancia sirve a gente.
termux-wake-lock 2>/dev/null || true

IP=$(ip route get 1 2>/dev/null | awk '{print $7; exit}')
echo ""
echo "══════════════════════════════════════════════════════"
echo "  Instancia en marcha."
echo "  · En ESTE teléfono: abre la app Distop — la detecta sola."
[ -n "$IP" ] && echo "  · Desde tu Wi-Fi: http://$IP:5000"
echo "  · Tus datos: $DATA (haz copias de esa carpeta)"
echo "══════════════════════════════════════════════════════"
echo ""

cd "$DIR/node-server"
exec node server.ts
