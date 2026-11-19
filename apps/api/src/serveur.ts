import { demarrerWorker } from "@po-agent/agent";
import { creerApp } from "./app.ts";
import { demarrerTelegram } from "./notificateur.ts";
import { CANAL_NOTIFY, choisirFournisseur, creerContexte, creerDiffuseur, horloge, lireConfig, ouvrirBase, chargerEnvLocal } from "./config.ts";

// Commande locale : lit .env sans écraser l'environnement (voir chargerEnvLocal).
chargerEnvLocal();

const config = lireConfig();
const db = await ouvrirBase(config);
const llm = choisirFournisseur(db);
const { emetteur, diffuser } = creerDiffuseur(db, false);
const ctx = creerContexte(db, llm, horloge(config.dateScenario), diffuser);

if (config.mode === "tout-en-un") {
  demarrerWorker(ctx);
} else if (config.databaseUrl) {
  // Worker séparé : ses événements arrivent par LISTEN/NOTIFY.
  const { default: pg } = await import("pg");
  const ecoute = new pg.Client({ connectionString: config.databaseUrl });
  await ecoute.connect();
  await ecoute.query(`LISTEN ${CANAL_NOTIFY}`);
  ecoute.on("notification", (n) => {
    if (n.payload) emetteur.emit("evenement", JSON.parse(n.payload));
  });
}

const telegram = demarrerTelegram(ctx, emetteur);
const app = creerApp(ctx, emetteur);
await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`API de l'agent PO sur http://localhost:${config.port} · fournisseur : ${llm.nom} · mode : ${config.mode} · Telegram : ${telegram ? "actif (les lignes « Telegram, bot … » disent si chaque bot répond)" : "inactif (aucun jeton)"}`);
