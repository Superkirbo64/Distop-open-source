# Distop siempre activo en Raspberry Pi

Sirve una Raspberry Pi 4/5 de 64 bits con Raspberry Pi OS basado en Debian y,
como mínimo práctico, 2 GB de RAM. Se recomienda un SSD USB; una microSD sometida
a SQLite, subidas y logs tiene más riesgo de desgaste.

1. Instala Raspberry Pi OS Lite de 64 bits, activa SSH y actualiza el sistema.
2. Descarga y verifica `install-vps.sh` como explica `docs/instalar-vps.md`.
3. Ejecútalo. La imagen de release incluye `linux/arm64`.
4. Autoriza Tailscale, activa Funnel y fija la URL con los comandos que muestra.
5. Reclama la instancia y guarda la frase de copia fuera de la Raspberry.

El servicio arranca solo después de un corte de luz. Para una copia adicional,
conecta otro disco o copia periódicamente `/var/lib/distop` a otro equipo; no
cuentes una copia que nunca hayas restaurado.

Si ya administras Docker Compose, también puedes usar el `docker-compose.yml`
del repositorio cambiando `build` por la imagen fija
`ghcr.io/superkirbo64/distop:0.1.6`. El instalador es el camino recomendado
porque además configura `systemd`, permisos y una exposición HTTPS segura.
