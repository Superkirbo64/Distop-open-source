# N1 — siempre activo

Oracle está descartado y no forma parte del producto. La meta vigente es poder
mover la misma instancia a hardware propio o a cualquier alojamiento de
contenedores con disco persistente, sin convertir a Distop en una plataforma
central obligatoria.

## Cerrado localmente para v0.1.3

- [x] Imagen OCI multi-arquitectura `amd64` + `arm64` en GHCR.
- [x] Voz P2P con fallback por par al servidor; cámara y pantalla P2P.
- [x] Escalera de publicación con coste y diferencia entre URL temporal/fija.
- [x] Instalador Ubuntu/Debian, servicio systemd, volumen `/data` y contenedor
      sin privilegios, solo expuesto por localhost.
- [x] Checksum SHA-256 generado y comprobado en cada release.
- [x] Tailscale instalado desde repositorio firmado y pasos de autorización
      mostrados al final.
- [x] Guía de Raspberry Pi y configuración Railway.
- [x] Expediente de candidatura para el catálogo PikaPods.
- [x] Asistente dentro de Compartir: hardware propio, VPS o servicio gestionado.

## Validación externa pendiente

- [ ] Ejecutar el instalador en Ubuntu limpio y completar Funnel con una cuenta
      real de Tailscale.
- [ ] Probar una VPS de Serverspace y anotar coste, región y latencia reales.
- [ ] En Northflank, montar `/data`, forzar redeploy y verificar persistencia.
- [ ] Crear la plantilla pública de Railway solo después de la misma prueba.
- [ ] Proponer Distop a PikaPods cuando la imagen `0.1.3` esté publicada.

Estas tareas requieren cuentas, aceptación de condiciones y, en algunos casos,
un método de pago. El repositorio no puede hacerlas en nombre del usuario.

## Criterio duro

No se llama «gratis» a un crédito temporal ni «persistente» a un filesystem
efímero. Una opción solo entra en la aplicación cuando sobrevive a reinicio y
redeploy con la misma identidad, base SQLite y archivos.
