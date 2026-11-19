import { demarrerWorker } from "@po-agent/agent";
import { choisirFournisseur, creerContexte, creerDiffuseur, horloge, lireConfig, ouvrirBase, chargerEnvLocal } from "./config.ts";

// Commande locale : lit .env sans écraser l'environnement (voir chargerEnvLocal).
chargerEnvLocal();

/** Worker séparé (Docker Compose) : il prend les tâches de la file et publie ses événements par NOTIFY. */
const config = lireConfig();
if (!config.databaseUrl) {
  console.error("Le worker séparé exige DATABASE_URL (Postgres partagé avec l'API). En local, lancez l'API en mode tout-en-un.");
  process.exit(1);
}
const db = await ouvrirBase(config);
const { diffuser } = creerDiffuseur(db, true);
const ctx = creerContexte(db, choisirFournisseur(db), horloge(config.dateScenario), diffuser);
demarrerWorker(ctx);
console.log(`Worker de l'agent PO démarré · fournisseur : ${ctx.llm.nom}`);
