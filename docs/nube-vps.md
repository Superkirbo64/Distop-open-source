# Una máquina que no se apaga

Distop está pensado para vivir en tu ordenador. Este documento es para cuando
eso ya no basta: cuando quieres que tu comunidad siga en pie con tu equipo
apagado.

No hay atajo. **No existe hoy un servicio gratuito, siempre encendido, con disco
persistente y de un clic.** Todo lo que se anuncia como tal falla en alguna de
esas cuatro cosas, y esta guía dice en cuál. Lo que sí hay son dos caminos
honestos: poner tú el hardware, o alquilar una máquina por unos euros al mes.

## Antes de gastar nada: ¿de verdad hace falta?

Tres preguntas que ahorran dinero:

- **¿Cuánta gente sois?** Para un grupo de amigos, el ordenador de casa con el
  túnel que la aplicación abre sola sobra. La comunidad está disponible mientras
  ese equipo esté encendido, y se dice en la interfaz.
- **¿Hay alguien más que pueda hospedar?** Distop sabe pasar el anfitrión de una
  máquina a otra sin copiar claves ni perder nada (`docs/relevo.md`). Muchas
  veces la respuesta correcta a «necesito un servidor» es «tu amigo ya tiene
  uno».
- **¿Tienes un equipo viejo?** Un mini-PC o una Raspberry Pi encendida en un
  rincón es el «siempre activo» más barato que existe y no depende de nadie.

Si después de eso sigues queriendo una máquina alquilada, sigue leyendo.

## Lo que hay, a agosto de 2026

| Opción | Entrada | Qué te da | La letra pequeña |
|---|---|---|---|
| **Raspberry Pi / mini-PC** | sin cuota de hosting | Hardware bajo tu control | Electricidad, conexión y copias son tuyas. Es el único «gratis para siempre» si ya tienes el equipo. |
| **VPS Ubuntu/Debian** | precio del proveedor | Disco persistente y control total | El instalador de Distop deja la aplicación lista, pero la cuenta, cobro y disponibilidad dependen del proveedor. |
| [**PikaPods**](https://www.pikapods.com/) | desde US$1,80/mes | Disco, HTTPS, dominio del pod y gestión sencilla | Da US$5 iniciales sin tarjeta, no una capa gratuita permanente. Distop debe ser admitido en su catálogo. |
| [**Railway**](https://docs.railway.com/pricing) | prueba; luego desde US$5/mes | Docker, HTTPS y volúmenes | La prueba es crédito temporal. El volumen se factura aparte y hay que validar persistencia antes de publicar la plantilla. |
| [**Northflank Sandbox**](https://northflank.com/docs/v1/application/billing/pricing-on-northflank) | servicios gratis | Servicios siempre activos para pruebas | Exige método de pago, no recomienda Sandbox para producción y el volumen persistente es un recurso facturado aparte. |

Los precios y las condiciones cambian sin avisar. Contrasta antes de pagar. En
particular, un crédito de bienvenida no es una VPS gratuita permanente.

## Instalación lista

- En Ubuntu/Debian usa `docs/instalar-vps.md`: instalador firmado por checksum,
  Docker, `systemd`, disco persistente y Tailscale Funnel.
- En Raspberry Pi usa `docs/raspberry-pi.md`; la misma imagen incluye `arm64`.
- Para PaaS, `deploy/README.md` documenta el contrato del contenedor y las
  pruebas que debe superar cualquier plantilla antes de ofrecer un botón.

## La dirección: no hace falta DNS

Es el paso que más gente abandona, y se puede saltar entero.

- **Tailscale Funnel** da `tu-maquina.tailnet.ts.net` con HTTPS, gratis y sin
  abrir puertos ni tocar un registro DNS. Vale igual en tu PC de casa, en una
  Raspberry o en una VPS alquilada. Es el carril que la aplicación ya sabe
  configurar. Requiere cuenta de Tailscale y sigue siendo una función en beta.
- **Un PaaS** (PikaPods, Railway, Fly) te entrega el nombre y el certificado
  hechos. Ahí no hay nada que hacer.
- **El túnel de Cloudflare** que Distop abre solo sirve para empezar, pero su
  dirección **cambia en cada reinicio**: no vale para publicar tu comunidad ni
  para que la gente vuelva mañana.
- **Un dominio propio** con su registro A es lo clásico, y hoy solo hace falta
  si quieres que la dirección sea tuya de verdad.

## Por qué esto es viable ahora

Hasta hace poco la voz pasaba entera por el servidor: cada persona que hablaba
se reenviaba a todas las demás, y eso multiplicaba la subida del anfitrión.
Con la voz directa entre navegadores (Ajustes → *Por dónde va la voz*), el
servidor se queda con el texto, el historial, los ficheros y la señalización.

Medido con dos navegadores reales: **0 bytes por segundo subiendo a la
instancia** cuando todo el mundo está en directo, frente a 4 KB/s por persona
antes. Por eso una máquina pequeña vale, y por eso el límite de ancho de banda
de Funnel dejó de importar.

El precio de esa decisión también está medido y dicho: la malla aguanta seis u
ocho personas hablando; por encima, la sala entera vuelve por el servidor.

## Lo que no cambia

Sea cual sea la máquina, sigue siendo **tu** instancia: tus datos, tus copias,
tu responsabilidad. Alquilar un servidor no convierte esto en un servicio con
alguien detrás arreglándolo. Antes de mudarte, lee `docs/copias-de-seguridad.md`
y prueba una restauración; una copia que nunca se ha restaurado no es una copia.
