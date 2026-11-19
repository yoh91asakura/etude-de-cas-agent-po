import type { Complexite, ValeurImpact } from "./parametres.ts";

export type Plan = "free" | "pro" | "business";
export type Canal = "email" | "ticket" | "commentaire" | "direct";

export interface Compte {
  id: string;
  nom: string;
  plan: Plan;
  /** MRR mensuel en euros. */
  mrr: number;
  /** Vrai quand un message a signalé une menace de départ. */
  risqueDepart?: boolean;
}

export interface Feedback {
  id: string;
  compteId: string;
  canal: Canal;
  /** Date ISO 8601. */
  recuLe: string;
  texte: string;
}

/** Nature d'un feedback, décidée par l'appel d'extraction (en quarantaine, sans outils). */
export type NatureFeedback = "demande" | "bug" | "compliment" | "question" | "bruit" | "suspect";

/** Sortie structurée de l'extraction. C'est la seule chose que la suite de la chaîne voit d'un feedback. */
export interface Extraction {
  feedbackId: string;
  nature: NatureFeedback;
  /** Vrai si le texte tente de donner des instructions à l'agent. */
  injectionSuspectee: boolean;
  /** Vrai si le texte exprime une menace de départ. */
  menaceDepart: boolean;
  demandes: Array<{
    resume: string;
    /** Citation qui doit figurer mot pour mot dans le texte du feedback. */
    citation: string;
    /** Vrai si le texte décrit un comportement qui fonctionnait avant (régression). */
    regression: boolean;
  }>;
}

export type TypeItem = "fonctionnalite" | "bug";
export type StatutItem = "candidat" | "backlog" | "pret" | "termine";

export interface ItemBacklog {
  id: string;
  titre: string;
  description?: string;
  type: TypeItem;
  statut: StatutItem;
  complexite: Complexite;
  /** Aligné sur l'objectif du trimestre. */
  alignementObjectif: boolean;
}

export type VerdictRattachement = "meme_besoin" | "different" | "incertain";

/** Lien entre un feedback et un item, avec la citation qui le justifie. */
export interface Preuve {
  id: string;
  itemId: string;
  feedbackId: string;
  compteId: string;
  canal: Canal;
  recuLe: string;
  citation: string;
  /** Seules les preuves « sûres » comptent dans le Reach et la Confidence. */
  sure: boolean;
  /** Règle de doctrine qui a tranché le rattachement, le cas échéant. */
  regleId?: string;
}

export interface JugementImpact {
  itemId: string;
  tirages: ValeurImpact[];
  mediane: ValeurImpact;
  justification: string;
  citations: string[];
}

export type Filtre = "aucun" | "mrr" | "objectif";

export interface DetailSegment {
  comptes: number;
  messages: number;
  mrr: number;
}

export interface DetailScore {
  itemId: string;
  filtres: Filtre[];
  reach: number;
  /** Nature du Reach : comptes distincts, ou k€ de MRR avec le filtre MRR. */
  uniteReach: "comptes" | "kEUR";
  impact: number;
  confidence: number;
  effort: number;
  multiplicateurs: Array<{ raison: string; valeur: number }>;
  score: number;
  parSegment: Record<Plan, DetailSegment>;
  preuvesComptees: string[];
}

export type Moscow = "must" | "should" | "could" | "wont";
