import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileTachesPostgres, migrer, ouvrirPGlite } from "@po-agent/db";
import { ingerer, viderFile, type Contexte, type Evenement } from "@po-agent/agent";
import { choisirFournisseur, RACINE, chargerEnvLocal } from "./config.ts";
import { importerInstantane, type Instantane } from "./instantane.ts";
import { chargerSeed, feedbacksDirects } from "./seed.ts";

// Commande locale : lit .env sans écraser l'environnement (voir chargerEnvLocal).
chargerEnvLocal();

/**
 * Mesure de la latence du moment clé de la démo (cadrage : objectif d'environ 30 s, mesuré dès J4).
 * Part de l'instantané s'il existe (sinon du jeu complet, ce qui coûte un préchargement avec Claude),
 * injecte l'escalade D01, et chronomètre : feedback traité, alerte de risque, reclassement, première question.
 * Usage : npm run latence -w @po-agent/api [-- --repetitions 3]
 */

const INSTANTANE = path.join(RACINE, "donnees", "instantanes", "etat-demo.json");
const i = process.argv.indexOf("--repetitions");
const repetitions = i > 0 ? Number(process.argv[i + 1]) : 1;
const escalade = (await feedbacksDirects()).find((d) => d.id === "D01");
if (!escalade) throw new Error("Feedback D01 introuvable dans donnees/seed/direct.json");

const mesures: Array<Record<string, number | null>> = [];
for (let k = 1; k <= repetitions; k++) {
  const db = await ouvrirPGlite();
  await migrer(db);
  const jalons: Record<string, number | null> = { traite: null, alerteRisque: null, reclassement: null, question: null };
  let depart = 0;
  const diffuser = (e: Evenement) => {
    if (!depart) return;
    const ecoule = Math.round(performance.now() - depart);
    const d = (e.donnees ?? {}) as Record<string, unknown>;
    if (e.type === "feedback" && d.id === "D01" && d.statut === "traite") jalons.traite ??= ecoule;
    if (e.type === "alerte" && d.type === "risque_depart") jalons.alerteRisque ??= ecoule;
    if (e.type === "classement") jalons.reclassement ??= ecoule;
    if (e.type === "question") jalons.question ??= ecoule;
  };
  const ctx: Contexte = { db, llm: choisirFournisseur(db), file: fileTachesPostgres(db, 0), maintenant: () => new Date("2026-11-09T09:05:00Z"), diffuser };
  if (existsSync(INSTANTANE)) {
    await importerInstantane(db, JSON.parse(await readFile(INSTANTANE, "utf8")) as Instantane);
  } else {
    console.log("Aucun instantané : préchargement complet (avec Claude, environ 500 appels).");
    await chargerSeed(ctx);
    await viderFile(ctx);
  }
  depart = performance.now();
  await ingerer(ctx, { ...escalade, canal: "direct", recuLe: ctx.maintenant().toISOString() });
  await viderFile(ctx);
  const total = Math.round(performance.now() - depart);
  mesures.push({ ...jalons, total });
  console.log(`Exécution ${k}/${repetitions} · ${ctx.llm.nom} · ${JSON.stringify({ ...jalons, total })} (ms)`);
  await db.close();
}

const objectif = 30_000;
const pire = Math.max(...mesures.map((m) => Number(m.reclassement ?? m.total)));
console.log(`\nReclassement visible au pire en ${(pire / 1000).toFixed(1)} s (objectif : ${objectif / 1000} s) : ${pire <= objectif ? "tenu" : "DÉPASSÉ"}.`);
