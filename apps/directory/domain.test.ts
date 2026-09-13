import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { canonicalJson, DirectoryService, fingerprintOf, RETENTION } from "./domain.ts";
import { isPublicIp } from "./network.ts";
import { MemoryStorage } from "./storage.ts";
import type { SignedDirectoryManifest } from "./types.ts";

const now = 1_800_000_000_000;

async function signedManifest(
  origin = "https://community.example",
  { lineage = "lineage-a", instance = "instance-a", community = "community-a", name = "La Plaza", issuedAt = now } = {},
): Promise<SignedDirectoryManifest> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const fingerprint = await fingerprintOf(publicKey);
  const payload = {
    t: "DISTOP_DIRECTORY_MANIFEST" as const,
    version: 1 as const,
    nonce: "",
    instance_id: instance,
    lineage_id: lineage,
    epoch: 1,
    fingerprint,
    origin,
    communities: [{
      id: community, name, slug: community, description: null,
      icon_url: null, banner_url: null, accent_color: "#4059e0", members: 4,
      visibility: "public" as const, join_policy: "invite" as const, tags: ["amigos"], language: "es",
    }],
    succession_chain: [],
    issued_at: issuedAt,
    expires_at: issuedAt + 24 * 60 * 60_000,
  };
  const challengeStorage = new MemoryStorage();
  const service = new DirectoryService(challengeStorage, async () => {}, () => now);
  payload.nonce = (await service.challenge(payload.instance_id, origin)).nonce;
  const bytes = new TextEncoder().encode((await import("./domain.ts")).canonicalJson(payload));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, bytes));
  let raw = "";
  for (const byte of signature) raw += String.fromCharCode(byte);
  return Object.assign({ payload, public_key: publicKey, signature: btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") }, { service });
}

Deno.test("una ficha firmada ocupa una lease y aparece en Explorar", async () => {
  const manifest = await signedManifest() as SignedDirectoryManifest & { service: DirectoryService };
  await manifest.service.register(manifest);
  const listing = await manifest.service.explore({ language: "es" });
  assertEquals(listing.communities.map((item) => item.name), ["La Plaza"]);
});

Deno.test("una ficha sin renovar se oculta y se guarda solo 90 días más", async () => {
  const manifest = await signedManifest();
  let clock = now;
  const expiries: number[] = [];
  const storage = new MemoryStorage();
  const setIfVersion = storage.setIfVersion.bind(storage);
  storage.setIfVersion = (key, version, value, options) => {
    expiries.push(options?.expireIn ?? 0);
    return setIfVersion(key, version, value, options);
  };
  // Mismo secreto de desarrollo: el desafío firmado por otro servicio vale aquí.
  const service = new DirectoryService(storage, async () => {}, () => clock);
  await service.register(manifest);
  assertEquals(expiries, [24 * 60 * 60_000 + RETENTION]);

  clock = now + 24 * 60 * 60_000;
  assertEquals((await service.explore()).communities.length, 0);
  assertEquals((await storage.get(["manifest", "lineage-a"])).value !== null, true);
});

Deno.test("la firma manipulada y una lease demasiado larga se rechazan", async () => {
  const badSignature = await signedManifest() as SignedDirectoryManifest & { service: DirectoryService };
  badSignature.payload.communities[0]!.name = "Suplantada";
  await assertRejects(() => badSignature.service.register(badSignature), Error, "BAD_SIGNATURE");

  const badLease = await signedManifest() as SignedDirectoryManifest & { service: DirectoryService };
  badLease.payload.expires_at = now + 31 * 60 * 60_000;
  await assertRejects(() => badLease.service.register(badLease), Error, "BAD_LEASE");
});

Deno.test("reenviar el mismo manifiesto no revive una ficha retirada", async () => {
  /* El desafío es un token HMAC sin estado: quien lo intercepte podría volver a
     enviarlo dentro de la ventana de reloj y resucitar lo que la instancia acaba
     de quitar. Solo se acepta un manifiesto posterior al guardado. */
  const primero = await signedManifest() as SignedDirectoryManifest & { service: DirectoryService };
  await primero.service.register(primero);
  await assertRejects(() => primero.service.register(primero), Error, "STALE_MANIFEST");
});

Deno.test("las redes privadas, loopback y metadata quedan fuera", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.2.3", "192.168.1.2", "169.254.169.254", "::1", "fd00::1", "2001:db8::1"])
    assertEquals(isPublicIp(address), false, address);
  assertEquals(isPublicIp("1.1.1.1"), true);
  assertEquals(isPublicIp("2606:4700:4700::1111"), true);
});

function base64url(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signValue(privateKey: CryptoKey, value: unknown): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(canonicalJson(value)),
  )));
}

Deno.test("un relevo firmado conserva la ficha y un salto sin cadena no", async () => {
  const storage = new MemoryStorage();
  const service = new DirectoryService(storage, async () => {}, () => now);
  const a = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const b = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicA = await crypto.subtle.exportKey("jwk", a.publicKey);
  const publicB = await crypto.subtle.exportKey("jwk", b.publicKey);
  const fingerprintA = await fingerprintOf(publicA);
  const fingerprintB = await fingerprintOf(publicB);
  const community = {
    id: "community-lineage", name: "La misma plaza", slug: "misma", description: null,
    icon_url: null, banner_url: null, accent_color: null, members: 8,
    visibility: "public" as const, join_policy: "open" as const, tags: [], language: "es",
  };

  const challengeA = await service.challenge("instance-a", "https://a.example");
  const payloadA = {
    t: "DISTOP_DIRECTORY_MANIFEST" as const, version: 1 as const, nonce: challengeA.nonce,
    instance_id: "instance-a", lineage_id: "lineage-shared", epoch: 1, fingerprint: fingerprintA,
    origin: "https://a.example", communities: [community], succession_chain: [],
    issued_at: now, expires_at: now + 24 * 60 * 60_000,
  };
  await service.register({ payload: payloadA, public_key: publicA, signature: await signValue(a.privateKey, payloadA) });

  const certPayload = {
    t: "DISTOP_SUCCESSION_CERT" as const, version: 1 as const, lineage_id: "lineage-shared",
    from_instance_id: "instance-a", from_epoch: 1, from_fingerprint: fingerprintA,
    to_instance_id: "instance-b", to_epoch: 2, to_fingerprint: fingerprintB, to_public_key: publicB,
    allowed_origins: ["https://b.example"], issued_at: now - 1_000, not_before: now - 1_000,
    expires_at: now + 24 * 60 * 60_000, handover_id: "handover-a-b",
  };
  const certificate = {
    payload: certPayload,
    signature: await signValue(a.privateKey, certPayload),
    signer_public_key: publicA,
    signer_fingerprint: fingerprintA,
  };
  const challengeB = await service.challenge("instance-b", "https://b.example");
  const payloadB = {
    ...payloadA, nonce: challengeB.nonce, instance_id: "instance-b", epoch: 2,
    fingerprint: fingerprintB, origin: "https://b.example", succession_chain: [certificate],
  };
  await service.register({ payload: payloadB, public_key: publicB, signature: await signValue(b.privateKey, payloadB) });
  const listing = await service.explore();
  assertEquals(listing.communities.length, 1);
  assertEquals(listing.communities[0]!.instance_id, "instance-b");

  const challengeC = await service.challenge("instance-c", "https://c.example");
  const payloadC = {
    ...payloadB,
    nonce: challengeC.nonce,
    instance_id: "instance-c",
    epoch: 3,
    origin: "https://c.example",
    succession_chain: [],
  };
  const signatureC = await signValue(b.privateKey, payloadC);
  await assertRejects(
    () => service.register({ payload: payloadC, public_key: publicB, signature: signatureC }),
    Error,
    "SUCCESSION_CHAIN_MISSING",
  );
});

Deno.test("un linaje nuevo en la misma dirección retira las fichas del anterior", async () => {
  const storage = new MemoryStorage();
  const service = new DirectoryService(storage, async () => {}, () => now);
  const vieja = await signedManifest("https://casa.example", { lineage: "lineage-vieja", instance: "instance-vieja", community: "vieja", name: "La Vieja" });
  const otra = await signedManifest("https://otra.example", { lineage: "lineage-otra", instance: "instance-otra", community: "otra", name: "La Otra" });
  await service.register(vieja);
  await service.register(otra);

  const nueva = await signedManifest("https://casa.example", { lineage: "lineage-nueva", instance: "instance-nueva", community: "nueva", name: "La Nueva" });
  await service.register(nueva);

  const nombres = (await service.explore()).communities.map((item) => item.name).sort();
  assertEquals(nombres, ["La Nueva", "La Otra"], "la vieja desaparece; otra dirección y la propia ficha nueva se quedan");
  assertEquals((await storage.get(["manifest", "lineage-vieja"])).value, null);
  assertEquals((await storage.get(["manifest", "lineage-nueva"])).value !== null, true);
});

Deno.test("dos registros en la misma dirección dejan exactamente una ficha, en cualquier orden", async () => {
  for (const orden of ["nueva-primero", "vieja-primero", "a-la-vez"]) {
    const storage = new MemoryStorage();
    let reloj = now;
    const service = new DirectoryService(storage, async () => {}, () => reloj);
    const a = await signedManifest("https://casa.example", { lineage: "lineage-a2", instance: "instance-a2", community: "a2", name: "A" });
    const b = await signedManifest("https://casa.example", { lineage: "lineage-b2", instance: "instance-b2", community: "b2", name: "B" });

    if (orden === "nueva-primero") {
      // B se registra más tarde según el directorio pero guarda antes; A llega
      // después con un registered_at más viejo y se retira a sí misma.
      reloj = now + 2; await service.register(b);
      reloj = now + 1; await service.register(a);
    } else if (orden === "vieja-primero") {
      reloj = now + 1; await service.register(a);
      reloj = now + 2; await service.register(b);
    } else {
      // Mismo reloj: desempata el lineage_id menor.
      reloj = now + 1;
      await Promise.all([service.register(a), service.register(b)]);
    }

    const nombres = (await service.explore()).communities.map((item) => item.name);
    assertEquals(nombres, [orden === "a-la-vez" ? "A" : "B"], orden);
  }
});

Deno.test("si falla la limpieza el registro vale igual, y el siguiente registro limpia", async () => {
  const storage = new MemoryStorage();
  let reloj = now;
  const service = new DirectoryService(storage, async () => {}, () => reloj);
  await service.register(await signedManifest("https://casa.example", { lineage: "lineage-v3", instance: "instance-v3", community: "v3", name: "Vieja" }));

  const borrar = storage.deleteIfVersion.bind(storage);
  let fallos = 1;
  storage.deleteIfVersion = async (key, version) => {
    if (fallos-- > 0) throw new Error("KV caído");
    return await borrar(key, version);
  };

  reloj = now + 1;
  const nueva = await signedManifest("https://casa.example", { lineage: "lineage-n3", instance: "instance-n3", community: "n3", name: "Nueva" });
  assertEquals((await service.register(nueva)).published, 1, "el manifiesto guardado no se convierte en error");
  assertEquals((await service.explore()).communities.map((item) => item.name).sort(), ["Nueva", "Vieja"]);

  reloj = now + 2;
  await service.register(await signedManifest("https://casa.example", { lineage: "lineage-z3", instance: "instance-z3", community: "z3", name: "Última" }));
  assertEquals((await service.explore()).communities.map((item) => item.name), ["Última"]);
});

Deno.test("un linaje que se mudó no se toca, y una ficha antigua sin origin sí se retira", async () => {
  const storage = new MemoryStorage();
  const service = new DirectoryService(storage, async () => {}, () => now + 5);
  const ficha = (lineage: string, name: string, origin: string) => ({
    id: lineage, name, slug: lineage, description: null, icon_url: null, banner_url: null, accent_color: null,
    members: 1, visibility: "public" as const, join_policy: "open" as const, tags: [], language: "es",
    instance_id: `i-${lineage}`, lineage_id: lineage, epoch: 1, fingerprint: "f", origin, issued_at: now, expires_at: now + 24 * 60 * 60_000,
  });
  const guardada = (lineage: string, name: string, origin: string, extra: Record<string, unknown>) => ({
    identity: { instance_id: `i-${lineage}`, lineage_id: lineage, epoch: 1, fingerprint: "f", public_key: {} },
    communities: [ficha(lineage, name, origin)], issued_at: now, expires_at: now + 24 * 60 * 60_000, ...extra,
  });
  // Se mudó de casa.example a otra.example: su ficha actual dice otra.example.
  await storage.set(["manifest", "lineage-mudada"], guardada("lineage-mudada", "Mudada", "https://otra.example", { origin: "https://otra.example", registered_at: now }));
  // Ficha de antes de este cambio: sin origin ni registered_at en la raíz.
  await storage.set(["manifest", "lineage-antigua"], guardada("lineage-antigua", "Antigua", "https://casa.example", {}));

  await service.register(await signedManifest("https://casa.example", { lineage: "lineage-casa", instance: "instance-casa", community: "casa", name: "Casa" }));
  assertEquals((await service.explore()).communities.map((item) => item.name).sort(), ["Casa", "Mudada"]);
});
