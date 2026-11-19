import type { Db } from "./connexion.ts";

export interface Tache {
  id: string;
  type: string;
  charge: Record<string, unknown>;
  tentatives: number;
}

/** Interface de la file de tâches du socle. L'agent ne voit que cette interface. */
export interface FileTaches {
  /** Ajoute une tâche. Avec une clé, la même tâche n'est jamais mise deux fois en file : renvoie null si elle existe déjà. */
  ajouter(type: string, charge: Record<string, unknown>, options?: { cle?: string; disponibleLe?: Date }): Promise<string | null>;
  /** Prend la plus ancienne tâche disponible parmi ces types, ou null. Deux workers ne prennent jamais la même. */
  prendre(types: string[]): Promise<Tache | null>;
  terminer(id: string): Promise<void>;
  /** Échec : la tâche repasse en file après un délai, ou passe en échec définitif après le nombre maximal de tentatives. */
  echouer(id: string, erreur: string): Promise<"reessai" | "echec">;
}

export const TENTATIVES_MAX = 3;

/** Version minimale sur Postgres (FOR UPDATE SKIP LOCKED). La version du socle se brancherait derrière la même interface. */
export function fileTachesPostgres(db: Db, delaiReessaiMs = 5_000): FileTaches {
  return {
    async ajouter(type, charge, options = {}) {
      const r = await db.query<{ id: string }>(
        `INSERT INTO taches (type, charge, cle, disponible_le)
         VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))
         ON CONFLICT (cle) DO NOTHING
         RETURNING id`,
        [type, JSON.stringify(charge), options.cle ?? null, options.disponibleLe?.toISOString() ?? null],
      );
      return r.rows[0] ? String(r.rows[0].id) : null;
    },

    async prendre(types) {
      const r = await db.query<{ id: string; type: string; charge: Record<string, unknown>; tentatives: number }>(
        `UPDATE taches SET statut = 'en_cours', prise_le = now(), tentatives = tentatives + 1
         WHERE id = (
           SELECT id FROM taches
           WHERE statut = 'a_faire' AND disponible_le <= now() AND type = ANY($1)
           ORDER BY cree_le, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING id, type, charge, tentatives`,
        [types],
      );
      const t = r.rows[0];
      return t ? { id: String(t.id), type: t.type, charge: t.charge, tentatives: t.tentatives } : null;
    },

    async terminer(id) {
      await db.query("UPDATE taches SET statut = 'faite', erreur = NULL, cle = NULL WHERE id = $1", [id]);
    },

    async echouer(id, erreur) {
      const r = await db.query<{ statut: string }>(
        `UPDATE taches
         SET statut = CASE WHEN tentatives >= $3 THEN 'echec' ELSE 'a_faire' END,
             erreur = $2,
             disponible_le = now() + ($4 || ' milliseconds')::interval
         WHERE id = $1
         RETURNING statut`,
        [id, erreur, TENTATIVES_MAX, String(delaiReessaiMs)],
      );
      return r.rows[0]?.statut === "echec" ? "echec" : "reessai";
    },
  };
}
