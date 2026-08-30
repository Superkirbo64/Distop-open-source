import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { canonicalJson, DirectoryService, fingerprintOf } from "./domain.ts";
import { isPublicIp } from "./network.ts";
import { MemoryStorage } from "./storage.ts";
import type { SignedDirectoryManifest } from "./types.ts";

const now = 1_800_000_000_000;

async function signedManifest(origin = "https://community.example"): Promise<SignedDirectoryManifest> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const fingerprint = await fingerprintOf(publicKey);
  const payload = {
    t: "DISTOP_DIRECTORY_MANIFEST" as const,
    version: 1 as const,
    nonce: "",
    instance_id: "instance-a",
    lineage_id: "lineage-a",
    epoch: 1,
    fingerprint,
    origin,
    communities: [{
      id: "community-a", name: "La Plaza", slug: "la-plaza", description: null,
      icon_url: null, banner_url: null, accent_color: "#4059e0", members: 4,
      visibility: "public" as const, join_policy: "invite" as const, tags: ["amigos"], language: "es",
    }],
    succession_chain: [],
    issued_at: now,
    expires_at: now + 24 * 60 * 60_000,
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
