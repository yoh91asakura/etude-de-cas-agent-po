import { PARAMETRES } from "./parametres.ts";
import type { Moscow } from "./types.ts";

export interface EntreeMoscow {
  itemId: string;
  score: number;
  effort: number;
  /** Bug de régression touchant au moins un compte payant. */
  regressionPayante: boolean;
  /** Au moins un compte Business menace de partir faute de cet item. */
  risqueDepartBusiness: boolean;
}

export interface PropositionMoscow {
  itemId: string;
  categorie: Moscow;
  raison: string;
}

/**
 * Proposition MoSCoW pour la prochaine release. L'agent propose, le PO tranche.
 * 1. Must par règle : régression sur des comptes payants, ou risque de départ d'un compte Business.
 * 2. Les autres items, par score décroissant : Should tant que la capacité tient,
 *    Could jusqu'au multiple de capacité, Won't au-delà.
 */
export function proposerMoscow(entrees: EntreeMoscow[], p = PARAMETRES.moscow): PropositionMoscow[] {
  const resultat: PropositionMoscow[] = [];
  let cumul = 0;

  const musts = entrees.filter((e) => e.regressionPayante || e.risqueDepartBusiness);
  const autres = entrees
    .filter((e) => !(e.regressionPayante || e.risqueDepartBusiness))
    .sort((a, b) => b.score - a.score || a.itemId.localeCompare(b.itemId));

  for (const e of musts) {
    cumul += e.effort;
    const raison = e.regressionPayante
      ? "Régression qui touche des comptes payants"
      : "Un compte Business menace de partir";
    resultat.push({ itemId: e.itemId, categorie: "must", raison });
  }

  for (const e of autres) {
    if (cumul + e.effort <= p.capaciteRelease) {
      cumul += e.effort;
      resultat.push({ itemId: e.itemId, categorie: "should", raison: "Tient dans la capacité de la release" });
    } else if (cumul + e.effort <= p.capaciteRelease * p.multipleCould) {
      cumul += e.effort;
      resultat.push({ itemId: e.itemId, categorie: "could", raison: "Au-delà de la capacité, à faire si la release avance bien" });
    } else {
      resultat.push({ itemId: e.itemId, categorie: "wont", raison: "Hors capacité pour cette release" });
    }
  }
  return resultat;
}
