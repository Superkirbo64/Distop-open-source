/**
 * Markdown mínimo para mensajes (§9.2).
 * Devuelve nodos de React, nunca HTML: el contenido lo escribe cualquiera de la
 * comunidad, así que la vía de inyección se cierra por construcción, no filtrando.
 */
import type { ReactNode } from "react";

const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|`[^`]+`|https?:\/\/[^\s<]+)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(INLINE).map((chunk, index) => {
    const key = `${keyPrefix}-${index}`;
    if (!chunk) return null;

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

    return <span key={key}>{chunk}</span>;
  });
}

export function renderContent(content: string): ReactNode {
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
              {renderInline(text, `${index}-${lineIndex}`)}
            </span>
          ) : (
            renderInline(text, `${index}-${lineIndex}`)
          )}
        </span>
      );
    });
  });
}
