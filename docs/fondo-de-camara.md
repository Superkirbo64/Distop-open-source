# Fondo de cámara

> **Estado (2026-08-28): funciona, pero queda en pausa — a reestructurar o
> descartar.** Lo que hay está terminado, probado y en uso, y esta primera
> versión eligió el camino más simple de escribir, que resulta ser el más caro
> de ejecutar. La sección [Por qué esto está en pausa](#por-qué-esto-está-en-pausa)
> explica el diagnóstico con datos, las alternativas que se evaluaron y qué
> haría falta para que valga la pena seguir. No se toca nada más hasta decidirlo.

Difuminar la habitación o cambiarla por otra cosa mientras hablas, en salas de
voz y en reuniones. Responde a la petición original: *"un sistema de fondo igual
team discord en la camara, difuminar fondo colocar fondo y asi (…) eso aplica
para una sala de voz o una reunion tambien"*.

La diferencia con Discord no es la función, es el modelo: aquí no hay nada
detrás de un pago, ni fondos "premium", ni límite de imágenes. El único límite
es el espacio del navegador y la CPU del equipo, y los dos se dicen a la cara.

## Dónde se elige

El mismo selector en cuatro sitios, porque es una sola decisión:

| Sitio | Para qué |
|---|---|
| Pastilla de controles de la llamada (`ChatVoiceHeader`) | Durante una llamada, sala de voz o reunión |
| Barra lateral de voz (`VoiceBar`) | Igual, sin salir del panel de canales |
| Cabecera de la reunión por enlace (`GuestMeeting`) | Quien entra sin cuenta: su sesión acotada no llega a Ajustes |
| Ajustes → Cámara y pantalla | Con prueba en vivo, antes de entrar a ninguna llamada |

Elegir con la cámara apagada deja el fondo listo para la próxima vez; con la
cámara encendida entra al momento, sin cortar la emisión ni renegociar nada.

## Qué se puede poner

- **Difuminado**, suave o fuerte.
- **Cuatro fondos incluidos** (Aurora, Estudio, Atardecer, Arboleda). Se dibujan
  por código con degradados: ni un archivo que descargar, ni una licencia de
  imagen que arrastrar, ni peso extra para quien hospeda.
- **Imágenes propias**, hasta 12 de 8 MB cada una. Se guardan en IndexedDB
  (`distop-backgrounds`) en el navegador de quien las sube: **no se suben a la
  instancia y nadie más las ve**.

El fondo elegido se recuerda en `localStorage`, en `distop.cameraBackground`.

## Cómo funciona

1. Se captura la cámara como siempre (`capture("camera")` en `lib/voice.ts`).
2. `lib/cameraBackground.ts` la pasa por un lienzo: en cada fotograma pregunta
   al modelo dónde está la persona, pinta el fondo elegido y pega encima a la
   persona recortada.
3. Ese lienzo se convierte en pista de vídeo (`captureStream`) y **esa** es la
   que sale por la red, exactamente igual que la cámara sobre pantalla
   compartida, que ya usaba esta misma técnica.

Todo ocurre en el equipo de quien enciende la cámara. La instancia y el resto de
la sala reciben la imagen ya compuesta: el fondo real no sale de ahí, ni siquiera
para quien hospeda.

Detalles que importan:

- El modelo corre a 20 Hz y el lienzo pinta a los fps del perfil de vídeo: la
  máscara se reutiliza entre fotogramas, que es lo que hace esto viable en un
  portátil normal.
- El difuminado se calcula sobre una reducción a 480 px de ancho y se estira; a
  resolución completa costaría mucho más y no se notaría.
- El recuadro de la cámara **sobre la pantalla compartida** también lleva fondo.
  Es más caro (dos lienzos encadenados) pero quien pidió no enseñar su
  habitación no la quiere colada en el rincón de una presentación.

## Qué modelo, y por qué está en el repo

`apps/web/public/models/selfie_segmenter_landscape.tflite` (244 KB), el Selfie
Segmenter de MediaPipe en su variante apaisada, que es la pensada para
videollamada. Lo descarga `scripts/fetch-segmenter-model.mjs` y se versiona en
el repositorio a propósito: clonar y hospedar no debe depender de que Google
siga sirviendo el archivo, ni meter una descarga a un tercero en mitad de una
llamada. El aviso de licencia (Apache-2.0) está en `THIRD_PARTY_NOTICES.md`.

El runtime WebAssembly que ejecuta el modelo viene del paquete npm y lo empaqueta
Vite. Pesa unos 12 MB sin comprimir (3,4 MB por la red), y **no se descarga al
abrir la aplicación**: solo la primera vez que alguien enciende un fondo. El
service worker lo cachea a partir de ahí.

## La trampa de la máscara

El fallo más peligroso de esto es silencioso: si se invierte la máscara, se
borra a la persona y se enseña la habitación entera — justo lo contrario de lo
prometido, sin ningún error a la vista.

Y la convención invita al error. `getLabels()` de este modelo devuelve
`["selfie"]`, **sin** categoría "background": los píxeles de la persona llevan el
índice de esa categoría (el **0**) y el fondo queda marcado con **255**, el valor
de "ninguna categoría". Dar por hecho que el 0 es el fondo —lo aparentemente
obvio— invierte el recorte entero.

Por eso esa decisión vive aparte, en `lib/cameraMask.ts`, con pruebas en
`lib/cameraMask.test.ts` que fijan las dos convenciones (modelo de una sola clase
y modelo con "background" explícito).

## Límites, dichos claro

- **Gasta CPU y GPU del equipo local.** En máquinas modestas puede bajar los
  fotogramas de la cámara. Se quita cuando se quiera.
- **Hace falta WebAssembly SIMD.** Sin él no se puede: la variante lenta de
  MediaPipe son otros 11 MB para un resultado que no da los fps de una
  videollamada, así que no se incluye. Se dice en la interfaz.
- **Si el fondo no se puede preparar, la cámara no se enciende.** Es deliberado:
  encenderla "aunque sea" enseñaría la habitación de alguien que pidió
  exactamente lo contrario. El aviso explica cómo seguir (quitar el fondo).
- **Las imágenes propias viven en un solo navegador.** No se sincronizan entre
  dispositivos, y borrar los datos del sitio se las lleva.

---

## Por qué esto está en pausa

La pregunta que abrió esta revisión fue directa: *"¿no hay manera que funcione
de la manera bastante eficiente como lo hace Teams de Microsoft?"*. La respuesta
honesta tiene dos partes, y solo una es mala noticia.

### Teams no es alcanzable, y no por falta de esfuerzo

Teams **no hace la segmentación él mismo**: la delega en *Windows Studio
Effects*, una función del propio sistema operativo acelerada por NPU y expuesta
vía DirectML, que además exige hardware Copilot+. Es una API del sistema, **no
está expuesta a las páginas web**, y ningún navegador puede invocarla. Esa
comparación está cerrada: no es cuestión de optimizar más.

WebNN —el estándar que algún día daría acceso a la NPU desde el navegador—
seguía tras *flag* en Chrome en 2026, con un CVE parcheado en junio. No es base
para producción.

### Pero la segunda mitad de esa eficiencia sí era alcanzable, y no se tomó

La eficiencia de Teams tiene otra mitad que no depende de la NPU: **no mover
nunca la imagen entre GPU y CPU**. Y ahí esta implementación hace exactamente lo
contrario:

1. Baja la máscara de la GPU a la CPU con `getAsUint8Array()`.
2. Recorre sus 36.864 píxeles en un bucle de JavaScript, **20 veces por
   segundo**, reservando un búfer de imagen nuevo en cada pasada.
3. Compone en canvas 2D: tres dibujados a resolución completa por fotograma.
4. Todo ello en el hilo principal — y la llamada al modelo (`segmentForVideo`)
   es **síncrona**, así que bloquea el hilo que pinta la interfaz.

La referencia del sector (Volcomix) publica esta comparativa en un Pixel 3:
pipeline en **canvas 2D + CPU → 11 FPS** frente a **WebGL2 → 31–60 FPS**. Con la
cautela de que esas cifras mezclan cambio de modelo con cambio de pipeline, así
que no son un 3× limpio; pero la dirección no admite duda.

### Qué hacen los que van rápido

Se revisó el código real de las librerías del sector, no sus README:

| Proyecto | Licencia | Técnica | Sirve aquí |
|---|---|---|---|
| `@livekit/track-processors` | Apache-2.0 | WebGL2, máscara como textura (`getAsWebGLTexture`), sin readback | La técnica sí; el paquete no — arrastra `livekit-client` (12,2 MB) por una función de log |
| `@twilio/video-processors` | BSD-3-Clause | WebGL2 + worker + joint bilateral filter | Funciona suelto de verdad (su README miente: no hay ni un import del SDK), pero 5,7 MB, ES5, runtime TFLite congelado y producto con dos anuncios de EOL |
| Jitsi `virtual-background` | Apache-2.0 | **canvas 2D** — el mismo camino lento | No, y además no es un paquete reutilizable |
| Volcomix | mixta | La referencia de la técnica WebGL2 | Es una demo, no una librería; su modelo *Meet Segmentation* pasó a ToS de Google y **no es redistribuible en AGPL** |

La pieza que importa de LiveKit son ~6 ficheros pequeños de WebGL y un shader de
unas 30 líneas, bajo Apache-2.0, compatible con AGPL-3.0.

### La ruta, si se retoma

En orden de coste/beneficio:

1. **Selector de cámara** (barato, y desbloquea mucho más que esto — ver abajo).
2. **Composición en WebGL2 dentro de un worker con OffscreenCanvas**: tomar la
   máscara con `getAsWebGLTexture()` y hacer desenfoque, recorte y mezcla en una
   sola pasada de GPU. Elimina el readback, el bucle por píxel y el bloqueo del
   hilo principal de una vez. Se vendoriza la técnica de LiveKit citando su
   copyright en `THIRD_PARTY_NOTICES.md`, sin añadir dependencias.
3. **Cerrar el cabo legal del modelo** (ver más abajo).

### Cabo suelto legal — pendiente

`THIRD_PARTY_NOTICES.md` declara el `.tflite` como Apache-2.0. El repositorio de
MediaPipe lo es, y varios listados dan esa licencia al modelo, **pero no se
encontró un fichero de licencia adjunto al binario concreto** que sirve el
almacenamiento de Google. Como Distop se publica bajo AGPL y ese archivo viaja
dentro del repositorio, **conviene confirmarlo antes de un release**.

## La otra vía: cámaras virtuales externas

Existe una categoría distinta que resuelve esto mejor, y que conviene no ignorar:
programas que se ponen **delante** de la cámara y publican una "cámara virtual"
que el sistema operativo ve como una webcam más.

- **OBS Studio + plugin Background Removal** — gratuito, código abierto, vivo
  (v1.3.2, agosto de 2026). Usa **DirectML** en Windows, **CoreML** en Mac y
  **TensorRT** en Linux: la misma aceleración por hardware que hace eficiente a
  Teams.
- **NVIDIA Broadcast** — gratuito con una GPU RTX, recorte muy superior.
- *Snap Camera ya no existe*: Snap lo cerró el 25 de enero de 2023 y apagó sus
  servidores. Aparece en muchas guías desactualizadas.
- ManyCam / CyberLink son de pago y no aportan nada que OBS no cubra gratis.

**Hueco detectado:** Distop **no tiene selector de cámara**. Hay selector de
micrófono y de salida de audio, pero el vídeo se pide con `getUserMedia` sin
`deviceId`, así que se usa la cámara predeterminada del sistema. Es decir: quien
instale OBS Virtual Camera o NVIDIA Broadcast **no puede elegirla en Distop**, y
quien tenga dos webcams tampoco puede cambiar entre ellas. Es una carencia por
sí sola, barata de cerrar, y desbloquea toda esta categoría.

Las dos vías no compiten, se reparten el público: el fondo integrado funciona
para **cualquiera sin instalar nada** —también en móvil y para quien entra por
un enlace—, y la cámara virtual externa da mejor calidad a quien tenga un equipo
potente y esté dispuesto a instalar. Conviene ofrecer las dos, y que el fondo
integrado se pueda apagar con facilidad para no procesar dos veces.
