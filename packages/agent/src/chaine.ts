import {
  ajusterImpact,
  analyserTirages,
  analyserVerdicts,
  appliquerRattachement,
  calculerScore,
  citationVerifiee,
  classer,
  couperTitre,
  decrireEcart,
  decrireRang,
  detecterTendance,
  demandesExploitables,
  empreinteFeedback,
  expliquerEcart,
  impactDepuisIndex,
  indexImpact,
  mouvementsTop,
  numeroterRangs,
  PARAMETRES,
  selectionnerQuestions,
  type DetailScore,
  type Extraction,
  type Feedback,
  type Filtre,
  type ItemBacklog,
  type Plan,
} from "@po-agent/domain";
import { journaliser } from "@po-agent/db";
import { EchecLLM } from "@po-agent/llm";
import type { Contexte } from "./contexte.ts";
import { chargerComptes, chargerFeedback, chargerItem, chargerItems, chargerPreuves, chargerRegles, prochainId } from "./depot.ts";

/** Combinaisons de filtres calculées à chaque passage, pour que le PO bascule de vue sans attendre. */
export const COMBINAISONS_FILTRES: Filtre[][] = [[], ["mrr"], ["objectif"], ["mrr", "objectif"]];

export function cleFiltres(filtres: readonly Filtre[]): string {
  return filtres.length === 0 ? "aucun" : [...filtres].sort().join("+");
}

const VUE_REFERENCE = cleFiltres(PARAMETRES.alertes.vueReference as unknown as Filtre[]);

// ---------------------------------------------------------------------------
// Entrée : un feedback arrive (connecteur email, ticket, commentaire, ou direct)
// ---------------------------------------------------------------------------

/** Enregistre un feedback et met son traitement en file. Un doublon (même empreinte) est ignoré. */
export async function ingerer(ctx: Contexte, f: Feedback): Promise<"ajoute" | "doublon"> {
  const r = await ctx.db.query<{ id: string }>(
    `INSERT INTO feedbacks (id, compte_id, canal, recu_le, texte, empreinte)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [f.id, f.compteId, f.canal, f.recuLe, f.texte, empreinteFeedback(f)],
  );
  if (!r.rows[0]) return "doublon";
  await ctx.file.ajouter("traiter_feedback", { feedbackId: f.id }, { cle: `traiter:${f.id}` });
  ctx.diffuser({ type: "feedback", donnees: { id: f.id, statut: "recu" } });
  return "ajoute";
}

/** Une alerte désigne ce qu'elle concerne (`cible` : un item ou un feedback), pour que le PO l'ouvre d'un clic. */
/** « Business », « Pro », « Free » : comme dans le cockpit. */
function libellePlan(plan: Plan): string {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/** 4 100, avec l'espace des milliers à la française : le texte part aussi tel quel sur Telegram. */
function euros(montant: number): string {
  return Math.round(montant).toLocaleString("fr-FR").replace(/ /g, " ");
}

async function alerter(ctx: Contexte, type: string, message: string, urgente: boolean, cible?: string): Promise<void> {
  await ctx.db.query("INSERT INTO alertes (type, message, urgente, cible, creee_le) VALUES ($1, $2, $3, $4, $5)", [type, message, urgente, cible ?? null, ctx.maintenant().toISOString()]);
  ctx.diffuser({ type: "alerte", donnees: { type, message, urgente, cible: cible ?? null } });
}

// ---------------------------------------------------------------------------
// Comprendre : extraction en quarantaine, garde-fous, rattachement
// ---------------------------------------------------------------------------

/**
 * Traite un feedback. Renvoie les items touchés, à re-scorer.
 * Un échec maîtrisé du modèle (refus, schéma invalide) met le feedback en attente sans casser la chaîne.
 * Une erreur réseau est relancée pour que la file réessaie.
 */
export async function traiterFeedback(ctx: Contexte, feedbackId: string): Promise<string[]> {
  const f = await chargerFeedback(ctx.db, feedbackId);
  if (!f) throw new Error(`Feedback introuvable : ${feedbackId}`);
  if (f.statut !== "recu" && f.statut !== "en_attente") return [];

  let extraction: Extraction;
  try {
    // Seul appel à lire le texte brut. Il n'a aucun outil.
    extraction = await ctx.llm.extraire({ id: f.id, texte: f.texte });
  } catch (e) {
    if (e instanceof EchecLLM && e.motif !== "erreur") {
      await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "systeme", action: "extraction_en_attente", cible: f.id, details: { motif: e.motif } });
      await ctx.db.query("UPDATE feedbacks SET statut = 'en_attente' WHERE id = $1", [f.id]);
      ctx.diffuser({ type: "feedback", donnees: { id: f.id, statut: "en_attente" } });
      return [];
    }
    throw e;
  }

  const garde = demandesExploitables(extraction, f.texte);
  await ctx.db.query(
    `INSERT INTO extractions (feedback_id, nature, injection_suspectee, menace_depart, demandes, demandes_rejetees)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (feedback_id) DO UPDATE SET nature = EXCLUDED.nature, demandes = EXCLUDED.demandes, demandes_rejetees = EXCLUDED.demandes_rejetees`,
    [f.id, extraction.nature, extraction.injectionSuspectee, extraction.menaceDepart, JSON.stringify(garde.exploitables), JSON.stringify(garde.rejetees)],
  );

  if (extraction.injectionSuspectee || extraction.nature === "suspect") {
    await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "mise_en_quarantaine", cible: f.id, details: { raison: "tentative d'instruction détectée" } });
    await ctx.db.query("UPDATE feedbacks SET statut = 'suspect' WHERE id = $1", [f.id]);
    await alerter(ctx, "quarantaine", `Feedback ${f.id} mis à l'écart : il tente de donner des instructions à l'agent. Aucune preuve ni écriture n'en a été tirée.`, false, f.id);
    ctx.diffuser({ type: "feedback", donnees: { id: f.id, statut: "suspect" } });
    return [];
  }

  if (extraction.menaceDepart) {
    await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "risque_depart_detecte", cible: f.compteId, details: { feedbackId: f.id } });
    await ctx.db.query("UPDATE comptes SET risque_depart = TRUE WHERE id = $1", [f.compteId]);
    const comptes = await chargerComptes(ctx.db);
    const c = comptes.get(f.compteId);
    // L'alerte dit ce que le client demande : le PO doit savoir sur quoi porte la menace sans ouvrir le message.
    const demandes = garde.exploitables.map((d) => `« ${d.resume} »`).join(" ; ");
    await alerter(ctx, "risque_depart", `${c?.nom ?? f.compteId} (${c ? libellePlan(c.plan) : "?"}, ${euros(c?.mrr ?? 0)} €/mois) menace de partir.${demandes ? ` Sa demande : ${demandes}.` : ""}`, true, f.id);
  }

  const touches = new Set<string>();
  for (const demande of garde.exploitables) {
    const itemId = await rattacher(ctx, f, demande, extraction);
    if (itemId) touches.add(itemId);
  }

  await ctx.db.query("UPDATE feedbacks SET statut = 'traite' WHERE id = $1", [f.id]);
  ctx.diffuser({ type: "feedback", donnees: { id: f.id, statut: "traite" } });
  for (const itemId of touches) await ctx.file.ajouter("rescorer", { itemId }, { cle: `rescorer:${itemId}` });
  return [...touches];
}

async function creerPreuve(
  ctx: Contexte,
  f: Feedback,
  itemId: string,
  citation: string,
  sure: boolean,
  regleId?: string,
): Promise<string> {
  const id = await prochainId(ctx.db, "P", "preuves");
  await ctx.db.query(
    // Une preuve en attente sur cet item devient sûre si une autre demande du même message y est rattachée avec certitude :
    // avant, la seconde preuve était perdue en silence, et le journal affirmait un rattachement qui n'existait pas.
    `INSERT INTO preuves (id, item_id, feedback_id, compte_id, canal, recu_le, citation, sure, regle_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (item_id, feedback_id) DO UPDATE SET
       sure = preuves.sure OR EXCLUDED.sure,
       citation = CASE WHEN preuves.sure THEN preuves.citation ELSE EXCLUDED.citation END,
       regle_id = COALESCE(preuves.regle_id, EXCLUDED.regle_id)`,
    [id, itemId, f.id, f.compteId, f.canal, f.recuLe, citation, sure, regleId ?? null],
  );
  return id;
}

/**
 * Recherche de candidats pour un rattachement (interface du cadrage, § 4).
 * Version minimale : tout le backlog actif, qui tient dans le contexte du modèle.
 * Au-delà de quelques centaines d'items, on la remplacerait par une recherche par embeddings (les plus proches),
 * sans changer le reste de la chaîne.
 */
export async function rechercherCandidats(
  _ctx: Contexte,
  _demande: Extraction["demandes"][number],
  items: ItemBacklog[],
): Promise<Array<{ id: string; titre: string; description?: string }>> {
  return items.map((i) => ({ id: i.id, titre: i.titre, ...(i.description ? { description: i.description } : {}) }));
}

/**
 * Bug déguisé (CADRAGE § 2) : un candidat créé par l'agent comme fonctionnalité devient un bug quand une demande
 * qui signale une régression y est rattachée. Avant, seul le premier message décidait du type, et la régression passait inaperçue.
 */
async function signalerRegression(ctx: Contexte, itemId: string, d: Extraction["demandes"][number], extraction: Extraction): Promise<void> {
  if (!d.regression || extraction.nature !== "bug") return;
  const item = (await ctx.db.query<{ titre: string; type: string; cree_par: string; statut: string }>("SELECT titre, type, cree_par, statut FROM items WHERE id = $1", [itemId])).rows[0];
  if (!item || item.type === "bug" || item.cree_par !== "agent") return;
  await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "requalifier_en_bug", cible: itemId, details: { feedbackId: extraction.feedbackId, citation: d.citation } });
  await ctx.db.query("UPDATE items SET type = 'bug' WHERE id = $1", [itemId]);
  await alerter(ctx, "bug_deguise", `Un bug se cache derrière « ${item.titre} » : un client signale que cela fonctionnait avant (« ${d.citation} »). L'agent l'a requalifié en bug.`, false, itemId);
}

/** Rattache une demande : d'abord les règles de doctrine (déterministes), sinon plusieurs tirages du LLM. */
async function rattacher(ctx: Contexte, f: Feedback, d: Extraction["demandes"][number], extraction: Extraction): Promise<string | null> {
  const regles = await chargerRegles(ctx.db);
  const parRegle = appliquerRattachement(`${d.resume} ${d.citation}`, regles);
  if (parRegle) {
    // Audit : l'action est consignée avant l'écriture.
    await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "rattacher", cible: f.id, details: { itemId: parRegle.itemId, par: "regle" }, reglesCitees: [parRegle.regleId] });
    await creerPreuve(ctx, f, parRegle.itemId, d.citation, true, parRegle.regleId);
    await signalerRegression(ctx, parRegle.itemId, d, extraction);
    return parRegle.itemId;
  }

  const items = await chargerItems(ctx.db);
  const candidats = await rechercherCandidats(ctx, d, items);
  const n = PARAMETRES.doute.tiragesRattachement;
  const verdicts = await Promise.all(Array.from({ length: n }, (_, i) => ctx.llm.jugerRattachement(d, candidats, i)));
  const analyse = analyserVerdicts(verdicts.map((v) => v.verdict));
  const ids = verdicts.map((v) => v.itemId);
  const memeItem = ids.every((id) => id !== null && id === ids[0]);

  if (!analyse.doute && analyse.verdict === "meme_besoin" && memeItem) {
    const itemId = ids[0] as string;
    await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "rattacher", cible: f.id, details: { itemId, par: "llm", tirages: n } });
    await creerPreuve(ctx, f, itemId, d.citation, true);
    await signalerRegression(ctx, itemId, d, extraction);
    return itemId;
  }

  if (!analyse.doute && analyse.verdict === "different") {
    // Une question sans élément correspondant (facture, adresse, panne du jour) relève du support, pas du backlog :
    // elle ne crée plus d'élément candidat. Le message reste dans le fil, marqué « question ».
    if (extraction.nature === "question") {
      await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "orienter_support", cible: f.id, details: { resume: d.resume } });
      return null;
    }
    const itemId = await creerItemCandidat(ctx, d, extraction);
    await creerPreuve(ctx, f, itemId, d.citation, true);
    return itemId;
  }

  // Doute : la preuve est visible mais ne compte pas, et le PO est interrogé.
  const proposes = [...new Set([...ids.filter((id): id is string => id !== null), ...verdicts.flatMap((v) => v.alternatives)])];
  const probable = proposes[0];
  if (probable) await creerPreuve(ctx, f, probable, d.citation, false);
  const titres = new Map(items.map((i) => [i.id, i.titre]));
  const options = [...proposes.map((id) => ({ valeur: id, libelle: titres.get(id) ?? id })), { valeur: "nouvel_item", libelle: "Un besoin nouveau" }, { valeur: "ignorer", libelle: "Ne pas en tenir compte" }];
  // Une seule question par message et par jeu d'options : deux demandes d'un même email ne prennent pas deux places du budget.
  const memeQuestion = await ctx.db.query(
    "SELECT 1 FROM questions WHERE type = 'rattachement' AND etat IN ('ouverte', 'relancee') AND contexte->>'feedbackId' = $1 AND options = $2::jsonb",
    [f.id, JSON.stringify(options)],
  );
  if (memeQuestion.rows.length > 0) return probable ?? null;
  await creerQuestion(ctx, {
    type: "rattachement",
    enonce: proposes.length >= 2 ? `Cette demande relève-t-elle de « ${titres.get(proposes[0]!)} » ou de « ${titres.get(proposes[1]!)} » ?` : "À quel élément du backlog rattacher cette demande ?",
    options,
    // Les lectures de l'agent sont gardées : le PO voit pourquoi il doute (qui dit quoi, avec quelle justification).
    contexte: {
      feedbackId: f.id,
      compteId: f.compteId,
      citation: d.citation,
      resume: d.resume,
      nature: extraction.nature,
      regression: d.regression,
      verdicts: verdicts.map((v) => ({ itemId: v.itemId, verdict: v.verdict, alternatives: v.alternatives, justification: v.justification })),
    },
    enjeu: await enjeuRattachement(ctx, f, proposes, items),
    urgente: extraction.menaceDepart,
  });
  return probable ?? null;
}

/**
 * Enjeu d'une question de rattachement : ce que la réponse ferait bouger dans le classement de la vue de référence.
 * On calcule, pour chaque item proposé, le gain de score si la preuve y était comptée ; l'enjeu est le plus grand.
 */
async function enjeuRattachement(ctx: Contexte, f: Feedback, proposes: string[], items: ItemBacklog[]): Promise<number> {
  const comptes = await chargerComptes(ctx.db);
  const filtres = PARAMETRES.alertes.vueReference as unknown as Filtre[];
  let enjeu = 0;
  for (const id of proposes) {
    const item = items.find((i) => i.id === id);
    if (!item) continue;
    const preuves = (await chargerPreuves(ctx.db, id)).filter((p) => p.feedbackId !== f.id);
    const impact = Number((await ctx.db.query<{ mediane: string }>("SELECT mediane FROM jugements_impact WHERE item_id = $1", [id])).rows[0]?.mediane ?? 1);
    const base = { item, impact, comptes, maintenant: ctx.maintenant(), filtres };
    const sans = calculerScore({ ...base, preuves });
    const avec = calculerScore({ ...base, preuves: [...preuves, { id: "hypothese", itemId: id, feedbackId: f.id, compteId: f.compteId, canal: f.canal, recuLe: f.recuLe, citation: "", sure: true }] });
    enjeu = Math.max(enjeu, avec.score - sans.score);
  }
  return Math.round(enjeu * 100) / 100;
}

async function creerItemCandidat(ctx: Contexte, d: Extraction["demandes"][number], extraction: Extraction): Promise<string> {
  const id = await prochainId(ctx.db, "N", "items");
  const estBug = extraction.nature === "bug";
  const titre = couperTitre(`${estBug && d.regression ? "Régression : " : ""}${d.resume}`);
  let complexite: ItemBacklog["complexite"] = "M";
  try {
    complexite = (await ctx.llm.estimerComplexite({ titre }, [d.citation])).complexite;
  } catch (e) {
    if (!(e instanceof EchecLLM) || e.motif === "erreur") throw e;
  }
  await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "creer_item_candidat", cible: id, details: { titre, type: estBug ? "bug" : "fonctionnalite" } });
  await ctx.db.query(
    `INSERT INTO items (id, titre, type, statut, complexite, alignement_objectif, cree_par) VALUES ($1, $2, $3, 'candidat', $4, FALSE, 'agent')`,
    [id, titre, estBug ? "bug" : "fonctionnalite", complexite],
  );
  const propId = await prochainId(ctx.db, "PR", "propositions");
  await ctx.db.query("INSERT INTO propositions (id, type, charge, resume, creee_le) VALUES ($1, 'nouvel_item', $2, $3, $4)", [
    propId,
    JSON.stringify({ itemId: id }),
    `Nouvel item candidat : « ${titre} »${estBug ? " (bug)" : ""}`,
    ctx.maintenant().toISOString(),
  ]);
  ctx.diffuser({ type: "proposition", donnees: { id: propId } });
  if (estBug && d.regression) {
    // Un bug déguisé en demande (cadrage § 3) : une fonction qui marchait avant. Signalé au PO, sans urgence.
    // Un incident sans régression (« ça rame ce matin ») reste un bug candidat, sans cette alerte.
    await alerter(ctx, "bug_deguise", `Un bug se cache derrière une demande client : « ${titre} ». L'agent l'a requalifié en bug candidat (régression signalée).`, false, id);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Questions au PO : création, budget quotidien
// ---------------------------------------------------------------------------

export async function creerQuestion(
  ctx: Contexte,
  q: { type: "rattachement" | "impact" | "fusion" | "requalification"; enonce: string; options: Array<{ valeur: string; libelle: string }>; contexte: Record<string, unknown>; enjeu: number; urgente: boolean },
): Promise<string> {
  const id = await prochainId(ctx.db, "Q", "questions");
  await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "question_creee", cible: id, details: { type: q.type, urgente: q.urgente } });
  await ctx.db.query(
    "INSERT INTO questions (id, type, enonce, options, contexte, enjeu, urgente) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [id, q.type, q.enonce, JSON.stringify(q.options), JSON.stringify(q.contexte), q.enjeu, q.urgente],
  );
  // Seule l'urgence part tout de suite (CADRAGE § 1). Les autres attendent la fin du lot de travail (file vide),
  // pour être posées par ordre d'enjeu : sinon, les premières arrivées prendraient tout le budget du jour.
  if (q.urgente) await poserQuestions(ctx);
  return id;
}

/** Pose les questions en attente dans la limite du budget du jour ; les urgences passent toujours. */
export async function poserQuestions(ctx: Contexte): Promise<string[]> {
  const debutJour = new Date(ctx.maintenant());
  debutJour.setUTCHours(0, 0, 0, 0);
  const deja = await ctx.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM questions WHERE posee_le >= $1 AND NOT urgente", [debutJour.toISOString()]);
  const enAttente = await ctx.db.query<{ id: string; enjeu: string; urgente: boolean }>("SELECT id, enjeu, urgente FROM questions WHERE posee_le IS NULL AND etat = 'ouverte'");
  const { aPoser } = selectionnerQuestions(
    enAttente.rows.map((q) => ({ id: q.id, enjeu: Number(q.enjeu), urgente: q.urgente })),
    deja.rows[0]?.n ?? 0,
  );
  for (const q of aPoser) {
    await ctx.db.query("UPDATE questions SET posee_le = $2 WHERE id = $1", [q.id, ctx.maintenant().toISOString()]);
    ctx.diffuser({ type: "question", donnees: { id: q.id, urgente: q.urgente } });
  }
  return aPoser.map((q) => q.id);
}

// ---------------------------------------------------------------------------
// Arbitrer : Impact (tirages multiples), scores, écarts, alertes
// ---------------------------------------------------------------------------

async function jugerImpact(ctx: Contexte, item: ItemBacklog): Promise<number | null> {
  const preuves = (await chargerPreuves(ctx.db, item.id)).filter((p) => p.sure);
  if (preuves.length === 0) return null;

  const existant = await ctx.db.query<{ mediane: string; cree_le: unknown; regles: string[]; tirages: number[] }>("SELECT * FROM jugements_impact WHERE item_id = $1", [item.id]);
  const derniere = await ctx.db.query<{ m: unknown }>("SELECT MAX(cree_le) AS m FROM preuves WHERE item_id = $1 AND sure", [item.id]);
  const jugement = existant.rows[0];
  if (jugement && derniere.rows[0]?.m && new Date(String(jugement.cree_le)) >= new Date(String(derniere.rows[0].m))) {
    return Number(jugement.mediane);
  }

  const citations = preuves.slice(-12).map((p) => p.citation);
  const n = PARAMETRES.rice.tiragesImpact;
  let tirages;
  try {
    tirages = await Promise.all(Array.from({ length: n }, (_, i) => ctx.llm.jugerImpact({ item, citations }, i)));
  } catch (e) {
    if (e instanceof EchecLLM && e.motif !== "erreur") return jugement ? Number(jugement.mediane) : null;
    throw e;
  }
  const analyse = analyserTirages(tirages.map((t) => t.impact));
  const comptes = await chargerComptes(ctx.db);
  const plans = new Set<Plan>(preuves.map((p) => comptes.get(p.compteId)?.plan).filter((p): p is Plan => p !== undefined));
  const ajuste = ajusterImpact(indexImpact(analyse.mediane), { plans, alignementObjectif: item.alignementObjectif }, await chargerRegles(ctx.db));
  const impact = impactDepuisIndex(ajuste.index);

  await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "juger_impact", cible: item.id, details: { tirages: tirages.map((t) => t.impact), mediane: analyse.mediane, retenu: impact }, reglesCitees: ajuste.reglesAppliquees });
  // La justification affichée est celle d'un tirage égal à la médiane : celle du premier tirage pouvait conclure
  // à 3 sous une médiane de 2, et l'écran se contredisait.
  const representatif = tirages.find((t) => t.impact === analyse.mediane) ?? tirages[0];
  await ctx.db.query(
    `INSERT INTO jugements_impact (item_id, tirages, mediane, ecart_crans, justification, valeur_justification, citations, regles, cree_le)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (item_id) DO UPDATE SET tirages = EXCLUDED.tirages, mediane = EXCLUDED.mediane, ecart_crans = EXCLUDED.ecart_crans,
       justification = EXCLUDED.justification, valeur_justification = EXCLUDED.valeur_justification, citations = EXCLUDED.citations, regles = EXCLUDED.regles, cree_le = now()`,
    // Seules les citations du juge qui figurent mot pour mot dans les verbatims fournis sont gardées.
    // cree_le reste sur l'horloge de la base, comme celui des preuves : la comparaison des deux évite un nouveau jugement.
    [
      item.id,
      JSON.stringify(tirages.map((t) => t.impact)),
      impact,
      analyse.ecartCrans,
      representatif?.justification ?? "",
      representatif?.impact ?? null,
      JSON.stringify((representatif?.citations ?? []).filter((c) => citationVerifiee(c, citations.join("\n")))),
      JSON.stringify(ajuste.reglesAppliquees),
    ],
  );

  if (analyse.doute) {
    const ouverte = await ctx.db.query("SELECT 1 FROM questions WHERE type = 'impact' AND etat IN ('ouverte', 'relancee') AND contexte->>'itemId' = $1", [item.id]);
    if (ouverte.rows.length === 0) {
      const valeurs = [...new Set(tirages.map((t) => t.impact))].sort((a, b) => a - b);
      await creerQuestion(ctx, {
        type: "impact",
        enonce: `Mes estimations de l'Impact de « ${item.titre} » divergent (${valeurs.join(", ")}). Laquelle retenir ?`,
        options: valeurs.map((v) => ({ valeur: String(v), libelle: String(v) })),
        contexte: { itemId: item.id, tirages: tirages.map((t) => t.impact), justifications: tirages.map((t) => t.justification) },
        enjeu: analyse.ecartCrans,
        urgente: false,
      });
    }
  }
  return impact;
}

async function derniersScores(ctx: Contexte, filtres: string): Promise<Map<string, DetailScore>> {
  const r = await ctx.db.query<{ item_id: string; detail: DetailScore }>(
    `SELECT DISTINCT ON (item_id) item_id, detail FROM scores WHERE filtres = $1 ORDER BY item_id, calcule_le DESC, id DESC`,
    [filtres],
  );
  return new Map(r.rows.map((x) => [x.item_id, x.detail]));
}

/** Recalcule l'Impact puis les scores d'un item, enregistre les instantanés, et alerte si le top bouge. */
export async function rescorer(ctx: Contexte, itemId: string): Promise<void> {
  const item = await chargerItem(ctx.db, itemId);
  if (!item || item.statut === "termine") return;
  const impactPO = await ctx.db.query<{ impact: string }>(
    "SELECT (r.choix)::numeric AS impact FROM reponses r JOIN questions q ON q.id = r.question_id WHERE q.type = 'impact' AND q.contexte->>'itemId' = $1 ORDER BY r.recue_le DESC LIMIT 1",
    [itemId],
  );
  const impact = impactPO.rows[0] ? Number(impactPO.rows[0].impact) : ((await jugerImpact(ctx, item)) ?? 1);
  const preuves = await chargerPreuves(ctx.db, itemId);
  const comptes = await chargerComptes(ctx.db);
  const tousItems = await chargerItems(ctx.db);
  const titres = new Map(tousItems.map((i) => [i.id, i.titre]));
  const statuts = new Map(tousItems.map((i) => [i.id, i.statut]));

  for (const filtres of COMBINAISONS_FILTRES) {
    const cle = cleFiltres(filtres);
    const avant = await derniersScores(ctx, cle);
    const detail = calculerScore({ item, preuves, impact, comptes, maintenant: ctx.maintenant(), filtres });
    const ecart = expliquerEcart(avant.get(itemId), detail);
    if (cle === VUE_REFERENCE) await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "rescorer", cible: itemId, details: { vue: cle, explication: decrireEcart(ecart) } });
    await ctx.db.query("INSERT INTO scores (item_id, filtres, detail) VALUES ($1, $2, $3)", [itemId, cle, JSON.stringify(detail)]);

    if (cle === VUE_REFERENCE) {
      const ordreAvant = classer([...avant.values()]).map((s) => s.itemId);
      const apres = new Map(avant);
      apres.set(itemId, detail);
      const ordreApres = classer([...apres.values()]).map((s) => s.itemId);
      const { entrees, sorties } = mouvementsTop(ordreAvant, ordreApres, PARAMETRES.alertes.tailleTop);
      // En lot (préchargement), les entrées et sorties du top ne sont pas signalées : voir Contexte.modeLot.
      for (const id of ctx.modeLot ? [] : entrees) {
        // Le rang affiché suit le comptage du cockpit (candidats non numérotés) ; l'entrée dans le top, elle, ne change pas.
        const rang = numeroterRangs(ordreApres, statuts).get(id);
        const urgente = [...preuves].some((p) => p.sure && comptes.get(p.compteId)?.risqueDepart);
        await alerter(ctx, "entree_top", `« ${titres.get(id) ?? id} » entre dans le top ${PARAMETRES.alertes.tailleTop} (${rang ? decrireRang(rang) : "rang ?"}). ${id === itemId ? decrireEcart(ecart) : ""}`.trim(), urgente && id === itemId, id);
      }
      for (const id of ctx.modeLot ? [] : sorties) {
        await alerter(ctx, "sortie_top", `« ${titres.get(id) ?? id} » sort du top ${PARAMETRES.alertes.tailleTop}.`, false, id);
      }
    }
  }

  // Thème émergent (cadrage § 3) : la tendance est calculée par le code, et signalée une seule fois par item.
  const tendance = detecterTendance(
    preuves.filter((p) => p.sure).map((p) => p.recuLe),
    ctx.maintenant(),
  );
  if (tendance.tendance) {
    const deja = await ctx.db.query("SELECT 1 FROM journal_activite WHERE action = 'alerte_tendance' AND cible = $1", [itemId]);
    if (deja.rows.length === 0) {
      await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "alerte_tendance", cible: itemId, details: { ...tendance } });
      await alerter(ctx, "tendance", `Thème émergent : « ${item.titre} », ${tendance.recent} demandes sur les ${PARAMETRES.tendances.fenetreJours} derniers jours contre ${tendance.precedent} avant.`, false, itemId);
    }
  }
  ctx.diffuser({ type: "classement", donnees: { itemId } });
}

/** Classement courant d'une vue, à partir des derniers instantanés. */
export async function classement(ctx: Contexte, filtres: readonly Filtre[]): Promise<DetailScore[]> {
  return classer([...(await derniersScores(ctx, cleFiltres(filtres))).values()]);
}
