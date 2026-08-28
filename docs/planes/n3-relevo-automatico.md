# N3 — relevo automático (híbrido local↔online)

Objetivo: si cae uno, el otro continúa; cuando el local vuelve, recupera el
trabajo. El relevo manual ya existe y está cerrado (C2/C3 en
`docs/plan-continuidad.md`); esta fase construye lo que falta para que sea
casi automático, sin mentir sobre lo que "automático" puede significar.

**Regla dura de coste:** el par local↔nube usa la misma VM Always Free y el
mismo bucket de `n1-siempre-activo.md`; ningún relevo puede depender de un
tercer servicio de pago.

## Primitivas que YA existen (no reconstruir)

- Rol `PRIMARY | STANDBY | SUPERSEDED` (identity.ts) y los estados de
  handover de C2.
- Certificados de sucesión con `allowed_origins` pre-autorizados y handover
  "unplanned" con confirmación reforzada (succession-api.ts).
- Orígenes firmados alternativos (máximo 3) y `adopt.ts`.
- Época monotónica que **previene split-brain**: dos primarios no pueden
  coexistir en la cadena (EPOCH_NOT_NEXT / INSTANCE_ALREADY_SUPERSEDED).

## Lo que NO existe (el trabajo real)

**Replicación continua entre instancias del mismo linaje.** Hoy solo hay
bundle de handover puntual: el sucesor se sincroniza una vez, en el corte.

## Fase N3a — standby que sincroniza

- [ ] Standby en la VM que baja del bucket la copia cifrada más reciente y la
      mantiene lista para restaurar
- [ ] Health-watch mutuo entre los dos pares del linaje
- [ ] La frescura del standby es visible: "última copia sincronizada hace X"

## Fase N3b — relevo de emergencia semiautomático

- [ ] Certificado pre-emitido con ventana corta de validez
- [ ] Activado por el humano tras el aviso (el Web Push de A2 ya existe),
      **nunca por un temporizador solo**
- [ ] Confirmación reforzada y auditada, como el handover unplanned actual

## Fase N3c — vuelta a casa

- [ ] El PC local se re-inscribe como sucesor y recupera el linaje — el
      mecanismo de relevo ya es bidireccional por diseño
- [ ] Lo escrito en la nube durante la ausencia vuelve en la copia

## Fase N3d — reparto de trabajo en caliente

Diseño abierto. Exige un protocolo nuevo entre pares del linaje.

- [ ] Diseño: voz por el host con menor latencia mientras la VM retiene chat
      y estado
- [ ] No prometer ni empezar hasta tener N3a–N3c cerradas

## Lo que esto no puede hacer

- **La reclamación imprevista de Oracle no se puede firmar post-mortem**: si
  la VM desaparece sin aviso, no hay certificado de despedida. La red de
  seguridad de N3a es la copia, no el certificado.
- "Automático" nunca significa "sin humano": la activación de emergencia la
  confirma una persona; un temporizador solo produciría split-brain justo
  cuando la red se parte en dos.
- Entre copia y copia se pierde lo no replicado: la ventana de pérdida es el
  intervalo del planificador, y la interfaz lo dice.
- No hay exclusión mutua verdadera entre pares (plan-continuidad, §29.3):
  dos escrituras divergentes no se fusionan.

## Criterios de aceptación

- Simulacro completo probado: el local cae → aviso → el humano confirma → la
  VM pasa a PRIMARY con la época siguiente → el local vuelve → se re-inscribe
  y recupera el linaje. Con pruebas negativas: activación fuera de ventana,
  certificado caducado, época repetida.
- El standby nunca acepta escrituras antes de activarse.
- La frescura de la réplica es visible en la interfaz de los dos lados.
- N3d no tiene ni una línea de código antes de que N3a–N3c estén verdes.
