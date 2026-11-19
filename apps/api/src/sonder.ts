import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { migrer, ouvrirPGlite } from "@po-agent/db";
import type { Feedback } from "@po-agent/domain";
import { chargerEnvLocal, choisirFournisseur, depenseApres, depenseOpenRouter, DOSSIER_SEED } from "./config.ts";

// Commande locale : lit .env sans écraser l'environnement (voir chargerEnvLocal).
chargerEnvLocal();

/**
 * Sonde de la route vers le modèle, à lancer avant un banc payant : trois requêtes au plus.
 * 1. Une extraction (sortie structurée, effort, réflexion adaptative) sur un vrai feedback.
 * 2. Un tour de conversation avec un outil (deux requêtes : l'appel d'outil, puis la réponse).
 * Via OpenRouter, elle lit aussi ce qu'elle a coûté, sur la dépense de la clé.
 * Usage : npm run sonde -w @po-agent/api   (avec LLM_MODELE=claude-haiku-5-5 pour un test à bas coût)
 */

const db = await ouvrirPGlite();
await migrer(db);
const f = choisirFournisseur(db);
const depenseAvant = await depenseOpenRouter();
console.log(`Fournisseur : ${f.nom}`);
if (f.nom.startsWith("faux")) {
  console.log("Faux fournisseur : rien à sonder. Renseignez une clé dans .env.");
  process.exit(0);
}

const feedbacks = JSON.parse(await readFile(path.join(DOSSIER_SEED, "feedbacks.json"), "utf8")) as Feedback[];
const source = feedbacks.find((x) => x.id === "F012")!;
const resultats: Array<{ etape: string; ok: boolean; detail: string }> = [];

try {
  const ex = await f.extraire({ id: source.id, texte: source.texte });
  resultats.push({ etape: "extraction (sortie structurée)", ok: ex.demandes.length > 0, detail: `nature ${ex.nature}, ${ex.demandes.length} demande(s), menace ${ex.menaceDepart}` });
} catch (e) {
  resultats.push({ etape: "extraction (sortie structurée)", ok: false, detail: e instanceof Error ? e.message : String(e) });
}

try {
  const rep = await f.converser({
    message: "Quelle est la date du jour selon l'outil date_du_jour ? Réponds en une phrase.",
    historique: [],
    outils: [{ nom: "date_du_jour", description: "Renvoie la date du jour du scénario.", schema: z.object({}), executer: async () => "Lundi 9 novembre 2026" }],
  });
  resultats.push({ etape: "conversation (outil)", ok: rep.appels.some((a) => a.outil === "date_du_jour") && /9 novembre/.test(rep.texte), detail: `outils ${rep.appels.map((a) => a.outil).join(", ") || "aucun"} ; « ${rep.texte.slice(0, 80)} »` });
} catch (e) {
  resultats.push({ etape: "conversation (outil)", ok: false, detail: e instanceof Error ? e.message : String(e) });
}

for (const r of resultats) console.log(`${r.ok ? "OK " : "KO "} ${r.etape} : ${r.detail}`);
const traces = await db.query<{ etape: string; modele: string; statut: string; tokens_entree: number | null; tokens_sortie: number | null; duree_ms: number }>(
  "SELECT etape, modele, statut, tokens_entree, tokens_sortie, duree_ms FROM traces_llm ORDER BY id",
);
console.log("\nRequêtes tracées :");
for (const t of traces.rows) console.log(`- ${t.etape} · ${t.modele} · ${t.statut} · ${t.tokens_entree ?? "?"} → ${t.tokens_sortie ?? "?"} jetons · ${t.duree_ms} ms`);

// Via OpenRouter : le coût est lu sur la dépense de la clé, avant et après (l'épinglage sur Anthropic est vérifié par les tests).
const cout = await depenseApres(depenseAvant);
if (cout !== null) console.log(`\nCoût de la sonde, lu sur la clé OpenRouter : ${cout.toFixed(5)} $`);
process.exitCode = resultats.every((r) => r.ok) ? 0 : 1;
