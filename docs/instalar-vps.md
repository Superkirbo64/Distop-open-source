# Instalar Distop en una VPS

La release incluye un instalador para Ubuntu/Debian (`amd64` y `arm64`). No se
ejecuta directamente desde Internet: primero se descargan el archivo y su
checksum, se comprueba y solo entonces se usa `sudo`.

```sh
cd /tmp
curl -fLO https://github.com/Superkirbo64/Distop-open-source/releases/latest/download/install-vps.sh
curl -fLO https://github.com/Superkirbo64/Distop-open-source/releases/latest/download/install-vps.sh.sha256
sha256sum -c install-vps.sh.sha256
sudo bash install-vps.sh
```

El script instala Docker y Tailscale desde sus repositorios firmados, crea un
servicio `systemd`, fija la imagen de la release y guarda SQLite y los archivos
en `/var/lib/distop`. El contenedor solo escucha en `127.0.0.1`: no expone HTTP
sin cifrar a Internet.

Al terminar muestra el código de reclamación y cuatro pasos. El único paso que
no puede automatizar es que inicies sesión en tu propia cuenta de Tailscale:

```sh
sudo tailscale up
sudo tailscale funnel --bg --yes 5000
sudo distop-set-public-url https://nombre-de-tu-equipo.tu-red.ts.net
```

Abre esa URL, crea la cuenta dueña usando el código y guarda la frase de copia
de seguridad fuera de la VPS.

## Operación

```sh
sudo systemctl status distop
sudo journalctl -u distop -f
sudo systemctl restart distop
```

Los secretos están en `/etc/distop/distop.env` con permisos `0600`. Para una
copia en frío, detén Distop y copia `/var/lib/distop`; comprueba una restauración
antes de depender de ella.

## Actualizar

No se actualiza sola: la imagen queda anclada por digest y cambiar de versión
es una decisión tuya. Para pasar a la última release, repite los mismos cinco
comandos de arriba. Cada `install-vps.sh` publicado instala la versión de su
propia release, conserva los datos, `AUTH_SECRET` y `SETUP_CODE`, actualiza la
unidad y reinicia el contenedor.

Para fijar o volver a una versión concreta, añade `--version`:

```sh
sudo bash install-vps.sh --version 0.1.9
```
