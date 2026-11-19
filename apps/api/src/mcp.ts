import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { journaliser } from "@po-agent/db";
import { outilsConversation, prochainId, type Contexte } from "@po-agent/agent";

/**
 * Serveur MCP de l'agent PO : les assistants du socle du client (Claude Desktop, Copilot, Rovo…) peuvent
 * lire le backlog vivant, simuler, et déposer une suggestion pour le PO. Ils ne valident jamais rien.
 * Les outils de lecture sont ceux de l'agent conversationnel, annotés en lecture seule (readOnlyHint).
 */
export function creerServeurMcp(ctx: Contexte): McpServer {
  const serveur = new McpServer({ name: "agent-po-jalonne", version: "0.1.0" });

  for (const outil of outilsConversation(ctx)) {
    serveur.registerTool(
      outil.nom,
      { description: outil.description, inputSchema: outil.schema, annotations: { readOnlyHint: true } },
      async (args: unknown) => ({ content: [{ type: "text" as const, text: await outil.executer(args) }] }),
    );
  }

  serveur.registerTool(
    "proposer_au_po",
    {
      description: "Dépose une suggestion dans la boîte de l'agent, que le PO acceptera ou refusera. Ne modifie pas le backlog.",
      inputSchema: z.object({
        resume: z.string().min(5).max(500).describe("La suggestion, en une ou deux phrases"),
        item_id: z.string().optional().describe("Élément du backlog concerné, s'il y en a un"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args: { resume: string; item_id?: string }) => {
      const id = await prochainId(ctx.db, "PR", "propositions");
      await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "systeme", action: "suggestion_mcp", cible: id, details: { itemId: args.item_id ?? null } });
      await ctx.db.query("INSERT INTO propositions (id, type, charge, resume, creee_le) VALUES ($1, 'suggestion', $2, $3, $4)", [
        id,
        JSON.stringify({ source: "assistant MCP", ...(args.item_id ? { itemId: args.item_id } : {}) }),
        `Suggestion d'un assistant du socle : ${args.resume}`,
        ctx.maintenant().toISOString(),
      ]);
      ctx.diffuser({ type: "proposition", donnees: { id, type: "suggestion" } });
      return { content: [{ type: "text" as const, text: `Suggestion ${id} déposée. Le PO la verra dans la boîte de l'agent ; rien n'est appliqué sans sa décision.` }] };
    },
  );

  return serveur;
}
