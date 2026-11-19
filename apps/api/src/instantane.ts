import type { Db } from "@po-agent/db";

/**
 * Instantané de l'état de démo, en JSON portable (PGlite comme Postgres).
 * On le produit une seule fois après un préchargement avec Claude, puis la démo et le jury repartent de lui :
 * aucun des ~500 appels au modèle du préchargement n'est rejoué.
 */

/** Ordre d'insertion compatible avec les clés étrangères. */
const TABLES = [
  "comptes",
  "feedbacks",
  "extractions",
  "items",
  "preuves",
  "jugements_impact",
  "scores",
  "questions",
  "reponses",
  "regles",
  "propositions",
  "stories",
  "alertes",
  "journal_activite",
  "traces_llm",
] as const;

/** Tables dont l'identifiant vient d'une séquence (BIGSERIAL) : la séquence est recalée après import. */
const AVEC_SEQUENCE = new Set(["scores", "alertes", "journal_activite", "traces_llm"]);

export interface Instantane {
  format: "po-agent/instantane";
  version: 1;
  creeLe: string;
  fournisseur: string;
  tables: Record<string, Array<Record<string, unknown>>>;
}

function versJson(v: unknown): unknown {
  return v instanceof Date ? v.toISOString() : v;
}

export async function exporterInstantane(db: Db, fournisseur: string): Promise<Instantane> {
  const tables: Instantane["tables"] = {};
  for (const t of TABLES) {
    const r = await db.query<Record<string, unknown>>(`SELECT * FROM ${t}`);
    tables[t] = r.rows.map((ligne) => Object.fromEntries(Object.entries(ligne).map(([k, v]) => [k, versJson(v)])));
  }
  return { format: "po-agent/instantane", version: 1, creeLe: new Date().toISOString(), fournisseur, tables };
}

/** Remplace tout l'état par celui de l'instantané (la file de tâches est vidée : l'état est déjà traité). */
export async function importerInstantane(db: Db, i: Instantane): Promise<Record<string, number>> {
  if (i.format !== "po-agent/instantane" || i.version !== 1) throw new Error("Instantané au format inconnu");
  const comptes: Record<string, number> = {};
  await db.transaction(async (tx) => {
    await tx.exec(`TRUNCATE ${[...TABLES].reverse().join(", ")}, taches RESTART IDENTITY CASCADE`);
    for (const t of TABLES) {
      const lignes = i.tables[t] ?? [];
      for (const ligne of lignes) {
        const colonnes = Object.keys(ligne);
        const valeurs = colonnes.map((c) => {
          const v = ligne[c];
          return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
        });
        await tx.query(`INSERT INTO ${t} (${colonnes.join(", ")}) VALUES (${colonnes.map((_, k) => `$${k + 1}`).join(", ")})`, valeurs);
      }
      if (AVEC_SEQUENCE.has(t)) {
        await tx.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${t}), 1))`);
      }
      comptes[t] = lignes.length;
    }
  });
  return comptes;
}
