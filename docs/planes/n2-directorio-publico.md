# N2 — directorio público ("el servidor mío")

Un directorio global de instancias que tú mantienes para construir comunidad.
**Opt-in siempre, plataforma obligatoria jamás**: una instancia que no se
registra no pierde nada salvo findabilidad (`docs/plan-continuidad.md` deja
"plataforma central obligatoria" explícitamente fuera de alcance). En la
instancia viene apagado de fábrica (`PUBLIC_DISCOVERY_ENABLED`, default
false).

**Regla dura de coste:** capa gratuita de Cloudflare — Workers 100.000
peticiones/día; D1 5 millones de lecturas y 100.000 escrituras/día, base
≤ 500 MB. Con escritura-solo-en-transiciones esto escala a decenas de miles
de instancias sin pagar. Si el uso real desborda la capa gratuita, se
replantea el diseño, no se contrata nada.

Depende de N1 cerrada: el seam `DirectorySource` del cliente y el gating de
descubrimiento nacen ahí.

## Fase N2a — workspace `apps/central-api/`

Cloudflare Workers + D1 + 1 Durable Object por shard (claude.md §16.2 y §17).

- [ ] Workspace nuevo `apps/central-api/` con wrangler.toml y TS estricto (§30)
- [ ] Esquema D1 copiado de `docs/nube-oracle.md` — instances,
      succession_edges, reports, moderation_actions — se copia, no se rediseña
- [ ] Durable Object por shard que retiene `lastSeen`; D1 solo se escribe en
      transiciones online↔offline
- [ ] Migraciones y tests del worker en CI, sin secretos

## Fase N2b — endpoints

- [ ] `POST /v1/instances/register` — challenge → la instancia firma con su
      ES256; perfil RFC 9421 fijado en `docs/nube-oracle.md`
- [ ] `POST /v1/instances/heartbeat` — cada 15 minutos; escritura en D1 solo
      si cambia el estado
- [ ] `POST /v1/instances/unpublish` — darse de baja es un derecho, no una
      negociación
- [ ] `GET /v1/explore` — filtros por idioma y etiquetas
- [ ] `GET /v1/instances/{id}`
- [ ] `POST /v1/reports`

## Fase N2c — verificación de relevo

La ventaja que Matrix y el fediverso no tienen: una ficha sobrevive a un
cambio de máquina.

- [ ] Seguir `moved_to` + `GET /api/v1/succession/chain` (anónimo, ya
      implementado) y verificar la cadena antes de actualizar la ficha
- [ ] Época menor o linaje distinto → se rechaza; la ficha no se pisa

## Fase N2d — dos carriles y moderación

Lección de Matrix (febrero de 2025: congelaron su directorio abierto por
amplificar abuso): abierto sin revisión amplifica; revisado sin carril
abierto muere.

- [ ] Carril público: autopublicación verificada, sin portada
- [ ] Carril destacado: revisión humana antes de aparecer
- [ ] Blocklist separada de los datos declarados por la instancia
- [ ] `moderation_actions` auditables

## Fase N2e — guardas

- [ ] SSRF (las del doc): resolver DNS antes de conectar; bloquear RFC1918,
      link-local y metadata; límites de redirecciones, tamaño y tiempo
- [ ] Rate limits por origen + IP + fingerprint

## Fase N2f — lado instancia

- [ ] Módulo pequeño en node-server: registro voluntario + latido firmado
- [ ] Gated por `PUBLIC_DISCOVERY_ENABLED`; apagado de fábrica

## Fase N2g — lado cliente

- [ ] Segunda `DirectorySource` en `lib/directory.ts` (el seam de N1 ya lo
      deja listo); una fuente muerta no mata la lista

## Lo que esto no puede hacer

- No es una plataforma central: no guarda mensajes, miembros ni credenciales;
  solo los metadatos que la instancia decidió publicar.
- No puede obligar a nadie: no registrarse o darse de baja nunca degrada la
  instancia, solo su findabilidad.
- No verifica el contenido de una comunidad, solo su identidad criptográfica
  y su disponibilidad; el carril público puede listar comunidades que no te
  gusten — para eso están los reports y la blocklist.
- Bloquear una ficha no apaga la instancia: el directorio quita findabilidad,
  no controla físicamente nodos ajenos (claude.md §23).
- No sobrevive por sí solo a un cambio de límites de Cloudflare: si la capa
  gratuita cambia, el directorio degrada o se replantea; las instancias
  siguen funcionando exactamente igual.

## Criterios de aceptación

- Una instancia con `PUBLIC_DISCOVERY_ENABLED=true` se registra, late y
  aparece en Explorar; al apagar el flag desaparece en el siguiente latido.
- Un relevo real A→B conserva la ficha con la URL nueva, verificado por
  cadena, sin intervención manual.
- Un register con firma inválida, un latido fuera de ventana y una URL
  interna (RFC1918 o metadata) se rechazan con error tipado, con test cada
  uno.
- El consumo diario proyectado con 10.000 instancias cabe en la capa gratuita
  y el cálculo está escrito en el README del workspace.
- Una instancia sin registrar no nota ninguna diferencia funcional.
