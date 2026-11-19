import type { EventEmitter } from "node:events";
import Fastify, { type FastifyInstance } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Contexte } from "@po-agent/agent";
import { creerServeurMcp } from "./mcp.ts";
import { enregistrerRoutes } from "./routes.ts";

export function creerApp(ctx: Contexte, emetteur: EventEmitter): FastifyInstance {
  const app = Fastify({ logger: false });
  enregistrerRoutes(app, ctx, emetteur);

  // Serveur MCP en HTTP « streamable », sans état : une instance par requête, dans le processus de l'API.
  app.post("/mcp", async (req, reply) => {
    reply.hijack();
    const serveur = creerServeurMcp(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.raw.on("close", () => {
      void transport.close();
      void serveur.close();
    });
    await serveur.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  return app;
}
