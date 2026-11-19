/**
 * Accès typé à l'API du cockpit. Les types viennent du contrat de l'API (import de type uniquement).
 */
import type {
  AlerteApi,
  FicheFeedbackApi,
  ProduitApi,
  DetailItemApi,
  EntreeJournalApi,
  EtatApi,
  FeedbackApi,
  FiltreVue,
  LigneClassement,
  LigneOfficielle,
  MoscowApi,
  PropositionApi,
  QuestionApi,
  RegleApi,
  ReponseConversationApi,
  SanteApi,
  TypeEvenementApi,
} from "../../api/src/contrat.ts";
import type { ApercuRegleApi, ModificationStoryApi, RetraitRegleApi } from "../../api/src/contrat.ts";

export type {
  CompteApi,
  DetailsPropositionApi,
  FicheFeedbackApi,
  OptionQuestionApi,
  ProduitApi,
  LigneOfficielle,
  ReponseConversationApi,
  AlerteApi,
  DetailItemApi,
  EntreeJournalApi,
  EtatApi,
  FeedbackApi,
  FiltreVue,
  LigneClassement,
  MoscowApi,
  Plan,
  PreuveApi,
  PropositionApi,
  QuestionApi,
  RegleApi,
  SanteApi,
  SegmentApi,
  StoryApi,
  TypeEvenementApi,
} from "../../api/src/contrat.ts";
export type { ApercuRegleApi, ElementRegleApi, ModificationStoryApi, OrigineRegleApi, RetraitRegleApi } from "../../api/src/contrat.ts";

/** Erreur d'appel à l'API. `statut` vaut null quand le réseau ou le proxy n'a pas répondu. */
export class ErreurApi extends Error {
  readonly statut: number | null;
  constructor(message: string, statut: number | null) {
    super(message);
    this.name = "ErreurApi";
    this.statut = statut;
  }
  /** L'API ne répond pas (réseau coupé, proxy en erreur, serveur en redémarrage). */
  get injoignable(): boolean {
    return this.statut === null || this.statut === 502 || this.statut === 503 || this.statut === 504;
  }
}

async function requete<T>(chemin: string, init?: RequestInit): Promise<T> {
  let reponse: Response;
  try {
    reponse = await fetch(chemin, { ...init, headers: { Accept: "application/json", ...(init?.headers ?? {}) } });
  } catch {
    throw new ErreurApi("API injoignable", null);
  }
  const texte = await reponse.text();
  let corps: unknown = null;
  if (texte) {
    try {
      corps = JSON.parse(texte);
    } catch {
      corps = null;
    }
  }
  if (!reponse.ok) {
    const champ = (cle: string): string | null => {
      const v = corps && typeof corps === "object" ? (corps as Record<string, unknown>)[cle] : null;
      return typeof v === "string" && v ? v : null;
    };
    // Erreurs métier de l'API : { erreur } ; erreurs de Fastify : { message }.
    const message = champ("erreur") ?? champ("message") ?? `Erreur ${reponse.status}`;
    throw new ErreurApi(message, reponse.status);
  }
  return corps as T;
}

function lire<T>(chemin: string): Promise<T> {
  return requete<T>(chemin);
}

/** POST avec corps JSON. Sans corps, aucun Content-Type n'est envoyé (Fastify refuse un corps JSON vide). */
function envoyer<T>(chemin: string, corps?: unknown): Promise<T> {
  if (corps === undefined) return requete<T>(chemin, { method: "POST" });
  return requete<T>(chemin, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps) });
}

/** Accepte un tableau nu ou un objet qui enveloppe un tableau. */
function liste<T>(brut: unknown): T[] {
  if (Array.isArray(brut)) return brut as T[];
  if (brut && typeof brut === "object") {
    const tableau = Object.values(brut).find(Array.isArray);
    if (tableau) return tableau as T[];
  }
  return [];
}

function avecFiltres(chemin: string, filtres: FiltreVue[]): string {
  return filtres.length > 0 ? `${chemin}?filtres=${filtres.join(",")}` : chemin;
}

export const api = {
  etat: () => lire<EtatApi>("/api/etat"),
  feedbacks: (limite = 60) => lire<unknown>(`/api/feedbacks?limite=${limite}`).then((x) => liste<FeedbackApi>(x)),
  feedback: (id: string) => lire<FicheFeedbackApi>(`/api/feedbacks/${encodeURIComponent(id)}`),
  produit: () => lire<ProduitApi>("/api/produit"),
  classement: (filtres: FiltreVue[]) => lire<unknown>(avecFiltres("/api/classement", filtres)).then((x) => liste<LigneClassement>(x)),
  item: (id: string, filtres: FiltreVue[]) => lire<DetailItemApi>(avecFiltres(`/api/items/${encodeURIComponent(id)}`, filtres)),
  backlogOfficiel: (filtres: FiltreVue[]) => lire<unknown>(avecFiltres("/api/backlog-officiel", filtres)).then((x) => liste<LigneOfficielle>(x)),
  moscow: (filtres: FiltreVue[]) => lire<MoscowApi>(avecFiltres("/api/moscow", filtres)),
  validerMoscow: (filtres: FiltreVue[], ajustements: Record<string, MoscowApi["propositions"][number]["categorie"]>) =>
    envoyer<{ id: string }>("/api/moscow/valider", { filtres: filtres.join(","), ajustements }),
  regles: () => lire<unknown>("/api/regles").then((x) => liste<RegleApi>(x)),
  journal: (limite = 100) => lire<unknown>(`/api/journal?limite=${limite}`).then((x) => liste<EntreeJournalApi>(x)),
  sante: () => lire<SanteApi>("/api/sante"),
  questions: () => lire<unknown>("/api/questions").then((x) => liste<QuestionApi>(x)),
  propositions: () => lire<unknown>("/api/propositions").then((x) => liste<PropositionApi>(x)),
  alertes: () => lire<unknown>("/api/alertes").then((x) => liste<AlerteApi>(x)),

  simulateurSuivant: () => envoyer<{ id: string | null }>("/api/simulateur/suivant"),
  defaireFusion: (itemId: string) => envoyer<{ preuvesRendues: number }>(`/api/fusions/${encodeURIComponent(itemId)}/defaire`),
  /** La conversation raisonne sur la vue affichée : ses rangs et ses scores sont ceux de l'écran. */
  converser: (message: string, historique: Array<{ role: "user" | "assistant"; texte: string }>, filtres: FiltreVue[]) =>
    envoyer<ReponseConversationApi>("/api/conversation", { message, historique, filtres: filtres.join(",") }),
  passageDeFond: () => envoyer<{ fusions: number; regles: number; resume: string }>("/api/agent-de-fond/passage"),
  repondreQuestion: (id: string, choix: string) =>
    envoyer<{ reponseId?: string; regleProposee?: { id: string; texte: string } | null; itemCree?: string | null; reglePrevue?: boolean }>(`/api/questions/${encodeURIComponent(id)}/reponse`, { choix }),
  /** `portee: "top"` : pour un ordre du backlog, n'accepter que le haut du classement proposé. */
  deciderProposition: (id: string, accepter: boolean, portee?: "top") =>
    envoyer<{ ok?: boolean }>(`/api/propositions/${encodeURIComponent(id)}/decision`, portee ? { accepter, portee } : { accepter }),
  deciderRegle: (id: string, accepter: boolean) =>
    envoyer<{ statut: string; contradictions: unknown }>(`/api/regles/${encodeURIComponent(id)}/decision`, { accepter }),
  /** Ce que ferait la règle si elle était active : demandes captées, contradictions, cas d'origine cassés, règles proches. */
  apercuRegle: (id: string) => lire<ApercuRegleApi>(`/api/regles/${encodeURIComponent(id)}/apercu`),
  /** Retire une règle active : les rattachements déjà faits restent, les nouveaux feedbacks ne l'appliquent plus. */
  retirerRegle: (id: string) => envoyer<RetraitRegleApi>(`/api/regles/${encodeURIComponent(id)}/retirer`),
  // Le PO corrige (audit du 15/11/2026). Des écritures du cockpit seulement : le serveur MCP n'en expose aucune.
  corrigerEffort: (itemId: string, taille: string) => envoyer<{ avant: string; apres: string }>(`/api/items/${encodeURIComponent(itemId)}/effort`, { taille }),
  /** `itemId` : l'élément visé, ou « ignorer » pour retirer le verbatim de tout score. */
  rattacherPreuve: (preuveId: string, itemId: string) => envoyer<{ avant: string; apres: string }>(`/api/preuves/${encodeURIComponent(preuveId)}/rattacher`, { itemId }),
  modifierStory: (id: string, m: ModificationStoryApi) => envoyer<{ ok: boolean }>(`/api/stories/${encodeURIComponent(id)}/modifier`, m),
  /** Le découpage part dans la file de l'agent : la proposition arrive par le flux. */
  decouperStory: (id: string) => envoyer<{ enFile: boolean }>(`/api/stories/${encodeURIComponent(id)}/decouper`),
};

/** Message du flux SSE : { type, donnees }. */
export interface EvenementFlux {
  type: TypeEvenementApi;
  donnees: unknown;
}

export function messageErreur(e: unknown): string {
  if (e instanceof ErreurApi) return e.injoignable ? "API injoignable" : e.message;
  return e instanceof Error ? e.message : String(e);
}
