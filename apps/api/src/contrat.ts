/**
 * Contrat de l'API du cockpit. L'interface web n'importe que ces types (import de type uniquement).
 * Toutes les routes sont préfixées par /api. Les dates sont en ISO 8601.
 */

export type Plan = "free" | "pro" | "business";
export type FiltreVue = "mrr" | "objectif";

/** GET /api/etat */
export interface EtatApi {
  fournisseur: string;
  /** Vrai quand le fournisseur est le faux (démo sans clé) : l'interface l'affiche clairement. */
  fournisseurFactice: boolean;
  maintenant: string;
  parametresValides: boolean;
  compteurs: { feedbacks: number; traites: number; enAttente: number; suspects: number; questionsOuvertes: number; propositionsEnAttente: number };
  /** Nombre de feedbacks du simulateur « direct » restant à injecter. */
  simulateurRestants: number;
  /** Vue sur laquelle l'agent raisonne (alertes, stories, ordre proposé, résumé). */
  vueReference: FiltreVue[];
  /** Questions créées mais pas encore posées (plafond quotidien, tri par enjeu). */
  questionsEnFile: number;
  /** Vrai quand un outil de suivi (Jira) est branché : une story validée peut alors y être exportée. */
  outilSuiviBranche: boolean;
}

export interface SegmentApi {
  comptes: number;
  messages: number;
  mrr: number;
}

/** Une ligne du backlog vivant. GET /api/classement?filtres=mrr,objectif */
export interface LigneClassement {
  rang: number;
  itemId: string;
  titre: string;
  type: "fonctionnalite" | "bug";
  statut: "candidat" | "backlog" | "pret" | "termine";
  complexite: "S" | "M" | "L" | "XL";
  alignementObjectif: boolean;
  score: number;
  reach: number;
  uniteReach: "comptes" | "kEUR";
  impact: number;
  confidence: number;
  effort: number;
  multiplicateurs: Array<{ raison: string; valeur: number }>;
  parSegment: Record<Plan, SegmentApi>;
  nbPreuves: number;
  /** Tirages d'Impact et écart en crans : un écart supérieur à 1 signale un doute. */
  tiragesImpact: number[];
  ecartImpact: number;
  impactTranchePO: boolean;
  tendance: { recent: number; precedent: number; tendance: boolean };
  risqueDepart: boolean;
  /** Explication du dernier mouvement de score, en français. */
  explication: string | null;
  reglesCitees: string[];
  aUneStory: boolean;
}

export interface PreuveApi {
  id: string;
  feedbackId: string;
  compte: { id: string; nom: string; plan: Plan; mrr: number };
  canal: string;
  recuLe: string;
  citation: string;
  sure: boolean;
  regleId: string | null;
  itemOrigine: string | null;
  /** Vrai si la preuve vient d'un item absorbé par une fusion (la fusion peut alors se défaire). */
  origineFusionnee: boolean;
}

export interface StoryApi {
  id: string;
  itemId: string;
  /** « proposee » : issue d'un découpage que le PO n'a pas encore tranché. */
  statut: "brouillon" | "prete" | "exportee" | "proposee" | "remplacee" | "refusee";
  enTantQue: string;
  jeVeux: string;
  afinDe: string;
  criteres: Array<{ etantDonne: string; quand: string; alors: string }>;
  casLimites: string[];
  complexite: string;
  citations: string[];
  controles: Array<{ nom: string; ok: boolean; detail?: string }>;
  jugement: Record<string, boolean | string> | null;
  /** Ticket créé dans l'outil de l'équipe (Jira), après décision du PO. */
  ticket: { cle: string; url: string } | null;
  /** Story d'origine, pour une story issue d'un découpage. */
  parentId: string | null;
  /** Vrai si le PO a réécrit la story : le verdict du juge porte sur la version de l'agent. */
  modifiee: boolean;
  /** Preuves sûres arrivées depuis la rédaction : la story ne les a pas lues. */
  preuvesDepuisRedaction: number;
  /** La proposition « Story à valider » en attente, pour valider depuis l'onglet Stories. */
  propositionValidation: string | null;
}

/** POST /api/stories/:id/modifier : le PO réécrit une story (les citations et la taille restent celles de l'agent). */
export interface ModificationStoryApi {
  enTantQue: string;
  jeVeux: string;
  afinDe: string;
  criteres: Array<{ etantDonne: string; quand: string; alors: string }>;
  casLimites: string[];
}

/** GET /api/items/:id */
export interface DetailItemApi {
  ligne: LigneClassement | null;
  description: string | null;
  preuves: PreuveApi[];
  justificationImpact: string | null;
  /** Valeur du tirage dont la justification est affichée : elle peut différer de la médiane sur un jugement ancien. */
  valeurJustificationImpact: number | null;
  historique: Array<{ calculeLe: string; score: number }>;
  story: StoryApi | null;
  /** Les stories en vigueur de l'élément : une seule, ou plusieurs après un découpage accepté. */
  stories: StoryApi[];
  /** Un découpage proposé par l'agent, que le PO n'a pas encore tranché. */
  decoupage: { propositionId: string; storyId: string; justification: string | null; enfants: StoryApi[] } | null;
  /** Stories dont le découpage, demandé par le PO, est en cours dans la file. */
  decoupageEnCours: string[];
}

/** GET /api/feedbacks?limite=60 */
export interface FeedbackApi {
  id: string;
  compte: { id: string; nom: string; plan: Plan; mrr: number; risqueDepart: boolean };
  canal: "email" | "ticket" | "commentaire" | "direct";
  recuLe: string;
  texte: string;
  statut: "recu" | "extrait" | "suspect" | "en_attente" | "traite";
  nature: string | null;
  menaceDepart: boolean;
  items: string[];
}

/** Le client qui a écrit. */
export interface CompteApi {
  id: string;
  nom: string;
  plan: Plan;
  mrr: number;
  risqueDepart: boolean;
}

/** GET /api/feedbacks/:id : le message complet, et ce que l'agent en a fait. */
export interface FicheFeedbackApi {
  id: string;
  texte: string;
  canal: "email" | "ticket" | "commentaire" | "direct";
  recuLe: string;
  statut: "recu" | "extrait" | "suspect" | "en_attente" | "traite";
  compte: CompteApi;
  nature: string | null;
  menaceDepart: boolean;
  /** Les demandes que l'agent a lues dans le message (résumé et citation exacte). */
  demandes: Array<{ resume: string; citation: string; regression: boolean }>;
  /** Où ces demandes comptent : item, preuve sûre ou en attente de votre réponse, règle appliquée. */
  rattachements: Array<{ itemId: string; titre: string; sure: boolean; regleId: string | null }>;
}

/** Une réponse possible, avec ce qu'elle déclenche. */
export interface OptionQuestionApi {
  valeur: string;
  libelle: string;
  /** Ce que fait ce choix, en une phrase. */
  effet: string;
}

/** GET /api/questions (questions posées, ouvertes ou relancées) ; POST /api/questions/:id/reponse { choix } */
export interface QuestionApi {
  id: string;
  type: "rattachement" | "fusion" | "impact" | "requalification";
  enonce: string;
  options: OptionQuestionApi[];
  contexte: Record<string, unknown>;
  urgente: boolean;
  etat: "ouverte" | "relancee" | "repondue" | "expiree";
  poseeLe: string | null;
  /** Ce que la réponse peut faire bouger : gain de score maximal d'un item (rattachement, vue de référence) ou écart en crans (Impact). */
  enjeu: number;
  /** Rattachement : le message d'origine, en entier, avec le client. */
  feedback: FicheFeedbackApi | null;
  /** Les éléments du backlog en jeu, pour juger sans ouvrir d'autre écran. */
  items: Array<{ id: string; titre: string; description: string | null; preuvesSures: number }>;
  /** Rattachement : ce que chaque lecture de l'agent a conclu (null si elles n'ont pas été conservées). */
  lectures: Array<{ itemId: string | null; titre: string | null; verdict: string; justification: string }> | null;
  /** Fusion : l'explication de l'agent. Impact : sa justification. */
  explication: string | null;
  /** Impact : quelques verbatims comptés sur l'item. */
  verbatims: string[];
}

/** Ce qu'il faut voir pour décider d'une proposition, selon son type. */
export type DetailsPropositionApi =
  | { type: "nouvel_item"; item: { id: string; titre: string; type: string }; sources: Array<{ feedbackId: string; compte: CompteApi; nature: string | null; citation: string; texte: string }> }
  | {
      type: "regle";
      regle: { id: string; texte: string; motsCles: string[]; itemId: string | null; itemTitre: string | null };
      origine: { question: string; citation: string | null; resume: string | null; feedbackId: string | null; choix: string } | null;
      /** L'aperçu de la doctrine, résumé : ce que la règle ferait, ce qui bloquerait sa validation, les règles proches. */
      apercu: { resume: string; bloquante: boolean; blocages: string[]; proches: string[] } | null;
    }
  | { type: "ordre_backlog"; vue: string; mouvements: Array<{ itemId: string; titre: string; avant: number | null; apres: number | null }> }
  | { type: "story_prete" | "export_jira"; story: { id: string; itemId: string; itemTitre: string; controlesOk: number; controlesTotal: number; jugeOui: number; jugeTotal: number; criteresNon: string[]; commentaire: string | null } }
  | {
      /** Le découpage d'une story refusée par le juge, en stories plus petites, chacune jugée. */
      type: "decoupage";
      storyId: string;
      itemId: string;
      itemTitre: string;
      justification: string | null;
      enfants: Array<{ id: string; enTantQue: string; jeVeux: string; complexite: string; jugeOui: number; jugeTotal: number; criteresNon: string[] }>;
    }
  | {
      /** La taille estimée par la rédaction d'une story, proposée au PO au lieu d'être imposée. */
      type: "effort";
      itemId: string;
      itemTitre: string;
      avant: string;
      apres: string;
      storyId: string | null;
      scoreAvant: number | null;
      scoreApres: number | null;
      /** « rang 4 », ou « candidat, se placerait au rang 4 ». */
      rangAvant: string | null;
      rangApres: string | null;
    }
  | { type: "autre" };

/** GET /api/propositions ; POST /api/propositions/:id/decision { accepter } */
export interface PropositionApi {
  id: string;
  type: string;
  resume: string;
  charge: Record<string, unknown>;
  statut: "en_attente" | "acceptee" | "refusee" | "expiree";
  creeeLe: string;
  /** Ce que la proposition change, et ce qu'accepter déclenche. */
  effet: string;
  details: DetailsPropositionApi;
}

/** GET /api/produit : le produit fictif du scénario, pour juger les demandes. */
export interface ProduitApi {
  nom: string;
  activite: string;
  objectifTrimestre: string;
  dateScenario: string;
  /** D'où viennent ces informations (le scénario, à valider par l'humain). */
  source: string;
  comptes: Array<{ plan: Plan; nombre: number; mrrTotal: number; mrrMin: number; mrrMax: number }>;
  mrrTotal: number;
  itemsBacklog: number;
  feedbacks: { total: number; parCanal: Record<string, number> };
}

/** GET /api/regles : la doctrine produit */
export interface RegleApi {
  id: string;
  version: number;
  texte: string;
  contenu: Record<string, unknown>;
  statut: "proposee" | "active" | "rejetee" | "retiree";
  sourceReponseId: string;
  creeeLe: string;
  valideeLe: string | null;
  /** Date du retrait par le PO (journal), ou null. */
  retireeLe: string | null;
  /** Nombre de décisions qui ont cité cette règle. */
  citations: number;
  /** Mots-clés qui déclenchent la règle de rattachement, sans lecture par le modèle ni question (vide pour les autres types). */
  motsCles: string[];
  /** Les éléments visés, avec leurs titres : un pour un rattachement, deux pour une paire distincte. */
  elements: ElementRegleApi[];
  /** Le cas d'origine : la question, la demande et la réponse du PO dont la règle est née. */
  origine: OrigineRegleApi | null;
}

export type StatutRegleApi = RegleApi["statut"];

export interface ElementRegleApi {
  id: string;
  titre: string;
}

export interface OrigineRegleApi {
  reponseId: string;
  questionId: string;
  /** L'énoncé de la question posée au PO. */
  question: string;
  resume: string | null;
  citation: string | null;
  feedbackId: string | null;
  choix: string;
  /** La réponse du PO en clair : le titre de l'élément choisi, ou le libellé de l'option. */
  choixLibelle: string;
  repondueLe: string;
}

/**
 * GET /api/regles/:id/apercu : ce que ferait la règle si elle était active, parmi les règles actives.
 * Calculé par le code sur les demandes déjà reçues. Les rattachements déjà faits ne bougent pas.
 */
export interface ApercuRegleApi {
  regleId: string;
  version: number;
  statut: StatutRegleApi;
  type: "rattachement" | "paire_distincte" | "ajustement_impact";
  motsCles: string[];
  elements: ElementRegleApi[];
  /** Nombre de demandes déjà reçues rejouées (messages mis en quarantaine exclus). */
  demandesLues: number;
  /** Les demandes que la règle rattacherait à son élément, les changements d'élément en premier. */
  captees: Array<{
    feedbackId: string;
    resume: string;
    citation: string;
    /** Où la demande compte aujourd'hui, ou null si elle n'a pas de preuve propre. */
    actuel: { element: ElementRegleApi; sure: boolean; regleId: string | null } | null;
    changerait: boolean;
  }>;
  changements: number;
  /** Demandes que la règle toucherait mais qu'une autre règle active envoie ailleurs : aucune règle ne s'appliquerait, le modèle les lirait. */
  ambigues: Array<{ feedbackId: string; resume: string; citation: string; concurrentes: Array<{ regleId: string; element: ElementRegleApi }> }>;
  /** Contradictions avec la doctrine active, en clair. Elles empêchent la validation. */
  contradictions: Array<{ regleId: string; texte: string; message: string }>;
  /** Cas d'origine que la règle casserait (non-régression). Ils empêchent la validation. */
  casCasses: Array<{ regleId: string; propre: boolean; demande: string; attendu: ElementRegleApi; obtenu: ElementRegleApi | null; message: string }>;
  /** Règles actives ou proposées qui visent le même élément avec des mots-clés qui se recouvrent. */
  proches: Array<{ regleId: string; version: number; statut: StatutRegleApi; texte: string; motsCles: string[]; recouvrements: string[]; message: string }>;
  /** Vrai si « Valider » serait refusé (contradiction ou cas d'origine cassé). */
  bloquante: boolean;
  /** « Si vous validez : N demandes déjà reçues seraient rattachées à « X », dont M changeraient d'élément. » */
  resume: string;
}

/**
 * POST /api/regles/:id/retirer : le PO retire une règle active (journalisé avant l'écriture).
 * Les rattachements déjà faits restent ; les nouveaux feedbacks ne l'appliquent plus.
 */
export interface RetraitRegleApi {
  statut: "retiree";
  version: number;
}

/** GET /api/alertes */
export interface AlerteApi {
  id: number;
  type: string;
  message: string;
  urgente: boolean;
  creeeLe: string;
  /** Ce que l'alerte concerne : un item ou un feedback, à ouvrir d'un clic. */
  cible: { type: "item" | "feedback"; id: string } | null;
}

/** GET /api/journal?limite=100 */
export interface EntreeJournalApi {
  id: number;
  acteur: "agent" | "po" | "systeme";
  action: string;
  cible: string | null;
  details: Record<string, unknown>;
  reglesCitees: string[];
  horodatage: string;
}

/** GET /api/moscow?filtres=mrr */
export type CategorieMoscow = "must" | "should" | "could" | "wont";

export interface MoscowApi {
  capacite: number;
  propositions: Array<{ itemId: string; titre: string; categorie: CategorieMoscow; raison: string; effort: number; score: number }>;
  /**
   * Dernier découpage validé par le PO (POST /api/moscow/valider { filtres?, ajustements? }), ou null.
   * `categories` fige tout le découpage au moment de la validation ; seuls les items de `deplaces`
   * ont été tranchés par le PO contre la proposition de l'agent. Pour les autres, la proposition actuelle fait foi.
   */
  valide: {
    decideLe: string;
    categories: Record<string, CategorieMoscow>;
    /** Items que le PO a placés ailleurs que la proposition de l'agent, au moment de la validation. */
    deplaces: string[];
    /** Vue dans laquelle le découpage a été validé. */
    filtres: FiltreVue[];
  } | null;
}

/** GET /api/backlog-officiel?filtres=… : l'ordre validé par le PO, comparé à l'ordre que propose l'agent. */
export interface LigneOfficielle {
  rang: number;
  itemId: string;
  titre: string;
  /** Rang de cet item dans l'ordre proposé par l'agent (vue de référence). */
  rangPropose: number | null;
  score: number | null;
}

/** POST /api/conversation { message, historique? } : question libre du PO à l'agent (outils en lecture seule). */
export interface ReponseConversationApi {
  reponse: string;
  outils: string[];
}

/** GET /api/sante : indicateurs de succès de l'agent */
export interface SanteApi {
  /** Propositions de l'agent acceptées / décidées (la validation MoSCoW, faite par le PO lui-même, n'en fait pas partie). */
  tauxAcceptation: number | null;
  tauxCorrection: number | null;
  /** Entre la création d'une question et la réponse du PO, les deux instants pris sur l'horloge de la base. */
  delaiDecisionMinutes: number | null;
  /** Les effectifs derrière chaque taux, pour lire « 2 sur 2 » et non un pourcentage nu. */
  effectifs: {
    acceptees: number;
    decidees: number;
    corrections: number;
    reponses: number;
    /** Corrections faites par le PO lui-même (effort, rattachement, texte d'une story), comptées aussi dans `corrections`. */
    correctionsDirectes: number;
    /** Réponses dont le délai a pu être mesuré. */
    delaisMesures: number;
  };
  alertesParJour: number;
  partAlertesIgnorees: number | null;
  appelsLLM: { total: number; echecs: number; dureeMoyenneMs: number | null; tokensEntree: number; tokensSortie: number };
}

/** GET /api/flux : flux d'événements (Server-Sent Events). Chaque message : { type, donnees }. */
export type TypeEvenementApi = "feedback" | "classement" | "alerte" | "question" | "proposition" | "regle" | "story" | "journal";

/**
 * Autres routes :
 * POST /api/simulateur/suivant   → injecte le prochain feedback « direct » ; renvoie { id } ou { id: null } s'il n'y en a plus
 * POST /api/feedbacks            → { compteId, canal, texte } : connecteur générique ; renvoie { id, statut: "ajoute" | "doublon" }
 * POST /api/regles/:id/decision  → { accepter } ; renvoie { statut, contradictions }
 * POST /api/fusions/:itemId/defaire → défait la fusion de cet item ; renvoie { preuvesRendues }
 * POST /api/agent-de-fond/passage → déclenche un passage de l'agent de fond ; renvoie { fusions, regles, resume }
 */
