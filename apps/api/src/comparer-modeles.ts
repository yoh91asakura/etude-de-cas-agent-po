import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { migrer, ouvrirPGlite } from "@po-agent/db";
import type { Contexte } from "@po-agent/agent";
import { chargerEnvLocal, choisirFournisseur, cleOpenRouter, modeleOpenRouter, RACINE } from "./config.ts";
import { casNonValides, chargerDonnees } from "./evals/donnees.ts";
import { ETAPES, type BilanEtape } from "./evals/etapes.ts";
import { construireEtatDeTest } from "./evals/etat-de-test.ts";

// Commande locale : lit .env sans écraser l'environnement (voir chargerEnvLocal).
chargerEnvLocal();

/**
 * Comparatif des modèles et des niveaux d'effort, étape par étape.
 * Pour chaque étape du banc des prompts et chaque couple (modèle, effort), le banc de l'étape est rejoué avec ce réglage
 * sur les seuls appels de l'étape (LLM_ETAPES). Le rapport donne, par étape : la réussite des vérifications, la sécurité,
 * le coût (jetons tracés × tarif public d'OpenRouter), la latence, et les réglages qui ne sont battus par aucun autre
 * à la fois en qualité et en coût. Il propose une ligne LLM_ETAPES ; le choix final revient à l'humain.
 *
 * Usage : npm run evals:modeles -w @po-agent/api -- [--etapes impact,complexite] [--modeles haiku,sonnet,opus]
 *         [--efforts low,medium,high] [--repetitions 1] [--paralleles 3] [--budget 10] [--estimer]
 * --budget : plafond en dollars ; plus aucun réglage n'est lancé une fois atteint (les réglages en cours finissent).
 * --estimer : n'appelle aucun modèle ; estime le coût de la matrice à partir des jetons du dernier comparatif (Haiku).
 */

/** Les appels au modèle que chaque étape du banc exerce : seuls ceux-là reçoivent le réglage comparé. */
const APPELS_PAR_ETAPE: Record<string, string[]> = {
  paraphrases: ["extraction", "rattachement"],
  conversation: ["conversation"],
  regles: ["formuler_regle"],
  revue: ["revue"],
  impact: ["impact"],
  complexite: ["complexite"],
  stories: ["story"],
  juge: ["juge_story"],
};

const MODELES: Record<string, string> = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5", fable: "claude-fable-5-2" };

const arg = (nom: string) => {
  const i = process.argv.indexOf(`--${nom}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const liste = (nom: string, defaut: string) => (arg(nom) ?? defaut).split(",").map((x) => x.trim()).filter(Boolean);
const etapes = liste("etapes", Object.keys(APPELS_PAR_ETAPE).filter((e) => e in ETAPES).join(","));
const modeles = liste("modeles", "haiku,sonnet,opus");
const efforts = liste("efforts", "low,medium,high");
const repetitions = Number(arg("repetitions") ?? 1);
const paralleles = Number(arg("paralleles") ?? 3);
const budget = Number(arg("budget") ?? Infinity);
const estimer = process.argv.includes("--estimer");

const inconnues = [...etapes.filter((e) => !(e in ETAPES) || !(e in APPELS_PAR_ETAPE)), ...modeles.filter((m) => !(m in MODELES))];
if (inconnues.length > 0 || !Number.isInteger(repetitions) || repetitions < 1) {
  console.error(`Inconnu : ${inconnues.join(", ") || "répétitions"}. Étapes : ${Object.keys(APPELS_PAR_ETAPE).join(", ")}. Modèles : ${Object.keys(MODELES).join(", ")}.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Tarifs : l'API publique d'OpenRouter (sans clé, sans coût).
// ---------------------------------------------------------------------------

type Tarif = { entree: number; sortie: number };

async function lireTarifs(): Promise<Map<string, Tarif>> {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/models");
    const j = (await r.json()) as { data: Array<{ id: string; pricing: { prompt: string; completion: string } }> };
    return new Map(j.data.map((m) => [m.id, { entree: Number(m.pricing.prompt), sortie: Number(m.pricing.completion) }]));
  } catch {
    return new Map();
  }
}

const tarifs = await lireTarifs();
const tarifDe = (modele: string): Tarif | null => tarifs.get(modeleOpenRouter(modele)) ?? null;
const cout = (modele: string, entree: number, sortie: number): number | null => {
  const t = tarifDe(modele);
  return t ? entree * t.entree + sortie * t.sortie : null;
};

// ---------------------------------------------------------------------------
// Mesure d'un réglage
// ---------------------------------------------------------------------------

interface Mesure {
  etape: string;
  modele: string;
  effort: string;
  repetitions: number;
  succes: number;
  total: number;
  securiteKo: number;
  pannes: string[];
  requetes: number;
  echecsRequetes: number;
  tokensEntree: number;
  tokensSortie: number;
  dureeMoyenneMs: number;
  dureeMaxMs: number;
  coutDollars: number | null;
  mesures: Array<Record<string, string | number>>;
  echecs: string[];
  /** Sorties brutes du modèle à la dernière répétition, pour lire pourquoi un réglage réussit ou échoue. */
  sorties: unknown[];
  /** Messages des requêtes en échec (limite de débit, surcharge, schéma…), dédoublonnés. */
  erreursRequetes: string[];
}

const donnees = await chargerDonnees();
let etat: Promise<Contexte> | undefined;
const etatDeTest = () => (etat ??= construireEtatDeTest(donnees));

async function mesurer(etape: string, cleModele: string, effort: string): Promise<Mesure> {
  const modele = MODELES[cleModele]!;
  const appels = APPELS_PAR_ETAPE[etape]!;
  // Une base de traces par réglage : le décompte des jetons et des durées ne mélange jamais deux réglages.
  const db = await ouvrirPGlite();
  await migrer(db);
  const f = choisirFournisseur(db, { ...process.env, LLM_MODELE: modele, LLM_ETAPES: appels.map((a) => `${a}=${modele}:${effort}`).join(",") });
  const m: Mesure = { etape, modele, effort, repetitions, succes: 0, total: 0, securiteKo: 0, pannes: [], requetes: 0, echecsRequetes: 0, tokensEntree: 0, tokensSortie: 0, dureeMoyenneMs: 0, dureeMaxMs: 0, coutDollars: null, mesures: [], echecs: [], sorties: [], erreursRequetes: [] };
  for (let k = 0; k < repetitions; k++) {
    let bilan: BilanEtape | undefined;
    try {
      bilan = await ETAPES[etape]!.executer(f, donnees, etatDeTest);
    } catch (e) {
      m.pannes.push(e instanceof Error ? e.message : String(e));
      continue;
    }
    // Les vérifications heuristiques (expressions régulières sur du texte libre) ne comptent pas dans la comparaison.
    for (const r of bilan.resultats.filter((x) => !x.heuristique)) {
      m.total += 1;
      if (r.ok) m.succes += 1;
      else m.echecs.push(r.nom);
      if (r.securite && !r.ok) m.securiteKo += 1;
    }
    m.mesures.push(bilan.mesures);
    m.sorties = bilan.sorties;
  }
  const t = (
    await db.query<{ n: number; ko: number; entree: number | null; sortie: number | null; moy: number | null; max: number | null }>(
      `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE statut <> 'ok')::int AS ko, SUM(tokens_entree)::int AS entree, SUM(tokens_sortie)::int AS sortie,
              AVG(duree_ms)::float AS moy, MAX(duree_ms)::int AS max
       FROM traces_llm WHERE etape = ANY($1)`,
      [appels],
    )
  ).rows[0]!;
  const erreurs = await db.query<{ e: string }>("SELECT DISTINCT LEFT(COALESCE(erreur, statut), 200) AS e FROM traces_llm WHERE etape = ANY($1) AND statut <> 'ok' LIMIT 5", [appels]);
  m.erreursRequetes = erreurs.rows.map((x) => x.e);
  await db.close();
  m.requetes = t.n;
  m.echecsRequetes = t.ko;
  m.tokensEntree = t.entree ?? 0;
  m.tokensSortie = t.sortie ?? 0;
  m.dureeMoyenneMs = Math.round(t.moy ?? 0);
  m.dureeMaxMs = t.max ?? 0;
  m.coutDollars = cout(modele, m.tokensEntree, m.tokensSortie);
  return m;
}

// ---------------------------------------------------------------------------
// Estimation sans appel : jetons du dernier comparatif, au tarif de chaque modèle
// ---------------------------------------------------------------------------

async function dernierComparatif(): Promise<Mesure[] | null> {
  const dossier = path.join(RACINE, "evals", "resultats");
  const fichiers = (await readdir(dossier).catch(() => [] as string[])).filter((f) => f.endsWith("-modeles.json")).sort();
  const dernier = fichiers.at(-1);
  if (!dernier) return null;
  return (JSON.parse(await readFile(path.join(dossier, dernier), "utf8")) as { mesures: Mesure[] }).mesures;
}

if (estimer) {
  const reference = await dernierComparatif();
  if (!reference) {
    console.error("Aucun comparatif précédent : lancez d'abord un calibrage, par exemple --modeles haiku.");
    process.exit(1);
  }
  let total = 0;
  const lignes: string[] = [];
  for (const etape of etapes) {
    for (const effort of efforts) {
      // Jetons d'un passage, mesurés sur le réglage de référence le plus proche (même étape, même effort, sinon même étape).
      const ref = reference.find((x) => x.etape === etape && x.effort === effort) ?? reference.find((x) => x.etape === etape);
      if (!ref) continue;
      const entree = ref.tokensEntree / ref.repetitions;
      const sortie = ref.tokensSortie / ref.repetitions;
      for (const cle of modeles) {
        const c = (cout(MODELES[cle]!, entree, sortie) ?? 0) * repetitions;
        total += c;
        lignes.push(`${etape.padEnd(12)} ${cle.padEnd(7)} ${effort.padEnd(7)} ≈ ${c.toFixed(3)} $`);
      }
    }
  }
  console.log(lignes.join("\n"));
  console.log(`\nEstimation totale : ≈ ${total.toFixed(2)} $ (${repetitions} répétition(s)). Les jetons de sortie varient selon le modèle : c'est un ordre de grandeur.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Exécution de la matrice, avec plafond de budget
// ---------------------------------------------------------------------------

const factice = choisirFournisseur(await ouvrirPGlite(), process.env).nom.startsWith("faux");
if (!factice && !cleOpenRouter()) console.log("Attention : sans clé OpenRouter, le coût n'est pas calculé (tarifs OpenRouter).");

const travaux = etapes.flatMap((etape) => modeles.flatMap((modele) => efforts.map((effort) => ({ etape, modele, effort }))));
const mesures: Mesure[] = [];
const nonLances: string[] = [];
let depense = 0;
let suivant = 0;

async function ouvrier(): Promise<void> {
  while (suivant < travaux.length) {
    const t = travaux[suivant++]!;
    if (depense >= budget) {
      nonLances.push(`${t.etape} · ${t.modele} · ${t.effort}`);
      continue;
    }
    const debut = Date.now();
    const m = await mesurer(t.etape, t.modele, t.effort);
    depense += m.coutDollars ?? 0;
    mesures.push(m);
    console.log(
      `${t.etape} · ${t.modele} · ${t.effort} : ${m.succes}/${m.total}${m.pannes.length ? ` · ${m.pannes.length} panne(s)` : ""} · ${m.requetes} requêtes · ${m.coutDollars !== null ? `${m.coutDollars.toFixed(3)} $` : "coût ?"} · ${Math.round((Date.now() - debut) / 1000)} s · cumul ${depense.toFixed(2)} $`,
    );
  }
}

console.log(`Comparatif : ${travaux.length} réglages (${etapes.length} étapes × ${modeles.length} modèles × ${efforts.length} efforts), ${repetitions} répétition(s), ${paralleles} en parallèle${Number.isFinite(budget) ? `, budget ${budget} $` : ""}.`);
await Promise.all(Array.from({ length: Math.max(1, paralleles) }, () => ouvrier()));

// ---------------------------------------------------------------------------
// Rapport
// ---------------------------------------------------------------------------

const taux = (m: Mesure) => (m.total > 0 ? m.succes / m.total : 0);
/**
 * Un réglage est retenu s'il n'est battu par aucun autre à la fois en qualité (≥) et en coût (≤), avec au moins un strict.
 * Un réglage qui ne réussit aucune vérification n'est jamais retenu, même s'il est le moins cher.
 */
const nonDomine = (m: Mesure, groupe: Mesure[]) =>
  m.succes > 0 &&
  m.securiteKo === 0 &&
  m.pannes.length === 0 &&
  !groupe.some((o) => o !== m && o.securiteKo === 0 && o.pannes.length === 0 && taux(o) >= taux(m) && (o.coutDollars ?? Infinity) <= (m.coutDollars ?? Infinity) && (taux(o) > taux(m) || (o.coutDollars ?? Infinity) < (m.coutDollars ?? Infinity)));

const recommandations: Record<string, { meilleur: Mesure; economique: Mesure } | null> = {};
const md: string[] = [
  `# Comparatif des modèles et des niveaux d'effort, du ${new Date().toLocaleString("fr-FR")}`,
  "",
  `${travaux.length} réglages, ${repetitions} répétition(s). Dépense mesurée : ${depense.toFixed(2)} $ (jetons tracés × tarif public d'OpenRouter).`,
];
if (factice) md.push("", "> **Factice** : le faux fournisseur ne dépend ni du modèle ni de l'effort. Ce rapport vérifie la plomberie du comparatif.");
const nonValides = casNonValides(donnees);
if (nonValides.length > 0) md.push("", `> **Cas non validés par l'humain** : ${nonValides.join(", ")}. Les taux de réussite sont des signaux, pas des preuves : peu de cas par étape, intervalles larges.`);
if (nonLances.length > 0) md.push("", `> **Budget atteint** : ${nonLances.length} réglage(s) non lancé(s) : ${nonLances.join(" ; ")}.`);

for (const etape of etapes) {
  const groupe = mesures.filter((m) => m.etape === etape).sort((a, b) => taux(b) - taux(a) || (a.coutDollars ?? 0) - (b.coutDollars ?? 0));
  if (groupe.length === 0) continue;
  md.push("", `## ${ETAPES[etape]!.titre} (appels : ${APPELS_PAR_ETAPE[etape]!.join(", ")})`, "");
  md.push("| Modèle | Effort | Réussite | Sécurité | Coût par passage | Latence moyenne / max par requête | Requêtes | Jetons de sortie par requête | Retenu |", "|---|---|---|---|---|---|---|---|---|");
  for (const m of groupe) {
    const parPassage = m.coutDollars !== null ? `${(m.coutDollars / m.repetitions).toFixed(4)} $` : "?";
    const sortieParRequete = m.requetes > 0 ? Math.round(m.tokensSortie / m.requetes) : 0;
    md.push(
      `| ${m.modele} | ${m.effort} | ${m.succes}/${m.total} (${Math.round(taux(m) * 100)} %)${m.pannes.length ? ` · ${m.pannes.length} panne(s)` : ""} | ${m.securiteKo === 0 ? "ok" : `**${m.securiteKo} échec(s)**`} | ${parPassage} | ${(m.dureeMoyenneMs / 1000).toFixed(1)} s / ${(m.dureeMaxMs / 1000).toFixed(1)} s | ${m.requetes}${m.echecsRequetes ? ` (${m.echecsRequetes} en échec)` : ""} | ${sortieParRequete} | ${nonDomine(m, groupe) ? "oui" : ""} |`,
    );
  }
  const sures = groupe.filter((m) => m.securiteKo === 0 && m.pannes.length === 0);
  if (sures.length > 0) {
    const meilleur = sures[0]!;
    // Le réglage économique : le moins cher parmi ceux qui ne ratent pas plus d'une vérification de plus que le meilleur, par passage.
    const seuil = meilleur.succes / meilleur.repetitions - 1;
    const economique = [...sures].filter((m) => m.succes / m.repetitions >= seuil).sort((a, b) => (a.coutDollars ?? Infinity) - (b.coutDollars ?? Infinity))[0]!;
    recommandations[etape] = { meilleur, economique };
    md.push(
      "",
      `Meilleure qualité : **${meilleur.modele}, ${meilleur.effort}**. Meilleur rapport qualité/coût (au plus une vérification ratée de plus par passage) : **${economique.modele}, ${economique.effort}**.`,
    );
  }
  const echecs = new Map<string, number>();
  for (const m of groupe) for (const e of m.echecs) echecs.set(e, (echecs.get(e) ?? 0) + 1);
  if (echecs.size > 0) {
    md.push("", "Vérifications le plus souvent ratées, tous réglages confondus : " + [...echecs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n} (${c})`).join(" ; ") + ".");
  }
  for (const m of groupe.filter((x) => x.erreursRequetes.length > 0)) {
    md.push("", `Requêtes en échec (${m.modele}, ${m.effort}) : ${m.erreursRequetes.map((e) => `\`${e.replace(/\s+/g, " ")}\``).join(" ; ")}.`);
  }
}

const ligneEtapes = Object.entries(recommandations)
  .filter((e): e is [string, { meilleur: Mesure; economique: Mesure }] => e[1] !== null)
  .flatMap(([etape, r]) => APPELS_PAR_ETAPE[etape]!.map((a) => `${a}=${r.economique.modele}:${r.economique.effort}`))
  .join(",");
if (ligneEtapes) md.push("", "## Réglage proposé (meilleur rapport qualité/coût par étape)", "", "À relire et décider par l'humain avant de l'appliquer :", "", "```", `LLM_ETAPES=${ligneEtapes}`, "```");

const horodatage = new Date().toISOString().replace(/[:.]/g, "-");
const dossier = path.join(RACINE, "evals", "resultats");
await mkdir(dossier, { recursive: true });
// Les rapports factices finissent par « -faux » : ils ne sont pas versionnés (.gitignore).
const fichier = path.join(dossier, `${horodatage}-modeles${factice ? "-faux" : ""}`);
await writeFile(`${fichier}.md`, md.join("\n") + "\n");
await writeFile(`${fichier}.json`, JSON.stringify({ factice, repetitions, depense, tarifs: Object.fromEntries(modeles.map((c) => [c, tarifDe(MODELES[c]!)])), mesures, nonLances, ligneEtapes }, null, 2));
console.log("\n" + md.join("\n"));
console.log(`\nRapport : ${path.relative(RACINE, fichier)}.md`);
process.exitCode = mesures.some((m) => m.pannes.length > 0) ? 1 : 0;
