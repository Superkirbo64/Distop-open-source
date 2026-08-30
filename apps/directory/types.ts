export type KvKey = readonly (string | number | bigint | boolean | Uint8Array)[];

export type Visibility = "public";
export type JoinPolicy = "open" | "invite" | "request";

export interface PublicCommunityProfile {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  icon_url: string | null;
  banner_url: string | null;
  accent_color: string | null;
  members: number;
  visibility: Visibility;
  join_policy: JoinPolicy;
  tags: string[];
  language: string | null;
}

export interface DirectoryManifestPayload {
  t: "DISTOP_DIRECTORY_MANIFEST";
  version: 1;
  nonce: string;
  instance_id: string;
  lineage_id: string;
  epoch: number;
  fingerprint: string;
  origin: string;
  communities: PublicCommunityProfile[];
  succession_chain: SuccessionCertificate[];
  issued_at: number;
  expires_at: number;
}

export interface SuccessionCertificate {
  payload: {
    t: "DISTOP_SUCCESSION_CERT";
    version: 1;
    lineage_id: string;
    from_instance_id: string;
    from_epoch: number;
    from_fingerprint: string;
    to_instance_id: string;
    to_epoch: number;
    to_fingerprint: string;
    to_public_key: JsonWebKey;
    allowed_origins: string[];
    issued_at: number;
    not_before: number;
    expires_at: number;
    handover_id: string;
  };
  signature: string;
  signer_public_key: JsonWebKey;
  signer_fingerprint: string;
}

export interface SignedDirectoryManifest {
  payload: DirectoryManifestPayload;
  signature: string;
  public_key: JsonWebKey;
}

export interface StoredListing extends PublicCommunityProfile {
  instance_id: string;
  lineage_id: string;
  epoch: number;
  fingerprint: string;
  origin: string;
  issued_at: number;
  expires_at: number;
}

/** Un solo registro renovable por instancia. Mantener las comunidades juntas
 * hace que una renovación diaria consuma una única escritura de Deno KV. */
export interface StoredManifest {
  identity: {
    instance_id: string;
    lineage_id: string;
    epoch: number;
    fingerprint: string;
    public_key: JsonWebKey;
  };
  communities: StoredListing[];
  issued_at: number;
  expires_at: number;
}

export interface DirectoryChallenge {
  nonce: string;
  instance_id: string;
  origin: string;
  expires_at: number;
}

export interface DirectoryReport {
  id: string;
  listing_key: string;
  reason: "spam" | "abuse" | "illegal" | "impersonation" | "other";
  detail: string;
  created_at: number;
  reporter_hash: string;
}

export interface ModerationAction {
  id: string;
  listing_key: string;
  action: "block" | "unblock";
  reason: string;
  created_at: number;
}
