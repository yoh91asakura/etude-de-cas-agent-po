import { EventEmitter } from "node:events";
import { beforeAll, describe, expect, it } from "vitest";
import { fileTachesPostgres, migrer, ouvrirPGlite } from "@po-agent/db";
import { FournisseurFaux, type CandidatItem, type DemandeARattacher, type VerdictLLM } from "@po-agent/llm";
import type { Extraction } from "@po-agent/domain";
import { ingerer, viderFile, type Contexte } from "@po-agent/agent";
import { creerApp } from "../src/app.ts";
import { texteQuestionTelegram } from "../src/contexte-decision.ts";
import type { AlerteApi, FicheFeedbackApi, ProduitApi, PropositionApi, QuestionApi } from "../src/contrat.ts";

/** Le contexte des décisions (session 4) : ce que le PO voit pour trancher, dans le cockpit comme sur Telegram. */

class FournisseurScripte extends FournisseurFaux {
  override async extraire(f: { id: string; texte: string }): Promise<Extraction> {
    if (f.id === "F1") {
      return { feedbackId: f.id, nature: "demande", injectionSuspectee: false, menaceDepart: true, demandes: [{ resume: "Prendre en charge le mode sombre du navigateur", citation: "Vous pourriez l'ajouter ?", regression: false }] };
    }
    if (f.id === "F3") {
      return { feedbackId: f.id, nature: "demande", injectionSuspectee: false, menaceDepart: false, demandes: [{ resume: "Exporter les tâches vers Excel", citation: "un export Excel", regression: false }] };
    }
    return { feedbackId: f.id, nature: "question", injectionSuspectee: false, menaceDepart: false, demandes: [{ resume: "Vérifier un double prélèvement", citation: "débités deux fois", regression: false }] };
  }
  override async jugerRattachement(d: DemandeARattacher, _c: CandidatItem[], tirage = 0): Promise<VerdictLLM> {
    if (d.resume.startsWith("Vérifier")) return { itemId: null, verdict: "different", alternatives: [], justification: "Aucun élément ne parle de facturation." };
    if (d.resume.startsWith("Exporter")) return { itemId: null, verdict: "different", alternatives: [], justification: "Aucun élément ne parle d'export." };
    return tirage === 0
      ? { itemId: "B04", verdict: "meme_besoin", alternatives: [], justification: "Le client parle du mode sombre." }
      : { itemId: null, verdict: "incertain", alternatives: ["B04"], justification: "La citation seule ne dit pas quoi ajouter." };
  }
}

let app: ReturnType<typeof creerApp>;

beforeAll(async () => {
  const db = await ouvrirPGlite();
  await migrer(db);
  await db.exec(`
    INSERT INTO comptes (id, nom, plan, mrr) VALUES ('CF1', 'Blanchard Déco', 'free', 0), ('CP1', 'Atelier Pro', 'pro', 900), ('CB1', 'Grand Compte', 'business', 5000);
    INSERT INTO items (id, titre, type, statut, complexite, alignement_objectif) VALUES ('B04', 'Mode sombre', 'fonctionnalite', 'backlog', 'S', FALSE);
  `);
  const emetteur = new EventEmitter();
  const ctx: Contexte = { db, llm: new FournisseurScripte(), file: fileTachesPostgres(db, 0), maintenant: () => new Date("2026-11-09T09:00:00Z"), diffuser: (e) => emetteur.emit("evenement", e) };
  await ingerer(ctx, { id: "F1", compteId: "CF1", canal: "commentaire", recuLe: "2026-11-08T10:00:00Z", texte: "Le mode sombre de mon navigateur ne s'applique pas à Jalonne, tout reste blanc. Vous pourriez l'ajouter ?" });
  await ingerer(ctx, { id: "F2", compteId: "CP1", canal: "email", recuLe: "2026-11-08T11:00:00Z", texte: "On a été débités deux fois ce mois-ci ??" });
  await ingerer(ctx, { id: "F3", compteId: "CP1", canal: "ticket", recuLe: "2026-11-08T12:00:00Z", texte: "Il nous faudrait un export Excel des tâches." });
  await viderFile(ctx);
  app = creerApp(ctx, emetteur);
});

describe("Contexte des décisions", () => {
  it("donne à une question le message complet, le client, les lectures de l'agent et l'effet de chaque réponse", async () => {
    const [q] = (await app.inject("/api/questions")).json<QuestionApi[]>();
    expect(q?.feedback?.texte).toContain("tout reste blanc");
    expect(q?.feedback?.compte).toMatchObject({ nom: "Blanchard Déco", plan: "free" });
    expect(q?.lectures?.map((l) => l.verdict)).toEqual(["meme_besoin", "incertain", "incertain"]);
    expect(q?.items.map((i) => i.titre)).toEqual(["Mode sombre"]);
    const effets = Object.fromEntries(q!.options.map((o) => [o.valeur, o.effet]));
    expect(effets.B04).toMatch(/score de « Mode sombre »/);
    expect(effets.nouvel_item).toMatch(/Crée un nouvel élément/);
    expect(effets.ignorer).toMatch(/ne comptera dans aucun score/);
    // Telegram reçoit le même contexte, autonome.
    const texte = texteQuestionTelegram(q!);
    expect(texte).toContain("Blanchard Déco");
    expect(texte).toContain("tout reste blanc");
    expect(texte).toContain("L'agent a compris");
  });

  it("ouvre la fiche d'un message, avec ce que l'agent en a fait", async () => {
    const f = (await app.inject("/api/feedbacks/F1")).json<FicheFeedbackApi>();
    expect(f.demandes[0]?.citation).toBe("Vous pourriez l'ajouter ?");
    expect(f.rattachements).toEqual([{ itemId: "B04", titre: "Mode sombre", sure: false, regleId: null }]);
    expect((await app.inject("/api/feedbacks/F999")).statusCode).toBe(404);
  });

  it("montre la source d'un nouvel élément proposé, et sa nature", async () => {
    const props = (await app.inject("/api/propositions")).json<PropositionApi[]>();
    const nouvel = props.find((p) => p.type === "nouvel_item")!;
    expect(nouvel.details.type).toBe("nouvel_item");
    if (nouvel.details.type === "nouvel_item") {
      expect(nouvel.details.sources[0]).toMatchObject({ feedbackId: "F3", nature: "demande", compte: { nom: "Atelier Pro" } });
    }
    expect(nouvel.effet).toMatch(/entrer cet élément au backlog/);
  });

  it("n'ouvre pas d'élément candidat pour une question de support sans élément correspondant", async () => {
    const props = (await app.inject("/api/propositions")).json<PropositionApi[]>();
    expect(props.filter((p) => p.type === "nouvel_item")).toHaveLength(1);
    const f = (await app.inject("/api/feedbacks/F2")).json<FicheFeedbackApi>();
    expect(f.rattachements).toEqual([]);
  });

  it("donne aux alertes une cible ouvrable, et à l'alerte de départ la demande du client", async () => {
    const alertes = (await app.inject("/api/alertes")).json<AlerteApi[]>();
    const depart = alertes.find((a) => a.type === "risque_depart")!;
    expect(depart.cible).toEqual({ type: "feedback", id: "F1" });
    expect(depart.message).toContain("Prendre en charge le mode sombre");
  });

  it("décrit le produit fictif à partir du scénario et des données", async () => {
    const p = (await app.inject("/api/produit")).json<ProduitApi>();
    expect(p.nom).toBe("Jalonne");
    expect(p.objectifTrimestre).toMatch(/plus de 50 personnes/);
    expect(p.comptes.map((c) => c.plan)).toEqual(["free", "pro", "business"]);
    expect(p.mrrTotal).toBe(5900);
  });
});
