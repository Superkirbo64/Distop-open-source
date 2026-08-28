# N1 — siempre activo (Distop en Oracle Cloud Always Free)

Objetivo: una comunidad Distop **siempre online a coste cero**, con voz por la
instancia, vídeo y pantalla P2P, TURN propio y copias fuera de la VM. El
diseño completo vive en `docs/nube-oracle.md`; este fichero solo rastrea sus
commits. El PC en casa sigue siendo el modo por defecto: la nube es un tercer
modo opcional, mismo dueño, coste cero.

**Regla dura de coste:** todo dentro de Oracle Always Free (A1 con 2 OCPU y
12 GB totales, 10 TB de egress, 20 GB de Object Storage combinados, IP
reservada a $0). Ningún paso puede exigir pago más allá de la verificación de
la cuenta, que es de Oracle.

## Fase N1 — secuencia de commits

Espejo de la secuencia aprobada. Cada casilla se marca **al cerrar su commit**,
nunca antes ni a mitad.

- [x] 1. `docs: nube-oracle corregido contra el código, decisión registrada y hoja de ruta N en docs/planes`
      Corrige las tres premisas falsas de `docs/nube-oracle.md` (imagen Docker
      inexistente, copia sin mecanismo, NodeInfo que hoy devuelve index.html),
      añade "Lo que 'remoto' cambia en la instancia", la entrada en
      `docs/decisions.md` y el teaser del README. Esta carpeta nace aquí.
- [ ] 2. `feat(server): versión desde package.json, nodeinfo 2.1 y turn efímero`
      `VERSION` deja de estar horneada a "0.1.0"; NodeInfo 2.1 gated por
      `PUBLIC_DISCOVERY_ENABLED` con `/.well-known/*` fuera del fallback SPA;
      credenciales TURN efímeras (use-auth-secret) como campo `secret` del modo custom.
- [ ] 3. `feat(server): copias programadas que sobreviven al proxy`
      Planificador interno con cortesía hacia llamadas activas, passphrase en
      fichero 0600 que mata el boot si falta o es débil, poda conservando K, y
      el GET de copias relajado a requireHost-only. Restore sigue siendo CLI.
- [ ] 4. `feat(web): explorar, carril nube, estado de copias y turn efímero en la interfaz`
      Sub-selector TURN en Ajustes, estado de copias en el panel de instancia,
      tercer carril "Siempre disponible (nube, coste cero)" en Compartir, y el
      modal Explorar con estados honestos. i18n en los tres idiomas.
- [ ] 5. `infra: stack terraform para oracle always free`
      `infrastructure/oracle/` completo (VM A1, IP reservada única, bucket,
      cloud-init sin secretos en user_data, coturn, timer de subida de copias)
      más el workflow `infra.yml` sin credenciales en CI.
- [ ] 6. `ci: imagen multi-arch y zip del stack en cada release`
      release.yml gana los jobs `docker` (ghcr arm64+amd64, tags semver) y
      `oci-stack` (zip con `main.tf` en raíz + sha256). Solo entonces
      `ORACLE_STACK_URL` deja de ser `null` en el cliente.

## Contratos fijados (no renegociar al implementar)

- `TURN_URL` + `TURN_SECRET`: cloud-init genera el secreto; config.ts muere si
  va uno sin el otro.
- `GET /api/v1/instance/backups` pasa a requireHost-only con `schedule` y
  `manual_available`; el POST y restore/inspect siguen siendo solo locales.
- `relayState()` gana `ephemeral: boolean`, nunca `secret`.
- `ORACLE_STACK_URL` permanece `null` hasta el commit 6.

## Lo que esto no puede hacer

(§29.3 — y la interfaz lo dice donde toca.)

- Sin SLA: Oracle puede reclamar la VM por inactividad (CPU y red y memoria
  por debajo del 20 % durante 7 días, las tres condiciones en Y) o por cambio
  de política.
- En la VM nada es "local": copia por HTTP, restore/inspect y la sucesión
  desde la web no funcionan tras el proxy; sus caminos son CLI por SSH. Es
  diseño, no bug.
- El restore exige parar la instancia; no hay restauración en caliente.
- La copia no lleva `voice_relay` ni `public.fixed` (redactados): tras
  restaurar hay que reconfigurarlos a mano.
- Hasta el commit 2, la credencial TURN estática es extraíble por cualquier
  cliente que pida `/api/v1/info`.
- v1 compila desde código en la VM (10–20 minutos); la imagen GHCR llega en el
  commit 6.
- Sigue siendo self-hosting: la copia fuera de OCI es responsabilidad de quien
  hospeda.

## Criterios de aceptación

- `npm run typecheck` y `npm test` completos en verde en cada commit; pruebas
  nuevas: `nodeinfo.test.ts`, `ice.test.ts` (vector HMAC pineado),
  `backup-scheduler.test.ts`, `lib/publish.test.ts`, `lib/directory.test.ts`,
  `lib/backups.test.ts`; `vite build` de apps/web pasa (la completitud de los
  tres locales la fuerza el tipado).
- `infra.yml`: fmt, validate, shellcheck, render de cloud-init y dry-run del
  zip — todo sin credenciales OCI en CI.
- Smoke local sin Oracle: NodeInfo devuelve JSON con la SPA intacta en las
  demás rutas, dos `/info` consecutivos dan credenciales efímeras con ≥24 h,
  el planificador crea una copia real, la inspecciona con la passphrase del
  fichero y poda, y la interfaz enseña los cuatro frentes.
- Smoke real en tenancy Free Tier nueva: apply sin recursos facturables,
  `/health` por Caddy tras reboot, candidato relay TURN desde red móvil,
  copia subida a `backups/` (no `incoming/`) y podada, y recuperación fría
  con la identidad conservada.
