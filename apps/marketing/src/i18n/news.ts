import type { Locale } from "./ui";

/**
 * Entradas reales del desarrollo, con la fecha en que se hicieron. Se quedan aquí
 * y no en un CMS: son cuatro por año y un archivo es más barato de mantener que
 * una integración.
 */
export type Entry = {
  /** ISO, para `<time datetime>` y para ordenar. */
  date: string;
  title: Record<Locale, string>;
  body: Record<Locale, string>;
};

export const NEWS: Entry[] = [
  {
    date: "2026-08-02",
    title: {
      es: "La voz va directa entre vosotros",
      en: "Voice goes straight between you",
      "pt-br": "A voz vai direto entre vocês",
    },
    body: {
      es: "Los canales de voz ya funcionan. El audio viaja directo de una persona a otra, sin pasar por ningún sitio en medio, y por eso un PC de casa aguanta perfectamente una sala. Hasta unas seis personas por canal se oye bien; a partir de ahí la cosa se resiente y ya estamos en ello.",
      en: "Voice channels work now. Audio travels straight from one person to another, without passing through anywhere in between, which is why a home PC handles a room just fine. Up to around six people per channel sounds good; past that it starts to suffer, and we are on it.",
      "pt-br": "Os canais de voz já funcionam. O áudio vai direto de uma pessoa para a outra, sem passar por lugar nenhum no meio, e por isso um PC de casa aguenta bem uma sala. Até umas seis pessoas por canal se ouve bem; daí para cima a coisa piora, e já estamos cuidando disso.",
    },
  },
  {
    date: "2026-08-02",
    title: {
      es: "Entrar sin cuenta deja de ser una versión recortada",
      en: "Joining without an account stops being a trimmed-down version",
      "pt-br": "Entrar sem conta deixa de ser uma versão cortada",
    },
    body: {
      es: "Antes, quien entraba como invitado podía leer y escribir, pero no crear su propia comunidad: eso convertía el modo invitado en una demo. Ahora invitado y cuenta pueden exactamente lo mismo. La contraseña sirve para volver desde otro dispositivo, no para desbloquear nada.",
      en: "Guests used to be able to read and write but not create a community of their own, which turned guest mode into a demo. Now guests and accounts can do exactly the same things. A password is for coming back from another device, not for unlocking anything.",
      "pt-br": "Antes, quem entrava como convidado podia ler e escrever, mas não criar a própria comunidade: isso transformava o modo convidado numa demonstração. Agora convidado e conta podem exatamente o mesmo. A senha serve para voltar de outro aparelho, não para desbloquear nada.",
    },
  },
  {
    date: "2026-08-01",
    title: {
      es: "Hospedar ya no exige loguearse primero",
      en: "Hosting no longer demands a login first",
      "pt-br": "Hospedar não exige mais fazer login antes",
    },
    body: {
      es: "La primera pantalla al abrirlo era un muro de acceso a un sitio que ya era tuyo. Ahora es la puesta en marcha: pones tu nombre y creas tu comunidad de una vez. Desde tu propio equipo no te pide nada más, porque estar sentado delante ya es prueba suficiente.",
      en: "The first screen when you opened it was a login wall to a place that was already yours. Now it is the setup: you put in your name and create your community in one go. From your own machine it asks for nothing else, because sitting in front of it is proof enough.",
      "pt-br": "A primeira tela ao abrir era um muro de login para um lugar que já era seu. Agora é a configuração inicial: você põe seu nome e cria sua comunidade de uma vez. Da sua própria máquina não pede mais nada, porque estar sentado na frente já é prova suficiente.",
    },
  },
  {
    date: "2026-08-01",
    title: {
      es: "Errores que dicen la verdad",
      en: "Errors that tell the truth",
      "pt-br": "Erros que dizem a verdade",
    },
    body: {
      es: "Antes, si el equipo que hospedaba estaba apagado, salía un error en inglés que no decía nada y hacía buscar el fallo donde no estaba. Ahora la pantalla distingue «hay alguien y ha fallado algo» de «no hay nadie al otro lado», y lo dice con esas palabras.",
      en: "Before, if the machine hosting was switched off, you got a meaningless error that sent you looking for the problem in the wrong place. The screen now tells «someone is there and something went wrong» apart from «there is nobody on the other side», and says so in those words.",
      "pt-br": "Antes, se a máquina que hospedava estava desligada, aparecia um erro em inglês que não dizia nada e fazia procurar o problema no lugar errado. Agora a tela distingue «tem alguém e algo deu errado» de «não tem ninguém do outro lado», e diz isso com essas palavras.",
    },
  },
];
