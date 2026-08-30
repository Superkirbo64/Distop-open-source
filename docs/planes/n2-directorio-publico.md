# N2 — directorio público

El directorio es una redirección verificable hacia instancias independientes.
No guarda mensajes, archivos, sesiones, voz ni vídeo; si cae, solo deja de
funcionar Explorar. Las invitaciones y las comunidades siguen vivas.

## Cerrado localmente para v0.1.3

- [x] `visibility` (`private`, `unlisted`, `public`) separado de `join_policy`
      (`open`, `invite`, `request`), migrando lo público anterior a invitación.
- [x] Entrar directamente, solicitar acceso y aprobar/rechazar solicitudes.
- [x] Servicio `apps/directory` en Deno con almacenamiento desacoplado de KV.
- [x] Ficha ES256, lease diaria y sucesión de identidad con cadena firmada.
- [x] Verificación del origen y fingerprint antes de entrar.
- [x] Guardas SSRF, límites, reportes, blocklist y moderación auditable.
- [x] Segunda fuente global en Explorar; un fallo no tumba la fuente local.
- [x] Una escritura KV por instancia y día; desafíos HMAC sin estado.

Con 10.000 instancias y una renovación diaria: unas 300.000 escrituras y
600.000 requests al mes. El plan gratuito vigente de Deno anuncia 500.000
unidades de escritura y un millón de requests; se debe vigilar CPU, tamaño de
las fichas, lecturas y reportes además de ese cálculo base.

## Pendiente externo

- [ ] Crear la aplicación y KV en `console.deno.com`.
- [ ] Definir `DIRECTORY_CHALLENGE_SECRET` y `DIRECTORY_ADMIN_TOKEN`.
- [ ] Publicar y copiar la URL HTTPS a `DIRECTORY_URL` de las instancias.
- [ ] Smoke con dos orígenes públicos reales y un relevo A→B.
- [ ] Establecer política de moderación y responsable de reportes.

Crear esa aplicación requiere iniciar sesión en la cuenta del propietario. La
implementación y sus pruebas locales no necesitan esas credenciales.
