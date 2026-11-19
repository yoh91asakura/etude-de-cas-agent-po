/**
 * PARAMÈTRES MÉTIER : À VALIDER PAR L'HUMAIN
 *
 * Toutes les formules, tous les seuils et tous les plafonds de l'agent sont réunis ici.
 * Le cadrage (CLAUDE.md) les classe parmi les éléments qui appartiennent à l'humain :
 * ces valeurs sont des propositions de l'IA tant qu'elles n'ont pas été relues.
 * Après validation, mettre `valide` à true et consigner la date dans JOURNAL.md.
 */

export const STATUT_PARAMETRES = {
  valide: false,
  proposePar: "IA (Claude Code), 2026-11-14",
} as const;

/** Échelle RICE standard de l'Impact, avec ses ancres (grille proposée). */
export const ECHELLE_IMPACT = [0.25, 0.5, 1, 2, 3] as const;
export type ValeurImpact = (typeof ECHELLE_IMPACT)[number];

export const ANCRES_IMPACT: Record<ValeurImpact, string> = {
  0.25: "Minime : confort marginal, aucun blocage, aucune mention d'enjeu.",
  0.5: "Faible : confort apprécié, contournement facile.",
  1: "Moyen : gêne récurrente dans le travail quotidien, contournement coûteux.",
  2: "Fort : bloque un usage important, ou freine l'adoption par une équipe.",
  3: "Massif : bloque l'usage, menace de départ, ou condition d'achat explicite.",
};

export const PARAMETRES = {
  rice: {
    /** Fenêtre glissante, en jours, pour compter le Reach (comptes distincts). */
    fenetreReachJours: 90,
    /** Nombre de tirages indépendants pour juger l'Impact. On retient la médiane. */
    tiragesImpact: 5,
    /** Effort en personne-mois, selon la taille estimée. */
    effortParComplexite: { S: 0.5, M: 1, L: 2, XL: 4 },
    /** Paliers de Confidence, selon la solidité des preuves (seuls les rattachements sûrs comptent). */
    confidence: {
      base: 0.5,
      palierComptes: 3, // à partir de 3 comptes distincts : 0.8
      valeurPalier: 0.8,
      comptesPleine: 5, // à partir de 5 comptes ET 2 canaux : 1.0
      canauxPleine: 2,
      valeurPleine: 1.0,
    },
  },
  filtres: {
    /** Filtre MRR : le Reach devient la somme du MRR des comptes demandeurs, en k€. */
    multiplicateurRisqueDepart: 1.5,
    /** Filtre objectif du trimestre : bonus appliqué aux items alignés. */
    multiplicateurObjectif: 1.3,
  },
  tendances: {
    /** Fenêtre récente comparée à la fenêtre précédente de même durée. */
    fenetreJours: 14,
    /** Une tendance exige au moins ce nombre d'occurrences récentes… */
    minimumRecent: 3,
    /** …et un nombre récent au moins égal à ce facteur multiplié par le nombre précédent. */
    facteur: 2,
  },
  doute: {
    /** Doute sur l'Impact si l'écart entre tirages dépasse ce nombre de crans de l'échelle. */
    ecartMaxCrans: 1,
    /** Nombre de tirages pour un verdict de rattachement (même besoin / différent / incertain). */
    tiragesRattachement: 3,
  },
  questions: {
    /** Plafond de questions au PO par jour (hors urgences). */
    maxParJour: 5,
    /** Une question sans réponse est reposée une fois au résumé suivant, puis expire. */
    relancesMax: 1,
    /** Délai minimal entre la pose (ou la relance) d'une question et le passage qui la relance ou la fait expirer. */
    delaiAvantRelanceHeures: 3,
  },
  alertes: {
    /** Nombre maximal d'alertes non urgentes reprises dans un résumé ; les autres restent dans la boîte de l'agent. */
    maxParJour: 6,
    /** Taille du « top » surveillé pour les entrées et sorties. */
    tailleTop: 5,
    /** Vue de référence du PO pour les alertes et les brouillons de stories (filtres appliqués). */
    vueReference: ["mrr"] as const,
  },
  moscow: {
    /** Capacité de la prochaine release, en personne-mois. */
    capaciteRelease: 6,
    /** Les Could remplissent jusqu'à ce multiple de la capacité ; au-delà, Won't. */
    multipleCould: 1.5,
  },
  agentDeFond: {
    /** Heures de passage de l'agent de fond, dans le fuseau du PO. */
    heures: [9, 13, 17],
    fuseau: "Europe/Paris",
  },
} as const;

export type Complexite = keyof typeof PARAMETRES.rice.effortParComplexite;
