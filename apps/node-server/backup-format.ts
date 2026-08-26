/**
 * Formato `.distop-backup` v1: contenedor cifrado, en streaming, autenticado.
 *
 * Vive aparte de backup.ts y no importa ni la base ni la configuración, porque
 * la herramienta de restauración tiene que poder leer un fichero SIN abrir la
 * instancia que está a punto de reemplazar. Aquí solo hay bytes.
 *
 * ── Estructura ───────────────────────────────────────────────────────────
 *
 *   línea 1   JSON en claro, terminado en \n, con lo IMPRESCINDIBLE para
 *             descifrar y nada más.
 *   resto     bloques cifrados, uno detrás de otro:
 *
 *                 [4 bytes BE: longitud del texto cifrado]
 *                 [texto cifrado]
 *                 [16 bytes: etiqueta AES-GCM]
 *
 * En claro quedan únicamente el nombre del formato, su versión y los parámetros
 * de derivación y cifrado. Ni el nombre de la instancia, ni sus comunidades, ni
 * sus usuarios, ni su identificador, ni su linaje, ni su huella, ni su
 * dirección pública, ni un solo nombre de fichero: todo eso vive dentro del
 * manifiesto, que va cifrado como el resto. Una copia encontrada en un disco no
 * debe delatar de quién es.
 *
 * ── Por qué por bloques y no un solo paquete ─────────────────────────────
 *
 * "AES-256-GCM con una contraseña" no es una especificación: reutilizar el
 * nonce dentro de un archivo grande es una falla real, y cifrar de una pieza
 * obligaría a tener el bundle entero en memoria — imposible con adjuntos de
 * gigabytes en el PC de casa. Cada bloque lleva su propio nonce: ocho bytes
 * aleatorios fijos del fichero más un contador de cuatro.
 *
 * ── Por qué el último bloque va marcado ──────────────────────────────────
 *
 * El dato asociado autenticado de cada bloque incluye su índice y si es el
 * último. Sin eso, cortar el fichero por la mitad produciría una copia que
 * descifra perfectamente y a la que le faltan datos — el peor fallo posible en
 * un backup, porque parece que funcionó.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import type { Readable } from "node:stream";

/* promisify infiere la última sobrecarga de scrypt, que no lleva opciones; sin
   este tipo explícito no se pueden pasar N, r, p ni maxmem. */
const derivar = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

export const BACKUP_FORMAT = "distop-backup";
export const BACKUP_VERSION = 1;
export const BACKUP_EXTENSION = ".distop-backup";
/** Marca de un fichero a medio escribir. Nunca se acepta para restaurar. */
export const PARTIAL_EXTENSION = ".partial";

/** Texto plano por bloque. 1 MiB va bien en un portátil y en una Raspberry Pi. */
const BLOQUE = 1024 * 1024;
const TAG_BYTES = 16;
const NONCE_BYTES = 12;
const SALT_BYTES = 16;
const CLAVE_BYTES = 32;
/** Un encabezado sano ocupa ~200 bytes; más que esto es un fichero hostil. */
const MAX_CABECERA = 4096;

/**
 * Parámetros de scrypt. Duros a propósito y distintos de los de las
 * contraseñas: aquí no hay un servidor que limite mil intentos por segundo, hay
 * un fichero robado y todo el tiempo del mundo para probar frases.
 */
export const SCRYPT_N = 32768;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
/** 128·N·r son 32 MiB justos: el tope por defecto de Node se queda corto. */
const SCRYPT_MAXMEM = 96 * 1024 * 1024;

export interface BackupHeader {
  format: typeof BACKUP_FORMAT;
  version: number;
  kdf: { name: "scrypt"; salt: string; N: number; r: number; p: number };
  cipher: { name: "aes-256-gcm"; nonce: string };
}

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface BackupCounts {
  users: number;
  communities: number;
  channels: number;
  messages: number;
  attachments: number;
}

export interface BackupManifest {
  format: "distop-backup-manifest";
  version: number;
  created_at: number;
  /** Crece por cada intento de copia de esta instancia. */
  generation: number;
  instance_id: string;
  lineage_id: string;
  epoch: number;
  role: string;
  instance_name: string;
  server_version: string;
  database_schema: number;
  counts: BackupCounts;
  /** Secretos/configuración excluidos deliberadamente de la base copiada. */
  redactions: string[];

  files: ManifestFile[];
}

export class BackupError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Frase incorrecta y fichero manipulado dan EXACTAMENTE el mismo error.
 *
 * Distinguirlos convertiría la copia en un oráculo: probar frases y saber
 * cuándo acertaste a medias. Y tampoco se pueden distinguir de verdad —un fallo
 * de GCM es un fallo de GCM—, así que fingir que sí sería además mentir.
 */
export const ILEGIBLE = (): BackupError =>
  new BackupError(
    "BACKUP_UNREADABLE",
    "No se pudo leer la copia: o la frase no es esa, o el archivo está dañado o manipulado.",
  );
/**
 * TypeScript no protege una frontera de fichero. El manifiesto llega de bytes
 * descifrados y se valida antes de que una sola ruta pueda llegar al destino.
 */
export function validateManifest(value: unknown): BackupManifest {
  if (!value || typeof value !== "object") throw ILEGIBLE();
  const manifest = value as Partial<BackupManifest>;
  if (manifest.format !== "distop-backup-manifest" || manifest.version !== 1) {
    throw new BackupError("UNSUPPORTED_MANIFEST", "La versión del manifiesto no es compatible con este programa.");
  }
  const entero = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  if (
    !entero(manifest.created_at) ||
    !entero(manifest.generation) ||
    typeof manifest.instance_id !== "string" || !manifest.instance_id ||
    typeof manifest.lineage_id !== "string" || !manifest.lineage_id ||
    !entero(manifest.epoch) ||
    typeof manifest.role !== "string" || !manifest.role ||
    typeof manifest.instance_name !== "string" ||
    typeof manifest.server_version !== "string" ||
    !entero(manifest.database_schema) ||
    !Array.isArray(manifest.redactions) ||
    !manifest.redactions.every((item) => typeof item === "string" && item.length <= 128) ||
    !manifest.counts || typeof manifest.counts !== "object" ||
    !["users", "communities", "channels", "messages", "attachments"].every(
      (key) => entero((manifest.counts as unknown as Record<string, unknown>)[key]),
    ) ||
    !Array.isArray(manifest.files) || manifest.files.length > 100_000
  ) {
    throw ILEGIBLE();
  }
  const paths = new Set<string>();
  for (const file of manifest.files) {
    if (
      !file || typeof file !== "object" ||
      !safeEntryPath(file.path) || file.path === "manifest.json" ||
      !entero(file.size) || typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(file.sha256) ||
      paths.has(file.path)
    ) throw ILEGIBLE();
    paths.add(file.path);
  }
  return manifest as BackupManifest;
}


/* ── derivación ───────────────────────────────────────────────────────── */

export async function deriveKey(passphrase: string, salt: Buffer, kdf: BackupHeader["kdf"]): Promise<Buffer> {
  if (kdf?.name !== "scrypt") throw new BackupError("UNSUPPORTED_KDF", "Esta copia usa una derivación desconocida.");
  const rango = (valor: number, min: number, max: number): boolean =>
    Number.isInteger(valor) && valor >= min && valor <= max;
  if (!rango(kdf.N, 16384, 1048576) || !rango(kdf.r, 1, 32) || !rango(kdf.p, 1, 16)) {
    throw new BackupError("UNSUPPORTED_KDF", "Los parámetros de derivación de esta copia están fuera de rango.");
  }
  return (await derivar(passphrase.normalize("NFKC"), salt, CLAVE_BYTES, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: SCRYPT_MAXMEM,
  })) as Buffer;
}

/* ── nonce y datos asociados por bloque ───────────────────────────────── */

function nonceDe(base: Buffer, indice: number): Buffer {
  const nonce = Buffer.alloc(NONCE_BYTES);
  base.copy(nonce, 0, 0, 8);
  nonce.writeUInt32BE(indice, 8);
  return nonce;
}

/** Lo que se autentica junto al bloque: versión, número de bloque y si cierra
    el fichero. Cortar el archivo deja de ser invisible. */
function datosAsociados(indice: number, ultimo: boolean): Buffer {
  const aad = Buffer.alloc(6);
  aad.writeUInt8(BACKUP_VERSION, 0);
  aad.writeUInt32BE(indice, 1);
  aad.writeUInt8(ultimo ? 1 : 0, 5);
  return aad;
}

/* ── contenedor interno ───────────────────────────────────────────────────
   Dentro del cifrado las entradas van una detrás de otra:

       {"path":"database/app.db","size":40960}\n   seguido de esos 40960 bytes
       ...
       {"end":true}\n

   No es tar y no lo pretende: es un formato de cinco líneas que cualquiera
   puede leer con un script, que era la exigencia del §21. Un tar habría traído
   permisos, propietarios, enlaces y campos octales que aquí no significan nada
   y que solo abren superficie al restaurar.                                */

export interface BackupEntry {
  path: string;
  size: number;
  /** De dónde salen los bytes: un fichero en disco, o algo ya en memoria. */
  source: { file: string } | { data: Buffer };
}

/* ── escritura ────────────────────────────────────────────────────────── */

/**
 * Escribe la copia cifrada en `destination`.
 *
 * Sale primero como `.partial` y solo se renombra al terminar de escribir el
 * último bloque y sincronizar a disco. Un corte de luz a mitad deja un
 * `.partial` que nadie confundirá con una copia buena — que es exactamente lo
 * que no puede pasar con un backup.
 */
export async function writeBackup(opts: {
  destination: string;
  passphrase: string;
  manifest: BackupManifest;
  entries: BackupEntry[];
}): Promise<{ path: string; bytes: number }> {
  const salt = randomBytes(SALT_BYTES);
  const nonceBase = randomBytes(8);
  const header: BackupHeader = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    kdf: { name: "scrypt", salt: salt.toString("base64"), N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
    cipher: { name: "aes-256-gcm", nonce: nonceBase.toString("base64") },
  };
  const key = await deriveKey(opts.passphrase, salt, header.kdf);

  const parcial = `${opts.destination}${PARTIAL_EXTENSION}`;
  const salida = createWriteStream(parcial, { flags: "wx" });
  let bytes = 0;

  const escribir = (trozo: Buffer): Promise<void> =>
    new Promise((resolve, reject) => {
      bytes += trozo.length;
      salida.write(trozo, (error) => (error ? reject(error) : resolve()));
    });

  /* Un solo búfer de texto plano en vuelo, del tamaño de un bloque: da igual
     que la copia pese 40 GB, la memoria del proceso no se mueve. */
  let pendiente: Buffer[] = [];
  let pendienteBytes = 0;
  let indice = 0;

  const emitir = async (ultimo: boolean): Promise<void> => {
    const plano = Buffer.concat(pendiente, pendienteBytes);
    pendiente = [];
    pendienteBytes = 0;
    const cifrador = createCipheriv("aes-256-gcm", key, nonceDe(nonceBase, indice));
    cifrador.setAAD(datosAsociados(indice, ultimo));
    const cifrado = Buffer.concat([cifrador.update(plano), cifrador.final()]);
    const cabecera = Buffer.alloc(4);
    cabecera.writeUInt32BE(cifrado.length, 0);
    await escribir(cabecera);
    await escribir(cifrado);
    await escribir(cifrador.getAuthTag());
    indice++;
  };

  const alimentar = async (trozo: Buffer): Promise<void> => {
    let resto = trozo;
    while (pendienteBytes + resto.length >= BLOQUE) {
      const cabe = BLOQUE - pendienteBytes;
      pendiente.push(resto.subarray(0, cabe));
      pendienteBytes += cabe;
      resto = resto.subarray(cabe);
      await emitir(false);
    }
    if (resto.length > 0) {
      pendiente.push(resto);
      pendienteBytes += resto.length;
    }
  };

  try {
    await escribir(Buffer.from(`${JSON.stringify(header)}\n`, "utf8"));

    const manifiesto = Buffer.from(JSON.stringify(opts.manifest), "utf8");
    await alimentar(Buffer.from(`${JSON.stringify({ path: "manifest.json", size: manifiesto.length })}\n`, "utf8"));
    await alimentar(manifiesto);

    for (const entrada of opts.entries) {
      await alimentar(Buffer.from(`${JSON.stringify({ path: entrada.path, size: entrada.size })}\n`, "utf8"));
      if ("data" in entrada.source) {
        await alimentar(entrada.source.data);
        continue;
      }
      let leidos = 0;
      for await (const trozo of createReadStream(entrada.source.file)) {
        const buf = trozo as Buffer;
        leidos += buf.length;
        if (leidos > entrada.size) throw new BackupError("FILE_GREW", "Un archivo creció mientras se copiaba.");
        await alimentar(buf);
      }
      if (leidos !== entrada.size) throw new BackupError("FILE_SHRANK", "Un archivo cambió mientras se copiaba.");
    }

    await alimentar(Buffer.from(`${JSON.stringify({ end: true })}\n`, "utf8"));
    await emitir(true);

    await new Promise<void>((resolve, reject) =>
      salida.end((error?: Error | null) => (error ? reject(error) : resolve())),
    );
    /* fsync antes del rename: sin esto, tras un corte de luz puede quedar el
       nombre definitivo puesto sobre un contenido que nunca llegó al disco. */
    const handle = await open(parcial, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(parcial, opts.destination);
    return { path: opts.destination, bytes };
  } catch (error) {
    salida.destroy();
    await unlink(parcial).catch(() => {});
    throw error;
  }
}

/* ── lectura ──────────────────────────────────────────────────────────── */

/** Lee el encabezado en claro sin descifrar nada ni derivar la clave. */
export async function readHeader(file: string): Promise<BackupHeader> {
  const handle = await open(file, "r");
  try {
    const buf = Buffer.alloc(MAX_CABECERA);
    const { bytesRead } = await handle.read(buf, 0, MAX_CABECERA, 0);
    const fin = buf.subarray(0, bytesRead).indexOf(0x0a);
    if (fin < 0) throw new BackupError("NOT_A_BACKUP", "Esto no parece una copia de Distop.");
    let header: BackupHeader;
    try {
      header = JSON.parse(buf.subarray(0, fin).toString("utf8")) as BackupHeader;
    } catch {
      throw new BackupError("NOT_A_BACKUP", "Esto no parece una copia de Distop.");
    }
    if (header?.format !== BACKUP_FORMAT) throw new BackupError("NOT_A_BACKUP", "Esto no parece una copia de Distop.");
    if (header.version !== BACKUP_VERSION) {
      throw new BackupError(
        "UNSUPPORTED_VERSION",
        `Esta copia usa el formato ${header.version} y este programa entiende el ${BACKUP_VERSION}.`,
      );
    }
    if (header.cipher?.name !== "aes-256-gcm") {
      throw new BackupError("UNSUPPORTED_CIPHER", "Esta copia usa un cifrado desconocido.");
    }
    return header;
  } finally {
    await handle.close();
  }
}

export type EntrySink = (chunk: Buffer) => Promise<void>;

/**
 * Recorre la copia entregando cada entrada según llega, sin materializarla.
 * `onEntry` decide qué hacer con cada fichero y devuelve por dónde verterlo.
 *
 * Recibe también el manifiesto, que para entonces ya está leído: el formato
 * obliga a que vaya primero y ninguna entrada se acepta sin él. Sin pasarlo
 * aquí, quien restaura no tendría con qué comparar hasta que el recorrido
 * hubiera terminado — es decir, hasta después de haber escrito los ficheros.
 */
export async function readBackup(
  file: string,
  passphrase: string,
  onEntry: (path: string, size: number, manifest: BackupManifest) => Promise<EntrySink>,
  /**
   * `stopAfterManifest` lee lo justo para saber de quién es la copia y qué
   * dice traer, sin recorrer cuarenta gigas. A cambio NO comprueba que el
   * fichero esté completo ni que los hashes cuadren — quien la use tiene que
   * decir que lo que devuelve no es una verificación, porque no lo es.
   */
  opts: { stopAfterManifest?: boolean } = {},
): Promise<BackupManifest> {
  const header = await readHeader(file);
  const salt = Buffer.from(header.kdf.salt, "base64");
  if (salt.length < SALT_BYTES) throw new BackupError("UNSUPPORTED_KDF", "La sal de esta copia es demasiado corta.");
  const nonceBase = Buffer.from(header.cipher.nonce, "base64");
  if (nonceBase.length < 8) throw ILEGIBLE();
  const key = await deriveKey(passphrase, salt, header.kdf);

  const origen = createReadStream(file, { start: Buffer.byteLength(JSON.stringify(header), "utf8") + 1 });

  let manifest: BackupManifest | null = null;
  let terminado = false;
  let linea: number[] = [];
  let abierta: { restante: number; sink: EntrySink } | null = null;
  const vistas = new Set<string>();

  const abrirEntrada = async (cabecera: { path?: string; size?: number; end?: boolean }): Promise<void> => {
    if (cabecera.end === true) {
      terminado = true;
      return;
    }
    if (typeof cabecera.path !== "string" || !Number.isSafeInteger(cabecera.size) || (cabecera.size ?? -1) < 0) {
      throw ILEGIBLE();
    }
    const path = cabecera.path;
    const size = cabecera.size ?? 0;
    /* Dos entradas con la misma ruta: la segunda pisaría a la primera después
       de que la primera ya pasara la comprobación de hash. */
    if (vistas.has(path)) throw new BackupError("DUPLICATE_ENTRY", "La copia trae dos veces el mismo archivo.");
    vistas.add(path);

    if (path === "manifest.json") {
      if (manifest !== null) throw new BackupError("DUPLICATE_ENTRY", "La copia trae dos manifiestos.");
      if (size === 0 || size > 64 * 1024 * 1024) throw ILEGIBLE();
      const trozos: Buffer[] = [];
      let leidos = 0;
      abierta = {
        restante: size,
        sink: async (chunk) => {
          trozos.push(chunk);
          leidos += chunk.length;
          if (leidos === size) {
            try {
              manifest = validateManifest(JSON.parse(Buffer.concat(trozos).toString("utf8")));
            } catch (error) {
              if (error instanceof BackupError) throw error;
              throw ILEGIBLE();
            }
            if (opts.stopAfterManifest) terminado = true;
          }
        },
      };
      return;
    }

    if (manifest === null) throw new BackupError("NO_MANIFEST", "La copia no empieza por su manifiesto.");
    const sink = await onEntry(path, size, manifest);
    if (size === 0) {
      /* También se cierra el destino y se verifica el hash de la cadena vacía. */
      await sink(Buffer.alloc(0));
      abierta = null;
    } else {
      abierta = { restante: size, sink };
    }
  };

  const consumir = async (plano: Buffer): Promise<void> => {
    let resto = plano;
    while (resto.length > 0 && !terminado) {
      if (abierta) {
        const toma = Math.min(abierta.restante, resto.length);
        await abierta.sink(resto.subarray(0, toma));
        abierta.restante -= toma;
        resto = resto.subarray(toma);
        if (abierta.restante === 0) abierta = null;
        continue;
      }
      const salto = resto.indexOf(0x0a);
      if (salto < 0) {
        for (const byte of resto) linea.push(byte);
        if (linea.length > MAX_CABECERA) throw ILEGIBLE();
        return;
      }
      for (const byte of resto.subarray(0, salto)) linea.push(byte);
      const texto = Buffer.from(linea).toString("utf8");
      linea = [];
      resto = resto.subarray(salto + 1);
      let cabecera: { path?: string; size?: number; end?: boolean };
      try {
        cabecera = JSON.parse(texto) as { path?: string; size?: number; end?: boolean };
      } catch {
        throw ILEGIBLE();
      }
      await abrirEntrada(cabecera);
    }
  };

  await descifrarBloques(origen, key, nonceBase, consumir, () => terminado);
  origen.destroy();

  if (manifest === null) throw new BackupError("NO_MANIFEST", "La copia no trae manifiesto.");
  if (opts.stopAfterManifest) return manifest;
  if (!terminado || abierta !== null) throw new BackupError("TRUNCATED", "La copia está incompleta: le falta el final.");
  return manifest;
}

/** Descifra bloque a bloque, comprobando etiqueta, índice y marca de final. */
async function descifrarBloques(
  origen: Readable,
  key: Buffer,
  nonceBase: Buffer,
  consumir: (plano: Buffer) => Promise<void>,
  basta: () => boolean,
): Promise<void> {
  let buffer = Buffer.alloc(0);
  let indice = 0;
  let cerrado = false;

  const procesar = async (fin: boolean): Promise<void> => {
    while (!cerrado && !basta()) {
      if (buffer.length < 4) return;
      const largo = buffer.readUInt32BE(0);
      if (largo > BLOQUE + 64) throw ILEGIBLE();
      const total = 4 + largo + TAG_BYTES;
      if (buffer.length < total) return;

      /* Si detrás hay más bytes, este bloque no es el último. Si no los hay y
         el fichero aún no se ha terminado de leer, todavía no se sabe: se
         espera. Decidirlo antes de tiempo era el fallo — un bloque final que
         llegaba entero en la misma lectura se juzgaba como intermedio, y como
         la marca va autenticada, no validaba. */
      const hayMas = buffer.length > total;
      if (!hayMas && !fin) return;
      const ultimo = !hayMas;

      let plano: Buffer;
      try {
        const descifrador = createDecipheriv("aes-256-gcm", key, nonceDe(nonceBase, indice));
        descifrador.setAAD(datosAsociados(indice, ultimo));
        descifrador.setAuthTag(buffer.subarray(4 + largo, total));
        plano = Buffer.concat([descifrador.update(buffer.subarray(4, 4 + largo)), descifrador.final()]);
      } catch {
        /* Aquí caen a la vez la frase equivocada, el byte cambiado y el fichero
           cortado justo por un límite de bloque: los tres son "esto no es lo que
           dice ser", y distinguirlos sería un oráculo. */
        throw ILEGIBLE();
      }
      if (ultimo) cerrado = true;

      buffer = buffer.subarray(total);
      indice++;
      await consumir(plano);
    }
  };

  for await (const trozo of origen) {
    buffer = Buffer.concat([buffer, trozo as Buffer]);
    await procesar(false);
    if (basta()) return;
  }
  await procesar(true);

  if (!basta() && !cerrado) throw new BackupError("TRUNCATED", "La copia está incompleta: le falta el final.");
}

/* ── utilidades compartidas ───────────────────────────────────────────── */

export async function sha256File(file: string): Promise<{ hash: string; size: number }> {
  const hasher = createHash("sha256");
  let size = 0;
  for await (const trozo of createReadStream(file)) {
    const buf = trozo as Buffer;
    size += buf.length;
    hasher.update(buf);
  }
  return { hash: hasher.digest("hex"), size };
}

export function sameHash(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}

/**
 * Comprueba que una ruta del manifiesto es un destino aceptable.
 *
 * Lo que llega dentro de una copia lo escribió alguien que no somos nosotros.
 * Se rechaza cualquier ruta absoluta, cualquier salto hacia arriba, cualquier
 * letra de unidad de Windows, cualquier barra invertida y cualquier segmento
 * vacío. Y no se "sanea" para dejarla pasar: se rechaza.
 */
export function safeEntryPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > 512) return false;
  if (path.includes("\\") || path.includes("\0")) return false;
  if (path.startsWith("/")) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  return path.split("/").every((parte) => parte !== "" && parte !== "." && parte !== "..");
}
