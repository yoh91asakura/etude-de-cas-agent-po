import type { Complexite, Extraction, ItemBacklog, NatureFeedback, Story, ValeurImpact } from "@po-agent/domain";
import type { CandidatItem, DemandeARattacher, EntreeDecoupage, EntreeImpact, EtatRevue, FournisseurLLM, ImpactLLM, MessageConversation, OutilConversation, ReponseConversation, ResultatRevue, VerdictLLM } from "./fournisseur.ts";
import type { JugementStory } from "./schemas.ts";

/**
 * FAUX FOURNISSEUR : il fait tourner la chaîne sans clé d'API, par simples mots-clés.
 * Il sert à tester la plomberie et à montrer l'interface. Ses résultats ne comptent JAMAIS comme évaluation.
 */

/** Mots-clés par item du backlog de démo (voir donnees/verite-terrain.md). */
export const MOTS_CLES_DEMO: Record<string, RegExp> = {
  B01: /gantt|timeline|planning visuel|diagramme de planning|frise|chronolog/i,
  B02: /permission|droits? (d'accès )?par projet|rôles? par projet|lecture seule|invité|prestataire/i,
  B03: /\bsso\b|saml|okta|entra|connexion unique/i,
  B04: /sombre|dark/i,
  B05: /\bteams\b/i,
  B06: /excel|xlsx/i,
  B07: /champs? personnalis/i,
  B08: /récurren|recurren|répét/i,
  B09: /modèles? de projet|template/i,
  B10: /notification|mobile|push/i,
  B11: /journal d'audit|audit|historique des modifications/i,
  B12: /webhook|\bapi\b/i,
  B13: /trello|import/i,
  B14: /charge de travail|capacité|surcharg/i,
  B15: /portefeuille|portfolio|multi-projets/i,
  B16: /suivi du temps|temps passé|timesheet|chrono/i,
  B17: /hors ligne|offline/i,
  B18: /sous-tâche/i,
  B19: /recherche|retrouver/i,
  B20: /rappel/i,
};

const FORMULE_POLITESSE = /^(bonjour|bonsoir|hello|hi|salut|madame|monsieur|cher|chère|hey)\b[^.!?\n]{0,40}[,!.]?$/i;

/**
 * Phrase citée, recopiée telle quelle : la première qui contient un mot-clé connu,
 * sinon la première phrase utile (formules de politesse ignorées).
 */
function phraseCitee(texte: string, motsCles: RegExp[]): string {
  const phrases = texte.split(/(?<=[.!?\n])\s+|\n+/).map((s) => s.trim());
  const utiles = phrases.filter((s) => s.length >= 12 && !FORMULE_POLITESSE.test(s));
  const morceau = utiles.find((s) => motsCles.some((r) => r.test(s))) ?? utiles[0] ?? phrases.find((s) => s.length >= 3) ?? texte;
  return morceau.slice(0, 200);
}

export class FournisseurFaux implements FournisseurLLM {
  readonly nom = "faux (démo sans clé : résultats non évalués)";

  constructor(private readonly motsCles: Record<string, RegExp> = MOTS_CLES_DEMO) {}

  async extraire(feedback: { id: string; texte: string }): Promise<Extraction> {
    const t = feedback.texte;
    const injection = /ignore[rz]? (tes|vos|les) (instructions|consignes)|priorité 1 du backlog/i.test(t);
    const regression = /marchait (avant|bien)|fonctionnait avant|depuis la (dernière )?mise à jour/i.test(t);
    const menaceDepart = /\b(partir|résilier|pas renouveler|ne renouvellerons|changer d'outil|concurren)/i.test(t);
    const demande = /(j'aimerais|aimerions|ce serait bien|pourriez|il faudrait|svp|s'il vous plaît|besoin|possible d|manque|souhait)/i.test(t);
    const bug = regression || /\b(bug|ne marche|plante|erreur|perd)\b/i.test(t);
    let nature: NatureFeedback;
    if (injection) nature = "suspect";
    else if (bug) nature = "bug";
    else if (demande || Object.values(this.motsCles).some((r) => r.test(t))) nature = "demande";
    else if (/(merci|bravo|super|génial|top)/i.test(t)) nature = "compliment";
    else if (/(facture|paiement|tarif|abonnement)/i.test(t)) nature = "question";
    else nature = "bruit";
    const avecDemande = nature === "demande" || nature === "bug";
    const citation = phraseCitee(t, Object.values(this.motsCles));
    return {
      feedbackId: feedback.id,
      nature,
      injectionSuspectee: injection,
      menaceDepart,
      demandes: avecDemande ? [{ resume: citation.length > 70 ? `${citation.slice(0, 67)}…` : citation, citation, regression }] : [],
    };
  }

  async jugerRattachement(demande: DemandeARattacher, candidats: CandidatItem[]): Promise<VerdictLLM> {
    const texte = `${demande.resume} ${demande.citation}`;
    const touches = candidats.filter((c) => this.motsCles[c.id]?.test(texte));
    if (touches.length === 1) return { itemId: touches[0]!.id, verdict: "meme_besoin", alternatives: [], justification: "Mots-clés (faux fournisseur)" };
    if (touches.length > 1) return { itemId: null, verdict: "incertain", alternatives: touches.map((c) => c.id), justification: `Plusieurs candidats : ${touches.map((c) => c.id).join(", ")}` };
    return { itemId: null, verdict: "different", alternatives: [], justification: "Aucun mot-clé reconnu (faux fournisseur)" };
  }

  async jugerImpact(entree: EntreeImpact, _tirage = 0): Promise<ImpactLLM> {
    const texte = entree.citations.join(" ");
    let impact: ValeurImpact = 1;
    if (/partir|renouvel|bloqu|impossible/i.test(texte)) impact = 3;
    else if (/client|prestataire|équipe|sécurité/i.test(texte)) impact = 2;
    else if (/sombre|couleur|joli/i.test(texte)) impact = 0.5;
    return { impact, justification: "Heuristique de mots-clés (faux fournisseur)", citations: entree.citations.slice(0, 2) };
  }

  async estimerComplexite(item: Pick<ItemBacklog, "titre">): Promise<{ complexite: Complexite; justification: string }> {
    const complexite: Complexite = /export|sombre|rappel|modèle/i.test(item.titre) ? "S" : "M";
    return { complexite, justification: "Estimation par défaut (faux fournisseur)" };
  }

  async redigerStory(entree: { item: ItemBacklog; citations: string[] }): Promise<Story> {
    const titre = entree.item.titre.toLowerCase();
    return {
      itemId: entree.item.id,
      enTantQue: "utilisateur d'un espace de travail",
      jeVeux: `disposer de : ${titre}`,
      afinDe: "travailler sans contournement",
      criteres: [
        { etantDonne: "un espace de travail configuré", quand: `j'utilise la fonction « ${titre} »`, alors: "le résultat attendu s'affiche" },
        { etantDonne: "un utilisateur sans droit d'administration", quand: "il tente de modifier la configuration", alors: "l'action est refusée" },
      ],
      casLimites: ["Espace de travail vide"],
      complexite: entree.item.complexite,
      citations: entree.citations.slice(0, 3),
    };
  }

  /** Découpage factice et déterministe : les critères de la story d'origine répartis en deux stories. */
  async decouperStory(entree: EntreeDecoupage): Promise<{ stories: Story[]; justification: string }> {
    const s = entree.story;
    const plusPetite: Record<Complexite, Complexite> = { S: "S", M: "S", L: "M", XL: "L" };
    const moitie = Math.ceil(s.criteres.length / 2);
    const generique = { etantDonne: "un espace de travail configuré", quand: "la fonction est utilisée", alors: "le résultat attendu s'affiche" };
    const part = (criteres: Story["criteres"], n: number): Story => ({
      ...s,
      jeVeux: `${s.jeVeux} (partie ${n})`,
      criteres: criteres.length >= 2 ? criteres : [...criteres, generique].slice(0, 2),
      complexite: plusPetite[s.complexite],
      citations: s.citations.slice(0, 2),
    });
    return {
      stories: [part(s.criteres.slice(0, moitie), 1), part(s.criteres.slice(moitie), 2)],
      justification: "Découpage factice (faux fournisseur) : les critères répartis en deux.",
    };
  }

  async jugerStory(): Promise<JugementStory> {
    return { independante: true, valeur: true, estimable: true, petite: true, testable: true, un_seul_besoin: true, commentaire: "Jugement factice (faux fournisseur)" };
  }

  /**
   * Conversation factice : un aiguillage par mots, qui appelle les vrais outils et recopie leur résultat.
   * Elle montre la plomberie (outils, journal) sans raisonnement.
   */
  async converser(entree: { message: string; historique: MessageConversation[]; outils: OutilConversation[] }): Promise<ReponseConversation> {
    const outils = new Map(entree.outils.map((o) => [o.nom, o]));
    const appels: ReponseConversation["appels"] = [];
    const appeler = async (nom: string, args: Record<string, unknown>) => {
      const o = outils.get(nom);
      if (!o) return "";
      const valide = o.schema.safeParse(args);
      if (!valide.success) return "";
      appels.push({ outil: nom, entree: valide.data });
      return o.executer(valide.data);
    };
    const id = entree.message.match(/\b([BN]\d{2,3})\b/)?.[1];
    let corps: string;
    if (id && /et si|si on|simul/i.test(entree.message)) {
      const impact = entree.message.match(/impact\s*(?:à|de|=)?\s*(0[.,]25|0[.,]5|1|2|3)\b/i)?.[1]?.replace(",", ".");
      corps = await appeler("simuler", { item_id: id, ...(impact ? { impact } : {}) });
    } else if (id) {
      corps = await appeler("detail_item", { item_id: id });
    } else if (/doctrine|règle/i.test(entree.message)) {
      corps = await appeler("doctrine", {});
    } else {
      corps = await appeler("classement", { limite: 5, ...(/mrr|revenu/i.test(entree.message) ? { filtres: ["mrr"] } : {}) });
    }
    const lisible = corps.replace(/<(verbatim|feedback|citation)>\n?/g, "« ").replace(/\n?<\/(verbatim|feedback|citation)>/g, " »");
    return { texte: `(Réponse factice, sans raisonnement : voici ce que renvoie l'outil.)\n${lisible}`, appels };
  }

  /** Revue factice : propose de fusionner un item créé par l'agent avec un item existant qui partage ses mots-clés. */
  async revueDeFond(etat: EtatRevue): Promise<ResultatRevue> {
    const fusions: ResultatRevue["fusions"] = [];
    for (const cree of etat.items.filter((i) => i.creeParAgent)) {
      const texte = `${cree.titre} ${cree.verbatims.join(" ")}`;
      const existant = etat.items.find((i) => !i.creeParAgent && this.motsCles[i.id]?.test(texte));
      if (existant) fusions.push({ itemA: existant.id, itemB: cree.id, explication: "Mots-clés communs (faux fournisseur)" });
    }
    return { fusions, regles: [] };
  }

  async formulerRegleRattachement(entree: { citation: string; itemChoisi: CandidatItem; itemsEcartes: CandidatItem[] }): Promise<{ motsCles: string[]; texte: string }> {
    const motif = this.motsCles[entree.itemChoisi.id];
    const trouves = motif ? [...entree.citation.matchAll(new RegExp(motif.source, "gi"))].map((m) => m[0].toLowerCase()) : [];
    const motsCles = [...new Set(trouves)].slice(0, 5);
    const ecartes = entree.itemsEcartes.map((c) => c.titre).join(", ");
    return {
      motsCles: motsCles.length > 0 ? motsCles : [entree.itemChoisi.titre.toLowerCase()],
      texte: `Les demandes qui mentionnent ${motsCles.join(", ") || entree.itemChoisi.titre} relèvent de « ${entree.itemChoisi.titre} »${ecartes ? `, pas de « ${ecartes} »` : ""}.`,
    };
  }
}
