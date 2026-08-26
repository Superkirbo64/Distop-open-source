/**
 * El certificado de sucesión, caso por caso (C2 §2.8).
 *
 * `succession.test.ts` prueba que el relevo funciona. Esto prueba lo contrario:
 * las formas de fabricar un certificado que parece bueno. Cada una de ellas es
 * un intento de quedarse con una comunidad, y todas tienen que fallar por una
 * razón nombrada, no por casualidad.
 *
 *   node --test "*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const raiz = mkdtempSync(join(tmpdir(), "distop-cert-"));
mkdirSync(raiz, { recursive: true });
process.env.PORT = "0";
process.env.DATABASE_PATH = join(raiz, "app.db");
process.env.DEFAULT_STORAGE_PATH = join(raiz, "uploads");
delete process.env.AUTH_SECRET;

const { db, closeDatabase } = await import("./db.ts");
const { canonicalJson, checkSuccessionStep, uuidv7 } = await import("@distop/protocol");
const identidad = await import("./identity.ts");
const {
  authorizeSuccessor,
  currentIdentity,
  enrolSuccessor,
  mintSuccessionCert,
  verifySuccessionCert,
  verifySuccessionChain,
} = await import("./succession.ts");

type Cert = ReturnType<typeof mintSuccessionCert>;

const sucesorB = generateKeyPairSync("ec", { namedCurve: "P-256" });
const intruso = generateKeyPairSync("ec", { namedCurve: "P-256" });
let base: Cert;
let deA: ReturnType<typeof currentIdentity>;

before(() => {
  db.prepare(
    "INSERT INTO users (id, username, display_name, kind, created_at) VALUES (?, 'ana', 'Ana', 'local', ?)",
  ).run("u-ana", Date.now());
  const { row, code } = authorizeSuccessor({ label: "portátil", createdBy: "u-ana" });
  assert.ok(row.id);
  enrolSuccessor({
    code,
    instanceId: uuidv7(),
    publicKey: sucesorB.publicKey.export({ format: "jwk" }) as JsonWebKey,
    origin: "https://equipo-nuevo.example",
  });
  deA = currentIdentity();
  base = mintSuccessionCert({
    successor: db.prepare("SELECT * FROM successors LIMIT 1").get() as never,
    handoverId: uuidv7(),
    notBefore: Date.now() - 1_000,
  });
});

after(() => {
  closeDatabase();
  rmSync(raiz, { recursive: true, force: true });
});

/** Vuelve a firmar un payload retocado, con la clave que se le diga. */
function refirmar(cambios: Partial<Cert["payload"]>, conClave = intruso): Cert {
  const payload = { ...base.payload, ...cambios };
  return {
    payload,
    signature: sign("sha256", Buffer.from(canonicalJson(payload)), {
      key: conClave.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url"),
    signer_public_key: conClave.publicKey.export({ format: "jwk" }) as Record<string, unknown>,
    signer_fingerprint: identidad.huellaDe(conClave.publicKey.export({ format: "jwk" }) as JsonWebKey),
  };
}

/** Retoca el payload SIN volver a firmar: la firma deja de cuadrar. */
function retocar(cambios: Partial<Cert["payload"]>): Cert {
  return { ...base, payload: { ...base.payload, ...cambios } };
}

test("el certificado que emite la instancia vale", () => {
  assert.equal(verifySuccessionCert(base, deA), null);
  assert.equal(base.payload.to_epoch, deA.epoch + 1);
  assert.notEqual(base.payload.to_fingerprint, deA.fingerprint, "el sucesor trae clave propia");
});

test("una firma manipulada no vale", () => {
  const roto = { ...base, signature: `${base.signature.slice(0, -4)}AAAA` };
  assert.equal(verifySuccessionCert(roto, deA), "BAD_SIGNATURE");
});

test("un certificado firmado por un tercero no autoriza nada", () => {
  /* Está perfectamente firmado —por quien no es—. Sin esta comprobación,
     cualquiera podría emitir sucesores de la comunidad de otro. */
  assert.equal(verifySuccessionCert(refirmar({}), deA), "SIGNER_NOT_PREDECESSOR");
});

test("declarar la huella del predecesor sin tener su clave tampoco cuela", () => {
  const suplantado = refirmar({});
  suplantado.signer_fingerprint = deA.fingerprint;
  /* La huella se recalcula sobre la clave que llega: si no cuadra con la
     declarada, se cae antes de mirar nada más. */
  assert.equal(verifySuccessionCert(suplantado, deA), "SIGNER_KEY_MISMATCH");
});

test("saltarse una época, repetirla o retroceder se rechaza", () => {
  assert.equal(verifySuccessionCert(retocar({ to_epoch: deA.epoch + 2 }), deA), "EPOCH_NOT_NEXT");
  assert.equal(verifySuccessionCert(retocar({ to_epoch: deA.epoch }), deA), "EPOCH_NOT_NEXT");
  assert.equal(verifySuccessionCert(retocar({ to_epoch: deA.epoch - 1 }), deA), "EPOCH_NOT_NEXT");
});

test("otro linaje no es una sucesión: es otra comunidad", () => {
  assert.equal(verifySuccessionCert(retocar({ lineage_id: uuidv7() }), deA), "LINEAGE_MISMATCH");
});

test("un certificado caducado o todavía no válido no sirve", () => {
  const ahora = Date.now();
  assert.equal(verifySuccessionCert(base, deA, base.payload.expires_at + 1), "EXPIRED");
  assert.equal(verifySuccessionCert(retocar({ not_before: ahora + 60_000 }), deA, ahora), "NOT_YET_VALID");
});

test("un certificado que se autoriza a sí mismo no es una sucesión", () => {
  assert.equal(verifySuccessionCert(retocar({ to_instance_id: deA.instance_id }), deA), "SAME_INSTANCE");
  assert.equal(verifySuccessionCert(retocar({ to_fingerprint: deA.fingerprint }), deA), "SAME_KEY");
});

test("no se acepta una lista de direcciones sin fondo", () => {
  const muchas = Array.from({ length: 9 }, (_, i) => `https://sitio-${i}.example`);
  assert.equal(verifySuccessionCert(retocar({ allowed_origins: muchas }), deA), "BAD_ORIGINS");
});

test("las reglas de un paso se pueden comprobar sin criptografía", () => {
  /* Es lo que usa el cliente antes de gastar CPU verificando una firma, y lo
     que permite que servidor y navegador apliquen exactamente lo mismo. */
  assert.equal(checkSuccessionStep(deA, base.payload, Date.now()), null);
  assert.equal(checkSuccessionStep({ ...deA, epoch: 5 }, base.payload, Date.now()), "FROM_EPOCH_MISMATCH");
  assert.equal(checkSuccessionStep(deA, { ...base.payload, t: "OTRA_COSA" as never }, Date.now()), "NOT_A_CERT");
});

test("una cadena demasiado larga se rechaza antes de verificarla", () => {
  const larga = Array.from({ length: 20 }, () => base);
  const resultado = verifySuccessionChain(deA, larga);
  assert.equal(resultado.ok, false);
  if (!resultado.ok) assert.equal(resultado.reason, "CHAIN_TOO_LONG");
});

test("una cadena con un eslabón que no encaja se corta ahí", () => {
  /* El segundo certificado es el mismo que el primero: parte de la época de A
     cuando ya deberíamos estar en la siguiente. */
  const resultado = verifySuccessionChain(deA, [base, base]);
  assert.equal(resultado.ok, false);
  if (!resultado.ok) assert.equal(resultado.reason, "SIGNER_NOT_PREDECESSOR");
});

test("una instancia retirada no vuelve a mandar por su cuenta", () => {
  identidad.setInstanceStanding({ role: "SUPERSEDED" });
  assert.throws(
    () => identidad.setInstanceStanding({ role: "PRIMARY" }),
    /INSTANCE_ALREADY_SUPERSEDED/,
    "reactivarla con la época vieja sería un rollback criptográfico",
  );
  assert.equal(identidad.instanceRole(), "SUPERSEDED");
});

test("la época nunca baja", () => {
  assert.throws(() => identidad.setInstanceStanding({ epoch: 0 }), /EPOCH_CANNOT_GO_BACK/);
});
