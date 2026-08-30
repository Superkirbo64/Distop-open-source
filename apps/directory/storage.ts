import type { KvKey } from "./types.ts";

export interface StoredValue<T> {
  value: T | null;
  version: string | null;
}

export interface ListPage<T> {
  values: T[];
  cursor: string;
}

/**
 * El dominio no conoce Deno KV. La operación condicional es parte del contrato:
 * dos renovaciones simultáneas no pueden pisar una época más nueva con otra
 * vieja. Un backend SQL la implementará con una transacción, no cambiando las
 * reglas del directorio.
 */
export interface DirectoryStorage {
  get<T>(key: KvKey): Promise<StoredValue<T>>;
  set<T>(key: KvKey, value: T, options?: { expireIn?: number }): Promise<void>;
  setIfVersion<T>(key: KvKey, version: string | null, value: T, options?: { expireIn?: number }): Promise<boolean>;
  delete(key: KvKey): Promise<void>;
  list<T>(prefix: KvKey, options?: { cursor?: string; limit?: number }): Promise<ListPage<T>>;
}

export class DenoKvStorage implements DirectoryStorage {
  constructor(private readonly kv: Deno.Kv) {}

  async get<T>(key: KvKey): Promise<StoredValue<T>> {
    const entry = await this.kv.get<T>(key as Deno.KvKey);
    return { value: entry.value, version: entry.versionstamp };
  }

  async set<T>(key: KvKey, value: T, options?: { expireIn?: number }): Promise<void> {
    await this.kv.set(key as Deno.KvKey, value, options?.expireIn ? { expireIn: options.expireIn } : undefined);
  }

  async setIfVersion<T>(key: KvKey, version: string | null, value: T, options?: { expireIn?: number }): Promise<boolean> {
    const operation = this.kv.atomic()
      .check({ key: key as Deno.KvKey, versionstamp: version })
      .set(key as Deno.KvKey, value, options?.expireIn ? { expireIn: options.expireIn } : undefined);
    const result = await operation.commit();
    return result.ok;
  }

  async delete(key: KvKey): Promise<void> {
    await this.kv.delete(key as Deno.KvKey);
  }

  async list<T>(prefix: KvKey, options: { cursor?: string; limit?: number } = {}): Promise<ListPage<T>> {
    const iterator = this.kv.list<T>({ prefix: prefix as Deno.KvKey }, {
      cursor: options.cursor,
      limit: Math.min(options.limit ?? 100, 100),
    });
    const values: T[] = [];
    for await (const entry of iterator) values.push(entry.value);
    return { values, cursor: iterator.cursor };
  }
}

export class MemoryStorage implements DirectoryStorage {
  private readonly data = new Map<string, { value: unknown; version: number; expiresAt: number | null }>();
  private serial = 0;

  private id(key: KvKey): string {
    return JSON.stringify(key);
  }

  async get<T>(key: KvKey): Promise<StoredValue<T>> {
    const id = this.id(key);
    const entry = this.data.get(id);
    if (!entry || (entry.expiresAt !== null && entry.expiresAt <= Date.now())) {
      this.data.delete(id);
      return { value: null, version: null };
    }
    return { value: entry.value as T, version: String(entry.version) };
  }

  async set<T>(key: KvKey, value: T, options?: { expireIn?: number }): Promise<void> {
    this.data.set(this.id(key), {
      value,
      version: ++this.serial,
      expiresAt: options?.expireIn ? Date.now() + options.expireIn : null,
    });
  }

  async setIfVersion<T>(key: KvKey, version: string | null, value: T, options?: { expireIn?: number }): Promise<boolean> {
    const current = await this.get(key);
    if (current.version !== version) return false;
    await this.set(key, value, options);
    return true;
  }

  async delete(key: KvKey): Promise<void> {
    this.data.delete(this.id(key));
  }

  async list<T>(prefix: KvKey, options: { cursor?: string; limit?: number } = {}): Promise<ListPage<T>> {
    const prefixText = JSON.stringify(prefix).slice(0, -1);
    const all: T[] = [];
    for (const [key, entry] of this.data) {
      if (!key.startsWith(prefixText)) continue;
      if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) continue;
      all.push(entry.value as T);
    }
    const offset = Number(options.cursor || "0") || 0;
    const limit = Math.min(options.limit ?? 100, 100);
    return { values: all.slice(offset, offset + limit), cursor: offset + limit < all.length ? String(offset + limit) : "" };
  }
}
