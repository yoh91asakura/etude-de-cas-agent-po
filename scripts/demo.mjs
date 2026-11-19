// Démo locale en une commande : npm run demo
// 1. Si l'état local n'existe pas, il est préparé (depuis l'instantané s'il existe, sinon par traitement complet).
// 2. L'API (avec son worker) et le cockpit démarrent ensemble ; Ctrl+C arrête les deux.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const etat = process.env.PGLITE_DIR ?? path.join(racine, "donnees", "etat-local");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function lancer(args, nom) {
  const enfant = spawn(npm, args, { cwd: racine, stdio: "inherit", shell: process.platform === "win32" });
  enfant.on("exit", (code) => {
    if (code && code !== 0) console.error(`[${nom}] arrêté (code ${code})`);
  });
  return enfant;
}

function attendre(enfant) {
  return new Promise((resoudre, rejeter) => enfant.on("exit", (code) => (code === 0 ? resoudre() : rejeter(new Error(`code ${code}`)))));
}

if (!existsSync(etat) || process.argv.includes("--reinitialiser")) {
  console.log("Préparation de l'état de démo…");
  await attendre(lancer(["run", "precharger", "-w", "@po-agent/api", "--", "--reinitialiser", "--si-instantane"], "préchargement"));
}

const api = lancer(["run", "start", "-w", "@po-agent/api"], "api");
const web = lancer(["run", "dev", "-w", "@po-agent/web"], "cockpit");
console.log("\nCockpit : http://localhost:5173 · API : http://localhost:3000 · Ctrl+C pour arrêter.\n");

const arreter = () => {
  api.kill();
  web.kill();
  process.exit(0);
};
process.on("SIGINT", arreter);
process.on("SIGTERM", arreter);
