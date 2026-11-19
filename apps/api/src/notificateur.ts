import type { EventEmitter } from "node:events";
import { converser, deciderRegle, ingerer, prochainId, repondre, type Contexte, type Evenement } from "@po-agent/agent";
import { chargerItemsContexte, enrichirQuestion, texteQuestionTelegram, type LigneQuestionBrute } from "./contexte-decision.ts";
import { botSupport, canalTelegram, expliquerErreurTelegram, journalConsole, type CanalPO, type Journal } from "./telegram.ts";

/**
 * Relie les canaux de messagerie (optionnels) à l'agent :
 * - les questions posées et les alertes urgentes partent vers le PO ;
 * - ses clics deviennent des réponses (canal « telegram »), ses messages libres passent à l'agent conversationnel ;
 * - le bot « support » de la démo ingère les messages des clients comme feedbacks « direct ».
 * Une seule instance de réception par bot : ce module tourne dans le processus de l'API.
 */
export function brancherCanal(ctx: Contexte, emetteur: EventEmitter, canal: CanalPO, journal: Journal = journalConsole): void {
  const envoyerQuestionsEnAttente = async () => {
    const r = await ctx.db.query<LigneQuestionBrute>(
      `SELECT * FROM questions
       WHERE etat IN ('ouverte', 'relancee') AND posee_le IS NOT NULL AND (envoyee_le IS NULL OR envoyee_le < posee_le)
       ORDER BY urgente DESC, enjeu DESC, posee_le`,
    );
    const items = await chargerItemsContexte(ctx);
    for (const ligne of r.rows) {
      // Un message autonome : sur un téléphone, il n'y a pas d'autre écran pour compléter.
      const q = await enrichirQuestion(ctx, ligne, items);
      await canal.envoyerQuestion({ id: q.id, enonce: q.enonce, options: q.options, urgente: q.urgente, contexte: texteQuestionTelegram(q) });
      // Même horloge que posee_le (celle du scénario) : sinon une question relancée ne repartirait jamais.
      await ctx.db.query("UPDATE questions SET envoyee_le = $2 WHERE id = $1", [q.id, ctx.maintenant().toISOString()]);
    }
  };

  emetteur.on("evenement", (e: Evenement) => {
    const donnees = (e.donnees ?? {}) as Record<string, unknown>;
    const tache = (async () => {
      if (e.type === "question" && donnees.etat !== "repondue") await envoyerQuestionsEnAttente();
      if (e.type === "alerte" && (donnees.urgente === true || donnees.type === "resume")) {
        await canal.envoyerMessage(String(donnees.message ?? ""));
        if (donnees.type === "resume") await envoyerQuestionsEnAttente();
      }
    })();
    // Un envoi raté ne casse rien (la boîte du cockpit reste la référence), mais il doit se voir dans le terminal.
    tache.catch((err) => journal(`Canal ${canal.nom} : envoi au PO impossible. ${expliquerErreurTelegram(err)}`));
  });
}

export function demarrerTelegram(ctx: Contexte, emetteur: EventEmitter, env = process.env): { arreter: () => void } | null {
  const arrets: Array<() => void> = [];

  if (env.TELEGRAM_PO_BOT_TOKEN) {
    const canal = canalTelegram({
      jeton: env.TELEGRAM_PO_BOT_TOKEN,
      autorises: (env.TELEGRAM_ALLOWED_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      surReponse: async (questionId, index) => {
        const ligne = (await ctx.db.query<LigneQuestionBrute>("SELECT * FROM questions WHERE id = $1", [questionId])).rows[0];
        if (!ligne) throw new Error("question inconnue");
        // L'effet est calculé avant de répondre : la confirmation dit ce que le clic a déclenché.
        const option = (await enrichirQuestion(ctx, ligne, await chargerItemsContexte(ctx))).options[index];
        if (!option) throw new Error("option inconnue");
        const r = await repondre(ctx, questionId, option.valeur, "telegram");
        if (r.regleProposee) {
          const contenu = r.regleProposee.contenu;
          await canal.envoyerRegle({ id: r.regleProposee.id, texte: r.regleProposee.texte, motsCles: contenu.type === "rattachement" ? contenu.motsCles : [] });
        }
        const suite = r.reglePrevue ? " L'agent formulera la règle dans un instant : elle arrivera dans l'onglet Doctrine du cockpit." : "";
        return `Noté : « ${option.libelle} ». ${option.effet}${suite}`;
      },
      surDecisionRegle: async (regleId, accepter) => {
        const r = await deciderRegle(ctx, regleId, accepter);
        if (r.contradictions.length > 0) return `Règle non activée : ${r.contradictions.join(" ; ")}`;
        return r.statut === "active" ? `Règle ${regleId} validée : l'agent l'appliquera et la citera.` : `Règle ${regleId} rejetée.`;
      },
      surMessage: async (texte) => (await converser(ctx, texte)).texte,
    });
    brancherCanal(ctx, emetteur, canal);
    canal.demarrer();
    arrets.push(() => canal.arreter());
  }

  if (env.TELEGRAM_SUPPORT_BOT_TOKEN) {
    const support = botSupport({
      jeton: env.TELEGRAM_SUPPORT_BOT_TOKEN,
      surFeedback: async (texte) => {
        const id = await prochainId(ctx.db, "T", "feedbacks");
        // Le compte au nom duquel écrit le « client » de la démo (par défaut, celui de l'escalade).
        await ingerer(ctx, { id, compteId: env.TELEGRAM_SUPPORT_COMPTE_ID ?? "C237", canal: "direct", recuLe: ctx.maintenant().toISOString(), texte });
      },
    });
    support.demarrer();
    arrets.push(() => support.arreter());
  }

  return arrets.length > 0 ? { arreter: () => arrets.forEach((a) => a()) } : null;
}
