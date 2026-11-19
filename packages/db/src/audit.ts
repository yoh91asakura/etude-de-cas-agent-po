import type { Db } from "./connexion.ts";

export type Acteur = "agent" | "po" | "systeme";

/** Consigne une action dans le journal d'activité (service d'audit du socle, version minimale). */
export async function journaliser(
  db: Db,
  /** `horodatage` : l'heure de l'horloge du scénario (ctx.maintenant()), pour que le journal et les feedbacks partagent une date. */
  entree: { acteur: Acteur; action: string; cible?: string; details?: Record<string, unknown>; reglesCitees?: string[]; horodatage?: Date },
): Promise<void> {
  await db.query(
    "INSERT INTO journal_activite (acteur, action, cible, details, regles_citees, horodatage) VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()))",
    [entree.acteur, entree.action, entree.cible ?? null, JSON.stringify(entree.details ?? {}), JSON.stringify(entree.reglesCitees ?? []), entree.horodatage?.toISOString() ?? null],
  );
}

export interface TraceLLM {
  etape: string;
  modele: string;
  effort?: string;
  dureeMs: number;
  tokensEntree?: number;
  tokensSortie?: number;
  stopReason?: string;
  statut: "ok" | "refus" | "schema_invalide" | "erreur";
  erreur?: string;
}

/** Enregistre la trace d'un appel au modèle (observabilité du socle, version minimale). */
export async function tracer(db: Db, t: TraceLLM): Promise<void> {
  await db.query(
    `INSERT INTO traces_llm (etape, modele, effort, duree_ms, tokens_entree, tokens_sortie, stop_reason, statut, erreur)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [t.etape, t.modele, t.effort ?? null, Math.round(t.dureeMs), t.tokensEntree ?? null, t.tokensSortie ?? null, t.stopReason ?? null, t.statut, t.erreur ?? null],
  );
}
