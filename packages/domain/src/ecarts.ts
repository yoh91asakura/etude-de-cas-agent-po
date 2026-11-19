import type { DetailScore } from "./types.ts";

export type Facteur = "reach" | "impact" | "confidence" | "effort" | "multiplicateurs";

export interface Cause {
  facteur: Facteur;
  avant: number;
  apres: number;
}

export interface Ecart {
  itemId: string;
  scoreAvant: number | null;
  scoreApres: number;
  delta: number;
  nouvellesPreuves: string[];
  preuvesRetirees: string[];
  causes: Cause[];
}

function produitMultiplicateurs(s: DetailScore): number {
  return s.multiplicateurs.reduce((acc, m) => acc * m.valeur, 1);
}

/** Attribue un écart de score à ses causes : facteurs RICE modifiés et preuves arrivées ou retirées. */
export function expliquerEcart(avant: DetailScore | undefined, apres: DetailScore): Ecart {
  const causes: Cause[] = [];
  const facteurs: Array<[Facteur, (s: DetailScore) => number]> = [
    ["reach", (s) => s.reach],
    ["impact", (s) => s.impact],
    ["confidence", (s) => s.confidence],
    ["effort", (s) => s.effort],
    ["multiplicateurs", produitMultiplicateurs],
  ];
  if (avant) {
    for (const [nom, lire] of facteurs) {
      const a = lire(avant);
      const b = lire(apres);
      if (Math.abs(a - b) > 1e-9) causes.push({ facteur: nom, avant: a, apres: b });
    }
  }
  const avantIds = new Set(avant?.preuvesComptees ?? []);
  const apresIds = new Set(apres.preuvesComptees);
  return {
    itemId: apres.itemId,
    scoreAvant: avant ? avant.score : null,
    scoreApres: apres.score,
    delta: apres.score - (avant?.score ?? 0),
    nouvellesPreuves: apres.preuvesComptees.filter((id) => !avantIds.has(id)),
    preuvesRetirees: [...avantIds].filter((id) => !apresIds.has(id)),
    causes,
  };
}

const LIBELLES: Record<Facteur, string> = {
  reach: "Reach",
  impact: "Impact",
  confidence: "Confidence",
  effort: "Effort",
  multiplicateurs: "Filtres",
};

function arrondi(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

/** Phrase lisible pour le PO, par exemple « Score 4.8 → 7.2 : Reach 4 → 5 ; 1 nouvelle preuve. » */
export function decrireEcart(e: Ecart): string {
  const morceaux = e.causes.map((c) => `${LIBELLES[c.facteur]} ${arrondi(c.avant)} → ${arrondi(c.apres)}`);
  if (e.nouvellesPreuves.length > 0) {
    morceaux.push(`${e.nouvellesPreuves.length} nouvelle${e.nouvellesPreuves.length > 1 ? "s" : ""} preuve${e.nouvellesPreuves.length > 1 ? "s" : ""}`);
  }
  if (e.preuvesRetirees.length > 0) {
    morceaux.push(`${e.preuvesRetirees.length} preuve${e.preuvesRetirees.length > 1 ? "s" : ""} retirée${e.preuvesRetirees.length > 1 ? "s" : ""}`);
  }
  const debut = e.scoreAvant === null ? `Score ${arrondi(e.scoreApres)}` : `Score ${arrondi(e.scoreAvant)} → ${arrondi(e.scoreApres)}`;
  return morceaux.length > 0 ? `${debut} : ${morceaux.join(" ; ")}.` : `${debut}.`;
}

/** Entrées et sorties du top N entre deux classements (listes d'identifiants ordonnées). */
export function mouvementsTop(avant: string[], apres: string[], n: number): { entrees: string[]; sorties: string[] } {
  const topAvant = new Set(avant.slice(0, n));
  const topApres = new Set(apres.slice(0, n));
  return {
    entrees: apres.slice(0, n).filter((id) => !topAvant.has(id)),
    sorties: avant.slice(0, n).filter((id) => !topApres.has(id)),
  };
}
