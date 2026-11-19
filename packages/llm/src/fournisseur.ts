import type { ZodObject } from "zod";
import type { Complexite, Extraction, ItemBacklog, Story, ValeurImpact, VerdictRattachement } from "@po-agent/domain";
import type { JugementStory } from "./schemas.ts";

export interface DemandeARattacher {
  resume: string;
  citation: string;
}

export type CandidatItem = Pick<ItemBacklog, "id" | "titre" | "description">;

export interface VerdictLLM {
  itemId: string | null;
  verdict: VerdictRattachement;
  /** Éléments entre lesquels le modèle hésite (tous connus des candidats). */
  alternatives: string[];
  justification: string;
}

export interface EntreeImpact {
  item: Pick<ItemBacklog, "id" | "titre" | "description">;
  citations: string[];
}

export interface EntreeDecoupage {
  item: ItemBacklog;
  story: Story;
  citations: string[];
  /** Ce que le juge reproche à la story (critères refusés, commentaire). */
  reproches: string[];
}

export interface ImpactLLM {
  impact: ValeurImpact;
  justification: string;
  citations: string[];
}

/**
 * Interface de la couche LLM. La chaîne ne connaît qu'elle.
 * Chaque méthode correspond à un appel, sans outils, à sortie structurée.
 * Les tirages multiples (Impact, rattachement) sont orchestrés par l'appelant.
 */
export interface FournisseurLLM {
  readonly nom: string;
  /** Appel en quarantaine : seul à lire le texte brut d'un feedback. */
  extraire(feedback: { id: string; texte: string }): Promise<Extraction>;
  jugerRattachement(demande: DemandeARattacher, candidats: CandidatItem[], tirage: number): Promise<VerdictLLM>;
  jugerImpact(entree: EntreeImpact, tirage: number): Promise<ImpactLLM>;
  estimerComplexite(item: Pick<ItemBacklog, "titre" | "description">, citations: string[]): Promise<{ complexite: Complexite; justification: string }>;
  redigerStory(entree: { item: ItemBacklog; citations: string[] }): Promise<Story>;
  jugerStory(story: Story): Promise<JugementStory>;
  /**
   * Découpe une story que le juge trouve trop grosse ou qui mélange plusieurs besoins, en 2 à 4 stories plus petites.
   * Le LLM ne fait que rédiger : le PO accepte ou refuse le découpage.
   */
  decouperStory(entree: EntreeDecoupage): Promise<{ stories: Story[]; justification: string }>;
  /**
   * Formule une règle à partir d'une réponse du PO. Le LLM ne fait que rédiger :
   * la règle reste rattachée à la réponse du PO, qui doit encore la valider.
   */
  formulerRegleRattachement(entree: { citation: string; itemChoisi: CandidatItem; itemsEcartes: CandidatItem[] }): Promise<{ motsCles: string[]; texte: string }>;
  /** Revue de fond : propositions de fusion, et règles qui généralisent des réponses du PO déjà données. */
  revueDeFond(etat: EtatRevue): Promise<ResultatRevue>;
  /**
   * Conversation libre avec le PO : une boucle d'outils fournis par l'appelant.
   * Les outils sont en lecture seule ou de simulation : l'agent conversationnel ne modifie rien.
   */
  converser(entree: { message: string; historique: MessageConversation[]; outils: OutilConversation[] }): Promise<ReponseConversation>;
}

export interface OutilConversation {
  nom: string;
  description: string;
  schema: ZodObject;
  executer: (entree: unknown) => Promise<string>;
}

export interface MessageConversation {
  role: "user" | "assistant";
  texte: string;
}

export interface ReponseConversation {
  texte: string;
  appels: Array<{ outil: string; entree: unknown }>;
}

export interface EtatRevue {
  items: Array<CandidatItem & { creeParAgent: boolean; preuves: number; verbatims: string[] }>;
  reponsesPO: Array<{ id: string; enonce: string; choix: string; citation: string | null }>;
}

export interface ResultatRevue {
  fusions: Array<{ itemA: string; itemB: string; explication: string }>;
  regles: Array<{ itemId: string; motsCles: string[]; reponsesSources: string[]; texte: string }>;
}

export type MotifEchec = "refus" | "schema_invalide" | "erreur";

/** Échec maîtrisé : la chaîne met l'élément en attente au lieu de casser en silence. */
export class EchecLLM extends Error {
  constructor(
    readonly etape: string,
    readonly motif: MotifEchec,
    message: string,
  ) {
    super(`${etape} : ${message}`);
    this.name = "EchecLLM";
  }
}
