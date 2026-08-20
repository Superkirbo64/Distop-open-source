/**
 * Markdown mínimo para mensajes (§9.2).
 * Devuelve nodos de React, nunca HTML: el contenido lo escribe cualquiera de la
 * comunidad, así que la vía de inyección se cierra por construcción, no filtrando.
 */
import { useState, type ReactNode } from "react";
import { AnimatedEmoji, animatedIdFor } from "../components/AnimatedEmoji.tsx";

/**
 * Con qué pintar lo que en el texto es solo un id.
 * Las menciones se guardan como `<@id>` y `<#id>`, no como el nombre escrito:
 * así renombrarse no rompe las menciones viejas ni convierte a nadie en otra
 * persona. El nombre se resuelve aquí, al leer.
 */
export interface RenderContext {
  users?: Map<string, string> | undefined;
  channels?: Map<string, string> | undefined;
  /** Para resaltar la mención propia distinta de las demás. */
  selfId?: string | undefined;
  onChannel?: ((channelId: string) => void) | undefined;
  /** El servidor ya decidió si este mensaje podía avisar a todo el mundo. */
  everyone?: boolean | undefined;
  /** id → emoji propio, para pintar `<:nombre:id>` como imagen. */
  emojis?: Map<string, { name: string; url: string; kind: string }> | undefined;
  /** Mensaje hecho solo de emojis: se pintan grandes, como hace todo el mundo. */
  jumbo?: boolean | undefined;
}

const INLINE =
  /(<:[a-zA-Z0-9_]{2,32}:[0-9a-f-]{36}>|<@[0-9a-f-]{36}>|<#[0-9a-f-]{36}>|\|\|[^|]+\|\||\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|`[^`]+`|https?:\/\/[^\s<]+|@everyone|@todos)/g;

/**
 * Un emoji "de verdad": el pictograma base, con su selector de variación,
 * modificador de tono o los que va cosiendo con ZWJ, o una bandera (dos
 * indicadores regionales). Mismo criterio que isJumbo en @distop/protocol,
 * pero en forma de captura global: aquí no se pregunta "es todo esto un
 * emoji" sino "dónde hay uno dentro de este trozo de texto".
 */
const EMOJI_SEQUENCE =
  /(\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic}\uFE0F?)*|\p{Regional_Indicator}{2})/gu;

/**
 * Solo se llama en mensajes jumbo (puro emoji, ya pintado grande): ahí cada
 * emoji Unicode con versión animada se cambia por su AnimatedEmoji. Fuera de
 * jumbo el texto normal no se toca, para no convertir cada emoji suelto de
 * una frase corriente en un reproductor Lottie.
 */
function renderJumboText(text: string, keyPrefix: string): ReactNode[] {
  return text.split(EMOJI_SEQUENCE).map((piece, i) => {
    if (!piece) return null;
    if (i % 2 === 0) return piece;
    return animatedIdFor(piece) ? <AnimatedEmoji key={`${keyPrefix}-${i}`} char={piece} size={44} /> : piece;
  });
}

/**
 * Contenido oculto hasta que se toca.
 * Se pinta con el texto ya dentro y solo tapado por CSS, no fuera del árbol:
 * un lector de pantalla lo anuncia como spoiler y decide su usuario, que es lo
 * que pide §31. Una vez abierto no se vuelve a cerrar, como en cualquier sitio.
 */
function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setShown(true)}
      aria-expanded={shown}
      className={`rounded px-1 transition-colors ${
        shown ? "bg-sunken" : "bg-ink/85 text-transparent select-none hover:bg-ink/70"
      }`}
    >
      {children}
    </button>
  );
}

function Mention({ label, self, kind, onClick }: { label: string; self: boolean; kind: "user" | "channel"; onClick?: (() => void) | undefined }) {
  const className = `rounded px-1 py-px font-medium ${
    self ? "bg-warn/25 text-ink" : "bg-accent-soft text-accent"
  } ${onClick ? "hover:underline" : ""}`;

  // Un canal lleva a alguna parte, una persona no: solo el primero es un botón.
  if (kind === "channel" && onClick)
    return (
      <button type="button" onClick={onClick} className={className}>
        #{label}
      </button>
    );

  return <span className={className}>{kind === "channel" ? `#${label}` : `@${label}`}</span>;
}

function renderInline(text: string, keyPrefix: string, ctx: RenderContext): ReactNode[] {
  return text.split(INLINE).map((chunk, index) => {
    const key = `${keyPrefix}-${index}`;
    if (!chunk) return null;

    if (chunk.startsWith("<:") && chunk.endsWith(">")) {
      const corte = chunk.lastIndexOf(":");
      const nombre = chunk.slice(2, corte);
      const emoji = ctx.emojis?.get(chunk.slice(corte + 1, -1));

      /* Si el emoji ya no existe queda `:nombre:`, que sigue leyéndose. Un
         cuadro roto no dice nada; el nombre sí dice qué quiso poner quien escribió. */
      if (!emoji) return <span key={key}>:{nombre}:</span>;

      // Un sticker es un emoji grande: mismo dato, distinto tamaño al pintar.
      const alto = emoji.kind === "sticker" ? "h-32" : ctx.jumbo ? "h-12" : "h-[1.4em]";
      return (
        <img
          key={key}
          src={emoji.url}
          alt={`:${emoji.name}:`}
          title={`:${emoji.name}:`}
          loading="lazy"
          className={`${alto} inline-block w-auto max-w-full align-text-bottom`}
        />
      );
    }

    if (chunk.startsWith("<@") && chunk.endsWith(">")) {
      const id = chunk.slice(2, -1);
      // Sin nombre conocido no se inventa uno: alguien que ya no está en la
      // comunidad se dice, en vez de pintar un id crudo de 36 caracteres.
      return <Mention key={key} kind="user" label={ctx.users?.get(id) ?? "…"} self={id === ctx.selfId} />;
    }

    if (chunk.startsWith("<#") && chunk.endsWith(">")) {
      const id = chunk.slice(2, -1);
      const name = ctx.channels?.get(id);
      if (!name) return <span key={key}>#…</span>;
      return <Mention key={key} kind="channel" label={name} self={false} onClick={ctx.onChannel ? () => ctx.onChannel!(id) : undefined} />;
    }

    // @everyone solo se ve como aviso si el servidor dejó que lo fuera: sin el
    // permiso queda como texto normal, que es lo que fue.
    if (chunk === "@everyone" || chunk === "@todos")
      return ctx.everyone ? (
        <span key={key} className="rounded bg-warn/25 px-1 py-px font-medium text-ink">
          {chunk}
        </span>
      ) : (
        <span key={key}>{chunk}</span>
      );

    if (chunk.startsWith("||") && chunk.endsWith("||") && chunk.length > 4)
      return <Spoiler key={key}>{chunk.slice(2, -2)}</Spoiler>;

    if (chunk.startsWith("**") && chunk.endsWith("**") && chunk.length > 4)
      return <strong key={key}>{chunk.slice(2, -2)}</strong>;

    if (chunk.startsWith("~~") && chunk.endsWith("~~") && chunk.length > 4)
      return (
        <s key={key} className="opacity-70">
          {chunk.slice(2, -2)}
        </s>
      );

    if (chunk.startsWith("*") && chunk.endsWith("*") && chunk.length > 2)
      return <em key={key}>{chunk.slice(1, -1)}</em>;

    if (chunk.startsWith("`") && chunk.endsWith("`") && chunk.length > 2)
      return (
        <code key={key} className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[0.85em]">
          {chunk.slice(1, -1)}
        </code>
      );

    if (chunk.startsWith("http://") || chunk.startsWith("https://"))
      return (
        <a
          key={key}
          href={chunk}
          target="_blank"
          // noopener/noreferrer: la pestaña destino no toca la nuestra.
          rel="noopener noreferrer nofollow ugc"
          className="text-accent underline underline-offset-2 hover:no-underline"
        >
          {chunk}
        </a>
      );

    if (ctx.jumbo) return <span key={key}>{renderJumboText(chunk, key)}</span>;

    return <span key={key}>{chunk}</span>;
  });
}

export function renderContent(content: string, ctx: RenderContext = {}): ReactNode {
  // Los bloques de código se separan primero: dentro no se interpreta nada más.
  const blocks = content.split(/```/);

  return blocks.map((block, index) => {
    if (index % 2 === 1) {
      const newline = block.indexOf("\n");
      const body = newline === -1 ? block : block.slice(newline + 1);
      return (
        <pre
          key={`block-${index}`}
          className="my-1 overflow-x-auto rounded-[10px] border border-line bg-sunken p-3 font-mono text-[0.85em]"
        >
          <code>{body.replace(/\n$/, "")}</code>
        </pre>
      );
    }

    return block.split("\n").map((line, lineIndex) => {
      const quoted = line.startsWith("> ");
      const text = quoted ? line.slice(2) : line;
      return (
        <span key={`${index}-${lineIndex}`}>
          {lineIndex > 0 ? <br /> : null}
          {quoted ? (
            <span className="my-0.5 flex gap-2 border-l-2 border-line pl-2 text-muted">
              {renderInline(text, `${index}-${lineIndex}`, ctx)}
            </span>
          ) : (
            renderInline(text, `${index}-${lineIndex}`, ctx)
          )}
        </span>
      );
    });
  });
}
