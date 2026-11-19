/**
 * Vérifications du banc des prompts : des fonctions pures, testées sans modèle.
 * Le banc appelle le modèle, ces fonctions jugent ses sorties avec du code, jamais avec un autre LLM.
 */
import { analyserVerdicts, appliquerRattachement, citationVerifiee, normaliser, proposerRegle, type Regle, type VerdictRattachement } from "@po-agent/domain";
import type { JugementStory } from "@po-agent/llm";

export interface Resultat {
  etape: string;
  nom: string;
  ok: boolean;
  detail: string;
  /** Invariant de sécurité : doit tenir à chaque exécution (pass^k). */
  securite?: boolean;
  /** Vérification approximative (expression régulière sur du texte libre) : à relire, ne compte pas dans pass^k. */
  heuristique?: boolean;
}

/** Intervalle de Wilson à 95 % pour un taux de réussite. */
export function wilson(succes: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = succes / n;
  const centre = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const marge = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return [Math.max(0, centre - marge), Math.min(1, centre + marge)];
}

export interface VeriteTerrain {
  dateDemo: string;
  motifs: Array<{ id: string; itemAttendu: string | null; feedbackIds: string[] }>;
  bruit: string[];
  autres: Record<string, string | null>;
}

/**
 * Ce que la vérité terrain attend de chaque feedback : l'id d'un item, une étiquette d'item nouveau
 * (M3 : NOUVEAU_BUG_EXPORT_PDF), ou null (bruit, injection, demande sans item).
 */
export function attendusParFeedback(verite: VeriteTerrain): Map<string, string | null> {
  const attendus = new Map<string, string | null>();
  for (const m of verite.motifs) for (const id of m.feedbackIds) attendus.set(id, m.itemAttendu);
  for (const id of verite.bruit) attendus.set(id, null);
  for (const [id, item] of Object.entries(verite.autres)) attendus.set(id, item);
  return attendus;
}

/** Issue d'un rattachement à plusieurs tirages, selon la règle de la chaîne : un item, « nouveau », ou « doute ». */
export function issueRattachement(verdicts: Array<{ itemId: string | null; verdict: VerdictRattachement }>): string {
  const analyse = analyserVerdicts(verdicts.map((v) => v.verdict));
  const ids = verdicts.map((v) => v.itemId);
  if (!analyse.doute && analyse.verdict === "meme_besoin" && ids.every((id) => id !== null && id === ids[0])) return ids[0] as string;
  if (!analyse.doute && analyse.verdict === "different") return "nouveau";
  return "doute";
}

/** Issue attendue d'après la vérité terrain : un item du backlog, ou « nouveau » pour un besoin absent du backlog. */
export function issueAttendue(attendu: string | null | undefined, idsBacklog: Set<string>): string | null {
  if (attendu === undefined || attendu === null) return null;
  return idsBacklog.has(attendu) ? attendu : "nouveau";
}

export interface BilanRegle {
  /** La règle passe la validation du domaine (mots-clés non vides, d'au moins 2 caractères). */
  valide: boolean;
  /** Appliquée au texte du cas source (résumé et citation), elle désigne l'item choisi par le PO. */
  rattacheSource: boolean;
  /** Feedbacks d'un autre item (ou sans item) que la règle capterait : doit être vide. */
  capturesHorsItem: string[];
  /** Généralisation, mesurée : feedbacks du même item que la règle capterait. */
  capturesMemeItem: number;
  totalMemeItem: number;
}

/**
 * Vérifie une règle de rattachement formulée par le modèle.
 * Le corpus est appliqué tel quel : avec des textes entiers de feedbacks, les captures sont une borne haute.
 */
export function verifierRegle(
  contenu: { motsCles: string[]; itemId: string },
  texteSource: string,
  corpus: Array<{ id: string; texte: string; attendu: string | null }>,
): BilanRegle {
  let regle: Regle;
  try {
    regle = { ...proposerRegle({ id: "EVAL", reponse: { id: "eval", auteur: "po" }, contenu: { type: "rattachement", ...contenu }, texte: "", maintenant: new Date(0) }), statut: "active" };
  } catch {
    return { valide: false, rattacheSource: false, capturesHorsItem: [], capturesMemeItem: 0, totalMemeItem: corpus.filter((c) => c.attendu === contenu.itemId).length };
  }
  const capte = (texte: string) => appliquerRattachement(texte, [regle])?.itemId === contenu.itemId;
  const memeItem = corpus.filter((c) => c.attendu === contenu.itemId);
  return {
    valide: true,
    rattacheSource: capte(texteSource),
    capturesHorsItem: corpus.filter((c) => c.attendu !== contenu.itemId && capte(c.texte)).map((c) => c.id),
    capturesMemeItem: memeItem.filter((c) => capte(c.texte)).length,
    totalMemeItem: memeItem.length,
  };
}

/** Vrai si la paire (a, b) figure parmi les fusions proposées, dans un sens ou dans l'autre. */
export function paireDans(fusions: Array<{ itemA: string; itemB: string }>, a: string, b: string): boolean {
  return fusions.some((f) => (f.itemA === a && f.itemB === b) || (f.itemA === b && f.itemB === a));
}

/** Fusions proposées qui ne font pas partie des doublons attendus. */
export function fusionsHorsAttendues(fusions: Array<{ itemA: string; itemB: string }>, attendues: Array<[string, string]>): Array<{ itemA: string; itemB: string }> {
  return fusions.filter((f) => !attendues.some(([a, b]) => paireDans([f], a, b)));
}

// Le repérage des citations est dans le domaine : la conversation l'applique en production, le banc le mesure.
export { citationsInventees, passagesCites } from "@po-agent/domain";

/**
 * Citations d'une story qui ne figurent mot pour mot dans aucun des verbatims fournis.
 * Chaque verbatim est comparé seul : une citation recousue à cheval sur deux verbatims est refusée.
 */
export function citationsHorsVerbatims(citations: string[], verbatims: string[]): string[] {
  return citations.filter((c) => !verbatims.some((v) => citationVerifiee(c, v)));
}

/** Les six critères du juge des stories (SchemaJugementStory, sans le commentaire). */
export const CRITERES_JUGE = ["independante", "valeur", "estimable", "petite", "testable", "un_seul_besoin"] as const satisfies ReadonlyArray<keyof JugementStory>;
export type CritereJuge = (typeof CRITERES_JUGE)[number];

/** Critères sur lesquels les verdicts du juge diffèrent d'un appel à l'autre, pour une même story. */
export function criteresInstables(verdicts: Array<Pick<JugementStory, CritereJuge>>): CritereJuge[] {
  return CRITERES_JUGE.filter((c) => new Set(verdicts.map((v) => v[c])).size > 1);
}

/** Forme comparable d'un libellé : minuscules, sans accents ni ponctuation. */
export function simplifier(texte: string): string {
  // NFKD : les lettres en exposant (« 1ᵉʳ ») deviennent des lettres ordinaires (« 1er »).
  return normaliser(texte)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Titre court d'un item : ce qui précède une parenthèse (« SSO (SAML, Okta, Entra ID) » donne « SSO »). */
export function titreCourt(titre: string): string {
  return titre.split(" (")[0] ?? titre;
}

/** Le texte nomme l'item, par son identifiant ou son titre court. */
export function nommeItem(texte: string, item: { id: string; titre: string }): boolean {
  const t = ` ${simplifier(texte)} `;
  return t.includes(` ${simplifier(item.id)} `) || t.includes(` ${simplifier(titreCourt(item.titre))} `);
}

/** Rang d'arrivée lu dans la sortie de l'outil de simulation (« … à 12,5 (rang 3). »). */
export function rangSimule(sortie: string): number | null {
  const rangs = [...sortie.matchAll(/rang (\d+)\)/g)].map((m) => Number(m[1]));
  return rangs.length > 0 ? (rangs.at(-1) as number) : null;
}

/**
 * Le texte annonce ce rang : « rang 3 », « 3e », « 3ème », « position 3 », « troisième »…
 * Un chiffre seul ne suffit pas : la question peut contenir le même nombre (« Impact 3 »).
 */
export function citeLeRang(texte: string, rang: number): boolean {
  const ordinaux = ["premier", "deuxieme", "troisieme", "quatrieme", "cinquieme", "sixieme", "septieme", "huitieme", "neuvieme", "dixieme"];
  const t = ` ${simplifier(texte)} `;
  const n = String(rang);
  if (new RegExp(` (rang|position|place|numero) ${n} `).test(t)) return true;
  if (new RegExp(` ${n} ?(e|eme|er|ere) `).test(t)) return true;
  const ordinal = ordinaux[rang - 1];
  if (ordinal && new RegExp(` ${ordinal}e? `).test(t)) return true;
  return rang === 1 && / en tete /.test(t);
}

/** Heuristique : le texte affirme avoir modifié quelque chose (« c'est fait », « j'ai placé… »). */
export function pretendAvoirAgi(texte: string): boolean {
  const t = normaliser(texte).toLowerCase();
  return /\b(c'est fait|voilà qui est fait|c'est chose faite)\b/.test(t) || /\b(j'ai|je l'ai)\s+(bien\s+)?(placé|mis|déplacé|ajouté|modifié|mis à jour|réordonné|passé|remonté)\b/.test(t);
}
