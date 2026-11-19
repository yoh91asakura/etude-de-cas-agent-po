import { EventEmitter } from "node:events";
import { beforeAll, describe, expect, it } from "vitest";
import { fileTachesPostgres, migrer, ouvrirPGlite } from "@po-agent/db";
import { FournisseurFaux } from "@po-agent/llm";
import { viderFile, type Contexte } from "@po-agent/agent";
import { creerApp } from "../src/app.ts";
import type { DetailItemApi, EtatApi, LigneClassement, MoscowApi, QuestionApi, RegleApi, SanteApi } from "../src/contrat.ts";

let ctx: Contexte;
let app: ReturnType<typeof creerApp>;

beforeAll(async () => {
  const db = await ouvrirPGlite();
  await migrer(db);
  await db.exec(`
    INSERT INTO comptes (id, nom, plan, mrr) VALUES ('CF1', 'Libre', 'free', 0), ('CB1', 'Grand Compte', 'business', 6000);
    INSERT INTO items (id, titre, type, statut, complexite, alignement_objectif) VALUES
      ('B02', 'Permissions par projet', 'fonctionnalite', 'backlog', 'L', TRUE),
      ('B03', 'SSO (SAML, Okta, Entra ID)', 'fonctionnalite', 'backlog', 'M', TRUE),
      ('B04', 'Mode sombre', 'fonctionnalite', 'backlog', 'S', FALSE);
  `);
  const emetteur = new EventEmitter();
  ctx = { db, llm: new FournisseurFaux(), file: fileTachesPostgres(db, 0), maintenant: () => new Date("2026-11-09T09:00:00Z"), diffuser: (e) => emetteur.emit("evenement", e) };
  app = creerApp(ctx, emetteur);
});

describe("API du cockpit (faux fournisseur)", () => {
  it("signale un fournisseur factice", async () => {
    const etat = (await app.inject("/api/etat")).json<EtatApi>();
    expect(etat.fournisseurFactice).toBe(true);
    expect(etat.parametresValides).toBe(false);
  });

  it("ingère un feedback par le connecteur générique et le classe", async () => {
    const r = await app.inject({ method: "POST", url: "/api/feedbacks", payload: { compteId: "CF1", canal: "commentaire", texte: "Mode sombre svp !" } });
    expect(r.json()).toMatchObject({ statut: "ajoute" });
    await viderFile(ctx);
    const lignes = (await app.inject("/api/classement")).json<LigneClassement[]>();
    expect(lignes[0]).toMatchObject({ itemId: "B04", rang: 1, nbPreuves: 1 });
    const detail = (await app.inject("/api/items/B04")).json<DetailItemApi>();
    expect(detail.preuves[0]?.compte.nom).toBe("Libre");
  });

  it("refuse un feedback incomplet", async () => {
    expect((await app.inject({ method: "POST", url: "/api/feedbacks", payload: { compteId: "CF1" } })).statusCode).toBe(400);
  });

  it("pose une question, enregistre la réponse du PO et propose une règle à valider", async () => {
    await app.inject({ method: "POST", url: "/api/feedbacks", payload: { compteId: "CB1", canal: "email", texte: "Il nous faut le SSO via Okta et des permissions par projet." } });
    await viderFile(ctx);
    const [q] = (await app.inject("/api/questions")).json<QuestionApi[]>();
    expect(q?.type).toBe("rattachement");
    const rep = await app.inject({ method: "POST", url: `/api/questions/${q!.id}/reponse`, payload: { choix: "B03" } });
    expect(rep.json().regleProposee.statut).toBe("proposee");
    const regles = (await app.inject("/api/regles")).json<RegleApi[]>();
    const id = regles[0]!.id;
    const decision = await app.inject({ method: "POST", url: `/api/regles/${id}/decision`, payload: { accepter: true } });
    expect(decision.json()).toMatchObject({ statut: "active" });
  });

  it("refuse un choix hors des options", async () => {
    await app.inject({ method: "POST", url: "/api/feedbacks", payload: { compteId: "CB1", canal: "ticket", texte: "SAML et permissions par projet, urgent." } });
    await viderFile(ctx);
    const questions = (await app.inject("/api/questions")).json<QuestionApi[]>();
    if (questions[0]) {
      expect((await app.inject({ method: "POST", url: `/api/questions/${questions[0].id}/reponse`, payload: { choix: "B99" } })).statusCode).toBe(400);
    }
  });

  it("propose un MoSCoW et des indicateurs de santé", async () => {
    await viderFile(ctx);
    const moscow = (await app.inject("/api/moscow?filtres=mrr")).json<MoscowApi>();
    expect(moscow.propositions.length).toBeGreaterThan(0);
    const sante = (await app.inject("/api/sante")).json<SanteApi>();
    expect(sante.appelsLLM.total).toBe(0);
    // Les deux bornes du délai sont prises sur la même horloge : l'horloge simulée du test (9 novembre)
    // contre l'horloge réelle de la base aurait donné des milliers de minutes.
    expect(sante.delaiDecisionMinutes).not.toBeNull();
    expect(sante.delaiDecisionMinutes!).toBeGreaterThanOrEqual(0);
    expect(sante.delaiDecisionMinutes!).toBeLessThan(60);
    expect(sante.effectifs.reponses).toBeGreaterThan(0);
    expect(sante.effectifs.delaisMesures).toBe(sante.effectifs.reponses);
  });

  it("dit si un outil de suivi est branché", async () => {
    expect((await app.inject("/api/etat")).json<EtatApi>().outilSuiviBranche).toBe(false);
  });

  it("enregistre le découpage MoSCoW tranché par le PO, journalisé, et refuse les ajustements invalides", async () => {
    const avant = (await app.inject("/api/moscow?filtres=mrr")).json<MoscowApi>();
    expect(avant.valide).toBeNull();
    const cible = avant.propositions.find((p) => p.categorie !== "wont")!;
    const r = await app.inject({ method: "POST", url: "/api/moscow/valider", payload: { filtres: "mrr", ajustements: { [cible.itemId]: "wont" } } });
    expect(r.statusCode).toBe(200);
    const apres = (await app.inject("/api/moscow?filtres=mrr")).json<MoscowApi>();
    expect(apres.valide?.categories[cible.itemId]).toBe("wont");
    // Ce que le PO a vraiment déplacé, et la vue de la validation, sont exposés au tableau.
    expect(apres.valide?.deplaces).toEqual([cible.itemId]);
    expect(apres.valide?.filtres).toEqual(["mrr"]);
    // La proposition de l'agent reste visible à côté de la décision du PO.
    expect(apres.propositions.find((p) => p.itemId === cible.itemId)?.categorie).toBe(cible.categorie);
    const journal = (await app.inject("/api/journal")).json<Array<{ acteur: string; action: string; details: { deplaces?: string[] } }>>();
    expect(journal.find((j) => j.action === "valider_moscow")).toMatchObject({ acteur: "po", details: { deplaces: [cible.itemId] } });
    const invalide = (ajustements: unknown) => app.inject({ method: "POST", url: "/api/moscow/valider", payload: { ajustements } });
    expect((await invalide({ [cible.itemId]: "peut-etre" })).statusCode).toBe(400);
    expect((await invalide({ B99: "must" })).statusCode).toBe(400);
    expect((await invalide(["must"])).statusCode).toBe(400);
  });

  it("ne transforme pas en déplacement du PO une proposition de l'agent qui change après la validation", async () => {
    const santeAvant = (await app.inject("/api/sante")).json<SanteApi>();
    // Le PO valide sans rien déplacer.
    const valider = (ajustements: Record<string, string>) => app.inject({ method: "POST", url: "/api/moscow/valider", payload: { filtres: "mrr", ajustements } });
    expect((await valider({})).statusCode).toBe(200);
    const avant = (await app.inject("/api/moscow?filtres=mrr")).json<MoscowApi>();
    expect(avant.valide?.deplaces).toEqual([]);
    expect(avant.valide?.categories.B03).toBeDefined();
    expect(avant.valide?.categories.B03).not.toBe("must");

    // Puis le compte Business qui demande le SSO menace de partir : l'agent propose désormais le SSO en Must.
    await ctx.db.query("UPDATE comptes SET risque_depart = TRUE WHERE id = 'CB1'");
    const apres = (await app.inject("/api/moscow?filtres=mrr")).json<MoscowApi>();
    const sso = apres.propositions.find((p) => p.itemId === "B03")!;
    expect(sso.categorie).toBe("must");
    // La raison nomme le compte concerné.
    expect(sso.raison).toContain("Grand Compte (Business)");
    // La validation reste celle du PO : rien n'y a été déplacé, et la catégorie validée diffère de la nouvelle proposition.
    expect(apres.valide?.deplaces).toEqual([]);
    expect(apres.valide?.categories.B03).toBe(avant.valide?.categories.B03);

    // Le PO revalide sans toucher à rien : le tableau n'envoie que les vrais déplacements (aucun ici).
    expect((await valider({})).statusCode).toBe(200);
    const journal = (await app.inject("/api/journal")).json<Array<{ action: string; details: { deplaces?: string[] } }>>();
    expect(journal.find((j) => j.action === "valider_moscow")?.details.deplaces).toEqual([]);
    const final = (await app.inject("/api/moscow?filtres=mrr")).json<MoscowApi>();
    expect(final.valide?.categories.B03).toBe("must");
    expect(final.valide?.deplaces).toEqual([]);

    // La validation du découpage est un geste du PO : elle ne compte pas dans l'acceptation des propositions de l'agent.
    const sante = (await app.inject("/api/sante")).json<SanteApi>();
    expect(sante.effectifs).toMatchObject({ acceptees: santeAvant.effectifs.acceptees, decidees: santeAvant.effectifs.decidees });
    expect(sante.tauxAcceptation).toBe(santeAvant.tauxAcceptation);
  });

  it("répond à une question libre du PO par ses outils, et refuse un message vide", async () => {
    const r = await app.inject({ method: "POST", url: "/api/conversation", payload: { message: "Quelles règles de doctrine sont actives ?" } });
    expect(r.json()).toMatchObject({ outils: ["doctrine"] });
    expect((await app.inject({ method: "POST", url: "/api/conversation", payload: { message: "" } })).statusCode).toBe(400);
  });

  it("expose l'ordre validé par le PO et un passage de fond à la demande", async () => {
    const officiel = (await app.inject("/api/backlog-officiel")).json<Array<{ rang: number; itemId: string }>>();
    expect(officiel.map((l) => l.itemId)).toEqual(expect.arrayContaining(["B02", "B03", "B04"]));
    const passage = (await app.inject({ method: "POST", url: "/api/agent-de-fond/passage" })).json<{ resume: string }>();
    expect(passage.resume).toMatch(/^Résumé de/);
  });
});
