/**
 * Todo el texto del sitio vive aquí (§32): ningún literal dentro de un componente.
 * `es` define la forma; `en` y `pt-BR` la implementan, así que olvidar una clave
 * es un error de tipos, no una cadena en blanco en producción.
 *
 * Quien lee esto es alguien que juega, no alguien que programa: nada de Docker,
 * Node, SQLite ni «instancia» en el texto visible. Los términos técnicos que
 * quedan viven plegados en la sección para quien monta el servidor a mano.
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

/** Solo aparece dentro de la sección plegada de la página de descarga. */
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
    title: "Distop — Tu comunidad, sin peajes",
    description:
      "Chat de voz y texto para tu comunidad. Todo lo que otras apps te cobran, aquí viene incluido y gratis.",
  },
  skip: "Saltar al contenido",
  nav: {
    features: "Funciones",
    install: "Descargar",
    hosting: "Cómo funciona",
    news: "Novedades",
    code: "Código",
  },
  hero: {
    eyebrow: "Gratis · Sin cuenta · Sin tarjeta",
    line1: "Tu comunidad,",
    line2: "sin peajes",
    sub: "Chat de voz y texto para jugar con los tuyos. Lo descargas, lo abres y ya tienes tu sitio. Emojis, calidad de audio, temas, tamaño del grupo: todo lo que otras apps te venden, aquí viene puesto.",
    cta1: "Descargar para Windows",
    cta2: "Cómo funciona",
    note: "Windows 10 y 11 · No necesitas instalar nada más",
  },
  free: {
    eyebrow: "Créditos necesarios: 0",
    title: "Nada de esto se paga",
    sub: "No hay una versión gratis y otra de pago. Hay una sola, y la tienes entera desde el primer minuto.",
    items: [
      "Emojis y reacciones",
      "Calidad de audio",
      "Subir archivos",
      "Temas y colores",
      "Avatares y perfil",
      "Tamaño de la comunidad",
      "Historial completo",
      "Llevarte tus datos",
    ],
    tag: "Incluido",
    footnote:
      "El único límite es tu propio equipo: el espacio que tengas y lo rápida que sea tu conexión. Nada está capado a propósito para venderte la versión buena.",
  },
  features: {
    eyebrow: "Select player",
    title: "Lo que ya funciona",
    sub: "No es una promesa: es lo que hace la versión que puedes descargar hoy.",
    items: [
      {
        tag: "Texto",
        title: "Canales de chat",
        body: "Categorías, respuestas, reacciones, mensajes fijados, editar, buscar y todo el historial. Los mensajes aparecen al momento, sin recargar nada.",
      },
      {
        tag: "Voz",
        title: "Voz que entra a la primera",
        body: "Entras al canal y hablas. No hay que abrir nada en el router ni pelearse con la configuración de la red: el audio va por el mismo camino que el chat.",
      },
      {
        tag: "Roles",
        title: "Permisos de verdad",
        body: "33 permisos que das por comunidad, categoría, canal, rol o persona. Nadie puede repartir lo que no tiene, y queda apuntado quién hizo qué.",
      },
      {
        tag: "Tema",
        title: "Personalizar sin candados",
        body: "Color, esquinas, letra, fondo del chat, animaciones y tema claro u oscuro. Ninguna opción tiene un candado al lado.",
      },
      {
        tag: "Gente",
        title: "Invitar es pasar un enlace",
        body: "Enlaces con caducidad y usos contados. Quien entra puede quedarse sin crear cuenta, y ponerse contraseña más tarde sin perder nada.",
      },
      {
        tag: "Datos",
        title: "Tus cosas salen contigo",
        body: "Puedes descargar tu comunidad entera, con mensajes y archivos, cuando te dé la gana. Mudarte a otro sitio no es un favor que te hagamos.",
      },
    ],
  },
  host: {
    eyebrow: "Continue?",
    title: "Tres pasos y estás dentro",
    sub: "Desde darle a descargar hasta pasarle el enlace a tus amigos.",
    steps: [
      {
        title: "Ábrelo",
        body: "Descargas, descomprimes y doble clic. No hay que instalar ningún programa aparte ni crear cuenta en ninguna web: la aplicación ya viene con todo lo que necesita.",
      },
      {
        title: "Pon tu nombre",
        body: "La primera pantalla no es un muro de acceso: creas tu perfil y tu comunidad en el mismo paso. Con contraseña o sin ella, tú eliges.",
      },
      {
        title: "Invita",
        body: "Un botón te da una dirección para compartir, aunque tus amigos vivan en la otra punta. Se la pasas y entran.",
      },
    ],
    code: COMPOSE,
    codeLabel: "docker-compose.yml",
    warnTitle: "Esto conviene que lo sepas",
    warn: "Tu comunidad funciona mientras tu PC esté encendido, igual que un servidor de Minecraft montado en casa. Si lo apagas, tus amigos no entran hasta que vuelvas a encenderlo. Preferimos decírtelo ahora que después.",
  },
  data: {
    eyebrow: "High score",
    title: "Sin intermediarios",
    sub: "No hay ningún servidor nuestro en medio de vuestras conversaciones, porque no tenemos ninguno.",
    items: [
      {
        title: "En tu equipo",
        body: "Los mensajes y los archivos se quedan en tu ordenador. Para guardarlos en otro sitio basta con copiar una carpeta.",
      },
      {
        title: "Cerrar sesión cierra de verdad",
        body: "Si echas a alguien o cierras una sesión, se cierra en ese momento. No se queda abierta por ahí hasta que caduque sola.",
      },
      {
        title: "Los archivos no muerden",
        body: "Lo que sube la gente se guarda apartado y se muestra sin ejecutarse, así que nadie puede colar un archivo que haga algo raro en tu equipo.",
      },
      {
        title: "Nadie te está mirando",
        body: "La aplicación no manda información a nadie. Ni lo que escribes, ni con quién hablas, ni cuánto tiempo pasas dentro.",
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
    sub: "Descarga, ábrelo, invita. Sin cuenta, sin tarjeta y sin desbloquear nada.",
    b1: "Descargar para Windows",
    b2: "Ver el código",
  },
  footer: {
    tagline: "Chat de voz y texto para comunidades. Gratis y abierto.",
    product: "Producto",
    project: "Proyecto",
    help: "Ayuda",
    links: {
      features: "Funciones",
      install: "Descargar",
      hosting: "Cómo funciona",
      news: "Novedades",
      code: "Código fuente",
      license: "Licencia",
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
    title: "Descargar Distop",
    sub: "Para Windows hay descarga directa. Lo abres y funciona: no hace falta instalar nada más.",
    download: {
      tag: "Windows",
      title: "Descargar Distop",
      sub: "Un .zip con el instalador dentro. Descomprimir, doble clic y listo.",
      cta: "Descargar para Windows",
      host: "Se descarga desde MediaFire",
      meta: ".zip · 246 MB · Windows 10 y 11 (64 bits)",
      stepsTitle: "Tres pasos",
      steps: [
        {
          title: "Descarga el .zip",
          body: "El botón abre la página de MediaFire. Ahí pulsa «Download» y espera a que termine.",
        },
        {
          title: "Descomprime el archivo",
          body: "Clic derecho sobre Distop.zip y «Extraer todo». Aparece una carpeta llamada release.",
        },
        {
          title: "Abre el instalador",
          body: "Dentro de release, doble clic en «Distop Setup 0.1.0.exe». Se instala solo y crea el acceso directo.",
        },
      ],
      warnTitle: "Windows va a avisarte",
      warn: "Al abrir el instalador saldrá una pantalla azul que dice «Windows protegió tu PC». Es porque el archivo no está firmado con un certificado de pago, no porque tenga nada raro. Pulsa «Más información» y luego «Ejecutar de todas formas».",
      portableTitle: "Si prefieres no instalar nada",
      portableBody:
        "El mismo .zip trae la carpeta win-unpacked. Ábrela y ejecuta Distop.exe directamente: funciona igual, no toca el sistema y cabe en un USB. A cambio, no se actualiza sola.",
    },
    reqTitle: "Lo que necesitas",
    reqs: [
      "Un PC con Windows 10 u 11.",
      "Que esté encendido mientras tus amigos estén dentro.",
      "Nada más: la aplicación trae dentro todo lo que necesita para funcionar.",
    ],
    advancedTitle: "¿Prefieres montarlo tú desde el código?",
    advancedNote:
      "Esta parte es para quien se maneja con la consola. Si solo quieres usar Distop, el botón de arriba es todo lo que necesitas.",
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
    ],
  },
  hosting: {
    title: "Cómo funciona",
    sub: "Distop no vive en la nube de nadie: vive en tu equipo. Esto es lo que eso significa en la práctica.",
    tunnelTitle: "Para que entren desde fuera de tu casa",
    tunnelBody:
      "Con un botón, Distop te da una dirección de internet para compartir. No hay que tocar la configuración del router ni saber qué es una IP: se la pasas a quien quieras y entra.",
    proxyTitle: "Cuánta gente aguanta",
    proxyBody:
      "Depende de tu equipo y de tu conexión, no de un plan que te vendamos. Un PC normal lleva a un grupo de amigos sin despeinarse. Si algún día se queda corto, se nota antes en la voz que en el chat.",
    backupTitle: "Guardar una copia",
    backupBody:
      "Todo lo tuyo son unos archivos en una carpeta. Cópiala a un disco externo o a la nube que uses y ya tienes copia de seguridad. Desde la propia aplicación también puedes descargar la comunidad entera de una vez.",
    offlineTitle: "Cuando apagas el PC",
    offlineBody:
      "Tus amigos no pueden entrar hasta que lo enciendas otra vez, y verán exactamente eso escrito, no un error raro. Es el precio de que nadie más tenga vuestras conversaciones.",
  },
  newsPage: {
    title: "Novedades",
    sub: "Lo que ha ido entrando, con fecha y sin adornos.",
  },
  privacy: {
    title: "Privacidad",
    sub: "La versión corta: esta página no te sigue, y la aplicación tampoco.",
    items: [
      {
        title: "Esta página",
        body: "Sin cookies, sin anuncios y sin nada que registre por dónde pasas. Ni siquiera las letras que estás leyendo vienen de fuera, así que nadie más sabe que has entrado aquí.",
      },
      {
        title: "La aplicación",
        body: "Distop no manda nada a ningún sitio. Tus mensajes, archivos y cuentas se quedan en el equipo donde la abriste. Quien manda ahí eres tú.",
      },
      {
        title: "Si algún día medimos algo",
        body: "Se avisará aquí, se podrá apagar, y jamás incluirá lo que escribes, los nombres de tus canales privados ni tus contraseñas.",
      },
      {
        title: "Enlaces a otros sitios",
        body: "Los enlaces a GitHub te sacan de aquí, y allí mandan sus normas. Nosotros no les contamos nada sobre ti.",
      },
    ],
    updated: "Última revisión: 22 de agosto de 2026.",
  },
};

/* Sin `as const` a propósito: con él, cada cadena del español se convierte en su
   propio tipo literal y `Dict` acaba exigiendo que el inglés diga exactamente lo
   mismo, letra por letra. Lo que se quiere comprobar es la forma, no el texto. */
type Dict = typeof es;

const en: Dict = {
  meta: {
    title: "Distop — Your community, no tolls",
    description:
      "Voice and text chat for your community. Everything other apps charge for is included here, free.",
  },
  skip: "Skip to content",
  nav: {
    features: "Features",
    install: "Download",
    hosting: "How it works",
    news: "News",
    code: "Code",
  },
  hero: {
    eyebrow: "Free · No account · No card",
    line1: "Your community,",
    line2: "no tolls",
    sub: "Voice and text chat for gaming with your people. Download it, open it, and the place is yours. Emojis, audio quality, themes, group size: everything other apps sell you comes built in.",
    cta1: "Download for Windows",
    cta2: "How it works",
    note: "Windows 10 and 11 · Nothing else to install",
  },
  free: {
    eyebrow: "Credits required: 0",
    title: "None of this costs money",
    sub: "There is no free version and paid version. There is one, and you get all of it from minute one.",
    items: [
      "Emojis and reactions",
      "Audio quality",
      "Uploading files",
      "Themes and colours",
      "Avatars and profile",
      "Community size",
      "Full history",
      "Taking your data with you",
    ],
    tag: "Included",
    footnote:
      "The only limit is your own machine: the space you have and how fast your connection is. Nothing is held back on purpose to sell you the good version.",
  },
  features: {
    eyebrow: "Select player",
    title: "What already works",
    sub: "Not a promise: this is what the version you can download today actually does.",
    items: [
      {
        tag: "Text",
        title: "Chat channels",
        body: "Categories, replies, reactions, pinned messages, editing, search and the whole history. Messages show up instantly, nothing to reload.",
      },
      {
        tag: "Voice",
        title: "Voice that works first try",
        body: "Join the channel and talk. No opening things on your router, no fighting with network settings: the audio travels the same path as the chat.",
      },
      {
        tag: "Roles",
        title: "Permissions that mean it",
        body: "33 permissions you grant per community, category, channel, role or person. Nobody can hand out what they do not have, and who did what gets written down.",
      },
      {
        tag: "Theme",
        title: "Customising without locks",
        body: "Colour, corners, lettering, chat background, animations and light or dark. No option has a padlock next to it.",
      },
      {
        tag: "People",
        title: "Inviting is sending a link",
        body: "Links that expire and have a limited number of uses. Whoever joins can stay without making an account, and add a password later without losing anything.",
      },
      {
        tag: "Data",
        title: "Your stuff leaves with you",
        body: "You can download your entire community, messages and files included, whenever you feel like it. Moving somewhere else is not a favour we do you.",
      },
    ],
  },
  host: {
    eyebrow: "Continue?",
    title: "Three steps and you are in",
    sub: "From hitting download to sending your friends the link.",
    steps: [
      {
        title: "Open it",
        body: "Download, unzip, double-click. No separate programs to install and no account to create on any website: the app already comes with everything it needs.",
      },
      {
        title: "Pick your name",
        body: "The first screen is not a login wall: you create your profile and your community in the same step. With a password or without one, your call.",
      },
      {
        title: "Invite people",
        body: "One button gives you an address to share, even if your friends live on the other side of the country. Send it and they are in.",
      },
    ],
    code: COMPOSE,
    codeLabel: "docker-compose.yml",
    warnTitle: "Worth knowing up front",
    warn: "Your community runs while your PC is on, exactly like a Minecraft server set up at home. Turn it off and your friends cannot get in until you turn it back on. We would rather tell you now than later.",
  },
  data: {
    eyebrow: "High score",
    title: "Nobody in the middle",
    sub: "There is no server of ours sitting in the middle of your conversations, because we do not have one.",
    items: [
      {
        title: "On your machine",
        body: "Messages and files stay on your computer. To keep them somewhere else, copying one folder is enough.",
      },
      {
        title: "Logging out really logs out",
        body: "If you kick someone or close a session, it closes right then. It does not linger somewhere until it expires on its own.",
      },
      {
        title: "Files cannot bite",
        body: "What people upload is stored off to the side and shown without running, so nobody can slip in a file that does something odd on your machine.",
      },
      {
        title: "Nobody is watching you",
        body: "The app does not send information to anyone. Not what you type, not who you talk to, not how long you stay.",
      },
    ],
  },
  news: {
    eyebrow: "News",
    title: "Latest rounds",
    all: "See all",
    readMore: "Read",
  },
  cta: {
    title: "Shall we play?",
    sub: "Download, open, invite. No account, no card, nothing to unlock.",
    b1: "Download for Windows",
    b2: "See the code",
  },
  footer: {
    tagline: "Voice and text chat for communities. Free and open.",
    product: "Product",
    project: "Project",
    help: "Help",
    links: {
      features: "Features",
      install: "Download",
      hosting: "How it works",
      news: "News",
      code: "Source code",
      license: "Licence",
      contributing: "Contributing",
      security: "Security",
      issues: "Report a bug",
      privacy: "Privacy",
    },
    legal:
      "Distop is free software under AGPL-3.0. Independent project, unaffiliated with Discord Inc. or any other platform.",
    langLabel: "Language",
  },
  install: {
    title: "Download Distop",
    sub: "For Windows there is a direct download. You open it and it works: nothing else to install.",
    download: {
      tag: "Windows",
      title: "Download Distop",
      sub: "A .zip with the installer inside. Extract it, double-click, done.",
      cta: "Download for Windows",
      host: "Hosted on MediaFire",
      meta: ".zip · 246 MB · Windows 10 and 11 (64-bit)",
      stepsTitle: "Three steps",
      steps: [
        {
          title: "Download the .zip",
          body: "The button opens the MediaFire page. Hit «Download» there and wait for it to finish.",
        },
        {
          title: "Extract the file",
          body: "Right-click Distop.zip and pick «Extract all». You get a folder called release.",
        },
        {
          title: "Open the installer",
          body: "Inside release, double-click «Distop Setup 0.1.0.exe». It installs itself and adds the shortcut.",
        },
      ],
      warnTitle: "Windows will warn you",
      warn: "Opening the installer brings up a blue screen saying «Windows protected your PC». That is because the file is not signed with a paid certificate, not because anything is wrong with it. Click «More info», then «Run anyway».",
      portableTitle: "If you would rather not install anything",
      portableBody:
        "The same .zip carries a win-unpacked folder. Open it and run Distop.exe directly: it works the same, touches nothing in the system and fits on a USB stick. The trade-off is that it will not update itself.",
    },
    reqTitle: "What you need",
    reqs: [
      "A PC running Windows 10 or 11.",
      "It on while your friends are inside.",
      "Nothing else: the app carries everything it needs to run.",
    ],
    advancedTitle: "Would you rather build it yourself from source?",
    advancedNote:
      "This part is for people comfortable with a terminal. If you just want to use Distop, the button above is all you need.",
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
    ],
  },
  hosting: {
    title: "How it works",
    sub: "Distop does not live in anyone's cloud: it lives on your machine. Here is what that means in practice.",
    tunnelTitle: "So people can join from outside your house",
    tunnelBody:
      "With one button, Distop gives you an internet address to share. No touching router settings, no needing to know what an IP is: send it to whoever you want and they are in.",
    proxyTitle: "How many people it holds",
    proxyBody:
      "It depends on your machine and your connection, not on a plan we sell you. A normal PC carries a group of friends without breaking a sweat. If it ever falls short, you notice it in the voice before the chat.",
    backupTitle: "Keeping a copy",
    backupBody:
      "Everything of yours is some files in a folder. Copy it to an external drive or whatever cloud you use and you have a backup. From inside the app you can also download the whole community in one go.",
    offlineTitle: "When you turn the PC off",
    offlineBody:
      "Your friends cannot get in until you turn it back on, and they will see exactly that written out, not some vague error. It is the price of nobody else holding your conversations.",
  },
  newsPage: {
    title: "News",
    sub: "What has landed, dated and without decoration.",
  },
  privacy: {
    title: "Privacy",
    sub: "The short version: this page does not follow you, and neither does the app.",
    items: [
      {
        title: "This page",
        body: "No cookies, no ads and nothing recording where you go. Not even the lettering you are reading comes from outside, so nobody else knows you were here.",
      },
      {
        title: "The app",
        body: "Distop sends nothing anywhere. Your messages, files and accounts stay on the machine where you opened it. You are the one in charge there.",
      },
      {
        title: "If we ever measure anything",
        body: "It will be announced here, it will be possible to switch off, and it will never include what you write, the names of your private channels or your passwords.",
      },
      {
        title: "Links to other sites",
        body: "Links to GitHub take you off this page, where their rules apply. We tell them nothing about you.",
      },
    ],
    updated: "Last reviewed: 22 August 2026.",
  },
};

const ptBR: Dict = {
  meta: {
    title: "Distop — Sua comunidade, sem pedágio",
    description:
      "Chat de voz e texto para a sua comunidade. Tudo o que os outros aplicativos cobram já vem incluído aqui, de graça.",
  },
  skip: "Pular para o conteúdo",
  nav: {
    features: "Recursos",
    install: "Baixar",
    hosting: "Como funciona",
    news: "Novidades",
    code: "Código",
  },
  hero: {
    eyebrow: "Grátis · Sem conta · Sem cartão",
    line1: "Sua comunidade,",
    line2: "sem pedágio",
    sub: "Chat de voz e texto para jogar com a sua turma. Você baixa, abre e o lugar já é seu. Emojis, qualidade de áudio, temas, tamanho do grupo: tudo o que os outros vendem, aqui já vem junto.",
    cta1: "Baixar para Windows",
    cta2: "Como funciona",
    note: "Windows 10 e 11 · Não precisa instalar mais nada",
  },
  free: {
    eyebrow: "Créditos necessários: 0",
    title: "Nada disso se paga",
    sub: "Não existe uma versão grátis e outra paga. Existe uma só, e você tem ela inteira desde o primeiro minuto.",
    items: [
      "Emojis e reações",
      "Qualidade de áudio",
      "Enviar arquivos",
      "Temas e cores",
      "Avatares e perfil",
      "Tamanho da comunidade",
      "Histórico completo",
      "Levar seus dados embora",
    ],
    tag: "Incluído",
    footnote:
      "O único limite é a sua própria máquina: o espaço que você tem e o quão rápida é a sua conexão. Nada fica travado de propósito para te vender a versão boa.",
  },
  features: {
    eyebrow: "Select player",
    title: "O que já funciona",
    sub: "Não é promessa: é o que a versão que você pode baixar hoje realmente faz.",
    items: [
      {
        tag: "Texto",
        title: "Canais de chat",
        body: "Categorias, respostas, reações, mensagens fixadas, editar, buscar e todo o histórico. As mensagens aparecem na hora, sem recarregar nada.",
      },
      {
        tag: "Voz",
        title: "Voz que entra de primeira",
        body: "Você entra no canal e fala. Não precisa abrir nada no roteador nem brigar com a configuração da rede: o áudio vai pelo mesmo caminho do chat.",
      },
      {
        tag: "Cargos",
        title: "Permissões de verdade",
        body: "33 permissões que você dá por comunidade, categoria, canal, cargo ou pessoa. Ninguém distribui o que não tem, e fica registrado quem fez o quê.",
      },
      {
        tag: "Tema",
        title: "Personalizar sem cadeados",
        body: "Cor, cantos, letra, fundo do chat, animações e tema claro ou escuro. Nenhuma opção tem cadeado do lado.",
      },
      {
        tag: "Gente",
        title: "Convidar é mandar um link",
        body: "Links com prazo e número de usos contado. Quem entra pode ficar sem criar conta, e colocar senha depois sem perder nada.",
      },
      {
        tag: "Dados",
        title: "Suas coisas saem com você",
        body: "Dá para baixar a comunidade inteira, com mensagens e arquivos, na hora que você quiser. Mudar de lugar não é favor que a gente faz.",
      },
    ],
  },
  host: {
    eyebrow: "Continue?",
    title: "Três passos e você está dentro",
    sub: "De clicar em baixar até mandar o link para os amigos.",
    steps: [
      {
        title: "Abra",
        body: "Baixa, descompacta e clica duas vezes. Não tem programa separado para instalar nem conta para criar em site nenhum: o aplicativo já vem com tudo o que precisa.",
      },
      {
        title: "Escolha seu nome",
        body: "A primeira tela não é um muro de login: você cria seu perfil e sua comunidade no mesmo passo. Com senha ou sem, você decide.",
      },
      {
        title: "Convide",
        body: "Um botão te dá um endereço para compartilhar, mesmo que seus amigos morem do outro lado do país. Você manda e eles entram.",
      },
    ],
    code: COMPOSE,
    codeLabel: "docker-compose.yml",
    warnTitle: "Isso é bom você saber",
    warn: "Sua comunidade funciona enquanto o seu PC estiver ligado, igualzinho a um servidor de Minecraft montado em casa. Se desligar, seus amigos não entram até você ligar de novo. A gente prefere avisar agora do que depois.",
  },
  data: {
    eyebrow: "High score",
    title: "Sem intermediários",
    sub: "Não tem nenhum servidor nosso no meio das suas conversas, porque a gente não tem nenhum.",
    items: [
      {
        title: "Na sua máquina",
        body: "As mensagens e os arquivos ficam no seu computador. Para guardar em outro lugar, basta copiar uma pasta.",
      },
      {
        title: "Sair da conta sai de verdade",
        body: "Se você expulsa alguém ou encerra uma sessão, ela encerra naquele momento. Não fica aberta por aí até vencer sozinha.",
      },
      {
        title: "Os arquivos não mordem",
        body: "O que o pessoal envia fica guardado separado e é exibido sem executar, então ninguém consegue enfiar um arquivo que faça algo estranho na sua máquina.",
      },
      {
        title: "Ninguém está te olhando",
        body: "O aplicativo não manda informação para ninguém. Nem o que você escreve, nem com quem você fala, nem quanto tempo você fica.",
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
    title: "Bora jogar?",
    sub: "Baixa, abre, convida. Sem conta, sem cartão e sem desbloquear nada.",
    b1: "Baixar para Windows",
    b2: "Ver o código",
  },
  footer: {
    tagline: "Chat de voz e texto para comunidades. Grátis e aberto.",
    product: "Produto",
    project: "Projeto",
    help: "Ajuda",
    links: {
      features: "Recursos",
      install: "Baixar",
      hosting: "Como funciona",
      news: "Novidades",
      code: "Código-fonte",
      license: "Licença",
      contributing: "Contribuir",
      security: "Segurança",
      issues: "Relatar um problema",
      privacy: "Privacidade",
    },
    legal:
      "O Distop é software livre sob AGPL-3.0. Projeto independente, sem relação com a Discord Inc. nem com qualquer outra plataforma.",
    langLabel: "Idioma",
  },
  install: {
    title: "Baixar o Distop",
    sub: "Para Windows tem download direto. Você abre e funciona: não precisa instalar mais nada.",
    download: {
      tag: "Windows",
      title: "Baixar o Distop",
      sub: "Um .zip com o instalador dentro. Descompactar, clicar duas vezes e pronto.",
      cta: "Baixar para Windows",
      host: "Baixa pelo MediaFire",
      meta: ".zip · 246 MB · Windows 10 e 11 (64 bits)",
      stepsTitle: "Três passos",
      steps: [
        {
          title: "Baixe o .zip",
          body: "O botão abre a página do MediaFire. Clique em «Download» e espere terminar.",
        },
        {
          title: "Descompacte o arquivo",
          body: "Clique com o botão direito em Distop.zip e escolha «Extrair tudo». Aparece uma pasta chamada release.",
        },
        {
          title: "Abra o instalador",
          body: "Dentro de release, clique duas vezes em «Distop Setup 0.1.0.exe». Ele se instala sozinho e cria o atalho.",
        },
      ],
      warnTitle: "O Windows vai avisar",
      warn: "Ao abrir o instalador aparece uma tela azul dizendo «O Windows protegeu o seu PC». É porque o arquivo não está assinado com um certificado pago, não porque tenha algo de errado. Clique em «Mais informações» e depois em «Executar assim mesmo».",
      portableTitle: "Se preferir não instalar nada",
      portableBody:
        "O mesmo .zip traz a pasta win-unpacked. Abra e execute o Distop.exe direto: funciona igual, não mexe no sistema e cabe num pendrive. Em troca, não se atualiza sozinho.",
    },
    reqTitle: "O que você precisa",
    reqs: [
      "Um PC com Windows 10 ou 11.",
      "Ele ligado enquanto seus amigos estiverem dentro.",
      "Mais nada: o aplicativo traz dentro tudo o que precisa para funcionar.",
    ],
    advancedTitle: "Prefere montar você mesmo pelo código?",
    advancedNote:
      "Esta parte é para quem se vira no terminal. Se você só quer usar o Distop, o botão lá de cima é tudo o que precisa.",
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
    ],
  },
  hosting: {
    title: "Como funciona",
    sub: "O Distop não mora na nuvem de ninguém: mora na sua máquina. É isso que significa na prática.",
    tunnelTitle: "Para entrarem de fora da sua casa",
    tunnelBody:
      "Com um botão, o Distop te dá um endereço de internet para compartilhar. Não precisa mexer na configuração do roteador nem saber o que é um IP: você manda para quem quiser e a pessoa entra.",
    proxyTitle: "Quanta gente aguenta",
    proxyBody:
      "Depende da sua máquina e da sua conexão, não de um plano que a gente te venda. Um PC comum leva um grupo de amigos sem suar. Se um dia ficar apertado, dá para perceber na voz antes do chat.",
    backupTitle: "Guardar uma cópia",
    backupBody:
      "Tudo o que é seu são uns arquivos numa pasta. Copie para um HD externo ou para a nuvem que você usa e já tem backup. De dentro do aplicativo também dá para baixar a comunidade inteira de uma vez.",
    offlineTitle: "Quando você desliga o PC",
    offlineBody:
      "Seus amigos não conseguem entrar até você ligar de novo, e vão ver exatamente isso escrito, não um erro esquisito. É o preço de mais ninguém ter as conversas de vocês.",
  },
  newsPage: {
    title: "Novidades",
    sub: "O que foi entrando, com data e sem enfeite.",
  },
  privacy: {
    title: "Privacidade",
    sub: "A versão curta: esta página não te segue, e o aplicativo também não.",
    items: [
      {
        title: "Esta página",
        body: "Sem cookies, sem anúncios e sem nada que registre por onde você passa. Nem as letras que você está lendo vêm de fora, então mais ninguém sabe que você esteve aqui.",
      },
      {
        title: "O aplicativo",
        body: "O Distop não manda nada para lugar nenhum. Suas mensagens, arquivos e contas ficam na máquina onde você abriu. Quem manda ali é você.",
      },
      {
        title: "Se um dia a gente medir alguma coisa",
        body: "Vai ser avisado aqui, vai dar para desligar, e nunca vai incluir o que você escreve, os nomes dos seus canais privados nem as suas senhas.",
      },
      {
        title: "Links para outros sites",
        body: "Os links para o GitHub te tiram daqui, e lá valem as regras deles. A gente não conta nada sobre você para eles.",
      },
    ],
    updated: "Última revisão: 22 de agosto de 2026.",
  },
};

export const UI: Record<Locale, Dict> = { es, en, "pt-br": ptBR };

/** Prefijo de ruta del locale, siempre con barras a los dos lados. */
export const path = (locale: Locale, rest = ""): string => `/${locale}/${rest}`;
