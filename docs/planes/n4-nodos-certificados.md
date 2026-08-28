# N4 — nodos certificados (repartir el servidor entre miembros)

Repartir carga del servidor entre usuarios **certificados por quien hospeda**,
nunca cualquiera. Es la última fase de la hoja N, no la primera: depende de
la replicación de `n3-relevo-automatico.md` y de la revocación de
`n5-seguridad.md`.

**Regla dura de coste:** los nodos auxiliares son máquinas de miembros que se
ofrecen; nada de esta fase puede convertirse en "alquila un nodo".

## Fase N4a — certificado de nodo auxiliar

Extiende la familia de certificados firmados que ya existe
(`DISTOP_SUCCESSION_CERT` / `DISTOP_ORIGIN_SET`) con un tipo nuevo, firmado
por el host.

- [ ] El host firma QUÉ máquina de QUÉ miembro puede hacer QUÉ
- [ ] Permisos declarativos, mínimos y enumerados: relay TURN · standby de
      copias · almacén de adjuntos — nada más hasta que exista
- [ ] Expiración corta; renovar es barato, revivir un certificado muerto no
      existe
- [ ] Cada nodo genera su propia clave y el host la certifica — las claves de
      identidad no salen del host (el mismo principio que el relevo C2)

## Fase N4b — revocación

- [ ] Lista de revocación firmada por el host, consultable por cualquier
      cliente
- [ ] Revocar corta hacia adelante: ningún cliente nuevo usa un nodo
      revocado; la ventana hacia atrás la acota la expiración corta

## Fase N4c — regla dura de datos

- [ ] Un nodo auxiliar no confiable **jamás ve datos en claro**: relay
      cifrado o adjuntos cifrados; el nodo mueve bytes que no puede leer
- [ ] Probado con un nodo hostil de test que intenta leer lo que transporta

## Lo que esto no puede hacer

- No convierte a un miembro en anfitrión: el certificado delega tareas, no
  autoridad; la identidad y la moderación siguen en el host.
- No protege de un host malicioso: quien firma los certificados define el
  sistema — igual que hoy.
- Una revocación no llega a quien está offline: la ventana la acota la
  expiración corta, no la lista.
- Un nodo auxiliar caído degrada su tarea (relay, standby, adjuntos), no la
  comunidad: todo lo delegado tiene camino de vuelta al host.

## Criterios de aceptación

- Un miembro certificado presta relay TURN sin ver un byte en claro, y está
  probado.
- Un certificado caducado o revocado se rechaza en todos los caminos, con un
  test negativo por cada permiso declarado.
- Quitar todos los nodos auxiliares deja la comunidad funcionando igual que
  antes de N4.
