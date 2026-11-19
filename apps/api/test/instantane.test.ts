import { describe, expect, it } from "vitest";
import { fileTachesPostgres, migrer, ouvrirPGlite } from "@po-agent/db";
import { FournisseurFaux } from "@po-agent/llm";
import { classement, ingerer, viderFile, type Contexte } from "@po-agent/agent";
import { exporterInstantane, importerInstantane } from "../src/instantane.ts";

async function contexte(): Promise<Contexte> {
  const db = await ouvrirPGlite();
  await migrer(db);
  return { db, llm: new FournisseurFaux(), file: fileTachesPostgres(db, 0), maintenant: () => new Date("2026-11-09T09:00:00Z"), diffuser: () => {} };
}

describe("instantané de démo", () => {
  it("restitue à l'identique un état traité, sans rien retraiter", async () => {
    const source = await contexte();
    await source.db.exec(`
      INSERT INTO comptes (id, nom, plan, mrr) VALUES ('CF1', 'Libre', 'free', 0), ('CB1', 'Grand', 'business', 5000);
      INSERT INTO items (id, titre, type, statut, complexite, alignement_objectif) VALUES
        ('B03', 'SSO (SAML, Okta, Entra ID)', 'fonctionnalite', 'backlog', 'M', TRUE),
        ('B04', 'Mode sombre', 'fonctionnalite', 'backlog', 'S', FALSE);
    `);
    await ingerer(source, { id: "F1", compteId: "CF1", canal: "commentaire", recuLe: "2026-11-08T10:00:00Z", texte: "Un mode sombre svp !" });
    await ingerer(source, { id: "F2", compteId: "CB1", canal: "email", recuLe: "2026-11-08T11:00:00Z", texte: "Il nous faut le SSO via Okta." });
    await viderFile(source);
    const instantane = JSON.parse(JSON.stringify(await exporterInstantane(source.db, "faux")));

    const cible = await contexte();
    const comptes = await importerInstantane(cible.db, instantane);
    expect(comptes.feedbacks).toBe(2);
    expect(await classement(cible, ["mrr"])).toEqual(await classement(source, ["mrr"]));
    expect((await cible.db.query("SELECT 1 FROM taches")).rows).toHaveLength(0);

    // Les séquences sont recalées : une nouvelle alerte s'insère sans conflit d'identifiant.
    await cible.db.query("INSERT INTO alertes (type, message) VALUES ('test', 'ok')");
    await source.db.close();
    await cible.db.close();
  });

  it("refuse un fichier qui n'est pas un instantané", async () => {
    const ctx = await contexte();
    await expect(importerInstantane(ctx.db, { format: "autre" } as never)).rejects.toThrow(/format inconnu/);
    await ctx.db.close();
  });
});
