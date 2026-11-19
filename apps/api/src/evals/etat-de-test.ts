/**
 * État de test de l'agent conversationnel, construit sans aucun appel au modèle.
 * Il part du jeu de données et de la vérité terrain : une preuve sûre par feedback dont l'item est connu,
 * et un Impact fixé à 1 pour tous les items (valeur de montage, pas un jugement). Le classement qui en sort
 * est calculé par le code du cockpit, ce qui donne au banc des valeurs de référence indépendantes du modèle.
 */
import { fileTachesPostgres, migrer, ouvrirPGlite } from "@po-agent/db";
import { FournisseurFaux } from "@po-agent/llm";
import { rescorer, type Contexte } from "@po-agent/agent";
import { chargerSeed } from "../seed.ts";
import { extraitRepresentatif, type DonneesEval } from "./donnees.ts";

export async function construireEtatDeTest(d: DonneesEval): Promise<Contexte> {
  const db = await ouvrirPGlite();
  await migrer(db);
  const maintenant = new Date(d.verite.dateDemo);
  // Le faux fournisseur garantit qu'aucun appel facturé ne part pendant le montage.
  const ctx: Contexte = { db, llm: new FournisseurFaux(), file: fileTachesPostgres(db, 0), maintenant: () => maintenant, diffuser: () => {} };
  await chargerSeed(ctx);
  // chargerSeed met chaque feedback en file : ces tâches ne doivent jamais être traitées ici.
  await db.query("DELETE FROM taches");

  // La tentative d'injection (M7) : la chaîne l'aurait mise en quarantaine.
  const injection = d.verite.motifs.find((m) => m.id === "M7")?.feedbackIds ?? [];
  for (const id of injection) await db.query("UPDATE feedbacks SET statut = 'suspect' WHERE id = $1", [id]);

  let n = 0;
  for (const [feedbackId, itemId] of d.attendus) {
    if (!itemId || !d.idsBacklog.has(itemId)) continue;
    const f = d.textes.get(feedbackId);
    if (!f) continue;
    n += 1;
    // Les feedbacks du direct ne sont pas dans le jeu chargé : le SELECT ne renvoie alors rien.
    const extrait = extraitRepresentatif(f.texte);
    await db.query(
      `INSERT INTO preuves (id, item_id, feedback_id, compte_id, canal, recu_le, citation, sure)
       SELECT $1, $2, f.id, f.compte_id, f.canal, f.recu_le, $3, TRUE FROM feedbacks f WHERE f.id = $4
       ON CONFLICT DO NOTHING`,
      [`PT${String(n).padStart(3, "0")}`, itemId, extrait, feedbackId],
    );
    // Une extraction de montage, comme la chaîne en aurait écrit : sans elle, la recherche de la conversation
    // (qui ne renvoie que les demandes extraites, jamais le texte brut) répondrait « pas encore lu par l'agent ».
    await db.query(
      `INSERT INTO extractions (feedback_id, nature, injection_suspectee, menace_depart, demandes)
       SELECT f.id, 'demande', FALSE, FALSE, $2 FROM feedbacks f WHERE f.id = $1
       ON CONFLICT DO NOTHING`,
      [feedbackId, JSON.stringify([{ resume: extrait, citation: extrait, regression: false }])],
    );
  }
  for (const item of d.items) {
    await db.query(
      "INSERT INTO jugements_impact (item_id, tirages, mediane, ecart_crans, justification, citations) VALUES ($1, '[1]', 1, 0, 'Valeur de montage du banc des prompts', '[]')",
      [item.id],
    );
  }
  for (const item of d.items) await rescorer(ctx, item.id);
  await db.query("DELETE FROM taches");
  return ctx;
}

/** Empreinte de l'état métier : elle ne doit pas bouger pendant une conversation. */
export async function empreinteEtat(ctx: Contexte): Promise<string> {
  const r = await ctx.db.query<Record<string, unknown>>(
    `SELECT
       (SELECT COUNT(*)::int FROM propositions) AS propositions,
       (SELECT COUNT(*)::int FROM regles) AS regles,
       (SELECT COUNT(*)::int FROM preuves) AS preuves,
       (SELECT COUNT(*)::int FROM questions) AS questions,
       (SELECT COUNT(*)::int FROM reponses) AS reponses,
       (SELECT COUNT(*)::int FROM stories) AS stories,
       (SELECT COUNT(*)::int FROM taches) AS taches,
       (SELECT string_agg(id || ':' || statut || ':' || complexite, ',' ORDER BY id) FROM items) AS items`,
  );
  return JSON.stringify(r.rows[0]);
}
