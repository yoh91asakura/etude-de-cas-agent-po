import { activerRegle, controlerStory, couperTitre, etatApresResume, PARAMETRES, proposerRegle, verifierDoctrine, type CasSource, type Complexite, type Regle, type Story } from "@po-agent/domain";
import { EchecLLM } from "@po-agent/llm";
import { journaliser } from "@po-agent/db";
import type { Contexte } from "./contexte.ts";
import { chargerItems, chargerRegles, enregistrerRegle, prochainId } from "./depot.ts";
import { poserQuestions } from "./chaine.ts";
import { ordreOfficiel } from "./ordre.ts";
import { appliquerRattachement, contradictions as contradictionsDoctrine, normaliser, type ContenuRegle, type StatutRegle } from "@po-agent/domain";

/**
 * Tout ce que le PO décide passe par ici : réponses aux questions, validation des règles, décisions sur les propositions.
 * Rien n'est écrit dans le backlog officiel sans une décision explicite du PO.
 */

type LigneQuestion = { id: string; type: string; enonce: string; options: Array<{ valeur: string; libelle: string }>; contexte: Record<string, unknown>; etat: string };

export async function repondre(
  ctx: Contexte,
  questionId: string,
  choix: string,
  canal: "application" | "telegram",
): Promise<{ reponseId: string; regleProposee?: Regle; itemCree?: string; reglePrevue?: boolean }> {
  const r = await ctx.db.query<LigneQuestion>("SELECT * FROM questions WHERE id = $1", [questionId]);
  const q = r.rows[0];
  if (!q) throw new Error(`Question introuvable : ${questionId}`);
  if (q.etat === "repondue" || q.etat === "expiree") throw new Error(`Question déjà close (${q.etat})`);
  if (!q.options.some((o) => o.valeur === choix)) throw new Error(`Choix hors des options proposées : ${choix}`);

  const reponseId = await prochainId(ctx.db, "R", "reponses");
  // Audit : chaque écriture est consignée avant d'être exécutée.
  await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "po", action: "repondre", cible: questionId, details: { choix, canal, reponseId } });
  await ctx.db.query("INSERT INTO reponses (id, question_id, auteur, choix, canal) VALUES ($1, $2, 'po', $3, $4)", [reponseId, questionId, choix, canal]);
  await ctx.db.query("UPDATE questions SET etat = 'repondue' WHERE id = $1", [questionId]);
  ctx.diffuser({ type: "question", donnees: { id: questionId, etat: "repondue" } });

  if (q.type === "impact") {
    const itemId = String(q.contexte.itemId);
    await ctx.file.ajouter("rescorer", { itemId }, { cle: `rescorer:${itemId}` });
    return { reponseId };
  }

  if (q.type === "fusion") {
    const itemA = String(q.contexte.itemA);
    const itemB = String(q.contexte.itemB);
    if (choix === "oui") {
      await fusionner(ctx, itemA, itemB, reponseId);
      return { reponseId };
    }
    // « Deux besoins distincts » : l'agent propose une règle pour ne plus jamais reposer la question.
    const titres = new Map((await chargerItems(ctx.db, true)).map((i) => [i.id, i.titre]));
    const regle = proposerRegle({
      id: await prochainIdRegle(ctx),
      reponse: { id: reponseId, auteur: "po" },
      contenu: { type: "paire_distincte", itemA, itemB },
      texte: `« ${titres.get(itemA)} » et « ${titres.get(itemB)} » sont deux besoins distincts : ne jamais les fusionner.`,
      maintenant: ctx.maintenant(),
    });
    await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "proposer_regle", cible: regle.id, details: { sourceReponseId: reponseId, texte: regle.texte } });
    await enregistrerRegle(ctx.db, regle);
    const propId = await prochainId(ctx.db, "PR", "propositions");
    await ctx.db.query("INSERT INTO propositions (id, type, charge, resume, creee_le) VALUES ($1, 'regle', $2, $3, $4)", [propId, JSON.stringify({ regleId: regle.id, version: regle.version }), `Règle proposée : ${regle.texte}`, ctx.maintenant().toISOString()]);
    ctx.diffuser({ type: "regle", donnees: { id: regle.id, statut: "proposee" } });
    return { reponseId, regleProposee: regle };
  }

  if (q.type === "rattachement") {
    const feedbackId = String(q.contexte.feedbackId);
    const citation = String(q.contexte.citation);
    const incertaine = await ctx.db.query<{ id: string; item_id: string }>("SELECT id, item_id FROM preuves WHERE feedback_id = $1 AND NOT sure", [feedbackId]);
    const precedent = incertaine.rows[0];

    if (choix === "ignorer") {
      if (precedent) await ctx.db.query("DELETE FROM preuves WHERE id = $1", [precedent.id]);
      return { reponseId };
    }
    if (choix === "nouvel_item") {
      // Le PO tranche : c'est un besoin absent du backlog. L'élément naît de sa décision, avec la demande comme première preuve sûre.
      const itemId = await creerItemDepuisReponse(ctx, q, feedbackId, citation, precedent);
      return { reponseId, itemCree: itemId };
    }

    await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "po", action: "trancher_rattachement", cible: feedbackId, details: { itemId: choix, avant: precedent?.item_id ?? null } });
    if (precedent && precedent.item_id !== choix) {
      await ctx.db.query("UPDATE preuves SET item_id = $2, sure = TRUE, item_origine = $3 WHERE id = $1", [precedent.id, choix, precedent.item_id]);
    } else if (precedent) {
      await ctx.db.query("UPDATE preuves SET sure = TRUE WHERE id = $1", [precedent.id]);
    } else {
      const f = await ctx.db.query<{ compte_id: string; canal: string; recu_le: unknown }>("SELECT compte_id, canal, recu_le FROM feedbacks WHERE id = $1", [feedbackId]);
      const fb = f.rows[0];
      if (fb) {
        const pid = await prochainId(ctx.db, "P", "preuves");
        await ctx.db.query(
          "INSERT INTO preuves (id, item_id, feedback_id, compte_id, canal, recu_le, citation, sure) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE) ON CONFLICT DO NOTHING",
          [pid, choix, feedbackId, fb.compte_id, fb.canal, fb.recu_le, citation],
        );
      }
    }
    for (const itemId of new Set([choix, precedent?.item_id].filter((x): x is string => !!x))) {
      await ctx.file.ajouter("rescorer", { itemId }, { cle: `rescorer:${itemId}` });
    }

    // L'agent propose d'en faire une règle. Elle naît de cette réponse du PO, et reste inactive tant qu'il ne l'a pas validée.
    // La réponse est déjà enregistrée : si la formulation échoue, elle est reprise par la file, au lieu de faire
    // croire au PO (sur Telegram) que sa réponse a été refusée.
    try {
      const regle = await formulerRegleDeReponse(ctx, reponseId);
      return regle ? { reponseId, regleProposee: regle } : { reponseId };
    } catch (e) {
      await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "systeme", action: "formulation_regle_reportee", cible: reponseId, details: { erreur: e instanceof Error ? e.message.slice(0, 200) : String(e) } });
      await ctx.file.ajouter("formuler_regle", { reponseId }, { cle: `regle:${reponseId}` });
      return { reponseId, reglePrevue: true };
    }
  }

  return { reponseId };
}

/**
 * Formule la règle qui naît d'une réponse de rattachement du PO, et la lui propose.
 * Idempotente : une réponse qui a déjà sa règle n'en produit pas une seconde (reprise par la file).
 */
export async function formulerRegleDeReponse(ctx: Contexte, reponseId: string): Promise<Regle | null> {
  const deja = await ctx.db.query("SELECT 1 FROM regles WHERE source_reponse_id = $1", [reponseId]);
  if (deja.rows.length > 0) return null;
  const r = await ctx.db.query<LigneQuestion & { choix: string }>("SELECT q.*, rp.choix FROM reponses rp JOIN questions q ON q.id = rp.question_id WHERE rp.id = $1", [reponseId]);
  const q = r.rows[0];
  if (!q || q.type !== "rattachement") return null;
  const choix = q.choix;
  const items = await chargerItems(ctx.db);
  const choisi = items.find((i) => i.id === choix);
  if (!choisi) return null;
  const ecartes = items.filter((i) => i.id !== choix && q.options.some((o) => o.valeur === i.id));
  const formulation = await ctx.llm.formulerRegleRattachement({
    citation: String(q.contexte.citation),
    itemChoisi: { id: choisi.id, titre: choisi.titre },
    itemsEcartes: ecartes.map((i) => ({ id: i.id, titre: i.titre })),
  });
  const regle = proposerRegle({
    id: await prochainIdRegle(ctx),
    reponse: { id: reponseId, auteur: "po" },
    contenu: { type: "rattachement", motsCles: formulation.motsCles, itemId: choix },
    texte: formulation.texte,
    maintenant: ctx.maintenant(),
  });
  await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "proposer_regle", cible: regle.id, details: { sourceReponseId: reponseId, texte: regle.texte } });
  await enregistrerRegle(ctx.db, regle);
  const propId = await prochainId(ctx.db, "PR", "propositions");
  await ctx.db.query("INSERT INTO propositions (id, type, charge, resume, creee_le) VALUES ($1, 'regle', $2, $3, $4)", [propId, JSON.stringify({ regleId: regle.id, version: regle.version }), `Règle proposée : ${regle.texte}`, ctx.maintenant().toISOString()]);
  ctx.diffuser({ type: "regle", donnees: { id: regle.id, statut: "proposee" } });
  return regle;
}

/** « Un besoin nouveau » : crée l'élément à partir de la demande, y place la preuve (sûre), puis re-score. */
async function creerItemDepuisReponse(
  ctx: Contexte,
  q: LigneQuestion,
  feedbackId: string,
  citation: string,
  precedent: { id: string; item_id: string } | undefined,
): Promise<string> {
  const resume = typeof q.contexte.resume === "string" && q.contexte.resume ? q.contexte.resume : citation;
  const titre = couperTitre(resume);
  const type = q.contexte.nature === "bug" ? "bug" : "fonctionnalite";
  let complexite: "S" | "M" | "L" | "XL" = "M";
  try {
    complexite = (await ctx.llm.estimerComplexite({ titre }, [citation])).complexite;
  } catch (e) {
    if (!(e instanceof EchecLLM) || e.motif === "erreur") throw e;
  }
  const id = await prochainId(ctx.db, "N", "items");
  await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "po", action: "creer_item", cible: id, details: { titre, feedbackId, questionId: q.id } });
  await ctx.db.query("INSERT INTO items (id, titre, type, statut, complexite, alignement_objectif, cree_par) VALUES ($1, $2, $3, 'backlog', $4, FALSE, 'humain')", [id, titre, type, complexite]);
  if (precedent) {
    await ctx.db.query("UPDATE preuves SET item_id = $2, sure = TRUE, item_origine = $3 WHERE id = $1", [precedent.id, id, precedent.item_id]);
    await ctx.file.ajouter("rescorer", { itemId: precedent.item_id }, { cle: `rescorer:${precedent.item_id}` });
  } else {
    const pid = await prochainId(ctx.db, "P", "preuves");
    await ctx.db.query(
      "INSERT INTO preuves (id, item_id, feedback_id, compte_id, canal, recu_le, citation, sure) SELECT $1, $2, f.id, f.compte_id, f.canal, f.recu_le, $3, TRUE FROM feedbacks f WHERE f.id = $4 ON CONFLICT DO NOTHING",
      [pid, id, citation, feedbackId],
    );
  }
  await ctx.file.ajouter("rescorer", { itemId: id }, { cle: `rescorer:${id}` });
  ctx.diffuser({ type: "classement", donnees: { itemCree: id } });
  return id;
}

/**
 * Fusion décidée par le PO : les preuves de B passent sur A en gardant leur origine, et B est clos.
 * La fusion est réversible : voir defaireFusion.
 */
async function fusionner(ctx: Contexte, itemA: string, itemB: string, reponseId: string): Promise<void> {
  await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "po", action: "fusionner", cible: itemB, details: { dans: itemA, reponseId } });
  // Un feedback déjà rattaché aux deux items ne garde que sa preuve sur A.
  await ctx.db.query("DELETE FROM preuves p WHERE p.item_id = $2 AND EXISTS (SELECT 1 FROM preuves q WHERE q.item_id = $1 AND q.feedback_id = p.feedback_id)", [itemA, itemB]);
  await ctx.db.query("UPDATE preuves SET item_id = $1, item_origine = $2 WHERE item_id = $2", [itemA, itemB]);
  await ctx.db.query("UPDATE items SET statut = 'termine' WHERE id = $1", [itemB]);
  await ctx.db.query("UPDATE propositions SET statut = 'expiree', decidee_le = now() WHERE statut = 'en_attente' AND charge->>'itemId' = $1", [itemB]);
  await ctx.file.ajouter("rescorer", { itemId: itemA }, { cle: `rescorer:${itemA}` });
  ctx.diffuser({ type: "classement", donnees: { fusion: { itemA, itemB } } });
}

/** Défait une fusion : les preuves venues de B y retournent, et B redevient actif. */
export async function defaireFusion(ctx: Contexte, itemB: string): Promise<{ preuvesRendues: number }> {
  const r = await ctx.db.query<{ item_id: string }>("SELECT DISTINCT item_id FROM preuves WHERE item_origine = $1", [itemB]);
  if (r.rows.length === 0) throw new Error(`Aucune fusion à défaire pour ${itemB}`);
  await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "po", action: "defaire_fusion", cible: itemB });
  const rendues = await ctx.db.query<{ id: string }>("UPDATE preuves SET item_id = $1, item_origine = NULL WHERE item_origine = $1 RETURNING id", [itemB]);
  await ctx.db.query("UPDATE items SET statut = CASE WHEN cree_par = 'agent' THEN 'candidat' ELSE 'backlog' END WHERE id = $1 AND statut = 'termine'", [itemB]);
  for (const itemId of new Set([itemB, ...r.rows.map((x) => x.item_id)])) await ctx.file.ajouter("rescorer", { itemId }, { cle: `rescorer:${itemId}` });
  ctx.diffuser({ type: "classement", donnees: { fusionDefaite: itemB } });
  return { preuvesRendues: rendues.rows.length };
}

async function prochainIdRegle(ctx: Contexte): Promise<string> {
  const r = await ctx.db.query<{ n: number }>("SELECT COUNT(DISTINCT id)::int AS n FROM regles");
  return `D${String((r.rows[0]?.n ?? 0) + 1).padStart(2, "0")}`;
}

/** Le PO valide ou rejette une règle proposée. Une règle qui en contredit une autre n'est pas activée. */
export async function deciderRegle(ctx: Contexte, regleId: string, accepter: boolean): Promise<{ statut: string; contradictions: string[] }> {
  const regles = await chargerRegles(ctx.db);
  const regle = regles.filter((r) => r.id === regleId && r.statut === "proposee").at(-1);
  if (!regle) throw new Error(`Aucune règle proposée ${regleId}`);
  if (!accepter) {
    await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "po", action: "rejeter_regle", cible: regleId });
    await enregistrerRegle(ctx.db, { ...regle, statut: "rejetee" });
    await fermerProposition(ctx, "regle", regleId, "refusee");
    ctx.diffuser({ type: "regle", donnees: { id: regleId, statut: "rejetee" } });
    return { statut: "rejetee", contradictions: [] };
  }
  const r = activerRegle(regle, regles, ctx.maintenant());
  if (r.contradictions.length > 0) return { statut: "proposee", contradictions: r.contradictions };

  // Non-régression par règle : avec la nouvelle règle, chaque règle de rattachement active
  // (et la nouvelle) doit encore rattacher son cas d'origine à l'item choisi par le PO.
  const actives = [...regles.filter((x) => x.statut === "active" && x.id !== regleId), r.regle];
  const casses = verifierDoctrine(actives, await casSources(ctx, actives));
  if (casses.length > 0) {
    return {
      statut: "proposee",
      contradictions: casses.map((c) => `Avec cette règle, le cas d'origine de ${c.regleId} (« ${c.texte.slice(0, 80)} ») ne serait plus rattaché à ${c.itemAttendu}${c.obtenu ? ` mais à ${c.obtenu}` : " (cas devenu ambigu)"}.`),
    };
  }
  await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "po", action: "valider_regle", cible: regleId, details: { texte: regle.texte } });
  await enregistrerRegle(ctx.db, r.regle);
  await fermerProposition(ctx, "regle", regleId, "acceptee");
  ctx.diffuser({ type: "regle", donnees: { id: regleId, statut: "active" } });
  return { statut: "active", contradictions: [] };
}

/** Cas d'origine des règles de rattachement : la demande sur laquelle le PO a tranché, retrouvée par sa réponse. */
export async function casSources(ctx: Contexte, regles: Regle[]): Promise<CasSource[]> {
  const cas: CasSource[] = [];
  for (const r of regles) {
    if (r.contenu.type !== "rattachement") continue;
    const q = await ctx.db.query<{ citation: string | null; resume: string | null }>(
      "SELECT q.contexte->>'citation' AS citation, q.contexte->>'resume' AS resume FROM reponses rp JOIN questions q ON q.id = rp.question_id WHERE rp.id = $1",
      [r.sourceReponseId],
    );
    const source = q.rows[0];
    if (source?.citation) cas.push({ regleId: r.id, texte: `${source.resume ?? ""} ${source.citation}`, itemAttendu: r.contenu.itemId });
  }
  return cas;
}

/** Vérifie toute la doctrine active contre ses cas d'origine (utilisé par le banc et à la demande). */
export async function verifierDoctrineActive(ctx: Contexte): Promise<{ regles: number; casses: string[] }> {
  const actives = (await chargerRegles(ctx.db)).filter((r) => r.statut === "active");
  const casses = verifierDoctrine(actives, await casSources(ctx, actives));
  return { regles: actives.length, casses: casses.map((c) => `${c.regleId} : ${c.itemAttendu} attendu, ${c.obtenu ?? "ambigu"} obtenu`) };
}

async function fermerProposition(ctx: Contexte, type: string, cible: string, statut: "acceptee" | "refusee"): Promise<void> {
  const champ = type === "regle" ? "regleId" : "itemId";
  await ctx.db.query(
    `UPDATE propositions SET statut = $3, decidee_le = now() WHERE type = $1 AND charge->>'${champ}' = $2 AND statut = 'en_attente'`,
    [type, cible, statut],
  );
  ctx.diffuser({ type: "proposition", donnees: { type, cible, statut } });
}

/** Décision du PO sur une proposition de l'agent (nouvel item, story prête, ordre du backlog). */
export async function deciderProposition(ctx: Contexte, propositionId: string, accepter: boolean, options: { portee?: "tout" | "top" } = {}): Promise<void> {
  const r = await ctx.db.query<{ id: string; type: string; charge: Record<string, string>; statut: string }>("SELECT * FROM propositions WHERE id = $1", [propositionId]);
  const p = r.rows[0];
  if (!p) throw new Error(`Proposition introuvable : ${propositionId}`);
  if (p.statut !== "en_attente") throw new Error(`Proposition déjà décidée (${p.statut})`);
  if (p.type === "regle") {
    const r = await deciderRegle(ctx, String(p.charge.regleId), accepter);
    // Un refus (contradiction, cas d'origine cassé) remonte au PO : avant, il était avalé et l'écran affichait un succès.
    if (accepter && r.statut !== "active") throw new Error(`Règle non activée : ${r.contradictions.join(" ; ") || "elle reste proposée"}`);
    return;
  }
  const partielle = accepter && p.type === "ordre_backlog" && options.portee === "top";
  // Journalisé avant d'agir.
  await journaliser(ctx.db, {
    horodatage: ctx.maintenant(),
    acteur: "po",
    action: accepter ? "accepter_proposition" : "refuser_proposition",
    cible: propositionId,
    details: { type: p.type, charge: p.charge, ...(partielle ? { portee: `top ${PARAMETRES.alertes.tailleTop}` } : {}) },
  });
  // Le PO n'accepte que le haut du classement : le top proposé prend la tête, le reste de l'ordre officiel garde son ordre.
  if (partielle) await accepterHautDeLOrdre(ctx, propositionId, p.charge.ordre as unknown as string[]);
  if (p.type === "decoupage") await deciderDecoupage(ctx, p.charge as unknown as { storyId: string; itemId: string; enfants: string[] }, accepter);
  if (accepter && p.type === "nouvel_item") await ctx.db.query("UPDATE items SET statut = 'backlog' WHERE id = $1 AND statut = 'candidat'", [p.charge.itemId]);
  if (!accepter && p.type === "nouvel_item") await ctx.db.query("UPDATE items SET statut = 'termine' WHERE id = $1 AND statut = 'candidat'", [p.charge.itemId]);
  if (accepter && p.type === "story_prete") await ctx.db.query("UPDATE stories SET statut = 'prete' WHERE id = $1", [p.charge.storyId]);
  if (accepter && p.type === "export_jira") await exporterStory(ctx, String(p.charge.storyId));
  if (accepter && p.type === "effort") await appliquerEffort(ctx, String(p.charge.itemId), lireTaille(p.charge.apres));
  await ctx.db.query("UPDATE propositions SET statut = $2, decidee_le = now() WHERE id = $1", [propositionId, accepter ? "acceptee" : "refusee"]);
  ctx.diffuser({ type: "proposition", donnees: { id: propositionId, statut: accepter ? "acceptee" : "refusee" } });

  // Une story validée peut partir dans l'outil de l'équipe : l'agent le propose, le PO décide encore une fois.
  if (accepter && p.type === "story_prete" && ctx.suivi) {
    const propId = await prochainId(ctx.db, "PR", "propositions");
    await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "proposer_export", cible: propId, details: { storyId: p.charge.storyId, vers: ctx.suivi.nom } });
    await ctx.db.query("INSERT INTO propositions (id, type, charge, resume, creee_le) VALUES ($1, 'export_jira', $2, $3, $4)", [
      propId,
      JSON.stringify({ storyId: p.charge.storyId, itemId: p.charge.itemId }),
      `Exporter vers ${ctx.suivi.nom} la story validée de « ${(await ctx.db.query<{ titre: string }>("SELECT titre FROM items WHERE id = $1", [p.charge.itemId])).rows[0]?.titre ?? p.charge.itemId} »`,
      ctx.maintenant().toISOString(),
    ]);
    ctx.diffuser({ type: "proposition", donnees: { id: propId, type: "export_jira" } });
  }
}

/**
 * Acceptation du seul haut de l'ordre proposé (audit du 15/11/2026) : la proposition se déclenche quand le top change,
 * et accepter tout l'ordre imposait aussi les reculs du bas du backlog. L'ordre accepté est gardé à côté de celui proposé.
 */
async function accepterHautDeLOrdre(ctx: Contexte, propositionId: string, propose: string[]): Promise<void> {
  const n = PARAMETRES.alertes.tailleTop;
  const haut = propose.slice(0, n);
  const officiel = await ordreOfficiel(ctx);
  const ordreAccepte = [...haut, ...officiel.filter((id) => !haut.includes(id))];
  await ctx.db.query("UPDATE propositions SET charge = charge || $2::jsonb WHERE id = $1", [propositionId, JSON.stringify({ ordreAccepte, portee: "top" })]);
}

/**
 * Découpage d'une story : accepté, les stories proposées deviennent des brouillons à valider, et la story d'origine
 * est remplacée ; refusé, les stories proposées sont écartées et la story d'origine reste.
 */
async function deciderDecoupage(ctx: Contexte, charge: { storyId: string; itemId: string; enfants: string[] }, accepter: boolean): Promise<void> {
  const enfants = Array.isArray(charge.enfants) ? charge.enfants.map(String) : [];
  if (!accepter) {
    await ctx.db.query("UPDATE stories SET statut = 'refusee' WHERE id = ANY($1) AND statut = 'proposee'", [enfants]);
    ctx.diffuser({ type: "story", donnees: { id: charge.storyId, decoupage: "refuse" } });
    return;
  }
  await ctx.db.query("UPDATE stories SET statut = 'remplacee' WHERE id = $1", [charge.storyId]);
  await ctx.db.query("UPDATE stories SET statut = 'brouillon' WHERE id = ANY($1) AND statut = 'proposee'", [enfants]);
  // La validation de la story d'origine n'a plus d'objet : chaque nouvelle story se valide à son tour.
  await ctx.db.query("UPDATE propositions SET statut = 'expiree', decidee_le = now() WHERE type = 'story_prete' AND statut = 'en_attente' AND charge->>'storyId' = $1", [charge.storyId]);
  const titre = (await ctx.db.query<{ titre: string }>("SELECT titre FROM items WHERE id = $1", [charge.itemId])).rows[0]?.titre ?? charge.itemId;
  for (const [i, storyId] of enfants.entries()) {
    const propId = await prochainId(ctx.db, "PR", "propositions");
    await ctx.db.query("INSERT INTO propositions (id, type, charge, resume, creee_le) VALUES ($1, 'story_prete', $2, $3, $4)", [
      propId,
      JSON.stringify({ storyId, itemId: charge.itemId }),
      `Story à valider pour « ${titre} » (${i + 1}/${enfants.length}, après découpage)`,
      ctx.maintenant().toISOString(),
    ]);
  }
  ctx.diffuser({ type: "story", donnees: { id: charge.storyId, decoupage: "accepte" } });
}

/**
 * Le PO rattache un verbatim à un autre élément, ou le retire de tout score (« ignorer »). Correction du jugement
 * de l'agent : journalisée comme décision du PO, réversible (l'élément d'origine est gardé sur la preuve).
 * Elle ne crée pas de règle de doctrine : une règle ne naît que d'une réponse à une question de l'agent.
 */
export async function corrigerRattachement(ctx: Contexte, preuveId: string, cible: string): Promise<{ avant: string; apres: string }> {
  const r = await ctx.db.query<{ id: string; item_id: string; feedback_id: string; sure: boolean; citation: string }>("SELECT id, item_id, feedback_id, sure, citation FROM preuves WHERE id = $1", [preuveId]);
  const preuve = r.rows[0];
  if (!preuve) throw new Error(`Preuve introuvable : ${preuveId}`);
  if (cible !== "ignorer") {
    const item = (await ctx.db.query<{ statut: string }>("SELECT statut FROM items WHERE id = $1", [cible])).rows[0];
    if (!item || item.statut === "termine") throw new Error(`Élément introuvable ou clos : ${cible}`);
  }
  if (cible === preuve.item_id && preuve.sure) return { avant: preuve.item_id, apres: cible };

  await journaliser(ctx.db, {
    horodatage: ctx.maintenant(),
    acteur: "po",
    action: "corriger_rattachement",
    cible: preuve.feedback_id,
    details: { preuveId, avant: preuve.item_id, apres: cible, citation: preuve.citation },
  });
  if (cible === "ignorer") {
    await ctx.db.query("DELETE FROM preuves WHERE id = $1", [preuveId]);
  } else if (cible === preuve.item_id) {
    await ctx.db.query("UPDATE preuves SET sure = TRUE WHERE id = $1", [preuveId]);
  } else {
    // Le même message déjà compté sur l'élément visé : on garde cette preuve-là, sûre, et on retire l'autre.
    const deja = await ctx.db.query<{ id: string }>("SELECT id FROM preuves WHERE item_id = $1 AND feedback_id = $2", [cible, preuve.feedback_id]);
    if (deja.rows[0]) {
      await ctx.db.query("UPDATE preuves SET sure = TRUE WHERE id = $1", [deja.rows[0].id]);
      await ctx.db.query("DELETE FROM preuves WHERE id = $1", [preuveId]);
    } else {
      await ctx.db.query("UPDATE preuves SET item_id = $2, sure = TRUE, item_origine = $3, regle_id = NULL WHERE id = $1", [preuveId, cible, preuve.item_id]);
    }
  }
  // Une question de rattachement encore ouverte sur ce message n'a plus d'objet : le PO a tranché autrement.
  if (!preuve.sure) {
    await ctx.db.query("UPDATE questions SET etat = 'expiree' WHERE type = 'rattachement' AND etat IN ('ouverte', 'relancee') AND contexte->>'feedbackId' = $1", [preuve.feedback_id]);
  }
  for (const itemId of new Set([preuve.item_id, cible].filter((x) => x !== "ignorer"))) {
    await ctx.file.ajouter("rescorer", { itemId }, { cle: `rescorer:${itemId}` });
  }
  ctx.diffuser({ type: "classement", donnees: { preuveId, avant: preuve.item_id, apres: cible } });
  return { avant: preuve.item_id, apres: cible };
}

export interface ModificationStory {
  enTantQue: string;
  jeVeux: string;
  afinDe: string;
  criteres: Array<{ etantDonne: string; quand: string; alors: string }>;
  casLimites: string[];
}

/**
 * Le PO réécrit une story. Les citations et la taille restent celles de l'agent : chaque citation reste vérifiée
 * mot pour mot. La version de l'agent est gardée, les contrôles du code sont refaits ; le verdict du juge, lui,
 * porte sur la version de l'agent, et le cockpit le dit.
 */
export async function modifierStory(ctx: Contexte, storyId: string, m: ModificationStory): Promise<void> {
  const r = await ctx.db.query<{ contenu: Story; statut: string; controles: Array<{ nom: string; ok: boolean; detail?: string }> }>("SELECT contenu, statut, controles FROM stories WHERE id = $1", [storyId]);
  const s = r.rows[0];
  if (!s) throw new Error(`Story introuvable : ${storyId}`);
  if (s.statut !== "brouillon" && s.statut !== "prete") throw new Error(`Cette story ne se modifie plus (${s.statut})`);
  const propre = (t: unknown, max = 600) => String(t ?? "").trim().slice(0, max);
  const criteres = (Array.isArray(m.criteres) ? m.criteres : [])
    .map((c) => ({ etantDonne: propre(c?.etantDonne), quand: propre(c?.quand), alors: propre(c?.alors) }))
    .filter((c) => c.etantDonne || c.quand || c.alors)
    .slice(0, 8);
  const contenu: Story = {
    ...s.contenu,
    enTantQue: propre(m.enTantQue),
    jeVeux: propre(m.jeVeux),
    afinDe: propre(m.afinDe),
    criteres,
    casLimites: (Array.isArray(m.casLimites) ? m.casLimites : []).map((c) => propre(c, 300)).filter(Boolean).slice(0, 10),
  };
  // Rien n'a changé : ce n'est pas une correction, et le taux de correction ne doit pas la compter.
  const champs = (x: Story) => JSON.stringify([x.enTantQue, x.jeVeux, x.afinDe, x.criteres, x.casLimites]);
  if (champs(contenu) === champs(s.contenu)) return;
  // Les contrôles de forme sont refaits ; celui des citations ne change pas, puisque les citations ne changent pas.
  const citations = s.controles.find((c) => c.nom === "citations_verifiees");
  const controles = [...controlerStory(contenu), ...(citations ? [citations] : [])];
  await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "po", action: "modifier_story", cible: storyId, details: { itemId: s.contenu.itemId, controlesKo: controles.filter((c) => !c.ok).map((c) => c.nom) } });
  await ctx.db.query("UPDATE stories SET contenu_agent = COALESCE(contenu_agent, contenu), contenu = $2, controles = $3, modifiee_le = now() WHERE id = $1", [storyId, JSON.stringify(contenu), JSON.stringify(controles)]);
  ctx.diffuser({ type: "story", donnees: { id: storyId, modifiee: true } });
}

const TAILLES: readonly Complexite[] = ["S", "M", "L", "XL"];

function lireTaille(v: unknown): Complexite {
  if (typeof v === "string" && (TAILLES as readonly string[]).includes(v)) return v as Complexite;
  throw new Error(`Taille inconnue : ${String(v)} (S, M, L ou XL)`);
}

/** Applique une taille à un élément, clôt les propositions d'effort qui l'attendaient et relance son score. */
async function appliquerEffort(ctx: Contexte, itemId: string, complexite: Complexite): Promise<void> {
  await ctx.db.query("UPDATE items SET complexite = $2 WHERE id = $1", [itemId, complexite]);
  await ctx.db.query("UPDATE propositions SET statut = 'expiree', decidee_le = now() WHERE type = 'effort' AND statut = 'en_attente' AND charge->>'itemId' = $1", [itemId]);
  await ctx.file.ajouter("rescorer", { itemId }, { cle: `rescorer:${itemId}` });
  ctx.diffuser({ type: "classement", donnees: { itemId, complexite } });
}

/**
 * Le PO corrige l'effort d'un élément (sa taille S, M, L ou XL). C'est une correction du jugement de l'agent :
 * elle est journalisée comme décision du PO et compte dans le taux de correction.
 */
export async function corrigerEffort(ctx: Contexte, itemId: string, taille: string): Promise<{ avant: Complexite; apres: Complexite }> {
  const apres = lireTaille(taille);
  const r = await ctx.db.query<{ complexite: Complexite; statut: string }>("SELECT complexite, statut FROM items WHERE id = $1", [itemId]);
  const item = r.rows[0];
  if (!item || item.statut === "termine") throw new Error(`Élément introuvable ou clos : ${itemId}`);
  if (item.complexite === apres) return { avant: item.complexite, apres };
  await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "po", action: "corriger_effort", cible: itemId, details: { avant: item.complexite, apres } });
  await appliquerEffort(ctx, itemId, apres);
  return { avant: item.complexite, apres };
}

/** Export d'une story validée vers l'outil de suivi, journalisé avant l'appel. */
async function exporterStory(ctx: Contexte, storyId: string): Promise<void> {
  if (!ctx.suivi) throw new Error("Aucun outil de suivi configuré");
  const r = await ctx.db.query<{ contenu: Story; item_id: string; statut: string; titre: string }>(
    "SELECT s.contenu, s.item_id, s.statut, i.titre FROM stories s JOIN items i ON i.id = s.item_id WHERE s.id = $1",
    [storyId],
  );
  const s = r.rows[0];
  if (!s) throw new Error(`Story introuvable : ${storyId}`);
  if (s.statut !== "prete") throw new Error("Seule une story validée par le PO peut être exportée");
  await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "exporter_story", cible: storyId, details: { vers: ctx.suivi.nom } });
  const ticket = await ctx.suivi.creerTicket(s.contenu, s.titre);
  await ctx.db.query("UPDATE stories SET statut = 'exportee', ticket_cle = $2, ticket_url = $3 WHERE id = $1", [storyId, ticket.cle, ticket.url]);
  ctx.diffuser({ type: "story", donnees: { id: storyId, ticket: ticket.cle } });
}

/** Passage du résumé : les questions sans réponse sont relancées une fois, puis expirent. Rien d'irréversible n'est appliqué. */
export async function passerResume(ctx: Contexte): Promise<{ relancees: string[]; expirees: string[] }> {
  const limite = new Date(ctx.maintenant().getTime() - PARAMETRES.questions.delaiAvantRelanceHeures * 3_600_000);
  const r = await ctx.db.query<{ id: string; etat: "ouverte" | "relancee"; relances: number }>(
    "SELECT id, etat, relances FROM questions WHERE etat IN ('ouverte', 'relancee') AND posee_le IS NOT NULL AND posee_le <= $1",
    [limite.toISOString()],
  );
  const suites = r.rows.map((q) => ({ id: q.id, ...etatApresResume(q) }));
  const relancees = suites.filter((s) => s.etat !== "expiree").map((s) => s.id);
  const expirees = suites.filter((s) => s.etat === "expiree").map((s) => s.id);
  if (suites.length > 0) await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "relancer_questions", details: { relancees, expirees } });
  for (const s of suites) {
    // La relance repose la question : le délai repart de maintenant.
    await ctx.db.query("UPDATE questions SET etat = $2, relances = $3, posee_le = $4 WHERE id = $1", [s.id, s.etat, s.relances, ctx.maintenant().toISOString()]);
  }
  await poserQuestions(ctx);
  return { relancees, expirees };
}

/* ---------- Une doctrine qui se lit avant d'être validée, et qui se retire ---------- */
/*
 * Audit d'usage : la doctrine se validait à l'aveugle. Les mots-clés qui rattachent une demande sans lecture
 * par le modèle n'étaient montrés nulle part, une règle active ne pouvait pas être retirée, et les refus
 * s'écrivaient en identifiants. Les fonctions qui suivent ne font que lire, sauf retirerRegle.
 */

/** Un élément du backlog désigné par une règle, avec son titre : l'identifiant seul ne dit rien au PO. */
export interface ElementRegle {
  id: string;
  titre: string;
}

/** Le cas d'origine d'une règle : la question posée au PO, la demande sur laquelle il a tranché, et sa réponse. */
export interface OrigineRegle {
  reponseId: string;
  questionId: string;
  question: string;
  resume: string | null;
  citation: string | null;
  feedbackId: string | null;
  choix: string;
  /** La réponse en clair : le titre de l'élément choisi, ou le libellé de l'option retenue. */
  choixLibelle: string;
  repondueLe: string;
}

/** Une demande déjà reçue que la règle rattacherait à son élément. */
export interface DemandeCaptee {
  feedbackId: string;
  resume: string;
  citation: string;
  /** Où la demande compte aujourd'hui. Null si elle n'a pas de preuve propre (écartée par le PO, ou doublon d'une autre demande du même message). */
  actuel: { element: ElementRegle; sure: boolean; regleId: string | null } | null;
  /** Vrai si la règle la placerait sur un autre élément que celui de sa preuve actuelle. */
  changerait: boolean;
}

/** Une demande que la règle toucherait, mais qu'une autre règle active envoie ailleurs : aucune des deux ne s'appliquerait. */
export interface DemandeAmbigue {
  feedbackId: string;
  resume: string;
  citation: string;
  concurrentes: Array<{ regleId: string; element: ElementRegle }>;
}

export interface ContradictionRegle {
  regleId: string;
  texte: string;
  message: string;
}

/** Un cas d'origine que la règle casserait : le PO avait tranché, la doctrine ne retrouverait plus son choix. */
export interface CasCasse {
  regleId: string;
  /** Vrai si c'est le cas d'origine de la règle examinée elle-même. */
  propre: boolean;
  demande: string;
  attendu: ElementRegle;
  /** Null : le cas deviendrait ambigu (deux règles viseraient des éléments différents). */
  obtenu: ElementRegle | null;
  message: string;
}

/** Une règle active ou proposée qui vise la même chose, avec des mots-clés qui se recouvrent. */
export interface RegleProche {
  regleId: string;
  version: number;
  statut: StatutRegle;
  texte: string;
  motsCles: string[];
  /** Les mots-clés qui se recouvrent, en clair : « projet » / « projets ». */
  recouvrements: string[];
  message: string;
}

/** Ce que ferait une règle si elle était active, calculé par le code sur les demandes déjà reçues. */
export interface ApercuRegle {
  regleId: string;
  version: number;
  statut: StatutRegle;
  type: ContenuRegle["type"];
  motsCles: string[];
  elements: ElementRegle[];
  /** Nombre de demandes déjà reçues rejouées (les messages mis en quarantaine sont exclus). */
  demandesLues: number;
  captees: DemandeCaptee[];
  /** Parmi les demandes captées, celles qui changeraient d'élément. */
  changements: number;
  ambigues: DemandeAmbigue[];
  contradictions: ContradictionRegle[];
  casCasses: CasCasse[];
  proches: RegleProche[];
  /** Vrai si la validation serait refusée : contradiction avec la doctrine active, ou cas d'origine cassé. */
  bloquante: boolean;
  /** La synthèse en une phrase : « Si vous validez : … ». */
  resume: string;
}

const LIBELLE_STATUT: Record<StatutRegle, string> = { proposee: "proposée", active: "active", rejetee: "rejetée", retiree: "retirée" };

function texteOuNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function dateIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

function extrait(s: string, max = 140): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function motsClesDe(c: ContenuRegle): string[] {
  return c.type === "rattachement" ? c.motsCles : [];
}

function cle(m: string): string {
  return normaliser(m).toLowerCase();
}

async function titresItems(ctx: Contexte): Promise<Map<string, string>> {
  // Avec les items terminés : un élément absorbé par une fusion garde un titre lisible.
  return new Map((await chargerItems(ctx.db, true)).map((i) => [i.id, i.titre]));
}

function elementDe(id: string, titres: Map<string, string>): ElementRegle {
  return { id, titre: titres.get(id) ?? id };
}

/** Les éléments du backlog que vise une règle, avec leurs titres. */
export function elementsVises(c: ContenuRegle, titres: Map<string, string>): ElementRegle[] {
  if (c.type === "rattachement") return [elementDe(c.itemId, titres)];
  if (c.type === "paire_distincte") return [elementDe(c.itemA, titres), elementDe(c.itemB, titres)];
  return [];
}

/** Les cas d'origine, par identifiant de réponse du PO. */
export async function originesRegles(ctx: Contexte, reponseIds: string[], titresConnus?: Map<string, string>): Promise<Map<string, OrigineRegle>> {
  const ids = [...new Set(reponseIds)];
  if (ids.length === 0) return new Map();
  const titres = titresConnus ?? (await titresItems(ctx));
  const r = await ctx.db.query<{ id: string; question_id: string; choix: string; recue_le: unknown; enonce: string; contexte: Record<string, unknown>; options: Array<{ valeur: string; libelle: string }> }>(
    "SELECT rp.id, rp.question_id, rp.choix, rp.recue_le, q.enonce, q.contexte, q.options FROM reponses rp JOIN questions q ON q.id = rp.question_id WHERE rp.id = ANY($1)",
    [ids],
  );
  return new Map(
    r.rows.map((x) => [
      x.id,
      {
        reponseId: x.id,
        questionId: x.question_id,
        question: x.enonce,
        resume: texteOuNull(x.contexte.resume),
        citation: texteOuNull(x.contexte.citation),
        feedbackId: texteOuNull(x.contexte.feedbackId),
        choix: x.choix,
        choixLibelle: titres.get(x.choix) ?? x.options.find((o) => o.valeur === x.choix)?.libelle ?? x.choix,
        repondueLe: dateIso(x.recue_le),
      },
    ]),
  );
}

/** Deux mots-clés se recouvrent quand, une fois normalisés, l'un contient l'autre (« projet » et « projets »). */
function recouvrements(a: string[], b: string[]): string[] {
  const vus = new Set<string>();
  for (const x of a.map(cle)) {
    for (const y of b.map(cle)) {
      if (x === y) vus.add(`« ${x} »`);
      else if (x.includes(y) || y.includes(x)) vus.add(`« ${x} » / « ${y} »`);
    }
  }
  return [...vus];
}

function phraseCaptures(prefixe: string, n: number, m: number, cible: string): string {
  if (n === 0) return `${prefixe} : aucune demande déjà reçue ne serait rattachée à « ${cible} ».`;
  const demandes = n > 1 ? `${n} demandes déjà reçues seraient rattachées` : "1 demande déjà reçue serait rattachée";
  const dont = m === 0 ? "dont aucune ne changerait d'élément" : m > 1 ? `dont ${m} changeraient d'élément` : "dont 1 changerait d'élément";
  return `${prefixe} : ${demandes} à « ${cible} », ${dont}.`;
}

/**
 * Aperçu d'une règle avant décision : ce qu'elle ferait si elle était active, parmi les règles actives.
 * Les contrôles sont ceux de deciderRegle (contradictions, puis non-régression des cas d'origine),
 * étendus aux demandes déjà reçues et aux règles qui visent le même élément. Lecture seule.
 * Renvoie null si la règle n'existe pas.
 */
export async function apercuRegle(ctx: Contexte, regleId: string): Promise<ApercuRegle | null> {
  const regles = await chargerRegles(ctx.db);
  const versions = regles.filter((r) => r.id === regleId);
  // Même version que deciderRegle : la dernière proposée, sinon la dernière active, sinon la dernière tout court.
  const regle = versions.filter((r) => r.statut === "proposee").at(-1) ?? versions.filter((r) => r.statut === "active").at(-1) ?? versions.at(-1);
  if (!regle) return null;

  const titres = await titresItems(ctx);
  const titre = (id: string): string => titres.get(id) ?? id;
  const supposee: Regle = { ...regle, statut: "active" };
  const autresActives = regles.filter((r) => r.statut === "active" && r.id !== regleId);
  const c = regle.contenu;
  const prefixe = regle.statut === "proposee" ? "Si vous validez" : regle.statut === "active" ? "Tant qu'elle reste active" : "Si elle était active";

  // 1. Contradictions : le contrôle du domaine, règle par règle, pour savoir laquelle est en cause.
  const contradictions: ContradictionRegle[] = [];
  for (const autre of autresActives) {
    const raisons = contradictionsDoctrine(supposee, [autre]);
    if (raisons.length === 0) continue;
    const a = autre.contenu;
    let message = raisons.join(" ; ");
    if (c.type === "rattachement" && a.type === "rattachement") {
      const communs = c.motsCles.map(cle).filter((m) => a.motsCles.map(cle).includes(m));
      const mots = `${communs.length > 1 ? "les mots-clés" : "le mot-clé"} ${communs.map((m) => `« ${m} »`).join(", ")}`;
      message = `La règle ${autre.id} (« ${extrait(autre.texte)} ») rattache déjà ${mots} à « ${titre(a.itemId)} ». Les deux règles ne peuvent pas être actives ensemble : rejetez celle-ci, ou retirez d'abord ${autre.id}.`;
    } else if (c.type === "ajustement_impact" && a.type === "ajustement_impact") {
      message = `La règle ${autre.id} (« ${extrait(autre.texte)} ») ajuste l'Impact en sens inverse pour les mêmes comptes.`;
    }
    contradictions.push({ regleId: autre.id, texte: autre.texte, message });
  }

  // 2. Non-régression : avec cette règle active, chaque règle de rattachement doit encore retrouver le choix du PO sur son cas d'origine.
  const actives = [...autresActives, supposee];
  const casses = verifierDoctrine(actives, await casSources(ctx, actives));
  const origines = await originesRegles(ctx, actives.map((r) => r.sourceReponseId), titres);
  const sourceDe = new Map(actives.map((r) => [r.id, r.sourceReponseId]));
  const casCasses: CasCasse[] = casses.map((k) => {
    const origine = origines.get(sourceDe.get(k.regleId) ?? "");
    const demande = extrait(origine?.citation ?? k.texte);
    const propre = k.regleId === regleId;
    const suite = k.obtenu ? ` mais à « ${titre(k.obtenu)} »` : " : deux règles y viseraient des éléments différents, et le cas deviendrait ambigu";
    const message = propre
      ? `Son propre cas d'origine (« ${demande} ») ne serait pas rattaché à « ${titre(k.itemAttendu)} »${suite}.`
      : `Le cas d'origine de la règle ${k.regleId} (« ${demande} ») ne serait plus rattaché à « ${titre(k.itemAttendu)} »${suite}.`;
    return { regleId: k.regleId, propre, demande, attendu: elementDe(k.itemAttendu, titres), obtenu: k.obtenu ? elementDe(k.obtenu, titres) : null, message };
  });

  // 3. Règles proches : même élément visé, mots-clés qui se recouvrent (active ou en attente de décision).
  const proches: RegleProche[] = [];
  const dernieres = new Map<string, Regle>();
  for (const r of regles) if (r.id !== regleId && (r.statut === "active" || r.statut === "proposee")) dernieres.set(r.id, r);
  for (const autre of dernieres.values()) {
    const a = autre.contenu;
    const etat = LIBELLE_STATUT[autre.statut];
    if (c.type === "rattachement" && a.type === "rattachement" && a.itemId === c.itemId) {
      const communs = recouvrements(c.motsCles, a.motsCles);
      if (communs.length === 0) continue;
      proches.push({
        regleId: autre.id,
        version: autre.version,
        statut: autre.statut,
        texte: autre.texte,
        motsCles: a.motsCles,
        recouvrements: communs,
        message: `La règle ${autre.id} (${etat}, « ${extrait(autre.texte)} ») vise déjà « ${titre(a.itemId)} » avec des mots-clés qui se recouvrent : ${communs.join(", ")}. Vérifiez que les deux ne font pas doublon.`,
      });
    } else if (c.type === "paire_distincte" && a.type === "paire_distincte" && new Set([c.itemA, c.itemB, a.itemA, a.itemB]).size === 2) {
      proches.push({ regleId: autre.id, version: autre.version, statut: autre.statut, texte: autre.texte, motsCles: [], recouvrements: [], message: `La règle ${autre.id} (${etat}) interdit déjà de fusionner « ${titre(a.itemA)} » et « ${titre(a.itemB)} ».` });
    } else if (c.type === "ajustement_impact" && a.type === "ajustement_impact" && a.plan === c.plan && a.alignementObjectif === c.alignementObjectif && Math.sign(a.crans) === Math.sign(c.crans)) {
      proches.push({ regleId: autre.id, version: autre.version, statut: autre.statut, texte: autre.texte, motsCles: [], recouvrements: [], message: `La règle ${autre.id} (${etat}, « ${extrait(autre.texte)} ») ajuste déjà l'Impact dans le même sens pour les mêmes comptes : les deux s'additionneraient.` });
    }
  }

  // 4. Les demandes déjà reçues que la règle capterait, rejouées comme le fait la chaîne (« résumé + citation »).
  const captees: DemandeCaptee[] = [];
  const ambigues: DemandeAmbigue[] = [];
  let demandesLues = 0;
  if (c.type === "rattachement") {
    const extractions = await ctx.db.query<{ feedback_id: string; demandes: Array<{ resume: string; citation: string }> }>(
      `SELECT e.feedback_id, e.demandes FROM extractions e JOIN feedbacks f ON f.id = e.feedback_id
       WHERE NOT e.injection_suspectee AND e.nature <> 'suspect' AND f.statut <> 'suspect'
       ORDER BY f.recu_le, f.id`,
    );
    // La preuve d'une demande porte sa citation exacte : c'est par elle qu'on la retrouve. Une preuve sûre prime.
    const preuves = await ctx.db.query<{ feedback_id: string; citation: string; item_id: string; sure: boolean; regle_id: string | null }>(
      "SELECT feedback_id, citation, item_id, sure, regle_id FROM preuves ORDER BY sure DESC, id",
    );
    const preuveDe = new Map<string, (typeof preuves.rows)[number]>();
    for (const p of preuves.rows) {
      const k = `${p.feedback_id}\u0000${p.citation}`;
      if (!preuveDe.has(k)) preuveDe.set(k, p);
    }
    for (const e of extractions.rows) {
      for (const d of e.demandes) {
        demandesLues++;
        const texte = `${d.resume} ${d.citation}`;
        if (!appliquerRattachement(texte, [supposee])) continue;
        const avec = appliquerRattachement(texte, actives);
        if (avec) {
          const p = preuveDe.get(`${e.feedback_id}\u0000${d.citation}`);
          captees.push({
            feedbackId: e.feedback_id,
            resume: d.resume,
            citation: d.citation,
            actuel: p ? { element: elementDe(p.item_id, titres), sure: p.sure, regleId: p.regle_id } : null,
            changerait: !!p && p.item_id !== c.itemId,
          });
        } else {
          const concurrentes = autresActives.flatMap((a) =>
            a.contenu.type === "rattachement" && a.contenu.itemId !== c.itemId && appliquerRattachement(texte, [a]) ? [{ regleId: a.id, element: elementDe(a.contenu.itemId, titres) }] : [],
          );
          ambigues.push({ feedbackId: e.feedback_id, resume: d.resume, citation: d.citation, concurrentes });
        }
      }
    }
    // Les changements d'abord : c'est ce que le PO doit regarder.
    captees.sort((x, y) => Number(y.changerait) - Number(x.changerait));
  }

  const changements = captees.filter((d) => d.changerait).length;
  let resume: string;
  if (c.type === "rattachement") resume = phraseCaptures(prefixe, captees.length, changements, titre(c.itemId));
  else if (c.type === "paire_distincte") resume = `${prefixe} : l'agent ne proposera plus de fusionner « ${titre(c.itemA)} » et « ${titre(c.itemB)} ».`;
  else resume = `${prefixe} : ${regle.texte}`;

  return {
    regleId: regle.id,
    version: regle.version,
    statut: regle.statut,
    type: c.type,
    motsCles: motsClesDe(c),
    elements: elementsVises(c, titres),
    demandesLues,
    captees,
    changements,
    ambigues,
    contradictions,
    casCasses,
    proches,
    bloquante: contradictions.length > 0 || casCasses.length > 0,
    resume,
  };
}

/**
 * Le PO retire une règle active. Journalisé avant l'écriture.
 * Les rattachements déjà faits restent ; les nouveaux feedbacks ne l'appliquent plus (seules les règles actives s'appliquent).
 * La version retirée est conservée, comme le fait la révision d'une règle.
 */
export async function retirerRegle(ctx: Contexte, regleId: string): Promise<{ statut: "retiree"; version: number }> {
  const regle = (await chargerRegles(ctx.db)).filter((r) => r.id === regleId && r.statut === "active").at(-1);
  if (!regle) throw new Error(`Aucune règle active ${regleId} : seule une règle active peut être retirée`);
  await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "po", action: "retirer_regle", cible: regleId, details: { version: regle.version, texte: regle.texte } });
  await enregistrerRegle(ctx.db, { ...regle, statut: "retiree" });
  ctx.diffuser({ type: "regle", donnees: { id: regleId, statut: "retiree" } });
  return { statut: "retiree", version: regle.version };
}
