import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileTachesPostgres, migrer, ouvrirPGlite, ouvrirPostgres, tracer, type Db } from "@po-agent/db";
import { FournisseurClaude, FournisseurFaux, type Effort, type FournisseurLLM } from "@po-agent/llm";
import type { Contexte, Evenement } from "@po-agent/agent";
import { outilJiraDepuisEnv } from "./jira.ts";

export const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DOSSIER_SEED = path.join(RACINE, "donnees", "seed");

export interface Config {
  port: number;
  /** Postgres réel (Docker Compose, socle). Absent : Postgres embarqué (PGlite) dans un dossier local. */
  databaseUrl?: string;
  pgliteDir: string;
  /** tout-en-un : l'API fait aussi tourner le worker (démo locale). api : le worker est un processus à part. */
  mode: "tout-en-un" | "api";
  /** Date fictive du scénario : l'horloge de la démo part de là. */
  dateScenario: Date;
}

export function lireConfig(env = process.env): Config {
  return {
    port: Number(env.PORT ?? 3000),
    ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}),
    pgliteDir: env.PGLITE_DIR ?? path.join(RACINE, "donnees", "etat-local"),
    mode: env.MODE === "api" ? "api" : "tout-en-un",
    dateScenario: new Date(env.DATE_SCENARIO ?? "2026-11-09T09:00:00Z"),
  };
}

/** L'horloge de la démo avance au rythme réel, à partir de la date du scénario. */
export function horloge(dateScenario: Date): () => Date {
  const depart = Date.now();
  return () => new Date(dateScenario.getTime() + (Date.now() - depart));
}

export async function ouvrirBase(config: Config): Promise<Db> {
  const db = config.databaseUrl ? await ouvrirPostgres(config.databaseUrl) : await ouvrirPGlite(config.pgliteDir);
  await migrer(db);
  return db;
}

/**
 * Charge le fichier .env de la racine pour une commande locale (serveur, worker, préchargement, bancs).
 * Une variable déjà définie dans l'environnement n'est jamais écrasée, et une valeur vide est ignorée :
 * `LLM_FOURNISSEUR=faux npm run …` garde la priorité sur le fichier.
 * À n'appeler que depuis un point d'entrée : les tests importent ce module et ne doivent jamais lire une clé.
 * Renvoie le nom des variables chargées, jamais leur valeur.
 */
export function chargerEnvLocal(fichier = path.join(RACINE, ".env"), env: NodeJS.ProcessEnv = process.env): string[] {
  let texte: string;
  try {
    texte = readFileSync(fichier, "utf8");
  } catch {
    return [];
  }
  const charges: string[] = [];
  for (const ligne of texte.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(ligne);
    if (!m) continue;
    const cle = m[1] as string;
    const valeur = (m[2] as string).replace(/^(['"])(.*)\1$/, "$2");
    if (valeur === "" || env[cle] !== undefined) continue;
    env[cle] = valeur;
    charges.push(cle);
  }
  return charges;
}

export const OPENROUTER_URL = "https://openrouter.ai/api";

/** Préfixe documenté des clés OpenRouter : une telle clé ne doit partir que vers OpenRouter. */
export const estCleOpenRouter = (cle: string | undefined): cle is string => !!cle && cle.startsWith("sk-or-");

/** Identifiant OpenRouter d'un modèle Anthropic : claude-haiku-5-5 devient anthropic/claude-haiku-5.5. */
export function modeleOpenRouter(modele: string): string {
  return modele.includes("/") ? modele : `anthropic/${modele.replace(/-(\d+)-(\d+)$/, "-$1.$2")}`;
}

/**
 * Transport qui épingle le fournisseur Anthropic chez OpenRouter. Sans cela, OpenRouter peut servir un modèle Claude
 * depuis Bedrock ou Vertex, où les sorties structurées et l'effort ne sont pas garantis. Seul le corps change, jamais les en-têtes.
 */
export function fetchOpenRouter(transport: typeof fetch = fetch): typeof fetch {
  return ((url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.method === "POST" && typeof init.body === "string") {
      const corps = JSON.parse(init.body) as Record<string, unknown>;
      corps.provider = { order: ["anthropic"], allow_fallbacks: false };
      return transport(url, { ...init, body: JSON.stringify(corps) });
    }
    return transport(url, init);
  }) as typeof fetch;
}

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Modèle et effort par étape : LLM_ETAPES="extraction=claude-haiku-5-5:low,impact=claude-opus-5-5:high,revue=:high".
 * Sert à appliquer le choix fait sur le comparatif des modèles, sans toucher au code. Une entrée mal formée arrête le démarrage.
 */
export function lireEtapes(valeur: string | undefined): { modeles: Record<string, string>; efforts: Record<string, Effort> } {
  const modeles: Record<string, string> = {};
  const efforts: Record<string, Effort> = {};
  for (const entree of (valeur ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [etape, reglage = ""] = entree.split("=").map((x) => x.trim());
    const [modele, effort] = reglage.split(":").map((x) => x.trim());
    if (!etape || (!modele && !effort)) throw new Error(`LLM_ETAPES : entrée mal formée « ${entree} » (attendu : etape=modele:effort)`);
    if (effort && !EFFORTS.includes(effort as Effort)) throw new Error(`LLM_ETAPES : effort inconnu « ${effort} » pour ${etape}`);
    if (modele) modeles[etape] = modele;
    if (effort) efforts[etape] = effort as Effort;
  }
  return { modeles, efforts };
}

/** Clé OpenRouter de l'environnement, s'il y en a une (OPENROUTER_API_KEY, ou une clé au préfixe OpenRouter). */
export function cleOpenRouter(env = process.env): string | undefined {
  return env.OPENROUTER_API_KEY || [env.LLM_API_KEY, env.ANTHROPIC_API_KEY].find(estCleOpenRouter);
}

/**
 * Dépense cumulée de la clé OpenRouter, en dollars (GET /api/v1/key, sans coût). Lue avant et après un banc,
 * elle donne ce que le banc a coûté. OpenRouter la met à jour avec quelques secondes de retard. null hors OpenRouter.
 */
export async function depenseOpenRouter(env = process.env): Promise<number | null> {
  const cle = cleOpenRouter(env);
  if (!cle) return null;
  try {
    const r = await fetch(`${OPENROUTER_URL}/v1/key`, { headers: { Authorization: `Bearer ${cle}` } });
    const j = (await r.json()) as { data?: { usage?: unknown } };
    return typeof j.data?.usage === "number" ? j.data.usage : null;
  } catch {
    return null;
  }
}

/** Relit la dépense jusqu'à ce qu'elle dépasse la valeur de départ (au plus 30 s), pour absorber le retard d'OpenRouter. */
export async function depenseApres(avant: number | null, env = process.env): Promise<number | null> {
  if (avant === null) return null;
  let apres = avant;
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    apres = (await depenseOpenRouter(env)) ?? apres;
    if (apres > avant) break;
  }
  return apres - avant;
}

/**
 * Le modèle passe par la passerelle LLM du socle quand elle est configurée.
 * Pour le développement et les évaluations, une clé OpenRouter (OPENROUTER_API_KEY) fait passer les appels par OpenRouter,
 * épinglés sur le fournisseur Anthropic : c'est un écart au cadrage, consigné dans le journal (session 4), pas l'architecture cible.
 * Sans clé ni passerelle, le faux fournisseur fait tourner la démo, et l'interface l'affiche clairement.
 */
export function choisirFournisseur(db: Db, env = process.env, transport: typeof fetch = fetch): FournisseurLLM {
  // LLM_FOURNISSEUR=faux force le faux fournisseur (tests de plomberie, démo sans clé dans le compose).
  if (env.LLM_FOURNISSEUR === "faux") return new FournisseurFaux();
  const cleOR = cleOpenRouter(env);
  const viaOpenRouter = env.LLM_BASE_URL ? env.LLM_BASE_URL.startsWith(OPENROUTER_URL) : !!cleOR;
  const cle = viaOpenRouter ? cleOR || env.LLM_API_KEY : env.LLM_API_KEY || env.ANTHROPIC_API_KEY;
  if (!viaOpenRouter && estCleOpenRouter(cle)) {
    throw new Error("Une clé OpenRouter ne part que vers OpenRouter : mettez-la dans OPENROUTER_API_KEY et retirez LLM_BASE_URL.");
  }
  if (!cle && !env.LLM_BASE_URL) return new FournisseurFaux();
  const etapes = lireEtapes(env.LLM_ETAPES);
  if (env.LLM_MODELE_EXTRACTION) etapes.modeles.extraction ??= env.LLM_MODELE_EXTRACTION;
  return new FournisseurClaude({
    // Sans LLM_MODELE, chaque étape prend son modèle par défaut (MODELE_PAR_ETAPE) ; LLM_MODELE en impose un à toutes.
    ...(env.LLM_MODELE ? { modele: env.LLM_MODELE } : {}),
    ...(viaOpenRouter
      ? { baseURL: OPENROUTER_URL, fetch: fetchOpenRouter(transport), route: "via OpenRouter, fournisseur anthropic", traduireModele: modeleOpenRouter }
      : env.LLM_BASE_URL
        ? { baseURL: env.LLM_BASE_URL }
        : {}),
    ...(cle ? { apiKey: cle } : {}),
    traceur: (t) => tracer(db, t),
    // Modèle et effort par étape (LLM_ETAPES), et l'ancien réglage de l'extraction (LLM_MODELE_EXTRACTION) : prioritaires.
    ...(Object.keys(etapes.modeles).length > 0 ? { modeleParEtape: etapes.modeles } : {}),
    ...(Object.keys(etapes.efforts).length > 0 ? { effortParEtape: etapes.efforts } : {}),
  });
}

export const CANAL_NOTIFY = "po_agent";

/** Diffusion des événements vers l'interface : en mémoire, et par NOTIFY Postgres quand le worker est un processus séparé. */
export function creerDiffuseur(db: Db, viaPostgres: boolean): { emetteur: EventEmitter; diffuser: (e: Evenement) => void } {
  const emetteur = new EventEmitter();
  emetteur.setMaxListeners(100);
  const diffuser = (e: Evenement) => {
    emetteur.emit("evenement", e);
    if (viaPostgres) void db.query("SELECT pg_notify($1, $2)", [CANAL_NOTIFY, JSON.stringify(e)]).catch(() => {});
  };
  return { emetteur, diffuser };
}

export function creerContexte(db: Db, llm: FournisseurLLM, maintenant: () => Date, diffuser: (e: Evenement) => void): Contexte {
  const suivi = outilJiraDepuisEnv();
  return { db, llm, file: fileTachesPostgres(db), maintenant, diffuser, ...(suivi ? { suivi } : {}) };
}
