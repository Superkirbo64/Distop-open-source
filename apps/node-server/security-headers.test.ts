/**
 * Las tres piezas que deciden en quién confía la instancia (§22).
 *
 * 1. De dónde sale la IP con la que se cuentan TODOS los límites previos a la
 *    sesión. Leer X-Forwarded-For por el principio es leer lo que escribió el
 *    atacante, y entonces entrar, registrarse o recuperar dejan de tener freno:
 *    basta con rotar la cabecera para estrenar contador en cada petición.
 * 2. Que la respuesta lleve las cabeceras que el navegador necesita para
 *    defenderse, y que la ÚNICA irreversible —HSTS— no salga por http plano.
 * 3. Que el comodín de CORS no sobreviva en ningún entorno: una web cualquiera
 *    también puede atacar el servidor local de la aplicación de escritorio.
 *
 *   node --test "*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "distop-seguridad-"));
process.env.PORT = "0";
process.env.DATABASE_PATH = join(workdir, "test.db");
process.env.DEFAULT_STORAGE_PATH = join(workdir, "uploads");
process.env.AUTH_SECRET = "test-secret-no-usar-en-produccion";
process.env.CORS_ORIGINS = "*";

const { clientIp } = await import("./http.ts");
const { allowedCorsOrigins, config } = await import("./config.ts");
const { server } = await import("./server.ts");

let base = "";

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(async () => {
  server.closeAllConnections();
  server.close();
  // Windows no borra el directorio mientras SQLite mantenga abiertos los WAL.
  const { db } = await import("./db.ts");
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

/* Un cliente directo escribe lo que quiera en la cabecera: sin proxy declarado
   no vale nada. Es el caso de quien hospeda en su PC, que es el más común. */
test("sin proxy declarado, X-Forwarded-For es texto del cliente y se ignora", () => {
  const sinProxy = { proxy: false, hops: 1 };
  assert.equal(clientIp("9.9.9.9", "203.0.113.5", sinProxy), "203.0.113.5");
  assert.equal(clientIp("9.9.9.9, 8.8.8.8", "203.0.113.5", sinProxy), "203.0.113.5");
  assert.equal(clientIp(undefined, "203.0.113.5", sinProxy), "203.0.113.5");
  // Sin socket tampoco se inventa nada: la clave del contador es "?" y punto.
  assert.equal(clientIp(undefined, undefined, sinProxy), "?");
});

test("con un proxy delante gana la IP que escribió el proxy, no la que mandó el cliente", () => {
  const unSalto = { proxy: true, hops: 1 };

  // Nadie miente: el proxy escribe la única entrada.
  assert.equal(clientIp("203.0.113.9", "10.0.0.2", unSalto), "203.0.113.9");

  /* El ataque: el cliente manda ya una cabecera y el proxy le AÑADE su IP real
     detrás. Quedarse con la primera entrada era coger justo la del atacante. */
  assert.equal(clientIp("1.2.3.4, 203.0.113.9", "10.0.0.2", unSalto), "203.0.113.9");
  assert.equal(
    clientIp("1.2.3.4, 5.6.7.8, 9.10.11.12, 203.0.113.9", "10.0.0.2", unSalto),
    "203.0.113.9",
    "por muchas entradas que invente, la suya nunca es la última",
  );

  // Node junta las cabeceras repetidas, pero si llegara como lista, igual.
  assert.equal(clientIp(["1.2.3.4", "203.0.113.9"], "10.0.0.2", unSalto), "203.0.113.9");

  /* Entradas vacías: con una coma suelta al final, contar desde el final sin
     limpiar devolvería "" y todo el mundo compartiría el contador de "". */
  assert.equal(clientIp("1.2.3.4, , 203.0.113.9,", "10.0.0.2", unSalto), "203.0.113.9");
});

test("con dos saltos la IP real es la penúltima, no la última", () => {
  const dosSaltos = { proxy: true, hops: 2 };

  /* Cloudflare por delante de un Nginx propio: Cloudflare añade la IP de quien
     llama y Nginx añade la de Cloudflare. La última es del borde, no de nadie. */
  assert.equal(clientIp("198.51.100.7, 203.0.113.9", "10.0.0.2", dosSaltos), "198.51.100.7");

  // Y con la cabecera falsificada por delante, sigue saliendo la de verdad.
  assert.equal(clientIp("1.2.3.4, 198.51.100.7, 203.0.113.9", "10.0.0.2", dosSaltos), "198.51.100.7");
});

test("una cadena más corta que los saltos no vale: se cae al socket, nunca al cliente", () => {
  const dosSaltos = { proxy: true, hops: 2 };

  /* Alguien llegó por un camino que no pasa por los dos proxies declarados (o
     se equivocó el número). La cabecera no cuadra con el despliegue, así que no
     se usa: toda esa gente comparte el contador del socket. Molesto y visible,
     pero cerrado. */
  assert.equal(clientIp("1.2.3.4", "10.0.0.2", dosSaltos), "10.0.0.2");
  assert.equal(clientIp(undefined, "10.0.0.2", dosSaltos), "10.0.0.2");
  assert.equal(clientIp("", "10.0.0.2", dosSaltos), "10.0.0.2");
  assert.equal(clientIp(" , ", "10.0.0.2", dosSaltos), "10.0.0.2", "entradas vacías no cuentan como saltos");
  assert.equal(clientIp(undefined, "10.0.0.2", { proxy: true, hops: 1 }), "10.0.0.2");
});

test("de fábrica se presupone un solo proxy delante", () => {
  assert.equal(config.trustedProxyHops, 1);
  // Sin TRUST_PROXY, el valor por defecto de la función ignora la cabecera.
  assert.equal(config.trustProxy, false);
  assert.equal(clientIp("9.9.9.9", "203.0.113.5"), "203.0.113.5");
});

test("toda respuesta de la API sale con sus cabeceras de seguridad", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);

  /* Una respuesta JSON no parsea HTML ni ejecuta scripts: aquí la política
     correcta es la más cerrada que hay. La del DOCUMENTO es otra y vive en
     server.ts, que calcula el hash del script en línea leyendo el index.html
     al arrancar. Tenerla también aquí significaba congelar ese hash y que se
     desincronizara en silencio en cuanto alguien tocara el script del tema. */
  assert.equal(
    res.headers.get("content-security-policy"),
    "default-src 'none'; frame-ancestors 'none'",
    "la API no sirve documento: nada que cargar, nada que permitir",
  );
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  /* Permissions-Policy gobierna el contexto de navegación, así que solo vale
     en el documento (server.ts:DOCUMENT_HEADERS). Mandarla en un JSON no
     protegía nada y hacía creer lo contrario a quien leyera el código. */
  assert.equal(res.headers.get("permissions-policy"), null);
});

test("HSTS NO sale por http plano: es la única cabecera irreversible", async () => {
  const res = await fetch(`${base}/health`);
  /* Un año de HSTS sobre una instancia casera servida por http deja el equipo
     inalcanzable en el navegador de quien la abrió, sin nada que el servidor
     pueda hacer para deshacerlo. Esta suite existe para que nadie la mande
     "por si acaso" desde una petición sin cifrar. */
  assert.equal(res.headers.get("strict-transport-security"), null);
});

test('el comodín de CORS se cae siempre y quedan los orígenes concretos', () => {
  const permitidos = allowedCorsOrigins(["*", "https://mi.comunidad"]);
  assert.ok(!permitidos.includes("*"), "reflejar cualquier Origin abre los endpoints locales sin credenciales");
  assert.ok(permitidos.includes("https://mi.comunidad"), "lo que puso quien hospeda a propósito sí sigue valiendo");
  assert.ok(
    permitidos.includes("app://distop") && permitidos.includes("http://localhost"),
    "y los clientes empaquetados no dependen de la variable: nunca se quedan fuera",
  );
});

test('CORS_ORIGINS=* no deja que una web lea el servidor local', async () => {
  const res = await fetch(`${base}/api/v1/info`, { headers: { origin: "https://sitio-ajeno.example" } });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  assert.equal(res.headers.get("access-control-allow-credentials"), null);
});

/* Leer X-Forwarded-For por el extremo bueno no basta si no se comprueba QUIÉN
   abre el socket. docker-compose.yml publica el 5000 en 0.0.0.0 y su propio
   comentario pide TRUST_PROXY=true cuando hay túnel delante: sin esta puerta,
   ese despliegue le entregaba ctx.ip —y con ella todos los límites previos a la
   sesión— a cualquiera que llegase al puerto desde internet. */
test("con TRUST_PROXY, un par que no es proxy no puede dictar la IP", () => {
  const conProxy = { proxy: true, hops: 1 };

  // Alguien de internet que alcanza el puerto directamente: manda su cabecera y se ignora.
  assert.equal(clientIp("1.2.3.4", "198.51.100.77", conProxy), "198.51.100.77");
  assert.equal(clientIp("1.2.3.4, 5.6.7.8", "203.0.113.200", conProxy), "203.0.113.200");
});

test("el proxy legítimo habla desde bucle local o red privada, y a ese sí se le cree", () => {
  const conProxy = { proxy: true, hops: 1 };

  // install-vps.sh: --publish=127.0.0.1:5000:5000
  assert.equal(clientIp("1.2.3.4, 203.0.113.9", "127.0.0.1", conProxy), "203.0.113.9");
  assert.equal(clientIp("1.2.3.4, 203.0.113.9", "::1", conProxy), "203.0.113.9");
  // Node entrega IPv4 sobre socket IPv6 con este prefijo; sin quitarlo no casaba nada.
  assert.equal(clientIp("1.2.3.4, 203.0.113.9", "::ffff:127.0.0.1", conProxy), "203.0.113.9");
  // Red del contenedor.
  assert.equal(clientIp("1.2.3.4, 203.0.113.9", "172.17.0.1", conProxy), "203.0.113.9");
  assert.equal(clientIp("1.2.3.4, 203.0.113.9", "10.0.0.3", conProxy), "203.0.113.9");
  assert.equal(clientIp("1.2.3.4, 203.0.113.9", "192.168.1.9", conProxy), "203.0.113.9");
});

test("172.16/12 se corta donde toca: 172.32 ya es internet", () => {
  const conProxy = { proxy: true, hops: 1 };
  assert.equal(clientIp("x, 203.0.113.9", "172.31.255.254", conProxy), "203.0.113.9", "172.31 es privada");
  /* Comparar por prefijo de texto («172.3») metía 172.32 dentro de la red
     privada, y 172.32 es una dirección pública como cualquier otra. */
  assert.equal(clientIp("x, 203.0.113.9", "172.32.0.1", conProxy), "172.32.0.1", "172.32 es pública");
  assert.equal(clientIp("x, 203.0.113.9", "172.15.0.1", conProxy), "172.15.0.1", "172.15 es pública");
});

test("con TRUSTED_PROXY_IPS manda la lista y nadie más", () => {
  const soloEse = { proxy: true, hops: 1, pares: ["203.0.113.10"] };

  // El proxy inverso en otra máquina, con IP pública: la heurística no vale, la lista sí.
  assert.equal(clientIp("1.2.3.4, 198.51.100.5", "203.0.113.10", soloEse), "198.51.100.5");
  /* Y con la lista puesta, el bucle local deja de estar implícito: si alguien la
     escribe, es que sabe exactamente por dónde le entran las peticiones. */
  assert.equal(clientIp("1.2.3.4, 198.51.100.5", "127.0.0.1", soloEse), "127.0.0.1");
});
