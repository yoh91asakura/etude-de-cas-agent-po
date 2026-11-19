import { EventEmitter } from "node:events";
import { beforeAll, describe, expect, it } from "vitest";
import { fileTachesPostgres, migrer, ouvrirPGlite, type Db } from "@po-agent/db";
import { FournisseurFaux } from "@po-agent/llm";
import type { Contexte } from "@po-agent/agent";
import { creerApp } from "../src/app.ts";
import type { ApercuRegleApi, EntreeJournalApi, RegleApi, RetraitRegleApi } from "../src/contrat.ts";

/** Routes de la doctrine (lot C) : règles lisibles, aperçu avant validation, retrait. Faux fournisseur, aucun appel au modèle. */

let db: Db;
let app: ReturnType<typeof creerApp>;

beforeAll(async () => {
  db = await ouvrirPGlite();
  await migrer(db);
  await db.exec(`
    INSERT INTO comptes (id, nom, plan, mrr) VALUES ('CB1', 'Grand Compte', 'business', 6000);
    INSERT INTO items (id, titre, type, statut, complexite, alignement_objectif) VALUES
      ('B02', 'Permissions par projet', 'fonctionnalite', 'backlog', 'L', TRUE),
      ('B05', 'Tableau de bord portefeuille', 'fonctionnalite', 'backlog', 'M', FALSE);
    INSERT INTO feedbacks (id, compte_id, canal, recu_le, texte, empreinte, statut) VALUES
      ('F1', 'CB1', 'email', '2026-11-05T10:00:00Z', 'Il nous faut des droits différents selon les projets.', 'e-F1', 'traite');
    INSERT INTO extractions (feedback_id, nature, injection_suspectee, menace_depart, demandes) VALUES
      ('F1', 'demande', FALSE, FALSE, '[{"resume": "Droits par projet", "citation": "des droits différents selon les projets", "regression": false}]');
    INSERT INTO preuves (id, item_id, feedback_id, compte_id, canal, recu_le, citation, sure) VALUES
      ('P1', 'B02', 'F1', 'CB1', 'email', '2026-11-05T10:00:00Z', 'des droits différents selon les projets', TRUE);
    INSERT INTO questions (id, type, enonce, options, contexte, etat) VALUES
      ('Q1', 'rattachement', 'Cette demande relève-t-elle de « Tableau de bord portefeuille » ou de « Permissions par projet » ?',
       '[{"valeur": "B05", "libelle": "Tableau de bord portefeuille"}, {"valeur": "B02", "libelle": "Permissions par projet"}]',
       '{"feedbackId": "F072", "resume": "Vue portefeuille", "citation": "un tableau de bord portefeuille"}', 'repondue'),
      ('Q2', 'rattachement', 'À quel élément du backlog rattacher cette demande ?', '[]',
       '{"feedbackId": "F080", "resume": "Suivi", "citation": "suivre nos portefeuilles clients"}', 'repondue');
    INSERT INTO reponses (id, question_id, auteur, choix, canal) VALUES ('R001', 'Q1', 'po', 'B05', 'application'), ('R002', 'Q2', 'po', 'B05', 'application');
    INSERT INTO regles (id, version, contenu, texte, source_reponse_id, statut, creee_le, validee_le) VALUES
      ('D01', 1, '{"type": "rattachement", "motsCles": ["portefeuille"], "itemId": "B05"}', 'Le portefeuille relève du tableau de bord', 'R001', 'active', now(), now()),
      ('D02', 1, '{"type": "rattachement", "motsCles": ["portefeuilles", "projets"], "itemId": "B05"}', 'Portefeuilles et projets relèvent du tableau de bord', 'R002', 'proposee', now(), NULL);
  `);
  const emetteur = new EventEmitter();
  const ctx: Contexte = { db, llm: new FournisseurFaux(), file: fileTachesPostgres(db, 0), maintenant: () => new Date("2026-11-09T09:00:00Z"), diffuser: (e) => emetteur.emit("evenement", e) };
  app = creerApp(ctx, emetteur);
});

describe("doctrine lisible, aperçu et retrait (API)", () => {
  it("montre pour chaque règle ses mots-clés, l'élément visé par son titre et le cas d'origine", async () => {
    const regles = (await app.inject("/api/regles")).json<RegleApi[]>();
    const d01 = regles.find((r) => r.id === "D01")!;
    expect(d01.motsCles).toEqual(["portefeuille"]);
    expect(d01.elements).toEqual([{ id: "B05", titre: "Tableau de bord portefeuille" }]);
    expect(d01.origine).toMatchObject({
      reponseId: "R001",
      questionId: "Q1",
      question: "Cette demande relève-t-elle de « Tableau de bord portefeuille » ou de « Permissions par projet » ?",
      resume: "Vue portefeuille",
      citation: "un tableau de bord portefeuille",
      feedbackId: "F072",
      choix: "B05",
      choixLibelle: "Tableau de bord portefeuille",
    });
    expect(d01.retireeLe).toBeNull();
  });

  it("donne l'aperçu d'une règle proposée, en clair, et 404 pour une règle inconnue", async () => {
    const r = await app.inject("/api/regles/D02/apercu");
    expect(r.statusCode).toBe(200);
    const a = r.json<ApercuRegleApi>();
    expect(a.resume).toBe("Si vous validez : 1 demande déjà reçue serait rattachée à « Tableau de bord portefeuille », dont 1 changerait d'élément.");
    expect(a.captees).toMatchObject([{ feedbackId: "F1", changerait: true, actuel: { element: { titre: "Permissions par projet" } } }]);
    expect(a.proches.map((p) => p.regleId)).toEqual(["D01"]);
    expect(a.bloquante).toBe(false);
    expect((await app.inject("/api/regles/D99/apercu")).statusCode).toBe(404);
  });

  it("retire une règle active, journalisé, et refuse un second retrait", async () => {
    const r = await app.inject({ method: "POST", url: "/api/regles/D01/retirer" });
    expect(r.statusCode).toBe(200);
    expect(r.json<RetraitRegleApi>()).toEqual({ statut: "retiree", version: 1 });

    const regles = (await app.inject("/api/regles")).json<RegleApi[]>();
    const d01 = regles.find((x) => x.id === "D01")!;
    expect(d01.statut).toBe("retiree");
    expect(d01.retireeLe).not.toBeNull();
    const journal = (await app.inject("/api/journal")).json<EntreeJournalApi[]>();
    expect(journal.find((j) => j.action === "retirer_regle")).toMatchObject({ acteur: "po", cible: "D01" });
    // La preuve déjà rattachée ne bouge pas.
    expect((await db.query<{ item_id: string }>("SELECT item_id FROM preuves WHERE id = 'P1'")).rows[0]?.item_id).toBe("B02");

    // Une fois D01 retirée, elle n'est plus une règle proche de D02.
    expect((await app.inject("/api/regles/D02/apercu")).json<ApercuRegleApi>().proches).toEqual([]);

    const encore = await app.inject({ method: "POST", url: "/api/regles/D01/retirer" });
    expect(encore.statusCode).toBe(400);
    expect(encore.json()).toMatchObject({ erreur: expect.stringMatching(/Aucune règle active D01/) });
    expect((await app.inject({ method: "POST", url: "/api/regles/D02/retirer" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/regles/D99/retirer" })).statusCode).toBe(404);
  });
});
