# Reuniones

Una sala de voz está siempre abierta. Una reunión **empieza y termina**, tiene
quien la organiza, quien espera fuera, quien pide la palabra, y al final dice
quién estuvo y cuánto.

## No es un tipo de sala nuevo

Una reunión es **un canal con `kind="meeting"`** más una fila en `meetings`.

Eso no es un detalle de implementación: significa que mensajes, adjuntos,
permisos, overwrites, búsqueda y fijados funcionan dentro de una reunión sin una
línea de código nueva, y que las salas de voz de siempre no cambian nada.

En la barra lateral viven en su propia sección. Una reunión empieza y termina;
un canal está siempre. Mezclarlas dejaría la lista de canales llena de reuniones
de la semana pasada.

## Convocar

Es un permiso propio, `MANAGE_MEETINGS`, y no `MANAGE_CHANNELS`: programar una
reunión y reordenar la barra lateral no son la misma responsabilidad, y en una
comunidad real convoca mucha más gente de la que toca la estructura.

```bash
POST /api/v1/communities/:id/meetings
     {"title":"Reunión del martes","agenda":"Repasar el plan","starts_at":1234567890000}
```

## El ciclo de vida

```text
DRAFT ──┐
        ├──▶ SCHEDULED ──▶ LOBBY ──▶ LIVE ──▶ ENDED
        └──────────────────────┴───────┴──▶ CANCELLED
```

`LOBBY` y `LIVE` son distintos a propósito. En `LOBBY` la gente puede llegar y
esperar, pero **nadie transmite nada**.

**Que llegue un invitado no abre la reunión.** La abre una persona con permiso
para hacerlo. Si bastara con llegar pronto, cualquiera podría empezar la reunión
de otro.

**Terminada es terminada.** Reabrir una reunión cerrada falsearía su asistencia
—dos tramos distintos contados como uno— y su duración. Se convoca otra.

Y una reunión que se queda vacía **termina sola**: si no, quedaría `LIVE` para
siempre porque el último cerró la pestaña, con su asistencia abierta
indefinidamente.

## La sala de espera, y por qué es segura

Con la sala de espera puesta, quien llega **no entra en el registro de voz**: se
queda en una lista aparte hasta que alguien le abre.

Eso no es una comprobación que el servidor hace y podría olvidarse de hacer. El
reenvío de audio y vídeo (`relayMedia`) manda a quien está en el registro, y
punto. Quien espera no está ahí, así que:

- no le llega ni un paquete de la reunión,
- y lo que él mande no llega a nadie.

**La propiedad es estructural, no una condición.** Está probada byte a byte en
`meetings.test.ts`, con el mismo aparato que ya prueba el relay de voz.

Quien modera nunca espera fuera. Si el anfitrión tuviera que esperar a que
alguien le abriese, una reunión con sala de espera no podría empezar nunca.

La lista de quién espera **solo la ve quien puede abrir**. Publicarla a la
reunión entera convertiría "esperar" en "que te miren esperar", y diría a todo
el mundo quién intentó entrar y no pudo. Por la misma razón, a quien se le
deniega la entrada no se le dice quién lo decidió: sería una lista de a quién
culpar dentro de su propia comunidad.

## Papeles

```text
host  >  cohost  >  presenter  >  attendee  >  viewer
```

Son **efímeros y de la reunión**, sin ninguna relación con los roles de la
comunidad: organizar una reunión no da poder sobre el servidor, y administrar el
servidor no convierte a nadie en organizador en silencio.

Nadie puede repartir un papel igual o superior al suyo, ni tocar a alguien de su
rango o por encima. Sin esa regla, un coanfitrión podría destituir al anfitrión y
quedarse con la reunión. Y no se le puede quitar el papel al último anfitrión:
quedaría una reunión que nadie puede cerrar ni abrir a nadie.

## Los dos ejes de autoridad

La jerarquía de la reunión gobierna lo ordinario. Pero la comunidad conserva
**poderes de seguridad**: quien administra puede terminar una reunión abusiva o
expulsar, aunque no la haya organizado.

Quitarle ese poder permitiría a cualquiera crear, dentro del servidor de otra
persona, una zona imposible de moderar. Dárselo entero convertiría a cada
administrador en organizador de todo.

El equilibrio es concreto: **puede cerrar, no puede apropiarse**. Su papel en la
reunión no cambia, y cada uso queda en la auditoría con su nombre — un poder de
seguridad invisible no es un poder de seguridad.

## Levantar la mano

La marca es una **hora**, no un sí/no. Saber quién pidió primero es la mitad del
valor de levantar la mano, y con un booleano el orden lo decidiría el orden de
la lista, que no significa nada.

Volver a levantar la mano estando ya levantada **no** refresca la marca: si lo
hiciera, insistir te adelantaría, y una cola en la que insistir funciona deja de
ser una cola.

## Asistencia

Cada entrada abre un tramo y cada salida lo cierra. Entrar, salir y volver son
**dos tramos**, no uno: un único `left_at` por persona perdería el segundo y
mentiría sobre el primero.

Al cerrar la reunión se completan los tramos de quien siguiera dentro — una
reunión terminada con gente "todavía dentro" mentiría sobre cuánto duró para
todo el que no cerró su pestaña.

Quién estuvo y cuánto **no es información de la sala: es un registro sobre
personas**. Lo ve quien modera la reunión o quien administra la comunidad.

```bash
GET /api/v1/meetings/:id/attendance
```

## Si no queda nadie que pueda admitir

La reunión **no se cierra sola y no se promociona a nadie**. Hay gente hablando,
y cortarles por un tecnicismo sería peor; ascender a alguien automáticamente
sería darle poder que nadie le dio.

Lo que sí se hace es decírselo a quien espera fuera, en vez de dejarlo mirando
una puerta que ya no va a abrir nadie. Quien administra la comunidad siempre
puede entrar y cerrar.

## El servidor no se fía de la interfaz

Cada comando de reunión que llega por el gateway —admitir, denegar, admitir a
todos, levantar la mano— **revalida el permiso en el servidor**. Que el cliente
haya enseñado el botón no autoriza nada: la interfaz es una sugerencia, y está
probado que un asistente que manda el comando a mano no admite a nadie.

## Lo que todavía no hay

- **Invitados de fuera de la comunidad** (V2). El campo `guests_allowed` existe
  y está en `0`; el endpoint de invitado y las sesiones limitadas a una reunión
  llegan en su fase.
- **Presupuesto de vídeo y grabación** (V3).
- **Calendario `.ics` y push-to-talk** (V4).
