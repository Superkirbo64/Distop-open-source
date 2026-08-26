/**
 * El lado del sucesor en un relevo (C2): adoptar una línea sin heredar su clave.
 *
 * Corre en la máquina NUEVA, con su instancia parada. Como `restore.ts`, no
 * importa `config.ts` ni `db.ts`: va a escribir en el directorio de datos y no
 * puede empezar abriéndolo.
 *
 *   DISTOP_ENROL_CODE='XXXX-XXXX-XXXX-XXXX' node adopt.ts \
 *     --from https://equipo-viejo.ts.net --origin https://equipo-nuevo.ts.net --target ./data
 *
 *   node adopt.ts --promote --from https://equipo-viejo.ts.net --target ./data
 *
 * Dos órdenes y no una, a propósito. La primera trae los datos y se queda en
 * reserva; la segunda solo asciende cuando el predecesor ya se ha retirado de
 * verdad. Ascender antes crearía dos PRIMARY escribiendo historias distintas
 * sobre la misma comunidad, y eso no se arregla después.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { canonicalJson, checkSuccessionStep, uuidv7, type SuccessionCert } from "@distop/protocol";
import { BackupError, sha256File } from "./backup-format.ts";
import { restoreBackup, type RestoreReport } from "./restore.ts";

/**
 * El fichero local lleva el id del relevo dentro del nombre.
 *
 * Reanudar significa continuar ESTA descarga. Con un nombre fijo, un segundo
 * relevo se encontraba los bytes del primero y pedía un rango a partir de un
 * tamaño que no era el suyo: el servidor contestaba 416, y en el mejor de los
 * casos fallaba. En el peor habría pegado la cola de un bundle sobre la cabeza
 * de otro.
 */
const bundleLocal = (handoverId: string): string => `handover-${handoverId}.distop-backup`;

/** Dónde guarda el sucesor lo justo para poder terminar el relevo después. */
const ESTADO = "handover-state.json";

export class AdoptError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function huellaDe(key: JsonWebKey | Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(key)).digest("base64url");
}

async function pedir(base: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method: opts.body === undefined ? "GET" : "POST",
    redirect: "manual",
    headers: {
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const texto = await res.text();
  const json = texto ? (JSON.parse(texto) as any) : null;
  if (!res.ok) {
    throw new AdoptError(json?.error?.code ?? `HTTP_${res.status}`, json?.error?.message ?? `El origen respondió ${res.status}.`);
  }
  return json;
}

/**
 * Descarga el bundle por rangos, reanudando si ya había parte en disco.
 *
 * Quien recibe una comunidad entera por una conexión doméstica no se puede
 * permitir que un corte a los treinta gigas signifique empezar de cero.
 */
async function descargar(base: string, token: string, destino: string): Promise<{ bytes: number; sha256: string }> {
  let desde = existsSync(destino) ? statSync(destino).size : 0;

  for (let intento = 0; intento < 6; intento++) {
    const res = await fetch(`${base}/api/v1/succession/bundle`, {
      redirect: "manual",
      headers: { authorization: `Bearer ${token}`, ...(desde > 0 ? { range: `bytes=${desde}-` } : {}) },
      signal: AbortSignal.timeout(6 * 60 * 60_000),
    });
    if (res.status === 409) throw new AdoptError("BUNDLE_NOT_READY", "El origen todavía está preparando la copia.");
    if (res.status === 416) {
      /* Pedimos a partir de un punto que el fichero de allí no tiene: lo que
         hay en disco no pertenece a esta descarga. Se tira y se empieza. */
      rmSync(destino, { force: true });
      desde = 0;
      continue;
    }
    if (!res.ok && res.status !== 206) throw new AdoptError(`HTTP_${res.status}`, `El origen respondió ${res.status}.`);
    /* Si pedimos un rango y nos dan el fichero entero, el servidor no sabe de
       rangos: se empieza de cero en vez de pegar bytes en el sitio equivocado. */
    if (desde > 0 && res.status !== 206) {
      rmSync(destino, { force: true });
      desde = 0;
    }

    const salida = createWriteStream(destino, { flags: desde > 0 ? "a" : "w" });
    try {
      const reader = res.body?.getReader();
      if (!reader) throw new AdoptError("EMPTY_RESPONSE", "El origen no envió nada.");
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        await new Promise<void>((ok, fail) => salida.write(next.value, (e) => (e ? fail(e) : ok())));
      }
      await new Promise<void>((ok, fail) => salida.end((e?: Error | null) => (e ? fail(e) : ok())));
      const { hash, size } = await sha256File(destino);
      return { bytes: size, sha256: hash };
    } catch (error) {
      salida.destroy();
      if (intento === 5) throw error;
      // Se reanuda desde donde llegó: por eso el fichero no se borra.
      desde = existsSync(destino) ? statSync(destino).size : 0;
      await new Promise((r) => setTimeout(r, 2_000 * (intento + 1)));
    }
  }
  throw new AdoptError("DOWNLOAD_FAILED", "No se pudo traer la copia del relevo.");
}

/** Escribe en la base restaurada quién es ahora esta instancia. */
function sellarIdentidad(target: string, opts: {
  instanceId: string;
  epoch: number;
  role: "STANDBY" | "PRIMARY";
  chain: SuccessionCert[];
}): void {
  const base = new DatabaseSync(join(target, "app.db"));
  try {
    const poner = base.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    poner.run("instance_id", opts.instanceId);
    poner.run("instance_epoch", String(opts.epoch));
    poner.run("instance_role", opts.role);
    poner.run("succession_chain", JSON.stringify(opts.chain));
    /* La dirección pública del equipo anterior no se hereda: publicar una que
       esta máquina no controla sería anunciar una puerta que no existe. */
    base.prepare("DELETE FROM meta WHERE key = 'public.fixed'").run();
    base.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    base.close();
  }
}

/** Cuánto sigue valiendo el secreto de sesiones del anfitrión anterior. */
const VENTANA_SECRETO_MS = 14 * 24 * 60 * 60_000;

/**
 * Estrena secreto de sesiones y conserva el anterior por una ventana.
 *
 * El secreto viaja dentro del bundle porque sin él todo el mundo aparecería
 * desconectado de golpe, y quien no tenga contraseña se quedaría fuera de su
 * propia comunidad. Pero el anfitrión anterior también lo conoce, así que
 * quedárselo para siempre sería dejarle una llave de reconocimiento de las
 * sesiones que ahora gestionamos nosotros. Se rota, y cada sesión que aparece
 * durante la ventana se reancla al secreto nuevo (§5.5).
 */
function rotarSecreto(target: string): void {
  const fichero = join(target, "secret.key");
  if (!existsSync(fichero)) return;
  const anterior = readFileSync(fichero, "utf8").trim();
  if (anterior.length < 32) return;

  writeFileSync(
    join(target, "secret.previous.json"),
    `${JSON.stringify({ secret: anterior, expires_at: Date.now() + VENTANA_SECRETO_MS }, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(fichero, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  try {
    chmodSync(fichero, 0o600);
    chmodSync(join(target, "secret.previous.json"), 0o600);
  } catch {
    /* Sin permisos POSIX. */
  }
}

export interface AdoptResult {
  instance_id: string;
  epoch: number;
  role: "STANDBY";
  bundle_sha256: string;
  restore: RestoreReport;
}

/**
 * Trae la línea y se queda en reserva.
 *
 * Al terminar, esta máquina tiene todos los datos y una identidad propia
 * autorizada por el predecesor, pero NO manda: sigue mandando el origen hasta
 * que su anfitrión active el relevo.
 */
export async function adopt(opts: {
  from: string;
  origin: string;
  code: string;
  targetDir: string;
  replace?: boolean;
  /** Cada cuánto se pregunta si la copia ya está. Cinco segundos en la vida
      real; las pruebas lo bajan para no tardar minutos en nada. */
  pollMs?: number;
}): Promise<AdoptResult> {
  const base = new URL(opts.from).origin;
  const target = resolve(opts.targetDir);
  mkdirSync(target, { recursive: true });

  // 1. Clave propia. La del predecesor no viaja y no se pide.
  const par = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicKey = par.publicKey.export({ format: "jwk" }) as JsonWebKey;
  const instanceId = uuidv7();

  // 2. Presentarse con el código de un solo uso.
  const enrol = await pedir(base, "/api/v1/succession/enrol", {
    body: { code: opts.code, instance_id: instanceId, public_key: publicKey, origin: opts.origin },
  });
  const token = enrol.transfer_token as string;
  const predecesor = enrol.predecessor as { instance_id: string; lineage_id: string; epoch: number; fingerprint: string };

  // 3. Esperar a que el origen tenga la copia lista.
  const espera = opts.pollMs ?? 5_000;
  const vueltas = Math.max(20, Math.ceil((60 * 60_000) / espera));
  let estado = await pedir(base, "/api/v1/succession/state", { token });
  for (let i = 0; i < vueltas && !estado.bundle.ready; i++) {
    if (estado.bundle.error) throw new AdoptError("BUNDLE_FAILED", `El origen no pudo preparar la copia: ${estado.bundle.error}`);
    await new Promise((r) => setTimeout(r, espera));
    estado = await pedir(base, "/api/v1/succession/state", { token });
  }
  if (!estado.bundle.ready) throw new AdoptError("BUNDLE_TIMEOUT", "El origen tardó demasiado en preparar la copia.");
  const bundleKey = estado.bundle.key as string | null;
  if (!bundleKey) throw new AdoptError("NO_BUNDLE_KEY", "El origen no entregó la clave de la copia.");

  // 4. El certificado, verificado ANTES de gastar ancho de banda.
  const cert = estado.certificate as SuccessionCert | null;
  if (!cert) throw new AdoptError("NO_CERTIFICATE", "El origen no ha emitido certificado para este relevo.");
  const reglas = checkSuccessionStep(predecesor, cert.payload, Date.now());
  if (reglas) throw new AdoptError(`CERT_${reglas}`, `El certificado del origen no cuadra: ${reglas}.`);
  if (cert.payload.to_fingerprint !== huellaDe(publicKey) || cert.payload.to_instance_id !== instanceId) {
    throw new AdoptError("CERT_NOT_FOR_US", "Ese certificado autoriza a otra clave, no a la nuestra.");
  }

  // 5. Traer el bundle, reanudable.
  const fichero = join(target, bundleLocal(cert.payload.handover_id));
  const traido = await descargar(base, token, fichero);

  // 6. Restaurar y verificar. Sin clave de identidad: la nuestra es propia.
  let report: RestoreReport;
  try {
    report = await restoreBackup({
      file: fichero,
      passphrase: bundleKey,
      targetDir: target,
      expectIdentityKey: false,
      ...(opts.replace ? { replace: true } : {}),
    });
  } catch (error) {
    if (error instanceof BackupError) throw new AdoptError(error.code, error.message);
    throw error;
  }
  if (!report.ok) throw new AdoptError("BUNDLE_INVALID", "La copia del relevo no pasó la verificación; no se adoptó nada.");

  // 7. Nuestra identidad, en reserva. Todavía no mandamos.
  writeFileSync(join(target, "instance.key"), `${JSON.stringify(par.privateKey.export({ format: "jwk" }))}\n`, { mode: 0o600 });
  try { chmodSync(join(target, "instance.key"), 0o600); } catch { /* Sin permisos POSIX. */ }
  sellarIdentidad(target, { instanceId, epoch: cert.payload.to_epoch, role: "STANDBY", chain: [cert] });
  rotarSecreto(target);

  // 8. Recibo firmado con NUESTRA clave: el origen no se retira sin él.
  const recibo = { t: "DISTOP_HANDOVER_RECEIPT", handover_id: cert.payload.handover_id, bundle_sha256: traido.sha256 };
  await pedir(base, "/api/v1/succession/receipt", {
    token,
    body: {
      bundle_sha256: traido.sha256,
      signature: sign("sha256", Buffer.from(canonicalJson(recibo)), {
        key: par.privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url"),
    },
  });

  rmSync(fichero, { force: true });
  /* Lo que hace falta para terminar el relevo cuando el anfitrión active: la
     dirección del origen y el testigo. Sin esto, `--promote` no tendría con qué
     pedir la copia final y habría que reemparejar, que es imposible porque el
     código era de un solo uso. */
  writeFileSync(
    join(target, ESTADO),
    `${JSON.stringify({ from: base, token, handover_id: cert.payload.handover_id }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { instance_id: instanceId, epoch: cert.payload.to_epoch, role: "STANDBY", bundle_sha256: traido.sha256, restore: report };
}

/**
 * Asciende a PRIMARY, y solo si el predecesor ya se retiró de verdad.
 *
 * Se comprueba preguntándole a él: su cadena tiene que decir que está superado
 * y por nuestro certificado. Ascender por nuestra cuenta —porque no contesta,
 * porque parece caído— es exactamente el error que produce dos PRIMARY, y una
 * máquina no distingue de forma segura "el otro murió" de "no llego al otro".
 */
export async function promote(opts: {
  from?: string;
  targetDir: string;
  /**
   * Ascender sin poder preguntarle al predecesor.
   *
   * Existe porque el caso "el equipo viejo murió y no vuelve" es real, y sin
   * salida el sucesor se queda con todos los datos y sin poder servirlos. No es
   * automático y no puede serlo: una máquina no distingue de forma segura "el
   * otro murió" de "no llego al otro", así que lo afirma una persona y carga
   * con ello. Si el viejo vuelve, habrá dos.
   */
  force?: boolean;
  pollMs?: number;
}): Promise<{ epoch: number; role: "PRIMARY"; finalized: boolean }> {
  const target = resolve(opts.targetDir);
  const guardado = existsSync(join(target, ESTADO))
    ? (JSON.parse(readFileSync(join(target, ESTADO), "utf8")) as { from: string; token: string; handover_id: string })
    : null;
  const base = new URL(opts.from ?? guardado?.from ?? "http://x").origin;

  const nuestra = JSON.parse(readFileSync(join(target, "instance.key"), "utf8")) as JsonWebKey;
  const nuestraHuella = huellaDe(createPublicKey({ key: nuestra, format: "jwk" }).export({ format: "jwk" }));

  /* 1. Si el anfitrión ya dio la orden de corte, lo primero es recoger la copia
        final: son los mensajes que la comunidad escribió mientras se preparaba
        el relevo, y sin este paso se perderían sin que nadie lo notara. */
  let finalized = false;
  if (guardado) {
    const estado = await pedir(base, "/api/v1/succession/state", { token: guardado.token }).catch(() => null);
    if (estado?.handover?.state === "ACTIVATING") {
      const espera = opts.pollMs ?? 2_000;
      let listo = estado;
      for (let i = 0; i < 900 && !listo.bundle.ready; i++) {
        await new Promise((r) => setTimeout(r, espera));
        listo = await pedir(base, "/api/v1/succession/state", { token: guardado.token });
      }
      if (!listo.bundle.ready) throw new AdoptError("FINAL_BUNDLE_TIMEOUT", "El origen no llegó a preparar la copia final.");

      const fichero = join(target, bundleLocal(`${guardado.handover_id}-final`));
      const traido = await descargar(base, guardado.token, fichero);
      const informe = await restoreBackup({
        file: fichero,
        passphrase: listo.bundle.key as string,
        targetDir: target,
        expectIdentityKey: false,
        replace: true,
      });
      if (!informe.ok) throw new AdoptError("FINAL_BUNDLE_INVALID", "La copia final no pasó la verificación.");
      rmSync(fichero, { force: true });
      rotarSecreto(target);
      finalized = true;

      const recibo = { t: "DISTOP_HANDOVER_RECEIPT", handover_id: guardado.handover_id, bundle_sha256: traido.sha256 };
      await pedir(base, "/api/v1/succession/receipt", {
        token: guardado.token,
        body: {
          bundle_sha256: traido.sha256,
          signature: sign("sha256", Buffer.from(canonicalJson(recibo)), {
            key: createPrivateKey({ key: nuestra, format: "jwk" }),
            dsaEncoding: "ieee-p1363",
          }).toString("base64url"),
        },
      });
    }
  }

  /* 2. Y solo entonces se mira si el predecesor se retiró de verdad. */
  const cadena = await pedir(base, "/api/v1/succession/chain").catch((error: Error) => {
    if (opts.force) return null;
    throw error;
  });
  if (cadena && !cadena.superseded && !opts.force) {
    throw new AdoptError("PREDECESSOR_STILL_PRIMARY", "El equipo anterior sigue mandando. No se asciende mientras tanto.");
  }

  const cert = (cadena?.chain as SuccessionCert[] | undefined)?.[0] ?? certificadoGuardado(target);
  if (!cert) throw new AdoptError("NO_CERTIFICATE", "No hay certificado de sucesión con el que ascender.");
  if (cert.payload.to_fingerprint !== nuestraHuella) {
    throw new AdoptError("CHAIN_NOT_OURS", "Ese certificado autoriza a otra clave, no a la nuestra.");
  }

  sellarIdentidad(target, {
    instanceId: cert.payload.to_instance_id,
    epoch: cert.payload.to_epoch,
    role: "PRIMARY",
    chain: [cert],
  });
  rmSync(join(target, ESTADO), { force: true });
  return { epoch: cert.payload.to_epoch, role: "PRIMARY", finalized };
}

/** El certificado que guardamos al adoptar, para el caso en que el predecesor
    ya no conteste nunca más. */
function certificadoGuardado(target: string): SuccessionCert | null {
  const base = new DatabaseSync(join(target, "app.db"));
  try {
    const fila = base.prepare("SELECT value FROM meta WHERE key = 'succession_chain'").get() as
      | { value: string }
      | undefined;
    const cadena = fila ? (JSON.parse(fila.value) as SuccessionCert[]) : [];
    return cadena[0] ?? null;
  } catch {
    return null;
  } finally {
    base.close();
  }
}

/* ── línea de órdenes ─────────────────────────────────────────────────── */

function argumento(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function principal(): Promise<void> {
  const from = argumento("from");
  const target = argumento("target");
  const promoviendo = process.argv.includes("--promote");
  const uso = [
    "Uso:",
    "  DISTOP_ENROL_CODE='...' node adopt.ts --from https://viejo --origin https://nuevo --target ./data",
    "  node adopt.ts --promote --from https://viejo --target ./data",
    "",
    "El código de emparejamiento va en DISTOP_ENROL_CODE, no en un argumento:",
    "los argumentos de un proceso los ve cualquiera que liste procesos.",
    "",
    "La instancia de ESTA máquina tiene que estar parada.",
  ].join("\n");

  /* Al ascender, la dirección del origen puede venir de lo que guardamos al
     adoptar: quien termina el relevo no tiene por qué recordarla. */
  if (!target || (!from && !promoviendo)) {
    console.error(uso);
    process.exitCode = 2;
    return;
  }

  try {
    if (process.argv.includes("--promote")) {
      const forzado = process.argv.includes("--force");
      if (forzado) {
        console.error(
          "Ascendiendo sin confirmación del equipo anterior. Estás afirmando que no va a volver:\n" +
            "si vuelve, habrá dos instancias con la misma línea escribiendo historias distintas.\n",
        );
      }
      console.log(
        JSON.stringify(await promote({ ...(from ? { from } : {}), targetDir: target, force: forzado }), null, 2),
      );
      return;
    }
    const origin = argumento("origin");
    const code = process.env.DISTOP_ENROL_CODE ?? "";
    // Adoptar sí necesita saber de dónde: aquí todavía no hay nada guardado.
    if (!from || !origin || !code) {
      console.error(uso);
      process.exitCode = 2;
      return;
    }
    const resultado = await adopt({
      from,
      origin,
      code,
      targetDir: target,
      replace: process.argv.includes("--replace"),
    });
    console.log(JSON.stringify(resultado, null, 2));
    console.error(
      "\nListo, en reserva. El equipo anterior sigue mandando hasta que su anfitrión active el relevo;\n" +
        "después, ejecuta aquí:  node adopt.ts --promote --from " + from + " --target " + target,
    );
  } catch (error) {
    const codigo = error instanceof AdoptError ? error.code : "ADOPT_FAILED";
    console.error(`${codigo}: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await principal();
}
