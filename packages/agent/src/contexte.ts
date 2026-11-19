import type { Story } from "@po-agent/domain";
import type { Db, FileTaches } from "@po-agent/db";
import type { FournisseurLLM } from "@po-agent/llm";

export type TypeEvenement = "feedback" | "classement" | "alerte" | "question" | "proposition" | "regle" | "story" | "journal";

export interface Evenement {
  type: TypeEvenement;
  donnees?: unknown;
}

/** Outil de suivi de l'équipe (Jira chez la plupart des clients). Optionnel. */
export interface OutilDeSuivi {
  readonly nom: string;
  creerTicket(story: Story, titre: string): Promise<{ cle: string; url: string }>;
}

/** Tout ce dont la chaîne a besoin, injecté : base, modèle, file de tâches, horloge, diffusion vers l'interface. */
export interface Contexte {
  db: Db;
  llm: FournisseurLLM;
  file: FileTaches;
  maintenant: () => Date;
  diffuser: (e: Evenement) => void;
  /** Absent : les stories validées restent dans l'application, sans proposition d'export. */
  suivi?: OutilDeSuivi;
  /**
   * Traitement en lot (préchargement de la démo) : les entrées et sorties du top 5 ne sont pas signalées une à une.
   * Au fil d'un chargement de six semaines, elles ne disent rien au PO et noient les vraies alertes.
   */
  modeLot?: boolean;
}
