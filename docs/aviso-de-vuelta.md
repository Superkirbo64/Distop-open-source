# Avisar cuando la comunidad vuelve

Una comunidad hospedada en el ordenador de alguien está apagada cuando ese
ordenador lo está. Con la aplicación de escritorio en la bandeja, Distop la
comprueba por ti y te avisa cuando vuelve.

Se activa por instancia, en Ajustes:

```text
Avisarme cuando esta comunidad vuelva
```

## Qué hace falta para poder ofrecerlo

- Sesión iniciada correctamente en esa instancia.
- Ser miembro de al menos una comunidad suya.
- Haber aceptado su identidad firmada.
- Una **dirección estable**: Tailscale Funnel, dominio propio o equivalente.

Un túnel rápido estrena URL en cada arranque, así que vigilarlo sería prometer
un aviso que no puede llegar. Y **no se acepta una dirección cualquiera**: eso
convertiría la aplicación en un escáner de red.

## Cómo comprueba

Con el gateway conectado no sondea: ya sabe que está viva. Al perderse, cada
60 s con una variación aleatoria de hasta 15 s —cuarenta miembros no deben
golpear a la vez— y tope de 6 s por intento. Pasados 15 minutos sin éxito
espacia a 5 minutos: una comunidad apagada tres días no necesita 4.320 sondeos.

No basta con que algo conteste en esa dirección. Se pide una **prueba firmada**
con un número de un solo uso que genera el cliente, y se comprueba contra la
clave que tenías fijada.

## Los seis finales posibles

| Lo que pasó | Qué hace |
|---|---|
| **Volvió la de siempre** | Un aviso: *"volvió a estar disponible"*. |
| **Se trasladó** | Un aviso distinto, y lleva a la dirección nueva. |
| **No contesta** | Nada. Estar caída no es noticia; volver, sí. |
| **Conflicto de identidad** | Ningún aviso. Se guarda y se cuenta al abrir. |
| **Ya no eres miembro** | Se quita la vigilancia, el nombre y la caché. |
| **Habla otro protocolo** | Ningún aviso de vuelta y no se le manda nada. |

### "Volvió" y "se trasladó" no son el mismo aviso

Decir "volvió" cuando en realidad cambió de máquina sería mentir justo sobre lo
único que el aviso tiene que dejar claro. **"Se trasladó" solo aparece con una
cadena de sucesión verificada** desde la clave que tenías fijada
([relevo.md](relevo.md)).

Hay dos formas de descubrirlo, y las dos acaban en la misma prueba:

- La máquina nueva contesta en la misma dirección, firma tu número de un solo
  uso, y su cadena enlaza su clave con la que tenías fijada.
- La máquina vieja ya no firma nada —está retirada— pero sigue sirviendo la
  cadena y diciendo a dónde se fue la línea.

En el segundo caso, **la dirección de destino sale del certificado**, no del
cuerpo de la respuesta: `successor_origin` es un campo sin firmar en la base de
datos de una máquina que puede haber sido tocada, mientras que la lista de
direcciones autorizadas va dentro de lo que firmó el predecesor. Si el destino
no está en las dos, no se ofrece el salto a nadie.

### El conflicto de identidad no se anuncia con una ventana emergente

Dos respuestas dicen ser la misma comunidad —misma línea, misma época, claves
distintas— y desde fuera las dos parecen legítimas. O alguien afirma continuar
la línea y no puede demostrarlo.

Ninguna de las dos cosas produce un aviso de vuelta, y tampoco un susto en una
esquina de la pantalla mientras haces otra cosa: se **deja de sondear** esa
dirección y se guarda para enseñarlo al abrir, con las dos huellas delante.

Se deja de sondear a propósito. Reintentar hasta que "salga bien" es
exactamente cómo un conflicto de identidad acaba aceptándose por cansancio.
Lo desbloquea una persona —volviendo a fijar una identidad—, no un temporizador.

### Perder la membresía

El vigilante sondea **sin credenciales**, así que no puede preguntar si sigues
dentro; y exponerlo en una ruta anónima filtraría la lista de miembros. Lo
detecta el cliente: tenías comunidades en esa instancia y ahora no tienes
ninguna. Entonces se borra la entrada entera —nombre, caché e identidad
fijada— y se le dice al escritorio que la olvide.

Una cuenta recién creada también tiene la lista vacía y no ha perdido nada: por
eso se compara con lo que había, no con cero.

## Antirruido

No se avisa por caídas de menos de 90 segundos, ni por recargas o
actualizaciones rápidas, ni más de una vez cada 30 minutos si la conexión
oscila, ni si la identidad o la época no cuadran. Una instancia con varias
comunidades produce **un** aviso, no uno por comunidad. Un traslado se anuncia
**una vez por destino**: es un hecho permanente, no una novedad que se repite
cada cinco minutos.

## Lo que esto no puede hacer

- **En el navegador no hay intervalo garantizado.** `setInterval` solo corre
  mientras la página vive, y Periodic Background Sync exige PWA instalada y lo
  decide el navegador según uso, batería y conectividad. La interfaz dice
  "según disponibilidad del navegador" y no promete un minuto.
- **No funciona con la aplicación cerrada del todo.** En el escritorio la
  vigilancia vive mientras Distop esté en la bandeja.
- **Apagar el PC de golpe no avisa a nadie.** En Windows el presupuesto de
  tiempo del sistema al apagar es demasiado corto para prometer un cierre
  ordenado. Es best-effort, y se dice así.
- **A quien nunca vio la instancia no se le puede avisar de nada**, y con las
  dos máquinas apagadas no hay por dónde empujar "la dirección cambió".
- **Tailscale Funnel es beta**, solo TLS, solo puertos 443/8443/10000, con
  límites de ancho de banda no configurables — y un fallo de certificado puede
  dejar la dirección inaccesible **hasta 34 horas**. En una función cuya
  promesa es "te aviso cuando vuelva", conviene saberlo.

## Dónde vive esto

- `apps/desktop/src/availability-policy.ts` — las reglas: qué cuenta como qué,
  cuánto se calla, cómo se verifica un eslabón.
- `apps/desktop/src/availability-watcher.ts` — el motor: sondear, seguir la
  cadena, decidir.
- `apps/desktop/src/availability.ts` — lo único que necesita Electron.

Las reglas de sucesión **no** están copiadas ahí: vienen de
`@distop/protocol`, las mismas que aplican el servidor y el navegador. Una
copia que se queda atrás rechaza relevos legítimos o acepta cadenas que el
resto del sistema ya no acepta, y nadie se entera hasta que alguien pierde su
comunidad.
