/** Mise en forme et libellés français de l'interface. */
import type { FeedbackApi, Plan } from "./api.ts";

const fmtCache = new Map<string, Intl.NumberFormat>();
function fmt(min: number, max: number): Intl.NumberFormat {
  const cle = `${min}-${max}`;
  let f = fmtCache.get(cle);
  if (!f) {
    f = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: min, maximumFractionDigits: max });
    fmtCache.set(cle, f);
  }
  return f;
}

export function nombre(v: number | null | undefined, decimales = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return fmt(0, decimales).format(v);
}

export function score(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return fmt(1, 1).format(v);
}

export function euros(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${fmt(0, 0).format(v)} €`;
}

export function mrr(v: number | null | undefined): string {
  return `${euros(v)}/mois`;
}

/** Taux exprimé comme un ratio (0 à 1). Tolère une valeur déjà en pourcentage. */
export function pourcent(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const ratio = v > 1 ? v / 100 : v;
  return `${fmt(0, 0).format(ratio * 100)} %`;
}

export function reach(v: number, unite: "comptes" | "kEUR"): string {
  if (unite === "kEUR") return `${nombre(v, 1)} k€`;
  return `${nombre(v, 0)} compte${v > 1 ? "s" : ""}`;
}

export function uniteReach(unite: "comptes" | "kEUR"): string {
  return unite === "kEUR" ? "k€ de MRR exposé" : "comptes distincts";
}

export function effort(v: number): string {
  return `${nombre(v, 2)} personne${v > 1 ? "s" : ""}-mois`;
}

/** Taille d'après l'effort en personnes-mois (S 0,5 ; M 1 ; L 2 ; XL 4 : packages/domain/src/parametres.ts). */
const TAILLE_PAR_EFFORT: Record<string, string> = { "0.5": "S", "1": "M", "2": "L", "4": "XL" };

/**
 * L'effort dans une seule unité partout (audit du 15/11/2026) : la taille, que le PO et la story emploient,
 * puis les personnes-mois du calcul. « M · 1 p.-m. ».
 */
export function tailleEffort(v: number, complexite?: string): string {
  const taille = complexite ?? TAILLE_PAR_EFFORT[String(v)];
  return `${taille ? `${taille} · ` : ""}${nombre(v, 2)} p.-m.`;
}

/**
 * Les décimales d'un texte de l'API (« divergent (0.25, 0.5, 1) », « Score 11.6 → 23.2 ») écrites à la française :
 * « (0,25 ; 0,5 ; 1) », « Score 11,6 → 23,2 ». Aucune valeur n'est arrondie.
 * À réserver aux énoncés et aux explications de score : un nom de modèle (« Haiku 5.5 ») ne doit pas y passer.
 */
export function decimalesFr(texte: string): string {
  // Une liste de nombres séparés par des virgules prend des points-virgules, sinon « 0,25, 0,5 » devient illisible.
  const listes = texte.replace(/\d+(?:\.\d+)?(?:, \d+(?:\.\d+)?)+/g, (m) => (m.includes(".") ? m.split(", ").join(" ; ") : m));
  return listes.replace(/(\d)\.(\d)/g, (_m, avant: string, apres: string) => `${avant},${apres}`);
}

/** Explication d'un mouvement de score : décimales à la française, Confidence en pourcentage comme dans la ligne du backlog. */
export function explicationFr(texte: string): string {
  const confiance = texte.replace(/Confidence (\d+(?:\.\d+)?) → (\d+(?:\.\d+)?)/g, (_m, a: string, b: string) => `Confidence ${pourcent(Number(a))} → ${pourcent(Number(b))}`);
  return decimalesFr(confiance);
}

export function duree(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "—";
  if (minutes < 1) return `${fmt(0, 0).format(minutes * 60)} s`;
  if (minutes < 60) return `${fmt(0, 0).format(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
}

const fmtDate = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtJour = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });

export function dateCourte(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : fmtDate.format(d);
}

export function jour(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : fmtJour.format(d);
}

/** Nom court d'une vue du backlog : « MRR + objectif », « sans filtre »… */
export function libelleFiltres(filtres: readonly string[]): string {
  if (filtres.length === 0) return "sans filtre";
  return [filtres.includes("mrr") ? "MRR" : null, filtres.includes("objectif") ? "objectif du trimestre" : null].filter(Boolean).join(" + ");
}

/** Deux vues identiques, quel que soit l'ordre des filtres. */
export function memeVue(a: readonly string[], b: readonly string[]): boolean {
  return [...a].sort().join(",") === [...b].sort().join(",");
}

export const LIBELLE_PLAN: Record<Plan, string> = { free: "Free", pro: "Pro", business: "Business" };
export const PLANS: Plan[] = ["free", "pro", "business"];

export const LIBELLE_CANAL: Record<string, string> = {
  email: "E-mail",
  ticket: "Ticket",
  commentaire: "Commentaire",
  direct: "Direct",
};

export const LIBELLE_STATUT_FEEDBACK: Record<FeedbackApi["statut"], string> = {
  recu: "reçu",
  extrait: "analysé",
  suspect: "en quarantaine",
  en_attente: "en attente",
  traite: "traité",
};

export const LIBELLE_NATURE: Record<string, string> = {
  demande: "demande",
  bug: "bug",
  compliment: "compliment",
  question: "question",
  bruit: "bruit",
  suspect: "suspect",
};

/** Ancres de l'échelle RICE de l'Impact (grille du domaine). */
export const ECHELLE_IMPACT = [0.25, 0.5, 1, 2, 3] as const;
export const ANCRE_IMPACT: Record<string, string> = {
  "0.25": "minime",
  "0.5": "faible",
  "1": "moyen",
  "2": "fort",
  "3": "massif",
};

export function libelleImpact(v: number): string {
  const ancre = ANCRE_IMPACT[String(v)];
  return ancre ? `${nombre(v, 2)} (${ancre})` : nombre(v, 2);
}

export const LIBELLE_CONTROLE: Record<string, string> = {
  gabarit_complet: "Gabarit « En tant que… je veux… afin de… » complet",
  // Contrôle purement textuel (pas de « ainsi que », au plus un « et ») : le juge, lui, se prononce sur le fond.
  un_seul_besoin: "« Je veux » sans besoins enchaînés (contrôle textuel)",
  criteres_given_when_then: "Critères au format Given / When / Then",
  au_moins_deux_criteres: "Au moins deux critères d'acceptation",
  citations_presentes: "La story cite ses verbatims",
  citations_verifiees: "Citations vérifiées mot pour mot",
};

export const LIBELLE_JUGEMENT: Record<string, string> = {
  independante: "Indépendante",
  valeur: "Apporte de la valeur",
  estimable: "Estimable",
  petite: "Assez petite",
  testable: "Testable",
  un_seul_besoin: "Un seul besoin",
};

export const LIBELLE_STATUT_REGLE: Record<string, string> = {
  proposee: "proposée",
  active: "active",
  rejetee: "rejetée",
  retiree: "retirée",
};

export const LIBELLE_ACTEUR: Record<string, string> = { agent: "Agent", po: "PO", systeme: "Système" };

/** Transforme un code technique (« trancher_rattachement », « feedbacksRelances ») en libellé lisible. */
export function humaniser(code: string): string {
  const s = code
    .replace(/([a-zà-ÿ])([A-Z])/g, (_m, a: string, b: string) => `${a} ${b.toLowerCase()}`)
    .replace(/[_-]+/g, " ")
    .trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const LIBELLE_CLE: Record<string, string> = {
  itemId: "élément",
  feedbackId: "message",
  compteId: "compte",
  storyId: "story",
  regleId: "règle",
  sourceReponseId: "votre réponse",
  reponseId: "réponse",
  reponsesSources: "réponses à l'origine",
  questionId: "question",
  citation: "citation",
  resume: "résumé",
  nature: "nature",
  regression: "régression",
  tirages: "tirages",
  avant: "avant",
  apres: "après",
  texte: "texte",
  version: "version",
  controlesKo: "contrôles en échec",
  regles: "règles proposées",
  fusions: "fusions proposées",
  expirees: "questions expirées",
  relancees: "questions relancées",
  feedbacksRelances: "messages relancés",
  feedbacks: "messages",
  remplace: "remplace",
  mouvements: "mouvements",
  vue: "vue",
  vueReference: "vue de l'agent",
  filtres: "vue",
  deplaces: "éléments déplacés",
  explication: "explication",
  retenu: "Impact retenu",
  mediane: "médiane",
  recent: "demandes récentes",
  precedent: "période précédente",
  tendance: "tendance",
  type: "type",
  urgente: "urgente",
  par: "rattaché par",
  raison: "raison",
  titre: "titre",
  choix: "choix",
  canal: "canal",
  outils: "outils utilisés",
  question: "question",
  dans: "fusionné dans",
  vers: "vers",
  charge: "objet",
  citationsNonVerifiees: "citations non vérifiées",
};

/** Outils de l'agent conversationnel, tels que le PO les comprend. */
export const LIBELLE_OUTIL: Record<string, string> = {
  classement: "classement",
  detail_item: "détail d'un élément",
  simuler: "simulation",
  chercher_feedbacks: "recherche de feedbacks",
  doctrine: "doctrine",
};

/** Valeurs codées du journal (« fonctionnalite », « llm », « ordre_backlog »…) en clair. */
export const LIBELLE_VALEUR: Record<string, string> = {
  fonctionnalite: "fonctionnalité",
  bug: "bug",
  llm: "lecture du modèle",
  regle: "règle de doctrine",
  agent_de_fond: "agent de fond",
  application: "cockpit",
  telegram: "Telegram",
  impact: "Impact",
  rattachement: "rattachement",
  fusion: "fusion",
  requalification: "requalification",
  ordre_backlog: "ordre du backlog",
  nouvel_item: "nouvel élément",
  story_prete: "story à valider",
  export_jira: "export Jira",
  suggestion: "suggestion d'un assistant",
  ignorer: "ne pas en tenir compte",
};

export function libelleCle(cle: string): string {
  return LIBELLE_CLE[cle] ?? humaniser(cle).toLowerCase();
}

/** Valeur courte et lisible pour un champ de détails libre. */
export function valeurCourte(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "oui" : "non";
  if (typeof v === "number") return nombre(v, 2);
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.length === 0 ? "aucun" : v.map(valeurCourte).join(", ");
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function mediane(valeurs: number[]): number | null {
  if (valeurs.length === 0) return null;
  const tri = [...valeurs].sort((a, b) => a - b);
  return tri[Math.floor((tri.length - 1) / 2)] ?? null;
}
