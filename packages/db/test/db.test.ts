import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileTachesPostgres, journaliser, migrer, ouvrirPGlite, TENTATIVES_MAX, type Db } from "../src/index.ts";

let db: Db;

beforeAll(async () => {
  db = await ouvrirPGlite();
  await migrer(db);
});
afterAll(async () => {
  await db.close();
});

describe("migrations", () => {
  it("ne rejouent jamais une migration déjà appliquée", async () => {
    expect(await migrer(db)).toEqual([]);
  });
});

describe("contraintes du schéma", () => {
  it("refuse deux feedbacks de même empreinte", async () => {
    await db.query("INSERT INTO comptes (id, nom, plan, mrr) VALUES ('C1', 'Acme', 'pro', 500)");
    const insert = "INSERT INTO feedbacks (id, compte_id, canal, recu_le, texte, empreinte) VALUES ($1, 'C1', 'email', now(), 'x', 'E1')";
    await db.query(insert, ["F1"]);
    await expect(db.query(insert, ["F2"])).rejects.toThrow();
  });

  it("refuse une réponse dont l'auteur n'est pas le PO", async () => {
    await db.query("INSERT INTO questions (id, type, enonce, options, contexte) VALUES ('Q1', 'fusion', '?', '[]', '{}')");
    await expect(
      db.query("INSERT INTO reponses (id, question_id, auteur, choix, canal) VALUES ('R1', 'Q1', 'agent', 'oui', 'application')"),
    ).rejects.toThrow();
  });
});

describe("file de tâches", () => {
  it("n'ajoute jamais deux fois une tâche de même clé", async () => {
    const file = fileTachesPostgres(db);
    expect(await file.ajouter("extraire", { feedbackId: "F1" }, { cle: "extraire:F1" })).not.toBeNull();
    expect(await file.ajouter("extraire", { feedbackId: "F1" }, { cle: "extraire:F1" })).toBeNull();
  });

  it("prend, termine, et ne redonne pas une tâche faite", async () => {
    const file = fileTachesPostgres(db);
    await file.ajouter("scorer", { itemId: "B01" });
    const t = await file.prendre(["scorer"]);
    expect(t?.charge).toEqual({ itemId: "B01" });
    await file.terminer(t!.id);
    expect(await file.prendre(["scorer"])).toBeNull();
  });

  it("réessaie après un échec, puis abandonne au-delà du nombre maximal de tentatives", async () => {
    const file = fileTachesPostgres(db, 0);
    await file.ajouter("fragile", {});
    let issue: string = "";
    for (let i = 0; i < TENTATIVES_MAX; i++) {
      const t = await file.prendre(["fragile"]);
      expect(t).not.toBeNull();
      issue = await file.echouer(t!.id, "panne simulée");
    }
    expect(issue).toBe("echec");
    expect(await file.prendre(["fragile"])).toBeNull();
  });
});

describe("audit", () => {
  it("consigne les actions avec les règles citées", async () => {
    await journaliser(db, { acteur: "agent", action: "rattacher", cible: "F1", reglesCitees: ["D1"] });
    const r = await db.query<{ regles_citees: string[] }>("SELECT regles_citees FROM journal_activite WHERE cible = 'F1'");
    expect(r.rows[0]?.regles_citees).toEqual(["D1"]);
  });
});
