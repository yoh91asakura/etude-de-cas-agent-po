import { PARAMETRES } from "@po-agent/domain";
import { heureLocale } from "./horloge.ts";
import { EchecLLM } from "@po-agent/llm";
import type { Contexte } from "./contexte.ts";
import { poserQuestions, rescorer, traiterFeedback } from "./chaine.ts";
import { passageDeFond } from "./fond.ts";
import { decouperStory, planifierStories, redigerStory } from "./stories.ts";
import { proposerOrdre } from "./ordre.ts";
import { formulerRegleDeReponse } from "./decisions.ts";
import { journaliser } from "@po-agent/db";

export const TYPES_TACHES = ["traiter_feedback", "rescorer", "rediger_story", "proposer_ordre", "resume", "formuler_regle", "decouper_story"] as const;

/** Exécute une tâche. Renvoie false si la file est vide. */
export async function executerUneTache(ctx: Contexte): Promise<boolean> {
  const t = await ctx.file.prendre([...TYPES_TACHES]);
  if (!t) return false;
  try {
    switch (t.type) {
      case "traiter_feedback":
        await traiterFeedback(ctx, String(t.charge.feedbackId));
        break;
      case "rescorer":
        await rescorer(ctx, String(t.charge.itemId));
        await planifierStories(ctx);
        await ctx.file.ajouter("proposer_ordre", {}, { cle: "ordre" });
        break;
      case "proposer_ordre":
        await proposerOrdre(ctx);
        break;
      case "rediger_story":
        await redigerStory(ctx, String(t.charge.itemId));
        break;
      case "resume":
        await passageDeFond(ctx);
        break;
      case "decouper_story":
        await decouperStory(ctx, String(t.charge.storyId));
        break;
      case "formuler_regle":
        // Reprise d'une formulation de règle qui a échoué pendant la réponse du PO. Un refus du modèle est consigné, sans boucle.
        try {
          await formulerRegleDeReponse(ctx, String(t.charge.reponseId));
        } catch (e) {
          if (!(e instanceof EchecLLM) || e.motif === "erreur") throw e;
          await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "systeme", action: "formulation_regle_echouee", cible: String(t.charge.reponseId), details: { motif: e.motif } });
        }
        break;
    }
    await ctx.file.terminer(t.id);
  } catch (e) {
    const message = e instanceof EchecLLM ? `${e.etape} (${e.motif}) : ${e.message}` : e instanceof Error ? e.message : String(e);
    await ctx.file.echouer(t.id, message);
  }
  return true;
}

/** Vide la file (utile pour le préchargement de la démo et pour les tests). */
export async function viderFile(ctx: Contexte, limite = 10_000): Promise<number> {
  let n = 0;
  while (n < limite && (await executerUneTache(ctx))) n += 1;
  // Fin du lot : les questions non urgentes sont posées maintenant, par ordre d'enjeu, dans la limite du jour.
  if (n > 0) await poserQuestions(ctx);
  return n;
}

/**
 * Agent de fond : un passage à chaque heure prévue (PARAMETRES.agentDeFond.heures, heure locale du PO),
 * une seule fois par créneau. Le passage relance les questions, fait la revue (fusions, règles généralisées),
 * remet en file les feedbacks restés en attente, et écrit le résumé (voir fond.ts).
 */
export async function planifierAgentDeFond(ctx: Contexte): Promise<string | null> {
  const { jour, heure } = heureLocale(ctx.maintenant());
  if (!(PARAMETRES.agentDeFond.heures as readonly number[]).includes(heure)) return null;
  const creneau = `${jour}T${String(heure).padStart(2, "0")}`;
  const deja = await ctx.db.query("SELECT 1 FROM taches WHERE type = 'resume' AND charge->>'creneau' = $1", [creneau]);
  if (deja.rows.length > 0) return null;
  await ctx.file.ajouter("resume", { creneau });
  return creneau;
}

/** Boucle du worker : prend les tâches dès qu'elles arrivent, et planifie l'agent de fond. */
export function demarrerWorker(ctx: Contexte, intervalleMs = 500): { arreter: () => void } {
  let actif = true;
  let derniereVerification = 0;
  let lotEnCours = false;
  const boucle = async () => {
    while (actif) {
      if (Date.now() - derniereVerification > 60_000) {
        derniereVerification = Date.now();
        await planifierAgentDeFond(ctx).catch(() => null);
      }
      const travail = await executerUneTache(ctx).catch(() => false);
      if (travail) lotEnCours = true;
      else {
        // File vide après un lot : on pose les questions en attente, triées par enjeu.
        if (lotEnCours) {
          lotEnCours = false;
          await poserQuestions(ctx).catch(() => []);
        }
        await new Promise((r) => setTimeout(r, intervalleMs));
      }
    }
  };
  void boucle();
  return { arreter: () => (actif = false) };
}
