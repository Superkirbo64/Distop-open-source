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
      es: "Voz entre pares, sin servidor en medio",
      en: "Peer-to-peer voice, no server in between",
      "pt-br": "Voz entre pares, sem servidor no meio",
    },
    body: {
      es: "Los canales de voz ya funcionan con una malla WebRTC: el audio va directo entre navegadores y la instancia solo hace de presentadora. Eso es lo que permite que hospedar voz quepa en un PC doméstico. El techo práctico son unas seis personas por canal; por encima haría falta un SFU, y el protocolo no cambiaría.",
      en: "Voice channels now run on a WebRTC mesh: audio goes straight between browsers and the instance only does introductions. That's what makes hosting voice fit on a home PC. The practical ceiling is around six people per channel; above that you'd want an SFU, and the protocol wouldn't change.",
      "pt-br": "Os canais de voz já funcionam com uma malha WebRTC: o áudio vai direto entre navegadores e a instância só apresenta as pessoas. É isso que faz hospedar voz caber num PC doméstico. O teto prático é de umas seis pessoas por canal; acima disso seria preciso um SFU, e o protocolo não mudaria.",
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
      es: "La primera pantalla de una instancia recién instalada era un muro de acceso a un sitio que es tuyo. Ahora es la puesta en marcha: creas tu cuenta y tu comunidad en un paso. Desde el propio equipo no se pide código; desde fuera sí, y se imprime en el terminal al arrancar.",
      en: "The first screen of a freshly installed instance was a login wall to a place that is yours. Now it's the setup: you create your account and your community in one step. From the machine itself no code is asked for; from outside it is, and it's printed to the terminal on boot.",
      "pt-br": "A primeira tela de uma instância recém-instalada era um muro de login para um lugar que é seu. Agora é a configuração inicial: você cria sua conta e sua comunidade num passo. Da própria máquina não se pede código; de fora sim, e ele é impresso no terminal ao subir.",
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
      es: "«Internal Server Error» aparecía cuando la instancia simplemente estaba apagada, y mandaba a depurar el sitio equivocado. Ahora el cliente distingue «la instancia contestó un error» de «no había instancia», y lo dice en pantalla con ese nombre.",
      en: "«Internal Server Error» showed up when the instance was simply switched off, sending you to debug the wrong place. The client now tells «the instance answered with an error» apart from «there was no instance», and says so on screen.",
      "pt-br": "«Internal Server Error» aparecia quando a instância estava simplesmente desligada, e mandava depurar o lugar errado. Agora o cliente distingue «a instância respondeu um erro» de «não havia instância», e diz isso na tela.",
    },
  },
];
