# Planes futuros — hoja de ruta N (nube y red)

Memoria persistente del proyecto: cualquier sesión futura arranca leyendo este
índice y el fichero de la fase en curso, no desde cero. **Nada se marca sin
prueba que lo respalde y sin `npm test` y `npm run typecheck` en verde** — la
misma regla que `docs/plan-continuidad.md`.

El prefijo de fase es **N** (nube/red); C, A y V ya están usados y cerrados en
`docs/plan-continuidad.md`.

**Regla dura de coste:** ni quien hospeda ni quien participa paga nada. Ningún
camino recomendado puede terminar en "compra esto" o "contrata aquello".
Oracle Cloud Always Free y la capa gratuita de Cloudflare entran porque cubren
el uso real; el día que dejen de cubrirlo, la fase se replantea, no se paga.

## Estado global

| # | Fase | Qué entrega sola | Estado |
|---|---|---|---|
| 1 | `n1-siempre-activo.md` | Comunidad siempre online a coste cero en Oracle | 🔨 en curso |
| 2 | `n2-directorio-publico.md` | Directorio global opt-in ("el servidor mío") | ⬜ futuro |
| 3 | `n3-relevo-automatico.md` | Híbrido local↔nube con relevo en ambos sentidos | ⬜ futuro |
| 4 | `n4-nodos-certificados.md` | Reparto de servidor entre miembros certificados | ⬜ futuro |
| 5 | `n5-seguridad.md` | Modelo de amenazas transversal de N1–N4 y N6 | ⬜ futuro |
| 6 | `n6-experiencia.md` | Todo lo anterior usable por una persona común | ⬜ futuro |

Leyenda: hecho ✅ · en curso 🔨 · futuro ⬜.

El orden no es negociable a ciegas: `n4-nodos-certificados.md` depende de
`n3-relevo-automatico.md` y `n5-seguridad.md`; `n2-directorio-publico.md` y
`n3-relevo-automatico.md` dependen de que `n1-siempre-activo.md` esté cerrada.
`n5-seguridad.md` y `n6-experiencia.md` son transversales: se avanzan por
trozos junto a la fase a la que protegen o pintan.

## Cómo se usa

1. Abre la fase en curso (la primera 🔨 de la tabla).
2. Haz el siguiente bloque sin marcar de su checklist.
3. Al cerrar un bloque real (con pruebas en verde), marca su casilla en el
   fichero de fase y, si la fase queda completa, cambia su estado aquí.
4. Un commit por bloque cerrado, nunca a mitad.

## Lo que esto no puede hacer

- Una casilla marcada no es una prueba: la prueba son los tests y el commit
  que la cerró. Si dudas, cree al código, no al checklist.
- Este índice no sustituye a los documentos de diseño (`docs/nube-oracle.md`,
  `docs/plan-continuidad.md`, `docs/decisions.md`); solo dice dónde estás.
- No detecta desvíos: si una implementación se apartó del plan y nadie lo
  anotó aquí, aquí no se ve.

## Criterios de aceptación

- Cada fase N tiene su fichero, con checkboxes, "Lo que esto no puede hacer"
  y "Criterios de aceptación" propios.
- El estado de esta tabla coincide con las casillas de cada fichero.
- Una sesión nueva puede decidir su siguiente tarea leyendo solo este README
  y el fichero de la fase en curso.
