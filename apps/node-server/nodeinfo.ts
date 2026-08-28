/**
 * NodeInfo 2.1: la puerta estándar para que un directorio sepa qué somos (§19).
 *
 * Es el mismo esquema que publican Mastodon o Misskey, y por eso se adopta en
 * vez de inventar uno: los rastreadores del ecosistema ya saben leerlo. No
 * sustituye a /api/v1/info — lo anuncia: identidad, capacidades y época siguen
 * siendo del protocolo Distop.
 *
 * Solo existe con PUBLIC_DISCOVERY_ENABLED. NodeInfo se publica para ser
 * rastreado por desconocidos; una instancia doméstica que no optó por el
 * descubrimiento no tiene por qué anunciar su software y versión exactos a
 * quien enumere /.well-known/ (§22). Es el mismo interruptor que gobierna
 * /api/v1/discovery, porque es la misma intención: aparecer.
 *
 * Sin conteos de miembros a propósito: el esquema exige el objeto `usage` pero
 * ninguna de sus propiedades, y cuántas personas hay en una instancia
 * mayormente privada es un dato privado (§8).
 */
import { config } from "./config.ts";
import { HANDLED, notFound, route, send, type Ctx } from "./http.ts";
import { publicUrl } from "./tunnel.ts";
import { VERSION } from "./instance.ts";

const SCHEMA_2_1 = "http://nodeinfo.diaspora.software/ns/schema/2.1";
const REPOSITORIO = "https://github.com/Superkirbo64/Distop-open-source";

/** Dirección con la que se nos ve desde fuera; sin ella, la del propio socket. */
function base(ctx: Ctx): string {
  return (publicUrl() || ctx.url.origin).replace(/\/+$/, "");
}

/** El documento de descubrimiento: dónde está el NodeInfo de verdad. */
export function nodeInfoLinks(baseUrl: string): { links: Array<{ rel: string; href: string }> } {
  return { links: [{ rel: SCHEMA_2_1, href: `${baseUrl}/nodeinfo/2.1` }] };
}

export function nodeInfoDocument(baseUrl: string): Record<string, unknown> {
  return {
    version: "2.1",
    software: { name: "distop", version: VERSION, repository: REPOSITORIO },
    protocols: ["distop"],
    services: { inbound: [], outbound: [] },
    openRegistrations: config.registrationEnabled,
    usage: { users: {}, localPosts: 0 },
    metadata: {
      distop: {
        info: `${baseUrl}/api/v1/info`,
        discovery: `${baseUrl}/api/v1/discovery`,
      },
    },
  };
}

route("GET", "/.well-known/nodeinfo", (ctx) => {
  if (!config.publicDiscoveryEnabled) throw notFound();
  return nodeInfoLinks(base(ctx));
});

route("GET", "/nodeinfo/2.1", (ctx) => {
  if (!config.publicDiscoveryEnabled) throw notFound();
  // El parámetro `profile` es un SHOULD del esquema NodeInfo: dice qué versión
  // del documento va dentro sin tener que abrirlo.
  send(ctx, 200, nodeInfoDocument(base(ctx)), {
    "content-type": `application/json; profile="${SCHEMA_2_1}#"; charset=utf-8`,
  });
  return HANDLED;
});
