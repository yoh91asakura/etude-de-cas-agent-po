import { describe, expect, it } from "vitest";
import type { Story } from "@po-agent/domain";
import { fileTachesPostgres, migrer, ouvrirPGlite } from "@po-agent/db";
import { FournisseurFaux } from "@po-agent/llm";
import { deciderProposition, type Contexte, type OutilDeSuivi } from "@po-agent/agent";
import { descriptionAdf, outilJira } from "../src/jira.ts";

const story: Story = {
  itemId: "B03",
  enTantQue: "administrateur d'un compte Business",
  jeVeux: "connecter Jalonne à notre fournisseur d'identité",
  afinDe: "gérer les accès de nos collaborateurs depuis un seul endroit",
  criteres: [
    { etantDonne: "un fournisseur SAML configuré", quand: "un collaborateur se connecte", alors: "il est authentifié sans mot de passe Jalonne" },
    { etantDonne: "un collaborateur désactivé chez le fournisseur", quand: "il tente de se connecter", alors: "l'accès est refusé" },
  ],
  casLimites: ["Compte invité hors annuaire"],
  complexite: "M",
  citations: ["nous ne renouvellerons pas sans SSO"],
};

describe("adaptateur Jira (fetch factice)", () => {
  it("crée le ticket avec l'authentification Basic documentée et une description ADF", async () => {
    let requete: { url: string; init: { headers: Record<string, string>; body: string } } | undefined;
    const f = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      requete = { url, init };
      return { ok: true, status: 201, json: async () => ({ id: "10001", key: "JAL-12", self: "x" }) };
    }) as unknown as typeof fetch;
    const jira = outilJira({ site: "https://exemple.atlassian.net/", email: "po@exemple.fr", jetonApi: "jeton", projet: "JAL", fetch: f });
    const ticket = await jira.creerTicket(story, "SSO (SAML, Okta, Entra ID)");
    expect(ticket).toEqual({ cle: "JAL-12", url: "https://exemple.atlassian.net/browse/JAL-12" });
    expect(requete!.url).toBe("https://exemple.atlassian.net/rest/api/3/issue");
    expect(requete!.init.headers.Authorization).toBe(`Basic ${Buffer.from("po@exemple.fr:jeton").toString("base64")}`);
    const corps = JSON.parse(requete!.init.body) as { fields: { project: { key: string }; issuetype: { name: string }; description: { type: string; version: number } } };
    expect(corps.fields).toMatchObject({ project: { key: "JAL" }, issuetype: { name: "Story" }, description: { type: "doc", version: 1 } });
  });

  it("remonte une erreur lisible quand Jira refuse", async () => {
    const f = (async () => ({ ok: false, status: 400, json: async () => ({ errorMessages: [], errors: { issuetype: "Type inconnu" } }) })) as unknown as typeof fetch;
    const jira = outilJira({ site: "https://exemple.atlassian.net", email: "a", jetonApi: "b", projet: "JAL", fetch: f });
    await expect(jira.creerTicket(story, "SSO")).rejects.toThrow(/Type inconnu/);
  });

  it("met chaque critère d'acceptation dans une liste ADF", () => {
    const adf = descriptionAdf(story) as { content: Array<{ type: string; content?: unknown[] }> };
    const listes = adf.content.filter((n) => n.type === "bulletList");
    expect(listes[0]!.content).toHaveLength(2);
  });
});

describe("export après décision du PO", () => {
  it("propose l'export d'une story validée, et n'exporte qu'après une seconde décision", async () => {
    const db = await ouvrirPGlite();
    await migrer(db);
    await db.exec(`
      INSERT INTO items (id, titre, type, statut, complexite) VALUES ('B03', 'SSO', 'fonctionnalite', 'backlog', 'M');
      INSERT INTO stories (id, item_id, contenu, controles) VALUES ('S001', 'B03', '${JSON.stringify(story).replaceAll("'", "''")}', '[]');
      INSERT INTO propositions (id, type, charge, resume) VALUES ('PR001', 'story_prete', '{"storyId":"S001","itemId":"B03"}', 'Story prête');
    `);
    const crees: string[] = [];
    const suivi: OutilDeSuivi = { nom: "Jira", creerTicket: async (_s, titre) => (crees.push(titre), { cle: "JAL-1", url: "https://x/browse/JAL-1" }) };
    const ctx: Contexte = { db, llm: new FournisseurFaux(), file: fileTachesPostgres(db, 0), maintenant: () => new Date(), diffuser: () => {}, suivi };

    await deciderProposition(ctx, "PR001", true);
    expect(crees).toHaveLength(0);
    const exportPropose = await db.query<{ id: string; resume: string }>("SELECT id, resume FROM propositions WHERE type = 'export_jira' AND statut = 'en_attente'");
    expect(exportPropose.rows).toHaveLength(1);
    // Le PO lit le titre de l'item, pas son identifiant.
    expect(exportPropose.rows[0]!.resume).toBe("Exporter vers Jira la story validée de « SSO »");

    await deciderProposition(ctx, exportPropose.rows[0]!.id, true);
    expect(crees).toEqual(["SSO"]);
    expect((await db.query<{ statut: string; ticket_cle: string }>("SELECT statut, ticket_cle FROM stories WHERE id = 'S001'")).rows[0]).toEqual({ statut: "exportee", ticket_cle: "JAL-1" });
    await db.close();
  });
});
