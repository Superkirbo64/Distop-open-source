/**
 * Direcciones alternativas firmadas y veredictos de continuidad (C3 §3.1, §3.3).
 *
 * Una lista de "dónde encontrar esta comunidad" es exactamente lo que un
 * atacante querría poder escribir. Lo que se prueba aquí es que no puede: ni
 * inventándola, ni reponiendo una vieja, ni pidiéndosela a la instancia sin
 * estar dentro.
 *
 *   node --test "*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const raiz = mkdtempSync(join(tmpdir(), "distop-origenes-"));
mkdirSync(raiz, { recursive: true });
process.env.PORT = "0";
process.env.DATABASE_PATH = join(raiz, "app.db");
process.env.DEFAULT_STORAGE_PATH = join(raiz, "uploads");
delete process.env.AUTH_SECRET;

const { server } = await import("./server.ts");
const { db } = await import("./db.ts");
const { stopIntegrityWork } = await import("./integrity.ts");
const { checkOriginSet, compareIdentities, MAX_SIGNED_ORIGINS } = await import("@distop/protocol");
const { currentIdentity, currentOriginSet, mintOriginSet } = await import("./succession.ts");

let base = "";
let token = "";

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  await stopIntegrityWork();
});

after(async () => {
  server.closeAllConnections();
  server.close();
  await stopIntegrityWork();
  try { db.close(); } catch { /* ya cerrada */ }
  rmSync(raiz, { recursive: true, force: true });
});

async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test("quien hospeda firma sus direcciones alternativas, y solo él", async () => {
  const claim = await call("POST", "/api/v1/auth/bootstrap", { body: { display_name: "Anfitriona" } });
  token = claim.json.access_token as string;
  await call("POST", "/api/v1/communities", { token, body: { name: "La Casa" } });

  const visita = await call("POST", "/api/v1/auth/guest", { body: { display_name: "de paso" } });
  const ajeno = await call("PUT", "/api/v1/instance/origins", {
    token: visita.json.access_token as string,
    body: { origins: [{ url: "https://malo.example", label: "mío" }] },
  });
  assert.equal(ajeno.status, 403, "cambiar por dónde se llega a una comunidad no lo hace cualquiera");

  const puesto = await call("PUT", "/api/v1/instance/origins", {
    token,
    body: {
      origins: [
        { url: "https://equipo.tailnet.ts.net", label: "el fijo", kind: "tailscale", priority: 10 },
        { url: "https://comunidad.example", label: "el dominio", kind: "custom", priority: 20 },
      ],
    },
  });
  assert.equal(puesto.status, 200);
  assert.equal(puesto.json.payload.origins.length, 2);
  assert.equal(puesto.json.payload.generation, 1);
  assert.equal(puesto.json.payload.origins[0].url, "https://equipo.tailnet.ts.net");
});

test("la lista NO sale a quien no ha entrado", async () => {
  const anonimo = await call("GET", "/api/v1/instance/origins");
  assert.equal(anonimo.status, 401, "publicar dónde vive una comunidad a quien haga un GET es una fuga");

  const info = await call("GET", "/api/v1/info");
  assert.equal(info.status, 200);
  assert.ok(!JSON.stringify(info.json).includes("tailnet.ts.net"), "y tampoco por la ficha anónima");

  const dentro = await call("GET", "/api/v1/instance/origins", { token });
  assert.equal(dentro.status, 200);
  assert.equal(dentro.json.generation, 1);
});

test("la generación sube en cada cambio y nunca se acepta una anterior", async () => {
  const vieja = currentOriginSet();
  assert.ok(vieja);

  const nueva = mintOriginSet([{ url: "https://otra.example", priority: 10, kind: "custom", label: "otra" }]);
  assert.equal(nueva.payload.generation, vieja.payload.generation + 1);

  const yo = currentIdentity();
  const ahora = Date.now();
  // Con la generación nueva ya aceptada, reponer la vieja es el ataque obvio.
  assert.equal(checkOriginSet(yo, nueva.payload.generation, nueva.payload, ahora), null);
  assert.equal(checkOriginSet(yo, nueva.payload.generation, vieja.payload, ahora), "STALE_GENERATION");
});

test("una lista que no es de esta instancia, o ya caducó, no vale", () => {
  const actual = currentOriginSet()!;
  const yo = currentIdentity();
  const ahora = Date.now();

  assert.equal(checkOriginSet({ ...yo, lineage_id: "otro-linaje" }, 0, actual.payload, ahora), "LINEAGE_MISMATCH");
  assert.equal(checkOriginSet({ ...yo, instance_id: "otra-instancia" }, 0, actual.payload, ahora), "INSTANCE_MISMATCH");
  assert.equal(checkOriginSet({ ...yo, epoch: 9 }, 0, actual.payload, ahora), "EPOCH_MISMATCH");
  assert.equal(checkOriginSet(yo, 0, actual.payload, actual.payload.expires_at + 1), "EXPIRED");
});

test("no caben más de tres pistas: esto es reencontrar una instancia, no un directorio", async () => {
  const demasiadas = Array.from({ length: MAX_SIGNED_ORIGINS + 1 }, (_, i) => ({
    url: `https://sitio-${i}.example`,
    label: `sitio ${i}`,
  }));
  const rechazado = await call("PUT", "/api/v1/instance/origins", { token, body: { origins: demasiadas } });
  assert.equal(rechazado.status, 400);
});

test("la etiqueta se recorta y la dirección se normaliza", () => {
  const firmado = mintOriginSet([
    { url: "https://equipo.example/", priority: 999, kind: "custom", label: "x".repeat(200) },
  ]);
  const origen = firmado.payload.origins[0]!;
  assert.equal(origen.url, "https://equipo.example", "sin barra final: es un origen, no una ruta");
  assert.equal(origen.label.length, 60);
  assert.equal(origen.priority, 100, "la prioridad tiene techo");
});

test("qué significa cada respuesta que dice ser la misma comunidad", () => {
  const fijada = { instance_id: "A", lineage_id: "L", epoch: 3, fingerprint: "KA" };

  assert.equal(compareIdentities(fijada, { ...fijada }), "same");
  assert.equal(compareIdentities(fijada, { ...fijada, epoch: 4, instance_id: "B", fingerprint: "KB" }), "successor");
  assert.equal(compareIdentities(fijada, { ...fijada, epoch: 2 }), "stale");
  assert.equal(compareIdentities(fijada, { ...fijada, lineage_id: "otro" }), "unrelated");

  /* El caso grave: misma línea, misma época, otra clave. Alguien restauró una
     copia o alguien miente, y desde fuera las dos parecen legítimas. */
  assert.equal(compareIdentities(fijada, { ...fijada, fingerprint: "KX" }), "fork");
});

test("cambiar las direcciones queda en la auditoría de cada comunidad", async () => {
  const comunidades = db.prepare("SELECT id FROM communities").all() as Array<{ id: string }>;
  assert.ok(comunidades.length > 0);
  const log = await call("GET", `/api/v1/communities/${comunidades[0]!.id}/audit`, { token });
  assert.ok(
    (log.json as Array<{ action: string }>).some((e) => e.action === "INSTANCE_ORIGINS_UPDATED"),
    "desviar una comunidad es justo el movimiento que tiene que dejar rastro",
  );
});
