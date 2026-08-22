# Memoria del proyecto — Distop

Lo que no se deduce leyendo el código: qué se decidió, qué se descartó y por qué.
Última actualización: **21 de agosto de 2026**.

## Identidad

- **Nombre: Distop.** Elegido por quien lidera el proyecto en esta sesión (escrito
  "DIstop" en la respuesta; se aplicó `Distop`). Vive en `apps/web/src/brand.ts` y en
  `packages/protocol` no aparece: renombrar es tocar ese archivo y el bloque de tokens
  de `styles.css`, nada más.
- **Dirección visual: claro y oscuro duales desde el día uno**, no un oscuro aclarado.
  Dos paletas escritas a mano en `apps/web/src/styles.css`. Descartado el neobrutalismo
  por cansar en sesiones largas de chat, y el "solo oscuro" por accesibilidad.
- Alcance elegido: **app real + API de instancia**. La landing pública quedó fuera de
  esa entrega, por decisión explícita. **Ya no: existe `apps/marketing`** — ver la
  sección «Sitio público» al final.

## Tipografías y licencias

- **Bricolage Grotesque** (display) e **Inter** (cuerpo), ambas **OFL** — válidas para
  uso comercial y para el sitio de un negocio.
- **Gotcha pendiente:** hoy se cargan desde `fonts.googleapis.com`. Para un proyecto que
  presume de privacidad (§8) eso es una petición a Google en cada carga. Antes de
  producción hay que autoalojar los `.woff2` y quitar los `<link>` de `index.html`.

## Decisiones técnicas y qué se descartó

| Decisión | Por qué | Qué se descartó |
|---|---|---|
| **Node 24 con TypeScript nativo** en el servidor | Node 24 ejecuta `.ts` sin compilar y trae `node:sqlite`. Cero paso de build, cero dependencia de runtime extra | **Bun** (era el runtime del prototipo §36). Obligaba a instalar otro runtime; el equipo tenía Node 24 |
| **`node:sqlite` + `ws`** como únicas piezas del servidor | Una sola dependencia de producción. Importa cuando la instancia corre en una Raspberry o un NAS | better-sqlite3 (compila binarios nativos), Fastify/Express (el router propio son 40 líneas) |
| **React + Vite** para el cliente | Todo vive detrás de sesión: el SEO no aplica. Vite es además la pareja natural de Tauri para el futuro cliente de escritorio (§15) | **Next.js**: SSR no aporta nada aquí y complica el empaquetado en Tauri |
| **Tokens propios + Tailwind v4 `@theme inline`** | El tema cambia en caliente porque las utilidades apuntan a variables CSS, no a valores fijos | **shadcn/ui**: arrastra Radix y su estética es reconocible; §25 pide identidad propia |
| **`<dialog>` nativo, `matchMedia`, `<details>`** para accesibilidad | El navegador ya trae trampa de foco, Escape y fondo modal | Radix, Headless UI |
| **scrypt de `node:crypto`** para contraseñas | Memory-hard y sin binarios que compilar en todas las plataformas objetivo | **Argon2id** que pide §22. Está aislado en `auth.ts` y el hash lleva prefijo de algoritmo, así que la migración es un archivo. Marcado con comentario `ponytail:` |
| **Tokens opacos + HMAC en base** | Revocables de verdad (§22 lo exige) y un volcado de la base no entrega sesiones usables | **JWT**: no se revoca sin lista negra, que es justo la tabla que ya tenemos |
| **Permisos en BigInt** | 33 permisos no caben en los 32 bits de las operaciones bitwise de JavaScript | Bitfield numérico (se rompe en silencio al llegar a 33) |
| **UUIDv7 con contador monótono** | Sin contador, dos IDs del mismo milisegundo no ordenan y la paginación por id devuelve el historial desordenado. Lo detectó un test | UUIDv4 (el prototipo lo usaba), columna de orden aparte |
| **Router propio de 30 líneas** | Tres rutas, y solo `/invite/:code` es profunda | react-router |
| **Zustand sin TanStack Query** | El gateway empuja el estado; casi no hay peticiones que cachear | TanStack Query |
| **Subida por cuerpo crudo** (`content-type` + `x-filename`) | Evita escribir un parser multipart entero para un caso de un archivo | multipart/form-data |

## Cosas que se resolvieron y volverían a morder

- **`node:sqlite` no acepta booleanos.** Todo va como `1`/`0`. Si aparece un
  `TypeError` raro al insertar, es esto.
- **El gateway manda `READY` en el mismo instante del upgrade.** Cualquier cliente
  (incluidos los tests) tiene que estar escuchando *antes* de que resuelva el `open`,
  o lo pierde. Los tests usan un buzón por eso.
- **`server.close()` no cierra los sockets ya actualizados a WebSocket.** Sin
  `server.closeAllConnections()` el proceso de test se queda colgado para siempre.
- **En Windows, SQLite bloquea el directorio** hasta que se llama a `db.close()`:
  el `rmSync` de limpieza falla si no.
- **`exactOptionalPropertyTypes` obliga a `?: T | undefined`** explícito en las props de
  React y a construir el `init` de `fetch` por difusión condicional. No es opcional
  quitarlo: lo pide §30.
- **Tailwind 4.0.0 rompía** con `@theme inline` ("Cannot convert undefined or null to
  object"). Resuelto subiendo a 4.3.3. No bajar de ahí.
- **Las capas de Tailwind ganan a la especificidad.** La rejilla `.app-grid` estaba en
  `@layer components` y su `display: none` de móvil perdía contra la utilidad `.flex`
  de los paneles (`utilities` va después de `components`), así que en 360 px el chat y
  la navegación se pintaban apilados. Por eso el bloque `.app-grid` está **sin `@layer`**
  en `styles.css`: lo no-capado gana a todo. No lo metas dentro de una capa.
- **El color del avatar recorre el círculo de tonos completo, no una paleta de ocho.**
  Con ocho, en cualquier comunidad pequeña ya salen dos personas del mismo color (pasó
  en la primera verificación). La luminosidad y el croma son fijos, así que el contraste
  del texto blanco es el mismo en todos los tonos.
- **`accent-[var(--accent)]` de Tailwind daba un color raro** en `input[type=range]` y
  en las casillas. Con `style={{ accentColor: "var(--accent)" }}` es inequívoco.

## Errores de acceso y hosting (verificado el 1 de agosto de 2026)

Salió de un fallo reportado desde la interfaz: un invitado veía **"Internal Server
Error"**. Ese texto no era nuestro — es el `statusText` de una respuesta sin cuerpo de
error tipado, que aparece cuando el proxy de Vite no encuentra la instancia. O sea: la
instancia estaba apagada y el mensaje mandaba a depurar el sitio equivocado.

Lo que se cambió a raíz de eso:

- **El cliente distingue "la instancia contestó un error" de "no hubo instancia".** Si la
  respuesta no trae error tipado, se etiqueta `INSTANCE_UNREACHABLE` y se dice en pantalla.
  Los 14 sitios que repetían el mismo ternario ahora usan un único `useErrorText()`.
- **El proxy de Vite responde 503 con error tipado y explica en el terminal** cómo
  arrancar la instancia, en vez de un 500 mudo.
- **El `.env` no lo leía nadie**, aunque el README mandara crearlo. Ahora el servidor
  arranca con `--env-file-if-exists=../../.env` y Vite lee la raíz con `loadEnv`.
- **`TRUST_PROXY` (nuevo, por defecto `false`).** Antes se confiaba siempre en
  `X-Forwarded-For`, así que cualquiera falseaba su IP y saltaba los límites. Ahora es
  explícito, con las dos caras documentadas: sin proxy es un agujero, y detrás de un
  túnel sin activarlo toda la comunidad comparte una IP.
- **Los límites por IP eran para un servicio público, no para una comunidad.** Cinco
  altas por hora dejaban fuera a la sexta persona de una misma casa u oficina. Ahora son
  configurables y de fábrica valen 30 altas / 60 invitados por hora.
- **Filtrado de existencia al borrar comunidad ajena:** devolvía 403 (confirmando que el
  identificador era real) donde el resto de la API devuelve 404. Corregido en `DELETE
  /communities/:id` y en `/leave`.

Comprobado con 28 casos de acceso (`acceso.sh`, en el scratchpad): credenciales, no
enumeración de usuarios, cuerpo no-JSON, token ausente/inventado/revocado, rotación
estricta del refresh, instancia con registro e invitados cerrados, límites por IP con
valores diminutos, cabecera falseada, y recursos ajenos.

**Hosting verificado sin Docker** (el demonio no estaba levantado en la máquina): modo
producción real —un proceso, un puerto, API + gateway + cliente compilado—, negativa a
arrancar sin `AUTH_SECRET`, el `HEALTHCHECK` del Dockerfile ejecutado tal cual,
`docker compose config` válido con su exigencia de secreto, el `npm ci` de la imagen
resuelto contra el lockfile, y **datos intactos tras reiniciar** (los mensajes siguen ahí,
la contraseña sigue valiendo, y cambiar `AUTH_SECRET` invalida los tokens viejos). La
suite completa de navegador pasa también contra esa instancia de producción, no solo
contra el dev server. **Falta construir la imagen de verdad** cuando Docker Desktop esté
en marcha.

## Hospedar sin loguearse (decisión del 1 de agosto de 2026)

Petición explícita de quien lidera el proyecto: **"no puedo hacer hosting sin loguearme
primero, eso es un inconveniente que no quiero"**. Tenía razón — la primera pantalla de
una instancia recién instalada era un muro de acceso a un sitio que es tuyo.

Cómo quedó, y por qué así:

- `GET /api/v1/info` publica `setup_required` (no hay ninguna persona todavía) y
  `setup_requires_code`. El cliente enseña `views/Setup.tsx` en lugar de `Auth.tsx`.
- `POST /api/v1/auth/bootstrap` crea a la dueña **sin contraseña** y devuelve sesión. El
  formulario pide además el nombre de la comunidad y la crea en el mismo paso: de cero a
  administrando en una pantalla.
- **Desde el propio equipo no se pide código**; desde fuera sí, y va impreso en el
  terminal al arrancar (`SETUP_CODE` para instalaciones desatendidas). Se decidió así
  porque las dos alternativas puras son malas: pedir código siempre es justo la fricción
  que se quería quitar, y no pedirlo nunca deja que el primer desconocido que encuentre
  la URL se quede el nodo. La localidad se mira en el **socket**, nunca en una cabecera,
  y con `TRUST_PROXY=true` nunca se considera local (delante hay un proxy).
- La ventana se cierra sola: con una persona dentro, `bootstrap` devuelve 409.
- `POST /users/me/upgrade` ya no mira `kind === "guest"` sino **si la cuenta tiene
  contraseña**. Así sirve para dos casos: el invitado que se queda y la dueña que quiere
  poder entrar desde otro equipo. Y a la dueña no se le niega por tener el registro
  cerrado: cerrar el registro es para los de fuera.

**Un invitado NO cuenta como dueño.** Primera versión de esto contaba `users` a secas, y
salió mal en la práctica: bastaba con que alguien —el propio dueño probando— entrase como
invitado para que la instancia quedara "reclamada" sin que nadie tuviera acceso de
administración. Cerrojo sin llave, y sin más salida que borrar la base. Ahora se cuenta
`countOwners()` = cuentas `kind = 'local'`, y el cliente enseña la puesta en marcha
también cuando hay una sesión de invitado abierta (un invitado no puede crear
comunidades, así que entrar como tal en una instancia sin reclamar es un callejón sin
salida; y si no está reclamada, todavía no existe ninguna comunidad que perder).

Cubierto por `bootstrap.test.ts` (5 casos, incluido el del invitado que pasa por delante)
y verificado en navegador contra una base real con tres invitados dentro: la primera
pantalla pasó de ser un login imposible a la puesta en marcha, **sin borrar nada**. Desde
la LAN sin código devuelve 403.

## Seguridad: lo que ya está cerrado

- Escalada de privilegios: nadie concede un permiso que no tiene, ni edita un rol igual
  o superior al suyo. Hay un test que lo comprueba.
- Canales privados: la visibilidad se recalcula **por socket** antes de emitir, así que
  un mensaje de canal privado no llega a quien no puede verlo. También hay test.
- Adjuntos: el nombre del usuario nunca toca el disco (en disco vive un UUID), lista
  blanca de tipos, y se sirven con `Content-Security-Policy: sandbox` y `nosniff`.
  Los SVG se descargan, nunca se muestran en línea.
- Errores: fuera de `HttpError` el mensaje real no sale al cliente (podría llevar rutas o SQL).

## Pendiente y fuera de alcance

**Pendiente cercano (sin empezar):**
- Autoalojar las tipografías (ver arriba).
- Archivo `LICENSE` con AGPL-3.0 y revisión de compatibilidad de dependencias (§24).
- Reordenar canales y categorías arrastrando (la API ya acepta `position`).
- Emojis y stickers personalizados; hoy solo hay seis reacciones rápidas fijas.
- Rate limiting en memoria: si algún día hay varias instancias tras un balanceador, se muda a Redis.
- Búsqueda con `LIKE`: sirve para un canal, no para un historial grande. FTS5 sin tocar la API.

**Declarado fuera de alcance en esta entrega:** voz y vídeo, mensajes directos, bots y
plugins, Minecraft, plataforma central, federación y la landing pública. La arquitectura
los contempla; el código no los tiene.

## Verificación hecha

`npm test` → 8 comprobaciones en verde (API completa, invitaciones de un uso, escalada de
privilegios, gateway con dos personas reales, canales privados, orden de UUIDv7).
`npm run typecheck` limpio en cliente e instancia. Prueba en vivo con `curl`: health,
info, cascarón SPA, ruta profunda, 404 tipado, subida y descarga de archivos con cabeceras
endurecidas, y rechazo de tipo no permitido.

**Verificado en navegador real** (Chromium 151 vía Playwright 1.62, dos contextos
independientes contra la instancia con el cliente compilado): registro, creación de
comunidad, envío y recepción de mensajes **en vivo entre dos navegadores**, invitación
generada y aceptada por un invitado sin cuenta, historial visible al entrar, presencia
con dos personas, cambio real de tema (fondo `rgb(13,14,18)` ↔ `rgb(244,245,248)`),
acciones del mensaje al pasar el ratón de verdad, tildes correctas en pantalla, foco
visible al primer tabulador y **cero errores de consola**. Anchos 1440, 768 y 360 px sin
desbordamiento horizontal. 18 comprobaciones en verde.

Lo que encontró esa verificación y ya está corregido: la conversación flotaba arriba con
medio panel vacío (ahora se apoya abajo con `mt-auto`), los avatares salían todos del
mismo color, el deslizador de tamaño de texto salía verde oliva, "1 miembros" sin
singular, y el fallo de capas de Tailwind descrito arriba.

**El guion de verificación no está en el repo** (vive en el scratchpad de la sesión). Si
esta comprobación va a repetirse, conviene promoverlo a `apps/web/e2e/` con Playwright
como devDependency — hoy los navegadores ya están descargados en la máquina.

**Sigue sin comprobarse**: lector de pantalla real, Firefox y Safari, y el recorrido
completo de administración (roles, auditoría, exportación) desde la interfaz.

## Voz, compartir y vida en la interfaz (2 de agosto de 2026)

Pedido con capturas de Discord como referencia (canal de voz con participantes
colgando debajo, panel "Voz conectada", miembros agrupados por rol).

- **Voz: malla WebRTC entre pares, sin SFU.** La instancia solo hace de
  señalización (`voice.ts` en servidor y cliente); el audio va directo entre
  navegadores. Esa decisión es la que permite que hospedar voz no cueste ancho
  de banda de servidor y quepa en el PC de alguien. Techo práctico ~6 por canal:
  el coste de una malla sube al cuadrado. Por encima toca SFU, y el protocolo no
  cambia. Quién ofrece y quién responde se decide por comparación de ids, no por
  orden de llegada, porque si los dos ofrecen a la vez la negociación se rompe.
- **Los `<audio>` de cada par van al DOM** (contenedor oculto `#distop-voice-sinks`),
  no sueltos en memoria: el navegador los trata mejor, se pueden inspeccionar y
  es donde colgará el volumen por persona.
- **Trampa de zustand v5 que costó un cuelgue:** un selector que devuelve `?? []`
  fabrica un array nuevo en cada lectura, `useSyncExternalStore` lo ve como
  estado nuevo y el render entra en bucle infinito (React #185, pantalla en
  blanco). Hay una constante `EMPTY` en cada archivo que lo necesita. **No
  escribas `useStore(s => s.algo[x] ?? [])` nunca.**
- **Miembros agrupados por rol destacado** (`hoist`), no solo por conexión.
- **Compartir el hosting:** `PUBLIC_URL` manda sobre `location.origin` al generar
  invitaciones —un enlace a localhost no le sirve a nadie— y el diálogo de estado
  trae el comando de túnel de Cloudflare ya escrito.
- **Movimiento:** cada animación responde a un suceso (mensaje que llega, panel
  que abre, alguien que habla). Nada se mueve solo, y todo se desactiva con
  `prefers-reduced-motion`.

Verificado con `voz.mjs`: dos Chromium reales con micrófono simulado llegan a
`connection.connectionState === "connected"` en ambos lados, con pistas de audio
vivas, estados de silencio propagados y limpieza al colgar. Cero errores de consola.

**Pendiente de esta tanda:** selector de micrófono y medidor de prueba en Ajustes
(aparece en las capturas de referencia), compartir pantalla y vídeo, mensajes
directos, hilos, notificaciones y no leídos, y emojis personalizados.

---

## Acceso, iconos y personalización (2 de agosto de 2026)

### Entrar sin cuenta ya no es una versión recortada

Un invitado podía leer y escribir pero no crear su comunidad, y eso convertía el
modo invitado en una demo. Ahora **invitado y cuenta pueden exactamente lo mismo**:
la contraseña sirve para volver desde otro dispositivo, no para desbloquear nada.

- Se cayó la comprobación `kind === "guest"` de `POST /communities` y la constante
  `GUEST_PERMISSIONS` del protocolo, que ya no la usaba nadie: todo el mundo entra
  con `DEFAULT_MEMBER_PERMISSIONS` y quien crea una comunidad la administra.
- `App.tsx` ya no manda a los invitados a la pantalla de puesta en marcha; con
  sesión abierta se entra directo. Poner contraseña desde Ajustes convierte la
  cuenta en `local` y, de paso, reclama la instancia si estaba sin dueño.

### El agujero que dejó a la instancia real sin acceso

En la instancia de pruebas del proyecto había un usuario `kirbo` de tipo `local`
**sin contraseña** (así se crea al poner en marcha, a propósito). Al perderse la
sesión del navegador —basta con rotar `AUTH_SECRET`— el login le respondía
"usuario o contraseña incorrectos" para siempre: no hay contraseña que teclear.

Solución: `POST /api/v1/auth/recover`. Abre sesión en una cuenta **sin contraseña**
si la petición viene del propio equipo (`isLocalRequest`) o trae el código impreso
en el terminal. `/api/v1/info` incluye `recoverable` —solo en peticiones locales—
con las cuentas sin contraseña **que tienen comunidad propia**, y el login pinta un
botón por cada una con el nombre de su comunidad, porque en una instancia doméstica
todas las cuentas se llaman parecido. No es un agujero nuevo: quien está sentado
delante de la máquina ya puede leer `app.db` entero.

### Iconos: animate-ui portado a CSS

Los iconos que reaccionan salen de **animate-ui** (MIT, github.com/imskyleen/animate-ui):
el engranaje que gira 180°, las ondas del altavoz que laten en cascada, la gente
que da un saltito, la línea del panel que se acerca al borde. Allí cada icono es
un componente de `motion` con contexto, `Slot` y hooks; aquí la geometría vive en
`components/icons.tsx` y la coreografía en `@keyframes` de `styles.css`, disparada
por el `:hover` del control que lo contiene. Motivo: `motion` son ~35 kB gzip para
mover seis trazos. Si algún día se quieren los componentes tal cual se publican,
se instala `motion` y se sustituye ese archivo; el resto del código solo ve
`<Gear size={17} />`.

Regla al añadir uno: lo que dura mientras el ratón esté encima va con `transition`
(vuelve solo, sin tirón); lo que ocurre una vez va con `animation`.

### Movimiento con tokens, no números sueltos

`--ease-soft`, `--ease-spring`, `--ease-both` y `--dur-1/2/3` en `:root`. Todo sale
rápido y se posa despacio; nada arranca y frena de golpe. Dos interruptores lo
apagan: `prefers-reduced-motion` del sistema y `data-motion="off"` desde Ajustes.

### Paneles retráctiles

La rejilla pasó de `auto auto 1fr auto` a **variables** (`--w-rail`, `--w-sidebar`,
`--w-members`) y transiciona `grid-template-columns`, así el chat gana el hueco
deslizándose. `data-sidebar` / `data-members` en `.app-grid` lo gobiernan, con
Ctrl+B y Ctrl+U, y la preferencia se recuerda en `localStorage`.

Dos trampas resueltas:
- Los paneles tenían ancho fijo (`w-64`, `w-60`). Con la columna a 0 se salían por
  encima del chat: ahora son `w-full` y es la columna la que manda.
- Con `box-sizing: border-box`, un ancho de 0 **no** se come el relleno ni el borde:
  quedaba una franja de 17 px del panel "plegado". El estado plegado pone también
  `padding: 0` y `border-width: 0`.
- El `overflow: hidden` del plegado se aplica **solo** en ese estado; si se pone a
  todos los paneles gana a `overflow-y-auto` de Tailwind (regla sin capa contra
  utilidad en capa) y se queda sin scroll la lista de miembros.

### Personalización, toda gratis

Nueva pestaña de Apariencia: color de acento (ocho de partida más selector libre,
con `--accent-ink` calculado por luminancia para que el texto encima contraste),
radio de las esquinas, tipografía (cuatro pilas locales, ninguna descarga nada),
fondo de la conversación (liso, degradado, puntos) y animaciones. Todo se guarda
en `localStorage` y se aplica como variables CSS sobre `documentElement`, así que
manda sobre los dos temas. Ninguna opción está reservada, ni marcada como "pro".

Verificado con `interfaz.mjs` (Chromium real): el panel se pliega animándose y
deja 0 px, Ctrl+B y Ctrl+U responden, el engranaje anima al pasar el ratón, acento,
esquinas, fondo y tipografía se aplican al instante, y no hay desbordamiento
horizontal a 1440, 768 ni 360. Y con `acceso.mjs`: quien hospeda vuelve a su
comunidad sin contraseña y un invitado crea la suya y la administra.

**Pendiente:** selector de micrófono y medidor en Ajustes, compartir pantalla y
vídeo, mensajes directos, hilos, notificaciones y no leídos, emojis personalizados.

---

## Sitio público — `apps/marketing` (2 de agosto de 2026)

Pedido con **inkgames.com** como referencia, estático, en Astro y sin demo previa.
De Ink Games se copió la **estructura** (cabecera ligera, hero de tipografía enorme
con un CTA, bloques a sangre alternando texto grande y producto) y nada más: es una
web de gaming con monetización real y Distop vende justo lo contrario.

### Decisiones de esta tanda

| Decisión | Por qué | Qué se descartó |
|---|---|---|
| **Proyecto Astro aparte** (`apps/marketing`), no una ruta de `apps/web` | El cliente vive detrás de sesión y no tiene SEO; esto es lo contrario. Astro manda HTML puro y cabe en cualquier capa gratuita | Meterlo en la SPA (mataba el SEO), Next.js (no hay nada dinámico que servir) |
| **Estética arcade de 8 bits**, oscuro comprometido | Elegida explícitamente sobre «terminal/CRT» y «escritorio 90s». Diferencia el sitio del clon-de-Discord oscuro | El dual claro/oscuro de la app: aquí se decidió una sola cara |
| **Press Start 2P + Silkscreen para titulares y etiquetas, Inter para párrafos** | La tipografía de píxeles es ilegible en texto corrido. Se avisó antes de elegirla y se aplicó la separación | Poner píxeles en todo |
| **Fuentes por Fontsource, autoalojadas** | Cierra para este sitio el pendiente de §8: cero peticiones a `fonts.googleapis.com`. Verificado: 13 `.woff2` en `dist/_astro` y ni una URL externa en el HTML | Los `<link>` de Google que todavía usa `apps/web` |
| **Rutas `/es/`, `/en/`, `/pt-br/` con prefijo también en español** | Un archivo por página en vez de dos. `/` redirige a `/es/` | `prefixDefaultLocale: false`, que obliga a duplicar cada página |
| **Slugs en inglés** (`install`, `hosting`, `news`, `privacy`) iguales en los tres idiomas | Traducir los slugs obliga a un enrutador por idioma para ganar nada | Slugs traducidos |
| **`astro check` en el `typecheck` de la raíz** | Encontró un fallo real a los diez segundos (abajo) | Dejar el sitio sin comprobar |
| **Campo de puntos en canvas propio** | Es la idea de `DotGrid` de ReactBits, que usa GSAP + `InertiaPlugin`. El muelle son tres líneas en el bucle, y GSAP ya estaba cargado para el scroll | `Beams`/`LightRays`/`Plasma` de ReactBits: WebGL con `ogl`, +30 kB y GPU al ralentí en una landing |
| **Cursor de píxeles dibujado a mano** (SVG en data-URI, en `--cursor-arrow`) | Los cursores de Windows 98 son de Microsoft. `1j01/retrores` **no tiene licencia** y sale de las DLL del sistema; los packs de Cursor Foundry y similares son para escritorio, no para redistribuir en una web. §24 lo prohíbe | Descargar cualquier pack «gratis» de internet |
| **Menú de móvil y selector de idioma con `<details>`** | El navegador ya sabe abrirlo, cerrarlo con Escape y anunciarlo | Una librería de menús |

**Uiverse no se pudo consultar**: devuelve 403 a cualquier fetch y no tiene repositorio
público (lo que aparece al buscar son forks ajenos). La comparación de FASE 3 fue
ReactBits contra CSS nativo, no ReactBits contra Uiverse.

### Cosas que se vieron mirando, no leyendo

Todas salieron de capturas con `scripts/shot.mjs`, ninguna del código:

- **Press Start 2P ocupa casi el doble de ancho por letra.** El `h1` con tope de 4rem
  llenaba la pantalla entera: 64 px reales, 302 px de alto. Bajado a 2.5rem.
- **`border-image` con el SVG de esquinas mordidas salía a rayas.** Con
  `border: 4px` y `border-image-width: 2px` sobraban 2 px que pintaba el borde normal.
  Sustituido por `border: 2px solid`: mismo aire de 8 bits, cero artefactos.
- **`main` ocupa el `1fr` del body, así que en una página corta estira sus filas
  automáticas** y los botones del bloque final salían convertidos en cuadrados de
  190 px. Se cierra con `align-content: start` en `main`. Vale para cualquier página
  corta futura, no solo para la portada.
- **La marca eran cinco nodos unidos en diagonal y a 20 px se leía como una X**, o
  sea como un botón de cerrar. Ahora es un bocadillo de conversación de píxeles.
- **Las fechas ISO sin hora son medianoche UTC**: al formatearlas en un huso al oeste
  de Greenwich salía el día anterior («1 de agosto» para el 2). Va `timeZone: "UTC"`.
- **A 360 px no había navegación**: la barra se ocultaba y solo quedaba el pie. Ahora
  hay un desplegable de 44×44.
- Las tildes de Press Start 2P **sí existen** y se colocan bien (comprobado ampliando
  «últimas» a 6 aumentos). No hace falta buscarle sustituta.

**Trampa de tipos que encontró `astro check`:** el diccionario español llevaba
`as const`, así que cada cadena era su propio tipo literal y `Dict = typeof es`
acababa exigiendo que el inglés dijera **exactamente lo mismo, letra por letra**
(242 errores). Sin `as const` se comprueba la forma, que es lo que se quería.

### Verificación hecha

Navegador real (Chromium por CDP, `scripts/shot.mjs`) a **1440, 768 y 360 px**: cero
desbordamiento horizontal en los tres (`scrollWidth === innerWidth`); el único
elemento más ancho que la ventana es el `<code>` del bloque de Docker, que scrollea
dentro de su propia caja. **Hover disparado con ratón de verdad** (nuevo `HOVER="x,y"`
en `shot.mjs`, porque un evento sintético desde la página no activa `:hover`): la card
se levanta 3 px y aparece la sombra de acento. `astro check` limpio en 13 archivos.
`astro build` genera 16 páginas.

La captura del hero es **la app de verdad**, no un montaje: se levantó una instancia
aislada en el puerto 5055 con su base en el scratchpad (nunca `data/app.db`), se
sembró con `seed.mjs` —cuatro personas registradas de verdad y una conversación— y se
fotografió con el token en `localStorage`. La instancia se paró y sus datos se
borraron al terminar.

### Pendiente de esta tanda

- **`apps/web` sigue pidiendo las fuentes a Google.** Aquí ya está resuelto con
  Fontsource; queda copiar el mismo enfoque al cliente.
- **`ws` está en 8.18.0 y tiene dos avisos altos** (divulgación de memoria y DoS por
  fragmentos diminutos). Se arregla subiendo a 8.21.1. Es dependencia de producción de
  la instancia, no del sitio; no se tocó en esta tanda para no mezclar cosas.
- ~~El repositorio del pie apunta a `github.com/kirbo/distop`~~ **resuelto el 21 de
  agosto de 2026**: ahora es `github.com/Superkirbo64/Distop-open-source`. Sigue
  pendiente `site: "https://distop.app"` en `astro.config.mjs`.
- No hay imagen de Open Graph (`og:image`), así que al compartir el enlace sale sin
  tarjeta. Es una captura de 1200×630 en `public/`.
- Falta la página de descubrimiento de comunidades públicas: la API ya tiene
  `/api/v1/discovery`, pero el sitio es estático y no puede consultarla en el build.

---

## Seguridad, fuentes y Ajustes de cuenta (21 de agosto de 2026)

Tanda de verificación y optimización sobre el repo recién clonado.

### Lo que se cerró de la lista de pendientes

- **`ws` 8.18.0 → 8.21.3.** Eran los dos avisos altos ya anotados (divulgación de
  memoria y DoS por fragmentos diminutos). `vite` 6.0.7 → 6.4.3 por el aviso del
  dev server de esbuild (solo afectaba a desarrollo). `npm audit` queda en cero.
- **`apps/web` ya no pide las fuentes a Google.** Mismo enfoque Fontsource que
  `apps/marketing`: `@fontsource-variable/inter` y `@fontsource-variable/bricolage-grotesque`
  importados en `main.tsx`, `<link>` de Google fuera de `index.html`, y los tokens
  de `styles.css` apuntan a las familias "… Variable" con las viejas de respaldo.
  Verificado: 10 `.woff2` en `dist/assets` y ni una URL externa.
- **Medidor de prueba del micrófono en Ajustes → Voz** (pendiente desde la tanda de
  voz). Botón que arranca `getUserMedia` + `AnalyserNode` y pinta una barra con el
  nivel RMS. Nada sale del equipo; cambiar de aparato con la prueba en marcha la
  reinicia con el nuevo; se suelta el micrófono al desmontar. De paso, conceder el
  permiso destapa los nombres de los aparatos.

### Cuenta: contraseña que ya existe y dueño sin contraseña

- **Nuevo `POST /api/v1/users/me/password`**: pide la contraseña actual, revoca las
  demás sesiones (cambiarla ES la palanca ante una fuga) y devuelve tokens nuevos
  para la sesión que hizo el cambio, que sigue dentro sin relogin. Rate limit igual
  que el login. Cubierto por `password.test.ts` (2 tests, 46 en total en verde).
- **`SelfUser.has_password` (protocolo, aditivo).** La pestaña Cuenta decide con eso,
  no con `kind === "guest"`: el agujero era que quien pone en marcha la instancia es
  `local` sin contraseña y no veía NINGUNA forma de ponerla desde Ajustes. Ahora
  "convertir en cuenta permanente" sale para cualquier cuenta sin contraseña (con el
  usuario prellenado) y "cambiar la contraseña" para las que ya la tienen.
- La clave de Klipy en `klipy-key.ts` es pública **a propósito** (confirmado por quien
  lidera); solo se le añadió la anotación `: string` porque el tipo literal rompía el
  `!== ""` de `api.ts` en typecheck.

### Bundle

- **`lottie-web` pasó a import dinámico** en `AnimatedEmoji.tsx`: el motor solo se
  descarga la primera vez que un emoji animado entra en pantalla. El bundle
  principal bajó de 854 a 681 kB (gzip 256 → 207); lottie queda en un chunk aparte
  de 169 kB que la mayoría de cargas nunca pide.
- `motion` (~35 kB) volvió a entrar como dependencia para `icons.tsx` en algún
  momento posterior a la nota que decía haberlo evitado con CSS. No se tocó: los
  iconos se usan en toda la interfaz y no hay dónde partirlos.

### Verificación de esta tanda

`npm run typecheck` limpio (había 1 error real, el de Klipy), `npm test` 46/46,
`npm audit` 0 vulnerabilidades, build del cliente sin URLs externas, y smoke test
de producción real: instancia arrancada con `AUTH_SECRET`, `/health` y `/api/v1/info`
respondiendo, registro + cambio de contraseña por curl con tokens nuevos.

**Sigue pendiente de antes:** LICENSE con AGPL-3.0, reordenar canales arrastrando,
FTS5 para búsqueda, og:image y URL real del repo en el sitio público.

## Vídeo con prioridad, y limpieza de datos (21 de agosto de 2026, segunda tanda)

- **Bug encontrado y corregido:** el `PUT /api/v1/instance/relay` filtraba el cuerpo
  por lista blanca y `video`, `quality` (y el nuevo `priority`) no estaban en ella —
  el selector de calidad y el modo de vídeo de Ajustes **guardaban en el vacío**
  desde siempre. El cliente los mandaba, el servidor los tiraba, y la respuesta
  devolvía lo de antes.
- **Nueva opción "Qué priorizar"** en Ajustes → Voz, junto al techo de calidad:
  `fluid` / `balanced` / `sharp`. El techo dice CUÁNTO; esto dice QUÉ SACRIFICAR.
  Atraviesa los dos caminos: en WebRTC directo gobierna `degradationPreference` y
  `contentHint`; en modo instancia ajusta el perfil de `relay.ts` (nitidez = mitad
  de fps al mismo bitrate → el doble de bits por fotograma; fluidez = ⅔ de
  resolución de cámara, la pantalla no se reduce porque el texto se vuelve
  ilegible). `balanced` conserva el comportamiento de siempre (cámara-movimiento,
  pantalla-detalle). Se guarda en el mismo `voice_relay` de la instancia.
- **`-webkit-text-stroke: 0.4px #fff`** en el textarea del compositor (Chat.tsx):
  fuera. Ponía un borde blanco a cada letra y en tema claro se veía lavado.
- **Diálogo de instancia: almacenamiento con espacio libre** (`storage_free_mb` en
  `InstanceHealth`, vía `statfsSync`; en GB/TB legibles) y **sección "Limpiar
  datos"** solo para quien hospeda: `POST /api/v1/instance/purge` borra mensajes y
  sus archivos de TODAS las comunidades y deja comunidades, miembros, roles,
  canales, emojis y avatares (solo adjuntos con `message_id NOT NULL`, justo por el
  aviso que ya estaba en db.ts sobre los adjuntos de personalización). Dos pasos
  con advertencia en la interfaz, constancia en la auditoría de cada comunidad, y
  evento nuevo **`MESSAGES_PURGED`** para que los clientes conectados vacíen el
  canal en vivo en vez de enseñar una conversación que ya no existe.
- Verificación: typecheck limpio, **47/47 tests** (nuevo `purge.test.ts`), build ok.

## Editor de perfil estilo Discord (21 de agosto de 2026, tercera tanda)

Pedido con capturas del editor de perfil de Discord como referencia explícita.

- **`ProfileTab` pasó de formulario vertical a editor de dos columnas:** carril de
  categorías plegables a la izquierda (acordeón, una abierta a la vez) y
  **`ProfileCardPreview`** —la tarjeta grande y viva— fija a la derecha con el
  botón de guardar debajo. Cada cabecera del carril enseña la elección ACTUAL en
  miniatura (avatar con su aro, chip de la placa, muestra del gradiente, "Ag" con
  la fuente elegida), que es lo que hace legible el carril sin abrir nada.
- Categorías: Identidad (nombre, pronombres, bio, acento) · Avatar y decoración
  (subida + galería + aros + decoración propia) · Banner (subida + dos galerías)
  · Placa · Estilo del nombre (fuente/efecto/color) · Tema del perfil (gradiente)
  · Efecto de la tarjeta. **Sin tienda, sin candados, sin "exclusivo de"**: la
  estructura es la de Discord, el modelo no (§10, §29.6).
- `ProfileStyleEditor` desapareció: `ProfileStyle.tsx` ahora exporta piezas
  (`ProfileCardPreview`, `AvatarDecoPicker`, `PlatePicker`, `NameStylePicker`,
  `CardEffectPicker`, `GradientControls`) y Settings compone el acordeón.
  `cardBackground`/`effectClass`/`profileSurfaceBackground` intactos (los usan
  Members y UserBar).
- La tarjeta enseña además el punto de presencia y "Miembro desde" con
  `created_at` formateado al locale.
- **Verificado en navegador real** con `scripts/shot.mjs` + `EVAL` para abrir el
  modal por CDP (truco: el aria-label del engranaje cambia por idioma —
  "Ajustes"/"Configurações" — el selector va por regex). Captura correcta a
  1400×900: carril, acordeón abierto, tarjeta viva y guardar visibles.

## Auditoría de lo entregado (21 de agosto de 2026, cuarta tanda)

Revisión pedida expresamente («analiza qué hiciste mal») sobre las tres tandas.
Lo que estaba mal y quedó corregido:

- **Revocar sesiones no cerraba sus sockets.** El cambio de contraseña (nuevo) y
  el «cerrar sesión en todos los dispositivos» (preexistente) borraban las filas
  de `sessions`, pero un gateway ya conectado seguía recibiendo eventos con una
  sesión que no existía: la expulsión era mentira en vivo. Nuevo
  `disconnectUser()` en gateway.ts, llamado en los dos endpoints; cada cliente
  reintenta con su token guardado (el nuevo entra, el revocado cae al login).
  El test de contraseña ahora abre un socket real y comprueba el cierre 4001.
- **La vista previa del perfil quedaba DEBAJO de todas las secciones en pantalla
  estrecha**: se editaba a ciegas. `order-first lg:order-last` — en móvil la
  tarjeta va arriba, como en la referencia.
- **«Aros incluidos» y «Tu propia decoración» eran dos secciones para una sola
  decisión** (lo señaló quien lidera). Además `Avatar` pinta ambas capas a la
  vez: apiladas eran un borrón. Ahora es UN catálogo «Decoración del avatar»:
  Ninguno · casilla de subida propia · los 39 aros, mutuamente excluyentes
  (elegir aro limpia la propia y al revés).
- **`toFixed(1)` en el espacio libre del disco**: separador decimal fijo en
  punto. Ahora `Intl.NumberFormat(locale)`.
- Verificado además en esta pasada: `statfsSync` funciona en Windows (el /health
  real devuelve `storage_free_mb`), typecheck limpio, **47/47 tests**, audit 0,
  build ok, y captura nueva del catálogo unificado en navegador real.

Deudas conocidas que se dejaron a propósito (anotadas, no corregidas):
- `PurgeData` y `ShareInstance` hacen cada uno su `GET /instance/tunnel` para
  saber si eres anfitrión: dos peticiones al abrir el diálogo. Barato, pero feo.
- Tras limpiar datos, las cifras de almacenamiento del diálogo abierto no se
  refrescan hasta el próximo READY (reconexión): el caché se invalida en el
  servidor, no en el cliente.

- **Quinta tanda (mismo día):** «Tu banner» y «Placa del nombre» unificadas en
  UNA sección «Banner y placa» (pedido explícito): los dos son el fondo sobre el
  que va tu nombre — el banner en la tarjeta, la placa en la lista de miembros.
  La cabecera enseña las dos miniaturas. El carril queda en seis categorías:
  Identidad · Avatar y decoración · Banner y placa · Estilo del nombre · Tema ·
  Efecto de la tarjeta. Verificado en navegador (captura con la sección abierta).

---

## Descarga de Windows en el sitio público (21 de agosto de 2026)

Se pidió publicar el binario de escritorio desde el sitio. La decisión de distribución
la tomó quien lidera el proyecto y no es la que recomendaría por defecto.

### Decisiones de esta tanda

| Decisión | Por qué | Qué se descartó |
|---|---|---|
| **MediaFire como único origen de descarga**, enlazado desde `/[lang]/install/` | Decisión explícita del proyecto | **GitHub Releases**, que se ofreció como principal (sin anuncios ni esperas, y es el feed que ya lee `electron-updater`). Se descartó a propósito |
| **El `.zip` se enlaza, no se sirve** desde el sitio | 246 MB no caben en el repo ni en la capa gratuita de Pages | Subir el binario al repositorio |
| **Tres pasos numerados con contador CSS** (`counter-increment`) en vez de números en el marcado | El orden lo pone la hoja de estilos; reordenar no toca el HTML ni las tres traducciones | Escribir «1/2/3» en cada idioma |
| **Una columna o tres, nunca dos** (`@media (min-width: 60rem)`) | Con `auto-fit` salían dos columnas a 768 px y el tercer paso se quedaba huérfano con medio grid vacío | `repeat(auto-fit, minmax(15rem, 1fr))` |
| **Se dice en la página que Windows va a avisar** («Windows protegió tu PC») | El build no está firmado y SmartScreen lo marca. Callarlo hace que parezca un virus; §29.3 pide no ocultar limitaciones | Dejar que el usuario se lo encuentre |
| **La tarjeta «Escritorio — en camino» se borró** | Decía que la app era Tauri y que no había binarios. Las dos cosas eran falsas: es Electron y ya se descarga | Actualizarla y dejarla duplicando el bloque de descarga |

### Qué hay dentro del `.zip` (verificado, no supuesto)

`Distop.zip` son **258 342 801 bytes** y su raíz es `release/`, o sea la carpeta de
salida de electron-builder tal cual:

```text
release/
├── Distop Setup 0.1.0.exe        ← el instalador que enlaza la web
├── Distop Setup 0.1.0.exe.blockmap
├── builder-debug.yml
├── latest.yml
└── win-unpacked/                 ← además, la versión portable
```

Se comprobó **sin descargar los 246 MB**: se resolvió el enlace directo de MediaFire,
se leyó el `End of Central Directory` con una petición de rango sobre los últimos
64 KB (1093 entradas) y luego el directorio central completo (147 546 bytes desde el
offset 258 195 233). Vale la pena recordar el truco: el índice de un zip está al final,
así que se puede listar un archivo remoto entero bajando dos rangos pequeños.

### Pendiente de esta tanda

- **El `.zip` publicado pesa 2,5× lo necesario.** Lleva `win-unpacked/` (408 MB sin
  comprimir) *además* del instalador, que ya contiene lo mismo. Solo con el `.exe`
  serían ~101 MB. Se mantuvo porque es el archivo que ya está subido, y la página
  aprovecha la carpeta portable como alternativa de «no instalar nada».
- **`builder-debug.yml` viaja dentro del zip y lleva rutas absolutas de la máquina de
  compilación** (con el nombre de usuario de Windows). No es una credencial, pero no
  pinta nada en una descarga pública. Al regenerar el zip, fuera.
- **El enlace de MediaFire es una constante en `install.astro`** (`DOWNLOAD_URL`). Cada
  versión nueva es un archivo nuevo con otra URL: hay que editarla a mano. Si esto se
  repite, el sitio de descarga debería salir de un solo archivo de configuración.
- **La versión está escrita a mano en tres sitios** del texto de instalación
  («Distop Setup 0.1.0.exe» en `es`, `en` y `pt-BR`) y en `meta` («246 MB»). Al publicar
  0.2.0 hay que tocar los tres idiomas.

---

## Despliegue del sitio en Vercel (22 de agosto de 2026)

Se pidió sacar `apps/marketing` a un repositorio aparte «para poder ponerlo en Vercel».
**No hizo falta:** Vercel tiene un campo *Root Directory* que apunta a una carpeta del
repo, así que el sitio se despliega desde el monorepo y no hay dos copias que
desincronizar. Se ofreció el repo aparte y se descartó por eso.

### Ajustes del proyecto en Vercel

```text
Repository:       Superkirbo64/Distop-open-source
Root Directory:   apps/marketing
Framework Preset: Astro          (se autodetecta)
Build Command:    npm run build  (por defecto)
Output Directory: dist           (por defecto)
Node.js Version:  22.x
```

**«Include files outside of the Root Directory» tiene que quedarse activado** (viene
así): son workspaces de npm y la instalación ocurre en la raíz del repo, no dentro de
`apps/marketing`.

### Decisiones de esta tanda

| Decisión | Por qué | Qué se descartó |
|---|---|---|
| **Desplegar desde el monorepo** con Root Directory | Un solo sitio donde vive el código. Cada push a `main` redespliega | Repo `distop-site` aparte, que obligaba a duplicar o sincronizar el sitio a mano |
| **`engines.node: ">=22.12.0"` en `apps/marketing/package.json`** | La raíz declara `>=24` porque el node-server lo necesita (`node:sqlite`, TS sin compilar). Vercel no ofrece Node 24, y leyendo el `engines` del proyecto habría fallado el build. Astro 7 pide 22.12 | Bajar el `>=24` de la raíz, que rompería el servidor |
| **`vercel.json` con `trailingSlash: true`** | Astro genera las rutas con barra final (`trailingSlash: "always"`). Sin decírselo a Vercel, cada página existiría con y sin barra: contenido duplicado para Google | Dejar el valor por defecto |
| **Redirección `/` → `/es/` como 307 en `vercel.json`** | En estático, Astro resuelve esa redirección con un `<meta refresh>` y `noindex`. Un 307 real es más rápido y lo entienden los buscadores | Un 301/308 permanente: el navegador lo cachea para siempre y hoy la elección de idioma por defecto todavía puede cambiar |
| **La redirección de Astro se queda además de la de Vercel** | §16.1 admite también Cloudflare Pages y Netlify. Quitarla ataría el sitio a Vercel | Borrar `redirects` de `astro.config.mjs` |

### Cosas que hay que saber antes de tocar esto

- **`npm ci` falla en Windows con `EPERM` sobre `astro.win32-x64-msvc.node`**: es un
  binario nativo que algún proceso de Node tiene mapeado (editor, servidor de lenguaje,
  un `astro check` anterior). No dice nada del despliegue, que corre en Linux. Para
  validar la sincronía del lockfile sin tocar el disco: **`npm ci --dry-run`**.
- **Un `npm ci` interrumpido deja `node_modules` a medias** (se quedó en 51 entradas de
  527). Se repara con `npm install`, pero si algo falla justo después de un `ci` cortado,
  mira eso antes de buscar la causa en otro sitio.
- **Los demonios de esbuild del repo bloquean `node_modules`.** Se cierran sin miedo:
  se relanzan solos cuando un build los necesita.

### Pendiente

- **`site: "https://distop.app"` en `astro.config.mjs` sigue siendo un marcador.** De ahí
  salen las URL canónicas, así que mientras el sitio viva en `*.vercel.app` los canónicos
  apuntan a un dominio que todavía no sirve nada. O se compra y se apunta el dominio, o
  se cambia esa línea por la dirección real de Vercel.

---

## El sitio deja de hablar como documentación (22 de agosto de 2026)

Se pidió quitar **todo** el tecnicismo: el público es gente que juega, no gente
que programa, y lo único que quiere es abrir la aplicación y probarla. El aviso
concreto fue «en un NAS o en una Raspberry», pero el problema era el sitio entero.

### La regla que se aplicó

**Fuera el vocabulario, dentro la verdad.** Borrar que la comunidad vive en el PC
de alguien sería vender lo que la aplicación no hace, y §29.6 prohíbe justamente
eso. Así que «tu comunidad funciona mientras tu PC esté encendido, igual que un
servidor de Minecraft montado en casa» se queda: dice lo mismo que «instancia
self-hosted» sin pedirle a nadie que busque una palabra.

| Antes | Ahora |
|---|---|
| «en un NAS o en una Raspberry» | (fuera) |
| «Node 24 · SQLite · Docker opcional» | «Windows 10 y 11 · No necesitas instalar nada más» |
| «malla WebRTC», «haría falta un SFU» | «el audio va directo de una persona a otra» |
| «la instancia», «self-hosted» | «tu PC», «el equipo donde lo abriste» |
| «scrypt y tokens opacos» | «cerrar una sesión la cierra de verdad» |
| «abre un túnel de Cloudflare con HTTPS» | «un botón te da una dirección para compartir» |
| «Activa TRUST_PROXY=true…» | sustituido por «cuánta gente aguanta» |
| «Internal Server Error… depurar» | «no hay nadie al otro lado» |

### Decisiones de esta tanda

| Decisión | Por qué | Qué se descartó |
|---|---|---|
| **Docker y Node dentro de un `<details>`** en la página de descarga | No desaparecen: se apartan. Quien juega no los ve nunca; quien los busca los abre a la primera. El navegador ya sabe plegar, cerrar con Escape y anunciarlo | Borrar esas dos formas de instalar, que dejaría tirado a quien monta el servidor a mano |
| **El `docker-compose.yml` sale de la portada** | Un archivo de configuración era lo tercero que veía un visitante | Dejarlo «porque demuestra que es abierto» |
| **La captura del hero, rehecha entera** | Era el mayor infractor y lo primero que se ve: la conversación de dentro hablaba de SFU, Raspberry, SQLite e «instancia», y la comunidad se llamaba «Taller Píxel» | Recortar la imagen o taparla |
| **`scripts/seed.mjs` vuelve al repo** | La captura es la aplicación de verdad (§25). El script que la sembraba se había perdido, así que rehacer la imagen era imposible sin reescribirlo | Un montaje en un editor de imágenes |
| **«Hospedar» pasa a llamarse «Cómo funciona»** en la navegación | «Hospedar» ya es media palabra técnica | Dejar el nombre |
| **AGPL-3.0 se queda solo en la línea legal del pie** | Es un aviso legal, no texto de venta. Fuera del hero y del enlace de licencia | Quitarlo del todo, que sería incumplir la licencia |
| **«router» se queda** | Quien juega sabe lo que es su router: abrió puertos para Minecraft alguna vez. Es vocabulario de casa, no de programador | Buscarle un rodeo que sonara raro |

### Cómo se rehace la captura del hero

```text
1. Instancia aparte, nunca la base real:
   PORT=5055 DATABASE_PATH=<scratchpad>/app.db AUTH_SECRET=… node server.ts
2. node scripts/seed.mjs http://127.0.0.1:5055   → imprime el token
3. node scripts/shot.mjs http://127.0.0.1:5055/ chat.png 1440 900 <token>
4. Copiar a apps/marketing/public/shots/chat.png, parar la instancia y borrar sus datos.
```

`seed.mjs` registra cuatro personas de verdad por la API, crea «La Partida», mete
al resto por invitación y escribe la conversación. El nombre de usuario lleva un
sufijo de tiempo para poder sembrar dos veces sin chocar.

### Verificación

Rastreo automático de 26 términos técnicos sobre el **HTML servido** de las 16
páginas, descontando lo que vive dentro del `<details>`: **cero**. Ojo con el
rastreo ingenuo: buscar «NAS» encuentra «perso**nas**» y «TURN» encuentra «**turn**
it off», así que la comprobación usa límites de palabra. `astro check` limpio,
que es lo que garantiza que los tres idiomas siguen teniendo las mismas claves.

### Pendiente

- **La aplicación en sí sigue hablando técnico** en algunos sitios (Ajustes,
  Estado de la instancia, mensajes de error). Esta tanda solo tocó el sitio público.
- La captura se queda desfasada cada vez que cambie la interfaz. Ahora al menos
  hay un guion para rehacerla en tres órdenes.

---

## La descarga pasa a ser el .exe suelto (22 de agosto de 2026)

Se subió a MediaFire el instalador solo, en vez del `.zip` con la carpeta
`release/` entera. Eso resuelve los dos pendientes de la tanda anterior: la
descarga baja de 246 MB a **101 MB** y `builder-debug.yml`, que llevaba rutas
absolutas de la máquina de compilación, ya no viaja con ella.

- **URL nueva**: `mediafire.com/file/s4na7z6ka0estct/Distop_Setup_0.1.0.exe/file`
- **Verificado, no supuesto**: 105 487 954 bytes y `content-type:
  application/x-dosexec`, y coincide byte a byte con el instalador construido
  aquí — comparados tres trozos de 2 KB (principio, mitad y final) contra el
  archivo local, sin descargar los 100 MB.

### Qué cambió en el texto

- **De tres pasos a dos**: ya no hay nada que descomprimir. También se corrigió
  la frase de la portada que decía «descargas, descomprimes y doble clic».
- **Fuera el aviso de la carpeta portable** y sus claves `portableTitle` /
  `portableBody` en los tres idiomas: `win-unpacked/` ya no viaja en la descarga,
  así que ofrecerla sería mentir.
- **El aviso de Windows menciona ahora también al navegador**: al ser un `.exe`
  suelto, Chrome o Edge preguntan si conservar el archivo *antes* de que aparezca
  la pantalla azul de SmartScreen. Quien no lo espera piensa que es un virus.

### Lo que se vio mirando

La rejilla de pasos estaba fijada a `repeat(3, 1fr)`, así que al quedarse en dos
dejaba una tercera columna vacía. Ahora usa `grid-auto-flow: column` con
`grid-auto-columns: 1fr`: tantas columnas como pasos haya. Aguanta si mañana
vuelven a ser tres.

### Pendiente

- **La URL de MediaFire sigue escrita a mano en `install.astro`** y la versión,
  en los tres idiomas. Publicar 0.2.0 son cuatro sitios que tocar.
