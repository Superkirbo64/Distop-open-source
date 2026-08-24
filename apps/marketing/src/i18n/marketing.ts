import type { Locale } from "./ui";

/** Contenido ampliado del sitio. Se mantiene separado del diccionario histórico
 * para que las páginas nuevas puedan evolucionar sin mezclar texto de producto
 * con instrucciones del instalador. */
const es = {
  navTutorials: "Tutoriales",
  preview: {
    eyebrow: "Gameplay real",
    title: "Míralo antes de instalarlo",
    sub: "Dos recorridos cortos, hechos con la interfaz de Distop: cómo se siente la comunidad y cómo llega el enlace a tus amigos.",
    productTitle: "Chat, voz y personalidad",
    productBody: "Canales, mensajes, overlay de voz y perfiles con temas propios en una sola aplicación.",
    hostingTitle: "Tu PC, dos caminos",
    hostingBody: "Cloudflare para empezar en automático o Tailscale Funnel para conservar una dirección fija.",
    videoFallback: "Tu navegador no puede reproducir esta vista previa.",
    openTutorials: "Ver todos los tutoriales",
  },
  capabilities: {
    eyebrow: "Inventario completo",
    title: "Más que texto y voz",
    sub: "Todo esto está dentro de la versión actual. Sin niveles de pago ni botones de muestra.",
    groups: [
      {
        tag: "Hablar",
        title: "Conversaciones que no se quedan cortas",
        body: "Texto en tiempo real, voz, vídeo y pantalla compartida, con herramientas para mantener el orden.",
        items: ["Canales de texto, voz y anuncios", "Respuestas, reacciones, fijados y búsqueda", "Cámara y pantalla compartida", "Overlay transparente que marca quién habla"],
      },
      {
        tag: "Crear",
        title: "Una comunidad con cara propia",
        body: "El perfil y el espacio se pueden llevar mucho más lejos que cambiar un solo color.",
        items: ["Avatares, banners y decoraciones", "Fuentes gamer y nombres animados", "Temas, fondos y paleta completa", "Emojis, stickers y sonidos propios"],
      },
      {
        tag: "Mandar",
        title: "Control sin convertirlo en trabajo",
        body: "La administración es profunda cuando la necesitas y discreta cuando solo quieres jugar.",
        items: ["33 permisos y roles ordenados", "Reglas por categoría, canal o persona", "Invitaciones con caducidad y usos", "Registro de acciones importantes"],
      },
      {
        tag: "Conservar",
        title: "La comunidad sigue siendo tuya",
        body: "Puedes mover, guardar o limpiar tus datos sin pedir permiso a una plataforma.",
        items: ["Identidad portable al cambiar de dirección", "Exportación de mensajes y archivos", "Copia de seguridad copiando una carpeta", "Borrado del historial sin borrar la comunidad"],
      },
    ],
  },
  hostingModes: {
    eyebrow: "Elige ruta",
    title: "Dos formas de compartir tu comunidad",
    sub: "Las dos evitan abrir puertos del router. Puedes empezar con una y cambiar después.",
    items: [
      {
        badge: "Más rápido",
        title: "Cloudflare automático",
        body: "Distop crea el enlace por ti. No pide cuenta ni dominio; si reinicias el túnel, la dirección puede cambiar.",
        steps: ["Pulsa compartir", "Espera la dirección", "Copia el enlace"],
      },
      {
        badge: "Dirección fija",
        title: "Tailscale Funnel",
        body: "Requiere iniciar sesión una vez. Cuando Tailscale pida habilitar Funnel, Distop abre la página exacta y luego reintentas.",
        steps: ["Conecta Tailscale", "Habilita Funnel desde el enlace", "Reintenta y guarda la dirección"],
      },
    ],
    cta: "Aprender a configurarlo",
  },
  tutorials: {
    title: "Tutoriales de Distop",
    sub: "Guías cortas, con el resultado esperado en cada paso. Empieza por la primera o salta directamente a lo que necesitas.",
    eyebrow: "Player guide",
    indexTitle: "Elige una misión",
    stepLabel: "Paso",
    resultLabel: "Al terminar",
    timeLabel: "Tiempo",
    backTop: "Volver al índice",
    officialGuide: "Abrir tutorial oficial",
    items: [
      {
        id: "primera-comunidad",
        tag: "Inicio",
        title: "Crear tu primera comunidad",
        summary: "Instala Distop, crea tu perfil y entrega la primera invitación.",
        time: "3 minutos",
        steps: ["Descarga el instalador de Windows y abre Distop.", "Elige tu nombre, avatar y contraseña opcional.", "Crea la comunidad y ponle nombre e icono.", "Pulsa Invitar, copia el enlace y envíalo a tus amigos."],
        result: "Tendrás una comunidad funcionando desde tu PC y un enlace listo para compartir.",
      },
      {
        id: "cloudflare",
        tag: "Rápido",
        title: "Publicar con Cloudflare automático",
        summary: "La opción más directa, sin cuenta, dominio ni configuración del router.",
        time: "1 minuto",
        steps: ["Abre el asistente de conexión de Distop.", "Elige Cloudflare automático y pulsa Continuar.", "Espera a que aparezca la dirección HTTPS.", "Cópiala y compártela. Si reinicias el túnel, comparte la nueva dirección."],
        result: "Tus amigos podrán entrar desde internet sin que abras ningún puerto.",
      },
      {
        id: "tailscale-funnel",
        tag: "Fijo",
        title: "Conservar una dirección con Tailscale Funnel",
        summary: "Una activación inicial para mantener el mismo enlace después de reiniciar.",
        time: "5 minutos",
        steps: ["Instala Tailscale, inicia sesión y vuelve a Distop.", "Elige Tailscale Funnel, pulsa Continuar y después Reintentar.", "La primera vez puede fallar y mostrar un enlace destacado. Ábrelo: te lleva directamente a la página para habilitar HTTPS/Funnel.", "Autoriza Funnel, vuelve a Distop y pulsa Reintentar otra vez.", "Copia la dirección fija que muestra el asistente."],
        result: "La comunidad conservará su dirección mientras mantengas la misma cuenta y nombre del equipo en Tailscale.",
        link: "https://tailscale.com/docs/features/tailscale-funnel",
      },
      {
        id: "overlay-voz",
        tag: "Voz",
        title: "Usar el overlay mientras juegas",
        summary: "Ve quién está en la sala sin mantener abierta la ventana completa.",
        time: "1 minuto",
        steps: ["Entra en un canal de voz desde la aplicación de escritorio.", "Minimiza Distop; aparecerá la interfaz transparente con los avatares.", "Cuando alguien hable, su avatar recupera opacidad y muestra un aro.", "Arrastra el overlay a una zona que no tape el juego."],
        result: "Podrás seguir la conversación y reconocer a quien habla con una indicación simple.",
      },
      {
        id: "personalizar",
        tag: "Estilo",
        title: "Personalizar perfil y nombres",
        summary: "Combina fuentes gamer, animaciones, colores, avatar, banner y decoración.",
        time: "2 minutos",
        steps: ["Abre Ajustes y entra en Perfil.", "Despliega Estilo del nombre y elige una fuente y un efecto animado.", "Abre Color del nombre para usar la paleta o seleccionar un color exacto.", "Completa el perfil con avatar, banner, decoración, tema y fondo."],
        result: "Tu nombre y tarjeta tendrán un estilo propio visible dentro de la comunidad.",
      },
      {
        id: "datos",
        tag: "Copia",
        title: "Guardar o mover tus datos",
        summary: "Haz una copia completa y conserva tu identidad cuando cambie el enlace.",
        time: "3 minutos",
        steps: ["Desde administración, descarga la exportación de la comunidad.", "Guarda también una copia de la carpeta de datos del servidor.", "Si cambia la dirección pública, abre el nuevo enlace con el mismo perfil portable.", "Comprueba que Distop te reconoce como el mismo miembro antes de borrar la copia antigua."],
        result: "Tendrás mensajes, archivos y configuración guardados, y tu miembro seguirá siendo el mismo.",
      },
    ],
  },
};

type MarketingCopy = typeof es;

const en: MarketingCopy = {
  navTutorials: "Tutorials",
  preview: {
    eyebrow: "Real gameplay",
    title: "See it before installing",
    sub: "Two short tours built with the Distop interface: how the community feels and how the invite reaches your friends.",
    productTitle: "Chat, voice and personality",
    productBody: "Channels, messages, voice overlay and themed profiles in one application.",
    hostingTitle: "Your PC, two routes",
    hostingBody: "Cloudflare for an automatic start or Tailscale Funnel to keep a fixed address.",
    videoFallback: "Your browser cannot play this preview.",
    openTutorials: "See every tutorial",
  },
  capabilities: {
    eyebrow: "Full inventory",
    title: "More than text and voice",
    sub: "All of this is in the current version. No paid tiers or demo buttons.",
    groups: [
      { tag: "Talk", title: "Conversations that do not fall short", body: "Real-time text, voice, video and screen sharing, with tools that keep things tidy.", items: ["Text, voice and announcement channels", "Replies, reactions, pins and search", "Camera and screen sharing", "Transparent overlay showing who speaks"] },
      { tag: "Create", title: "A community with its own face", body: "Profiles and spaces go much further than changing one colour.", items: ["Avatars, banners and decorations", "Gaming fonts and animated names", "Themes, backgrounds and full colour palette", "Custom emoji, stickers and sounds"] },
      { tag: "Manage", title: "Control without turning it into work", body: "Administration is deep when you need it and quiet when you just want to play.", items: ["33 ordered permissions and roles", "Rules per category, channel or person", "Expiring and limited-use invites", "Log of important actions"] },
      { tag: "Keep", title: "The community stays yours", body: "Move, save or clear your data without asking a platform for permission.", items: ["Portable identity when an address changes", "Message and file export", "Back up by copying one folder", "Clear history without deleting the community"] },
    ],
  },
  hostingModes: {
    eyebrow: "Choose route", title: "Two ways to share your community", sub: "Both avoid opening router ports. Start with either and switch later.",
    items: [
      { badge: "Fastest", title: "Automatic Cloudflare", body: "Distop creates the link for you. No account or domain; restarting the tunnel may change the address.", steps: ["Press share", "Wait for the address", "Copy the link"] },
      { badge: "Fixed address", title: "Tailscale Funnel", body: "Sign in once. When Tailscale asks to enable Funnel, Distop opens the exact page and you retry.", steps: ["Connect Tailscale", "Enable Funnel from the link", "Retry and save the address"] },
    ], cta: "Learn how to set it up",
  },
  tutorials: {
    title: "Distop tutorials", sub: "Short guides with the expected result at every step. Start at the beginning or jump straight to what you need.", eyebrow: "Player guide", indexTitle: "Choose a mission", stepLabel: "Step", resultLabel: "When finished", timeLabel: "Time", backTop: "Back to index", officialGuide: "Open official tutorial",
    items: [
      { id: "first-community", tag: "Start", title: "Create your first community", summary: "Install Distop, create your profile and send the first invite.", time: "3 minutes", steps: ["Download the Windows installer and open Distop.", "Choose your name, avatar and optional password.", "Create the community and give it a name and icon.", "Press Invite, copy the link and send it to your friends."], result: "You will have a community running from your PC and a link ready to share." },
      { id: "cloudflare", tag: "Quick", title: "Publish with automatic Cloudflare", summary: "The most direct choice, without an account, domain or router configuration.", time: "1 minute", steps: ["Open Distop's connection assistant.", "Choose Automatic Cloudflare and press Continue.", "Wait for the HTTPS address to appear.", "Copy and share it. If the tunnel restarts, share the new address."], result: "Your friends can join over the internet without you opening any ports." },
      { id: "tailscale-funnel", tag: "Fixed", title: "Keep one address with Tailscale Funnel", summary: "One initial activation to retain the same link after restarts.", time: "5 minutes", steps: ["Install Tailscale, sign in and return to Distop.", "Choose Tailscale Funnel, press Continue, then Retry.", "The first attempt may fail and show a highlighted link. Open it: it goes directly to the page that enables HTTPS/Funnel.", "Authorise Funnel, return to Distop and press Retry again.", "Copy the fixed address shown by the assistant."], result: "The community keeps its address while you retain the same Tailscale account and machine name.", link: "https://tailscale.com/docs/features/tailscale-funnel" },
      { id: "voice-overlay", tag: "Voice", title: "Use the overlay while gaming", summary: "See who is in the room without keeping the full window open.", time: "1 minute", steps: ["Join a voice channel in the desktop app.", "Minimise Distop; the transparent avatar interface appears.", "When someone speaks, their avatar becomes opaque and gains a ring.", "Drag the overlay somewhere that does not cover the game."], result: "You can follow the room and recognise the speaker through one simple cue." },
      { id: "customise", tag: "Style", title: "Customise profiles and names", summary: "Combine gaming fonts, animations, colours, avatar, banner and decoration.", time: "2 minutes", steps: ["Open Settings and enter Profile.", "Expand Name style and choose a font and animated effect.", "Open Name colour to use the palette or pick an exact colour.", "Finish the profile with an avatar, banner, decoration, theme and background."], result: "Your name and profile card will have a distinctive style throughout the community." },
      { id: "data", tag: "Backup", title: "Save or move your data", summary: "Make a full backup and preserve your identity when the link changes.", time: "3 minutes", steps: ["Download the community export from administration.", "Also save a copy of the server data folder.", "If the public address changes, open the new link with the same portable profile.", "Check Distop recognises you as the same member before deleting the old copy."], result: "Messages, files and settings will be saved, and your member identity will stay the same." },
    ],
  },
};

const pt: MarketingCopy = {
  navTutorials: "Tutoriais",
  preview: {
    eyebrow: "Gameplay real", title: "Veja antes de instalar", sub: "Dois passeios curtos feitos com a interface do Distop: como a comunidade funciona e como o convite chega aos seus amigos.", productTitle: "Chat, voz e personalidade", productBody: "Canais, mensagens, overlay de voz e perfis com temas em um só aplicativo.", hostingTitle: "Seu PC, dois caminhos", hostingBody: "Cloudflare para começar automaticamente ou Tailscale Funnel para manter um endereço fixo.", videoFallback: "Seu navegador não consegue reproduzir esta prévia.", openTutorials: "Ver todos os tutoriais",
  },
  capabilities: {
    eyebrow: "Inventário completo", title: "Mais do que texto e voz", sub: "Tudo isso já está na versão atual. Sem níveis pagos nem botões de demonstração.",
    groups: [
      { tag: "Falar", title: "Conversas que não ficam pela metade", body: "Texto em tempo real, voz, vídeo e compartilhamento de tela, com ferramentas para manter a ordem.", items: ["Canais de texto, voz e anúncios", "Respostas, reações, fixados e busca", "Câmera e compartilhamento de tela", "Overlay transparente mostrando quem fala"] },
      { tag: "Criar", title: "Uma comunidade com cara própria", body: "O perfil e o espaço vão muito além de trocar uma única cor.", items: ["Avatares, banners e decorações", "Fontes gamer e nomes animados", "Temas, fundos e paleta completa", "Emojis, stickers e sons próprios"] },
      { tag: "Gerir", title: "Controle sem virar trabalho", body: "A administração é profunda quando você precisa e discreta quando só quer jogar.", items: ["33 permissões e cargos ordenados", "Regras por categoria, canal ou pessoa", "Convites com validade e usos", "Registro de ações importantes"] },
      { tag: "Guardar", title: "A comunidade continua sua", body: "Mova, salve ou limpe seus dados sem pedir permissão a uma plataforma.", items: ["Identidade portátil quando o endereço muda", "Exportação de mensagens e arquivos", "Backup copiando uma pasta", "Limpeza do histórico sem apagar a comunidade"] },
    ],
  },
  hostingModes: {
    eyebrow: "Escolha a rota", title: "Duas formas de compartilhar sua comunidade", sub: "As duas evitam abrir portas no roteador. Comece com uma e troque depois.",
    items: [
      { badge: "Mais rápido", title: "Cloudflare automático", body: "O Distop cria o link para você. Não pede conta nem domínio; reiniciar o túnel pode mudar o endereço.", steps: ["Clique em compartilhar", "Espere o endereço", "Copie o link"] },
      { badge: "Endereço fixo", title: "Tailscale Funnel", body: "Entre uma vez. Quando o Tailscale pedir para ativar Funnel, o Distop abre a página exata e você tenta novamente.", steps: ["Conecte o Tailscale", "Ative Funnel pelo link", "Tente de novo e salve o endereço"] },
    ], cta: "Aprender a configurar",
  },
  tutorials: {
    title: "Tutoriais do Distop", sub: "Guias curtos com o resultado esperado em cada passo. Comece pelo primeiro ou pule direto para o que precisa.", eyebrow: "Player guide", indexTitle: "Escolha uma missão", stepLabel: "Passo", resultLabel: "Ao terminar", timeLabel: "Tempo", backTop: "Voltar ao índice", officialGuide: "Abrir tutorial oficial",
    items: [
      { id: "primeira-comunidade", tag: "Início", title: "Criar sua primeira comunidade", summary: "Instale o Distop, crie seu perfil e envie o primeiro convite.", time: "3 minutos", steps: ["Baixe o instalador do Windows e abra o Distop.", "Escolha nome, avatar e senha opcional.", "Crie a comunidade e defina nome e ícone.", "Clique em Convidar, copie o link e envie aos amigos."], result: "Você terá uma comunidade rodando no seu PC e um link pronto para compartilhar." },
      { id: "cloudflare", tag: "Rápido", title: "Publicar com Cloudflare automático", summary: "A opção mais direta, sem conta, domínio ou configuração do roteador.", time: "1 minuto", steps: ["Abra o assistente de conexão do Distop.", "Escolha Cloudflare automático e clique em Continuar.", "Espere o endereço HTTPS aparecer.", "Copie e compartilhe. Se o túnel reiniciar, compartilhe o novo endereço."], result: "Seus amigos poderão entrar pela internet sem você abrir nenhuma porta." },
      { id: "tailscale-funnel", tag: "Fixo", title: "Manter um endereço com Tailscale Funnel", summary: "Uma ativação inicial para conservar o mesmo link após reiniciar.", time: "5 minutos", steps: ["Instale o Tailscale, faça login e volte ao Distop.", "Escolha Tailscale Funnel, clique em Continuar e depois em Tentar novamente.", "A primeira tentativa pode falhar e mostrar um link destacado. Abra-o: ele leva direto à página para ativar HTTPS/Funnel.", "Autorize Funnel, volte ao Distop e tente novamente.", "Copie o endereço fixo mostrado pelo assistente."], result: "A comunidade manterá o endereço enquanto você conservar a mesma conta e nome do computador no Tailscale.", link: "https://tailscale.com/docs/features/tailscale-funnel" },
      { id: "overlay-voz", tag: "Voz", title: "Usar o overlay enquanto joga", summary: "Veja quem está na sala sem manter a janela inteira aberta.", time: "1 minuto", steps: ["Entre em um canal de voz no aplicativo desktop.", "Minimize o Distop; a interface transparente com avatares aparece.", "Quando alguém fala, o avatar fica opaco e recebe um aro.", "Arraste o overlay para uma área que não cubra o jogo."], result: "Você acompanhará a sala e reconhecerá quem fala com uma indicação simples." },
      { id: "personalizar", tag: "Estilo", title: "Personalizar perfil e nomes", summary: "Combine fontes gamer, animações, cores, avatar, banner e decoração.", time: "2 minutos", steps: ["Abra Ajustes e entre em Perfil.", "Abra Estilo do nome e escolha uma fonte e um efeito animado.", "Abra Cor do nome para usar a paleta ou escolher uma cor exata.", "Complete o perfil com avatar, banner, decoração, tema e fundo."], result: "Seu nome e cartão terão um estilo próprio visível na comunidade." },
      { id: "dados", tag: "Backup", title: "Salvar ou mover seus dados", summary: "Faça uma cópia completa e preserve sua identidade quando o link mudar.", time: "3 minutos", steps: ["Baixe a exportação da comunidade pela administração.", "Guarde também uma cópia da pasta de dados do servidor.", "Se o endereço público mudar, abra o novo link com o mesmo perfil portátil.", "Confirme que o Distop reconhece você como o mesmo membro antes de apagar a cópia antiga."], result: "Mensagens, arquivos e configurações estarão salvos, e sua identidade continuará a mesma." },
    ],
  },
};

export const MARKETING: Record<Locale, MarketingCopy> = { es, en, "pt-br": pt };
