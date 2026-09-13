/**
 * Entrada offline para importar UNA comunidad en otra instancia.
 *
 * La importación nunca es una ruta HTTP: reemplaza e inserta datos que deben
 * permanecer coherentes entre varias tablas, así que se ejecuta con el servidor
 * detenido. La frase viaja por entorno y no por argumentos visibles en la lista
 * de procesos.
 *
 *   node import-community.ts --bundle comunidad.distop-backup \
 *     --certificate certificate.json --target ./data --confirm-stopped
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CommunityMigrationCert } from "@distop/protocol";

export interface ImportCommunityArgs {
  bundle?: string;
  certificate?: string;
  target?: string;
  confirmStopped: boolean;
  help: boolean;
}

type ValueField = "bundle" | "certificate" | "target";
const VALUE_OPTIONS: Readonly<Record<string, ValueField>> = {
  "--bundle": "bundle",
  "--certificate": "certificate",
  "--target": "target",
};

export function parseImportCommunityArgs(argv: string[]): ImportCommunityArgs {
  const parsed: ImportCommunityArgs = { confirmStopped: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (token === "--confirm-stopped") {
      parsed.confirmStopped = true;
      continue;
    }
    const field = VALUE_OPTIONS[token];
    if (!field) throw new Error(`Opción desconocida: ${token}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`Falta el valor de ${token}.`);
    parsed[field] = value;
  }
  return parsed;
}

function usage(): string {
  return [
    "Uso:",
    "  node import-community.ts --bundle comunidad.distop-backup \\",
    "    --certificate certificate.json \\",
    "    --target ./data --confirm-stopped",
    "",
    "--certificate acepta el certificado solo o la respuesta completa de /migration/export.",
    "La instancia debe estar PARADA. La frase no se acepta como argumento.",
  ].join("\n");
}

function readCertificate(path: string): CommunityMigrationCert {
  const document = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("El archivo de certificado no contiene un objeto JSON.");
  }
  const certificate = "certificate" in document ? document.certificate : document;
  if (!certificate || typeof certificate !== "object" || Array.isArray(certificate)) {
    throw new Error("El archivo no contiene un certificado de migración.");
  }
  return certificate as CommunityMigrationCert;
}

async function main(): Promise<void> {
  let args: ImportCommunityArgs;
  try {
    args = parseImportCommunityArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.bundle || !args.certificate || !args.target || !args.confirmStopped) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const passphrase = process.env.DISTOP_MIGRATION_PASSPHRASE ?? "";
  if (passphrase.length < 12) {
    console.error("DISTOP_MIGRATION_PASSPHRASE debe tener al menos 12 caracteres.");
    process.exitCode = 2;
    return;
  }

  const bundle = resolve(args.bundle);
  const certificatePath = resolve(args.certificate);
  const target = resolve(args.target);
  for (const [label, path] of [["bundle", bundle], ["certificado", certificatePath]] as const) {
    if (!existsSync(path)) {
      console.error(`No existe el ${label}: ${path}`);
      process.exitCode = 2;
      return;
    }
  }
  if (!existsSync(join(target, "app.db"))) {
    console.error(`El destino no contiene app.db: ${target}`);
    process.exitCode = 2;
    return;
  }

  /* community-migration.ts importa config.ts y db.ts para el lado exportador.
     Se cargan DESPUÉS de fijar el destino, de modo que nunca abran por accidente
     la base predeterminada. El secreto efímero solo satisface la configuración
     de producción de esta herramienta offline; no se guarda ni firma sesiones. */
  process.env.DATABASE_PATH = join(target, "app.db");
  process.env.DEFAULT_STORAGE_PATH = join(target, "uploads");
  process.env.AUTH_SECRET ||= randomBytes(32).toString("hex");

  let MigrationErrorClass: typeof import("./community-migration.ts").MigrationError | undefined;
  try {
    const certificate = readCertificate(certificatePath);
    const { importMigration, MigrationError } = await import("./community-migration.ts");
    MigrationErrorClass = MigrationError;
    const report = await importMigration({ file: bundle, passphrase, dataDir: target, certificate });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      console.error("No se importó nada: hay colisiones que deben resolverse primero.");
      process.exitCode = 1;
    }
  } catch (error) {
    const code = MigrationErrorClass && error instanceof MigrationErrorClass ? error.code : "IMPORT_FAILED";
    console.error(`${code}: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main();
}
