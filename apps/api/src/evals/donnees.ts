/**
 * Données du banc des prompts : vérité terrain, textes des feedbacks, backlog du scénario et fichiers de cas.
 * Chaque fichier de cas est contrôlé au chargement : un feedback inconnu, un extrait qui ne figure pas mot pour mot
 * ou une réponse simulée contraire à la vérité terrain arrête le banc avant tout appel au modèle.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { citationVerifiee, PARAMETRES, type Feedback, type ItemBacklog, type Story } from "@po-agent/domain";
import { DOSSIER_SEED, RACINE } from "../config.ts";
import { attendusParFeedback, CRITERES_JUGE, type CritereJuge, type VeriteTerrain } from "./verifications.ts";

export const DOSSIER_CAS = path.join(RACINE, "evals", "cas");

export interface EnTeteCas {
  statut: "propose_par_ia" | "valide";
  proposePar: string;
  validePar: string | null;
  valideLe: string | null;
  etape: string;
  objet: string;
  provenance: string;
}

export interface CasParaphrases extends EnTeteCas {
  cas: Array<{ id: string; feedbackId: string; paraphrase: string; attendus?: { menaceDepart?: boolean; injection?: boolean } }>;
}

export interface CasConversation extends EnTeteCas {
  cas: Array<{
    id: string;
    question: string;
    outils?: string[];
    doitCiterLeTop?: { filtres: Array<"mrr" | "objectif">; n: number };
    doitMentionnerUnDe?: string[];
    doitCiterLeRangSimule?: { itemId: string; impact: string; filtres: Array<"mrr" | "objectif"> };
    doitDire?: string;
    demandeUneEcriture?: boolean;
  }>;
}

export interface CasRegles extends EnTeteCas {
  tolerance: { capturesHorsItemMax: number };
  cas: Array<{ id: string; feedbackId: string; resume: string; citation: string; itemChoisi: string; itemsEcartes: string[] }>;
}

export interface CasRevue extends EnTeteCas {
  itemsCreesParAgent: Array<{ id: string; titre: string; verbatims: Array<{ feedbackId: string; extrait: string }> }>;
  reponsesPO: Array<{ id: string; enonce: string; choix: string; feedbackId: string; resume: string; citation: string }>;
}

interface Libelle {
  titre: string;
  citations?: string[];
  description?: string;
}

export interface CasImpact extends EnTeteCas {
  tolerance: { paraphraseCransMax: number };
  paires: Array<{ id: string; fort: Libelle; faible: Libelle }>;
  paraphrases: Array<{ id: string; itemId: string; cas: string[] }>;
}

export interface CasComplexite extends EnTeteCas {
  repetitions: number;
  paires: Array<{ id: string; petit: Libelle; grand: Libelle }>;
}

/** Bornes du nombre d'extraits par élément dans les cas de rédaction de story. */
export const VERBATIMS_PAR_STORY = { min: 2, max: 4 };

export interface CasStories extends EnTeteCas {
  /** Un élément réel du backlog et des extraits mot pour mot de feedbacks que la vérité terrain lui rattache. */
  cas: Array<{ id: string; itemId: string; verbatims: Array<{ feedbackId: string; extrait: string }> }>;
}

export interface CasJuge extends EnTeteCas {
  /** Nombre d'appels au juge par story, pour mesurer la stabilité de ses verdicts. */
  appels: number;
  /** Stories écrites à la main. Les attendus ne portent que sur les critères évidents. */
  stories: Array<{ id: string; nature: "saine" | "defectueuse"; attendus: Partial<Record<CritereJuge, boolean>>; story: Story }>;
}

export interface DonneesEval {
  verite: VeriteTerrain;
  /** Item attendu par feedback (id du backlog, étiquette d'item nouveau, ou null). */
  attendus: Map<string, string | null>;
  /** Feedbacks du jeu (six semaines) et du direct de la démo, par identifiant. */
  textes: Map<string, Feedback>;
  items: Array<ItemBacklog & { description?: string }>;
  idsBacklog: Set<string>;
  /** Feedbacks dont la vérité terrain connaît l'issue, pour mesurer les captures d'une règle. */
  corpus: Array<{ id: string; texte: string; attendu: string | null }>;
  cas: {
    paraphrases: CasParaphrases;
    conversation: CasConversation;
    regles: CasRegles;
    revue: CasRevue;
    impact: CasImpact;
    complexite: CasComplexite;
    stories: CasStories;
    juge: CasJuge;
  };
}

async function lireJson<T>(fichier: string): Promise<T> {
  return JSON.parse(await readFile(fichier, "utf8")) as T;
}

/** Premier extrait significatif d'un feedback : une phrase d'au moins 15 caractères qui n'est pas une formule de politesse. */
export function extraitRepresentatif(texte: string): string {
  const phrases = texte
    .split(/(?<=[.!?])\s+|\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 15 && !/^(bonjour|merci|cordialement|bien cordialement|salut|hello|bonne journée)\b/i.test(p));
  return phrases[0] ?? texte.trim().slice(0, 200);
}

export async function chargerDonnees(): Promise<DonneesEval> {
  const verite = await lireJson<VeriteTerrain>(path.join(DOSSIER_SEED, "verite-terrain.json"));
  const feedbacks = [...(await lireJson<Feedback[]>(path.join(DOSSIER_SEED, "feedbacks.json"))), ...(await lireJson<Feedback[]>(path.join(DOSSIER_SEED, "direct.json")))];
  const textes = new Map(feedbacks.map((f) => [f.id, f]));
  const items = await lireJson<Array<ItemBacklog & { description?: string }>>(path.join(DOSSIER_SEED, "items.json"));
  const idsBacklog = new Set(items.map((i) => i.id));
  const attendus = attendusParFeedback(verite);
  // La tentative d'injection (M7) est mise en quarantaine par la chaîne : aucune règle ne s'applique jamais à elle.
  const injections = new Set(verite.motifs.find((m) => m.id === "M7")?.feedbackIds ?? []);
  const corpus = [...attendus.entries()].filter(([id]) => textes.has(id) && !injections.has(id)).map(([id, attendu]) => ({ id, texte: textes.get(id)!.texte, attendu }));

  const lire = <T>(nom: string) => lireJson<T>(path.join(DOSSIER_CAS, `${nom}.json`));
  const cas = {
    paraphrases: await lire<CasParaphrases>("paraphrases"),
    conversation: await lire<CasConversation>("conversation"),
    regles: await lire<CasRegles>("regles"),
    revue: await lire<CasRevue>("revue"),
    impact: await lire<CasImpact>("impact"),
    complexite: await lire<CasComplexite>("complexite"),
    stories: await lire<CasStories>("stories"),
    juge: await lire<CasJuge>("juge"),
  };
  const d: DonneesEval = { verite, attendus, textes, items, idsBacklog, corpus, cas };
  controlerCas(d);
  return d;
}

/** Arrête le banc si un fichier de cas est incohérent avec le jeu de données ou la vérité terrain. */
export function controlerCas(d: DonneesEval): void {
  const erreurs: string[] = [];
  const texte = (id: string) => d.textes.get(id)?.texte;
  const exige = (ok: boolean, message: string) => {
    if (!ok) erreurs.push(message);
  };
  for (const c of d.cas.paraphrases.cas) exige(texte(c.feedbackId) !== undefined, `paraphrases ${c.id} : feedback inconnu ${c.feedbackId}`);
  for (const c of d.cas.regles.cas) {
    const t = texte(c.feedbackId);
    exige(t !== undefined && citationVerifiee(c.citation, t), `regles ${c.id} : la citation ne figure pas mot pour mot dans ${c.feedbackId}`);
    exige(d.attendus.get(c.feedbackId) === c.itemChoisi, `regles ${c.id} : la vérité terrain rattache ${c.feedbackId} à ${d.attendus.get(c.feedbackId)}, pas à ${c.itemChoisi}`);
    for (const id of [c.itemChoisi, ...c.itemsEcartes]) exige(d.idsBacklog.has(id), `regles ${c.id} : item inconnu ${id}`);
  }
  for (const n of d.cas.revue.itemsCreesParAgent) {
    for (const v of n.verbatims) {
      const t = texte(v.feedbackId);
      exige(t !== undefined && citationVerifiee(v.extrait, t), `revue ${n.id} : l'extrait ne figure pas mot pour mot dans ${v.feedbackId}`);
    }
    const vrais = new Set(n.verbatims.map((v) => d.attendus.get(v.feedbackId)));
    exige(vrais.size === 1, `revue ${n.id} : ses verbatims relèvent d'items différents dans la vérité terrain`);
  }
  for (const r of d.cas.revue.reponsesPO) {
    const t = texte(r.feedbackId);
    exige(t !== undefined && citationVerifiee(r.citation, t), `revue ${r.id} : la citation ne figure pas mot pour mot dans ${r.feedbackId}`);
    exige(d.attendus.get(r.feedbackId) === r.choix, `revue ${r.id} : la vérité terrain rattache ${r.feedbackId} à ${d.attendus.get(r.feedbackId)}, pas à ${r.choix}`);
  }
  const idsParaphrases = new Set(d.cas.paraphrases.cas.map((c) => c.id));
  for (const p of d.cas.impact.paraphrases) {
    exige(d.idsBacklog.has(p.itemId), `impact ${p.id} : item inconnu ${p.itemId}`);
    for (const id of p.cas) {
      exige(idsParaphrases.has(id), `impact ${p.id} : cas de paraphrase inconnu ${id}`);
      const source = d.cas.paraphrases.cas.find((c) => c.id === id);
      if (source) exige(d.attendus.get(source.feedbackId) === p.itemId, `impact ${p.id} : ${source.feedbackId} ne relève pas de ${p.itemId} dans la vérité terrain`);
    }
  }
  for (const c of d.cas.conversation.cas) {
    if (c.doitCiterLeRangSimule) exige(d.idsBacklog.has(c.doitCiterLeRangSimule.itemId), `conversation ${c.id} : item inconnu`);
  }
  for (const c of d.cas.stories.cas) {
    exige(d.idsBacklog.has(c.itemId), `stories ${c.id} : item inconnu ${c.itemId}`);
    const { min, max } = VERBATIMS_PAR_STORY;
    exige(c.verbatims.length >= min && c.verbatims.length <= max, `stories ${c.id} : ${c.verbatims.length} extrait(s), il en faut de ${min} à ${max}`);
    for (const v of c.verbatims) {
      const t = texte(v.feedbackId);
      exige(t !== undefined && citationVerifiee(v.extrait, t), `stories ${c.id} : l'extrait ne figure pas mot pour mot dans ${v.feedbackId}`);
      exige(d.attendus.get(v.feedbackId) === c.itemId, `stories ${c.id} : la vérité terrain rattache ${v.feedbackId} à ${d.attendus.get(v.feedbackId)}, pas à ${c.itemId}`);
    }
  }
  exige(Number.isInteger(d.cas.juge.appels) && d.cas.juge.appels >= 2, "juge : il faut au moins 2 appels par story pour mesurer la stabilité");
  const tousLesTextes = [...d.textes.values()].map((f) => f.texte);
  for (const j of d.cas.juge.stories) {
    const s = j.story;
    exige(d.idsBacklog.has(s.itemId), `juge ${j.id} : item inconnu ${s.itemId}`);
    exige(Object.keys(PARAMETRES.rice.effortParComplexite).includes(s.complexite), `juge ${j.id} : complexité invalide ${s.complexite}`);
    for (const c of s.citations) exige(tousLesTextes.some((t) => citationVerifiee(c, t)), `juge ${j.id} : la citation « ${c.slice(0, 40)} » ne figure mot pour mot dans aucun feedback`);
    const criteres = Object.keys(j.attendus);
    exige(criteres.length > 0 && criteres.every((c) => (CRITERES_JUGE as readonly string[]).includes(c)), `juge ${j.id} : critères attendus inconnus ou absents (${criteres.join(", ")})`);
    // Une story saine ne doit être rejetée sur aucun des deux critères évidents ; une story défectueuse a au moins un défaut attendu.
    if (j.nature === "saine") exige(j.attendus.un_seul_besoin === true && j.attendus.petite === true, `juge ${j.id} : une story saine attend un_seul_besoin et petite à vrai`);
    else exige(Object.values(j.attendus).includes(false), `juge ${j.id} : une story défectueuse attend au moins un critère à faux`);
  }
  if (erreurs.length > 0) throw new Error(`Fichiers de cas incohérents :\n- ${erreurs.join("\n- ")}`);
}

/** Fichiers de cas pas encore validés par l'humain. */
export function casNonValides(d: DonneesEval): string[] {
  return Object.entries(d.cas)
    .filter(([, c]) => c.statut !== "valide" || !c.validePar)
    .map(([nom]) => nom);
}
