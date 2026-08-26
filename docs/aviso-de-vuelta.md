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

---

# Con Distop cerrado del todo: Web Push

Lo de arriba necesita que Distop esté abierto en algún sitio —en la bandeja, en
una pestaña—. Web Push no: el navegador enseña el aviso aunque no haya ninguna
pestaña, y aunque la aplicación esté cerrada.

Se activa en Ajustes, y es opcional por los dos lados: quien hospeda no tiene
que configurar nada y quien participa tiene que pedirlo.

```text
Avisarme aunque tenga Distop cerrado
```

## Sin intermediarios de pago

Lo manda **tu propia instancia**. No hay Firebase, ni OneSignal, ni una cuenta
que registrar: los servicios de push de los navegadores no le cobran a quien
envía, y las claves (VAPID) se las genera la instancia sola la primera vez.

El precio es que está escrito a mano. Web Push sin dependencias significa
implementar dos RFC de criptografía:

- **RFC 8291** — el mensaje va cifrado de extremo a extremo: ECDH P-256, HKDF
  con SHA-256 y AES-128-GCM. Ni el servicio de push del navegador puede leerlo.
- **RFC 8292** — la instancia firma cada envío con un JWT ES256, para que el
  servicio de push sepa que viene de quien dice.

Todo eso está en `node:crypto`, así que la regla de "solo `ws`" se mantiene.
Que sea correcto no es opinable: la prueba reproduce **byte a byte** el ejemplo
publicado en el RFC 8291 §5.

## Qué viaja dentro del aviso

Un código y, como mucho, un número:

```json
{"v":1,"t":"mention"}
```

Ni nombre de comunidad, ni de canal, ni el texto, ni quién escribió, ni
direcciones. El texto que ves lo escribe el service worker en tu idioma. Lo que
no viaja no se puede filtrar.

Y todos los avisos **pesan exactamente lo mismo**: van rellenados a un tamaño
fijo. El contenido va cifrado, pero el tamaño no, y un aviso de 12 bytes y otro
de 90 no dicen lo mismo.

## Cuándo llega

- **La instancia volvió**, al arrancar, si estuvo caída más de 90 segundos — el
  mismo umbral que el vigilante de escritorio, para que quien tenga los dos no
  reciba dos versiones distintas de la misma verdad.
- **Te mencionaron**, y solo si no tenías la aplicación abierta. Una mención
  cada dos minutos como mucho: veinte menciones en una conversación animada son
  un aviso, no veinte.

`@everyone` **no** manda push a nadie. Despertar los móviles de una comunidad
entera porque alguien escribió dos palabras es exactamente cómo se consigue que
la gente apague los avisos para siempre.

## Cómo se mide "estuvo caída"

Con un latido que la instancia escribe cada 30 segundos, no con una marca al
apagarse limpiamente. La diferencia importa: el escenario de este producto es
"apagué el PC", y un corte de luz o un cierre a lo bruto no dejan escribir
nada. Con una marca de apagado, el único caso que de verdad hace falta cubrir
sería justo el que se pierde.

## Cuando una suscripción muere

Un `404` o un `410` del servicio de push son definitivos: esa suscripción ya no
existe y se borra. Un fallo pasajero espacia el siguiente intento —1 minuto, 5,
30, 2 horas, 12— y al quinto se abandona. Insistir para siempre contra un
endpoint muerto es tráfico contra un servicio ajeno que además nunca va a
funcionar.

## Lo que se guarda aquí, y cómo

El `endpoint` de una suscripción es una URL capaz de despertar el navegador de
una persona, y sus claves cifran lo que se le manda. En la base se guardan
**cifrados**, con una clave que vive en `data/push.key`.

Que quede claro qué protege eso: **la base por su cuenta** — un `app.db` que
alguien comparte, una copia suelta. No protege contra quien tiene el directorio
de datos entero, porque la clave está ahí al lado. Decir otra cosa sería mentir.

## Lo que Web Push no puede hacer

- **No funciona en la aplicación de escritorio empaquetada.** Electron no trae
  servicio de push y el origen es `app://distop`. Ahí el aviso lo da el
  vigilante de la bandeja, que además no depende de ningún tercero.
- **El proveedor de push de tu navegador sabe cuándo y cada cuánto te llega un
  aviso**, aunque no pueda leer ninguno. Eso es inherente a Web Push y no hay
  forma de evitarlo. Se dice antes de activarlo, no después.
- **Hace falta una dirección pública** por la que el servicio de push pueda
  llegar a la instancia. Sin ella, el interruptor ni aparece.
- **Las claves de push viajan en las copias y en un relevo.** Quien restaure una
  copia puede mandar notificaciones a los navegadores de tus miembros. Está
  dicho también en [copias-de-seguridad.md](copias-de-seguridad.md) y en
  [relevo.md](relevo.md).

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
- `apps/desktop-tauri/src-tauri/watcher/main.ts` — el mismo motor como sidecar
  de Node, hablando por líneas JSON.
- `apps/desktop-tauri/src-tauri/src/availability.rs` — lo único que necesita
  Tauri: arranca y para el sidecar, y convierte lo que dice en avisos.

## Por qué Tauri no lo reescribe en Rust

Verificar que una comunidad se trasladó son firmas ES256 sobre JSON canónico,
con la época, el linaje y la cadena de certificados. Un segundo juego de esas
reglas en otro lenguaje daría dos jueces para la misma pregunta, y el día que
uno se corrigiera sin el otro, un cascarón diría «volvió» donde el otro dice
«se trasladó» — y el que se equivocara mandaría a su gente a un servidor que ya
no es el suyo.

El precio es un `node.exe` vivo mientras hay algo que vigilar, y por eso el
proceso solo existe mientras haya vigilancias: quien no usa la función no paga
la memoria. Una prueba comprueba que los ficheros escenificados son byte a byte
los de Electron, para que nadie los copie a mano por comodidad.

Las reglas de sucesión **no** están copiadas ahí: vienen de
`@distop/protocol`, las mismas que aplican el servidor y el navegador. Una
copia que se queda atrás rechaza relevos legítimos o acepta cadenas que el
resto del sistema ya no acepta, y nadie se entera hasta que alguien pierde su
comunidad.
