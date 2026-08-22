/**
 * Siembra una instancia con una comunidad de ejemplo, para fotografiarla.
 *
 * La captura del sitio público es la aplicación de verdad, no un montaje: se
 * levanta una instancia aparte, se registran personas de verdad y se escribe
 * una conversación de verdad. Este script hace esa parte y devuelve el token de
 * quien mira, que es lo que `shot.mjs` necesita para entrar.
 *
 *   node scripts/seed.mjs [url]
 *
 * Nunca apunta a la base de datos real: la instancia que se siembra tiene que
 * arrancarse con su propio DATABASE_PATH, y quien la arranca la borra después.
 */
const base = process.argv[2] ?? "http://127.0.0.1:5055";

/** Sufijo único: la instancia puede sembrarse dos veces sin chocar de nombres. */
const marca = Date.now().toString(36).slice(-4);

async function pedir(ruta, { metodo = "POST", token, cuerpo } = {}) {
  const res = await fetch(`${base}/api/v1${ruta}`, {
    method: metodo,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
  });
  const texto = await res.text();
  if (!res.ok) throw new Error(`${metodo} ${ruta} → ${res.status} ${texto.slice(0, 300)}`);
  return texto ? JSON.parse(texto) : null;
}

/** Registra a alguien y devuelve su token y su id. */
async function registrar(usuario, nombre) {
  const r = await pedir("/auth/register", {
    cuerpo: {
      username: `${usuario}${marca}`,
      password: "contrasena-larga-de-ejemplo",
      display_name: nombre,
    },
  });
  return { token: r.access_token ?? r.token, id: r.user?.id, nombre };
}

const GENTE = [
  ["kirbo", "Kirbo"],
  ["nayeli", "Nayeli"],
  ["tomas", "Tomás"],
  ["irene", "Irene"],
];

/* La conversación que se ve en la portada. Habla como habla la gente que juega:
   ni una palabra que haga falta buscar en Google. */
const CHARLA = [
  [0, "Ya está montado. Os paso el enlace y entráis directo, sin crear cuenta ni nada."],
  [1, "¿En serio no hay que registrarse? En el otro nos pedía correo hasta para mirar."],
  [0, "Nada. Pones tu nombre y ya estás dentro. Si luego quieres contraseña, se la pones."],
  [2, "Acabo de entrar desde el móvil y funciona igual. Qué gusto."],
  [3, "He cambiado el color a magenta y las esquinas a cuadradas. No me ha pedido pagar nada 🎉"],
  [1, "Eso es lo que más me gusta: no hay ninguna pestaña de «mejora tu plan» escondida en Ajustes."],
  [0, "Y los emojis son ilimitados, que sé que era lo que más rabia te daba."],
  [2, "¿Entramos a voz un rato y probamos? A ver qué tal se oye."],
  [0, "Venga. El canal de voz está ahí arriba, solo hay que hacer clic."],
];

const salida = { base, comunidad: null, token: null };

const gente = [];
for (const [usuario, nombre] of GENTE) gente.push(await registrar(usuario, nombre));

const jefa = gente[0];
const comunidad = await pedir("/communities", {
  token: jefa.token,
  cuerpo: { name: "La Partida", is_public: false },
});
salida.comunidad = comunidad.name;

// El resto entra por invitación, como entraría cualquiera.
const invite = await pedir(`/communities/${comunidad.id}/invites`, { token: jefa.token, cuerpo: {} });
for (const persona of gente.slice(1)) {
  await pedir(`/invites/${invite.code}/join`, { token: persona.token, cuerpo: {} });
}

// El canal por defecto de la comunidad recién creada.
const arranque = await pedir(`/communities/${comunidad.id}/bootstrap`, { metodo: "GET", token: jefa.token });
const canal = arranque.channels.find((c) => c.type === "text") ?? arranque.channels[0];

for (const [quien, texto] of CHARLA) {
  await pedir(`/channels/${canal.id}/messages`, { token: gente[quien].token, cuerpo: { content: texto } });
}

salida.token = jefa.token;
console.log(JSON.stringify(salida));
