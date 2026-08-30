# Plantillas de alojamiento

La pieza común es `ghcr.io/superkirbo64/distop:0.1.3`, con un puerto HTTP
interno `5000` y un volumen persistente montado en `/data`. Una plataforma no
es apta si no puede conservar ese volumen después de recrear el contenedor.

Variables mínimas:

```text
PORT=5000
AUTH_SECRET=<64 caracteres hex aleatorios>
SETUP_CODE=<código aleatorio para el primer dueño>
DATABASE_PATH=/data/app.db
DEFAULT_STORAGE_PATH=/data/uploads
TRUST_PROXY=true
NODE_ENV=production
```

## Railway

`railway.toml` fija el Dockerfile, `/health`, una réplica y reinicio permanente.
Al convertirlo en plantilla pública hay que:

1. generar `AUTH_SECRET` y `SETUP_CODE` como variables secretas;
2. montar un volumen en `/data`;
3. exponer el puerto `5000` con el dominio HTTPS de Railway;
4. copiar ese dominio a `PUBLIC_URL`;
5. reiniciar y comprobar que los datos sobreviven a un redeploy.

Railway ofrece prueba, pero una instancia permanente no es gratuita. No se
publicará el botón hasta ejecutar esa prueba de persistencia con una cuenta real.

## Northflank

El Sandbox permite servicios siempre activos, pero la documentación lo presenta
para pruebas, exige método de pago y factura los volúmenes persistentes aparte.
La prueba pendiente debe desplegar la imagen, montar `/data`, crear una comunidad,
forzar un redeploy y comprobar que sigue allí. Hasta entonces no se promete como
alojamiento gratuito ni se mantiene una plantilla sin validar.

## PikaPods

El expediente listo para proponer Distop al catálogo está en
`deploy/pikapods-submission.md`. La admisión la decide PikaPods y requiere que la
imagen de una release estable ya sea pública.
