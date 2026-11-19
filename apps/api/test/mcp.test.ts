import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fileTachesPostgres, migrer, ouvrirPGlite, type Db } from "@po-agent/db";
import { FournisseurFaux } from "@po-agent/llm";
import { ingerer, viderFile, type Contexte } from "@po-agent/agent";
import { creerApp } from "../src/app.ts";
import { creerServeurMcp } from "../src/mcp.ts";

let db: Db;
let ctx: Contexte;

beforeAll(async () => {
  db = await ouvrirPGlite();
  await migrer(db);
  await db.exec(`
    INSERT INTO comptes (id, nom, plan, mrr) VALUES ('CF1', 'Libre', 'free', 0);
    INSERT INTO items (id, titre, type, statut, complexite, alignement_objectif) VALUES ('B04', 'Mode sombre', 'fonctionnalite', 'backlog', 'S', FALSE);
  `);
  ctx = { db, llm: new FournisseurFaux(), file: fileTachesPostgres(db, 0), maintenant: () => new Date("2026-11-09T09:00:00Z"), diffuser: () => {} };
  await ingerer(ctx, { id: "F1", compteId: "CF1", canal: "commentaire", recuLe: "2026-11-08T10:00:00Z", texte: "Un mode sombre svp !" });
  await viderFile(ctx);
});
afterAll(async () => {
  await db.close();
});

type Texte = { content: Array<{ type: string; text: string }> };

describe("serveur MCP de l'agent PO", () => {
  it("expose les outils de lecture, annotés en lecture seule, et l'outil de suggestion", async () => {
    const [cote, serveurCote] = InMemoryTransport.createLinkedPair();
    await creerServeurMcp(ctx).connect(serveurCote);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(cote);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["chercher_feedbacks", "classement", "detail_item", "doctrine", "proposer_au_po", "simuler"]);
    expect(tools.filter((t) => t.annotations?.readOnlyHint).length).toBe(5);

    const classement = (await client.callTool({ name: "classement", arguments: { limite: 3 } })) as Texte;
    expect(classement.content[0]!.text).toMatch(/B04 « Mode sombre »/);

    const suggestion = (await client.callTool({ name: "proposer_au_po", arguments: { resume: "Regrouper les demandes de thème visuel.", item_id: "B04" } })) as Texte;
    expect(suggestion.content[0]!.text).toMatch(/rien n'est appliqué sans sa décision/);
    const p = await db.query<{ type: string; statut: string }>("SELECT type, statut FROM propositions WHERE type = 'suggestion'");
    expect(p.rows).toEqual([{ type: "suggestion", statut: "en_attente" }]);
    await client.close();
  });

  it("répond en HTTP streamable sur /mcp, dans le processus de l'API", async () => {
    const app = creerApp(ctx, new EventEmitter());
    await app.listen({ port: 0, host: "127.0.0.1" });
    const adresse = app.server.address();
    const port = typeof adresse === "object" && adresse ? adresse.port : 0;
    const client = new Client({ name: "test-http", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const doctrine = (await client.callTool({ name: "doctrine", arguments: {} })) as Texte;
    expect(doctrine.content[0]!.text).toBe("Aucune règle active.");
    await client.close();
    await app.close();
  });
});
