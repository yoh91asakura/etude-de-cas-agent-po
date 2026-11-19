/**
 * Les huit étapes du banc des prompts. Chacune appelle un seul type d'appel au modèle, sur des cas contrôlés,
 * et juge les sorties avec du code (voir verifications.ts). Les sorties brutes sont gardées pour la relecture humaine.
 */
import { analyserTirages, citationVerifiee, controlerStory, demandesExploitables, indexImpact, PARAMETRES, type Complexite, type Extraction } from "@po-agent/domain";
import { EchecLLM, type CandidatItem, type EtatRevue, type FournisseurLLM, type JugementStory } from "@po-agent/llm";
import { classement, outilsConversation, type Contexte } from "@po-agent/agent";
import { extraitRepresentatif, type DonneesEval } from "./donnees.ts";
import { empreinteEtat } from "./etat-de-test.ts";
import {
  citationsHorsVerbatims,
  citationsInventees,
  citeLeRang,
  CRITERES_JUGE,
  criteresInstables,
  fusionsHorsAttendues,
  issueAttendue,
  issueRattachement,
  nommeItem,
  paireDans,
  passagesCites,
  pretendAvoirAgi,
  rangSimule,
  simplifier,
  titreCourt,
  verifierRegle,
  type CritereJuge,
  type Resultat,
} from "./verifications.ts";

export interface BilanEtape {
  resultats: Resultat[];
  /** Mesures sans critère de réussite (généralisation, dispersion, accord avec une référence provisoire). */
  mesures: Record<string, string | number>;
  sorties: unknown[];
}

export type Etape = (f: FournisseurLLM, d: DonneesEval, ctx: () => Promise<Contexte>) => Promise<BilanEtape>;

type Tentative<T> = { ok: true; valeur: T } | { ok: false; erreur: string };

/** Un échec maîtrisé du modèle (refus, sortie hors schéma) compte comme un échec du cas, pas comme une panne du banc. */
async function tenter<T>(f: () => Promise<T>): Promise<Tentative<T>> {
  try {
    return { ok: true, valeur: await f() };
  } catch (e) {
    if (e instanceof EchecLLM) return { ok: false, erreur: `${e.etape} (${e.motif})` };
    throw e;
  }
}

const candidat = (i: { id: string; titre: string; description?: string }): CandidatItem => ({ id: i.id, titre: i.titre, ...(i.description ? { description: i.description } : {}) });
const suspect = (ex: Extraction) => ex.injectionSuspectee || ex.nature === "suspect";

// ---------------------------------------------------------------------------
// 1. Extraction et rattachement : le test métamorphique de paraphrase (CADRAGE § 5)
// ---------------------------------------------------------------------------

export const etapeParaphrases: Etape = async (f, d) => {
  const E = "Extraction et rattachement";
  const r: Resultat[] = [];
  const sorties: unknown[] = [];
  const candidats = d.items.map(candidat);
  const n = PARAMETRES.doute.tiragesRattachement;
  let citations = 0;
  let exactes = 0;

  // Même traitement que la chaîne : extraction, garde-fou, puis tirages de rattachement par demande (3 au plus).
  const analyser = async (id: string, texte: string) => {
    const ex = await f.extraire({ id, texte });
    citations += ex.demandes.length;
    exactes += ex.demandes.filter((x) => citationVerifiee(x.citation, texte)).length;
    const issues: string[] = [];
    // Les tirages sont gardés pour comprendre un doute : quel item, quel verdict, quelles alternatives.
    const tirages: Array<{ demande: string; verdicts: Array<{ itemId: string | null; verdict: string; alternatives: string[] }> }> = [];
    for (const dm of demandesExploitables(ex, texte).exploitables.slice(0, 3)) {
      const verdicts = await Promise.all(Array.from({ length: n }, (_, i) => f.jugerRattachement({ resume: dm.resume, citation: dm.citation }, candidats, i)));
      issues.push(issueRattachement(verdicts));
      tirages.push({ demande: dm.resume, verdicts: verdicts.map((v) => ({ itemId: v.itemId, verdict: v.verdict, alternatives: v.alternatives })) });
    }
    return { extraction: ex, issues: [...new Set(issues)].sort(), tirages };
  };

  for (const c of d.cas.paraphrases.cas) {
    const o = await tenter(() => analyser(c.feedbackId, d.textes.get(c.feedbackId)!.texte));
    const p = await tenter(() => analyser(`${c.id}-paraphrase`, c.paraphrase));
    if (!o.ok || !p.ok) {
      r.push({ etape: E, nom: `${c.id} analyse`, ok: false, detail: [o, p].map((x) => (x.ok ? "ok" : x.erreur)).join(" / ") });
      continue;
    }
    const O = o.valeur;
    const P = p.valeur;
    sorties.push({ cas: c.id, feedbackId: c.feedbackId, original: O, paraphrase: P });
    const injO = suspect(O.extraction);
    const injP = suspect(P.extraction);

    if (c.attendus?.injection) {
      r.push({ etape: E, nom: `${c.id} injection repérée, original et paraphrase`, ok: injO && injP, detail: `original ${injO ? "repérée" : "manquée"}, paraphrase ${injP ? "repérée" : "manquée"}`, securite: true });
      continue;
    }
    r.push({ etape: E, nom: `${c.id} aucun faux soupçon d'injection`, ok: !injO && !injP, detail: `original ${injO}, paraphrase ${injP}` });
    r.push({ etape: E, nom: `${c.id} même nature`, ok: O.extraction.nature === P.extraction.nature, detail: `${O.extraction.nature} / ${P.extraction.nature}` });
    const menaceAttendue = c.attendus?.menaceDepart;
    r.push({
      etape: E,
      nom: `${c.id} même menace de départ${menaceAttendue !== undefined ? ` (attendue : ${menaceAttendue ? "oui" : "non"})` : ""}`,
      ok: O.extraction.menaceDepart === P.extraction.menaceDepart && (menaceAttendue === undefined || O.extraction.menaceDepart === menaceAttendue),
      detail: `${O.extraction.menaceDepart} / ${P.extraction.menaceDepart}`,
    });
    const issues = (x: { issues: string[] }) => x.issues.join("+") || "aucune demande";
    r.push({ etape: E, nom: `${c.id} même rattachement`, ok: issues(O) === issues(P), detail: `${issues(O)} / ${issues(P)}` });
    const attendue = issueAttendue(d.attendus.get(c.feedbackId), d.idsBacklog);
    if (attendue) {
      r.push({ etape: E, nom: `${c.id} rattachement attendu (${attendue})`, ok: O.issues.includes(attendue) && P.issues.includes(attendue), detail: `${issues(O)} / ${issues(P)}` });
    }
  }
  return { resultats: r, mesures: { "Citations exactes avant le garde-fou": `${exactes}/${citations}` }, sorties };
};

// ---------------------------------------------------------------------------
// 2. Conversation : outils appelés, faits du code, citations exactes, aucune écriture
// ---------------------------------------------------------------------------

export const etapeConversation: Etape = async (f, d, etat) => {
  const E = "Conversation";
  const ctx = await etat();
  const r: Resultat[] = [];
  const sorties: unknown[] = [];
  const items = new Map(d.items.map((i) => [i.id, i]));

  for (const c of d.cas.conversation.cas) {
    const sortiesOutils: string[] = [];
    const outils = outilsConversation(ctx).map((o) => ({
      ...o,
      executer: async (e: unknown) => {
        const s = await o.executer(e);
        sortiesOutils.push(s);
        return s;
      },
    }));
    const avant = await empreinteEtat(ctx);
    const rep = await tenter(() => f.converser({ message: c.question, historique: [], outils }));
    const inchange = avant === (await empreinteEtat(ctx));
    // Contrôle structurel : les outils sont en lecture seule par construction. Il garde le banc honnête si un outil d'écriture apparaissait.
    r.push({ etape: E, nom: `${c.id} aucune écriture (structurel : outils en lecture seule)`, ok: inchange, detail: inchange ? "état métier inchangé" : "l'état métier a changé", securite: true });
    if (!rep.ok) {
      r.push({ etape: E, nom: `${c.id} réponse`, ok: false, detail: rep.erreur });
      continue;
    }
    const { texte, appels } = rep.valeur;
    sorties.push({ cas: c.id, question: c.question, reponse: texte, appels, sortiesOutils });
    const appeles = appels.map((a) => a.outil);

    if (c.outils) {
      r.push({ etape: E, nom: `${c.id} appelle ${c.outils.join(" ou ")}`, ok: appeles.some((o) => c.outils!.includes(o)), detail: appeles.join(", ") || "aucun outil" });
    }
    // Sources légitimes d'une citation : ce que les outils ont rendu, et la question du PO elle-même.
    const inventees = citationsInventees(texte, [c.question, ...sortiesOutils].join("\n"));
    r.push({
      etape: E,
      nom: `${c.id} citations mot pour mot`,
      ok: inventees.length === 0,
      detail: inventees.length > 0 ? inventees.map((x) => `« ${x.slice(0, 60)} »`).join(" ; ") : `${passagesCites(texte).length} passage(s) cité(s), tous retrouvés`,
    });
    if (c.doitCiterLeTop) {
      const { filtres, n } = c.doitCiterLeTop;
      const top = (await classement(ctx, filtres)).slice(0, n).flatMap((s) => (items.has(s.itemId) ? [items.get(s.itemId)!] : []));
      const absents = top.filter((i) => !nommeItem(texte, i));
      r.push({
        etape: E,
        nom: `${c.id} cite le top ${n} calculé par le code`,
        ok: top.length === n && absents.length === 0,
        detail: `attendu : ${top.map((i) => titreCourt(i.titre)).join(", ")}${absents.length > 0 ? ` ; absents : ${absents.map((i) => titreCourt(i.titre)).join(", ")}` : ""}`,
      });
    }
    if (c.doitMentionnerUnDe) {
      const trouves = c.doitMentionnerUnDe.filter((m) => simplifier(texte).includes(simplifier(m)));
      r.push({ etape: E, nom: `${c.id} explique le calcul (${c.doitMentionnerUnDe.join(", ")})`, ok: trouves.length > 0, detail: trouves.join(", ") || "aucun facteur nommé" });
    }
    if (c.doitCiterLeRangSimule) {
      const { itemId, impact, filtres } = c.doitCiterLeRangSimule;
      const simuler = outilsConversation(ctx).find((o) => o.nom === "simuler")!;
      const rang = rangSimule(await simuler.executer({ item_id: itemId, impact, filtres }));
      r.push({ etape: E, nom: `${c.id} annonce le rang simulé par le code`, ok: rang !== null && citeLeRang(texte, rang), detail: `rang attendu : ${rang ?? "?"}` });
    }
    if (c.doitDire) {
      r.push({ etape: E, nom: `${c.id} répond « ${c.doitDire.split("|").join(" » ou « ")} »`, ok: new RegExp(c.doitDire, "i").test(texte), detail: texte.slice(0, 80), heuristique: true });
    }
    if (c.demandeUneEcriture) {
      r.push({ etape: E, nom: `${c.id} ne prétend pas avoir modifié le backlog`, ok: !pretendAvoirAgi(texte), detail: texte.slice(0, 100), heuristique: true });
    }
  }
  return { resultats: r, mesures: {}, sorties };
};

// ---------------------------------------------------------------------------
// 3. Formulation de règle
// ---------------------------------------------------------------------------

export const etapeRegles: Etape = async (f, d) => {
  const E = "Formulation de règle";
  const r: Resultat[] = [];
  const mesures: Record<string, string> = {};
  const sorties: unknown[] = [];
  const items = new Map(d.items.map((i) => [i.id, i]));
  const tolerance = d.cas.regles.tolerance.capturesHorsItemMax;

  for (const c of d.cas.regles.cas) {
    const s = await tenter(() =>
      f.formulerRegleRattachement({ citation: c.citation, itemChoisi: candidat(items.get(c.itemChoisi)!), itemsEcartes: c.itemsEcartes.map((id) => candidat(items.get(id)!)) }),
    );
    if (!s.ok) {
      r.push({ etape: E, nom: `${c.id} formulation`, ok: false, detail: s.erreur });
      continue;
    }
    const bilan = verifierRegle({ motsCles: s.valeur.motsCles, itemId: c.itemChoisi }, `${c.resume} ${c.citation}`, d.corpus.filter((x) => x.id !== c.feedbackId));
    sorties.push({ cas: c.id, regle: s.valeur, bilan });
    r.push({ etape: E, nom: `${c.id} règle bien formée`, ok: bilan.valide, detail: s.valeur.motsCles.join(", ") || "aucun mot-clé" });
    r.push({ etape: E, nom: `${c.id} rattache son cas source à ${c.itemChoisi}`, ok: bilan.rattacheSource, detail: s.valeur.motsCles.join(", ") });
    r.push({
      etape: E,
      nom: `${c.id} ne capte aucune demande d'un autre item (borne haute)`,
      ok: bilan.capturesHorsItem.length <= tolerance,
      detail: bilan.capturesHorsItem.length === 0 ? "aucune capture" : bilan.capturesHorsItem.slice(0, 6).map((id) => `${id}→${d.attendus.get(id) ?? "sans item"}`).join(", "),
    });
    mesures[`${c.id} : demandes de ${c.itemChoisi} captées (généralisation)`] = `${bilan.capturesMemeItem}/${bilan.totalMemeItem}`;
  }
  return { resultats: r, mesures, sorties };
};

// ---------------------------------------------------------------------------
// 4. Revue de fond : sortie brute du modèle, avant le filtre de fond.ts
// ---------------------------------------------------------------------------

export const etapeRevue: Etape = async (f, d): Promise<BilanEtape> => {
  const E = "Revue de fond";
  const r: Resultat[] = [];
  const plantes = d.cas.revue.itemsCreesParAgent;
  const utilises = new Set(plantes.flatMap((n) => n.verbatims.map((v) => v.feedbackId)));
  const parItem = new Map<string, string[]>();
  for (const [fid, item] of d.attendus) {
    if (!item || !d.idsBacklog.has(item) || utilises.has(fid) || !d.textes.has(fid)) continue;
    parItem.set(item, [...(parItem.get(item) ?? []), fid]);
  }
  const etat: EtatRevue = {
    items: [
      ...d.items.map((i) => {
        const fids = parItem.get(i.id) ?? [];
        return { ...candidat(i), creeParAgent: false, preuves: fids.length, verbatims: fids.slice(0, 3).map((fid) => extraitRepresentatif(d.textes.get(fid)!.texte)) };
      }),
      ...plantes.map((n) => ({ id: n.id, titre: n.titre, creeParAgent: true, preuves: n.verbatims.length, verbatims: n.verbatims.map((v) => v.extrait) })),
    ],
    reponsesPO: d.cas.revue.reponsesPO.map((x) => ({ id: x.id, enonce: x.enonce, choix: x.choix, citation: x.citation })),
  };
  // Le vrai item d'un item planté est celui de ses verbatims dans la vérité terrain (contrôlé au chargement).
  const attendues = plantes.flatMap((n): Array<[string, string]> => {
    const vrai = d.attendus.get(n.verbatims[0]!.feedbackId);
    return vrai && d.idsBacklog.has(vrai) ? [[n.id, vrai]] : [];
  });

  const s = await tenter(() => f.revueDeFond(etat));
  if (!s.ok) return { resultats: [{ etape: E, nom: "revue", ok: false, detail: s.erreur }], mesures: {}, sorties: [] };
  const { fusions, regles } = s.valeur;

  for (const [n, vrai] of attendues) {
    r.push({ etape: E, nom: `doublon ${n} ↔ ${vrai} repéré`, ok: paireDans(fusions, n, vrai), detail: fusions.filter((x) => x.itemA === n || x.itemB === n).map((x) => `${x.itemA}+${x.itemB}`).join(", ") || "non proposé" });
  }
  const enTrop = fusionsHorsAttendues(fusions, attendues);
  r.push({ etape: E, nom: "aucune fusion de besoins distincts", ok: enTrop.length === 0, detail: enTrop.map((x) => `${x.itemA}+${x.itemB}`).join(", ") || "aucune" });

  const reponses = new Map(d.cas.revue.reponsesPO.map((x) => [x.id, x]));
  // La revue doit aussi généraliser : deux réponses concordantes du PO vers un même élément appellent une règle.
  // Sans cette vérification, une revue qui ne propose aucune règle obtenait 100 %.
  const concordantes = [...new Set(d.cas.revue.reponsesPO.map((x) => x.choix))].filter((choix) => d.cas.revue.reponsesPO.filter((x) => x.choix === choix).length >= 2);
  for (const choix of concordantes) {
    r.push({
      etape: E,
      nom: `généralise les réponses concordantes vers ${choix}`,
      ok: regles.some((x) => x.itemId === choix),
      detail: regles.length === 0 ? "aucune règle proposée" : regles.map((x) => `${x.itemId}←${x.reponsesSources.join("+")}`).join(", "),
    });
  }
  if (regles.length > 0) {
    const inventees = regles.flatMap((x) => (x.reponsesSources.length === 0 ? ["(aucune)"] : x.reponsesSources.filter((id) => !reponses.has(id))));
    r.push({ etape: E, nom: "règles : sources qui sont de vraies réponses du PO (sortie brute)", ok: inventees.length === 0, detail: inventees.join(", ") || `${regles.length} règle(s), sources connues` });
    const bilans = regles.map((x) => {
      const sources = x.reponsesSources.flatMap((id) => (reponses.has(id) ? [reponses.get(id)!] : []));
      return {
        regle: x,
        conforme: sources.length > 0 && sources.every((sr) => sr.choix === x.itemId),
        verifs: sources.map((sr) => verifierRegle({ motsCles: x.motsCles, itemId: x.itemId }, `${sr.resume} ${sr.citation}`, d.corpus.filter((c) => c.id !== sr.feedbackId))),
      };
    });
    r.push({ etape: E, nom: "règles : item conforme aux réponses du PO", ok: bilans.every((b) => b.conforme), detail: bilans.map((b) => `${b.regle.itemId}←${b.regle.reponsesSources.join("+")}`).join(", ") });
    r.push({ etape: E, nom: "règles : rattachent leurs cas sources", ok: bilans.every((b) => b.verifs.length > 0 && b.verifs.every((v) => v.valide && v.rattacheSource)), detail: bilans.map((b) => b.regle.motsCles.join("/")).join(" ; ") });
    const captures = bilans.flatMap((b) => b.verifs.flatMap((v) => v.capturesHorsItem));
    r.push({ etape: E, nom: "règles : aucune capture hors item (borne haute)", ok: captures.length === 0, detail: [...new Set(captures)].slice(0, 6).join(", ") || "aucune capture" });
  }
  return { resultats: r, mesures: { "Fusions proposées": fusions.length, "Règles proposées": regles.length }, sorties: [{ etat, sortie: s.valeur }] };
};

// ---------------------------------------------------------------------------
// 5. Impact : ordre entre deux enjeux nets, stabilité sous paraphrase, dispersion
// ---------------------------------------------------------------------------

export const etapeImpact: Etape = async (f, d) => {
  const E = "Impact";
  const r: Resultat[] = [];
  const sorties: unknown[] = [];
  const n = PARAMETRES.rice.tiragesImpact;
  const tolerance = d.cas.impact.tolerance.paraphraseCransMax;
  let jugements = 0;
  let enDoute = 0;
  let ecartTotal = 0;
  let citationsJuge = 0;
  let citationsExactes = 0;

  const juger = async (id: string, titre: string, citations: string[], description?: string) => {
    const tirages = await Promise.all(Array.from({ length: n }, (_, i) => f.jugerImpact({ item: { id, titre, ...(description ? { description } : {}) }, citations }, i)));
    const analyse = analyserTirages(tirages.map((t) => t.impact));
    jugements += 1;
    enDoute += analyse.doute ? 1 : 0;
    ecartTotal += analyse.ecartCrans;
    for (const c of tirages.flatMap((t) => t.citations)) {
      citationsJuge += 1;
      citationsExactes += citationVerifiee(c, citations.join("\n")) ? 1 : 0;
    }
    return { tirages: tirages.map((t) => t.impact), ...analyse };
  };
  const decrire = (x: { mediane: number; tirages: number[] }) => `${x.mediane} [${x.tirages.join(", ")}]`;

  for (const p of d.cas.impact.paires) {
    const res = await tenter(async () => ({ fort: await juger(`${p.id}-fort`, p.fort.titre, p.fort.citations ?? []), faible: await juger(`${p.id}-faible`, p.faible.titre, p.faible.citations ?? []) }));
    if (!res.ok) {
      r.push({ etape: E, nom: `${p.id} jugement`, ok: false, detail: res.erreur });
      continue;
    }
    const { fort, faible } = res.valeur;
    sorties.push({ cas: p.id, fort, faible });
    r.push({ etape: E, nom: `${p.id} « ${p.fort.titre} » au-dessus de « ${p.faible.titre} »`, ok: indexImpact(fort.mediane) > indexImpact(faible.mediane), detail: `${decrire(fort)} / ${decrire(faible)}` });
  }

  const paraphrases = new Map(d.cas.paraphrases.cas.map((c) => [c.id, c]));
  for (const p of d.cas.impact.paraphrases) {
    const item = d.items.find((i) => i.id === p.itemId)!;
    const cas = p.cas.map((id) => paraphrases.get(id)!);
    const res = await tenter(async () => ({
      original: await juger(item.id, item.titre, cas.map((c) => d.textes.get(c.feedbackId)!.texte), item.description),
      paraphrase: await juger(item.id, item.titre, cas.map((c) => c.paraphrase), item.description),
    }));
    if (!res.ok) {
      r.push({ etape: E, nom: `${p.id} jugement`, ok: false, detail: res.erreur });
      continue;
    }
    const { original, paraphrase } = res.valeur;
    sorties.push({ cas: p.id, original, paraphrase });
    const ecart = Math.abs(indexImpact(original.mediane) - indexImpact(paraphrase.mediane));
    r.push({ etape: E, nom: `${p.id} ${item.id} stable sous paraphrase (±${tolerance} cran)`, ok: ecart <= tolerance, detail: `${decrire(original)} / ${decrire(paraphrase)}` });
  }
  return {
    resultats: r,
    mesures: {
      [`Jugements (${n} tirages chacun)`]: jugements,
      "Jugements en doute (écart au-delà du seuil)": `${enDoute}/${jugements}`,
      "Écart moyen entre tirages (crans)": jugements > 0 ? Math.round((ecartTotal / jugements) * 100) / 100 : 0,
      "Citations du juge exactes avant filtre": `${citationsExactes}/${citationsJuge}`,
    },
    sorties,
  };
};

// ---------------------------------------------------------------------------
// 6. Complexité : ordre, stabilité, accord avec la référence provisoire du scénario
// ---------------------------------------------------------------------------

const ORDRE_COMPLEXITE: Complexite[] = ["S", "M", "L", "XL"];

function plusFrequente(valeurs: Complexite[]): Complexite {
  const compte = new Map<Complexite, number>();
  for (const v of valeurs) compte.set(v, (compte.get(v) ?? 0) + 1);
  return [...compte.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

export const etapeComplexite: Etape = async (f, d) => {
  const E = "Complexité";
  const r: Resultat[] = [];
  const sorties: unknown[] = [];
  const k = d.cas.complexite.repetitions;
  const estimer = async (l: { titre: string; description?: string; citations?: string[] }) => {
    const v: Complexite[] = [];
    for (let i = 0; i < k; i++) v.push((await f.estimerComplexite({ titre: l.titre, ...(l.description ? { description: l.description } : {}) }, l.citations ?? [])).complexite);
    return v;
  };

  for (const p of d.cas.complexite.paires) {
    const res = await tenter(async () => ({ petit: await estimer(p.petit), grand: await estimer(p.grand) }));
    if (!res.ok) {
      r.push({ etape: E, nom: `${p.id} estimation`, ok: false, detail: res.erreur });
      continue;
    }
    const { petit, grand } = res.valeur;
    sorties.push({ cas: p.id, petit, grand });
    r.push({
      etape: E,
      nom: `${p.id} « ${p.grand.titre} » plus gros que « ${p.petit.titre} »`,
      ok: ORDRE_COMPLEXITE.indexOf(plusFrequente(grand)) > ORDRE_COMPLEXITE.indexOf(plusFrequente(petit)),
      detail: `grand ${grand.join(",")} / petit ${petit.join(",")}`,
    });
    r.push({ etape: E, nom: `${p.id} estimation stable sur ${k} répétitions`, ok: new Set(petit).size === 1 && new Set(grand).size === 1, detail: `grand ${grand.join(",")} / petit ${petit.join(",")}` });
  }

  let exact = 0;
  let unCran = 0;
  const backlog: unknown[] = [];
  for (const item of d.items) {
    const res = await tenter(() => f.estimerComplexite({ titre: item.titre, ...(item.description ? { description: item.description } : {}) }, []));
    if (!res.ok) continue;
    const ecart = Math.abs(ORDRE_COMPLEXITE.indexOf(res.valeur.complexite) - ORDRE_COMPLEXITE.indexOf(item.complexite));
    exact += ecart === 0 ? 1 : 0;
    unCran += ecart <= 1 ? 1 : 0;
    backlog.push({ itemId: item.id, reference: item.complexite, estimee: res.valeur.complexite });
  }
  sorties.push({ backlog });
  return {
    resultats: r,
    mesures: {
      "Accord exact avec le backlog du scénario (référence provisoire)": `${exact}/${d.items.length}`,
      "Accord à un cran près": `${unCran}/${d.items.length}`,
    },
    sorties,
  };
};

// ---------------------------------------------------------------------------
// 7. Rédaction de story : forme vérifiée par le code, citations mot pour mot, longueur mesurée
// ---------------------------------------------------------------------------

/** Bornes du prompt de rédaction (PROMPT_STORY : « 2 à 5 critères d'acceptation »). */
const CRITERES_PAR_STORY = { min: 2, max: 5 };

export const etapeStories: Etape = async (f, d) => {
  const E = "Rédaction de story";
  const r: Resultat[] = [];
  const sorties: unknown[] = [];
  const items = new Map(d.items.map((i) => [i.id, i]));
  const { min, max } = CRITERES_PAR_STORY;
  const longueurs: Array<{ itemId: string; criteres: string; casLimites: string }> = [];
  let redigees = 0;

  for (const c of d.cas.stories.cas) {
    const item = items.get(c.itemId)!;
    const verbatims = c.verbatims.map((v) => v.extrait);
    const s = await tenter(() => f.redigerStory({ item, citations: verbatims }));
    if (!s.ok) {
      r.push({ etape: E, nom: `${c.id} ${c.itemId} rédaction`, ok: false, detail: s.erreur });
      longueurs.push({ itemId: c.itemId, criteres: "échec", casLimites: "échec" });
      continue;
    }
    const story = s.valeur;
    redigees += 1;
    sorties.push({ cas: c.id, itemId: c.itemId, verbatims, story });

    for (const k of controlerStory(story)) {
      r.push({ etape: E, nom: `${c.id} ${c.itemId} contrôle du domaine : ${k.nom}`, ok: k.ok, detail: k.ok ? "ok" : (k.detail ?? "en défaut") });
    }
    // Comme dans la chaîne (stories.ts), mais verbatim par verbatim : une citation recousue sur deux verbatims est refusée.
    const horsVerbatims = citationsHorsVerbatims(story.citations, verbatims);
    r.push({
      etape: E,
      nom: `${c.id} ${c.itemId} citations mot pour mot dans les verbatims fournis`,
      ok: horsVerbatims.length === 0,
      detail:
        horsVerbatims.length > 0
          ? horsVerbatims.map((x) => `« ${x.slice(0, 60)} »`).join(" ; ")
          : story.citations.length === 0
            ? "aucune citation"
            : `${story.citations.length} citation(s), toutes retrouvées`,
    });
    const n = story.criteres.length;
    r.push({ etape: E, nom: `${c.id} ${c.itemId} de ${min} à ${max} critères d'acceptation`, ok: n >= min && n <= max, detail: `${n} critère(s)` });
    r.push({ etape: E, nom: `${c.id} ${c.itemId} complexité valide`, ok: ORDRE_COMPLEXITE.includes(story.complexite), detail: `${story.complexite} (backlog : ${item.complexite})` });
    longueurs.push({ itemId: c.itemId, criteres: String(n), casLimites: String(story.casLimites.length) });
  }
  const parItem = (cle: "criteres" | "casLimites") => longueurs.map((l) => `${l.itemId} ${l[cle]}`).join(", ");
  return {
    resultats: r,
    mesures: {
      "Stories rédigées": `${redigees}/${d.cas.stories.cas.length}`,
      "Critères d'acceptation par story": parItem("criteres"),
      "Cas limites par story": parItem("casLimites"),
    },
    sorties,
  };
};

// ---------------------------------------------------------------------------
// 8. Juge des stories : défauts flagrants repérés, stories saines acceptées, verdicts stables
// ---------------------------------------------------------------------------

const ouiNon = (b: boolean) => (b ? "oui" : "non");

export const etapeJuge: Etape = async (f, d) => {
  const E = "Juge des stories";
  const r: Resultat[] = [];
  const sorties: unknown[] = [];
  const k = d.cas.juge.appels;
  let identiques = 0;
  let compares = 0;
  const oui = { saine: 0, defectueuse: 0 };
  const rendus = { saine: 0, defectueuse: 0 };

  for (const j of d.cas.juge.stories) {
    const res = await tenter(async () => {
      const v: JugementStory[] = [];
      for (let i = 0; i < k; i++) v.push(await f.jugerStory(j.story));
      return v;
    });
    if (!res.ok) {
      r.push({ etape: E, nom: `${j.id} jugement`, ok: false, detail: res.erreur });
      continue;
    }
    const verdicts = res.valeur;
    sorties.push({ cas: j.id, nature: j.nature, attendus: j.attendus, verdicts });

    // Chaque appel doit rendre le verdict attendu : la chaîne n'appelle le juge qu'une fois par story.
    for (const [critere, attendu] of Object.entries(j.attendus) as Array<[CritereJuge, boolean]>) {
      const obtenus = verdicts.map((v) => v[critere]);
      r.push({
        etape: E,
        nom: attendu ? `${j.id} story ${j.nature === "saine" ? "saine" : "défectueuse"} non rejetée sur ${critere}` : `${j.id} défaut repéré : ${critere}`,
        ok: obtenus.every((x) => x === attendu),
        detail: `attendu ${ouiNon(attendu)}, obtenu ${obtenus.map(ouiNon).join(", ")}`,
      });
    }
    const instables = criteresInstables(verdicts);
    identiques += CRITERES_JUGE.length - instables.length;
    compares += CRITERES_JUGE.length;
    r.push({
      etape: E,
      nom: `${j.id} verdicts identiques sur ${k} appels`,
      ok: instables.length === 0,
      detail: instables.length > 0 ? `instables : ${instables.join(", ")}` : `${CRITERES_JUGE.length} critères identiques`,
    });
    for (const v of verdicts) {
      for (const c of CRITERES_JUGE) {
        rendus[j.nature] += 1;
        oui[j.nature] += v[c] ? 1 : 0;
      }
    }
  }
  return {
    resultats: r,
    mesures: {
      "Critères au verdict identique d'un appel à l'autre": `${identiques}/${compares}`,
      "Réponses « oui » sur les stories saines (six critères)": `${oui.saine}/${rendus.saine}`,
      "Réponses « oui » sur les stories défectueuses (six critères)": `${oui.defectueuse}/${rendus.defectueuse}`,
    },
    sorties,
  };
};

export const ETAPES: Record<string, { titre: string; executer: Etape }> = {
  paraphrases: { titre: "Extraction et rattachement (paraphrases)", executer: etapeParaphrases },
  conversation: { titre: "Conversation", executer: etapeConversation },
  regles: { titre: "Formulation de règle", executer: etapeRegles },
  revue: { titre: "Revue de fond", executer: etapeRevue },
  impact: { titre: "Impact", executer: etapeImpact },
  complexite: { titre: "Complexité", executer: etapeComplexite },
  stories: { titre: "Rédaction de story", executer: etapeStories },
  juge: { titre: "Juge des stories", executer: etapeJuge },
};
