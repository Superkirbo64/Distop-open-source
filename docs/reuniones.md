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

## Invitados de fuera de la comunidad

Entrar por un enlace **sin instalar nada, sin crear cuenta y sin aguantar un
botón que pide descargar la aplicación**. Es la ventaja real frente a las
alternativas, y las dos piezas ya existían: canales con permisos y sesiones
revocables.

```bash
POST /api/v1/meetings/:id/invites      # quien organiza reparte el enlace
POST /api/v1/meetings/guest            # {token, display_name}
```

El token va en el **cuerpo** y no en la ruta. Una ruta acaba en los registros de
acceso de cualquier proxy y en la cabecera `Referer` del navegador, y en este
proyecto los tokens no se registran en logs.

### Primero se comprueba, después se crea

El orden es la mitad del diseño: enlace, reunión, invitados permitidos,
caducidad, usos y aforo. **Solo si todo eso pasa** se crea la identidad. Al
revés, cualquiera probando enlaces al azar dejaría un rastro de cuentas basura
en la instancia de otra persona.

Un enlace que no vale y un enlace que no existe dan **el mismo error**:
distinguirlos convertiría esto en una forma de averiguar qué enlaces hay vivos.
Lo que sí se dice es que la reunión está cerrada o llena — quien tiene un enlace
legítimo merece saber que llegó pronto o tarde.

De la invitación solo se guarda el **hash**. El enlace es el secreto: se enseña
una vez al crearlo, y si se pierde se revoca y se hace otro.

### Un invitado no es miembro

Meterlo en `members` sería lo fácil y sería lo peor: le daría acceso a todo lo
demás y lo pondría en la lista de miembros de todo el mundo. En su lugar queda
atado a **una** reunión, y de ahí salen sus permisos:

> ver, escribir, reaccionar, entrar, hablar y encender la cámara —
> **en el canal de su reunión, y solo mientras siga abierta**

Ni adjuntar ficheros al disco de quien hospeda, ni mencionar a la comunidad, ni
gestionar nada. Terminada la reunión, no se queda con un canal ajeno.

### La sesión no sirve para nada más

Su sesión nace acotada (`sessions.meeting_id`) y se comprueba en **una sola
puerta**, con lista blanca. Una lista negra envejece mal: cada ruta nueva
quedaría permitida por omisión, y bastaría con que alguien añadiera un endpoint
sin acordarse para que un invitado de media hora pudiera leer la comunidad
entera.

Y el id de la ruta tiene que ser **el suyo**: que la forma encaje no basta.
`/api/v1/meetings/<otra>` encaja igual de bien y no es su reunión.

Por el gateway pasa lo mismo: `SUBSCRIBE` lo rechaza porque no es miembro, así
que no recibe nada de la comunidad. Lo de su propia reunión le llega por un
camino explícito y estrecho, no por la suscripción general.

### Cuando no llegan a entrar

Alguien que abrió el enlace, escribió su nombre y se fue sin que le admitieran
deja una cuenta que no pertenece a ninguna comunidad y a la que nadie va a
volver. Se limpian cada hora. Quien sí estuvo se queda —su asistencia es un
registro real— y quien convirtió su paso en una cuenta de la comunidad no la
pierde por una limpieza.

## Lo que todavía no hay

- **Presupuesto de vídeo y grabación** (V3).
- **Calendario `.ics` y push-to-talk** (V4).
