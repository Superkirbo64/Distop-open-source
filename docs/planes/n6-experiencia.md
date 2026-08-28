# N6 — experiencia (que lo use una persona común)

Nada de lo anterior vale si solo lo puede operar quien lo programó. Regla del
proyecto: una fase no está hecha si solo se puede usar por API — y tampoco si
solo la entiende quien sabe qué es un túnel.

**Regla dura de coste:** ningún carril recomendado por la interfaz puede
terminar en "compra esto" o "contrata aquello" — también en los textos.

## Fase N6a — asistente "Publicar mi comunidad"

- [ ] Tres carriles sin jerga: "desde tu PC con Cloudflare" · "desde tu PC
      con Tailscale" · "siempre disponible (nube, coste cero)"
- [ ] `detectLane()` elige el carril que ya está en uso y no ofrece lo que no
      aplica
- [ ] Cada carril dice su contrapartida ANTES de empezar (tu PC apagado =
      comunidad offline; la nube = confiar en Oracle), no después

## Fase N6b — botón Deploy to Oracle Cloud

- [ ] Solo cuando exista el zip versionado con checksum de una release (el
      `ORACLE_STACK_URL` de N1 deja de ser `null`); jamás apuntar a main
- [ ] El botón lleva al stack de ESA release, con el manual al lado

## Fase N6c — claim guiado con SETUP_CODE

- [ ] El primer claim de la instancia recién desplegada se guía paso a paso:
      dónde sale el código (`docker compose logs`), dónde se pega, qué probar
- [ ] Un claim fallido explica el porqué, no dice solo "error"

## Fase N6d — estados honestos (§26)

- [ ] También para el directorio: activado / desactivado / registrado / sin
      latido desde X
- [ ] También para el relevo: "tu comunidad vive en X; si X cae, pasa Y" —
      con la frescura de la réplica visible
- [ ] Ningún fallo escondido tras un mensaje genérico

## Fase N6e — tres idiomas

- [ ] Todo texto nuevo en es, en y pt-BR desde el primer commit de cada
      feature (el tipado de `MessageKey` lo fuerza en build)

## Lo que esto no puede hacer

- No elimina las decisiones: la persona sigue eligiendo dónde vive su
  comunidad; el asistente explica, no decide por ella.
- No abstrae lo que Oracle exige de verdad: crear la cuenta OCI (con su
  verificación) es de Oracle y no se puede saltar desde nuestra interfaz; se
  acompaña, no se finge.
- Un estado honesto no arregla el fallo: decir "sin latido desde ayer" es
  informar; recuperar la instancia sigue siendo trabajo del anfitrión.

## Criterios de aceptación

- Una persona sin conocimientos técnicos publica su comunidad por cualquiera
  de los tres carriles siguiendo solo la interfaz (el criterio del §37 de
  claude.md, extendido a la nube).
- Cada estado del §26 que aplique al directorio y al relevo tiene su texto en
  los tres idiomas.
- El botón de deploy no existe en la interfaz mientras `ORACLE_STACK_URL` sea
  `null`; cuando existe, apunta a una release concreta con checksum.
