import { z } from "zod";
import { citationsInventees, ECHELLE_IMPACT, PARAMETRES, type Filtre } from "@po-agent/domain";
import { journaliser } from "@po-agent/db";
import { encadrerDonnee, type MessageConversation, type OutilConversation, type ReponseConversation } from "@po-agent/llm";
import type { Contexte } from "./contexte.ts";
import { classement } from "./chaine.ts";
import { numeroterRangs, simulerChangement, type Simulation } from "./ordre.ts";
import { chargerComptes, chargerItem, chargerItems, chargerPreuves, chargerRegles } from "./depot.ts";

/**
 * Agent conversationnel : il répond aux questions libres du PO avec des outils en lecture seule et une simulation.
 * Il n'a aucun outil d'écriture : il explique et simule, le PO décide ailleurs.
 */

const FILTRES = z
  .array(z.enum(["mrr", "objectif"]))
  .optional()
  .describe("Filtres de lecture : mrr (Reach en k€ de MRR), objectif (bonus objectif du trimestre). Sans ce champ : la vue que le PO a sous les yeux. Une liste vide : la vue sans filtre.");
const nb = (n: number, d = 1) => n.toLocaleString("fr-FR", { maximumFractionDigits: d });

/** Vue de référence de l'agent : celle des alertes, des stories et de l'ordre proposé. */
export const VUE_CONVERSATION_DEFAUT = PARAMETRES.alertes.vueReference as unknown as Filtre[];

/** « vue pondérée par le MRR », « vue sans filtre »… : chaque sortie d'outil dit sur quelle vue elle porte. */
function libelleVue(filtres: readonly Filtre[]): string {
  if (filtres.length === 0) return "vue sans filtre";
  const parties = [filtres.includes("mrr") ? "pondérée par le MRR" : null, filtres.includes("objectif") ? "avec le bonus objectif du trimestre" : null].filter(Boolean);
  return `vue ${parties.join(", ")}`;
}

/**
 * Les outils lisent par défaut la vue que le PO a sous les yeux (`vue`). Sans cela, l'agent répondait sur la vue
 * sans filtre pendant que le cockpit affichait la vue MRR, et contredisait l'écran.
 */
export function outilsConversation(ctx: Contexte, vue: readonly Filtre[] = VUE_CONVERSATION_DEFAUT): OutilConversation[] {
  const vueParDefaut = [...vue];
  return [
    {
      nom: "classement",
      description: "Classement actuel du backlog vivant, avec le détail RICE de chaque élément.",
      schema: z.object({ filtres: FILTRES, limite: z.number().int().min(1).max(20).optional() }),
      executer: async (e) => {
        const { filtres = vueParDefaut, limite = 10 } = e as { filtres?: Filtre[]; limite?: number };
        const items = await chargerItems(ctx.db);
        const titres = new Map(items.map((i) => [i.id, i.titre]));
        const classes = (await classement(ctx, filtres)).filter((s) => titres.has(s.itemId));
        // Mêmes rangs que le cockpit : seuls les éléments du backlog sont numérotés ; un candidat dit où il se placerait.
        const rangs = numeroterRangs(classes.map((s) => s.itemId), new Map(items.map((i) => [i.id, i.statut])));
        const lignes = classes.slice(0, limite);
        const corps = lignes
          .map((s) => {
            const r = rangs.get(s.itemId);
            const tete = r?.candidat ? `(candidat, se placerait au rang ${r.rang})` : `${r?.rang ?? "?"}.`;
            return `${tete} ${s.itemId} « ${titres.get(s.itemId)} » : score ${nb(s.score)} (Reach ${nb(s.reach)} ${s.uniteReach === "kEUR" ? "k€" : "comptes"}, Impact ${nb(s.impact, 2)}, Confidence ${Math.round(s.confidence * 100)} %, Effort ${nb(s.effort, 2)})`;
          })
          .join("\n");
        return corps ? `Classement, ${libelleVue(filtres)} :\n${corps}` : "Backlog vide.";
      },
    },
    {
      nom: "detail_item",
      description: "Détail d'un élément : calcul RICE, répartition par segment, verbatims cités, jugements d'Impact, règles appliquées.",
      schema: z.object({ item_id: z.string(), filtres: FILTRES }),
      executer: async (e) => {
        const { item_id, filtres = vueParDefaut } = e as { item_id: string; filtres?: Filtre[] };
        const item = await chargerItem(ctx.db, item_id);
        if (!item) return `Élément inconnu : ${item_id}.`;
        const tous = await chargerItems(ctx.db);
        const classes = (await classement(ctx, filtres)).filter((x) => tous.some((i) => i.id === x.itemId));
        const r = numeroterRangs(classes.map((x) => x.itemId), new Map(tous.map((i) => [i.id, i.statut]))).get(item_id);
        const rang = r && !r.candidat ? r.rang : 0;
        const s = classes.find((x) => x.itemId === item_id);
        const preuves = (await chargerPreuves(ctx.db, item_id)).filter((p) => p.sure);
        const comptes = await chargerComptes(ctx.db);
        const j = (await ctx.db.query<{ tirages: number[]; justification: string }>("SELECT tirages, justification FROM jugements_impact WHERE item_id = $1", [item_id])).rows[0];
        const lignes = [
          `${item.id} « ${item.titre} » (${item.type}, complexité ${item.complexite}${item.alignementObjectif ? ", aligné sur l'objectif" : ""}).`,
          s ? `Score dans la ${libelleVue(filtres)} : ${nb(s.score)}${rang > 0 ? `, rang ${rang}` : ""}. Calcul : Reach ${nb(s.reach)} × Impact ${s.impact} × Confidence ${s.confidence} ÷ Effort ${s.effort}${s.multiplicateurs.map((m) => ` × ${m.valeur} (${m.raison})`).join("")}.` : "Pas encore de score.",
          s ? `Segments : Free ${s.parSegment.free.comptes} compte(s)/${s.parSegment.free.messages} message(s), Pro ${s.parSegment.pro.comptes}/${s.parSegment.pro.messages}, Business ${s.parSegment.business.comptes}/${s.parSegment.business.messages}.` : "",
          j ? `Impact : tirages ${j.tirages.join(", ")} ; justification : ${j.justification}` : "",
          `Verbatims (${preuves.length}) :`,
          ...preuves.slice(-5).map((p) => `- ${comptes.get(p.compteId)?.nom ?? p.compteId} (${comptes.get(p.compteId)?.plan}) ${encadrerDonnee("verbatim", p.citation)}${p.regleId ? ` [règle ${p.regleId}]` : ""}`),
        ];
        return lignes.filter(Boolean).join("\n");
      },
    },
    {
      nom: "simuler",
      description: "Simulation « et si » : recalcule le score et le rang d'un élément avec un autre Impact ou une autre complexité, sans rien modifier.",
      schema: z.object({
        item_id: z.string(),
        impact: z.enum(["0.25", "0.5", "1", "2", "3"]).optional(),
        complexite: z.enum(["S", "M", "L", "XL"]).optional(),
        filtres: FILTRES,
      }),
      executer: async (e) => {
        const { item_id, impact, complexite, filtres = vueParDefaut } = e as { item_id: string; impact?: string; complexite?: "S" | "M" | "L" | "XL"; filtres?: Filtre[] };
        if (impact && !ECHELLE_IMPACT.includes(Number(impact) as (typeof ECHELLE_IMPACT)[number])) return "Impact hors échelle.";
        const sim = await simulerChangement(ctx, item_id, { ...(impact ? { impact: Number(impact) } : {}), ...(complexite ? { complexite } : {}) }, filtres);
        if (!sim) return `Élément inconnu : ${item_id}.`;
        const rang = (r: Simulation["rangAvant"]) => (r ? (r.candidat ? `candidat, se placerait au rang ${r.rang}` : `rang ${r.rang}`) : "rang -");
        return `Simulation (rien n'est modifié, ${libelleVue(filtres)}) : ${item_id} passerait d'un score ${nb(sim.scoreAvant)} (${rang(sim.rangAvant)}) à ${nb(sim.scoreApres)} (${rang(sim.rangApres)}).`;
      },
    },
    {
      nom: "chercher_feedbacks",
      description: "Recherche des feedbacks clients contenant un mot ou une expression. Renvoie ce que l'agent en a lu : demandes résumées et citations vérifiées.",
      schema: z.object({ mots: z.string().min(2), limite: z.number().int().min(1).max(15).optional() }),
      executer: async (e) => {
        const { mots, limite = 8 } = e as { mots: string; limite?: number };
        // Invariant (CLAUDE.md) : seul l'appel d'extraction, sans outils, lit le texte brut. La recherche se fait
        // par le code ; l'agent conversationnel, qui a des outils, ne reçoit que les demandes extraites et leurs citations.
        const r = await ctx.db.query<{ id: string; nom: string; plan: string; nature: string | null; menace_depart: boolean | null; demandes: Array<{ resume: string; citation: string }> | null }>(
          `SELECT f.id, c.nom, c.plan, e.nature, e.menace_depart, e.demandes
           FROM feedbacks f JOIN comptes c ON c.id = f.compte_id LEFT JOIN extractions e ON e.feedback_id = f.id
           WHERE f.texte ILIKE $1 AND f.statut <> 'suspect' ORDER BY f.recu_le DESC LIMIT $2`,
          [`%${mots}%`, limite],
        );
        return (
          r.rows
            .map((f) => {
              const demandes = (f.demandes ?? []).map((d) => `  · ${d.resume} ${encadrerDonnee("citation", d.citation)}`).join("\n");
              const entete = `- ${f.id} · ${f.nom} (${f.plan}) · ${f.nature ?? "pas encore lu par l'agent"}${f.menace_depart ? " · menace de partir" : ""}`;
              return demandes ? `${entete}\n${demandes}` : entete;
            })
            .join("\n") || "Aucun feedback trouvé."
        );
      },
    },
    {
      nom: "doctrine",
      description: "Règles de doctrine actives (décisions du PO devenues règles).",
      schema: z.object({}),
      executer: async () => {
        const regles = (await chargerRegles(ctx.db)).filter((r) => r.statut === "active");
        return regles.map((r) => `- ${r.id} (v${r.version}) : ${r.texte}`).join("\n") || "Aucune règle active.";
      },
    },
  ];
}

/** Avertissement ajouté par le code sous une réponse qui cite un passage introuvable dans les données consultées. */
export function avertissementCitations(passages: string[]): string {
  const liste = passages.map((p) => `« ${p} »`).join(" ; ");
  return passages.length === 1
    ? `Vérification du code : ce passage entre guillemets ne figure mot pour mot dans aucune des données consultées. Ne le reprenez pas comme verbatim : ${liste}.`
    : `Vérification du code : ces passages entre guillemets ne figurent mot pour mot dans aucune des données consultées. Ne les reprenez pas comme verbatims : ${liste}.`;
}

export async function converser(
  ctx: Contexte,
  message: string,
  historique: MessageConversation[] = [],
  vue: readonly Filtre[] = VUE_CONVERSATION_DEFAUT,
): Promise<ReponseConversation> {
  const recent = historique.slice(-10);
  // Ce que les outils ont rendu pendant cet échange : avec la question et l'historique, ce sont les seules sources
  // qu'une citation de la réponse peut reprendre.
  const sorties: string[] = [];
  const outils = outilsConversation(ctx, vue).map((o) => ({
    ...o,
    executer: async (entree: unknown) => {
      const sortie = await o.executer(entree);
      sorties.push(sortie);
      return sortie;
    },
  }));
  const reponse = await ctx.llm.converser({ message, historique: recent, outils });
  // Invariant (CLAUDE.md) : chaque citation est vérifiée mot pour mot. Le banc a vu les trois modèles citer au moins une fois
  // un passage inexact : la réponse reste affichée, mais le code signale chaque passage qu'il ne retrouve pas.
  const nonVerifiees = citationsInventees(reponse.texte, [message, ...recent.map((m) => m.texte), ...sorties].join("\n"));
  await journaliser(ctx.db, { horodatage: ctx.maintenant(),
    acteur: "po",
    action: "question_libre",
    details: {
      question: message.slice(0, 300),
      outils: reponse.appels.map((a) => a.outil),
      vue: [...vue],
      ...(nonVerifiees.length > 0 ? { citationsNonVerifiees: nonVerifiees.map((p) => p.slice(0, 200)) } : {}),
    },
  });
  if (nonVerifiees.length === 0) return reponse;
  return { ...reponse, texte: `${reponse.texte}\n\n${avertissementCitations(nonVerifiees)}` };
}
