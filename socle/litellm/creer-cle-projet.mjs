#!/usr/bin/env node
/**
 * Crée la clé virtuelle du projet « agent PO » sur la passerelle LLM du socle (LiteLLM)
 * et l'écrit dans .env (LITELLM_CLE_PROJET). La clé n'est jamais affichée.
 *
 * Pourquoi : l'agent ne doit pas appeler le modèle avec la clé maître de la passerelle.
 * La clé de projet limite les modèles autorisés et plafonne la dépense (budget remis à zéro
 * à chaque période), et la passerelle attribue chaque appel à ce projet.
 *
 * Usage (passerelle démarrée : docker compose up -d postgres passerelle-llm) :
 *   node socle/litellm/creer-cle-projet.mjs [--budget 20] [--periode 30d] [--env .env]
 *
 * Variables lues : LITELLM_MASTER_KEY (défaut du compose : sk-socle-local),
 * PASSERELLE_URL (défaut : http://localhost:4000).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Les modèles de l'agent, choisis étape par étape (docs/decisions/013-choix-modele-par-etape.md).
const MODELES = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

const args = process.argv.slice(2);
const option = (nom, defaut) => {
  const i = args.indexOf(`--${nom}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : defaut;
};
const fichierEnv = option("env", ".env");
const budget = Number(option("budget", "20"));
const periode = option("periode", "30d");
const passerelle = (process.env.PASSERELLE_URL ?? "http://localhost:4000").replace(/\/$/, "");

/** Lit une variable du fichier .env sans l'afficher. */
function lireEnv(cle) {
  if (!existsSync(fichierEnv)) return undefined;
  const ligne = readFileSync(fichierEnv, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${cle}=`));
  return ligne?.slice(cle.length + 1).trim() || undefined;
}

/** Remplace ou ajoute une variable dans le fichier .env. */
function ecrireEnv(cle, valeur) {
  const lignes = existsSync(fichierEnv) ? readFileSync(fichierEnv, "utf8").split(/\r?\n/) : [];
  const i = lignes.findIndex((l) => l.startsWith(`${cle}=`));
  if (i >= 0) lignes[i] = `${cle}=${valeur}`;
  else {
    if (lignes.at(-1) === "") lignes.pop();
    lignes.push("# Clé virtuelle du projet « agent PO », créée par socle/litellm/creer-cle-projet.mjs.", `${cle}=${valeur}`, "");
  }
  writeFileSync(fichierEnv, lignes.join("\n"));
}

async function appeler(chemin, cleMaitre, init) {
  let r;
  try {
    r = await fetch(`${passerelle}${chemin}`, { ...init, headers: { Authorization: `Bearer ${cleMaitre}`, "Content-Type": "application/json" } });
  } catch {
    throw new Error(`Passerelle injoignable sur ${passerelle}. Démarrez-la : docker compose up -d postgres passerelle-llm`);
  }
  return { statut: r.status, corps: await r.json().catch(() => null) };
}

async function principal() {
  if (!Number.isFinite(budget) || budget <= 0) throw new Error("--budget doit être un montant positif en dollars.");
  const cleMaitre = process.env.LITELLM_MASTER_KEY ?? lireEnv("LITELLM_MASTER_KEY") ?? "sk-socle-local";

  // Une clé déjà présente et reconnue par la passerelle : rien à faire.
  const existante = lireEnv("LITELLM_CLE_PROJET");
  if (existante) {
    const info = await appeler(`/key/info?key=${encodeURIComponent(existante)}`, cleMaitre, { method: "GET" });
    if (info.statut === 200) {
      const i = info.corps?.info ?? {};
      console.log(`Clé de projet déjà configurée dans ${fichierEnv} (alias ${i.key_alias ?? "?"}, dépense ${i.spend ?? 0} $ sur ${i.max_budget ?? "∞"} $).`);
      return;
    }
    console.log("La clé présente dans le fichier n'est pas reconnue par la passerelle : création d'une nouvelle clé.");
  }

  // La passerelle exige des alias uniques : l'horodatage les distingue.
  const alias = `agent-po-${new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}`;
  const { statut, corps } = await appeler("/key/generate", cleMaitre, {
    method: "POST",
    body: JSON.stringify({
      key_alias: alias,
      models: MODELES,
      max_budget: budget,
      budget_duration: periode,
      metadata: { projet: "agent-po", creee_par: "socle/litellm/creer-cle-projet.mjs" },
    }),
  });
  if (statut !== 200 || typeof corps?.key !== "string") {
    throw new Error(`La passerelle a refusé la création (${statut}) : ${corps?.error?.message ?? corps?.detail ?? JSON.stringify(corps)}`);
  }
  ecrireEnv("LITELLM_CLE_PROJET", corps.key);
  console.log(`Clé de projet ${alias} créée (modèles : ${MODELES.join(", ")} ; budget : ${budget} $ par période de ${periode}).`);
  console.log(`Écrite dans ${fichierEnv} sous LITELLM_CLE_PROJET (non affichée). Relancez : docker compose up -d api worker`);
}

// Pas de process.exit() : sous Windows, quitter pendant la fermeture des connexions fait échouer une assertion de Node.
principal().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
