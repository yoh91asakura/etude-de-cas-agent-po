import { describe, expect, it } from "vitest";
import { fileTachesPostgres, migrer, ouvrirPGlite } from "@po-agent/db";
import { FournisseurFaux, type MessageConversation, type OutilConversation, type ReponseConversation } from "@po-agent/llm";
import { converser, type Contexte } from "../src/index.ts";

/**
 * Invariant « chaque citation est vérifiée mot pour mot », appliqué aux réponses de la conversation.
 * Le banc des prompts a vu les trois modèles citer au moins une fois un passage inexact : le code doit le signaler au PO.
 */

const MAINTENANT = new Date("2026-11-09T09:00:00Z");

/** Fournisseur qui appelle l'outil « detail_item », puis répond le texte que le test lui donne. */
class FournisseurCitant extends FournisseurFaux {
  constructor(private readonly reponse: (sortieOutil: string) => string) {
    super();
  }
  override async converser(entree: { message: string; historique: MessageConversation[]; outils: OutilConversation[] }): Promise<ReponseConversation> {
    const outil = entree.outils.find((o) => o.nom === "detail_item")!;
    const sortie = await outil.executer({ item_id: "B02" });
    return { texte: this.reponse(sortie), appels: [{ outil: "detail_item", entree: { item_id: "B02" } }] };
  }
}

async function monter(reponse: (sortieOutil: string) => string): Promise<Contexte> {
  const db = await ouvrirPGlite();
  await migrer(db);
  await db.exec(`
    INSERT INTO comptes (id, nom, plan, mrr) VALUES ('CB1', 'Grand Compte', 'business', 5000);
    INSERT INTO items (id, titre, type, statut, complexite, alignement_objectif) VALUES ('B02', 'Permissions par projet', 'fonctionnalite', 'backlog', 'L', TRUE);
    INSERT INTO feedbacks (id, compte_id, canal, recu_le, texte, empreinte, statut) VALUES
      ('F1', 'CB1', 'email', '2026-11-08T10:00:00Z', 'Nos sous-traitants ne doivent voir que leur chantier, rien de plus.', 'e1', 'traite');
    INSERT INTO preuves (id, item_id, feedback_id, compte_id, canal, recu_le, citation, sure) VALUES
      ('PT1', 'B02', 'F1', 'CB1', 'email', '2026-11-08T10:00:00Z', 'Nos sous-traitants ne doivent voir que leur chantier', TRUE);
  `);
  return { db, llm: new FournisseurCitant(reponse), file: fileTachesPostgres(db, 0), maintenant: () => MAINTENANT, diffuser: () => {} };
}

describe("Conversation : citations vérifiées", () => {
  it("laisse intacte une réponse dont chaque citation figure dans ce que les outils ont rendu", async () => {
    const ctx = await monter(() => "Le client écrit « Nos sous-traitants ne doivent voir que leur chantier » : c'est le cloisonnement par projet.");
    const r = await converser(ctx, "Pourquoi B02 ?");
    expect(r.texte).not.toContain("Vérification du code");
  });

  it("signale au PO une citation introuvable, et la consigne dans le journal", async () => {
    const ctx = await monter(() => "Le client écrit « Nos sous-traitants exigent un cloisonnement strict par chantier » : c'est urgent.");
    const r = await converser(ctx, "Pourquoi B02 ?");
    expect(r.texte).toContain("Vérification du code");
    expect(r.texte).toContain("« Nos sous-traitants exigent un cloisonnement strict par chantier »");
    const journal = await ctx.db.query<{ details: { citationsNonVerifiees?: string[] }; horodatage: unknown }>("SELECT details, horodatage FROM journal_activite WHERE action = 'question_libre'");
    expect(journal.rows[0]?.details.citationsNonVerifiees).toEqual(["Nos sous-traitants exigent un cloisonnement strict par chantier"]);
    // Le journal suit l'horloge du scénario, comme les feedbacks : une seule date visible dans le cockpit.
    expect(new Date(String(journal.rows[0]?.horodatage)).toISOString()).toBe(MAINTENANT.toISOString());
  });

  it("accepte une citation reprise de la question du PO, mais pas un texte brut que les outils n'ont pas rendu", async () => {
    // Le texte brut du feedback contient « rien de plus » : les outils n'en rendent que la citation extraite.
    const ctx = await monter(() => "Vous demandez « est-ce que B02 doit passer avant le reste » ; le client ajoute « voir que leur chantier, rien de plus ».");
    const r = await converser(ctx, "Dis-moi est-ce que B02 doit passer avant le reste ?");
    expect(r.texte).toContain("Vérification du code : ce passage");
    expect(r.texte).toContain("« voir que leur chantier, rien de plus »");
    const avertissement = r.texte.split("\n\n").at(-1) ?? "";
    expect(avertissement).not.toContain("est-ce que B02");
  });
});
