/**
 * Hospedar la instancia sin saber de terminales (§37).
 * Un doble clic no puede contestar preguntas, así que esto deja resuelto todo lo
 * que hoy hay que hacer a mano antes de arrancar: dependencias y el cliente
 * compilado. Después arranca el servidor
 * y abre el navegador cuando el puerto responde de verdad, no tras una espera
 * inventada.
 *
 * Es también el trozo que la app de escritorio ejecutará por dentro cuando
 * exista: el botón "Hospedar aquí" hace exactamente esta secuencia.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const force = process.argv.includes("--build");
const wantsTunnel = process.argv.includes("--tunnel");

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
}

/* ── 1. dependencias ─────────────────────────────────────────────────── */

if (!existsSync(join(root, "node_modules"))) {
  console.log("Instalando dependencias (solo la primera vez, tarda un rato)…\n");
  run(npm, ["install"]);
}

/* El secreto de sesiones ya no se escribe aquí: lo crea la propia instancia en
   data/secret.key, con permisos de solo-dueño, y no pasa por el .env. */
const envPath = join(root, ".env");

/* ── 2. cliente compilado ────────────────────────────────────────────── */

if (force || !existsSync(join(root, "apps", "web", "dist", "index.html"))) {
  console.log("Compilando el cliente…\n");
  run(npm, ["run", "build"]);
}

/* ── 3. arrancar y abrir ─────────────────────────────────────────────── */

// El mismo orden que aplica el servidor: --env-file no pisa lo que ya venga del
// entorno, así que un PORT puesto a mano manda sobre el del fichero.
const env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const port = process.env.PORT ?? /^PORT=(\d+)/m.exec(env)?.[1] ?? "5000";
const url = `http://localhost:${port}`;

/**
 * Comprobar el puerto ANTES de arrancar.
 * Si no, Node escupe un volcado de pila por EADDRINUSE, y peor: la espera de
 * más abajo la contestaría el programa que ya tiene el puerto, abriendo el
 * navegador contra algo que no es esta instancia.
 */
if (await portBusy(port)) {
  console.error(
    [
      "",
      `  El puerto ${port} ya está ocupado.`,
      `  Si es tu propia instancia, ya está en marcha: ábrela en ${url}`,
      "  Si es otro programa, cambia PORT en el fichero .env y vuelve a intentarlo.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

/* ── 4. túnel opcional (--tunnel) ────────────────────────────────────── */

let tunnel = null;
let publicUrl = "";

if (wantsTunnel) {
  // El túnel va PRIMERO: la instancia lee PUBLIC_URL una sola vez, al arrancar.
  // Si se hiciera al revés, las invitaciones saldrían con la dirección vieja.
  //
  // La dirección viaja por el entorno del proceso hijo, NO se escribe en .env:
  // la de un túnel rápido muere con él, y dejarla en disco significaba arrancar
  // al día siguiente anunciando una dirección que ya no existe.
  publicUrl = await startTunnel();
}

const server = spawn(process.execPath, ["--env-file-if-exists=../../.env", "server.ts"], {
  cwd: join(root, "apps", "node-server"),
  stdio: "inherit",
  env: {
    ...process.env,
    // Detrás del túnel, todas las peticiones llegan desde el propio equipo. Sin
    // esto, la comunidad entera cuenta como una sola IP y el límite de altas
    // deja fuera a la segunda persona. Se activa solo cuando hay túnel de
    // verdad delante: puesto siempre, cualquiera falsearía la cabecera.
    ...(wantsTunnel ? { TRUST_PROXY: "true", PUBLIC_URL: publicUrl } : {}),
  },
});

server.on("exit", (code) => {
  tunnel?.kill();
  process.exit(code ?? 0);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    tunnel?.kill();
    server.kill(signal);
  });
}

// Se espera a que /health conteste en vez de dormir un número mágico: si el
// servidor no llega a levantar (puerto ocupado, base bloqueada), no se abre un
// navegador con un error y ya está el fallo a la vista en la consola.
for (let attempt = 0; attempt < 60 && server.exitCode === null; attempt++) {
  await new Promise((r) => setTimeout(r, 250));
  try {
    await fetch(`${url}/health`);
    openBrowser(url);
    // El enlace que se reparte se imprime el último, después del arranque del
    // servidor: es lo que hay que copiar y no debe quedar sepultado por logs.
    if (publicUrl) {
      console.log(
        [
          "",
          "  ┌─ Tu comunidad está en internet ──────────────────────────────",
          `  │  ${publicUrl}`,
          "  │  Ábrelo en el móvil o pásaselo a quien quieras.",
          "  │  Deja de funcionar al cerrar esta ventana, y la próxima vez",
          "  │  la dirección será otra (túnel rápido, sin dominio propio).",
          "  └──────────────────────────────────────────────────────────────",
          "",
        ].join("\n"),
      );
    }
    break;
  } catch {
    // Todavía no escucha; se reintenta.
  }
}

/**
 * Túnel rápido de Cloudflare: dirección pública en HTTPS sin cuenta ni dominio.
 *
 * Lo que NO da: permanencia. El nombre es aleatorio y muere con el proceso, así
 * que al reiniciar el equipo hay una dirección nueva y el enlace repartido antes
 * deja de servir. Para una dirección fija hace falta un túnel con nombre y un
 * dominio propio (`cloudflared tunnel create`), o Tailscale Funnel. Esto es para
 * probar hoy, no para una comunidad que va a durar.
 */
function startTunnel() {
  console.log("Abriendo el túnel público…");

  // Sin `shell`: en Windows eso metería un cmd.exe por medio y al cerrar
  // quedaría el cloudflared vivo por su cuenta, con el túnel abierto.
  tunnel = spawn("cloudflared", ["tunnel", "--url", url], { stdio: ["ignore", "pipe", "pipe"] });

  return new Promise((done, fail) => {
    // La dirección aparece en el banner que cloudflared escribe por stderr.
    const address = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
    const timer = setTimeout(() => {
      tunnel?.kill();
      fail(new Error("cloudflared no dio ninguna dirección en 40 s. ¿Hay conexión a internet?"));
    }, 40_000);

    const read = (chunk) => {
      const found = address.exec(String(chunk));
      if (!found) return;
      clearTimeout(timer);
      done(found[0]);
    };

    tunnel.stdout.on("data", read);
    tunnel.stderr.on("data", read);
    tunnel.on("error", () => {
      clearTimeout(timer);
      fail(new Error("No se encontró cloudflared. Instálalo desde https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"));
    });
  });
}

/** Ocupado = alguien acepta conexiones ahí. No importa quién ni qué protocolo hable. */
function portBusy(target) {
  return new Promise((done) => {
    const socket = connect({ port: Number(target), host: "127.0.0.1" });
    const finish = (busy) => {
      socket.destroy();
      done(busy);
    };
    socket.setTimeout(800);
    socket.on("connect", () => finish(true));
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
  });
}

function openBrowser(target) {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", target]]
      : process.platform === "darwin"
        ? ["open", [target]]
        : ["xdg-open", [target]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // Sin escritorio (un servidor pelado, Termux): la URL ya está impresa arriba.
  }
}
