import { createContext, useCallback, useContext, useRef, useState } from "react";
import { api, messageErreur, type AlerteApi, type DetailsPropositionApi, type PropositionApi, type QuestionApi } from "./api.ts";
import type { Cle } from "./donnees.ts";
import { Surligne } from "./FicheFeedback.tsx";
import { dateCourte, decimalesFr, humaniser, LIBELLE_CANAL, LIBELLE_NATURE, mrr, nombre } from "./format.ts";
import { Badge, BadgePlan, Chargement, ErreurPanneau, Garde, useNotifier } from "./ui.tsx";

const TYPE_QUESTION: Record<QuestionApi["type"], string> = {
  rattachement: "Rattachement",
  fusion: "Fusion",
  impact: "Impact",
  requalification: "Requalification",
};

const TYPE_PROPOSITION: Record<string, string> = {
  nouvel_item: "Nouvel élément",
  regle: "Règle de doctrine",
  story_prete: "Story à valider",
  ordre_backlog: "Ordre du backlog",
  export_jira: "Export Jira",
  suggestion: "Suggestion d'un assistant",
  effort: "Effort à confirmer",
  decoupage: "Découpage de story",
};

/**
 * La file « À décider » (décision 014). Les règles se décident dans Doctrine, les stories et leurs découpages dans
 * Stories : la file y mène. Le reste se décide ici, dans cet ordre : ce qui change le backlog officiel d'abord.
 */
const VERS_DOCTRINE = new Set(["regle"]);
const VERS_STORIES = new Set(["story_prete", "decoupage"]);
const PRIORITE_PROPOSITION = ["ordre_backlog", "effort", "nouvel_item", "export_jira", "suggestion"];

/**
 * Après une décision, la carte décidée disparaît et celle du dessous remonte sous la souris : un double clic décidait
 * la suivante. Toutes les décisions de la boîte sont donc bloquées un court instant après chacune.
 */
const DELAI_VERROU_MS = 900;
const VerrouDecision = createContext<{ verrouille: boolean; verrouiller: () => void }>({ verrouille: false, verrouiller: () => {} });

function useVerrouDecision() {
  return useContext(VerrouDecision);
}

const TYPE_ALERTE: Record<string, string> = {
  quarantaine: "Quarantaine",
  risque_depart: "Risque de départ",
  entree_top: "Entrée dans le top",
  sortie_top: "Sortie du top",
  tendance: "Thème émergent",
  bug_deguise: "Bug déguisé",
  resume: "Résumé de l'agent",
};

interface Props {
  questions: QuestionApi[] | null;
  propositions: PropositionApi[] | null;
  alertes: AlerteApi[] | null;
  erreurs: Partial<Record<Cle, string>>;
  /** Libellé de la vue sur laquelle l'agent raisonne, par exemple « pondérée par le MRR ». */
  vueReference: string;
  questionsEnFile: number;
  rafraichir: (cles: Cle[]) => void;
  onOuvrirItem: (id: string) => void;
  onOuvrirFeedback: (id: string) => void;
  /** Ouvre la vue où se décident les règles (Doctrine) ou les stories (Stories, filtrée sur ce qui attend). */
  onOuvrirOnglet: (onglet: "doctrine" | "stories") => void;
}

export function Boite({ questions, propositions, alertes, erreurs, vueReference, questionsEnFile, rafraichir, onOuvrirItem, onOuvrirFeedback, onOuvrirOnglet }: Props) {
  const [verrouille, setVerrouille] = useState(false);
  const minuterieVerrou = useRef<ReturnType<typeof setTimeout> | null>(null);
  const verrouiller = useCallback(() => {
    setVerrouille(true);
    if (minuterieVerrou.current) clearTimeout(minuterieVerrou.current);
    minuterieVerrou.current = setTimeout(() => setVerrouille(false), DELAI_VERROU_MS);
  }, []);
  // Une seule ligne dépliée à la fois.
  const [ouverte, setOuverte] = useState<string | null>(null);
  // L'API trie déjà les questions : urgentes d'abord, puis par enjeu.
  const listeQuestions = questions ?? [];
  const enAttente = [...(propositions ?? [])]
    .filter((p) => p.statut === "en_attente")
    // Du plus récent au plus ancien par ordre de création (le numéro de « PR012 »), pas par date : une base créée avant
    // que les propositions suivent l'horloge du scénario mélange deux horloges.
    .sort((a, b) => numeroProposition(b.id) - numeroProposition(a.id) || b.creeeLe.localeCompare(a.creeeLe));
  const regles = enAttente.filter((p) => VERS_DOCTRINE.has(p.type));
  const stories = enAttente.filter((p) => VERS_STORIES.has(p.type));
  const ici = enAttente.filter((p) => !VERS_DOCTRINE.has(p.type) && !VERS_STORIES.has(p.type)).sort((a, b) => rang(a.type) - rang(b.type));
  const nbStories = stories.filter((p) => p.type === "story_prete").length;
  const nbDecoupages = stories.length - nbStories;
  const charge = questions !== null && propositions !== null;
  const total = listeQuestions.length + enAttente.length;

  return (
    <VerrouDecision.Provider value={{ verrouille, verrouiller }}>
    <section className="colonne colonne-boite" aria-labelledby="titre-boite">
      <div className="colonne-entete">
        <h2 id="titre-boite">À décider</h2>
        <span className={`compte-file${total > 0 ? " compte-file-actif" : ""}`} title="Questions et propositions de l'agent qui attendent votre décision">
          {charge ? total : "…"}
        </span>
      </div>
      <div className="colonne-defile">
        <Garde nom="urgences">
          <Urgences alertes={alertes} onOuvrirItem={onOuvrirItem} onOuvrirFeedback={onOuvrirFeedback} />
        </Garde>

        {erreurs.questions && !questions ? <ErreurPanneau message={erreurs.questions} /> : null}
        {erreurs.propositions && !propositions ? <ErreurPanneau message={erreurs.propositions} /> : null}
        {!charge && !erreurs.questions && !erreurs.propositions ? <Chargement /> : null}
        {charge && total === 0 ? <p className="vide-court">Rien à décider. Quand l'agent doute ou propose un changement, il vous le soumet ici.</p> : null}

        <Garde nom="questions">
          {listeQuestions.map((q) => (
            <CarteQuestion key={q.id} q={q} vueReference={vueReference} rafraichir={rafraichir} onOuvrirItem={onOuvrirItem} onOuvrirFeedback={onOuvrirFeedback} />
          ))}
          {questionsEnFile > 0 ? (
            <p className="discret file-note">
              {questionsEnFile} autre{questionsEnFile > 1 ? "s" : ""} question{questionsEnFile > 1 ? "s" : ""} en file, posée{questionsEnFile > 1 ? "s" : ""} par ordre d'enjeu.
            </p>
          ) : null}
        </Garde>

        {regles.length > 0 ? (
          <GroupeVers
            titre={regles.length === 1 ? "Règle de doctrine à valider" : `${regles.length} règles de doctrine à valider`}
            detail={regles.length === 1 ? regles[0]!.resume : null}
            cible="Doctrine"
            onOuvrir={() => onOuvrirOnglet("doctrine")}
          />
        ) : null}

        <Garde nom="propositions">
          {ici.length > 0 ? (
            <ul className="file-lignes">
              {ici.map((p) => (
                <LigneProposition
                  key={p.id}
                  p={p}
                  ouverte={ouverte === p.id}
                  onBasculer={() => setOuverte((o) => (o === p.id ? null : p.id))}
                  rafraichir={rafraichir}
                  onOuvrirItem={onOuvrirItem}
                  onOuvrirFeedback={onOuvrirFeedback}
                />
              ))}
            </ul>
          ) : null}
        </Garde>

        {stories.length > 0 ? (
          <GroupeVers
            titre={[nbStories > 0 ? `${nbStories} ${nbStories > 1 ? "stories" : "story"} à valider` : null, nbDecoupages > 0 ? `${nbDecoupages} découpage${nbDecoupages > 1 ? "s" : ""}` : null].filter(Boolean).join(" · ")}
            detail={null}
            cible="Stories"
            onOuvrir={() => onOuvrirOnglet("stories")}
          />
        ) : null}

        <Garde nom="pour info">
          <PourInfo alertes={alertes} erreur={erreurs.alertes} onOuvrirItem={onOuvrirItem} onOuvrirFeedback={onOuvrirFeedback} />
        </Garde>
      </div>
    </section>
    </VerrouDecision.Provider>
  );
}

/** Une ligne de la file qui mène à la vue où la décision se prend, avec son contexte. */
function GroupeVers({ titre, detail, cible, onOuvrir }: { titre: string; detail: string | null; cible: string; onOuvrir: () => void }) {
  return (
    <button type="button" className="groupe-vers" onClick={onOuvrir}>
      <span className="groupe-vers-titre">{titre}</span>
      {detail ? <span className="groupe-vers-detail">{detail}</span> : null}
      <span className="groupe-vers-cible">
        Décider dans {cible} <span aria-hidden="true">→</span>
      </span>
    </button>
  );
}

/** Ce qui tient sur une ligne de la file : l'objet de la proposition, sans répéter son type. */
function resumeCourt(p: PropositionApi): string {
  const d = p.details;
  if (d.type === "nouvel_item") return d.item.titre;
  if (d.type === "ordre_backlog") {
    const montees = d.mouvements.filter((m) => m.avant === null || (m.apres !== null && m.apres < m.avant)).length;
    return `${d.mouvements.length} mouvement${d.mouvements.length > 1 ? "s" : ""}, dont ${montees} montée${montees > 1 ? "s" : ""}`;
  }
  if (d.type === "effort") return `${d.itemTitre} : ${d.avant} → ${d.apres}`;
  if (d.type === "story_prete" || d.type === "export_jira") return d.story.itemTitre;
  return p.resume;
}

/** Une proposition réduite à une ligne ; dépliée, la carte complète avec ses boutons. */
function LigneProposition({ p, ouverte, onBasculer, ...reste }: { p: PropositionApi; ouverte: boolean; onBasculer: () => void } & Omit<CartePropositionProps, "p" | "dansLigne">) {
  return (
    <li className={`ligne-file${ouverte ? " ligne-file-ouverte" : ""}`}>
      <button type="button" className="ligne-file-entete" aria-expanded={ouverte} onClick={onBasculer} title={p.resume}>
        <span className="ligne-file-type">{TYPE_PROPOSITION[p.type] ?? humaniser(p.type)}</span>
        <span className="ligne-file-resume">{resumeCourt(p)}</span>
        <span className="chevron" aria-hidden="true" />
      </button>
      {ouverte ? <CarteProposition p={p} dansLigne {...reste} /> : null}
    </li>
  );
}

/** Numéro de création d'une proposition (« PR012 » donne 12), 0 pour un identifiant d'une autre forme. */
function numeroProposition(id: string): number {
  const m = /^PR(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

function rang(type: string): number {
  const i = PRIORITE_PROPOSITION.indexOf(type);
  return i < 0 ? PRIORITE_PROPOSITION.length : i;
}

const LIBELLE_VERDICT: Record<string, string> = { different: "aucun élément ne correspond", incertain: "hésite" };

function libelleLecture(l: NonNullable<QuestionApi["lectures"]>[number]): string {
  return l.verdict === "meme_besoin" && l.titre ? `« ${l.titre} »` : (LIBELLE_VERDICT[l.verdict] ?? l.verdict);
}

/** « 2 sur 3 : « Mode sombre » ; 1 sur 3 : hésite » */
function resumerLectures(lectures: NonNullable<QuestionApi["lectures"]>): string {
  const groupes = new Map<string, number>();
  for (const l of lectures) groupes.set(libelleLecture(l), (groupes.get(libelleLecture(l)) ?? 0) + 1);
  return [...groupes.entries()].map(([cle, n]) => `${n} sur ${lectures.length} : ${cle}`).join(" ; ");
}

/** Pourquoi l'agent pose la question. « Mes lectures divergent » serait faux quand toutes hésitent de la même façon. */
function pourquoiJeDemande(lectures: NonNullable<QuestionApi["lectures"]>): string {
  const verdicts = new Set(lectures.map((l) => (l.verdict === "meme_besoin" ? `meme:${l.titre ?? ""}` : l.verdict)));
  if (verdicts.size === 1 && lectures[0]?.verdict === "incertain") return `Pourquoi je vous demande : mes ${lectures.length} lectures hésitent entre plusieurs éléments`;
  if (verdicts.size === 1 && lectures[0]?.verdict === "different") return `Pourquoi je vous demande : aucune de mes ${lectures.length} lectures ne trouve d'élément correspondant`;
  return `Pourquoi je vous demande : mes lectures divergent (${resumerLectures(lectures)})`;
}

/**
 * La phrase finale commune à toutes les options (« Votre choix remplace l'estimation de l'agent… ») :
 * elle est dite une fois sous les boutons plutôt que répétée dans chacun.
 */
function phraseCommune(effets: string[]): string | null {
  if (effets.length < 2) return null;
  const phrases = effets.map((e) => e.trim().split(/(?<=[.!?»])\s+(?=[A-ZÀ-Ý«])/));
  if (phrases.some((p) => p.length < 2)) return null;
  const derniere = phrases[0]![phrases[0]!.length - 1]!;
  return phrases.every((p) => p[p.length - 1] === derniere) ? derniere : null;
}

function sansPhrase(effet: string, phrase: string | null): string {
  if (!phrase) return effet;
  const t = effet.trim();
  return t.endsWith(phrase) ? t.slice(0, t.length - phrase.length).trim() : t;
}

const LONGUEUR_APERCU = 320;

interface CarteQuestionProps {
  q: QuestionApi;
  vueReference: string;
  rafraichir: (cles: Cle[]) => void;
  onOuvrirItem: (id: string) => void;
  onOuvrirFeedback: (id: string) => void;
}

function CarteQuestion({ q, vueReference, rafraichir, onOuvrirItem, onOuvrirFeedback }: CarteQuestionProps) {
  const notifier = useNotifier();
  const { verrouille, verrouiller } = useVerrouDecision();
  const [envoi, setEnvoi] = useState<string | null>(null);
  const [deplie, setDeplie] = useState(false);
  const ctx = q.contexte ?? {};
  const citation = typeof ctx.citation === "string" ? ctx.citation : null;
  const resume = typeof ctx.resume === "string" ? ctx.resume : null;
  const tirages = Array.isArray(ctx.tirages) ? ctx.tirages.filter((t): t is number => typeof t === "number") : [];
  const f = q.feedback;

  const repondre = async (choix: string, libelle: string) => {
    if (verrouille) return;
    verrouiller();
    setEnvoi(choix);
    try {
      const r = await api.repondreQuestion(q.id, choix);
      notifier(`Réponse enregistrée : « ${libelle} ».`, "succes");
      if (r?.itemCree) notifier("Nouvel élément créé au backlog, avec cette demande comme première preuve.", "info");
      if (r?.regleProposee) notifier(`L'agent en tire une règle à valider : « ${r.regleProposee.texte} » (onglet Doctrine).`, "info");
      // La formulation a échoué pendant la réponse : la file la reprend, et la règle arrivera dans l'onglet Doctrine.
      if (r?.reglePrevue) notifier("Réponse prise en compte. La règle n'a pas encore pu être formulée : l'agent réessaie, elle arrivera dans l'onglet Doctrine.", "info");
      rafraichir(["questions", "regles", "propositions", "classement", "moscow", "feedbacks", "journal", "sante", "etat"]);
    } catch (e) {
      notifier(`Réponse impossible : ${messageErreur(e)}`, "erreur");
      setEnvoi(null);
    }
  };

  const long = (f?.texte.length ?? 0) > LONGUEUR_APERCU;
  const commune = phraseCommune(q.options.map((o) => o.effet));
  const lectures = q.lectures ?? [];
  return (
    <article className={`question${q.urgente ? " question-urgente" : ""}`} aria-label={`Question ${TYPE_QUESTION[q.type] ?? q.type}${q.urgente ? ", urgente" : ""}`}>
      <div className="question-meta">
        <Badge ton={q.urgente ? "risque" : "doute"}>{q.urgente ? "urgent" : (TYPE_QUESTION[q.type] ?? q.type)}</Badge>
        {q.urgente ? <span className="discret">{TYPE_QUESTION[q.type] ?? q.type}</span> : null}
        {q.etat === "relancee" ? <Badge ton="discret">relancée</Badge> : null}
        <span className="discret question-date">{dateCourte(q.poseeLe)}</span>
      </div>
      <p className="question-enonce">{decimalesFr(q.enonce)}</p>

      {/* Le doute d'abord (décision 014) : le désaccord des tirages, lisible sans clic, puis les réponses. */}
      {q.type === "impact" && tirages.length > 0 ? <DesaccordTirages tirages={tirages} /> : null}
      {q.type === "impact" && q.verbatims.length > 0 ? (
        <div className="question-verbatims">
          {q.verbatims.slice(0, 2).map((v, i) => (
            <q key={i} className="citation">
              {v}
            </q>
          ))}
        </div>
      ) : null}
      {lectures.length > 0 ? <DesaccordLectures lectures={lectures} /> : null}
      {lectures.length > 0 && citation ? <q className="citation question-citation">{citation}</q> : null}
      {q.type === "fusion" && q.explication ? (
        <p className="question-compris">
          <span className="discret">Pourquoi fusionner : </span>
          {q.explication}
        </p>
      ) : null}

      <div className="options" role="group" aria-label="Réponses possibles">
        {q.options.map((o) => (
          <button key={o.valeur} type="button" className="option" disabled={envoi !== null || verrouille} onClick={() => void repondre(o.valeur, decimalesFr(o.libelle))} aria-label={`Répondre : ${o.libelle}. ${o.effet}`}>
            <span className="option-libelle">{envoi === o.valeur ? "Envoi…" : decimalesFr(o.libelle)}</span>
            <span className="option-effet">{sansPhrase(o.effet, commune)}</span>
          </button>
        ))}
      </div>
      {commune ? <p className="option-effet-commun">{commune}</p> : null}

      <details className="question-plus">
        <summary>{q.type === "impact" ? "Ma justification, l'élément en jeu" : "Le message, le client, l'élément en jeu"}</summary>
      {f ? (
        <div className="question-client">
          <BadgePlan plan={f.compte.plan} />
          <strong>{f.compte.nom}</strong>
          <span>{mrr(f.compte.mrr)}</span>
          <span className="discret">
            {LIBELLE_CANAL[f.canal] ?? f.canal} · {dateCourte(f.recuLe)}
          </span>
          {f.compte.risqueDepart ? <Badge ton="risque">risque de départ</Badge> : null}
        </div>
      ) : null}

      {resume && q.type === "rattachement" ? (
        <p className="question-compris">
          <span className="discret">L'agent a compris : </span>
          {resume}
        </p>
      ) : null}

      {f ? (
        <div className="question-message">
          <blockquote className={deplie || !long ? "" : "replie"}>
            <Surligne texte={f.texte} citations={citation ? [citation] : []} />
          </blockquote>
          <div className="question-liens">
            {long ? (
              <button type="button" className="lien" onClick={() => setDeplie((d) => !d)} aria-expanded={deplie}>
                {deplie ? "Replier le message" : "Lire tout le message"}
              </button>
            ) : null}
            <button type="button" className="lien" onClick={() => onOuvrirFeedback(f.id)}>
              Fiche du message {f.id}
            </button>
          </div>
        </div>
      ) : citation && lectures.length === 0 ? (
        <q className="citation">{citation}</q>
      ) : null}

      {lectures.length > 0 ? (
        <ul className="question-lectures">
          {lectures.map((l, i) => (
            <li key={i}>
              <strong>Lecture {i + 1}</strong> : {libelleLecture(l)}. {l.justification}
            </li>
          ))}
        </ul>
      ) : q.type === "rattachement" ? (
        <p className="discret">Pourquoi je vous demande : mes lectures de ce message ne concordent pas.</p>
      ) : null}

      {q.type === "impact" && q.explication ? (
        <p className="question-compris">
          <span className="discret">Ma justification : </span>
          {q.explication}
        </p>
      ) : null}
      {q.type === "impact" && q.verbatims.length > 2
        ? q.verbatims.slice(2).map((v, i) => (
            <q key={i} className="citation">
              {v}
            </q>
          ))
        : null}

      {q.items.length > 0 ? (
        <p className="question-items">
          <span className="discret">{q.items.length > 1 ? "Éléments en jeu : " : "Élément en jeu : "}</span>
          {q.items.map((i, n) => (
            <span key={i.id}>
              {n > 0 ? " · " : ""}
              <button type="button" className="lien" onClick={() => onOuvrirItem(i.id)} title={i.description ?? undefined}>
                {i.titre}
              </button>{" "}
              <span className="discret">({i.preuvesSures} preuve{i.preuvesSures > 1 ? "s" : ""})</span>
            </span>
          ))}
        </p>
      ) : null}

      {q.type === "rattachement" && q.enjeu > 0 ? (
        <p className="discret">
          Enjeu : votre réponse peut faire gagner jusqu'à {nombre(q.enjeu, 1)} point{q.enjeu >= 2 ? "s" : ""} de score à l'un de ces éléments (vue {vueReference}).
        </p>
      ) : null}
      </details>
    </article>
  );
}

/** « 3 tirages disent 2 · 2 disent 3 » : les estimations d'Impact regroupées par valeur, sans pourcentage. */
function DesaccordTirages({ tirages }: { tirages: number[] }) {
  const groupes = [...tirages.reduce((m, t) => m.set(t, (m.get(t) ?? 0) + 1), new Map<number, number>()).entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return (
    <div className="desaccord" aria-label={`Mes ${tirages.length} estimations de l'Impact ne concordent pas`}>
      <p className="desaccord-titre">Mes {tirages.length} estimations ne concordent pas</p>
      <ul className="desaccord-groupes">
        {groupes.map(([valeur, n]) => (
          <li key={valeur} className="desaccord-groupe">
            <span className="desaccord-n">
              {n} tirage{n > 1 ? "s" : ""}
            </span>
            <span className="desaccord-valeur">Impact {nombre(valeur, 2)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Les lectures d'un message regroupées par verdict, côte à côte, chacune avec une justification. */
function DesaccordLectures({ lectures }: { lectures: NonNullable<QuestionApi["lectures"]> }) {
  const groupes = new Map<string, { n: number; justification: string }>();
  for (const l of lectures) {
    const cle = libelleLecture(l);
    const g = groupes.get(cle);
    if (g) g.n += 1;
    else groupes.set(cle, { n: 1, justification: l.justification });
  }
  return (
    <div className="desaccord" aria-label={pourquoiJeDemande(lectures)}>
      <p className="desaccord-titre">{groupes.size > 1 ? `Mes ${lectures.length} lectures divergent` : pourquoiJeDemande(lectures).replace(/^Pourquoi je vous demande : /, "").replace(/^./, (c) => c.toUpperCase())}</p>
      <ul className="desaccord-groupes">
        {[...groupes.entries()].map(([cle, g]) => (
          <li key={cle} className="desaccord-groupe desaccord-lecture">
            <span className="desaccord-n">
              {g.n} lecture{g.n > 1 ? "s" : ""} sur {lectures.length}
            </span>
            <span className="desaccord-valeur">{cle}</span>
            <span className="desaccord-justification">{g.justification}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface CartePropositionProps {
  p: PropositionApi;
  /** Dans une ligne dépliée de la file : le type et le résumé sont déjà dans la ligne. */
  dansLigne?: boolean;
  rafraichir: (cles: Cle[]) => void;
  onOuvrirItem: (id: string) => void;
  onOuvrirFeedback: (id: string) => void;
}

function CarteProposition({ p, dansLigne, rafraichir, onOuvrirItem, onOuvrirFeedback }: CartePropositionProps) {
  const notifier = useNotifier();
  const { verrouille, verrouiller } = useVerrouDecision();
  const [envoi, setEnvoi] = useState(false);

  const decider = async (accepter: boolean, portee?: "top") => {
    if (verrouille) return;
    verrouiller();
    setEnvoi(true);
    try {
      await api.deciderProposition(p.id, accepter, portee);
      notifier(
        portee === "top" ? "Le haut du classement proposé devient l'ordre officiel ; le reste garde son ordre." : accepter ? `Acceptée. ${p.effet}` : "Proposition refusée.",
        "succes",
      );
      rafraichir(["propositions", "regles", "classement", "moscow", "journal", "sante", "etat"]);
    } catch (e) {
      notifier(`Décision impossible : ${messageErreur(e)}`, "erreur");
      setEnvoi(false);
    }
  };

  const d = p.details;
  const aRevoir = (d.type === "story_prete" || d.type === "export_jira") && d.story.jugeOui < d.story.jugeTotal;
  return (
    <article className={`proposition${dansLigne ? " proposition-dans-ligne" : ""}`}>
      {dansLigne ? (
        <>
          {aRevoir ? <Badge ton="doute">le juge émet des réserves</Badge> : null}
          <p className="proposition-resume">{p.resume}</p>
        </>
      ) : (
        <>
          <div className="question-meta">
            <Badge ton="accent">{TYPE_PROPOSITION[p.type] ?? humaniser(p.type)}</Badge>
            {aRevoir ? <Badge ton="doute">le juge émet des réserves</Badge> : null}
            <span className="discret question-date">{dateCourte(p.creeeLe)}</span>
          </div>
          <p className="proposition-resume">{p.resume}</p>
        </>
      )}
      <DetailsProposition d={d} onOuvrirItem={onOuvrirItem} onOuvrirFeedback={onOuvrirFeedback} />
      <p className="proposition-effet">
        <span className="discret">Si vous acceptez : </span>
        {p.effet}
      </p>
      <div className="proposition-actions">
        {p.type === "ordre_backlog" ? (
          <button
            type="button"
            className="bouton bouton-principal"
            disabled={envoi || verrouille}
            onClick={() => void decider(true, "top")}
            title="Seul le top 5 proposé prend la tête de l'ordre officiel ; le reste du backlog garde son ordre, sans les reculs proposés."
          >
            Accepter le top 5
          </button>
        ) : null}
        <button
          type="button"
          className={p.type === "ordre_backlog" ? "bouton bouton-secondaire" : "bouton bouton-principal"}
          disabled={envoi || verrouille}
          onClick={() => void decider(true)}
          aria-label={`Accepter : ${p.resume}`}
        >
          {p.type === "ordre_backlog" ? "Tout accepter" : "Accepter"}
        </button>
        <button type="button" className="bouton bouton-secondaire" disabled={envoi || verrouille} onClick={() => void decider(false)} aria-label={`Refuser : ${p.resume}`}>
          Refuser
        </button>
      </div>
    </article>
  );
}

const MOUVEMENTS_VISIBLES = 8;

function DetailsProposition({ d, onOuvrirItem, onOuvrirFeedback }: { d: DetailsPropositionApi; onOuvrirItem: (id: string) => void; onOuvrirFeedback: (id: string) => void }) {
  const [tout, setTout] = useState(false);

  if (d.type === "nouvel_item") {
    return (
      <div className="question-contexte">
        <p>
          <button type="button" className="lien" onClick={() => onOuvrirItem(d.item.id)}>
            {d.item.titre}
          </button>{" "}
          <span className="discret">({d.item.type === "bug" ? "bug" : "fonctionnalité"})</span>
        </p>
        {d.sources.length === 0 ? <p className="discret">Aucun message source.</p> : null}
        {d.sources.map((s) => (
          <div key={s.feedbackId} className="proposition-source">
            <p>
              <BadgePlan plan={s.compte.plan} /> <strong>{s.compte.nom}</strong> <span className="discret">{mrr(s.compte.mrr)}</span>{" "}
              {s.nature ? <Badge ton={s.nature === "question" || s.nature === "bruit" ? "doute" : "discret"}>{LIBELLE_NATURE[s.nature] ?? s.nature}</Badge> : null}
            </p>
            <q className="citation">{s.citation}</q>
            <button type="button" className="lien" onClick={() => onOuvrirFeedback(s.feedbackId)}>
              Lire le message
            </button>
          </div>
        ))}
      </div>
    );
  }

  if (d.type === "regle") {
    return (
      <div className="question-contexte">
        <p>
          <span className="discret">Mots-clés qui déclencheront la règle : </span>
          {d.regle.motsCles.length > 0 ? d.regle.motsCles.map((m) => <code key={m} className="mot-cle">{m}</code>) : "aucun"}
        </p>
        <p>
          <span className="discret">Élément visé : </span>
          {d.regle.itemId ? (
            <button type="button" className="lien" onClick={() => onOuvrirItem(d.regle.itemId!)}>
              {d.regle.itemTitre ?? d.regle.itemId}
            </button>
          ) : (
            "?"
          )}
        </p>
        {d.apercu ? (
          <div className={d.apercu.bloquante ? "texte-risque" : ""}>
            <p>{d.apercu.resume}</p>
            {d.apercu.blocages.map((b, i) => (
              <p key={i}>{b}</p>
            ))}
            {d.apercu.proches.map((p, i) => (
              <p key={i} className="texte-doute">
                {p}
              </p>
            ))}
            <p className="discret">Le détail des demandes captées est dans l'onglet Doctrine.</p>
          </div>
        ) : null}
        {d.origine ? (
          <p>
            <span className="discret">Née de votre réponse « {d.origine.choix} » à : </span>
            {d.origine.question}
            {d.origine.citation ? (
              <>
                {" "}
                <q className="citation">{d.origine.citation}</q>
              </>
            ) : null}
            {d.origine.feedbackId ? (
              <>
                {" "}
                <button type="button" className="lien" onClick={() => onOuvrirFeedback(d.origine!.feedbackId!)}>
                  Lire le message
                </button>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
    );
  }

  if (d.type === "ordre_backlog") {
    const reculs = d.mouvements.filter((m) => m.avant !== null && (m.apres === null || m.apres > m.avant)).length;
    const visibles = tout ? d.mouvements : d.mouvements.slice(0, MOUVEMENTS_VISIBLES);
    return (
      <div className="question-contexte">
        <p className="discret">
          Classement de l'agent, vue {d.vue}, avec les mêmes rangs que le backlog vivant. {d.mouvements.length} élément{d.mouvements.length > 1 ? "s" : ""} change{d.mouvements.length > 1 ? "nt" : ""} de place, dont{" "}
          {reculs} recul{reculs > 1 ? "s" : ""}.
        </p>
        <ol className="mouvements">
          {visibles.map((m) => {
            const recul = m.avant !== null && (m.apres === null || m.apres > m.avant);
            return (
              <li key={m.itemId} className={recul ? "recul" : "montee"}>
                <button type="button" className="lien" onClick={() => onOuvrirItem(m.itemId)}>
                  {m.titre}
                </button>{" "}
                <span className="mouvement-rangs">
                  {m.avant ?? "nouveau"} → {m.apres ?? "retiré"} {recul ? "▼" : "▲"}
                </span>
              </li>
            );
          })}
        </ol>
        {d.mouvements.length > MOUVEMENTS_VISIBLES ? (
          <button type="button" className="lien" onClick={() => setTout((t) => !t)} aria-expanded={tout}>
            {tout ? "Afficher moins" : `Voir les ${d.mouvements.length} mouvements`}
          </button>
        ) : null}
      </div>
    );
  }

  if (d.type === "effort") {
    return (
      <div className="question-contexte">
        <p>
          <button type="button" className="lien" onClick={() => onOuvrirItem(d.itemId)}>
            {d.itemTitre}
          </button>{" "}
          <span className="discret">
            : taille {d.avant} → <strong>{d.apres}</strong>, estimée en rédigeant la story
          </span>
        </p>
        {d.scoreAvant !== null && d.scoreApres !== null ? (
          <p>
            Score {nombre(d.scoreAvant, 1)} → <strong>{nombre(d.scoreApres, 1)}</strong>
            {d.rangAvant && d.rangApres && d.rangAvant !== d.rangApres ? (
              <span className="discret">
                {" "}
                ({d.rangAvant} → {d.rangApres})
              </span>
            ) : null}
          </p>
        ) : null}
        <p className="discret">Un seul tirage du modèle : confirmez avec l'équipe si l'écart compte.</p>
      </div>
    );
  }

  if (d.type === "decoupage") {
    return (
      <div className="question-contexte">
        <p>
          <button type="button" className="lien" onClick={() => onOuvrirItem(d.itemId)}>
            {d.itemTitre}
          </button>
          {d.justification ? <span className="discret"> · {d.justification}</span> : null}
        </p>
        <ol className="decoupage-liste">
          {d.enfants.map((e) => (
            <li key={e.id}>
              {e.jeVeux} <span className="discret">· taille {e.complexite} · juge {e.jugeOui}/{e.jugeTotal}</span>
              {e.criteresNon.length > 0 ? <span className="texte-doute"> · pas {e.criteresNon.join(", pas ")}</span> : null}
            </li>
          ))}
        </ol>
        <p className="discret">Le détail de chaque story est dans l'onglet Stories.</p>
      </div>
    );
  }

  if (d.type === "story_prete" || d.type === "export_jira") {
    const s = d.story;
    return (
      <div className="question-contexte">
        <p>
          <button type="button" className="lien" onClick={() => onOuvrirItem(s.itemId)}>
            {s.itemTitre}
          </button>
        </p>
        <p>
          Contrôles du code : {s.controlesOk}/{s.controlesTotal} · Juge : {s.jugeOui}/{s.jugeTotal} critère{s.jugeTotal > 1 ? "s" : ""} remplis
        </p>
        {s.criteresNon.length > 0 ? <p className="texte-doute">Le juge relève : pas {s.criteresNon.join(", pas ")}.</p> : null}
        {s.commentaire ? <p className="discret">« {s.commentaire} »</p> : null}
      </div>
    );
  }

  return null;
}

type Ouvrir = { onOuvrirItem: (id: string) => void; onOuvrirFeedback: (id: string) => void };

function ouvrirCible(a: AlerteApi, { onOuvrirItem, onOuvrirFeedback }: Ouvrir): (() => void) | null {
  if (!a.cible) return null;
  const cible = a.cible;
  return () => (cible.type === "item" ? onOuvrirItem(cible.id) : onOuvrirFeedback(cible.id));
}

/** Les alertes urgentes, en tête de la file et en format court : le type, le message sur trois lignes, le lien. */
function Urgences({ alertes, ...ouvrir }: { alertes: AlerteApi[] | null } & Ouvrir) {
  const urgentes = (alertes ?? []).filter((a) => a.urgente);
  if (urgentes.length === 0) return null;
  return (
    <ul className="urgences" aria-label="Urgences">
      {urgentes.map((a) => {
        const voir = ouvrirCible(a, ouvrir);
        return (
          <li key={a.id} className="urgence">
            <p className="urgence-type">
              {TYPE_ALERTE[a.type] ?? humaniser(a.type)} <span className="urgence-date">· {dateCourte(a.creeeLe)}</span>
            </p>
            <p className="urgence-message" title={a.message}>
              {a.message}
            </p>
            {voir ? (
              <button type="button" className="lien" onClick={voir}>
                {a.cible!.type === "item" ? "Voir l'élément" : "Lire le message"}
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function LigneAlerte({ a, ...ouvrir }: { a: AlerteApi } & Ouvrir) {
  const voir = ouvrirCible(a, ouvrir);
  return (
    <li className="alerte">
      <div className="question-meta">
        <span className="alerte-type">{TYPE_ALERTE[a.type] ?? humaniser(a.type)}</span>
        <span className="discret question-date">{dateCourte(a.creeeLe)}</span>
      </div>
      <p>{a.message}</p>
      {voir ? (
        <button type="button" className="lien" onClick={voir}>
          {a.cible!.type === "item" ? "Voir l'élément" : "Lire le message"}
        </button>
      ) : null}
    </li>
  );
}

const ALERTES_VISIBLES = 8;

/** Ce qui informe sans attendre de décision : le dernier résumé et les alertes non urgentes, repliés en une ligne. */
function PourInfo({ alertes, erreur, ...ouvrir }: { alertes: AlerteApi[] | null; erreur: string | undefined } & Ouvrir) {
  const [tout, setTout] = useState(false);
  if (erreur && !alertes) return <ErreurPanneau message={erreur} />;
  if (!alertes) return null;
  const resume = alertes.find((a) => a.type === "resume");
  // Du plus récent au plus ancien.
  const autres = [...alertes].filter((a) => !a.urgente && a.type !== "resume").sort((a, b) => b.id - a.id);
  if (!resume && autres.length === 0) return null;
  const visibles = tout ? autres : autres.slice(0, ALERTES_VISIBLES);
  const sommaire = [resume ? `résumé du ${dateCourte(resume.creeeLe)}` : null, autres.length > 0 ? `${autres.length} alerte${autres.length > 1 ? "s" : ""}` : null].filter(Boolean).join(" · ");
  return (
    <details className="pour-info">
      <summary>
        <span className="pour-info-titre">Pour info</span> <span className="pour-info-sommaire">{sommaire}</span>
      </summary>
      {resume ? (
        <div className="resume-agent">
          <p className="alerte-type">
            Dernier résumé de l'agent <span className="discret">· {dateCourte(resume.creeeLe)}</span>
          </p>
          <p className="resume-texte">{resume.message}</p>
        </div>
      ) : null}
      {visibles.length > 0 ? (
        <ul className="alertes">
          {visibles.map((a) => (
            <LigneAlerte key={a.id} a={a} {...ouvrir} />
          ))}
        </ul>
      ) : null}
      {autres.length > ALERTES_VISIBLES ? (
        <button type="button" className="lien" onClick={() => setTout((t) => !t)} aria-expanded={tout}>
          {tout ? "Afficher moins" : `Afficher les ${autres.length} alertes`}
        </button>
      ) : null}
    </details>
  );
}
