import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { passageDeFond, viderFile } from "@po-agent/agent";
import { choisirFournisseur, creerContexte, creerDiffuseur, horloge, lireConfig, ouvrirBase, RACINE, chargerEnvLocal } from "./config.ts";
import { exporterInstantane, importerInstantane, type Instantane } from "./instantane.ts";
import { chargerSeed } from "./seed.ts";

// Commande locale : lit .env sans écraser l'environnement (voir chargerEnvLocal).
chargerEnvLocal();

/**
 * Prépare l'état de départ de la démo.
 * - Par défaut : charge les comptes, le backlog et les six semaines de feedbacks, puis fait tout traiter par la chaîne.
 * - --reinitialiser : repart d'une base vide (PGlite local uniquement).
 * - --exporter [fichier] : après traitement, écrit l'instantané (par défaut donnees/instantanes/etat-demo.json).
 * - --depuis-instantane [fichier] : charge l'instantané au lieu de tout retraiter (aucun appel au modèle).
 * - --si-instantane : comme --depuis-instantane si le fichier existe, sinon traitement complet (utilisé par le compose).
 */
const INSTANTANE_PAR_DEFAUT = path.join(RACINE, "donnees", "instantanes", "etat-demo.json");
const args = process.argv.slice(2);
function option(nom: string): string | null {
  const i = args.indexOf(nom);
  if (i < 0) return null;
  const valeur = args[i + 1];
  return valeur && !valeur.startsWith("--") ? path.resolve(valeur) : INSTANTANE_PAR_DEFAUT;
}

const config = lireConfig();
if (args.includes("--reinitialiser") && !config.databaseUrl) {
  await rm(config.pgliteDir, { recursive: true, force: true });
}
const db = await ouvrirBase(config);
const llm = choisirFournisseur(db);
const { diffuser } = creerDiffuseur(db, Boolean(config.databaseUrl));
// Mode lot : six semaines rejouées d'un coup ne doivent pas produire une alerte par mouvement du top 5.
const ctx = { ...creerContexte(db, llm, horloge(config.dateScenario), diffuser), modeLot: true };

const depuis = option("--depuis-instantane") ?? (args.includes("--si-instantane") && existsSync(INSTANTANE_PAR_DEFAUT) ? INSTANTANE_PAR_DEFAUT : null);
if (depuis) {
  const instantane = JSON.parse(await readFile(depuis, "utf8")) as Instantane;
  const comptes = await importerInstantane(db, instantane);
  console.log(`Instantané chargé (${instantane.fournisseur}, ${instantane.creeLe}) : ${comptes.feedbacks} feedbacks, ${comptes.items} items, ${comptes.scores} scores.`);
} else {
  console.log(`Préchargement · fournisseur : ${llm.nom}`);
  const r = await chargerSeed(ctx);
  console.log(`Chargés : ${r.comptes} comptes, ${r.items} items, ${r.feedbacks} nouveaux feedbacks`);
  const debut = Date.now();
  const n = await viderFile(ctx);
  const echecs = await db.query<{ type: string; erreur: string }>("SELECT type, erreur FROM taches WHERE statut = 'echec'");
  console.log(`${n} tâches exécutées en ${Math.round((Date.now() - debut) / 1000)} s · échecs : ${echecs.rows.length}`);
  for (const e of echecs.rows.slice(0, 10)) console.log(`  ✗ ${e.type} : ${e.erreur}`);

  // Le PO arrive le lundi matin : un premier passage de l'agent de fond lui prépare le résumé.
  const passage = await passageDeFond(ctx);
  console.log(`Passage de fond : ${passage.fusions} fusion(s) à trancher, ${passage.regles} règle(s) proposée(s).`);

  const vers = option("--exporter");
  if (vers) {
    await mkdir(path.dirname(vers), { recursive: true });
    await writeFile(vers, JSON.stringify(await exporterInstantane(db, llm.nom), null, 1));
    console.log(`Instantané écrit : ${path.relative(RACINE, vers)}`);
  }
}
await db.close();
