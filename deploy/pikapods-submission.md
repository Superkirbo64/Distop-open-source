# Ficha de candidatura para PikaPods

- Proyecto: Distop
- Repositorio: https://github.com/Superkirbo64/Distop-open-source
- Licencia: AGPL-3.0-only
- Imagen oficial: `ghcr.io/superkirbo64/distop:0.1.3`
- Arquitecturas: `linux/amd64`, `linux/arm64`
- Puerto HTTPS externo: uno; el contenedor escucha HTTP en `5000`
- Healthcheck: `GET /health`
- Volumen: `/data` (SQLite, identidad y archivos subidos)
- CPU inicial sugerida: 0,25 vCPU
- Memoria inicial sugerida: 512 MB
- Disco inicial sugerido: 5 GB

Variables que debe crear el catálogo:

- `PORT=5000`
- `AUTH_SECRET`: 32 bytes aleatorios en hexadecimal, oculto
- `SETUP_CODE`: 8 caracteres aleatorios; se muestra una vez al usuario
- `DATABASE_PATH=/data/app.db`
- `DEFAULT_STORAGE_PATH=/data/uploads`
- `TRUST_PROXY=true`
- `NODE_ENV=production`
- `PUBLIC_URL`: dominio HTTPS asignado al pod
- `DIRECTORY_URL`: opcional; URL del directorio público de Distop

Prueba de admisión propuesta:

1. arrancar el pod y obtener `200` en `/health`;
2. reclamarlo con `SETUP_CODE` y guardar la frase de copia;
3. crear una comunidad, texto y archivo pequeño;
4. recrear/actualizar el contenedor;
5. comprobar identidad, comunidad, texto y archivo;
6. probar WebSocket y dos participantes con voz P2P;
7. descargar los datos por SFTP y restaurarlos fuera de PikaPods.

La voz, cámara y pantalla son P2P cuando los participantes pueden conectarse
directamente; el servidor solo actúa como fallback de voz para salas que
superan el umbral o pares sin ruta directa. Distop no codifica vídeo en el pod.
