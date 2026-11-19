import { describe, expect, it } from "vitest";
import { fileTachesPostgres, migrer, ouvrirPGlite, type Db } from "@po-agent/db";
import { FournisseurFaux, type CandidatItem, type DemandeARattacher, type VerdictLLM } from "@po-agent/llm";
import type { Extraction } from "@po-agent/domain";
import { deciderProposition, executerUneTache, ingerer, outilsConversation, poserQuestions, repondre, viderFile, type Contexte } from "../src/index.ts";

/**
 * Lot B de la session 4 (audits d'usage) : questions posées par enjeu à la fin d'un lot, une question par message,
 * preuve sûre jamais perdue, bug déguisé requalifié, mode lot sans bruit d'alertes, « Un besoin nouveau » qui crée
 * l'élément, et l'invariant « texte brut lu seulement par l'extraction ».
 * Un fournisseur sur mesure impose extractions et verdicts : chaque comportement est testé de façon déterministe.
 */

const MAINTENANT = new Date("2026-11-09T09:00:00Z");

type Script = {
  extractions: Record<string, Omit<Extraction, "feedbackId">>;
  verdicts: (d: DemandeARattacher) => Omit<VerdictLLM, "justification">;
};

class FournisseurScripte extends FournisseurFaux {
  constructor(private readonly script: Script) {
    super();
  }
  override async extraire(f: { id: string; texte: string }): Promise<Extraction> {
    const e = this.script.extractions[f.id];
    return e ? { feedbackId: f.id, ...e } : super.extraire(f);
  }
  override async jugerRattachement(d: DemandeARattacher, _c: CandidatItem[], _t = 0): Promise<VerdictLLM> {
    return { ...this.script.verdicts(d), justification: "lecture scriptée" };
  }
}

async function monter(script: Script, modeLot = false): Promise<{ db: Db; ctx: Contexte }> {
  const db = await ouvrirPGlite();
  await migrer(db);
  await db.exec(`
    INSERT INTO comptes (id, nom, plan, mrr) VALUES ('CF1', 'Libre', 'free', 0), ('CB1', 'Grand Compte', 'business', 5000);
    INSERT INTO items (id, titre, type, statut, complexite, alignement_objectif) VALUES
      ('B02', 'Permissions par projet', 'fonctionnalite', 'backlog', 'L', TRUE),
      ('B03', 'SSO (SAML, Okta, Entra ID)', 'fonctionnalite', 'backlog', 'M', TRUE),
      ('B04', 'Mode sombre', 'fonctionnalite', 'backlog', 'S', FALSE);
  `);
  const ctx: Contexte = { db, llm: new FournisseurScripte(script), file: fileTachesPostgres(db, 0), maintenant: () => MAINTENANT, diffuser: () => {}, ...(modeLot ? { modeLot: true } : {}) };
  return { db, ctx };
}

const fb = (id: string, compteId: string, texte: string) => ({ id, compteId, canal: "email" as const, recuLe: "2026-11-08T10:00:00Z", texte });
const demande = (resume: string, citation: string, regression = false) => ({ resume, citation, regression });
const extraction = (nature: Extraction["nature"], demandes: Extraction["demandes"], menaceDepart = false) => ({ nature, injectionSuspectee: false, menaceDepart, demandes });
const incertain = { itemId: null, verdict: "incertain" as const, alternatives: ["B02", "B03"] };

describe("Lot B : décisions dans le bon ordre, sans perte ni bruit", () => {
  it("pose une question non urgente à la fin du lot, pas à sa création", async () => {
    const { db, ctx } = await monter({
      extractions: { F1: extraction("demande", [demande("Accès restreint par projet", "un accès limité à certains projets")]) },
      verdicts: () => incertain,
    });
    await ingerer(ctx, fb("F1", "CB1", "Il nous faudrait un accès limité à certains projets."));
    await executerUneTache(ctx);
    const avant = await db.query<{ posee_le: unknown }>("SELECT posee_le FROM questions");
    expect(avant.rows).toHaveLength(1);
    expect(avant.rows[0]!.posee_le).toBeNull();
    await viderFile(ctx);
    expect((await db.query<{ posee_le: unknown }>("SELECT posee_le FROM questions")).rows[0]!.posee_le).not.toBeNull();
  });

  it("pose d'abord les questions au plus fort enjeu", async () => {
    const { db, ctx } = await monter({ extractions: {}, verdicts: () => incertain });
    const opts = JSON.stringify([{ valeur: "B02", libelle: "Permissions par projet" }]);
    const valeurs = Array.from({ length: 7 }, (_, i) => `('Q0${i + 1}', 'rattachement', 'q', '${opts}', '{}', ${i}, FALSE)`).join(", ");
    await db.exec(`INSERT INTO questions (id, type, enonce, options, contexte, enjeu, urgente) VALUES ${valeurs}`);
    const posees = await poserQuestions(ctx);
    // Le plafond du jour (5) retient les cinq plus forts enjeux : Q07 à Q03.
    expect(posees).toEqual(["Q07", "Q06", "Q05", "Q04", "Q03"]);
  });

  it("ne pose qu'une question pour deux demandes d'un même message, et rend sûre la preuve confirmée", async () => {
    const { db, ctx } = await monter({
      extractions: {
        F2: extraction("demande", [demande("Rôles par projet", "des rôles par projet"), demande("Visibilité restreinte", "voir seulement leurs projets")]),
        F3: extraction("demande", [demande("Rôles par projet", "des rôles par projet"), demande("Droits par projet", "des droits par projet")]),
      },
      // F2 : les deux demandes laissent l'agent hésiter entre B02 et B03. F3 : la seconde est sûre, sur B02.
      verdicts: (d) => (d.resume === "Droits par projet" ? { itemId: "B02", verdict: "meme_besoin", alternatives: [] } : incertain),
    });
    await ingerer(ctx, fb("F2", "CB1", "Il nous faut des rôles par projet : nos prestataires doivent voir seulement leurs projets."));
    await ingerer(ctx, fb("F3", "CB1", "Il nous faut des rôles par projet, et des droits par projet."));
    await viderFile(ctx);
    const questions = await db.query<{ contexte: { feedbackId: string } }>("SELECT contexte FROM questions WHERE type = 'rattachement'");
    expect(questions.rows.filter((q) => q.contexte.feedbackId === "F2")).toHaveLength(1);
    // F3 : la preuve en attente sur B02 devient sûre quand l'autre demande y est rattachée avec certitude.
    expect((await db.query<{ sure: boolean }>("SELECT sure FROM preuves WHERE feedback_id = 'F3' AND item_id = 'B02'")).rows[0]?.sure).toBe(true);
  });

  it("requalifie en bug un candidat quand une régression y est rattachée", async () => {
    const { db, ctx } = await monter({
      extractions: {
        F4: extraction("demande", [demande("Dépendances dans l'export PDF", "les dépendances dans l'export PDF")]),
        F5: extraction("bug", [demande("Dépendances disparues de l'export PDF", "elles n'y sont plus", true)]),
      },
      verdicts: (d) => (d.resume.startsWith("Dépendances disparues") ? { itemId: "N001", verdict: "meme_besoin", alternatives: [] } : { itemId: null, verdict: "different", alternatives: [] }),
    });
    await ingerer(ctx, fb("F4", "CB1", "Pourriez-vous mettre les dépendances dans l'export PDF ?"));
    await viderFile(ctx);
    expect((await db.query<{ type: string }>("SELECT type FROM items WHERE id = 'N001'")).rows[0]?.type).toBe("fonctionnalite");
    await ingerer(ctx, fb("F5", "CB1", "Ça marchait avant, mais elles n'y sont plus depuis septembre."));
    await viderFile(ctx);
    expect((await db.query<{ type: string }>("SELECT type FROM items WHERE id = 'N001'")).rows[0]?.type).toBe("bug");
    const alerte = (await db.query<{ cible: string }>("SELECT cible FROM alertes WHERE type = 'bug_deguise'")).rows;
    expect(alerte).toEqual([{ cible: "N001" }]);
  });

  it("ne signale pas les mouvements du top 5 en mode lot", async () => {
    const script: Script = { extractions: { F6: extraction("demande", [demande("Mode sombre", "un mode sombre")]) }, verdicts: () => ({ itemId: "B04", verdict: "meme_besoin", alternatives: [] }) };
    const enDirect = await monter(script);
    await ingerer(enDirect.ctx, fb("F6", "CF1", "Vivement un mode sombre."));
    await viderFile(enDirect.ctx);
    expect((await enDirect.db.query("SELECT 1 FROM alertes WHERE type = 'entree_top'")).rows.length).toBeGreaterThan(0);
    const enLot = await monter(script, true);
    await ingerer(enLot.ctx, fb("F6", "CF1", "Vivement un mode sombre."));
    await viderFile(enLot.ctx);
    expect((await enLot.db.query("SELECT 1 FROM alertes WHERE type IN ('entree_top', 'sortie_top')")).rows).toHaveLength(0);
  });

  it("« Un besoin nouveau » crée l'élément, avec la demande comme preuve sûre", async () => {
    const { db, ctx } = await monter({
      extractions: { F7: extraction("demande", [demande("Export Gantt en PDF", "exporter le Gantt en PDF")]) },
      verdicts: () => incertain,
    });
    await ingerer(ctx, fb("F7", "CB1", "Nous voudrions exporter le Gantt en PDF pour nos clients."));
    await viderFile(ctx);
    const q = (await db.query<{ id: string }>("SELECT id FROM questions WHERE type = 'rattachement'")).rows[0]!;
    const r = await repondre(ctx, q.id, "nouvel_item", "application");
    expect(r.itemCree).toBeDefined();
    const item = (await db.query<{ titre: string; statut: string; cree_par: string }>("SELECT titre, statut, cree_par FROM items WHERE id = $1", [r.itemCree])).rows[0];
    expect(item).toEqual({ titre: "Export Gantt en PDF", statut: "backlog", cree_par: "humain" });
    expect((await db.query<{ item_id: string; sure: boolean }>("SELECT item_id, sure FROM preuves WHERE feedback_id = 'F7'")).rows).toEqual([{ item_id: r.itemCree, sure: true }]);
    expect((await db.query("SELECT 1 FROM journal_activite WHERE action = 'creer_item'")).rows).toHaveLength(1);
  });

  it("accepter depuis la boîte une règle contradictoire renvoie le refus, au lieu d'un faux succès", async () => {
    const { db, ctx } = await monter({ extractions: {}, verdicts: () => incertain });
    await db.exec(`
      INSERT INTO questions (id, type, enonce, options, contexte) VALUES ('Q01', 'rattachement', 'q', '[]', '{}');
      INSERT INTO reponses (id, question_id, auteur, choix, canal) VALUES ('R01', 'Q01', 'po', 'B03', 'application');
      INSERT INTO regles (id, version, contenu, texte, source_reponse_id, statut, creee_le, validee_le) VALUES
        ('D01', 1, '{"type":"rattachement","motsCles":["okta"],"itemId":"B03"}', 'Okta relève du SSO', 'R01', 'active', now(), now()),
        ('D02', 1, '{"type":"rattachement","motsCles":["okta"],"itemId":"B02"}', 'Okta relève des permissions', 'R01', 'proposee', now(), NULL);
      INSERT INTO propositions (id, type, charge, resume) VALUES ('PR01', 'regle', '{"regleId":"D02","version":1}', 'Règle proposée');
    `);
    await expect(deciderProposition(ctx, "PR01", true)).rejects.toThrow(/Règle non activée/);
    expect((await db.query<{ statut: string }>("SELECT statut FROM regles WHERE id = 'D02'")).rows[0]?.statut).toBe("proposee");
  });

  it("la recherche de la conversation ne transmet jamais le texte brut d'un message", async () => {
    const { ctx } = await monter({
      extractions: { F8: extraction("demande", [demande("Connexion via Okta", "la connexion via Okta")]) },
      verdicts: () => ({ itemId: "B03", verdict: "meme_besoin", alternatives: [] }),
    });
    await ingerer(ctx, fb("F8", "CB1", "Bonjour, notre DSI exige la connexion via Okta. Phrase privée qui ne doit pas sortir."));
    await viderFile(ctx);
    const outil = outilsConversation(ctx).find((o) => o.nom === "chercher_feedbacks")!;
    const sortie = await outil.executer({ mots: "Okta" });
    expect(sortie).toContain("Connexion via Okta");
    expect(sortie).toContain("la connexion via Okta");
    expect(sortie).not.toContain("Phrase privée");
  });
});
