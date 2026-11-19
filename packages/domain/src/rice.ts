import { PARAMETRES } from "./parametres.ts";
import type { Compte, DetailScore, DetailSegment, Filtre, ItemBacklog, Plan, Preuve } from "./types.ts";

const JOUR_MS = 24 * 60 * 60 * 1000;

export interface EntreeScore {
  item: ItemBacklog;
  preuves: Preuve[];
  /** Médiane des tirages d'Impact, éventuellement ajustée par une règle de doctrine. */
  impact: number;
  comptes: ReadonlyMap<string, Compte>;
  maintenant: Date;
  filtres?: Filtre[];
}

function segmentVide(): DetailSegment {
  return { comptes: 0, messages: 0, mrr: 0 };
}

/** Preuves qui comptent : sûres, dans la fenêtre glissante, et un seul exemplaire par feedback. */
export function preuvesComptees(preuves: Preuve[], maintenant: Date): Preuve[] {
  const debut = maintenant.getTime() - PARAMETRES.rice.fenetreReachJours * JOUR_MS;
  const vus = new Set<string>();
  const retenues: Preuve[] = [];
  for (const p of preuves) {
    const t = Date.parse(p.recuLe);
    if (!p.sure || Number.isNaN(t) || t < debut || t > maintenant.getTime()) continue;
    if (vus.has(p.feedbackId)) continue;
    vus.add(p.feedbackId);
    retenues.push(p);
  }
  return retenues;
}

export function calculerConfidence(nbComptes: number, nbCanaux: number): number {
  const c = PARAMETRES.rice.confidence;
  if (nbComptes >= c.comptesPleine && nbCanaux >= c.canauxPleine) return c.valeurPleine;
  if (nbComptes >= c.palierComptes) return c.valeurPalier;
  return c.base;
}

export function calculerScore(e: EntreeScore): DetailScore {
  const filtres = e.filtres ?? [];
  const retenues = preuvesComptees(e.preuves, e.maintenant);

  const comptesDistincts = new Map<string, Compte>();
  const canaux = new Set<string>();
  const parSegment: Record<Plan, DetailSegment> = {
    free: segmentVide(),
    pro: segmentVide(),
    business: segmentVide(),
  };

  for (const p of retenues) {
    const compte = e.comptes.get(p.compteId);
    if (!compte) throw new Error(`Compte inconnu pour la preuve ${p.id} : ${p.compteId}`);
    canaux.add(p.canal);
    parSegment[compte.plan].messages += 1;
    if (!comptesDistincts.has(compte.id)) {
      comptesDistincts.set(compte.id, compte);
      parSegment[compte.plan].comptes += 1;
      parSegment[compte.plan].mrr += compte.mrr;
    }
  }

  let reach: number;
  let uniteReach: DetailScore["uniteReach"];
  if (filtres.includes("mrr")) {
    uniteReach = "kEUR";
    reach = 0;
    for (const c of comptesDistincts.values()) {
      const majoration = c.risqueDepart ? PARAMETRES.filtres.multiplicateurRisqueDepart : 1;
      reach += (c.mrr / 1000) * majoration;
    }
  } else {
    uniteReach = "comptes";
    reach = comptesDistincts.size;
  }

  const confidence = calculerConfidence(comptesDistincts.size, canaux.size);
  const effort = PARAMETRES.rice.effortParComplexite[e.item.complexite];

  const multiplicateurs: DetailScore["multiplicateurs"] = [];
  if (filtres.includes("objectif") && e.item.alignementObjectif) {
    multiplicateurs.push({ raison: "Aligné sur l'objectif du trimestre", valeur: PARAMETRES.filtres.multiplicateurObjectif });
  }

  const produit = multiplicateurs.reduce((acc, m) => acc * m.valeur, 1);
  const score = (reach * e.impact * confidence * produit) / effort;

  return {
    itemId: e.item.id,
    filtres,
    reach,
    uniteReach,
    impact: e.impact,
    confidence,
    effort,
    multiplicateurs,
    score,
    parSegment,
    preuvesComptees: retenues.map((p) => p.id),
  };
}

export interface RangBacklog {
  rang: number;
  /** Un candidat n'a pas de rang à lui : `rang` est celui qu'il prendrait s'il était accepté. */
  candidat: boolean;
}

/**
 * Un seul comptage des rangs (audit du 15/11/2026) : seuls les éléments du backlog sont numérotés, comme dans
 * l'ordre officiel et les propositions d'ordre. Avant, la vue comptait les candidats et la proposition non :
 * le même élément avait deux rangs à l'écran. Un élément clos n'a pas de rang.
 */
export function numeroterRangs(idsClasses: readonly string[], statuts: ReadonlyMap<string, string>): Map<string, RangBacklog> {
  const rangs = new Map<string, RangBacklog>();
  let n = 0;
  for (const id of idsClasses) {
    const statut = statuts.get(id);
    if (!statut || statut === "termine") continue;
    if (statut === "candidat") rangs.set(id, { rang: n + 1, candidat: true });
    else rangs.set(id, { rang: ++n, candidat: false });
  }
  return rangs;
}

/** « rang 3 », ou « candidat, se placerait au rang 3 ». */
export function decrireRang(r: RangBacklog): string {
  return r.candidat ? `candidat, se placerait au rang ${r.rang}` : `rang ${r.rang}`;
}

/** Classement déterministe : score décroissant, puis identifiant pour départager. */
export function classer(scores: DetailScore[]): DetailScore[] {
  return [...scores].sort((a, b) => b.score - a.score || a.itemId.localeCompare(b.itemId));
}
