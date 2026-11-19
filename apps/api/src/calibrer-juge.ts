import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Story } from "@po-agent/domain";
import type { JugementStory } from "@po-agent/llm";
import { choisirFournisseur, lireConfig, ouvrirBase, RACINE, chargerEnvLocal } from "./config.ts";

// Commande locale : lit .env sans écraser l'environnement (voir chargerEnvLocal).
chargerEnvLocal();

/**
 * Calibration du juge LLM des stories contre des annotations humaines (cadrage : 15 stories annotées à la main).
 * L'annotation appartient à l'humain : ce script ne fait que préparer le fichier et mesurer l'accord.
 *
 * npm run evals:juge -w @po-agent/api -- --preparer   → écrit donnees/stories-a-annoter.json depuis l'état local
 * npm run evals:juge -w @po-agent/api                 → compare le juge aux annotations de donnees/stories-annotees.json
 */

export const CRITERES = ["independante", "valeur", "estimable", "petite", "testable", "un_seul_besoin"] as const;
export type Critere = (typeof CRITERES)[number];

export interface StoryAnnotee {
  story: Story;
  /** Rempli par l'humain : true ou false pour chaque critère. */
  annotation: Record<Critere, boolean | null>;
  annotePar: string | null;
}

/** Accord observé et kappa de Cohen entre deux séries de verdicts binaires. */
export function accord(humain: boolean[], juge: boolean[]): { accord: number; kappa: number | null } {
  const n = humain.length;
  if (n === 0 || n !== juge.length) throw new Error("Séries vides ou de longueurs différentes");
  const egaux = humain.filter((h, i) => h === juge[i]).length;
  const po = egaux / n;
  const pH = humain.filter(Boolean).length / n;
  const pJ = juge.filter(Boolean).length / n;
  const pe = pH * pJ + (1 - pH) * (1 - pJ);
  return { accord: po, kappa: pe === 1 ? null : (po - pe) / (1 - pe) };
}

const FICHIER_ANNOTEES = path.join(RACINE, "donnees", "stories-annotees.json");
const FICHIER_A_ANNOTER = path.join(RACINE, "donnees", "stories-a-annoter.json");

async function preparer(): Promise<void> {
  const db = await ouvrirBase(lireConfig());
  const r = await db.query<{ contenu: Story }>("SELECT contenu FROM stories ORDER BY creee_le");
  const vide = Object.fromEntries(CRITERES.map((c) => [c, null])) as Record<Critere, null>;
  const lot: StoryAnnotee[] = r.rows.map((s) => ({ story: s.contenu, annotation: { ...vide }, annotePar: null }));
  await writeFile(FICHIER_A_ANNOTER, JSON.stringify(lot, null, 2));
  console.log(`${lot.length} stories écrites dans ${path.relative(RACINE, FICHIER_A_ANNOTER)}. À annoter à la main, puis à renommer en stories-annotees.json.`);
  await db.close();
}

async function mesurer(): Promise<void> {
  const lot = JSON.parse(await readFile(FICHIER_ANNOTEES, "utf8")) as StoryAnnotee[];
  const completes = lot.filter((s) => s.annotePar && CRITERES.every((c) => typeof s.annotation[c] === "boolean"));
  if (completes.length < 15) throw new Error(`Il faut au moins 15 stories annotées à la main ; ${completes.length} le sont.`);
  const db = await ouvrirBase(lireConfig());
  const llm = choisirFournisseur(db);
  if (llm.nom.startsWith("faux")) throw new Error("Le juge factice répond toujours oui : la calibration exige Claude.");
  const verdicts: JugementStory[] = [];
  for (const s of completes) verdicts.push(await llm.jugerStory(s.story));
  const lignes = CRITERES.map((c) => {
    const a = accord(
      completes.map((s) => s.annotation[c] as boolean),
      verdicts.map((v) => v[c]),
    );
    return `| ${c} | ${(a.accord * 100).toFixed(0)} % | ${a.kappa === null ? "n/a" : a.kappa.toFixed(2)} |`;
  });
  const md = [`# Calibration du juge de stories (${new Date().toLocaleString("fr-FR")})`, "", `Juge : ${llm.nom} · ${completes.length} stories annotées à la main.`, "", "| Critère | Accord | Kappa de Cohen |", "|---|---|---|", ...lignes].join("\n");
  const dossier = path.join(RACINE, "evals", "resultats");
  await mkdir(dossier, { recursive: true });
  await writeFile(path.join(dossier, `${new Date().toISOString().replace(/[:.]/g, "-")}-juge.md`), md + "\n");
  console.log(md);
  await db.close();
}

if (process.argv[1]?.endsWith("calibrer-juge.ts")) {
  await (process.argv.includes("--preparer") ? preparer() : mesurer());
}
