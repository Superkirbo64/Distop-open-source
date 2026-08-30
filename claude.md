# AGENT.md — Plataforma de comunicación comunitaria open source

## 1. Identidad del proyecto

Este proyecto consiste en crear una plataforma de comunicación comunitaria open source inspirada en las principales funcionalidades de Discord, pero sin sistemas de monetización que bloqueen funciones, personalización, calidad, almacenamiento o ventajas sociales.

La plataforma deberá funcionar en:

* Navegadores web.
* Aplicación de escritorio para Windows.
* Futuramente Linux y macOS.
* Futuramente dispositivos móviles.

El proyecto no debe ser una copia visual exacta de Discord. Debe construir una identidad propia, una experiencia moderna y una arquitectura orientada a comunidades independientes.

Nombre temporal del proyecto:

```text
Open Community Platform
```

El nombre, identidad visual, colores, logotipo y terminología interna deberán ser fáciles de modificar.

---

## 2. Visión principal

Construir una plataforma gratuita, abierta, modular y completamente personalizable donde cualquier usuario pueda:

* Crear una comunidad.
* Crear servidores, espacios o grupos.
* Crear canales de texto.
* Crear canales de voz.
* Crear categorías.
* Invitar miembros mediante enlaces.
* Asignar roles y permisos.
* Personalizar visualmente su comunidad.
* Compartir archivos.
* Crear integraciones.
* Instalar bots, aplicaciones y extensiones.
* Hospedar por cuenta propia los servicios de su comunidad.
* Conectar servidores externos como Minecraft.
* Administrar una infraestructura comunitaria sin depender obligatoriamente de un servicio central pago.

La plataforma no debe tener mecánicas como:

* Suscripciones para desbloquear personalización.
* Pago para usar avatares animados.
* Pago para usar fondos de perfil.
* Pago para mejorar la calidad de audio.
* Pago para mejorar la calidad de video.
* Pago para aumentar límites artificiales.
* Pago para destacar perfiles.
* Pago para obtener emojis adicionales.
* Pago para acceder a temas.
* Pago para crear comunidades más grandes.
* Ventajas sociales o administrativas adquiridas mediante dinero.

Todas las funciones esenciales y de personalización deben ser gratuitas.

---

## 3. Contexto y restricciones actuales

El proyecto comienza sin presupuesto recurrente.

Actualmente no se puede depender de:

* Servidores VPS pagos.
* Bases de datos comerciales.
* Almacenamiento ilimitado.
* Servicios de video pagos.
* Infraestructura centralizada costosa.
* Servicios con cobro obligatorio por usuario.
* APIs cuya capa gratuita sea demasiado limitada.
* Soluciones que generen gastos inesperados.

La primera versión deberá utilizar, siempre que sea viable:

* Servicios gratuitos.
* Software open source.
* Infraestructura distribuida.
* Self-hosting realizado por los propios usuarios.
* Deploy vinculado a GitHub.
* Cloudflare o Vercel para el frontend.
* Bases de datos gratuitas o ejecutadas por el propio usuario.
* Tecnologías que puedan ejecutarse localmente.
* Límites técnicos transparentes, no límites comerciales artificiales.

La arquitectura deberá evitar que el propietario de la plataforma tenga que pagar por el tráfico, archivos, llamadas, mensajes y servidores de todas las comunidades.

---

## 4. Modelo general de arquitectura

La plataforma deberá utilizar una arquitectura híbrida.

Existirán dos componentes principales:

### 4.1 Plataforma central

La plataforma central será responsable de:

* Página pública del proyecto.
* Aplicación web principal.
* Registro opcional de usuarios.
* Inicio de sesión opcional con Google.
* Descubrimiento de comunidades públicas.
* Documentación.
* Gestión básica de identidad.
* Gestión de leads.
* Telemetría respetuosa con la privacidad.
* Google Analytics, cuando corresponda.
* Listado de nodos self-hosted.
* Resolución de enlaces de invitación.
* Actualizaciones del cliente.
* Distribución del software.
* Panel para conectar un servidor propio.
* Metadatos mínimos de las instancias conectadas.

La plataforma central no debe almacenar obligatoriamente:

* Todo el historial de mensajes.
* Todos los archivos.
* Todo el audio.
* Todo el video.
* Todos los datos privados de cada comunidad.
* Todas las credenciales de servidores externos.

La plataforma central deberá mantenerse ligera para poder operar inicialmente en capas gratuitas.

### 4.2 Instancias self-hosted

Cada usuario, administrador o comunidad podrá ejecutar su propia instancia.

La instancia self-hosted será responsable de:

* Servidores o comunidades del usuario.
* Canales.
* Mensajes.
* Archivos.
* Miembros.
* Roles.
* Permisos.
* Bots.
* Integraciones.
* Configuraciones.
* Historial.
* Logs.
* Servicios de voz.
* Servicios de video.
* Conexiones con servidores de juegos.
* Automatizaciones.
* Base de datos local.
* Almacenamiento de archivos.

Cada instancia deberá poder ejecutarse mediante:

* Docker.
* Docker Compose.
* Un ejecutable simplificado.
* Un instalador para Windows.
* Un script de instalación.
* Un servidor Linux.
* Una computadora personal.
* Un mini PC.
* Un NAS.
* Una Raspberry Pi, cuando la capacidad lo permita.

---

## 5. Principio de self-hosting

El self-hosting es uno de los pilares fundamentales del proyecto.

Un usuario deberá poder instalar un nodo o instancia local y conectar esa instancia a la plataforma principal.

El flujo ideal será:

1. El usuario crea una cuenta o entra como invitado.
2. El usuario elige “Crear comunidad”.
3. El sistema ofrece dos modalidades:

   * Conectar una instancia existente.
   * Instalar una nueva instancia.
4. El usuario instala el servicio mediante Docker, instalador o ejecutable.
5. La instancia genera un identificador único.
6. La instancia obtiene una URL pública o dirección accesible.
7. El usuario vincula esa URL con su comunidad.
8. La plataforma verifica la instancia.
9. El administrador crea un enlace de invitación.
10. Otros usuarios acceden mediante ese enlace.

Ejemplo conceptual:

```text
https://app.example.com/invite/mi-comunidad
```

La plataforma podrá resolver el enlace y conectar el cliente con la instancia correspondiente.

La instancia también podrá utilizar un enlace directo:

```text
https://community.example.com
```

o:

```text
https://node-user.example.net
```

o una dirección generada mediante túnel:

```text
https://random-subdomain.tunnel-provider.example
```

---

## 6. Conectividad de instancias locales

Muchos usuarios no podrán abrir puertos en el router.

La plataforma deberá contemplar mecanismos simplificados para publicar instancias locales.

Opciones posibles:

* Cloudflare Tunnel.
* Túneles reversos open source.
* Tailscale Funnel.
* Pangolin.
* FRP.
* Rathole.
* Servidores relay opcionales.
* Dominio propio.
* Proxy reverso.
* Apertura manual de puertos.

La opción recomendada para usuarios sin conocimientos técnicos deberá ser un asistente automático.

Ejemplo:

```text
Conectar mi servidor local
```

El asistente deberá:

1. Detectar el sistema operativo.
2. Instalar o configurar el agente.
3. Crear el túnel.
4. Generar una URL.
5. Verificar HTTPS.
6. Registrar la instancia.
7. Mostrar el enlace de invitación.
8. Explicar cuándo la instancia está online u offline.

La interfaz debe explicar claramente:

* La comunidad estará disponible mientras el equipo anfitrión esté encendido.
* La velocidad dependerá de la conexión del anfitrión.
* Los archivos ocupan espacio en el dispositivo anfitrión.
* Las llamadas pueden consumir ancho de banda.
* El administrador es responsable de realizar copias de seguridad.

---

## 7. Modos de funcionamiento

La aplicación deberá admitir varios modos.

### 7.1 Modo invitado

Permite acceder a una comunidad sin cuenta central, cuando el administrador lo autorice.

El usuario podrá:

* Elegir un nombre temporal.
* Entrar mediante un enlace.
* Participar según los permisos.
* Mantener una sesión local.
* Convertir posteriormente la sesión en una cuenta.

### 7.2 Cuenta local

La identidad se almacena en el dispositivo o en la instancia.

No requiere Google.

Puede utilizar:

* Usuario y contraseña.
* Clave de acceso.
* Magic link.
* Identidad local.
* Certificado del dispositivo.

### 7.3 Cuenta central

Permite:

* Sincronizar comunidades.
* Recuperar acceso.
* Mantener una lista de servidores.
* Utilizar la misma identidad en varios dispositivos.
* Recibir actualizaciones.
* Administrar varias instancias.

### 7.4 Inicio con Google

El inicio con Google debe ser opcional.

No debe bloquear el uso de la plataforma.

Sus objetivos iniciales serán:

* Facilitar el registro.
* Reducir la fricción de entrada.
* Medir interés real.
* Conocer el número aproximado de usuarios.
* Crear una base de leads.
* Recuperar cuentas.
* Sincronizar perfiles.

Siempre deberá existir una alternativa que no dependa de Google.

---

## 8. Leads, analítica y privacidad

La plataforma podrá utilizar Google Analytics en:

* Landing page.
* Documentación.
* Pantallas públicas.
* Flujo de onboarding.
* Descargas.
* Conversión de visitantes en usuarios.
* Creación de instancias.
* Conexión de nodos.

No se debe utilizar Google Analytics para registrar:

* Contenido de mensajes.
* Contenido de llamadas.
* Archivos privados.
* Nombres de canales privados.
* Credenciales.
* Tokens.
* Direcciones privadas.
* Contenido sensible de las comunidades.

La analítica debe poder desactivarse.

El sistema deberá incluir:

* Banner de consentimiento cuando sea necesario.
* Política de privacidad.
* Política de cookies.
* Opción de exclusión.
* Configuración de telemetría.
* Modo sin analítica.
* Variables de entorno para activar o desactivar proveedores.

Eventos útiles:

```text
landing_view
signup_started
signup_completed
google_login_used
guest_mode_used
instance_install_started
instance_connected
community_created
invite_created
desktop_app_downloaded
minecraft_integration_started
```

No enviar datos privados dentro de los eventos.

---

## 9. Características esenciales de comunicación

### 9.1 Comunidades

Cada comunidad podrá tener:

* Nombre.
* Ícono.
* Banner.
* Descripción.
* Color principal.
* Tema.
* URL personalizada.
* Reglas.
* Imagen de portada.
* Categorías.
* Canales.
* Roles.
* Integraciones.
* Miembros.
* Página pública opcional.

### 9.2 Canales de texto

Los canales de texto deberán soportar progresivamente:

* Mensajes en tiempo real.
* Respuestas.
* Hilos.
* Reacciones.
* Menciones.
* Emojis.
* Emojis personalizados.
* Markdown.
* Bloques de código.
* Archivos.
* Imágenes.
* Videos.
* Audios.
* Mensajes fijados.
* Edición.
* Eliminación.
* Búsqueda.
* Historial.
* Indicador de escritura.
* Estado leído o no leído.
* Notificaciones.
* Webhooks.
* Comandos.

### 9.3 Mensajes directos

Los usuarios podrán tener:

* Conversaciones privadas.
* Conversaciones grupales.
* Bloqueo de usuarios.
* Solicitudes de mensaje.
* Controles de privacidad.
* Llamadas privadas.
* Compartición de archivos.

Los mensajes directos no deben depender obligatoriamente de un servidor comunitario específico.

La implementación podrá comenzar mediante un servicio central mínimo o mediante almacenamiento federado.

### 9.4 Voz

Los canales de voz deberán incluir progresivamente:

* Entrada y salida de audio.
* Silenciar micrófono.
* Ensordecer.
* Selección de dispositivo.
* Control de volumen individual.
* Detección de voz.
* Push-to-talk.
* Indicador de usuario hablando.
* Cancelación de eco.
* Supresión de ruido.
* Reconexión automática.
* Permisos por canal.

Para comunicación en tiempo real, considerar:

* WebRTC.
* LiveKit self-hosted.
* mediasoup.
* Janus.
* Pion.
* SFU self-hosted.

No implementar una infraestructura central de voz costosa en la primera etapa.

### 9.5 Video y pantalla

Soporte futuro:

* Cámara.
* Compartir pantalla.
* Selección de ventana.
* Selección de monitor.
* Resolución ajustable.
* Tasa de cuadros ajustable.
* Vista en cuadrícula.
* Vista del hablante.
* Transmisión dentro de canales.

La calidad disponible dependerá de la infraestructura del host, no de una suscripción.

---

## 10. Personalización completamente gratuita

Toda la personalización deberá estar disponible sin pago.

### 10.1 Perfil del usuario

* Avatar.
* Banner.
* Biografía.
* Pronombres opcionales.
* Estado.
* Color del perfil.
* Tema del perfil.
* Fondo.
* Marco.
* Insignias de comunidad.
* Enlaces.
* Avatar animado.
* Banner animado.
* Efectos visuales opcionales.
* CSS limitado y seguro.
* Perfil diferente por comunidad.

### 10.2 Interfaz

* Tema claro.
* Tema oscuro.
* Tema automático.
* Temas personalizados.
* Variables de color.
* Tamaño de fuente.
* Densidad.
* Espaciado.
* Bordes.
* Radio de elementos.
* Tipografía.
* Fondos.
* Sonidos.
* Animaciones.
* Reducción de movimiento.
* Disposición de paneles.
* Barra lateral configurable.
* Componentes movibles.

### 10.3 Comunidades

* Banner animado.
* Ícono animado.
* Emojis personalizados ilimitados, según el almacenamiento del host.
* Stickers personalizados.
* Temas.
* Fondos.
* Sonidos.
* Nombres personalizados para roles.
* Pantallas de bienvenida.
* Página pública.
* Dominio personalizado.
* CSS seguro.
* Plantillas.

Los límites deberán depender de:

* Almacenamiento disponible.
* Memoria.
* CPU.
* Ancho de banda.
* Configuración del administrador.

Nunca de una suscripción artificial.

---

## 11. Roles y permisos

El sistema de permisos deberá ser granular.

Permisos sugeridos:

```text
ADMINISTRATOR
MANAGE_COMMUNITY
MANAGE_CHANNELS
MANAGE_ROLES
MANAGE_MEMBERS
KICK_MEMBERS
BAN_MEMBERS
TIMEOUT_MEMBERS
VIEW_CHANNEL
SEND_MESSAGES
MANAGE_MESSAGES
READ_HISTORY
ATTACH_FILES
EMBED_LINKS
ADD_REACTIONS
USE_CUSTOM_EMOJIS
MENTION_EVERYONE
CREATE_THREADS
MANAGE_THREADS
CONNECT_VOICE
SPEAK
MUTE_MEMBERS
DEAFEN_MEMBERS
MOVE_MEMBERS
STREAM
USE_CAMERA
MANAGE_WEBHOOKS
MANAGE_BOTS
MANAGE_INTEGRATIONS
MANAGE_GAME_SERVERS
VIEW_AUDIT_LOG
```

Los permisos deberán poder aplicarse por:

* Comunidad.
* Categoría.
* Canal.
* Rol.
* Usuario.
* Bot.
* Integración.

Debe existir un registro de auditoría.

---

## 12. Bots, plugins y extensiones

Ver la skill `plugin-architecture` (`.claude/skills/plugin-architecture/`).
Se carga sola al trabajar en bots, webhooks, plugins o integraciones.

---

## 13. Servidores de Minecraft y servicios comunitarios

Ver la skill `game-server-integration` (`.claude/skills/game-server-integration/`).
Se carga sola al trabajar en Minecraft u otros servidores de juego.

---

## 14. Aplicación web

La aplicación web será el cliente principal de la primera versión.

Requisitos:

* Responsive.
* Funcionar en escritorio.
* Funcionar razonablemente en móvil.
* Instalable como PWA.
* Soportar actualizaciones.
* Reconexión automática.
* Manejar instancias offline.
* Cargar rápidamente.
* Separar frontend, API e instancia.
* No depender de secretos expuestos en el navegador.
* Mantener caché local.
* Ofrecer modo offline limitado.

Tecnologías recomendadas:

```text
Next.js
React
TypeScript
Tailwind CSS
shadcn/ui o componentes propios
TanStack Query
Zustand
WebSocket
WebRTC
PWA
```

No utilizar una librería únicamente porque es popular. Evaluar:

* Mantenimiento.
* Licencia.
* Tamaño.
* Seguridad.
* Compatibilidad.
* Facilidad de self-hosting.
* Dependencia de servicios externos.

---

## 15. Aplicación de escritorio

La aplicación de escritorio deberá reutilizar, cuando sea viable, la interfaz web.

Opciones preferidas:

* Tauri.
* Electron, únicamente si sus ventajas justifican el consumo adicional.
* Aplicación PWA como primera alternativa.

Preferencia inicial:

```text
Tauri + frontend web compartido
```

La aplicación de escritorio deberá ofrecer:

* Notificaciones nativas.
* Inicio con el sistema.
* Actualizaciones.
* Minimizar a la bandeja.
* Push-to-talk global.
* Selección de pantalla.
* Compartición de pantalla.
* Atajos globales.
* Gestión de micrófono.
* Estado de actividad opcional.
* Instalador para Windows.
* Logs locales.
* Configuración de caché.
* Conexión con nodos locales.
* Instalación simplificada de una instancia.

El cliente y el servidor deben ser proyectos o paquetes separados.

---

## 16. Deploy inicial

### 16.1 Frontend

El frontend público podrá desplegarse inicialmente en:

* Cloudflare Pages.
* Vercel.
* GitHub Pages, únicamente para páginas estáticas.
* Netlify como alternativa.

Debe estar vinculado a GitHub.

Flujo esperado:

```text
push a main
→ CI
→ build
→ tests
→ deploy automático
```

### 16.2 API central

La API central deberá mantenerse mínima.

Opciones iniciales:

* Cloudflare Workers.
* Cloudflare Pages Functions.
* Vercel Functions.
* Supabase Edge Functions.
* Deno Deploy.
* API self-hosted cuando sea necesario.

No utilizar funciones serverless para cargas persistentes como:

* WebSocket masivo sin validar compatibilidad.
* Audio continuo.
* Video continuo.
* Servidores de juegos.
* Procesos de larga duración.
* Bases de datos embebidas persistentes.
* Procesamiento pesado.

### 16.3 Base de datos central

La base central debe almacenar únicamente información necesaria.

Opciones iniciales:

* Cloudflare D1.
* Supabase free tier.
* Neon free tier.
* Turso.
* PostgreSQL self-hosted.
* SQLite para desarrollo.

Información central posible:

* Usuarios.
* Proveedores de autenticación.
* Instancias registradas.
* Comunidades públicas.
* Invitaciones.
* Preferencias generales.
* Leads.
* Consentimientos.
* Sesiones.
* Metadatos mínimos.
* Versiones.

No almacenar de manera central todos los mensajes de todas las comunidades en la primera arquitectura.

### 16.4 Base de datos de la instancia

Cada nodo podrá utilizar:

* SQLite para instalaciones pequeñas.
* PostgreSQL para instalaciones medianas o grandes.
* Redis opcional.
* Almacenamiento local.
* S3 compatible opcional.
* MinIO.
* Cloudflare R2 opcional.
* Backblaze B2 opcional.

La configuración inicial debe funcionar con SQLite y almacenamiento local.

---

## 17. Estructura sugerida del monorepo

La disposición real se lee del repositorio (`ls apps packages`). Lo que sí
es decisión y no se deduce mirando: monorepo con pnpm/Turborepo, TypeScript,
workspaces y versiones fijadas; cliente y servidor en paquetes separados.

---

## 18. Protocolo entre clientes e instancias

La comunicación entre cliente e instancia deberá utilizar un protocolo documentado y versionado.

Ejemplo:

```text
Protocol version: v1
```

Transportes posibles:

* HTTPS.
* WebSocket.
* WebRTC.
* Server-Sent Events para casos específicos.

Cada instancia deberá exponer endpoints estandarizados. Ver `packages/protocol/src/index.ts` para la lista actual de endpoints y eventos WebSocket implementados.

Toda modificación del protocolo deberá preservar compatibilidad o incrementar la versión.

---

## 19. Federación

La arquitectura debe dejar abierta la posibilidad de federación.

Federación significa que:

* Una identidad puede interactuar con varias instancias.
* Comunidades de diferentes nodos pueden comunicarse.
* Los usuarios no necesitan crear una cuenta separada para cada servidor.
* Los nodos pueden compartir datos autorizados.
* Los administradores mantienen control de su infraestructura.

No es obligatorio implementar federación completa en el MVP.

Sin embargo:

* No acoplar las identidades a una única base central.
* No asumir que todos los canales pertenecen al mismo servidor físico.
* Utilizar IDs globalmente únicos.
* Versionar el protocolo.
* Diseñar URLs portables.
* Separar identidad, comunidad e instancia.
* Investigar compatibilidad futura con estándares abiertos.

No implementar ActivityPub o Matrix automáticamente sin analizar si cumplen las necesidades reales.

---

## 20. IDs y entidades principales

Utilizar IDs globalmente únicos, como UUIDv7 o identificadores equivalentes ordenables.

Entidades principales:

```text
User
Identity
Session
Device
Instance
Community
Membership
Role
Permission
Category
Channel
Message
Attachment
Reaction
Thread
Invite
Webhook
Bot
Plugin
VoiceRoom
VoiceSession
GameServer
GameServerTemplate
AuditLog
Notification
Theme
Profile
```

Separaciones importantes:

```text
User != Identity
Community != Instance
Channel != VoiceSession
Plugin != Bot
Central Account != Local Account
```

Una instancia puede alojar varias comunidades.

Una comunidad puede migrarse entre instancias.

---

## 21. Portabilidad y backups

El usuario debe ser propietario de sus datos.

Cada comunidad deberá poder exportarse.

Formato conceptual:

```text
community-export/
├── manifest.json
├── community.json
├── members.json
├── roles.json
├── channels.json
├── messages/
├── attachments/
├── emojis/
├── themes/
├── plugins/
└── integrations/
```

Funciones necesarias:

* Exportar comunidad.
* Importar comunidad.
* Crear backup.
* Restaurar backup.
* Programar backup.
* Descargar backup.
* Copiar a almacenamiento externo.
* Migrar entre instancias.
* Verificar integridad.

No utilizar un formato propietario imposible de leer.

---

## 22. Seguridad

La seguridad es una prioridad desde el principio.

Implementar:

* HTTPS obligatorio en producción.
* Contraseñas con Argon2id.
* Tokens de corta duración.
* Refresh tokens rotativos.
* Revocación de sesiones.
* Protección CSRF.
* Protección XSS.
* Content Security Policy.
* Rate limiting.
* Validación de entrada.
* Sanitización.
* Control de tamaño de archivos.
* Escaneo opcional.
* Logs de auditoría.
* Cifrado de secretos.
* Variables de entorno.
* Permisos mínimos.
* Protección SSRF.
* Protección contra path traversal.
* Protección contra inyección.
* CORS restrictivo.
* Validación de URLs de instancia.
* Verificación de webhooks.
* Backups.
* Bloqueo y reportes.
* Moderación.

Nunca:

* Guardar contraseñas en texto plano.
* Exponer claves en el frontend.
* Confiar únicamente en validación del cliente.
* Ejecutar plugins sin aislamiento.
* Ejecutar contenedores como root sin necesidad.
* Permitir acceso arbitrario al sistema anfitrión.
* Exponer puertos administrativos públicamente.
* Registrar tokens en logs.

---

## 23. Moderación

Cada instancia debe controlar su propia moderación.

Herramientas:

* Ban.
* Kick.
* Timeout.
* Silencio.
* Bloqueo.
* Eliminación de mensajes.
* Filtros.
* Lista de palabras.
* Modo lento.
* Verificación.
* Solicitudes de ingreso.
* Logs.
* Reportes.
* Roles de moderación.
* Auto-moderación opcional.
* Control anti-spam.
* Rate limits.
* Límites de menciones.
* Restricciones para cuentas nuevas.

La plataforma central podrá bloquear una instancia de sus sistemas de descubrimiento, pero no debe pretender controlar físicamente un nodo independiente.

Debe existir una política clara para contenido ilegal y abuso de servicios centrales.

---

## 24. Licencia open source

El código deberá publicarse bajo una licencia open source definida conscientemente.

Evaluar:

* AGPL-3.0 para exigir que modificaciones ofrecidas como servicio permanezcan abiertas.
* GPL-3.0.
* Apache-2.0.
* MPL-2.0.

Preferencia inicial:

```text
AGPL-3.0
```

Antes de confirmar la licencia definitiva, revisar compatibilidad con dependencias.

Los recursos gráficos, fuentes, sonidos y marcas pueden requerir licencias separadas.

No utilizar:

* Logotipos de Discord.
* Recursos copiados de Discord.
* Sonidos propietarios.
* Ilustraciones sin licencia.
* Código sin licencia compatible.
* Nombres que generen confusión con marcas existentes.

---

## 25. Identidad visual

La plataforma debe tener identidad propia.

Principios:

* Moderna.
* Tecnológica.
* Comunitaria.
* Amigable.
* Modular.
* Personalizable.
* Accesible.
* No parecer un clon directo de Discord.

La interfaz puede utilizar una estructura familiar:

* Barra de comunidades.
* Panel de canales.
* Área principal.
* Panel de miembros.
* Barra de usuario.
* Paneles configurables.

Pero debe mejorar:

* Uso del espacio.
* Jerarquía visual.
* Personalización.
* Accesibilidad.
* Navegación.
* Descubrimiento.
* Administración.
* Transparencia del estado del servidor.

---

## 26. Experiencia de estado self-hosted

El cliente debe explicar correctamente el estado de una instancia.

Estados:

```text
ONLINE
OFFLINE
STARTING
DEGRADED
UPDATING
MAINTENANCE
AUTHENTICATION_ERROR
VERSION_INCOMPATIBLE
CERTIFICATE_ERROR
UNREACHABLE
```

Mostrar:

* Estado.
* Última conexión.
* Latencia.
* Versión.
* Uso de CPU.
* Uso de memoria.
* Espacio disponible.
* Usuarios conectados.
* Servicios activos.
* Errores.
* Recomendaciones.

No ocultar fallos con mensajes genéricos.

---

## 27. Prioridades del MVP

El MVP no debe intentar implementar todas las funciones de Discord.

### Fase 1 — Base funcional

Construir:

* Landing page.
* Documentación.
* Repositorio.
* Autenticación opcional con Google.
* Modo invitado.
* Aplicación web.
* Instancia self-hosted.
* Docker Compose.
* SQLite.
* Creación de comunidad.
* Categorías.
* Canales de texto.
* Mensajes en tiempo real.
* Roles básicos.
* Invitaciones por enlace.
* Perfiles.
* Temas.
* Archivos pequeños.
* Registro de instancias.
* Indicador online y offline.
* Google Analytics limitado.
* Aplicación PWA.

### Fase 2 — Administración y escritorio

Construir:

* Aplicación Tauri.
* Notificaciones.
* Bandeja del sistema.
* Backups.
* Logs de auditoría.
* Permisos granulares.
* Webhooks.
* Bots iniciales.
* API pública.
* Plugins básicos.
* Instalador simplificado.
* Cloudflare Tunnel asistido.
* Actualizaciones de instancia.

### Fase 3 — Voz

Construir:

* Canales de voz.
* WebRTC.
* Servidor de señalización.
* SFU self-hosted.
* Push-to-talk.
* Selección de dispositivos.
* Permisos.
* Reconexión.

### Fase 4 — Minecraft

Construir:

* Integración con servidores existentes.
* Estado.
* Jugadores online.
* Consola.
* RCON seguro.
* Plantilla Docker.
* Instalación de Paper.
* Inicio y detención.
* Backups.
* Logs.
* Widget comunitario.

### Fase 5 — Ecosistema

Construir:

* SDK.
* Plugins.
* Marketplace.
* Temas.
* Aplicaciones.
* Federación.
* Migración de comunidades.
* Aplicaciones móviles.
* Video.
* Compartición de pantalla.

---

## 28. Problemas de corto plazo que deben considerarse

### 28.1 Instancias offline

Una instancia alojada en una computadora personal estará offline cuando:

* El equipo esté apagado.
* El usuario cierre el servicio.
* La conexión falle.
* El túnel falle.
* Cambie la red.
* El sistema suspenda el proceso.

La interfaz deberá comunicarlo claramente.

Posibles soluciones futuras:

* Host secundario.
* Réplica.
* Relay.
* Nodo de respaldo.
* Hosting comunitario.
* Migración rápida.
* Instancia temporal.
* Cola local de mensajes.

### 28.2 IP dinámica y NAT

Utilizar túneles o dominios dinámicos.

No asumir que los usuarios pueden abrir puertos.

### 28.3 Ancho de banda

Mensajes de texto son relativamente livianos.

Archivos, audio y video pueden generar consumo elevado.

El administrador deberá poder configurar:

* Tamaño máximo.
* Tipos permitidos.
* Compresión.
* Retención.
* Cuotas.
* Calidad de audio.
* Calidad de video.
* Número máximo de conexiones.
* Limpieza automática.

### 28.4 Almacenamiento

El almacenamiento gratuito no es infinito.

Permitir:

* Disco local.
* Almacenamiento externo.
* S3 compatible.
* MinIO.
* Cuotas.
* Borrado automático.
* Compresión.
* Deduplicación futura.
* Políticas de retención.

### 28.5 Seguridad del host

Instalar servidores y plugins implica riesgos.

La plataforma deberá:

* Aislar procesos.
* Mostrar permisos.
* Utilizar imágenes verificadas.
* Validar plantillas.
* Advertir sobre plugins desconocidos.
* No ejecutar comandos arbitrarios desde el navegador sin autorización.
* Solicitar confirmación para acciones destructivas.

### 28.6 Fragmentación de versiones

Las instancias pueden actualizarse en momentos diferentes.

Se requiere:

* Versionado de protocolo.
* Compatibilidad mínima.
* Migraciones.
* Actualización asistida.
* Avisos.
* Rollback.
* Health checks.
* Canal estable y beta.

---

## 29. Principios de desarrollo para Claude

Claude deberá seguir estas reglas al trabajar en el proyecto.

### 29.1 No construir todo de una vez

Trabajar por módulos pequeños y verificables.

Antes de crear una función:

1. Revisar la arquitectura actual.
2. Identificar el paquete correcto.
3. Definir tipos.
4. Definir contratos.
5. Implementar.
6. Probar.
7. Documentar.
8. Verificar seguridad.

### 29.2 No inventar APIs

No asumir que un servicio o biblioteca tiene una función.

Consultar documentación o revisar tipos antes de usarla.

### 29.3 No ocultar limitaciones

Cuando una función no pueda ejecutarse en Cloudflare, Vercel o una capa gratuita, explicarlo claramente.

No presentar serverless como solución para:

* Procesos persistentes.
* Servidores Minecraft.
* Audio continuo.
* Video continuo.
* Contenedores arbitrarios.
* WebSockets sin comprobar soporte.
* Almacenamiento local persistente.

### 29.4 Mantener separación arquitectónica

No mezclar:

* Plataforma central.
* Cliente.
* Nodo self-hosted.
* Servicio de voz.
* Servidor de juegos.
* Analytics.
* Plugins.

### 29.5 Priorizar código mantenible

Requisitos:

* TypeScript estricto.
* Sin `any` innecesario.
* Funciones pequeñas.
* Nombres claros.
* Errores tipados.
* Validación con esquemas.
* Logs estructurados.
* Tests.
* Documentación.
* Migraciones.
* Variables de entorno validadas.

### 29.6 No implementar dark patterns

Prohibido:

* Ocultar funciones para venderlas.
* Crear urgencia falsa.
* Manipular al usuario.
* Suscripciones engañosas.
* Seguimiento invasivo.
* Consentimiento preseleccionado.
* Obstaculizar exportación.
* Bloquear migración.
* Ocultar eliminación de cuenta.

---

## 30. Estándares de código

### TypeScript

Mantener `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` y `noImplicitOverride` activos en cada `tsconfig.json` del monorepo.

### Validación

Utilizar esquemas para:

* Variables de entorno.
* Requests.
* Responses.
* Eventos.
* Configuraciones.
* Manifiestos.
* Datos importados.

Puede utilizarse Zod u otra alternativa adecuada.

### Errores

Los errores deberán incluir:

```text
code
message
status
details
requestId
timestamp
```

No exponer stack traces en producción.

### Logs

Los logs deben ser:

* Estructurados.
* Filtrables.
* Sin secretos.
* Con niveles.
* Con identificadores de solicitud.
* Configurables.

### Tests

Incluir:

* Unitarios.
* Integración.
* End-to-end.
* Protocolo.
* Permisos.
* Migraciones.
* Seguridad básica.

---

## 31. Accesibilidad

Objetivo mínimo:

```text
WCAG 2.2 AA
```

Incluir:

* Navegación por teclado.
* Contraste adecuado.
* Etiquetas accesibles.
* Focus visible.
* Lectores de pantalla.
* Reducción de movimiento.
* Escalado de texto.
* No depender solo del color.
* Subtítulos futuros.
* Atajos configurables.
* Estados de error comprensibles.

---

## 32. Internacionalización

La plataforma deberá prepararse para múltiples idiomas.

Idiomas iniciales:

* Español.
* Portugués de Brasil.
* Inglés.

No colocar textos directamente en componentes.

Utilizar archivos de traducción.

Ejemplo:

```text
locales/
├── es.json
├── pt-BR.json
└── en.json
```

Fechas, horas, números y tamaños deberán respetar la configuración regional.

---

## 33. Configuración mediante variables de entorno

Ver `.env.example` para la lista actual de variables.

---

## 34. Flujo inicial de onboarding

El onboarding deberá preguntar:

```text
¿Qué quieres hacer?
```

Opciones:

* Entrar a una comunidad.
* Crear una comunidad.
* Conectar mi servidor.
* Instalar un servidor.
* Explorar comunidades públicas.
* Continuar como invitado.

Para crear comunidad:

1. Nombre.
2. Ícono.
3. Tipo de comunidad.
4. Privada o pública.
5. Instancia disponible.
6. Crear instancia local.
7. Conectar instancia remota.
8. Generar invitación.
9. Compartir enlace.

Para Minecraft:

1. Usar servidor existente.
2. Instalar nuevo servidor.
3. Seleccionar edición.
4. Seleccionar versión.
5. Seleccionar memoria.
6. Configurar acceso.
7. Instalar.
8. Vincular a un canal.
9. Compartir dirección.

---

## 35. Modelo de negocio futuro sin pay-to-win

El proyecto puede aceptar formas de financiación que no bloqueen funciones esenciales.

Opciones permitidas:

* Donaciones.
* Patrocinios.
* GitHub Sponsors.
* Open Collective.
* Soporte técnico.
* Instalación administrada.
* Hosting administrado opcional.
* Consultoría.
* Desarrollo personalizado.
* Marketplace con comisión transparente.
* Dominios.
* Servicios empresariales.
* SLA empresarial.
* Infraestructura dedicada.

El software self-hosted debe continuar siendo funcional y completo.

Un servicio administrado futuro podrá cobrar por:

* Infraestructura.
* Comodidad.
* Mantenimiento.
* Backups administrados.
* Disponibilidad.
* Soporte.
* Escalabilidad.

No deberá cobrar por desbloquear personalización artificialmente.

---

## 36. Primera tarea recomendada

Antes de desarrollar la interfaz completa, crear una prueba arquitectónica mínima.

Objetivo:

```text
Dos usuarios abren la aplicación web,
se conectan a una instancia self-hosted
y pueden enviar mensajes en tiempo real.
```

La prueba deberá incluir:

* `apps/web`
* `apps/node-server`
* Docker Compose.
* SQLite.
* WebSocket.
* Un canal.
* Dos usuarios.
* Creación y lectura de mensajes.
* Indicador online.
* Reconexión.
* Health check.
* Documentación para ejecutar localmente.

No comenzar por:

* Video.
* Marketplace.
* Federación completa.
* Aplicación móvil.
* Sistema avanzado de bots.
* Múltiples juegos.
* Personalización visual extrema.

Primero demostrar que el modelo distribuido funciona.

---

## 37. Definición de éxito del MVP

El MVP será considerado exitoso cuando una persona sin conocimientos avanzados pueda:

1. Entrar a la página.
2. Descargar o ejecutar el instalador.
3. Crear una instancia.
4. Conectarla mediante un túnel.
5. Crear una comunidad.
6. Generar una invitación.
7. Compartirla con otra persona.
8. Intercambiar mensajes.
9. Reiniciar el servidor sin perder datos.
10. Exportar un backup.
11. Personalizar la comunidad.
12. Utilizar todo sin pagar.

---

## 38. Instrucción final para Claude

Al recibir una tarea relacionada con este proyecto:

1. Lee este archivo completo.
2. Identifica qué componente será modificado.
3. Respeta la arquitectura híbrida.
4. Prioriza self-hosting.
5. Evita dependencias pagas obligatorias.
6. No centralices datos innecesariamente.
7. No implementes restricciones comerciales artificiales.
8. Mantén la plataforma personalizable.
9. Protege la seguridad del anfitrión.
10. Documenta todas las decisiones importantes.
11. Señala claramente limitaciones de Cloudflare, Vercel y servicios gratuitos.
12. Construye primero una solución mínima funcional.
13. No copies la identidad visual ni recursos propietarios de Discord.
14. Mantén compatibilidad con web y aplicación de escritorio.
15. Diseña cada módulo para poder evolucionar hacia federación.

La prioridad absoluta es construir una plataforma comunitaria abierta, gratuita, sostenible, portable y controlada por sus propios usuarios.
