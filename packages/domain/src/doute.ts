import { ECHELLE_IMPACT, PARAMETRES, type ValeurImpact } from "./parametres.ts";
import type { VerdictRattachement } from "./types.ts";

export function indexImpact(v: number): number {
  const i = ECHELLE_IMPACT.indexOf(v as ValeurImpact);
  if (i < 0) throw new Error(`Valeur d'Impact hors échelle : ${v}`);
  return i;
}

export function impactDepuisIndex(i: number): ValeurImpact {
  const borne = Math.min(Math.max(i, 0), ECHELLE_IMPACT.length - 1);
  return ECHELLE_IMPACT[borne] as ValeurImpact;
}

export interface AnalyseTirages {
  mediane: ValeurImpact;
  ecartCrans: number;
  doute: boolean;
}

/** Médiane des tirages (cran inférieur si le nombre est pair) et doute si l'écart dépasse le seuil. */
export function analyserTirages(tirages: number[], p = PARAMETRES.doute): AnalyseTirages {
  if (tirages.length === 0) throw new Error("Aucun tirage d'Impact");
  const indices = tirages.map(indexImpact).sort((a, b) => a - b);
  const milieu = indices[Math.floor((indices.length - 1) / 2)] as number;
  const ecartCrans = (indices[indices.length - 1] as number) - (indices[0] as number);
  return { mediane: impactDepuisIndex(milieu), ecartCrans, doute: ecartCrans > p.ecartMaxCrans };
}

/** Verdict de rattachement : seul un accord unanime et tranché évite le doute. */
export function analyserVerdicts(verdicts: VerdictRattachement[]): { verdict: VerdictRattachement; doute: boolean } {
  if (verdicts.length === 0) return { verdict: "incertain", doute: true };
  const premier = verdicts[0] as VerdictRattachement;
  const unanime = verdicts.every((v) => v === premier);
  if (unanime && premier !== "incertain") return { verdict: premier, doute: false };
  return { verdict: "incertain", doute: true };
}

export interface QuestionCandidate {
  id: string;
  /** Ce que la réponse ferait bouger dans le classement (par exemple un écart de rang). Sert au tri. */
  enjeu: number;
  urgente: boolean;
}

/**
 * Sélection des questions à poser au PO : les urgences partent toujours,
 * les autres sont triées par enjeu et plafonnées par jour.
 */
export function selectionnerQuestions(
  candidates: QuestionCandidate[],
  dejaPoseesAujourdhui: number,
  p = PARAMETRES.questions,
): { aPoser: QuestionCandidate[]; enAttente: QuestionCandidate[] } {
  const urgentes = candidates.filter((q) => q.urgente);
  const autres = candidates
    .filter((q) => !q.urgente)
    .sort((a, b) => b.enjeu - a.enjeu || a.id.localeCompare(b.id));
  const place = Math.max(0, p.maxParJour - dejaPoseesAujourdhui);
  return { aPoser: [...urgentes, ...autres.slice(0, place)], enAttente: autres.slice(place) };
}

export type EtatQuestion = "ouverte" | "relancee" | "repondue" | "expiree";

/** Au passage du résumé, une question restée sans réponse est relancée une fois, puis expire. */
export function etatApresResume(
  q: { etat: EtatQuestion; relances: number },
  p = PARAMETRES.questions,
): { etat: EtatQuestion; relances: number } {
  if (q.etat === "repondue" || q.etat === "expiree") return q;
  if (q.relances < p.relancesMax) return { etat: "relancee", relances: q.relances + 1 };
  return { etat: "expiree", relances: q.relances };
}
