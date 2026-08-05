/**
 * Todo el texto del sitio vive aquí (§32): ningún literal dentro de un componente.
 * `es` define la forma; `en` y `pt-BR` la implementan, así que olvidar una clave
 * es un error de tipos, no una cadena en blanco en producción.
 */
export const LOCALES = ["es", "en", "pt-br"] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_NAMES: Record<Locale, string> = {
  es: "Español",
  en: "English",
  "pt-br": "Português",
};

/** Etiqueta `lang` de HTML por locale. */
export const HTML_LANG: Record<Locale, string> = {
  es: "es",
  en: "en",
  "pt-br": "pt-BR",
};

const COMPOSE = `services:
  distop:
    image: ghcr.io/distop/distop:latest
    environment:
      AUTH_SECRET: \${AUTH_SECRET}
      PUBLIC_URL: https://mi-comunidad.example
    ports: ["5000:5000"]
    volumes: ["./data:/app/data"]`;

const es = {
  meta: {
    title: "Distop — Tu comunidad, en tu servidor",
    description:
      "Plataforma libre de chat de voz y texto que instalas tú. Todo lo que otras plataformas cobran viene incluido. AGPL-3.0.",
  },
  skip: "Saltar al contenido",
  nav: {
    features: "Funciones",
    install: "Instalar",
    hosting: "Hospedar",
    news: "Novedades",
    code: "Código",
  },
  hero: {
    eyebrow: "v0.1.0 · AGPL-3.0 · self-hosted",
    line1: "Tu comunidad,",
    line2: "en tu servidor",
    sub: "Distop es una plataforma de voz y texto que instalas tú: en tu PC, en un NAS o en una Raspberry. Los mensajes viven en tu disco. Todo lo que otras plataformas te cobran, aquí viene puesto.",
    cta1: "Instalar Distop",
    cta2: "Cómo hospedar",
    note: "Node 24 · SQLite · Docker opcional",
  },
  free: {
    eyebrow: "Créditos necesarios: 0",
    title: "Nada de esto se paga",
    sub: "No hay plan gratis ni plan de pago. Hay una sola versión, y la tienes entera desde el primer minuto.",
    items: [
      "Emojis y reacciones",
      "Calidad de audio",
      "Subir archivos",
      "Temas y colores",
      "Avatares y perfil",
      "Tamaño de la comunidad",
      "Historial completo",
      "Exportar tus datos",
    ],
    tag: "Incluido",
    footnote:
      "Los únicos límites son los de tu máquina: disco, memoria y subida. Y los ajustas tú, en la configuración.",
  },
  features: {
    eyebrow: "Select player",
    title: "Lo que ya funciona",
    sub: "No es una hoja de ruta: es lo que trae la versión de hoy.",
    items: [
      {
        tag: "Texto",
        title: "Canales en tiempo real",
        body: "Categorías, respuestas, reacciones, mensajes fijados, edición, búsqueda e historial. Llega por WebSocket, sin recargar la página.",
      },
      {
        tag: "Voz",
        title: "Voz entre pares",
        body: "El audio va directo de un navegador a otro por WebRTC. Tu instancia solo presenta a la gente, no transporta el sonido: por eso hospedar voz no te cuesta ancho de banda de servidor.",
      },
      {
        tag: "Roles",
        title: "Permisos de verdad",
        body: "33 permisos aplicables por comunidad, categoría, canal, rol y persona. Nadie concede lo que no tiene, y todo queda escrito en el registro de auditoría.",
      },
      {
        tag: "Tema",
        title: "Personalización sin candados",
        body: "Color de acento, esquinas, tipografía, fondo de la conversación, animaciones y tema claro u oscuro. Ninguna opción dice «pro».",
      },
      {
        tag: "Gente",
        title: "Invitar es un enlace",
        body: "Invitaciones con caducidad y usos limitados. Quien entra puede quedarse sin cuenta, y ponerse contraseña después sin perder nada.",
      },
      {
        tag: "Datos",
        title: "Tus datos salen contigo",
        body: "Exportación completa de la comunidad y descarga de adjuntos. Mudarte a otra instancia no es un favor que te hacemos.",
      },
    ],
  },
  host: {
    eyebrow: "Continue?",
    title: "Hospedar es una tarde, no un proyecto",
    sub: "Tres pasos desde cero hasta tener una dirección que puedes pasarle a alguien.",
    steps: [
      {
        title: "Arranca la instancia",
        body: "Con Docker o con Node 24 directamente. Crea su base SQLite sola en el primer arranque; no hay que instalar ningún motor de base de datos.",
      },
      {
        title: "Recláma­la",
        body: "La primera pantalla no es un muro de acceso: es la puesta en marcha. Creas tu cuenta y tu comunidad en el mismo paso, y sin contraseña si no la quieres.",
      },
      {
        title: "Abre el túnel",
        body: "Desde la propia app, en Estado de la instancia. Sale una dirección pública con HTTPS aunque no puedas abrir puertos en el router.",
      },
    ],
    code: COMPOSE,
    codeLabel: "docker-compose.yml",
    warnTitle: "Lo que hay que saber antes",
    warn: "Tu comunidad está disponible mientras tu equipo esté encendido. La velocidad es la de tu subida, los archivos ocupan tu disco, y las copias de seguridad las haces tú. Preferimos decírtelo aquí que después.",
  },
  data: {
    eyebrow: "High score",
    title: "Sin intermediarios",
    sub: "No hay un servidor nuestro en medio de tu conversación, porque no hay servidor nuestro.",
    items: [
      {
        title: "En tu disco",
        body: "Los mensajes y los adjuntos se guardan en un archivo SQLite y una carpeta de tu máquina. Se copian con arrastrarlos.",
      },
      {
        title: "Sesiones revocables",
        body: "Contraseñas con scrypt y tokens opacos guardados en tu base: cerrar una sesión la cierra de verdad, hoy, no cuando caduque.",
      },
      {
        title: "Adjuntos aislados",
        body: "Lista blanca de tipos, nombre real fuera del disco, y se sirven sin ejecutarse ni adivinar su formato.",
      },
      {
        title: "Sin analítica dentro",
        body: "La app no mide nada. Lo que mide este sitio se puede desactivar, y nunca son mensajes ni nombres de canal.",
      },
    ],
  },
  news: {
    eyebrow: "News",
    title: "Últimas partidas",
    all: "Ver todas",
    readMore: "Leer",
  },
  cta: {
    title: "¿Jugamos?",
    sub: "Descarga, arranca, invita. Sin cuenta central, sin tarjeta, sin desbloquear nada.",
    b1: "Instalar Distop",
    b2: "Ver el código",
  },
  footer: {
    tagline: "Comunicación comunitaria libre y self-hosted.",
    product: "Producto",
    project: "Proyecto",
    help: "Ayuda",
    links: {
      features: "Funciones",
      install: "Instalar",
      hosting: "Hospedar",
      news: "Novedades",
      code: "Código fuente",
      license: "Licencia AGPL-3.0",
      contributing: "Contribuir",
      security: "Seguridad",
      issues: "Reportar un fallo",
      privacy: "Privacidad",
    },
    legal:
      "Distop es software libre bajo AGPL-3.0. Proyecto independiente, sin relación con Discord Inc. ni con ninguna otra plataforma.",
    langLabel: "Idioma",
  },
  install: {
    title: "Instalar Distop",
    sub: "Hoy Distop se ejecuta desde el código o con Docker. La aplicación de escritorio con instalador está en camino, y no vamos a fingir que ya existe.",
    ways: [
      {
        tag: "Recomendado",
        title: "Con Docker",
        body: "Una orden y listo. Los datos quedan en la carpeta ./data, así que actualizar la imagen no borra nada.",
        code: "docker compose up -d",
      },
      {
        tag: "Sin Docker",
        title: "Con Node 24",
        body: "Node 24 ejecuta TypeScript sin compilar y trae SQLite dentro, así que no hace falta nada más.",
        code: "git clone … && cd distop\nnpm install\nnpm run host",
      },
      {
        tag: "En camino",
        title: "Escritorio",
        body: "Aplicación de escritorio con Tauri: notificaciones nativas, pulsar para hablar global y bandeja del sistema. Todavía no hay binarios que descargar.",
        code: "",
      },
    ],
    reqTitle: "Lo que necesitas",
    reqs: [
      "Node 24 o Docker.",
      "Cualquier equipo que esté encendido: un PC, un mini PC, un NAS o una Raspberry Pi.",
      "Una variable AUTH_SECRET. Sin ella la instancia se niega a arrancar, a propósito.",
      "Nada más. No hay cuenta que crear en ningún sitio.",
    ],
  },
  hosting: {
    title: "Hospedar tu instancia",
    sub: "Lo que implica de verdad tener una comunidad en tu propia máquina, con las partes incómodas incluidas.",
    tunnelTitle: "Si no puedes abrir puertos",
    tunnelBody:
      "La mayoría de conexiones domésticas no dejan abrir puertos en el router. Distop abre un túnel de Cloudflare desde la propia interfaz, en Estado de la instancia: te devuelve una dirección pública con HTTPS sin tocar la configuración de tu red.",
    proxyTitle: "Si pones un proxy delante",
    proxyBody:
      "Activa TRUST_PROXY=true. Sin eso, cualquiera puede falsear su IP y saltarse los límites; con eso puesto sin proxy delante, pasa exactamente lo mismo. Es una decisión que tienes que tomar tú, y por eso no viene decidida.",
    backupTitle: "Copias de seguridad",
    backupBody:
      "Toda la instancia son dos cosas: el archivo app.db y la carpeta de subidas. Cópialas y ya está. Además, cada comunidad se exporta entera desde su panel de administración.",
    offlineTitle: "Cuando tu equipo se apaga",
    offlineBody:
      "La comunidad deja de estar disponible, y quien entre verá exactamente eso, no un error genérico. Es la contrapartida honesta de no depender de nadie.",
  },
  newsPage: {
    title: "Novedades",
    sub: "Lo que ha ido entrando, con fecha y sin adornos.",
  },
  privacy: {
    title: "Privacidad",
    sub: "La versión corta: este sitio no te sigue, y la aplicación tampoco.",
    items: [
      {
        title: "Este sitio",
        body: "Es HTML estático. Sin cookies, sin analítica, sin píxeles de seguimiento y sin peticiones a terceros. Las tipografías se sirven desde este mismo dominio, así que ni siquiera Google sabe que has entrado.",
      },
      {
        title: "La aplicación",
        body: "Distop no envía telemetría. Tus mensajes, archivos y cuentas viven en la instancia que tú hospedas, en tu disco. Quien la administra es quien puede verlos, y esa persona eres tú.",
      },
      {
        title: "Si algún día medimos algo",
        body: "Se anunciará aquí, se podrá desactivar, y nunca incluirá contenido de mensajes, nombres de canales privados, credenciales ni direcciones.",
      },
      {
        title: "Enlaces externos",
        body: "Los enlaces a GitHub te llevan fuera de aquí, donde se aplican sus políticas. No les compartimos nada sobre ti.",
      },
    ],
    updated: "Última revisión: 2 de agosto de 2026.",
  },
};

/* Sin `as const` a propósito: con él, cada cadena del español se convierte en su
   propio tipo literal y `Dict` acaba exigiendo que el inglés diga exactamente lo
   mismo, letra por letra. Lo que se quiere comprobar es la forma, no el texto. */
type Dict = typeof es;

const en: Dict = {
  meta: {
    title: "Distop — Your community, on your server",
    description:
      "Free voice and text chat platform that you host yourself. Everything other platforms charge for is included. AGPL-3.0.",
  },
  skip: "Skip to content",
  nav: {
    features: "Features",
    install: "Install",
    hosting: "Hosting",
    news: "News",
    code: "Code",
  },
  hero: {
    eyebrow: "v0.1.0 · AGPL-3.0 · self-hosted",
    line1: "Your community,",
    line2: "on your server",
    sub: "Distop is a voice and text platform you install yourself: on your PC, a NAS or a Raspberry Pi. Messages live on your disk. Everything other platforms charge you for is already in the box.",
    cta1: "Install Distop",
    cta2: "How to host it",
    note: "Node 24 · SQLite · Docker optional",
  },
  free: {
    eyebrow: "Credits required: 0",
    title: "None of this costs money",
    sub: "There is no free tier and no paid tier. There is one version, and you get all of it from minute one.",
    items: [
      "Emoji and reactions",
      "Audio quality",
      "File uploads",
      "Themes and colours",
      "Avatars and profile",
      "Community size",
      "Full history",
      "Exporting your data",
    ],
    tag: "Included",
    footnote:
      "The only limits are your machine's: disk, memory and upload speed. And you set them yourself, in the settings.",
  },
  features: {
    eyebrow: "Select player",
    title: "What already works",
    sub: "Not a roadmap: this is what today's release ships.",
    items: [
      {
        tag: "Text",
        title: "Real-time channels",
        body: "Categories, replies, reactions, pinned messages, editing, search and history. It arrives over WebSocket, with no page reloads.",
      },
      {
        tag: "Voice",
        title: "Peer-to-peer voice",
        body: "Audio goes straight from one browser to another over WebRTC. Your instance only introduces people, it never carries the sound — which is why hosting voice costs you no server bandwidth.",
      },
      {
        tag: "Roles",
        title: "Permissions that mean it",
        body: "33 permissions applied per community, category, channel, role and person. Nobody grants what they don't hold, and every change lands in the audit log.",
      },
      {
        tag: "Theme",
        title: "Customisation with no locks",
        body: "Accent colour, corner radius, typeface, chat background, motion, light and dark themes. No option is labelled «pro».",
      },
      {
        tag: "People",
        title: "Inviting is just a link",
        body: "Invites with expiry and a use limit. Whoever joins can stay without an account, and add a password later without losing anything.",
      },
      {
        tag: "Data",
        title: "Your data leaves with you",
        body: "Full community export and attachment download. Moving to another instance isn't a favour we do you.",
      },
    ],
  },
  host: {
    eyebrow: "Continue?",
    title: "Hosting is an afternoon, not a project",
    sub: "Three steps from nothing to an address you can hand to someone.",
    steps: [
      {
        title: "Start the instance",
        body: "With Docker, or with Node 24 directly. It creates its own SQLite database on first boot — there is no database engine to install.",
      },
      {
        title: "Claim it",
        body: "The first screen isn't a login wall, it's the setup. You create your account and your community in the same step, without a password if you'd rather not have one.",
      },
      {
        title: "Open the tunnel",
        body: "From inside the app, under Instance status. You get a public HTTPS address even if you can't open ports on your router.",
      },
    ],
    code: COMPOSE,
    codeLabel: "docker-compose.yml",
    warnTitle: "What to know first",
    warn: "Your community is reachable while your machine is on. Speed is your upload speed, files take up your disk, and backups are yours to make. We'd rather tell you here than later.",
  },
  data: {
    eyebrow: "High score",
    title: "Nobody in the middle",
    sub: "There is no server of ours between you and your conversation, because there is no server of ours.",
    items: [
      {
        title: "On your disk",
        body: "Messages and attachments live in one SQLite file and one folder on your machine. Backing them up means copying them.",
      },
      {
        title: "Revocable sessions",
        body: "scrypt passwords and opaque tokens stored in your own database: ending a session ends it today, not whenever it expires.",
      },
      {
        title: "Sandboxed attachments",
        body: "Allow-list of types, real filenames never touch the disk, and files are served without executing or sniffing them.",
      },
      {
        title: "No analytics inside",
        body: "The app measures nothing. What this site measures can be switched off, and it is never messages or channel names.",
      },
    ],
  },
  news: {
    eyebrow: "News",
    title: "Recent runs",
    all: "See all",
    readMore: "Read",
  },
  cta: {
    title: "Shall we?",
    sub: "Download, boot, invite. No central account, no card, nothing to unlock.",
    b1: "Install Distop",
    b2: "Read the code",
  },
  footer: {
    tagline: "Free, self-hosted community communication.",
    product: "Product",
    project: "Project",
    help: "Help",
    links: {
      features: "Features",
      install: "Install",
      hosting: "Hosting",
      news: "News",
      code: "Source code",
      license: "AGPL-3.0 licence",
      contributing: "Contributing",
      security: "Security",
      issues: "Report a bug",
      privacy: "Privacy",
    },
    legal:
      "Distop is free software under AGPL-3.0. An independent project, unaffiliated with Discord Inc. or any other platform.",
    langLabel: "Language",
  },
  install: {
    title: "Install Distop",
    sub: "Today Distop runs from source or with Docker. The desktop app with an installer is on the way, and we're not going to pretend it already exists.",
    ways: [
      {
        tag: "Recommended",
        title: "With Docker",
        body: "One command. Data stays in the ./data folder, so pulling a new image never wipes anything.",
        code: "docker compose up -d",
      },
      {
        tag: "No Docker",
        title: "With Node 24",
        body: "Node 24 runs TypeScript without a build step and ships SQLite inside, so nothing else is needed.",
        code: "git clone … && cd distop\nnpm install\nnpm run host",
      },
      {
        tag: "On the way",
        title: "Desktop",
        body: "A Tauri desktop app: native notifications, global push-to-talk and a tray icon. There are no binaries to download yet.",
        code: "",
      },
    ],
    reqTitle: "What you need",
    reqs: [
      "Node 24 or Docker.",
      "Any machine that stays on: a PC, a mini PC, a NAS or a Raspberry Pi.",
      "An AUTH_SECRET variable. Without it the instance refuses to start, on purpose.",
      "Nothing else. There is no account to create anywhere.",
    ],
  },
  hosting: {
    title: "Hosting your instance",
    sub: "What running a community on your own machine actually involves, awkward parts included.",
    tunnelTitle: "If you can't open ports",
    tunnelBody:
      "Most home connections won't let you open router ports. Distop opens a Cloudflare tunnel from the interface itself, under Instance status: it hands you a public HTTPS address without touching your network settings.",
    proxyTitle: "If you put a proxy in front",
    proxyBody:
      "Set TRUST_PROXY=true. Without it, anyone can forge their IP and walk past the rate limits; with it set and no proxy in front, exactly the same thing happens. It's a call you have to make, which is why it doesn't come pre-made.",
    backupTitle: "Backups",
    backupBody:
      "The whole instance is two things: the app.db file and the uploads folder. Copy them and you're done. On top of that, every community exports in full from its admin panel.",
    offlineTitle: "When your machine goes off",
    offlineBody:
      "The community stops being reachable, and anyone arriving sees exactly that, not a generic error. It's the honest trade for depending on nobody.",
  },
  newsPage: {
    title: "News",
    sub: "What has landed, dated and unembellished.",
  },
  privacy: {
    title: "Privacy",
    sub: "The short version: this site doesn't track you, and neither does the app.",
    items: [
      {
        title: "This site",
        body: "It's static HTML. No cookies, no analytics, no tracking pixels and no third-party requests. Fonts are served from this same domain, so not even Google knows you dropped by.",
      },
      {
        title: "The app",
        body: "Distop sends no telemetry. Your messages, files and accounts live on the instance you host, on your disk. Whoever administers it is who can see them, and that person is you.",
      },
      {
        title: "If we ever measure anything",
        body: "It will be announced here, it will be switchable off, and it will never include message contents, private channel names, credentials or addresses.",
      },
      {
        title: "External links",
        body: "Links to GitHub take you off this site, where their own policies apply. We share nothing about you with them.",
      },
    ],
    updated: "Last reviewed: 2 August 2026.",
  },
};

const ptBR: Dict = {
  meta: {
    title: "Distop — Sua comunidade, no seu servidor",
    description:
      "Plataforma livre de voz e texto que você mesmo hospeda. Tudo o que as outras cobram já vem incluso. AGPL-3.0.",
  },
  skip: "Ir para o conteúdo",
  nav: {
    features: "Recursos",
    install: "Instalar",
    hosting: "Hospedar",
    news: "Novidades",
    code: "Código",
  },
  hero: {
    eyebrow: "v0.1.0 · AGPL-3.0 · self-hosted",
    line1: "Sua comunidade,",
    line2: "no seu servidor",
    sub: "Distop é uma plataforma de voz e texto que você instala: no seu PC, num NAS ou num Raspberry Pi. As mensagens ficam no seu disco. Tudo o que as outras plataformas cobram, aqui já vem.",
    cta1: "Instalar o Distop",
    cta2: "Como hospedar",
    note: "Node 24 · SQLite · Docker opcional",
  },
  free: {
    eyebrow: "Fichas necessárias: 0",
    title: "Nada disso se paga",
    sub: "Não existe plano grátis nem plano pago. Existe uma versão só, e ela é inteira desde o primeiro minuto.",
    items: [
      "Emojis e reações",
      "Qualidade de áudio",
      "Enviar arquivos",
      "Temas e cores",
      "Avatar e perfil",
      "Tamanho da comunidade",
      "Histórico completo",
      "Exportar seus dados",
    ],
    tag: "Incluso",
    footnote:
      "Os únicos limites são os da sua máquina: disco, memória e upload. E quem ajusta é você, nas configurações.",
  },
  features: {
    eyebrow: "Select player",
    title: "O que já funciona",
    sub: "Não é roteiro futuro: é o que a versão de hoje entrega.",
    items: [
      {
        tag: "Texto",
        title: "Canais em tempo real",
        body: "Categorias, respostas, reações, mensagens fixadas, edição, busca e histórico. Chega por WebSocket, sem recarregar a página.",
      },
      {
        tag: "Voz",
        title: "Voz entre pares",
        body: "O áudio vai direto de um navegador para outro por WebRTC. Sua instância só apresenta as pessoas, não carrega o som: por isso hospedar voz não consome banda do servidor.",
      },
      {
        tag: "Cargos",
        title: "Permissões de verdade",
        body: "33 permissões aplicáveis por comunidade, categoria, canal, cargo e pessoa. Ninguém concede o que não tem, e tudo fica no registro de auditoria.",
      },
      {
        tag: "Tema",
        title: "Personalização sem cadeado",
        body: "Cor de destaque, cantos, tipografia, fundo da conversa, animações e tema claro ou escuro. Nenhuma opção diz «pro».",
      },
      {
        tag: "Pessoas",
        title: "Convidar é um link",
        body: "Convites com validade e limite de usos. Quem entra pode ficar sem conta, e criar senha depois sem perder nada.",
      },
      {
        tag: "Dados",
        title: "Seus dados saem com você",
        body: "Exportação completa da comunidade e download dos anexos. Mudar de instância não é um favor que a gente faz.",
      },
    ],
  },
  host: {
    eyebrow: "Continue?",
    title: "Hospedar é uma tarde, não um projeto",
    sub: "Três passos do zero até um endereço que você pode passar para alguém.",
    steps: [
      {
        title: "Suba a instância",
        body: "Com Docker ou com Node 24 direto. Ela cria o próprio banco SQLite no primeiro arranque; não há motor de banco para instalar.",
      },
      {
        title: "Reivindique",
        body: "A primeira tela não é um muro de login: é a configuração inicial. Você cria sua conta e sua comunidade no mesmo passo, sem senha se preferir.",
      },
      {
        title: "Abra o túnel",
        body: "Pelo próprio app, em Estado da instância. Sai um endereço público com HTTPS mesmo sem abrir portas no roteador.",
      },
    ],
    code: COMPOSE,
    codeLabel: "docker-compose.yml",
    warnTitle: "O que saber antes",
    warn: "Sua comunidade fica no ar enquanto sua máquina estiver ligada. A velocidade é a do seu upload, os arquivos ocupam seu disco, e o backup é você quem faz. Preferimos avisar aqui do que depois.",
  },
  data: {
    eyebrow: "High score",
    title: "Sem intermediários",
    sub: "Não existe servidor nosso no meio da sua conversa, porque não existe servidor nosso.",
    items: [
      {
        title: "No seu disco",
        body: "Mensagens e anexos ficam num arquivo SQLite e numa pasta da sua máquina. Fazer backup é copiar.",
      },
      {
        title: "Sessões revogáveis",
        body: "Senhas com scrypt e tokens opacos guardados no seu banco: encerrar uma sessão encerra hoje, não quando vencer.",
      },
      {
        title: "Anexos isolados",
        body: "Lista de tipos permitidos, nome real nunca toca o disco, e nada é executado nem adivinhado ao servir.",
      },
      {
        title: "Sem análise por dentro",
        body: "O app não mede nada. O que este site mede pode ser desligado, e nunca são mensagens nem nomes de canal.",
      },
    ],
  },
  news: {
    eyebrow: "News",
    title: "Últimas partidas",
    all: "Ver todas",
    readMore: "Ler",
  },
  cta: {
    title: "Bora?",
    sub: "Baixe, suba, convide. Sem conta central, sem cartão, sem nada para desbloquear.",
    b1: "Instalar o Distop",
    b2: "Ver o código",
  },
  footer: {
    tagline: "Comunicação comunitária livre e self-hosted.",
    product: "Produto",
    project: "Projeto",
    help: "Ajuda",
    links: {
      features: "Recursos",
      install: "Instalar",
      hosting: "Hospedar",
      news: "Novidades",
      code: "Código-fonte",
      license: "Licença AGPL-3.0",
      contributing: "Contribuir",
      security: "Segurança",
      issues: "Relatar um erro",
      privacy: "Privacidade",
    },
    legal:
      "Distop é software livre sob AGPL-3.0. Projeto independente, sem relação com a Discord Inc. nem com qualquer outra plataforma.",
    langLabel: "Idioma",
  },
  install: {
    title: "Instalar o Distop",
    sub: "Hoje o Distop roda a partir do código ou com Docker. O aplicativo de desktop com instalador está a caminho, e não vamos fingir que já existe.",
    ways: [
      {
        tag: "Recomendado",
        title: "Com Docker",
        body: "Um comando. Os dados ficam na pasta ./data, então atualizar a imagem não apaga nada.",
        code: "docker compose up -d",
      },
      {
        tag: "Sem Docker",
        title: "Com Node 24",
        body: "O Node 24 executa TypeScript sem compilar e já traz SQLite dentro, então não precisa de mais nada.",
        code: "git clone … && cd distop\nnpm install\nnpm run host",
      },
      {
        tag: "A caminho",
        title: "Desktop",
        body: "Aplicativo de desktop com Tauri: notificações nativas, apertar para falar global e ícone na bandeja. Ainda não há binários para baixar.",
        code: "",
      },
    ],
    reqTitle: "O que você precisa",
    reqs: [
      "Node 24 ou Docker.",
      "Qualquer máquina que fique ligada: um PC, um mini PC, um NAS ou um Raspberry Pi.",
      "Uma variável AUTH_SECRET. Sem ela a instância se recusa a subir, de propósito.",
      "Mais nada. Não há conta para criar em lugar nenhum.",
    ],
  },
  hosting: {
    title: "Hospedar sua instância",
    sub: "O que realmente significa ter uma comunidade na sua máquina, com as partes chatas incluídas.",
    tunnelTitle: "Se você não pode abrir portas",
    tunnelBody:
      "A maioria das conexões domésticas não deixa abrir portas no roteador. O Distop abre um túnel da Cloudflare pela própria interface, em Estado da instância: devolve um endereço público com HTTPS sem mexer na sua rede.",
    proxyTitle: "Se houver um proxy na frente",
    proxyBody:
      "Ative TRUST_PROXY=true. Sem isso, qualquer um forja o próprio IP e passa por cima dos limites; com isso ligado e sem proxy na frente, acontece exatamente o mesmo. É uma decisão sua, e por isso não vem decidida.",
    backupTitle: "Backups",
    backupBody:
      "A instância inteira são duas coisas: o arquivo app.db e a pasta de uploads. Copie e pronto. Além disso, cada comunidade se exporta inteira pelo painel de administração.",
    offlineTitle: "Quando sua máquina desliga",
    offlineBody:
      "A comunidade sai do ar, e quem chegar vê exatamente isso, não um erro genérico. É a contrapartida honesta de não depender de ninguém.",
  },
  newsPage: {
    title: "Novidades",
    sub: "O que foi entrando, com data e sem enfeite.",
  },
  privacy: {
    title: "Privacidade",
    sub: "A versão curta: este site não te rastreia, e o aplicativo também não.",
    items: [
      {
        title: "Este site",
        body: "É HTML estático. Sem cookies, sem análise de tráfego, sem pixels de rastreamento e sem requisições a terceiros. As fontes são servidas deste mesmo domínio, então nem o Google sabe que você passou por aqui.",
      },
      {
        title: "O aplicativo",
        body: "O Distop não envia telemetria. Suas mensagens, arquivos e contas ficam na instância que você hospeda, no seu disco. Quem administra é quem pode vê-los, e essa pessoa é você.",
      },
      {
        title: "Se um dia medirmos algo",
        body: "Será anunciado aqui, poderá ser desligado, e nunca incluirá conteúdo de mensagens, nomes de canais privados, credenciais ou endereços.",
      },
      {
        title: "Links externos",
        body: "Os links para o GitHub levam para fora daqui, onde valem as políticas deles. Não compartilhamos nada sobre você com eles.",
      },
    ],
    updated: "Última revisão: 2 de agosto de 2026.",
  },
};

export const UI: Record<Locale, Dict> = { es, en, "pt-br": ptBR };

/** Prefijo de ruta del locale, siempre con barras a los dos lados. */
export const path = (locale: Locale, rest = ""): string => `/${locale}/${rest}`;
