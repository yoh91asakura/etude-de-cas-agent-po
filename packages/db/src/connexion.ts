import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Interface minimale vers Postgres : la même pour le vrai serveur (pg) et pour PGlite (tests, démo sans Docker). */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Exécute un script SQL de plusieurs instructions, sans paramètres. */
  exec(sql: string): Promise<void>;
  /** Exécute une fonction dans une transaction. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function ouvrirPostgres(url: string): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url });
  const surClient = (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): Db => ({
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params)).rows as T[] }),
    exec: async (sql: string) => {
      await client.query(sql);
    },
    transaction: () => {
      throw new Error("Transaction imbriquée non prise en charge");
    },
    close: async () => {},
  });
  return {
    ...surClient(pool),
    transaction: async <T>(fn: (tx: Db) => Promise<T>) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const resultat = await fn(surClient(client));
        await client.query("COMMIT");
        return resultat;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
    close: async () => {
      await pool.end();
    },
  };
}

/** Postgres embarqué (WASM). Sert aux tests et à une démo sans Docker. `dossier` absent : base en mémoire. */
export async function ouvrirPGlite(dossier?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = dossier ? new PGlite(dossier) : new PGlite();
  type Requetable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; exec: (sql: string) => Promise<unknown> };
  const surClient = (c: Requetable): Db => ({
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await c.query(sql, params)).rows as T[] }),
    exec: async (sql: string) => {
      await c.exec(sql);
    },
    transaction: () => {
      throw new Error("Transaction imbriquée non prise en charge");
    },
    close: async () => {},
  });
  return {
    ...surClient(pg),
    transaction: <T>(fn: (tx: Db) => Promise<T>) => pg.transaction((tx) => fn(surClient(tx))),
    close: async () => {
      await pg.close();
    },
  };
}

const DOSSIER_MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Applique les migrations SQL dans l'ordre, une seule fois chacune. */
export async function migrer(db: Db): Promise<string[]> {
  await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (nom TEXT PRIMARY KEY, appliquee_le TIMESTAMPTZ NOT NULL DEFAULT now())");
  const deja = new Set((await db.query<{ nom: string }>("SELECT nom FROM schema_migrations")).rows.map((r) => r.nom));
  const fichiers = (await readdir(DOSSIER_MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
  const appliquees: string[] = [];
  for (const f of fichiers) {
    if (deja.has(f)) continue;
    const sql = await readFile(path.join(DOSSIER_MIGRATIONS, f), "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query("INSERT INTO schema_migrations (nom) VALUES ($1)", [f]);
    });
    appliquees.push(f);
  }
  return appliquees;
}
