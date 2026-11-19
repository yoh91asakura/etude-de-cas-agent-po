import type { EventEmitter } from "node:events";
import { journaliser } from "@po-agent/db";
import type { FastifyInstance } from "fastify";
import {
  decrireEcart,
  detecterTendance,
  expliquerEcart,
  PARAMETRES,
  proposerMoscow,
  STATUT_PARAMETRES,
  type DetailScore,
  type Filtre,
} from "@po-agent/domain";
import { cleFiltres, classement, converser, chargerComptes, chargerItems, chargerPreuves, corrigerEffort, corrigerRattachement, deciderProposition, modifierStory, type ModificationStory, deciderRegle, defaireFusion, ingerer, ordreOfficiel, passageDeFond, ordrePropose, prochainId, repondre, type Contexte } from "@po-agent/agent";
import type {
  AlerteApi,
  DetailItemApi,
  EntreeJournalApi,
  EtatApi,
  FeedbackApi,
  LigneClassement,
  LigneOfficielle,
  CategorieMoscow,
  MoscowApi,
  FicheFeedbackApi,
  FiltreVue,
  PreuveApi,
  ProduitApi,
  PropositionApi,
  ReponseConversationApi,
  QuestionApi,
  RegleApi,
  SanteApi,
  StoryApi,
} from "./contrat.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DOSSIER_SEED } from "./config.ts";
import { chargerItemsContexte, enrichirProposition, enrichirQuestion, ficheFeedback, type LignePropositionBrute, type LigneQuestionBrute } from "./contexte-decision.ts";
import { feedbacksDirects } from "./seed.ts";
import { apercuRegle, elementsVises, numeroterRangs, originesRegles, retirerRegle } from "@po-agent/agent";
import type { ContenuRegle } from "@po-agent/domain";
import type { ApercuRegleApi, RetraitRegleApi } from "./contrat.ts";

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

function lireFiltres(q: unknown): Filtre[] {
  const brut = typeof q === "object" && q && "filtres" in q ? String((q as { filtres?: string }).filtres ?? "") : "";
  return brut
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Filtre => s === "mrr" || s === "objectif");
}

async function lignesClassement(ctx: Contexte, filtres: Filtre[]): Promise<LigneClassement[]> {
  const scores = await classement(ctx, filtres);
  const items = new Map((await chargerItems(ctx.db, true)).map((i) => [i.id, i]));
  const comptes = await chargerComptes(ctx.db);
  const preuves = await chargerPreuves(ctx.db);
  const jugements = new Map(
    (await ctx.db.query<{ item_id: string; tirages: number[]; ecart_crans: number; regles: string[] }>("SELECT item_id, tirages, ecart_crans, regles FROM jugements_impact")).rows.map((j) => [j.item_id, j]),
  );
  const tranches = new Set(
    (await ctx.db.query<{ item_id: string }>("SELECT q.contexte->>'itemId' AS item_id FROM questions q JOIN reponses r ON r.question_id = q.id WHERE q.type = 'impact'")).rows.map((r) => r.item_id),
  );
  const avecStory = new Set((await ctx.db.query<{ item_id: string }>("SELECT DISTINCT item_id FROM stories")).rows.map((r) => r.item_id));
  const precedents = new Map(
    (
      await ctx.db.query<{ item_id: string; detail: DetailScore }>(
        `SELECT item_id, detail FROM (
           SELECT item_id, detail, ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY calcule_le DESC, id DESC) AS n FROM scores WHERE filtres = $1
         ) s WHERE n = 2`,
        [cleFiltres(filtres)],
      )
    ).rows.map((r) => [r.item_id, r.detail]),
  );
  const maintenant = ctx.maintenant();
  // Un seul comptage : seuls les éléments du backlog sont numérotés, comme dans l'ordre officiel et les propositions d'ordre.
  const rangs = numeroterRangs(
    scores.map((s) => s.itemId),
    new Map([...items.values()].map((i) => [i.id, i.statut])),
  );

  return scores.flatMap((s) => {
    const item = items.get(s.itemId);
    if (!item || item.statut === "termine") return [];
    const siennes = preuves.filter((p) => p.itemId === s.itemId);
    const sures = siennes.filter((p) => p.sure);
    const j = jugements.get(s.itemId);
    const precedent = precedents.get(s.itemId);
    const reglesCitees = [...new Set([...sures.map((p) => p.regleId).filter((x): x is string => !!x), ...(j?.regles ?? [])])];
    return [
      {
        rang: rangs.get(s.itemId)?.rang ?? 0,
        itemId: s.itemId,
        titre: item.titre,
        type: item.type,
        statut: item.statut,
        complexite: item.complexite,
        alignementObjectif: item.alignementObjectif,
        score: s.score,
        reach: s.reach,
        uniteReach: s.uniteReach,
        impact: s.impact,
        confidence: s.confidence,
        effort: s.effort,
        multiplicateurs: s.multiplicateurs,
        parSegment: s.parSegment,
        nbPreuves: s.preuvesComptees.length,
        tiragesImpact: (j?.tirages ?? []).map(Number),
        ecartImpact: Number(j?.ecart_crans ?? 0),
        impactTranchePO: tranches.has(s.itemId),
        tendance: detecterTendance(sures.map((p) => p.recuLe), maintenant),
        risqueDepart: sures.some((p) => comptes.get(p.compteId)?.risqueDepart),
        explication: precedent ? decrireEcart(expliquerEcart(precedent, s)) : null,
        reglesCitees,
        aUneStory: avecStory.has(s.itemId),
      } satisfies LigneClassement,
    ];
  });
}

type LigneStory = {
  id: string;
  item_id: string;
  statut: StoryApi["statut"];
  contenu: Record<string, unknown>;
  controles: StoryApi["controles"];
  jugement: StoryApi["jugement"];
  ticket_cle: string | null;
  ticket_url: string | null;
  parent_id?: string | null;
  modifiee_le?: unknown;
  /** Preuves sûres arrivées depuis la rédaction (calculé par la requête). */
  depuis?: number | null;
  /** Proposition « Story à valider » en attente (calculé par la requête). */
  validation?: string | null;
};

const CHAMPS_CALCULES = ["id", "itemId", "statut", "controles", "jugement", "ticket", "parentId", "modifiee", "preuvesDepuisRedaction", "propositionValidation"] as const;

function versStory(r: LigneStory): StoryApi {
  const c = r.contenu as unknown as Omit<StoryApi, (typeof CHAMPS_CALCULES)[number]>;
  return {
    id: r.id,
    itemId: r.item_id,
    statut: r.statut,
    ...c,
    controles: r.controles,
    jugement: r.jugement,
    ticket: r.ticket_cle && r.ticket_url ? { cle: r.ticket_cle, url: r.ticket_url } : null,
    parentId: r.parent_id ?? null,
    modifiee: r.modifiee_le !== null && r.modifiee_le !== undefined,
    preuvesDepuisRedaction: Number(r.depuis ?? 0),
    propositionValidation: r.validation ?? null,
  };
}

/** Les stories d'un élément, avec les preuves arrivées depuis leur rédaction et leur validation en attente. */
const SQL_STORIES = `SELECT s.*,
    (SELECT COUNT(*)::int FROM preuves p WHERE p.item_id = s.item_id AND p.sure AND p.cree_le > s.creee_le) AS depuis,
    (SELECT pr.id FROM propositions pr WHERE pr.type = 'story_prete' AND pr.statut = 'en_attente' AND pr.charge->>'storyId' = s.id ORDER BY pr.creee_le DESC LIMIT 1) AS validation
  FROM stories s WHERE s.item_id = $1 ORDER BY s.creee_le, s.id`;

export function enregistrerRoutes(app: FastifyInstance, ctx: Contexte, emetteur: EventEmitter): void {
  app.get("/api/etat", async (): Promise<EtatApi> => {
    const c = (
      await ctx.db.query<Record<string, number>>(
        `SELECT
          (SELECT COUNT(*)::int FROM feedbacks) AS feedbacks,
          (SELECT COUNT(*)::int FROM feedbacks WHERE statut = 'traite') AS traites,
          (SELECT COUNT(*)::int FROM feedbacks WHERE statut IN ('recu', 'en_attente')) AS en_attente,
          (SELECT COUNT(*)::int FROM feedbacks WHERE statut = 'suspect') AS suspects,
          (SELECT COUNT(*)::int FROM questions WHERE etat IN ('ouverte', 'relancee') AND posee_le IS NOT NULL) AS questions,
          (SELECT COUNT(*)::int FROM questions WHERE etat = 'ouverte' AND posee_le IS NULL) AS en_file,
          (SELECT COUNT(*)::int FROM propositions WHERE statut = 'en_attente') AS propositions`,
      )
    ).rows[0]!;
    const directs = await feedbacksDirects();
    const deja = new Set((await ctx.db.query<{ id: string }>("SELECT id FROM feedbacks WHERE canal = 'direct'")).rows.map((r) => r.id));
    return {
      fournisseur: ctx.llm.nom,
      fournisseurFactice: ctx.llm.nom.startsWith("faux"),
      maintenant: ctx.maintenant().toISOString(),
      parametresValides: STATUT_PARAMETRES.valide,
      compteurs: {
        feedbacks: c.feedbacks ?? 0,
        traites: c.traites ?? 0,
        enAttente: c.en_attente ?? 0,
        suspects: c.suspects ?? 0,
        questionsOuvertes: c.questions ?? 0,
        propositionsEnAttente: c.propositions ?? 0,
      },
      simulateurRestants: directs.filter((d) => !deja.has(d.id)).length,
      vueReference: [...PARAMETRES.alertes.vueReference] as FiltreVue[],
      questionsEnFile: c.en_file ?? 0,
      outilSuiviBranche: Boolean(ctx.suivi),
    };
  });

  // Le produit fictif du scénario : sans lui, le PO ne peut pas juger une demande.
  app.get("/api/produit", async (): Promise<ProduitApi> => {
    const fiche = JSON.parse(await readFile(path.join(DOSSIER_SEED, "produit.json"), "utf8")) as Omit<ProduitApi, "comptes" | "mrrTotal" | "itemsBacklog" | "feedbacks">;
    const comptes = await ctx.db.query<{ plan: ProduitApi["comptes"][number]["plan"]; n: number; total: number; min: number; max: number }>(
      "SELECT plan, COUNT(*)::int AS n, SUM(mrr)::float AS total, MIN(mrr)::float AS min, MAX(mrr)::float AS max FROM comptes GROUP BY plan",
    );
    const ordre = ["free", "pro", "business"];
    const items = (await ctx.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM items WHERE statut IN ('backlog', 'pret')")).rows[0]?.n ?? 0;
    const canaux = await ctx.db.query<{ canal: string; n: number }>("SELECT canal, COUNT(*)::int AS n FROM feedbacks GROUP BY canal");
    return {
      nom: fiche.nom,
      activite: fiche.activite,
      objectifTrimestre: fiche.objectifTrimestre,
      dateScenario: fiche.dateScenario,
      source: fiche.source,
      comptes: comptes.rows
        .map((c) => ({ plan: c.plan, nombre: c.n, mrrTotal: Number(c.total), mrrMin: Number(c.min), mrrMax: Number(c.max) }))
        .sort((a, b) => ordre.indexOf(a.plan) - ordre.indexOf(b.plan)),
      mrrTotal: comptes.rows.reduce((a, c) => a + Number(c.total), 0),
      itemsBacklog: items,
      feedbacks: { total: canaux.rows.reduce((a, c) => a + c.n, 0), parCanal: Object.fromEntries(canaux.rows.map((c) => [c.canal, c.n])) },
    };
  });

  app.get<{ Params: { id: string } }>("/api/feedbacks/:id", async (req, reply): Promise<FicheFeedbackApi | undefined> => {
    const fiche = await ficheFeedback(ctx, req.params.id);
    if (!fiche) {
      void reply.code(404).send({ erreur: "Feedback introuvable" });
      return;
    }
    return fiche;
  });

  app.get("/api/classement", async (req): Promise<LigneClassement[]> => lignesClassement(ctx, lireFiltres(req.query)));

  app.get<{ Params: { id: string } }>("/api/items/:id", async (req, reply): Promise<DetailItemApi | undefined> => {
    const id = req.params.id;
    const item = (await ctx.db.query<{ description: string | null }>("SELECT description FROM items WHERE id = $1", [id])).rows[0];
    if (!item) {
      void reply.code(404).send({ erreur: "Item introuvable" });
      return;
    }
    const ligne = (await lignesClassement(ctx, lireFiltres(req.query))).find((l) => l.itemId === id) ?? null;
    const preuves = await ctx.db.query<{ id: string; feedback_id: string; compte_id: string; nom: string; plan: PreuveApi["compte"]["plan"]; mrr: number; canal: string; recu_le: unknown; citation: string; sure: boolean; regle_id: string | null; item_origine: string | null; origine_fusionnee: boolean | null }>(
      "SELECT p.*, c.nom, c.plan, c.mrr, (io.statut = 'termine') AS origine_fusionnee FROM preuves p JOIN comptes c ON c.id = p.compte_id LEFT JOIN items io ON io.id = p.item_origine WHERE p.item_id = $1 ORDER BY p.recu_le DESC",
      [id],
    );
    const jugement = (await ctx.db.query<{ justification: string; valeur_justification: string | null; tirages: number[] }>("SELECT justification, valeur_justification, tirages FROM jugements_impact WHERE item_id = $1", [id])).rows[0];
    // Un jugement ancien n'a pas cette valeur : l'agent gardait alors la justification du premier tirage.
    const valeurJustification = jugement ? (jugement.valeur_justification !== null ? Number(jugement.valeur_justification) : (jugement.tirages[0] ?? null)) : null;
    const historique = await ctx.db.query<{ calcule_le: unknown; detail: DetailScore }>("SELECT calcule_le, detail FROM scores WHERE item_id = $1 AND filtres = $2 ORDER BY calcule_le, id", [id, cleFiltres(lireFiltres(req.query))]);
    const lignesStories = (await ctx.db.query<LigneStory>(SQL_STORIES, [id])).rows;
    // Les stories en vigueur (après un découpage accepté, plusieurs) ; la plus récente reste « la » story de l'élément.
    const actives = lignesStories.filter((s) => s.statut === "brouillon" || s.statut === "prete" || s.statut === "exportee");
    const story = actives[actives.length - 1];
    const propDecoupage = (
      await ctx.db.query<{ id: string; charge: { storyId?: string; enfants?: string[]; justification?: string } }>(
        "SELECT id, charge FROM propositions WHERE type = 'decoupage' AND statut = 'en_attente' AND charge->>'itemId' = $1 ORDER BY creee_le DESC LIMIT 1",
        [id],
      )
    ).rows[0];
    const decoupageEnFile = (
      await ctx.db.query<{ story_id: string }>(
        "SELECT charge->>'storyId' AS story_id FROM taches WHERE type = 'decouper_story' AND statut IN ('a_faire', 'en_cours') AND charge->>'storyId' = ANY($1)",
        [actives.map((s) => s.id)],
      )
    ).rows.map((r) => r.story_id);
    return {
      ligne,
      description: item.description,
      preuves: preuves.rows.map((p) => ({
        id: p.id,
        feedbackId: p.feedback_id,
        compte: { id: p.compte_id, nom: p.nom, plan: p.plan, mrr: Number(p.mrr) },
        canal: p.canal,
        recuLe: iso(p.recu_le),
        citation: p.citation,
        sure: p.sure,
        regleId: p.regle_id,
        itemOrigine: p.item_origine,
        origineFusionnee: p.origine_fusionnee === true,
      })),
      justificationImpact: jugement?.justification ?? null,
      valeurJustificationImpact: valeurJustification,
      historique: historique.rows.map((h) => ({ calculeLe: iso(h.calcule_le), score: h.detail.score })),
      story: story ? versStory(story) : null,
      stories: actives.map(versStory),
      decoupage: propDecoupage
        ? {
            propositionId: propDecoupage.id,
            storyId: String(propDecoupage.charge.storyId ?? ""),
            justification: propDecoupage.charge.justification ?? null,
            enfants: lignesStories.filter((s) => (propDecoupage.charge.enfants ?? []).includes(s.id)).map(versStory),
          }
        : null,
      decoupageEnCours: decoupageEnFile,
    };
  });

  app.get("/api/feedbacks", async (req): Promise<FeedbackApi[]> => {
    const limite = Math.min(Number((req.query as { limite?: string }).limite ?? 60), 500);
    const r = await ctx.db.query<{ id: string; compte_id: string; nom: string; plan: FeedbackApi["compte"]["plan"]; mrr: number; risque_depart: boolean; canal: FeedbackApi["canal"]; recu_le: unknown; texte: string; statut: FeedbackApi["statut"]; nature: string | null; menace_depart: boolean | null; items: string[] | null }>(
      `SELECT f.id, f.compte_id, c.nom, c.plan, c.mrr, c.risque_depart, f.canal, f.recu_le, f.texte, f.statut, e.nature, e.menace_depart,
              (SELECT array_agg(DISTINCT p.item_id) FROM preuves p WHERE p.feedback_id = f.id) AS items
       FROM feedbacks f JOIN comptes c ON c.id = f.compte_id LEFT JOIN extractions e ON e.feedback_id = f.id
       ORDER BY f.recu_le DESC, f.id DESC LIMIT $1`,
      [limite],
    );
    return r.rows.map((f) => ({
      id: f.id,
      compte: { id: f.compte_id, nom: f.nom, plan: f.plan, mrr: Number(f.mrr), risqueDepart: f.risque_depart },
      canal: f.canal,
      recuLe: iso(f.recu_le),
      texte: f.texte,
      statut: f.statut,
      nature: f.nature,
      menaceDepart: f.menace_depart ?? false,
      items: f.items ?? [],
    }));
  });

  app.post<{ Body: { compteId?: string; canal?: string; texte?: string } }>("/api/feedbacks", async (req, reply) => {
    const { compteId, canal, texte } = req.body ?? {};
    if (!compteId || !texte || !["email", "ticket", "commentaire", "direct"].includes(String(canal))) {
      return reply.code(400).send({ erreur: "compteId, canal (email|ticket|commentaire|direct) et texte sont requis" });
    }
    const id = await prochainId(ctx.db, "X", "feedbacks");
    const statut = await ingerer(ctx, { id, compteId, canal: canal as FeedbackApi["canal"], recuLe: ctx.maintenant().toISOString(), texte });
    return { id, statut };
  });

  app.post("/api/simulateur/suivant", async () => {
    const deja = new Set((await ctx.db.query<{ id: string }>("SELECT id FROM feedbacks WHERE canal = 'direct'")).rows.map((r) => r.id));
    const suivant = (await feedbacksDirects()).find((d) => !deja.has(d.id));
    if (!suivant) return { id: null };
    await ingerer(ctx, { ...suivant, canal: "direct", recuLe: ctx.maintenant().toISOString() });
    return { id: suivant.id };
  });

  app.get("/api/questions", async (): Promise<QuestionApi[]> => {
    const r = await ctx.db.query<LigneQuestionBrute>(
      "SELECT * FROM questions WHERE etat IN ('ouverte', 'relancee') AND posee_le IS NOT NULL ORDER BY urgente DESC, enjeu DESC, posee_le",
    );
    const items = await chargerItemsContexte(ctx);
    return Promise.all(r.rows.map((q) => enrichirQuestion(ctx, q, items)));
  });

  app.post<{ Params: { id: string }; Body: { choix?: string } }>("/api/questions/:id/reponse", async (req, reply) => {
    try {
      const r = await repondre(ctx, req.params.id, String(req.body?.choix ?? ""), "application");
      return { reponseId: r.reponseId, regleProposee: r.regleProposee ?? null, itemCree: r.itemCree ?? null, reglePrevue: r.reglePrevue === true };
    } catch (e) {
      return reply.code(400).send({ erreur: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/api/propositions", async (): Promise<PropositionApi[]> => {
    const r = await ctx.db.query<LignePropositionBrute>("SELECT * FROM propositions WHERE statut = 'en_attente' ORDER BY CASE WHEN id ~ '^PR[0-9]+$' THEN CAST(SUBSTRING(id FROM 3) AS INTEGER) END DESC NULLS LAST, creee_le DESC");
    const items = await chargerItemsContexte(ctx);
    return Promise.all(r.rows.map((p) => enrichirProposition(ctx, p, items)));
  });

  app.post<{ Params: { id: string }; Body: { accepter?: boolean; portee?: string } }>("/api/propositions/:id/decision", async (req, reply) => {
    try {
      // « top » : pour un ordre du backlog, le PO n'accepte que le haut du classement proposé.
      await deciderProposition(ctx, req.params.id, req.body?.accepter === true, req.body?.portee === "top" ? { portee: "top" } : {});
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ erreur: e instanceof Error ? e.message : String(e) });
    }
  });

  // Le PO corrige (audit du 15/11/2026). Ce sont des écritures du PO : elles passent par ces routes du cockpit,
  // jamais par le serveur MCP, dont les assistants proposent sans jamais valider.
  app.post<{ Params: { id: string }; Body: { taille?: string } }>("/api/items/:id/effort", async (req, reply) => {
    try {
      return await corrigerEffort(ctx, req.params.id, String(req.body?.taille ?? ""));
    } catch (e) {
      return reply.code(400).send({ erreur: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post<{ Params: { id: string }; Body: { itemId?: string } }>("/api/preuves/:id/rattacher", async (req, reply) => {
    try {
      return await corrigerRattachement(ctx, req.params.id, String(req.body?.itemId ?? ""));
    } catch (e) {
      return reply.code(400).send({ erreur: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post<{ Params: { id: string }; Body: Partial<ModificationStory> }>("/api/stories/:id/modifier", async (req, reply) => {
    const b = req.body ?? {};
    try {
      await modifierStory(ctx, req.params.id, {
        enTantQue: String(b.enTantQue ?? ""),
        jeVeux: String(b.jeVeux ?? ""),
        afinDe: String(b.afinDe ?? ""),
        criteres: Array.isArray(b.criteres) ? b.criteres : [],
        casLimites: Array.isArray(b.casLimites) ? b.casLimites.map(String) : [],
      });
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ erreur: e instanceof Error ? e.message : String(e) });
    }
  });

  // Le découpage appelle le modèle (rédaction, puis un jugement par story) : il part dans la file, et la proposition
  // arrive par le flux d'événements.
  app.post<{ Params: { id: string } }>("/api/stories/:id/decouper", async (req, reply) => {
    const s = (await ctx.db.query<{ statut: string }>("SELECT statut FROM stories WHERE id = $1", [req.params.id])).rows[0];
    if (!s) return reply.code(404).send({ erreur: "Story introuvable" });
    if (s.statut !== "brouillon" && s.statut !== "prete") return reply.code(400).send({ erreur: `Cette story ne peut plus être découpée (${s.statut})` });
    const tache = await ctx.file.ajouter("decouper_story", { storyId: req.params.id }, { cle: `decoupage:${req.params.id}` });
    await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "po", action: "demander_decoupage", cible: req.params.id, details: { enFile: tache !== null } });
    return { enFile: true };
  });

  // La doctrine se lit en entier : mots-clés, élément visé (par son titre) et cas d'origine, pour ne rien valider à l'aveugle.
  app.get("/api/regles", async (): Promise<RegleApi[]> => {
    const r = await ctx.db.query<{
      id: string;
      version: number;
      texte: string;
      contenu: ContenuRegle;
      statut: RegleApi["statut"];
      source_reponse_id: string;
      creee_le: unknown;
      validee_le: unknown;
      citations: number;
      retiree_le: unknown;
    }>(
      `SELECT r.*, (SELECT COUNT(*)::int FROM journal_activite j WHERE j.regles_citees ? r.id) AS citations,
         CASE WHEN r.statut = 'retiree' THEN (SELECT MAX(j.horodatage) FROM journal_activite j WHERE j.action = 'retirer_regle' AND j.cible = r.id) END AS retiree_le
       FROM regles r ORDER BY r.id, r.version DESC`,
    );
    const titres = new Map((await chargerItems(ctx.db, true)).map((i) => [i.id, i.titre]));
    const origines = await originesRegles(ctx, r.rows.map((x) => x.source_reponse_id), titres);
    return r.rows.map((x) => ({
      id: x.id,
      version: x.version,
      texte: x.texte,
      contenu: x.contenu,
      statut: x.statut,
      sourceReponseId: x.source_reponse_id,
      creeeLe: iso(x.creee_le),
      valideeLe: x.validee_le ? iso(x.validee_le) : null,
      retireeLe: x.retiree_le ? iso(x.retiree_le) : null,
      citations: x.citations,
      motsCles: x.contenu.type === "rattachement" ? x.contenu.motsCles : [],
      elements: elementsVises(x.contenu, titres),
      origine: origines.get(x.source_reponse_id) ?? null,
    }));
  });

  // Aperçu avant décision, en lecture seule : demandes déjà reçues captées, contradictions, cas d'origine cassés, règles proches.
  app.get<{ Params: { id: string } }>("/api/regles/:id/apercu", async (req, reply): Promise<ApercuRegleApi | undefined> => {
    const apercu = await apercuRegle(ctx, req.params.id);
    if (!apercu) {
      void reply.code(404).send({ erreur: `Règle introuvable : ${req.params.id}` });
      return;
    }
    return apercu;
  });

  app.post<{ Params: { id: string }; Body: { accepter?: boolean } }>("/api/regles/:id/decision", async (req, reply) => {
    try {
      return await deciderRegle(ctx, req.params.id, req.body?.accepter === true);
    } catch (e) {
      return reply.code(400).send({ erreur: e instanceof Error ? e.message : String(e) });
    }
  });

  // Retrait d'une règle active par le PO : tout reste réversible (CADRAGE § 3). Les rattachements déjà faits restent.
  app.post<{ Params: { id: string } }>("/api/regles/:id/retirer", async (req, reply): Promise<RetraitRegleApi | undefined> => {
    const existe = await ctx.db.query("SELECT 1 FROM regles WHERE id = $1", [req.params.id]);
    if (existe.rows.length === 0) {
      void reply.code(404).send({ erreur: `Règle introuvable : ${req.params.id}` });
      return;
    }
    try {
      return await retirerRegle(ctx, req.params.id);
    } catch (e) {
      void reply.code(400).send({ erreur: e instanceof Error ? e.message : String(e) });
      return;
    }
  });

  app.get("/api/alertes", async (): Promise<AlerteApi[]> => {
    const r = await ctx.db.query<{ id: number; type: string; message: string; urgente: boolean; creee_le: unknown; cible: string | null; est_item: boolean }>(
      "SELECT a.*, EXISTS (SELECT 1 FROM items i WHERE i.id = a.cible) AS est_item FROM alertes a ORDER BY a.id DESC LIMIT 50",
    );
    return r.rows.map((a) => ({
      id: Number(a.id),
      type: a.type,
      message: a.message,
      urgente: a.urgente,
      creeeLe: iso(a.creee_le),
      cible: a.cible ? { type: a.est_item ? "item" : "feedback", id: a.cible } : null,
    }));
  });

  app.get("/api/journal", async (req): Promise<EntreeJournalApi[]> => {
    const limite = Math.min(Number((req.query as { limite?: string }).limite ?? 100), 500);
    const r = await ctx.db.query<{ id: number; acteur: EntreeJournalApi["acteur"]; action: string; cible: string | null; details: Record<string, unknown>; regles_citees: string[]; horodatage: unknown }>(
      "SELECT * FROM journal_activite ORDER BY id DESC LIMIT $1",
      [limite],
    );
    return r.rows.map((j) => ({ id: Number(j.id), acteur: j.acteur, action: j.action, cible: j.cible, details: j.details, reglesCitees: j.regles_citees, horodatage: iso(j.horodatage) }));
  });

  // Le dernier découpage validé, avec ce que le PO a réellement déplacé : le tableau garde ces décisions,
  // et reprend la proposition actuelle de l'agent pour tout le reste.
  const moscowValide = async (): Promise<MoscowApi["valide"]> => {
    const r = await ctx.db.query<{ charge: { categories: Record<string, CategorieMoscow>; deplaces?: string[]; filtres?: string[] }; decidee_le: unknown }>(
      "SELECT charge, decidee_le FROM propositions WHERE type = 'moscow' AND statut = 'acceptee' ORDER BY CASE WHEN id ~ '^PR[0-9]+$' THEN CAST(SUBSTRING(id FROM 3) AS INTEGER) END DESC NULLS LAST, creee_le DESC LIMIT 1",
    );
    const v = r.rows[0];
    if (!v) return null;
    return {
      decideLe: iso(v.decidee_le),
      categories: v.charge.categories,
      // Une validation enregistrée sans cette liste ne compte aucun déplacement : la proposition de l'agent fait foi.
      deplaces: Array.isArray(v.charge.deplaces) ? v.charge.deplaces.map(String) : [],
      filtres: (Array.isArray(v.charge.filtres) ? v.charge.filtres : []).filter((f): f is FiltreVue => f === "mrr" || f === "objectif"),
    };
  };

  app.get("/api/moscow", async (req): Promise<MoscowApi> => calculerMoscow(lireFiltres(req.query)));

  // Le PO tranche : il peut déplacer des items d'une catégorie à l'autre, puis valide le découpage.
  app.post<{ Body: { filtres?: string; ajustements?: Record<string, CategorieMoscow> } }>("/api/moscow/valider", async (req, reply) => {
    const filtres = lireFiltres({ filtres: req.body?.filtres ?? "" });
    const ajustements = req.body?.ajustements ?? {};
    if (typeof ajustements !== "object" || Array.isArray(ajustements)) return reply.code(400).send({ erreur: "ajustements invalides" });
    const valides = new Set(["must", "should", "could", "wont"]);
    if (Object.values(ajustements).some((c) => !valides.has(c))) return reply.code(400).send({ erreur: "catégorie inconnue" });
    const m = await calculerMoscow(filtres);
    const proposees = new Map(m.propositions.map((p) => [p.itemId, p.categorie]));
    const inconnus = Object.keys(ajustements).filter((id) => !proposees.has(id));
    if (inconnus.length > 0) return reply.code(400).send({ erreur: `item absent du découpage : ${inconnus.join(", ")}` });
    const categories = Object.fromEntries(m.propositions.map((p) => [p.itemId, ajustements[p.itemId] ?? p.categorie])) as Record<string, CategorieMoscow>;
    const deplaces = Object.keys(ajustements).filter((id) => proposees.get(id) !== ajustements[id]);
    // Journalisé avant l'écriture.
    await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "po", action: "valider_moscow", details: { filtres, deplaces } });
    const id = await prochainId(ctx.db, "PR", "propositions");
    const resume = `Découpage MoSCoW validé par le PO${deplaces.length > 0 ? ` (${deplaces.length} item(s) déplacé(s))` : ""}`;
    const maintenant = ctx.maintenant().toISOString();
    await ctx.db.query("INSERT INTO propositions (id, type, charge, resume, statut, creee_le, decidee_le) VALUES ($1, 'moscow', $2, $3, 'acceptee', $4, $4)", [
      id,
      JSON.stringify({ categories, filtres, capacite: m.capacite, deplaces }),
      resume,
      maintenant,
    ]);
    ctx.diffuser({ type: "proposition", donnees: { id, type: "moscow" } });
    return { id, valide: await moscowValide() };
  });

  async function calculerMoscow(filtres: Filtre[]): Promise<MoscowApi> {
    const lignes = await lignesClassement(ctx, filtres);
    const regressionsPayantes = new Set(
      (
        await ctx.db.query<{ item_id: string }>(
          `SELECT DISTINCT p.item_id FROM preuves p
           JOIN extractions e ON e.feedback_id = p.feedback_id
           JOIN comptes c ON c.id = p.compte_id
           JOIN items i ON i.id = p.item_id
           WHERE p.sure AND i.type = 'bug' AND c.plan <> 'free' AND e.demandes::text LIKE '%"regression": true%'`,
        )
      ).rows.map((r) => r.item_id),
    );
    const titres = new Map(lignes.map((l) => [l.itemId, l]));
    const entrees = lignes.map((l) => ({
      itemId: l.itemId,
      score: l.score,
      effort: l.effort,
      regressionPayante: regressionsPayantes.has(l.itemId),
      risqueDepartBusiness: l.risqueDepart && l.parSegment.business.comptes > 0,
    }));
    const parItem = new Map(entrees.map((e) => [e.itemId, e]));
    const propositions = proposerMoscow(entrees);

    // Un Must « risque de départ » nomme les comptes qui menacent de partir (preuves sûres de l'item).
    // La règle qui fait le Must ne change pas : seule sa raison devient lisible sans ouvrir l'item.
    const comptes = await chargerComptes(ctx.db);
    const preuves = await chargerPreuves(ctx.db);
    const libellePlan: Record<string, string> = { free: "Free", pro: "Pro", business: "Business" };
    const comptesARisque = (itemId: string) => {
      const ids = new Set(preuves.filter((p) => p.itemId === itemId && p.sure).map((p) => p.compteId));
      return [...ids]
        .map((id) => comptes.get(id))
        .filter((c): c is NonNullable<typeof c> => c?.risqueDepart === true)
        .sort((a, b) => b.mrr - a.mrr || a.nom.localeCompare(b.nom));
    };
    const raisonDe = (p: (typeof propositions)[number]): string => {
      const e = parItem.get(p.itemId);
      if (p.categorie !== "must" || !e?.risqueDepartBusiness || e.regressionPayante) return p.raison;
      const noms = comptesARisque(p.itemId).map((c) => `${c.nom} (${libellePlan[c.plan] ?? c.plan})`);
      if (noms.length === 0) return p.raison;
      const liste = noms.length > 1 ? `${noms.slice(0, -1).join(", ")} et ${noms[noms.length - 1]}` : noms[0];
      return noms.length > 1 ? `${noms.length} comptes menacent de partir : ${liste}` : `Un compte menace de partir : ${liste}`;
    };

    return {
      capacite: PARAMETRES.moscow.capaciteRelease,
      propositions: propositions.map((p) => ({ ...p, raison: raisonDe(p), titre: titres.get(p.itemId)?.titre ?? p.itemId, effort: titres.get(p.itemId)?.effort ?? 0, score: titres.get(p.itemId)?.score ?? 0 })),
      valide: await moscowValide(),
    };
  }

  app.post<{ Params: { itemId: string } }>("/api/fusions/:itemId/defaire", async (req, reply) => {
    try {
      return await defaireFusion(ctx, req.params.itemId);
    } catch (e) {
      return reply.code(400).send({ erreur: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post<{ Body: { message?: string; historique?: Array<{ role: "user" | "assistant"; texte: string }>; filtres?: string } }>("/api/conversation", async (req, reply): Promise<ReponseConversationApi | undefined> => {
    const message = String(req.body?.message ?? "").trim();
    if (message.length < 2) {
      void reply.code(400).send({ erreur: "message requis" });
      return;
    }
    const historique = (req.body?.historique ?? []).filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.texte === "string");
    // La vue que le PO a sous les yeux : la conversation raisonne dessus, pour ne pas contredire l'écran.
    // Sans ce champ (Telegram, anciens clients), la vue de référence de l'agent.
    const vue = typeof req.body?.filtres === "string" ? lireFiltres({ filtres: req.body.filtres }) : undefined;
    try {
      const r = await converser(ctx, message.slice(0, 2000), historique, vue);
      return { reponse: r.texte, outils: r.appels.map((a) => a.outil) };
    } catch (e) {
      void reply.code(502).send({ erreur: e instanceof Error ? e.message : String(e) });
      return;
    }
  });

  app.post("/api/agent-de-fond/passage", async () => passageDeFond(ctx));

  app.get("/api/backlog-officiel", async (req): Promise<LigneOfficielle[]> => {
    const officiel = await ordreOfficiel(ctx);
    const propose = await ordrePropose(ctx);
    const lignes = new Map((await lignesClassement(ctx, lireFiltres(req.query))).map((l) => [l.itemId, l]));
    const titres = new Map((await chargerItems(ctx.db)).map((i) => [i.id, i.titre]));
    return officiel.map((itemId, i) => ({
      rang: i + 1,
      itemId,
      titre: titres.get(itemId) ?? itemId,
      rangPropose: propose.includes(itemId) ? propose.indexOf(itemId) + 1 : null,
      score: lignes.get(itemId)?.score ?? null,
    }));
  });

  app.get("/api/sante", async (): Promise<SanteApi> => {
    // La validation MoSCoW est un geste du PO, enregistrée d'emblée comme acceptée : ce n'est pas une proposition de l'agent.
    const props = (
      await ctx.db.query<{ acceptees: number; refusees: number }>(
        "SELECT COUNT(*) FILTER (WHERE statut = 'acceptee')::int AS acceptees, COUNT(*) FILTER (WHERE statut = 'refusee')::int AS refusees FROM propositions WHERE type <> 'moscow'",
      )
    ).rows[0]!;
    // Les deux bornes du délai sur la même horloge, celle de la base : `posee_le` suit l'horloge simulée du scénario,
    // `recue_le` l'horloge réelle, et leur différence mesurait l'écart entre les deux horloges, pas la réactivité du PO.
    const reponses = await ctx.db.query<{ choix: string; options: Array<{ valeur: string }>; type: string; contexte: { tirages?: number[] }; delai: number | null }>(
      `SELECT r.choix, q.options, q.type, q.contexte, EXTRACT(EPOCH FROM (r.recue_le - q.creee_le)) / 60 AS delai
       FROM reponses r JOIN questions q ON q.id = r.question_id`,
    );
    const corrections = reponses.rows.filter((r) => {
      const suggestion = r.type === "impact" ? String([...(r.contexte.tirages ?? [])].sort((a, b) => a - b)[Math.floor(((r.contexte.tirages?.length ?? 1) - 1) / 2)]) : r.options[0]?.valeur;
      return suggestion !== undefined && suggestion !== r.choix;
    }).length;
    // Les corrections directes du PO (effort, rattachement, texte d'une story) contredisent aussi l'agent.
    const directes =
      (await ctx.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM journal_activite WHERE acteur = 'po' AND action IN ('corriger_effort', 'corriger_rattachement', 'modifier_story')")).rows[0]?.n ?? 0;
    const delais = reponses.rows.map((r) => (r.delai === null ? Number.NaN : Number(r.delai))).filter((d) => Number.isFinite(d) && d >= 0);
    const alertes = (await ctx.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM alertes WHERE creee_le > $1::timestamptz - interval '1 day'", [ctx.maintenant().toISOString()])).rows[0]?.n ?? 0;
    const llm = (
      await ctx.db.query<{ total: number; echecs: number; duree: number | null; entree: number | null; sortie: number | null }>(
        "SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE statut <> 'ok')::int AS echecs, AVG(duree_ms) AS duree, SUM(tokens_entree) AS entree, SUM(tokens_sortie) AS sortie FROM traces_llm",
      )
    ).rows[0]!;
    const decidees = props.acceptees + props.refusees;
    return {
      tauxAcceptation: decidees > 0 ? props.acceptees / decidees : null,
      tauxCorrection: reponses.rows.length + directes > 0 ? (corrections + directes) / (reponses.rows.length + directes) : null,
      delaiDecisionMinutes: delais.length > 0 ? delais.reduce((a, b) => a + b, 0) / delais.length : null,
      effectifs: { acceptees: props.acceptees, decidees, corrections: corrections + directes, reponses: reponses.rows.length, correctionsDirectes: directes, delaisMesures: delais.length },
      alertesParJour: alertes,
      partAlertesIgnorees: null,
      appelsLLM: {
        total: llm.total,
        echecs: llm.echecs,
        dureeMoyenneMs: llm.duree === null ? null : Number(llm.duree),
        tokensEntree: Number(llm.entree ?? 0),
        tokensSortie: Number(llm.sortie ?? 0),
      },
    };
  });

  app.get("/api/flux", (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    reply.raw.write(": connecté\n\n");
    const envoyer = (e: unknown) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    const battement = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);
    emetteur.on("evenement", envoyer);
    req.raw.on("close", () => {
      clearInterval(battement);
      emetteur.off("evenement", envoyer);
    });
  });
}
