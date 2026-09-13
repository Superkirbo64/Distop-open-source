import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { available, searchExpressions } from "./expressions.ts";

const sinClaves = { klipy: "", giphy: "" };

function falso(cuerpo: unknown, pedidas: URL[], status = 200) {
  return (url: URL) => {
    pedidas.push(url);
    return Promise.resolve(new Response(JSON.stringify(cuerpo), { status }));
  };
}

Deno.test("sin claves no hay pestañas, y buscar lo dice en vez de llamar a nadie", async () => {
  assertEquals(available(sinClaves), { gifs: false, stickers: false });
  assertEquals(available({ klipy: "k", giphy: "" }), { gifs: true, stickers: true });
  assertEquals(available({ klipy: "", giphy: "g" }), { gifs: true, stickers: false });
  const pedidas: URL[] = [];
  await assertRejects(() => searchExpressions("gifs", "hola", { limit: 10 }, sinClaves, falso({}, pedidas)), Error, "EXPRESSIONS_DISABLED");
  await assertRejects(() => searchExpressions("stickers", "", { limit: 10 }, { klipy: "", giphy: "g" }, falso({}, pedidas)), Error, "EXPRESSIONS_DISABLED");
  assertEquals(pedidas.length, 0);
});

Deno.test("los stickers salen de Klipy con la clave en la ruta y solo seis campos por resultado", async () => {
  const pedidas: URL[] = [];
  const cuerpo = {
    data: {
      data: [
        { slug: "gato", title: "Gato", file: { md: { webp: { url: "https://static.klipy.com/md.webp", width: 200, height: 180 } }, xs: { webp: { url: "https://static.klipy.com/xs.webp" } } } },
        { slug: "roto", title: "Sin archivo", file: {} },
      ],
    },
  };
  const resultados = await searchExpressions("stickers", "  gato  ", { limit: 999, region: "br" }, { klipy: "CLAVE", giphy: "" }, falso(cuerpo, pedidas));
  assertEquals(resultados, [{ id: "gato", url: "https://static.klipy.com/md.webp", preview: "https://static.klipy.com/xs.webp", title: "Gato", width: 200, height: 180 }]);
  const url = pedidas[0]!;
  assertEquals(url.pathname, "/api/v1/CLAVE/stickers/search");
  assertEquals(url.searchParams.get("q"), "gato");
  assertEquals(url.searchParams.get("per_page"), "50");
  assertEquals(url.searchParams.get("locale"), "br");
});

Deno.test("sin Klipy, los GIF salen de Giphy; sin texto, lo que está en portada", async () => {
  const pedidas: URL[] = [];
  const cuerpo = { data: [{ id: "g1", title: "Hola", images: { downsized_medium: { url: "https://media.giphy.com/g1.gif", width: "320", height: "240" }, fixed_width_small: { url: "https://media.giphy.com/g1s.gif" } } }] };
  const resultados = await searchExpressions("gifs", "", { limit: 12 }, { klipy: "", giphy: "GCLAVE" }, falso(cuerpo, pedidas));
  assertEquals(resultados[0]?.width, 320);
  assertEquals(pedidas[0]!.pathname, "/v1/gifs/trending");
  assertEquals(pedidas[0]!.searchParams.get("api_key"), "GCLAVE");
  assertEquals(pedidas[0]!.searchParams.has("q"), false);
});

Deno.test("un tercero caído se dice como tal, no como lista vacía", async () => {
  await assertRejects(
    () => searchExpressions("gifs", "x", { limit: 5 }, { klipy: "k", giphy: "" }, falso({}, [], 503)),
    Error,
    "EXPRESSIONS_UPSTREAM",
  );
});
