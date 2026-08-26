/**
 * Web Push escrito a mano: que la criptografía sea la del RFC y no una que se
 * le parezca (A2).
 *
 * El ancla de todo el archivo es el ejemplo publicado en el RFC 8291 §5: mismas
 * claves, misma sal, mismo texto, y el cuerpo tiene que salir byte a byte igual
 * al que imprime el RFC. Una prueba de ida y vuelta contra mi propia
 * implementación no valdría: un error coherente conmigo mismo pasaría igual.
 *
 * Encima de eso sí hay ida y vuelta —el servicio de push falso descifra lo que
 * recibe como lo haría un navegador— porque eso prueba lo que el vector no
 * cubre: las cabeceras, el relleno y que lo que sale de aquí es legible.
 *
 *   node --test "*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createHmac, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const raiz = mkdtempSync(join(tmpdir(), "distop-push-"));
mkdirSync(join(raiz, "uploads"), { recursive: true });

process.env.PORT = "0";
process.env.DATABASE_PATH = join(raiz, "app.db");
process.env.DEFAULT_STORAGE_PATH = join(raiz, "uploads");
process.env.PUSH_CONTACT = "mailto:quien-hospeda@example.org";
delete process.env.AUTH_SECRET;

const { server } = await import("./server.ts");
const { db } = await import("./db.ts");
const { stopIntegrityWork } = await import("./integrity.ts");
const push = await import("./push.ts");
const { PushError } = push;

/* ── el ejemplo del RFC 8291 §5, tal cual está publicado ──────────────── */

const RFC = {
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  plaintext: "When I grow up, I want to be a watermelon",
  cuerpo:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

const b64 = (valor: string): Buffer => Buffer.from(valor, "base64url");

/* ── el navegador de mentira, que descifra como lo haría uno de verdad ── */

const hmac = (clave: Buffer, datos: Buffer): Buffer => createHmac("sha256", clave).update(datos).digest();

/**
 * El lado receptor del RFC 8291, escrito aparte a propósito. Repite el KDF, así
 * que por sí solo no probaría que el KDF es correcto — para eso está el vector.
 * Lo que prueba es que el sobre que se manda se puede abrir.
 */
function descifrarComoNavegador(cuerpo: Buffer, uaPrivate: Buffer, uaPublic: Buffer, auth: Buffer): string {
  const salt = cuerpo.subarray(0, 16);
  const idlen = cuerpo.readUInt8(20);
  const asPublic = cuerpo.subarray(21, 21 + idlen);
  const cifrado = cuerpo.subarray(21 + idlen);

  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivate);
  const compartido = ecdh.computeSecret(asPublic);

  const prkKey = hmac(auth, compartido);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])])).subarray(0, 32);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01", "binary")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01", "binary")).subarray(0, 12);

  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(cifrado.subarray(cifrado.length - 16));
  const registro = Buffer.concat([decipher.update(cifrado.subarray(0, cifrado.length - 16)), decipher.final()]);

  /* Detrás del delimitador 0x02 solo hay ceros de relleno (RFC 8188 §2). */
  let fin = registro.length;
  while (fin > 0 && registro[fin - 1] === 0x00) fin -= 1;
  assert.equal(registro[fin - 1], 0x02, "el último registro lleva delimitador 0x02");
  return registro.subarray(0, fin - 1).toString("utf8");
}

/* ── el servicio de push falso ────────────────────────────────────────── */

interface Recibido {
  endpoint: string;
  headers: Record<string, string>;
  cuerpo: Buffer;
}

const recibidos: Recibido[] = [];
/** Qué contesta el servicio de push a la siguiente petición. */
let respuesta: { status: number } = { status: 201 };
const fetchReal = globalThis.fetch;

const navegador = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const navegadorEcdh = createECDH("prime256v1");
navegadorEcdh.setPrivateKey(
  b64((navegador.privateKey.export({ format: "jwk" }) as { d: string }).d),
);
const CLAVES_NAVEGADOR = {
  p256dh: navegadorEcdh.getPublicKey().toString("base64url"),
  auth: Buffer.from("0123456789abcdef").toString("base64url"),
};
const ENDPOINT = "https://push.example.net/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV";

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  await stopIntegrityWork();
  globalThis.fetch = (async (entrada: unknown, opciones: RequestInit = {}) => {
    recibidos.push({
      endpoint: String(entrada),
      headers: (opciones.headers ?? {}) as Record<string, string>,
      cuerpo: Buffer.from(opciones.body as ArrayBuffer),
    });
    return new Response(null, { status: respuesta.status });
  }) as typeof globalThis.fetch;
});

after(async () => {
  globalThis.fetch = fetchReal;
  server.closeAllConnections();
  server.close();
  await stopIntegrityWork();
  try { db.close(); } catch { /* ya cerrada */ }
  rmSync(raiz, { recursive: true, force: true });
});

/* ── RFC 8291: el vector ──────────────────────────────────────────────── */

test("el ejemplo del RFC 8291 §5 sale byte a byte igual", () => {
  const salida = push.encryptPush({
    plaintext: Buffer.from(RFC.plaintext, "utf8"),
    keys: { p256dh: RFC.uaPublic, auth: RFC.auth },
    salt: b64(RFC.salt),
    senderPrivate: b64(RFC.asPrivate),
  });
  assert.equal(salida.toString("base64url"), RFC.cuerpo);
});

test("la cabecera del sobre tiene la forma del RFC 8188", () => {
  const cuerpo = b64(RFC.cuerpo);
  assert.equal(cuerpo.subarray(0, 16).toString("base64url"), RFC.salt, "16 bytes de sal");
  assert.equal(cuerpo.readUInt32BE(16), 4096, "tamaño de registro, 4 bytes big-endian");
  assert.equal(cuerpo.readUInt8(20), 65, "longitud de la clave, y es un punto sin comprimir");
  assert.equal(cuerpo.readUInt8(21), 0x04, "que empieza por 0x04");
});

test("y el navegador puede volver a abrirlo", () => {
  const abierto = descifrarComoNavegador(
    b64(RFC.cuerpo),
    b64(RFC.uaPrivate),
    b64(RFC.uaPublic),
    b64(RFC.auth),
  );
  assert.equal(abierto, RFC.plaintext);
});

test("dos avisos distintos pesan exactamente lo mismo", () => {
  /* El proveedor de push ve el tamaño aunque no vea el contenido. Un aviso de
     "volvió" y uno de "te mencionaron" no deben distinguirse por la báscula. */
  const sobre = (payload: unknown) =>
    push.encryptPush({
      plaintext: Buffer.from(JSON.stringify(payload), "utf8"),
      keys: CLAVES_NAVEGADOR,
      padTo: push.RELLENO_FIJO,
    }).length;
  assert.equal(sobre({ v: 1, t: "instance_online" }), sobre({ v: 1, t: "mention", n: 12 }));
});

test("una sal distinta en cada envío, aunque el mensaje sea el mismo", () => {
  const uno = push.encryptPush({ plaintext: Buffer.from("igual"), keys: CLAVES_NAVEGADOR });
  const dos = push.encryptPush({ plaintext: Buffer.from("igual"), keys: CLAVES_NAVEGADOR });
  assert.notEqual(uno.toString("base64url"), dos.toString("base64url"));
  assert.notEqual(uno.subarray(0, 16).toString("hex"), dos.subarray(0, 16).toString("hex"));
});

test("una clave de cliente que no es un punto P-256 se rechaza", () => {
  for (const rota of ["", "AAAA", Buffer.alloc(65).toString("base64url")]) {
    assert.throws(() => push.encryptPush({ plaintext: Buffer.from("x"), keys: { p256dh: rota, auth: CLAVES_NAVEGADOR.auth } }));
  }
  assert.throws(() =>
    push.encryptPush({ plaintext: Buffer.from("x"), keys: { p256dh: CLAVES_NAVEGADOR.p256dh, auth: "AAAA" } }),
  );
});

/* ── RFC 8292: VAPID ──────────────────────────────────────────────────── */

test("el JWT de VAPID lo firma la instancia y se verifica con su clave pública", () => {
  const cabecera = push.vapidAuthHeader(`${ENDPOINT}?x=1`);
  const [, credencial] = /^vapid t=([^,]+), k=(.+)$/.exec(cabecera) ?? [];
  assert.ok(credencial, `cabecera con forma inesperada: ${cabecera}`);
  const clavePublica = cabecera.split("k=")[1]!;
  assert.equal(clavePublica, push.vapidPublicKey());

  const [header, payload, firma] = credencial.split(".");
  const cabeceraJwt = JSON.parse(b64(header!).toString("utf8")) as { typ: string; alg: string };
  assert.equal(cabeceraJwt.alg, "ES256");
  assert.equal(cabeceraJwt.typ, "JWT");

  const cuerpo = JSON.parse(b64(payload!).toString("utf8")) as { aud: string; exp: number; sub: string };
  assert.equal(cuerpo.aud, "https://push.example.net", "solo el origen, nunca la ruta de la suscripción");
  assert.equal(cuerpo.sub, "mailto:quien-hospeda@example.org");
  const horas = (cuerpo.exp * 1000 - Date.now()) / 3600_000;
  assert.ok(horas > 0 && horas <= 24, `caducidad fuera del rango del RFC: ${horas} h`);

  /* La firma se comprueba con la clave pública que la propia cabecera anuncia:
     es exactamente lo que hace el servicio de push. */
  const punto = b64(clavePublica);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: punto.subarray(1, 33).toString("base64url"),
    y: punto.subarray(33, 65).toString("base64url"),
  };
  const valida = verify(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
    b64(firma!),
  );
  assert.equal(valida, true);
});

test("la clave VAPID sobrevive a reiniciar, o cada arranque mataría las suscripciones", () => {
  const antes = push.vapidPublicKey();
  push.resetPushSecretsCache();
  assert.equal(push.vapidPublicKey(), antes);

  const fichero = push.pushSecretFile();
  const modo = statSync(fichero).mode & 0o777;
  /* Windows no aplica los permisos POSIX; donde sí se aplican, se comprueban. */
  if (process.platform !== "win32") assert.equal(modo, 0o600);
  assert.ok(!readFileSync(fichero, "utf8").includes("BEGIN"), "se guarda como JWK, no como PEM suelto");
});

/* ── suscripciones ────────────────────────────────────────────────────── */

let usuario = "";
let tokenAnfitriona = "";

test("alta de una suscripción: https, sin credenciales y sin guardar la dirección", async () => {
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const alta = await fetchReal(`${base}/api/v1/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ display_name: "Anfitriona" }),
  });
  const reclamada = (await alta.json()) as { user: { id: string }; access_token: string };
  usuario = reclamada.user.id;
  tokenAnfitriona = reclamada.access_token;

  const guardada = push.registerSubscription({ userId: usuario, endpoint: ENDPOINT, keys: CLAVES_NAVEGADOR });
  assert.ok(guardada.id);
  assert.equal(push.subscriptionCount(usuario), 1);

  const fila = db.prepare("SELECT * FROM push_subscriptions").get() as Record<string, string>;
  const crudo = JSON.stringify(fila);
  assert.ok(!crudo.includes("push.example.net"), "la dirección no está en claro en la base");
  assert.ok(!crudo.includes(CLAVES_NAVEGADOR.p256dh), "ni la clave del navegador");
  assert.ok(!crudo.includes(CLAVES_NAVEGADOR.auth), "ni su secreto de autenticación");
});

test("solo https, y nada de credenciales en la dirección", () => {
  for (const mala of [
    "http://push.example.net/x",
    "https://usuario:clave@push.example.net/x",
    "no es una url",
    `https://push.example.net/${"x".repeat(1200)}`,
  ]) {
    assert.throws(
      () => push.registerSubscription({ userId: usuario, endpoint: mala, keys: CLAVES_NAVEGADOR }),
      (error: unknown) => error instanceof PushError && error.code === "PUSH_BAD_ENDPOINT",
      `debería rechazar ${mala.slice(0, 40)}`,
    );
  }
});

test("volver a suscribir el mismo navegador actualiza, no acumula", () => {
  const antes = push.subscriptionCount(usuario);
  push.registerSubscription({ userId: usuario, endpoint: ENDPOINT, keys: CLAVES_NAVEGADOR });
  assert.equal(push.subscriptionCount(usuario), antes, "el navegador renueva la suscripción sola: es normal");
});

test("una persona no acumula suscripciones sin fondo", () => {
  for (let i = 0; i < push.MAX_SUSCRIPCIONES + 4; i++) {
    push.registerSubscription({ userId: usuario, endpoint: `${ENDPOINT}-${i}`, keys: CLAVES_NAVEGADOR });
  }
  assert.equal(push.subscriptionCount(usuario), push.MAX_SUSCRIPCIONES);
});

test("darse de baja no dice si la suscripción existía", () => {
  /* La última que entró sigue viva; las primeras las expulsó el tope de arriba. */
  const ultima = `${ENDPOINT}-${push.MAX_SUSCRIPCIONES + 3}`;
  assert.equal(push.dropSubscription(usuario, ultima), true);
  assert.equal(push.dropSubscription(usuario, ultima), false, "y la segunda vez ya no está");
  assert.equal(push.dropSubscription(usuario, "https://push.example.net/nunca-existio"), false);
});

/* ── entrega ──────────────────────────────────────────────────────────── */

function limpiarSuscripciones(): void {
  db.prepare("DELETE FROM push_subscriptions").run();
  recibidos.length = 0;
  respuesta = { status: 201 };
}

test("lo que llega al navegador es exactamente lo que se quiso mandar, y nada más", async () => {
  limpiarSuscripciones();
  push.registerSubscription({ userId: usuario, endpoint: ENDPOINT, keys: CLAVES_NAVEGADOR });

  const enviados = await push.pushToUser(usuario, { v: 1, t: "mention", n: 3 });
  assert.equal(enviados, 1);
  assert.equal(recibidos.length, 1);

  const envio = recibidos[0]!;
  assert.equal(envio.endpoint, ENDPOINT);
  assert.equal(envio.headers["content-encoding"], "aes128gcm");
  assert.equal(envio.headers["content-type"], "application/octet-stream");
  assert.ok(envio.headers.authorization?.startsWith("vapid t="));
  assert.ok(Number(envio.headers.ttl) > 0);

  const abierto = JSON.parse(
    descifrarComoNavegador(
      envio.cuerpo,
      navegadorEcdh.getPrivateKey(),
      navegadorEcdh.getPublicKey(),
      b64(CLAVES_NAVEGADOR.auth),
    ),
  ) as Record<string, unknown>;
  assert.deepEqual(abierto, { v: 1, t: "mention", n: 3 });

  /* Ni nombres, ni texto, ni direcciones: lo que no viaja no se puede filtrar. */
  const crudo = envio.cuerpo.toString("latin1");
  assert.ok(!crudo.includes("Anfitriona"));
  assert.ok(!crudo.includes("mention"), "y va cifrado: ni el propio código aparece en claro");
});

test("un 410 borra la suscripción: reintentarla sería golpear a un ajeno para siempre", async () => {
  limpiarSuscripciones();
  push.registerSubscription({ userId: usuario, endpoint: ENDPOINT, keys: CLAVES_NAVEGADOR });

  respuesta = { status: 410 };
  assert.equal(await push.pushToUser(usuario, { v: 1, t: "instance_online" }), 0);
  assert.equal(push.subscriptionCount(usuario), 0, "esa suscripción ya no existe y no va a volver");
});

test("un 404 también es definitivo", async () => {
  limpiarSuscripciones();
  push.registerSubscription({ userId: usuario, endpoint: ENDPOINT, keys: CLAVES_NAVEGADOR });
  respuesta = { status: 404 };
  await push.pushToUser(usuario, { v: 1, t: "instance_online" });
  assert.equal(push.subscriptionCount(usuario), 0);
});

test("un fallo pasajero espacia el siguiente intento, y al quinto se abandona", async () => {
  limpiarSuscripciones();
  push.registerSubscription({ userId: usuario, endpoint: ENDPOINT, keys: CLAVES_NAVEGADOR });
  respuesta = { status: 500 };

  let ahora = Date.now();
  for (let intento = 1; intento < push.FALLOS_PARA_ABANDONAR; intento++) {
    assert.equal(await push.pushToUser(usuario, { v: 1, t: "instance_online" }, ahora), 0);
    const fila = db.prepare("SELECT failures, next_attempt FROM push_subscriptions").get() as
      | { failures: number; next_attempt: number }
      | undefined;
    assert.equal(fila?.failures, intento);
    assert.ok(fila!.next_attempt > ahora, "no se reintenta inmediatamente");

    /* Antes de tiempo no sale nada: el backoff se respeta de verdad. */
    const enviosAntes = recibidos.length;
    await push.pushToUser(usuario, { v: 1, t: "instance_online" }, ahora);
    assert.equal(recibidos.length, enviosAntes, "todavía no le toca");
    ahora = fila!.next_attempt;
  }

  await push.pushToUser(usuario, { v: 1, t: "instance_online" }, ahora);
  assert.equal(push.subscriptionCount(usuario), 0, "insistir para siempre contra un endpoint muerto no es reintentar");
});

test("el aviso de vuelta respeta el mismo umbral que el vigilante de escritorio", async () => {
  limpiarSuscripciones();
  push.registerSubscription({ userId: usuario, endpoint: ENDPOINT, keys: CLAVES_NAVEGADOR });

  assert.equal(await push.pushInstanceOnline(push.CAIDA_MINIMA_MS - 1), 0, "un reinicio rápido no despierta a nadie");
  assert.equal(recibidos.length, 0);
  assert.equal(await push.pushInstanceOnline(push.CAIDA_MINIMA_MS + 1), 1);
});

test("el aviso de vuelta va a todo el mundo, no solo a una persona", async () => {
  limpiarSuscripciones();
  const otra = db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string };
  push.registerSubscription({ userId: usuario, endpoint: ENDPOINT, keys: CLAVES_NAVEGADOR });
  push.registerSubscription({ userId: otra.id, endpoint: `${ENDPOINT}-otro`, keys: CLAVES_NAVEGADOR });
  assert.equal(await push.pushInstanceOnline(push.CAIDA_MINIMA_MS + 1), 2);
});

test("una fila que no se puede abrir se tira, en vez de reintentarse eternamente", async () => {
  limpiarSuscripciones();
  push.registerSubscription({ userId: usuario, endpoint: ENDPOINT, keys: CLAVES_NAVEGADOR });
  db.prepare("UPDATE push_subscriptions SET sealed = 'basura'").run();
  assert.equal(await push.pushToUser(usuario, { v: 1, t: "instance_online" }), 0);
  assert.equal(push.subscriptionCount(usuario), 0);
  assert.equal(recibidos.length, 0, "ni se intenta: no hay a dónde mandarlo");
});

/* ── menciones ────────────────────────────────────────────────────────── */

test("mencionar a alguien que no está delante le manda un aviso, y uno solo", async () => {
  limpiarSuscripciones();
  push.resetMentionCooldown();
  push.registerSubscription({ userId: usuario, endpoint: ENDPOINT, keys: CLAVES_NAVEGADOR });

  assert.equal(await push.pushMention([usuario]), 1);
  /* Una conversación animada son veinte menciones en un minuto. Eso es un
     aviso, no veinte: si no, la persona lo apaga y ya no se entera de nada. */
  assert.equal(await push.pushMention([usuario]), 0, "dentro de la espera no se repite");
  assert.equal(recibidos.length, 1);
});

test("el camino real: se avisa al mencionado, nunca a quien escribió", async () => {
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const call = async (metodo: string, ruta: string, opciones: { token?: string; body?: unknown } = {}) => {
    const res = await fetchReal(`${base}${ruta}`, {
      method: metodo,
      headers: {
        "content-type": "application/json",
        ...(opciones.token ? { authorization: `Bearer ${opciones.token}` } : {}),
      },
      ...(opciones.body === undefined ? {} : { body: JSON.stringify(opciones.body) }),
    });
    const texto = await res.text();
    return { status: res.status, json: texto ? (JSON.parse(texto) as Record<string, any>) : null };
  };

  /* Quien hospeda ya existe desde que reclamó la instancia; falta alguien más
     a quien mencionar. */
  const token = tokenAnfitriona;
  assert.ok(token, "la sesión de quien reclamó la instancia sigue valiendo");

  const comunidad = await call("POST", "/api/v1/communities", { token, body: { name: "La Plaza" } });
  const comunidadId = comunidad.json!.id as string;
  const boot = await call("GET", `/api/v1/communities/${comunidadId}/bootstrap`, { token });
  const canal = (boot.json!.channels as Array<{ id: string; kind: string }>).find((c) => c.kind === "text")!;

  const visita = await call("POST", "/api/v1/auth/guest", { body: { display_name: "Quien pasaba" } });
  const invitada = visita.json!.user.id as string;
  const invitacion = await call("POST", `/api/v1/communities/${comunidadId}/invites`, { token, body: {} });
  await call("POST", `/api/v1/invites/${invitacion.json!.code}/join`, { token: visita.json!.access_token as string });

  limpiarSuscripciones();
  push.resetMentionCooldown();
  push.registerSubscription({ userId: usuario, endpoint: `${ENDPOINT}-autora`, keys: CLAVES_NAVEGADOR });
  push.registerSubscription({ userId: invitada, endpoint: `${ENDPOINT}-invitada`, keys: CLAVES_NAVEGADOR });

  const enviado = await call("POST", `/api/v1/channels/${canal.id}/messages`, {
    token,
    body: { content: `oye <@${invitada}>, mira esto` },
  });
  assert.equal(enviado.status, 200);
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(recibidos.length, 1, "un aviso, para una sola persona");
  assert.equal(recibidos[0]!.endpoint, `${ENDPOINT}-invitada`, "y no para quien escribió el mensaje");

  /* @everyone no despierta los móviles de toda la comunidad. Quien quiera
     verlo lo tiene en la aplicación; despertar a todo el mundo por dos
     palabras es cómo se consigue que apaguen los avisos. */
  recibidos.length = 0;
  push.resetMentionCooldown();
  await call("POST", `/api/v1/channels/${canal.id}/messages`, { token, body: { content: "@everyone atención" } });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(recibidos.length, 0);

  /* Y mencionar a alguien que no es miembro no manda nada: serviría para
     averiguar si esa cuenta existe en esta instancia. */
  recibidos.length = 0;
  push.resetMentionCooldown();
  await call("POST", `/api/v1/channels/${canal.id}/messages`, { token, body: { content: "<@no-existe-esta-persona>" } });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(recibidos.length, 0);
});

test("la caída se mide con el latido, no con una marca de apagado limpio", () => {
  /* El latido lleva escribiéndose desde que arrancó el servidor de esta prueba,
     así que ahora mismo la caída es prácticamente cero. */
  assert.ok(push.downtimeAtStartup(Date.now()) < push.CAIDA_MINIMA_MS);

  /* Un equipo que estuvo apagado dos horas: el último latido es viejo, y eso se
     ve sin que nadie haya podido escribir nada al apagarse. Es justo el caso
     que una marca de apagado limpio no cubriría — un corte de luz no avisa. */
  const dosHoras = Date.now() + 2 * 3600_000;
  assert.ok(push.downtimeAtStartup(dosHoras) >= 2 * 3600_000 - 60_000);

  /* Sin latido ninguno —primera vez que se enciende— no hay ausencia que
     anunciar: nadie la echó de menos porque nadie la conocía. */
  db.prepare("DELETE FROM meta WHERE key = 'push_heartbeat'").run();
  assert.equal(push.downtimeAtStartup(Date.now()), 0);
});
