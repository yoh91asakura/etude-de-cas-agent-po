/**
 * Contexte des décisions du PO : tout ce qu'il faut voir pour trancher sans ouvrir un autre écran.
 * Construit en un seul endroit, pour le cockpit et pour Telegram : les deux montrent la même chose.
 * Audit d'usage (session 4) : une question qui n'affiche qu'un extrait (« Vous pourriez l'ajouter ? ») fait décider à l'aveugle.
 */
import { apercuRegle, ordreOfficiel, simulerChangement, type Contexte } from "@po-agent/agent";
import { ANCRES_IMPACT, couperTitre, decrireRang, type Complexite, type ValeurImpact } from "@po-agent/domain";
import type { CompteApi, DetailsPropositionApi, FicheFeedbackApi, OptionQuestionApi, Plan, PropositionApi, QuestionApi } from "./contrat.ts";

const iso = (v: unknown): string => new Date(String(v)).toISOString();
const texte = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
/** 0,25 ; 21,9 : à la française, puisque le texte part aussi sur Telegram. */
const decimales = (n: number): string => n.toLocaleString("fr-FR", { maximumFractionDigits: 2 });


export interface ItemContexte {
  id: string;
  titre: string;
  description: string | null;
  preuvesSures: number;
}

/** Les items et leur nombre de preuves sûres, chargés une fois par requête. */
export async function chargerItemsContexte(ctx: Contexte): Promise<Map<string, ItemContexte>> {
  const r = await ctx.db.query<{ id: string; titre: string; description: string | null; sures: number }>(
    "SELECT i.id, i.titre, i.description, (SELECT COUNT(*)::int FROM preuves p WHERE p.item_id = i.id AND p.sure) AS sures FROM items i",
  );
  return new Map(r.rows.map((i) => [i.id, { id: i.id, titre: i.titre, description: i.description, preuvesSures: i.sures }]));
}

/** Le message complet d'un client, et ce que l'agent en a fait. */
export async function ficheFeedback(ctx: Contexte, id: string): Promise<FicheFeedbackApi | null> {
  const r = await ctx.db.query<{
    id: string;
    texte: string;
    canal: FicheFeedbackApi["canal"];
    recu_le: unknown;
    statut: FicheFeedbackApi["statut"];
    compte_id: string;
    nom: string;
    plan: Plan;
    mrr: number;
    risque_depart: boolean;
    nature: string | null;
    menace_depart: boolean | null;
    demandes: Array<{ resume: string; citation: string; regression?: boolean }> | null;
  }>(
    `SELECT f.id, f.texte, f.canal, f.recu_le, f.statut, f.compte_id, c.nom, c.plan, c.mrr, c.risque_depart, e.nature, e.menace_depart, e.demandes
     FROM feedbacks f JOIN comptes c ON c.id = f.compte_id LEFT JOIN extractions e ON e.feedback_id = f.id WHERE f.id = $1`,
    [id],
  );
  const f = r.rows[0];
  if (!f) return null;
  const preuves = await ctx.db.query<{ item_id: string; titre: string; sure: boolean; regle_id: string | null }>(
    "SELECT p.item_id, i.titre, p.sure, p.regle_id FROM preuves p JOIN items i ON i.id = p.item_id WHERE p.feedback_id = $1 ORDER BY p.sure DESC, p.item_id",
    [id],
  );
  return {
    id: f.id,
    texte: f.texte,
    canal: f.canal,
    recuLe: iso(f.recu_le),
    statut: f.statut,
    compte: { id: f.compte_id, nom: f.nom, plan: f.plan, mrr: Number(f.mrr), risqueDepart: f.risque_depart },
    nature: f.nature,
    menaceDepart: f.menace_depart ?? false,
    demandes: (f.demandes ?? []).map((d) => ({ resume: d.resume, citation: d.citation, regression: d.regression === true })),
    rattachements: preuves.rows.map((p) => ({ itemId: p.item_id, titre: p.titre, sure: p.sure, regleId: p.regle_id })),
  };
}

export interface LigneQuestionBrute {
  id: string;
  type: QuestionApi["type"];
  enonce: string;
  options: Array<{ valeur: string; libelle: string }>;
  contexte: Record<string, unknown>;
  urgente: boolean;
  etat: QuestionApi["etat"];
  posee_le: unknown;
  enjeu: number | string | null;
}

/** Une question, avec le message, les items en jeu, les lectures de l'agent et l'effet de chaque réponse. */
export async function enrichirQuestion(ctx: Contexte, q: LigneQuestionBrute, items: Map<string, ItemContexte>): Promise<QuestionApi> {
  const c = q.contexte ?? {};
  const titre = (id: string | null | undefined) => (id ? (items.get(id)?.titre ?? id) : null);
  const base = {
    id: q.id,
    type: q.type,
    enonce: q.enonce,
    contexte: c,
    urgente: q.urgente,
    etat: q.etat,
    poseeLe: q.posee_le ? iso(q.posee_le) : null,
    enjeu: Number(q.enjeu ?? 0),
  };
  const enJeu = (ids: Array<string | null | undefined>) => ids.flatMap((id) => (id && items.has(id) ? [items.get(id)!] : []));

  if (q.type === "fusion") {
    const a = texte(c.itemA);
    const b = texte(c.itemB);
    const nb = b ? (items.get(b)?.preuvesSures ?? 0) : 0;
    const options: OptionQuestionApi[] = q.options.map((o) => ({
      ...o,
      effet:
        o.valeur === "oui"
          ? `« ${titre(b)} » est absorbé par « ${titre(a)} » : ${nb} preuve(s) passent sur « ${titre(a)} ». La fusion se défait depuis le détail de l'item.`
          : "Les deux éléments restent distincts. L'agent vous proposera une règle pour ne plus poser cette question.",
    }));
    return { ...base, options, feedback: null, items: enJeu([a, b]), lectures: null, explication: texte(c.explication), verbatims: [] };
  }

  if (q.type === "impact") {
    const itemId = texte(c.itemId);
    const nomItem = titre(itemId) ?? "cet élément";
    // Ce que chaque réponse ferait au classement (audit du 15/11/2026) : sans cela, le PO ne voyait pas
    // qu'aucune réponse ne change le haut du backlog.
    const options: OptionQuestionApi[] = await Promise.all(
      q.options.map(async (o) => {
        const ancre = ANCRES_IMPACT[Number(o.valeur) as ValeurImpact];
        const sim = itemId ? await simulerChangement(ctx, itemId, { impact: Number(o.valeur) }) : null;
        const consequence = sim?.rangApres ? `Avec ${decimales(Number(o.valeur))} : ${decrireRang(sim.rangApres)}, score ${decimales(sim.scoreApres)} (vue MRR).` : "";
        return { ...o, effet: [ancre, consequence, `Votre choix remplace l'estimation de l'agent pour « ${nomItem} ».`].filter(Boolean).join(" ") };
      }),
    );
    const justifications = Array.isArray(c.justifications) ? c.justifications.filter((x): x is string => typeof x === "string") : [];
    const jugement = itemId ? (await ctx.db.query<{ justification: string }>("SELECT justification FROM jugements_impact WHERE item_id = $1", [itemId])).rows[0] : undefined;
    const verbatims = itemId
      ? (await ctx.db.query<{ citation: string }>("SELECT citation FROM preuves WHERE item_id = $1 AND sure ORDER BY recu_le DESC LIMIT 3", [itemId])).rows.map((p) => p.citation)
      : [];
    return { ...base, options, feedback: null, items: enJeu([itemId]), lectures: null, explication: justifications[0] ?? jugement?.justification ?? null, verbatims };
  }

  // Rattachement (et requalification) : le message d'origine et les lectures de l'agent.
  const feedbackId = texte(c.feedbackId);
  const resume = texte(c.resume) ?? texte(c.citation) ?? "cette demande";
  const options: OptionQuestionApi[] = q.options.map((o) => {
    if (o.valeur === "nouvel_item") return { ...o, effet: `Crée un nouvel élément du backlog, « ${couperTitre(resume, 70)} », avec cette demande comme première preuve.` };
    if (o.valeur === "ignorer") return { ...o, effet: "Retire cette demande : elle ne comptera dans aucun score." };
    return { ...o, effet: `Compte cette demande dans le score de « ${titre(o.valeur)} ». L'agent vous proposera ensuite une règle pour les demandes semblables.` };
  });
  const verdicts = Array.isArray(c.verdicts) ? (c.verdicts as Array<{ itemId?: unknown; verdict?: unknown; justification?: unknown }>) : null;
  const lectures = verdicts
    ? verdicts.map((v) => ({ itemId: texte(v.itemId), titre: titre(texte(v.itemId)), verdict: String(v.verdict ?? "incertain"), justification: String(v.justification ?? "") }))
    : null;
  return {
    ...base,
    options,
    feedback: feedbackId ? await ficheFeedback(ctx, feedbackId) : null,
    items: enJeu(q.options.map((o) => o.valeur)),
    lectures,
    explication: null,
    verbatims: [],
  };
}

const LIBELLE_VERDICT: Record<string, string> = { meme_besoin: "même besoin", different: "aucun élément ne correspond", incertain: "hésite" };

/** « 2 lectures sur 3 : Mode sombre ; 1 : hésite » */
export function resumerLectures(lectures: NonNullable<QuestionApi["lectures"]>): string {
  const groupes = new Map<string, number>();
  for (const l of lectures) {
    const cle = l.verdict === "meme_besoin" && l.titre ? `« ${l.titre} »` : (LIBELLE_VERDICT[l.verdict] ?? l.verdict);
    groupes.set(cle, (groupes.get(cle) ?? 0) + 1);
  }
  return [...groupes.entries()].map(([cle, n]) => `${n} sur ${lectures.length} : ${cle}`).join(" ; ");
}

const LIBELLE_PLAN: Record<Plan, string> = { free: "Free", pro: "Pro", business: "Business" };
const LIBELLE_CANAL: Record<string, string> = { email: "email", ticket: "ticket", commentaire: "commentaire", direct: "message direct" };

export function decrireCompte(c: CompteApi): string {
  return `${c.nom} · ${LIBELLE_PLAN[c.plan]} · ${c.mrr.toLocaleString("fr-FR")} €/mois${c.risqueDepart ? " · risque de départ" : ""}`;
}

/** Le texte d'une question pour un message Telegram : autonome, puisqu'il n'y a pas d'autre écran sur un téléphone. */
export function texteQuestionTelegram(q: QuestionApi): string {
  const lignes: string[] = [];
  if (q.feedback) {
    const f = q.feedback;
    lignes.push(`${decrireCompte(f.compte)} · ${LIBELLE_CANAL[f.canal] ?? f.canal}`);
    lignes.push(`« ${couperTitre(f.texte, 600)} »`);
    if (texte(q.contexte.resume)) lignes.push(`L'agent a compris : ${String(q.contexte.resume)}`);
  }
  if (q.lectures && q.lectures.length > 0) lignes.push(`Pourquoi je demande : mes lectures divergent (${resumerLectures(q.lectures)}).`);
  if (q.explication) lignes.push(`${q.type === "fusion" ? "Pourquoi fusionner" : "Justification de l'agent"} : ${q.explication}`);
  if (q.items.length > 0 && q.type !== "rattachement") lignes.push(...q.items.map((i) => `• ${i.titre} (${i.preuvesSures} preuve(s))`));
  if (q.verbatims.length > 0) lignes.push(...q.verbatims.slice(0, 2).map((v) => `« ${couperTitre(v, 200)} »`));
  lignes.push("", ...q.options.map((o) => `• ${o.libelle} : ${o.effet}`));
  return lignes.join("\n");
}

const LIBELLE_CRITERE: Record<string, string> = {
  independante: "indépendante",
  valeur: "valeur explicite",
  estimable: "estimable",
  petite: "assez petite pour un sprint",
  testable: "testable",
  un_seul_besoin: "un seul besoin",
};

export interface LignePropositionBrute {
  id: string;
  type: string;
  resume: string;
  charge: Record<string, unknown>;
  statut: PropositionApi["statut"];
  creee_le: unknown;
}

/** Une proposition, avec ce qu'il faut voir pour décider et ce qu'accepter déclenche. */
export async function enrichirProposition(ctx: Contexte, p: LignePropositionBrute, items: Map<string, ItemContexte>): Promise<PropositionApi> {
  const base = { id: p.id, type: p.type, resume: p.resume, charge: p.charge, statut: p.statut, creeeLe: iso(p.creee_le) };
  const ch = p.charge ?? {};
  const titre = (id: string | null) => (id ? (items.get(id)?.titre ?? id) : null);

  if (p.type === "nouvel_item") {
    const itemId = texte(ch.itemId);
    const it = itemId ? (await ctx.db.query<{ id: string; titre: string; type: string }>("SELECT id, titre, type FROM items WHERE id = $1", [itemId])).rows[0] : undefined;
    const sources = itemId
      ? (
          await ctx.db.query<{ feedback_id: string; citation: string; texte: string; compte_id: string; nom: string; plan: Plan; mrr: number; risque_depart: boolean; nature: string | null }>(
            `SELECT p.feedback_id, p.citation, f.texte, c.id AS compte_id, c.nom, c.plan, c.mrr, c.risque_depart, e.nature
             FROM preuves p JOIN feedbacks f ON f.id = p.feedback_id JOIN comptes c ON c.id = p.compte_id LEFT JOIN extractions e ON e.feedback_id = p.feedback_id
             WHERE p.item_id = $1 ORDER BY p.recu_le LIMIT 3`,
            [itemId],
          )
        ).rows
      : [];
    return {
      ...base,
      effet: "Accepter fait entrer cet élément au backlog. Refuser le clôt : ses preuves cessent de compter.",
      details: {
        type: "nouvel_item",
        item: { id: it?.id ?? itemId ?? "?", titre: it?.titre ?? p.resume, type: it?.type ?? "fonctionnalite" },
        sources: sources.map((s) => ({
          feedbackId: s.feedback_id,
          compte: { id: s.compte_id, nom: s.nom, plan: s.plan, mrr: Number(s.mrr), risqueDepart: s.risque_depart },
          nature: s.nature,
          citation: s.citation,
          texte: s.texte,
        })),
      },
    };
  }

  if (p.type === "regle") {
    const regleId = texte(ch.regleId);
    const r = regleId
      ? (await ctx.db.query<{ id: string; texte: string; contenu: { motsCles?: string[]; itemId?: string }; source_reponse_id: string }>("SELECT id, texte, contenu, source_reponse_id FROM regles WHERE id = $1 ORDER BY version DESC LIMIT 1", [regleId])).rows[0]
      : undefined;
    const origine = r
      ? (
          await ctx.db.query<{ enonce: string; contexte: Record<string, unknown>; choix: string }>(
            "SELECT q.enonce, q.contexte, rp.choix FROM reponses rp JOIN questions q ON q.id = rp.question_id WHERE rp.id = $1",
            [r.source_reponse_id],
          )
        ).rows[0]
      : undefined;
    const itemId = r?.contenu.itemId ?? null;
    // Le même aperçu que l'onglet Doctrine : accepter depuis la boîte ne se fait pas à l'aveugle.
    const a = regleId ? await apercuRegle(ctx, regleId) : null;
    const apercu = a
      ? { resume: a.resume, bloquante: a.bloquante, blocages: [...a.contradictions.map((c) => c.message), ...a.casCasses.map((c) => c.message)], proches: a.proches.map((p) => p.message) }
      : null;
    return {
      ...base,
      effet: `Valider active la règle : les demandes qui contiennent l'un de ses mots-clés seront rattachées à « ${titre(itemId) ?? "?"} » sans vous demander, et chaque décision la citera.`,
      details: {
        type: "regle",
        regle: { id: r?.id ?? regleId ?? "?", texte: r?.texte ?? p.resume, motsCles: r?.contenu.motsCles ?? [], itemId, itemTitre: titre(itemId) },
        origine: origine
          ? { question: origine.enonce, citation: texte(origine.contexte.citation), resume: texte(origine.contexte.resume), feedbackId: texte(origine.contexte.feedbackId), choix: titre(origine.choix) ?? origine.choix }
          : null,
        apercu,
      },
    };
  }

  if (p.type === "ordre_backlog") {
    const propose = Array.isArray(ch.ordre) ? (ch.ordre as string[]) : [];
    const officiel = await ordreOfficiel(ctx);
    const ids = [...new Set([...propose, ...officiel])];
    const mouvements = ids
      .map((id) => ({ itemId: id, titre: titre(id) ?? id, avant: officiel.includes(id) ? officiel.indexOf(id) + 1 : null, apres: propose.includes(id) ? propose.indexOf(id) + 1 : null }))
      .filter((m) => m.avant !== m.apres)
      .sort((a, b) => (a.apres ?? 999) - (b.apres ?? 999));
    const filtres = Array.isArray(ch.filtres) ? (ch.filtres as string[]) : [];
    return {
      ...base,
      effet: "Accepter remplace l'ordre officiel du backlog par celui-ci, en entier, y compris les reculs listés.",
      details: { type: "ordre_backlog", vue: filtres.includes("mrr") ? "pondérée par le MRR" : "sans filtre", mouvements },
    };
  }

  if (p.type === "story_prete" || p.type === "export_jira") {
    const storyId = texte(ch.storyId);
    const s = storyId
      ? (await ctx.db.query<{ id: string; item_id: string; controles: Array<{ ok: boolean }>; jugement: Record<string, boolean | string> | null }>("SELECT id, item_id, controles, jugement FROM stories WHERE id = $1", [storyId])).rows[0]
      : undefined;
    const criteres = s?.jugement ? Object.entries(s.jugement).filter(([k]) => k !== "commentaire") : [];
    const story = {
      id: s?.id ?? storyId ?? "?",
      itemId: s?.item_id ?? "?",
      itemTitre: titre(s?.item_id ?? null) ?? "?",
      controlesOk: (s?.controles ?? []).filter((x) => x.ok).length,
      controlesTotal: (s?.controles ?? []).length,
      jugeOui: criteres.filter(([, v]) => v === true).length,
      jugeTotal: criteres.length,
      criteresNon: criteres.filter(([, v]) => v === false).map(([k]) => LIBELLE_CRITERE[k] ?? k),
      commentaire: typeof s?.jugement?.commentaire === "string" ? s.jugement.commentaire : null,
    };
    const effet =
      p.type === "export_jira"
        ? `Accepter crée le ticket dans ${ctx.suivi?.nom ?? "l'outil de suivi"}.`
        : `Accepter marque la story « prête ». ${ctx.suivi ? `L'export vers ${ctx.suivi.nom} vous sera ensuite proposé (seconde validation).` : "Jira n'est pas branché : la story restera « prête » dans le cockpit."}`;
    return { ...base, effet, details: { type: p.type, story } };
  }

  if (p.type === "decoupage") {
    // Le découpage d'une story : chaque story proposée, avec sa taille et le verdict du juge, pour trancher sans changer d'écran.
    const enfantsIds = Array.isArray(ch.enfants) ? (ch.enfants as unknown[]).map(String) : [];
    const lignes = (
      await ctx.db.query<{ id: string; contenu: { enTantQue?: string; jeVeux?: string; complexite?: string }; jugement: Record<string, boolean | string> | null }>(
        "SELECT id, contenu, jugement FROM stories WHERE id = ANY($1) ORDER BY id",
        [enfantsIds],
      )
    ).rows;
    const itemId = texte(ch.itemId);
    const enfants = lignes.map((s) => {
      const criteres = s.jugement ? Object.entries(s.jugement).filter(([k]) => k !== "commentaire") : [];
      return {
        id: s.id,
        jeVeux: s.contenu.jeVeux ?? "",
        enTantQue: s.contenu.enTantQue ?? "",
        complexite: s.contenu.complexite ?? "?",
        jugeOui: criteres.filter(([, v]) => v === true).length,
        jugeTotal: criteres.length,
        criteresNon: criteres.filter(([, v]) => v === false).map(([k]) => LIBELLE_CRITERE[k] ?? k),
      };
    });
    return {
      ...base,
      effet: `Accepter remplace la story de « ${titre(itemId) ?? "?"} » par ces ${enfants.length} stories, chacune à valider ensuite. Refuser garde la story d'origine.`,
      details: { type: "decoupage", storyId: texte(ch.storyId) ?? "?", itemId: itemId ?? "?", itemTitre: titre(itemId) ?? "?", justification: texte(ch.justification), enfants },
    };
  }

  if (p.type === "effort") {
    // L'effort que propose la rédaction d'une story : le PO voit ce que la nouvelle taille ferait au score et au rang.
    const itemId = texte(ch.itemId) ?? "?";
    const avant = texte(ch.avant) ?? "?";
    const apres = texte(ch.apres) ?? "?";
    const sim = (["S", "M", "L", "XL"] as const).includes(apres as Complexite) ? await simulerChangement(ctx, itemId, { complexite: apres as Complexite }) : null;
    const chiffres = sim
      ? { scoreAvant: sim.scoreAvant, scoreApres: sim.scoreApres, rangAvant: sim.rangAvant ? decrireRang(sim.rangAvant) : null, rangApres: sim.rangApres ? decrireRang(sim.rangApres) : null }
      : { scoreAvant: null, scoreApres: null, rangAvant: null, rangApres: null };
    const effetScore = sim ? ` Le score passerait de ${decimales(sim.scoreAvant)} à ${decimales(sim.scoreApres)}${chiffres.rangAvant && chiffres.rangApres && chiffres.rangAvant !== chiffres.rangApres ? ` (${chiffres.rangAvant} → ${chiffres.rangApres})` : ""}.` : "";
    return {
      ...base,
      effet: `Accepter fixe la taille de « ${titre(itemId)} » à ${apres}.${effetScore} Refuser garde ${avant}.`,
      details: { type: "effort", itemId, itemTitre: titre(itemId) ?? itemId, avant, apres, storyId: texte(ch.storyId), ...chiffres },
    };
  }

  return { ...base, effet: "Accepter la marque comme retenue ; l'agent n'en fait rien d'autre : c'est à vous d'agir.", details: { type: "autre" } };
}
