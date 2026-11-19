import { describe, expect, it } from "vitest";
import { fileTachesPostgres, migrer, ouvrirPGlite, type Db } from "@po-agent/db";
import { EchecLLM, FournisseurFaux, type CandidatItem, type DemandeARattacher, type VerdictLLM } from "@po-agent/llm";
import type { Extraction, ItemBacklog, Story, ValeurImpact } from "@po-agent/domain";
import {
  converser,
  corrigerEffort,
  corrigerRattachement,
  deciderProposition,
  decouperStory,
  executerUneTache,
  ingerer,
  modifierStory,
  numeroterRangs,
  ordreOfficiel,
  outilsConversation,
  redigerStory,
  repondre,
  simulerChangement,
  viderFile,
  type Contexte,
} from "../src/index.ts";

/**
 * Audit du 15/11/2026, arbitré par l'humain : les correctifs du cœur et les deux fonctions nouvelles
 * (découpage de story, corrections du PO). Un fournisseur scripté rend chaque comportement déterministe.
 */

const MAINTENANT = new Date("2026-11-09T09:00:00Z");

type Script = {
  extractions?: Record<string, Omit<Extraction, "feedbackId">>;
  verdicts?: (d: DemandeARattacher) => Omit<VerdictLLM, "justification">;
  impacts?: Array<{ impact: ValeurImpact; justification: string }>;
  complexiteStory?: Story["complexite"];
};

class FournisseurScripte extends FournisseurFaux {
  echecsFormulation = 0;
  constructor(private readonly script: Script = {}) {
    super();
  }
  override async extraire(f: { id: string; texte: string }): Promise<Extraction> {
    const e = this.script.extractions?.[f.id];
    return e ? { feedbackId: f.id, ...e } : super.extraire(f);
  }
  override async jugerRattachement(d: DemandeARattacher, c: CandidatItem[], t = 0): Promise<VerdictLLM> {
    return this.script.verdicts ? { ...this.script.verdicts(d), justification: "lecture scriptée" } : super.jugerRattachement(d, c);
  }
  override async jugerImpact(e: Parameters<FournisseurFaux["jugerImpact"]>[0], tirage = 0) {
    const i = this.script.impacts?.[tirage % (this.script.impacts?.length ?? 1)];
    return i ? { ...i, citations: [] } : super.jugerImpact(e, tirage);
  }
  override async redigerStory(entree: { item: ItemBacklog; citations: string[] }): Promise<Story> {
    const s = await super.redigerStory(entree);
    return this.script.complexiteStory ? { ...s, complexite: this.script.complexiteStory } : s;
  }
  override async formulerRegleRattachement(entree: Parameters<FournisseurFaux["formulerRegleRattachement"]>[0]) {
    if (this.echecsFormulation > 0) {
      this.echecsFormulation -= 1;
      throw new EchecLLM("formuler_regle", "erreur", "réseau coupé (simulé)");
    }
    return super.formulerRegleRattachement(entree);
  }
}

async function monter(script: Script = {}): Promise<{ db: Db; ctx: Contexte; llm: FournisseurScripte }> {
  const db = await ouvrirPGlite();
  await migrer(db);
  await db.exec(`
    INSERT INTO comptes (id, nom, plan, mrr) VALUES ('CF1', 'Libre', 'free', 0), ('CP1', 'Atelier Pro', 'pro', 800), ('CB1', 'Grand Compte', 'business', 5000);
    INSERT INTO items (id, titre, type, statut, complexite, alignement_objectif) VALUES
      ('B02', 'Permissions par projet', 'fonctionnalite', 'backlog', 'L', TRUE),
      ('B03', 'SSO (SAML, Okta, Entra ID)', 'fonctionnalite', 'backlog', 'M', TRUE),
      ('B04', 'Mode sombre', 'fonctionnalite', 'backlog', 'S', FALSE);
  `);
  const llm = new FournisseurScripte(script);
  const ctx: Contexte = { db, llm, file: fileTachesPostgres(db, 0), maintenant: () => MAINTENANT, diffuser: () => {} };
  return { db, ctx, llm };
}

const fb = (id: string, compteId: string, texte: string) => ({ id, compteId, canal: "email" as const, recuLe: "2026-11-08T10:00:00Z", texte });
const demande = (resume: string, citation: string, regression = false) => ({ resume, citation, regression });
const extraction = (nature: Extraction["nature"], demandes: Extraction["demandes"], menaceDepart = false) => ({ nature, injectionSuspectee: false, menaceDepart, demandes });

describe("Audit du 15/11 : correctifs du cœur", () => {
  it("ne signale un bug déguisé que si une régression est signalée", async () => {
    const { db, ctx } = await monter({
      extractions: { F1: extraction("bug", [demande("L'application est lente aujourd'hui", "ça rame depuis ce matin")]) },
      verdicts: () => ({ itemId: null, verdict: "different", alternatives: [] }),
    });
    await ingerer(ctx, fb("F1", "CP1", "Bonjour, ça rame depuis ce matin, c'est normal ?"));
    await viderFile(ctx);
    expect((await db.query<{ type: string }>("SELECT type FROM items WHERE id = 'N001'")).rows[0]?.type).toBe("bug");
    expect((await db.query("SELECT 1 FROM alertes WHERE type = 'bug_deguise'")).rows).toHaveLength(0);
  });

  it("écrit l'alerte de risque de départ avec le plan et le MRR mis en forme", async () => {
    const { db, ctx } = await monter({
      extractions: { F1: extraction("demande", [demande("Mettre en place le SSO", "le SSO avec Okta")], true) },
      verdicts: () => ({ itemId: "B03", verdict: "meme_besoin", alternatives: [] }),
    });
    await ingerer(ctx, fb("F1", "CB1", "Sans le SSO avec Okta, nous ne renouvellerons pas."));
    await viderFile(ctx);
    const alerte = (await db.query<{ message: string }>("SELECT message FROM alertes WHERE type = 'risque_depart'")).rows[0]!.message;
    expect(alerte).toContain("Grand Compte (Business, 5 000 €/mois)");
  });

  it("garde la justification d'un tirage égal à la médiane, et sa valeur", async () => {
    const { db, ctx } = await monter({
      extractions: { F1: extraction("demande", [demande("Un mode sombre", "un mode sombre")]) },
      verdicts: () => ({ itemId: "B04", verdict: "meme_besoin", alternatives: [] }),
      impacts: [
        { impact: 3, justification: "criticité massive" },
        { impact: 2, justification: "bloque un usage important" },
        { impact: 2, justification: "fort" },
        { impact: 1, justification: "moyen" },
        { impact: 2, justification: "fort encore" },
      ],
    });
    await ingerer(ctx, fb("F1", "CF1", "Il faudrait un mode sombre."));
    await viderFile(ctx);
    const j = (await db.query<{ mediane: string; justification: string; valeur_justification: string }>("SELECT mediane, justification, valeur_justification FROM jugements_impact WHERE item_id = 'B04'")).rows[0]!;
    expect(Number(j.mediane)).toBe(2);
    expect(j.justification).toBe("bloque un usage important");
    expect(Number(j.valeur_justification)).toBe(2);
  });

  it("propose au PO la taille estimée par la story, sans l'imposer", async () => {
    const { db, ctx } = await monter({ complexiteStory: "M" });
    await ingerer(ctx, { ...fb("F1", "CB1", "Il nous faut des permissions par projet."), id: "F1" });
    await db.exec("INSERT INTO preuves (id, item_id, feedback_id, compte_id, canal, recu_le, citation, sure) VALUES ('P900', 'B02', 'F1', 'CB1', 'email', '2026-11-08T10:00:00Z', 'des permissions par projet', TRUE)");
    await redigerStory(ctx, "B02");
    expect((await db.query<{ complexite: string }>("SELECT complexite FROM items WHERE id = 'B02'")).rows[0]?.complexite).toBe("L");
    const p = (await db.query<{ id: string; charge: { avant: string; apres: string } }>("SELECT id, charge FROM propositions WHERE type = 'effort'")).rows[0]!;
    expect(p.charge).toMatchObject({ avant: "L", apres: "M" });
    await deciderProposition(ctx, p.id, true);
    expect((await db.query<{ complexite: string }>("SELECT complexite FROM items WHERE id = 'B02'")).rows[0]?.complexite).toBe("M");
  });

  it("garde la réponse du PO quand la formulation de la règle échoue, puis la reprend par la file", async () => {
    const { db, ctx, llm } = await monter({
      extractions: { F1: extraction("demande", [demande("Accès restreint par projet", "un accès limité à certains projets")]) },
      verdicts: () => ({ itemId: null, verdict: "incertain", alternatives: ["B02", "B03"] }),
    });
    await ingerer(ctx, fb("F1", "CB1", "Il nous faudrait un accès limité à certains projets."));
    await viderFile(ctx);
    const q = (await db.query<{ id: string }>("SELECT id FROM questions WHERE type = 'rattachement'")).rows[0]!;
    llm.echecsFormulation = 1;
    const r = await repondre(ctx, q.id, "B02", "application");
    expect(r).toMatchObject({ reglePrevue: true });
    expect((await db.query<{ etat: string }>("SELECT etat FROM questions WHERE id = $1", [q.id])).rows[0]?.etat).toBe("repondue");
    expect((await db.query("SELECT 1 FROM regles")).rows).toHaveLength(0);
    await viderFile(ctx);
    expect((await db.query<{ statut: string }>("SELECT statut FROM regles")).rows).toEqual([{ statut: "proposee" }]);
  });

  it("numérote seulement les éléments du backlog ; un candidat dit où il se placerait", () => {
    const statuts = new Map([
      ["B01", "backlog"],
      ["N001", "candidat"],
      ["B02", "pret"],
      ["N002", "termine"],
      ["B03", "backlog"],
    ]);
    const rangs = numeroterRangs(["B01", "N001", "B02", "N002", "B03"], statuts);
    expect(Object.fromEntries(rangs)).toEqual({
      B01: { rang: 1, candidat: false },
      N001: { rang: 2, candidat: true },
      B02: { rang: 2, candidat: false },
      B03: { rang: 3, candidat: false },
    });
  });

  it("répond sur la vue affichée : MRR par défaut, sans filtre si on le demande", async () => {
    const { ctx } = await monter({
      extractions: { F1: extraction("demande", [demande("Un mode sombre", "un mode sombre")]) },
      verdicts: () => ({ itemId: "B04", verdict: "meme_besoin", alternatives: [] }),
    });
    await ingerer(ctx, fb("F1", "CF1", "Il faudrait un mode sombre."));
    await viderFile(ctx);
    const classement = (vue?: Parameters<typeof outilsConversation>[1]) => outilsConversation(ctx, vue).find((o) => o.nom === "classement")!.executer({});
    expect(await classement()).toMatch(/vue pondérée par le MRR/);
    expect(await classement([])).toMatch(/vue sans filtre/);
    const sim = await simulerChangement(ctx, "B04", { impact: 3 }, []);
    expect(sim?.rangApres).toEqual({ rang: 1, candidat: false });
    const r = await converser(ctx, "Quel est le top 5 ?", [], []);
    expect(r.texte).toMatch(/sans filtre/);
  });
});

describe("Audit du 15/11 : le PO corrige", () => {
  it("corrige l'effort d'un élément, journalise la correction et relance le score", async () => {
    const { db, ctx } = await monter();
    expect(await corrigerEffort(ctx, "B02", "M")).toEqual({ avant: "L", apres: "M" });
    expect((await db.query<{ complexite: string }>("SELECT complexite FROM items WHERE id = 'B02'")).rows[0]?.complexite).toBe("M");
    expect((await db.query<{ acteur: string }>("SELECT acteur FROM journal_activite WHERE action = 'corriger_effort'")).rows).toEqual([{ acteur: "po" }]);
    expect((await db.query("SELECT 1 FROM taches WHERE type = 'rescorer' AND statut = 'a_faire'")).rows).toHaveLength(1);
    await expect(corrigerEffort(ctx, "B02", "XXL")).rejects.toThrow(/Taille inconnue/);
  });

  it("rattache un verbatim à un autre élément, sûr, en gardant son origine, et clôt la question qui n'a plus d'objet", async () => {
    const { db, ctx } = await monter({
      extractions: { F1: extraction("demande", [demande("Accès restreint par projet", "un accès limité à certains projets")]) },
      verdicts: () => ({ itemId: null, verdict: "incertain", alternatives: ["B03", "B02"] }),
    });
    await ingerer(ctx, fb("F1", "CB1", "Il nous faudrait un accès limité à certains projets."));
    await viderFile(ctx);
    const preuve = (await db.query<{ id: string; item_id: string; sure: boolean }>("SELECT id, item_id, sure FROM preuves")).rows[0]!;
    expect(preuve).toMatchObject({ item_id: "B03", sure: false });
    await corrigerRattachement(ctx, preuve.id, "B02");
    expect((await db.query("SELECT item_id, sure, item_origine FROM preuves")).rows).toEqual([{ item_id: "B02", sure: true, item_origine: "B03" }]);
    expect((await db.query<{ etat: string }>("SELECT etat FROM questions")).rows[0]?.etat).toBe("expiree");
    expect((await db.query("SELECT 1 FROM regles")).rows).toHaveLength(0);
    await corrigerRattachement(ctx, preuve.id, "ignorer");
    expect((await db.query("SELECT 1 FROM preuves")).rows).toHaveLength(0);
  });

  it("garde la version de l'agent d'une story réécrite par le PO, et refait les contrôles", async () => {
    const { db, ctx } = await monter();
    await ingerer(ctx, fb("F1", "CB1", "Il nous faut des permissions par projet."));
    await db.exec("INSERT INTO preuves (id, item_id, feedback_id, compte_id, canal, recu_le, citation, sure) VALUES ('P900', 'B02', 'F1', 'CB1', 'email', '2026-11-08T10:00:00Z', 'des permissions par projet', TRUE)");
    const id = (await redigerStory(ctx, "B02"))!;
    await modifierStory(ctx, id, {
      enTantQue: "administratrice d'un espace",
      jeVeux: "masquer un projet à un invité",
      afinDe: "protéger la confidentialité de mes clients",
      criteres: [{ etantDonne: "un invité sur le projet A", quand: "il ouvre la liste", alors: "le projet B n'apparaît pas" }],
      casLimites: [],
    });
    const s = (await db.query<{ contenu: Story; contenu_agent: Story; controles: Array<{ nom: string; ok: boolean }> }>("SELECT contenu, contenu_agent, controles FROM stories WHERE id = $1", [id])).rows[0]!;
    expect(s.contenu.jeVeux).toBe("masquer un projet à un invité");
    expect(s.contenu_agent.jeVeux).toMatch(/permissions par projet/);
    expect(s.contenu.citations).toEqual(s.contenu_agent.citations);
    expect(s.controles.find((c) => c.nom === "au_moins_deux_criteres")?.ok).toBe(false);
  });

  it("n'accepte que le top 5 d'un ordre proposé quand le PO le demande", async () => {
    const { db, ctx } = await monter();
    await db.exec(`
      INSERT INTO items (id, titre, type, statut, complexite, alignement_objectif) VALUES
        ('B05', 'Cinq', 'fonctionnalite', 'backlog', 'M', FALSE), ('B06', 'Six', 'fonctionnalite', 'backlog', 'M', FALSE), ('B07', 'Sept', 'fonctionnalite', 'backlog', 'M', FALSE);
      INSERT INTO propositions (id, type, charge, resume) VALUES ('PR900', 'ordre_backlog', '{"ordre": ["B07", "B06", "B05", "B04", "B03", "B02"]}', 'Nouvel ordre');
    `);
    await deciderProposition(ctx, "PR900", true, { portee: "top" });
    expect(await ordreOfficiel(ctx)).toEqual(["B07", "B06", "B05", "B04", "B03", "B02"]);
    await db.exec(`INSERT INTO propositions (id, type, charge, resume) VALUES ('PR901', 'ordre_backlog', '{"ordre": ["B02", "B03", "B04", "B05", "B06", "B07"]}', 'Autre ordre')`);
    await deciderProposition(ctx, "PR901", true, { portee: "top" });
    // Le top 5 proposé prend la tête ; B07, hors du top proposé, garde sa place relative dans l'ancien ordre.
    expect(await ordreOfficiel(ctx)).toEqual(["B02", "B03", "B04", "B05", "B06", "B07"]);
    const charge = (await db.query<{ charge: { ordre: string[]; ordreAccepte: string[]; portee: string } }>("SELECT charge FROM propositions WHERE id = 'PR900'")).rows[0]!.charge;
    expect(charge.portee).toBe("top");
  });
});

describe("Audit du 15/11 : découpage de story", () => {
  async function storyRefusee() {
    const m = await monter();
    await ingerer(m.ctx, fb("F1", "CB1", "Il nous faut des permissions par projet."));
    await m.db.exec("INSERT INTO preuves (id, item_id, feedback_id, compte_id, canal, recu_le, citation, sure) VALUES ('P900', 'B02', 'F1', 'CB1', 'email', '2026-11-08T10:00:00Z', 'des permissions par projet', TRUE)");
    const id = (await redigerStory(m.ctx, "B02"))!;
    await m.db.query("UPDATE stories SET jugement = $2 WHERE id = $1", [id, JSON.stringify({ independante: true, valeur: true, estimable: false, petite: false, testable: true, un_seul_besoin: false, commentaire: "Trop large." })]);
    return { ...m, storyId: id };
  }

  it("propose un découpage jugé ; accepté, les stories deviennent des brouillons à valider et l'origine est remplacée", async () => {
    const { db, ctx, storyId } = await storyRefusee();
    const propId = (await decouperStory(ctx, storyId))!;
    const enfants = (await db.query<{ id: string; statut: string; parent_id: string }>("SELECT id, statut, parent_id FROM stories WHERE parent_id = $1 ORDER BY id", [storyId])).rows;
    expect(enfants).toHaveLength(2);
    expect(enfants.every((e) => e.statut === "proposee")).toBe(true);
    // Une seconde demande ne relance pas le modèle : la proposition en attente est rendue.
    expect(await decouperStory(ctx, storyId)).toBe(propId);
    await deciderProposition(ctx, propId, true);
    expect((await db.query<{ statut: string }>("SELECT statut FROM stories WHERE id = $1", [storyId])).rows[0]?.statut).toBe("remplacee");
    expect((await db.query<{ statut: string }>("SELECT statut FROM stories WHERE parent_id = $1", [storyId])).rows.map((r) => r.statut)).toEqual(["brouillon", "brouillon"]);
    const validations = (await db.query<{ statut: string; charge: { storyId: string } }>("SELECT statut, charge FROM propositions WHERE type = 'story_prete' ORDER BY id")).rows;
    expect(validations.find((v) => v.charge.storyId === storyId)?.statut).toBe("expiree");
    expect(validations.filter((v) => v.statut === "en_attente").map((v) => v.charge.storyId).sort()).toEqual(enfants.map((e) => e.id).sort());
  });

  it("refusé, écarte les stories proposées et garde l'origine", async () => {
    const { db, ctx, storyId } = await storyRefusee();
    const propId = (await decouperStory(ctx, storyId))!;
    await deciderProposition(ctx, propId, false);
    expect((await db.query<{ statut: string }>("SELECT statut FROM stories WHERE id = $1", [storyId])).rows[0]?.statut).toBe("brouillon");
    expect((await db.query<{ statut: string }>("SELECT statut FROM stories WHERE parent_id = $1", [storyId])).rows.map((r) => r.statut)).toEqual(["refusee", "refusee"]);
  });

  it("passe par la file quand le PO le demande", async () => {
    const { db, ctx, storyId } = await storyRefusee();
    await ctx.file.ajouter("decouper_story", { storyId }, { cle: `decoupage:${storyId}` });
    while (await executerUneTache(ctx)) {
      // vide la file
    }
    expect((await db.query("SELECT 1 FROM propositions WHERE type = 'decoupage'")).rows).toHaveLength(1);
  });
});
