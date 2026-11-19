import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { migrer, ouvrirPGlite } from "@po-agent/db";
import type { FournisseurLLM } from "@po-agent/llm";
import type { Contexte } from "@po-agent/agent";
import { choisirFournisseur, depenseApres, depenseOpenRouter, RACINE, chargerEnvLocal } from "./config.ts";
import { casNonValides, chargerDonnees } from "./evals/donnees.ts";
import { ETAPES, type BilanEtape } from "./evals/etapes.ts";
import { construireEtatDeTest } from "./evals/etat-de-test.ts";
import { wilson, type Resultat } from "./evals/verifications.ts";

// Commande locale : lit .env sans écraser l'environnement (voir chargerEnvLocal).
chargerEnvLocal();

/**
 * Banc des prompts : chaque appel au modèle évalué seul, sur des cas contrôlés, et jugé par du code.
 * Il complète le banc de bout en bout (evaluer.ts), qui mesure la chaîne entière contre la vérité terrain.
 *
 * Usage : npm run evals:prompts -w @po-agent/api -- [--etapes paraphrases,conversation] [--repetitions 3]
 * Étapes : paraphrases, conversation, regles, revue, impact, complexite, stories, juge (toutes par défaut).
 * Avec le faux fournisseur, le rapport est marqué factice : il vérifie la plomberie du banc, pas les prompts.
 * Pour chaque étape, le rapport donne les appels de l'interface (une conversation compte pour un appel) et les
 * requêtes réellement envoyées au modèle, lues dans les traces avec leurs jetons : c'est la base du coût.
 */

const arg = (nom: string) => {
  const i = process.argv.indexOf(`--${nom}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const repetitions = Number(arg("repetitions") ?? 1);
const choisies = (arg("etapes") ?? Object.keys(ETAPES).join(",")).split(",").map((x) => x.trim());
const inconnues = choisies.filter((e) => !(e in ETAPES));
if (inconnues.length > 0 || !Number.isInteger(repetitions) || repetitions < 1) {
  console.error(`Étapes possibles : ${Object.keys(ETAPES).join(", ")}. Répétitions : un entier positif.`);
  process.exit(1);
}

/** Compte les appels au modèle, méthode par méthode, sans changer le fournisseur. */
function compter(f: FournisseurLLM): { fournisseur: FournisseurLLM; appels: Record<string, number> } {
  const appels: Record<string, number> = {};
  const fournisseur = new Proxy(f, {
    get(cible, prop, recepteur) {
      const v = Reflect.get(cible, prop, recepteur) as unknown;
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        appels[String(prop)] = (appels[String(prop)] ?? 0) + 1;
        return (v as (...a: unknown[]) => unknown).apply(cible, args);
      };
    },
  });
  return { fournisseur, appels };
}

const donnees = await chargerDonnees();
const nonValides = casNonValides(donnees);
const dbTraces = await ouvrirPGlite();
await migrer(dbTraces);
const base = choisirFournisseur(dbTraces);
const factice = base.nom.startsWith("faux");
const depenseAvant = factice ? null : await depenseOpenRouter();

// L'état de test de la conversation n'est construit qu'une fois, et seulement si l'étape est demandée.
let etat: Promise<Contexte> | undefined;
const etatDeTest = () => (etat ??= construireEtatDeTest(donnees));

type Requetes = { requetes: number; echecs: number; tokensEntree: number; tokensSortie: number };
type Execution = { etape: string; bilan?: BilanEtape; panne?: string; appels: Record<string, number>; requetes: Requetes };

/** Requêtes tracées depuis la trace `depuis` (le fournisseur réel écrit une trace par requête, conversation comprise). */
async function lireTraces(depuis: number): Promise<{ dernier: number; requetes: Requetes }> {
  const r = await dbTraces.query<{ dernier: number | null; n: number; echecs: number; entree: number | null; sortie: number | null }>(
    "SELECT MAX(id)::int AS dernier, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE statut <> 'ok')::int AS echecs, SUM(tokens_entree)::int AS entree, SUM(tokens_sortie)::int AS sortie FROM traces_llm WHERE id > $1",
    [depuis],
  );
  const x = r.rows[0]!;
  return { dernier: x.dernier ?? depuis, requetes: { requetes: x.n, echecs: x.echecs, tokensEntree: x.entree ?? 0, tokensSortie: x.sortie ?? 0 } };
}
const executions: Execution[][] = [];
let derniereTrace = 0;
for (let k = 1; k <= repetitions; k++) {
  const tour: Execution[] = [];
  for (const nom of choisies) {
    const { titre, executer } = ETAPES[nom]!;
    console.log(`Répétition ${k}/${repetitions} · ${titre} · ${base.nom}`);
    const { fournisseur, appels } = compter(base);
    let bilan: BilanEtape | undefined;
    let panne: string | undefined;
    try {
      bilan = await executer(fournisseur, donnees, etatDeTest);
    } catch (e) {
      panne = e instanceof Error ? (e.stack ?? e.message) : String(e);
    }
    const traces = await lireTraces(derniereTrace);
    derniereTrace = traces.dernier;
    tour.push({ etape: nom, ...(bilan ? { bilan } : {}), ...(panne ? { panne } : {}), appels, requetes: traces.requetes });
  }
  executions.push(tour);
}

// Agrégation par vérification, sur toutes les répétitions.
const lignes = new Map<string, { etape: string; r: Resultat; succes: number; total: number; details: string[] }>();
for (const tour of executions) {
  for (const x of tour) {
    for (const r of x.bilan?.resultats ?? []) {
      const cle = `${x.etape}::${r.nom}`;
      const l = lignes.get(cle) ?? { etape: x.etape, r, succes: 0, total: 0, details: [] };
      l.succes += r.ok ? 1 : 0;
      l.total += 1;
      l.details.push(r.detail);
      lignes.set(cle, l);
    }
  }
}
const appelsParEtape = Object.fromEntries(
  choisies.map((nom) => {
    const parMethode: Record<string, number> = {};
    for (const tour of executions) for (const x of tour.filter((t) => t.etape === nom)) for (const [m, n] of Object.entries(x.appels)) parMethode[m] = (parMethode[m] ?? 0) + n;
    return [nom, parMethode];
  }),
);
const totalAppels = Object.values(appelsParEtape).reduce((a, m) => a + Object.values(m).reduce((s, n) => s + n, 0), 0);
const somme = (xs: Requetes[]): Requetes =>
  xs.reduce((a, x) => ({ requetes: a.requetes + x.requetes, echecs: a.echecs + x.echecs, tokensEntree: a.tokensEntree + x.tokensEntree, tokensSortie: a.tokensSortie + x.tokensSortie }), { requetes: 0, echecs: 0, tokensEntree: 0, tokensSortie: 0 });
const requetesParEtape = Object.fromEntries(choisies.map((nom) => [nom, somme(executions.flat().filter((x) => x.etape === nom).map((x) => x.requetes))]));
const totalRequetes = somme(Object.values(requetesParEtape));
const decrireRequetes = (q: Requetes) =>
  factice ? "aucune (le faux fournisseur n'envoie rien)" : `${q.requetes} (${q.echecs} en échec), jetons : ${q.tokensEntree} en entrée, ${q.tokensSortie} en sortie`;
const pannes = executions.flat().filter((x) => x.panne);

const cout = await depenseApres(depenseAvant);
const pct = (x: number) => `${(x * 100).toFixed(0)} %`;
const md: string[] = [
  `# Banc des prompts du ${new Date().toLocaleString("fr-FR")}`,
  "",
  `Fournisseur : ${base.nom} · ${repetitions} répétition(s) · ${totalAppels} appel(s) de l'interface du modèle`,
  "",
  `Requêtes envoyées au modèle : ${decrireRequetes(totalRequetes)}`,
  ...(cout !== null ? ["", `Coût lu sur la clé OpenRouter : ${cout.toFixed(4)} $`] : []),
];
if (factice) md.push("", "> **Factice** : le faux fournisseur vérifie la plomberie du banc. Ce rapport ne mesure pas la qualité des prompts et ne compte pas comme évaluation.");
if (nonValides.length > 0) md.push("", `> **Cas non validés par l'humain** : ${nonValides.join(", ")}. Ils sont proposés par l'IA (evals/cas/) : tant qu'ils ne sont pas validés, les résultats ne comptent pas comme preuve.`);
for (const nom of choisies) {
  md.push("", `## ${ETAPES[nom]!.titre}`, "");
  const appels = Object.entries(appelsParEtape[nom] ?? {}).map(([m, n]) => `${m} ${n}`).join(", ");
  md.push(`Appels de l'interface : ${appels || "aucun"}. Requêtes envoyées : ${decrireRequetes(requetesParEtape[nom]!)}.`, "");
  for (const p of pannes.filter((x) => x.etape === nom)) md.push(`**Panne du banc** : ${p.panne?.split("\n")[0]}`, "");
  const siennes = [...lignes.values()].filter((l) => l.etape === nom);
  if (siennes.length > 0) {
    md.push("| Vérification | Type | Réussite | IC 95 % | Détail (dernière répétition) |", "|---|---|---|---|---|");
    for (const l of siennes) {
      const [bas, haut] = wilson(l.succes, l.total);
      const type = l.r.securite ? "sécurité (pass^k)" : l.r.heuristique ? "heuristique, à relire" : "qualité";
      const detail = (l.details.at(-1) ?? "").replaceAll("|", "/").replace(/\s*\n\s*/g, " ");
      md.push(`| ${l.r.nom.replaceAll("|", "/")} | ${type} | ${l.succes}/${l.total} | ${pct(bas)}–${pct(haut)} | ${detail} |`);
    }
  }
  const mesures = executions.map((tour) => tour.find((x) => x.etape === nom)?.bilan?.mesures).filter((m): m is Record<string, string | number> => !!m);
  if (mesures.length > 0 && Object.keys(mesures[0]!).length > 0) {
    md.push("", "Mesures (sans critère de réussite), par répétition :");
    for (const cle of Object.keys(mesures[0]!)) md.push(`- ${cle} : ${mesures.map((m) => m[cle]).join(" ; ")}`);
  }
}

const horodatage = new Date().toISOString().replace(/[:.]/g, "-");
const dossier = path.join(RACINE, "evals", "resultats");
await mkdir(dossier, { recursive: true });
const fichier = path.join(dossier, `${horodatage}-prompts-${factice ? "faux" : "claude"}`);
await writeFile(`${fichier}.md`, md.join("\n") + "\n");
await writeFile(
  `${fichier}.json`,
  JSON.stringify({ fournisseur: base.nom, factice, repetitions, casNonValides: nonValides, appels: appelsParEtape, requetes: requetesParEtape, coutDollars: cout, lignes: [...lignes.values()], executions }, null, 2),
);
console.log("\n" + md.join("\n"));
console.log(`\nRapport : ${path.relative(RACINE, fichier)}.md (sorties brutes du modèle dans le .json)`);

// Une panne du banc échoue toujours. Avec un vrai modèle, une vérification de sécurité qui manque une fois échoue aussi.
const securiteKo = [...lignes.values()].filter((l) => l.r.securite && l.succes < l.total);
process.exitCode = pannes.length > 0 || (!factice && securiteKo.length > 0) ? 1 : 0;
