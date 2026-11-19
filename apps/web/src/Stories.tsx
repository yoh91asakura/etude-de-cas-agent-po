import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, messageErreur, type DetailItemApi, type FiltreVue, type LigneClassement, type ModificationStoryApi, type StoryApi } from "./api.ts";
import type { Cle } from "./donnees.ts";
import { LIBELLE_CONTROLE, LIBELLE_JUGEMENT } from "./format.ts";
import { Aide, Badge, Chargement, ErreurPanneau, Garde, useNotifier, Vide } from "./ui.tsx";

const LIBELLE_STATUT_STORY: Record<StoryApi["statut"], string> = {
  brouillon: "brouillon",
  prete: "prête",
  exportee: "exportée",
  proposee: "proposée",
  remplacee: "remplacée",
  refusee: "écartée",
};
const MAX_STORIES = 12;

interface Props {
  lignes: LigneClassement[] | null;
  filtres: FiltreVue[];
  versionDetails: number;
  onPourquoi: (id: string) => void;
  rafraichir: (cles: Cle[]) => void;
  /** Ouverte depuis la file « À décider » : n'afficher d'abord que ce qui attend le PO. */
  aValiderSeulement?: boolean;
}

interface Groupe {
  ligne: LigneClassement;
  detail: DetailItemApi;
}

/** Après une décision du PO, les panneaux qui en dépendent. */
const APRES_DECISION: Cle[] = ["etat", "propositions", "classement", "moscow", "journal", "sante"];

export function Stories({ lignes, filtres, versionDetails, onPourquoi, rafraichir, aValiderSeulement = false }: Props) {
  const [seulementAValider, setSeulementAValider] = useState(aValiderSeulement);
  const [groupes, setGroupes] = useState<Groupe[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  // Jira branché ou non : sans lui, une story validée reste « prête » dans le cockpit.
  const [suiviBranche, setSuiviBranche] = useState<boolean | null>(null);
  // Rechargement local après une action, sans attendre le flux.
  const [version, setVersion] = useState(0);

  const avecStory = (lignes ?? []).filter((l) => l.aUneStory).slice(0, MAX_STORIES);
  const cle = avecStory.map((l) => l.itemId).join("|");
  const cleFiltres = filtres.join(",");

  useEffect(() => {
    let actif = true;
    api
      .etat()
      .then((e) => {
        if (actif) setSuiviBranche(typeof e.outilSuiviBranche === "boolean" ? e.outilSuiviBranche : null);
      })
      .catch(() => {
        // Sans réponse, on ne dit rien de Jira plutôt que d'affirmer à tort qu'il n'est pas branché.
        if (actif) setSuiviBranche(null);
      });
    return () => {
      actif = false;
    };
  }, [versionDetails]);

  useEffect(() => {
    if (!lignes) return;
    let actif = true;
    const cibles = (lignes ?? []).filter((l) => l.aUneStory).slice(0, MAX_STORIES);
    const f = cleFiltres ? (cleFiltres.split(",") as FiltreVue[]) : [];
    Promise.allSettled(cibles.map((l) => api.item(l.itemId, f).then((d) => ({ ligne: l, detail: d }))))
      .then((resultats) => {
        if (!actif) return;
        const ok = resultats.flatMap((r) => (r.status === "fulfilled" && (r.value.detail.stories ?? []).length > 0 ? [r.value] : []));
        const echec = resultats.find((r): r is PromiseRejectedResult => r.status === "rejected");
        setGroupes(ok);
        setErreur(echec && ok.length === 0 && cibles.length > 0 ? messageErreur(echec.reason) : null);
      })
      .catch((e: unknown) => {
        if (actif) setErreur(messageErreur(e));
      });
    return () => {
      actif = false;
    };
    // `lignes` change d'identité à chaque rechargement : la clé des items suffit à décider s'il faut recharger.
  }, [cle, cleFiltres, versionDetails, version, lignes === null]);

  const apres = () => {
    setVersion((v) => v + 1);
    rafraichir(APRES_DECISION);
  };

  // Ce qui attend le PO : une story à valider, ou un découpage à trancher.
  const aValider = (groupes ?? []).filter((g) => (g.detail.stories ?? []).some((s) => s.propositionValidation) || g.detail.decoupage);

  if (erreur && !groupes) return <ErreurPanneau message={erreur} />;
  if (!lignes || (!groupes && avecStory.length > 0)) return <Chargement texte="Chargement des stories…" />;
  if (avecStory.length === 0 || (groupes && groupes.length === 0)) {
    return (
      <Vide titre="Aucune story rédigée pour l'instant.">
        L'agent rédige un brouillon de story pour chaque item qui entre dans le top 5 du backlog. Il passe ensuite des contrôles dans le code, puis un juge LLM distinct.
      </Vide>
    );
  }
  return (
    <div className="stories">
      <div className="vue-outils">
        <div className="segment" role="group" aria-label="Stories affichées">
          <button type="button" className={`bouton segment-option${seulementAValider ? " segment-active" : ""}`} aria-pressed={seulementAValider} onClick={() => setSeulementAValider(true)}>
            À valider ({aValider.length})
          </button>
          <button type="button" className={`bouton segment-option${!seulementAValider ? " segment-active" : ""}`} aria-pressed={!seulementAValider} onClick={() => setSeulementAValider(false)}>
            Toutes ({groupes?.length ?? 0})
          </button>
        </div>
        {suiviBranche === false ? (
          <span className="stories-jira" role="note" title="Sans Jira, une story validée reste « prête » dans le cockpit.">
            Jira non connecté
          </span>
        ) : null}
        <Aide>
          Brouillons de l'agent pour les items les mieux classés. Deux vérifications indépendantes : des contrôles déterministes dans le code, puis un juge LLM au prompt distinct qui répond oui ou non critère
          par critère. Validez, réécrivez ou faites découper une story ici même. Sans Jira, une story validée reste « prête » dans le cockpit.
        </Aide>
      </div>
      {seulementAValider && aValider.length === 0 ? <p className="vide-court">Aucune story n'attend votre validation.</p> : null}
      {(seulementAValider ? aValider : groupes)?.map((g) => (
        <Garde key={g.ligne.itemId} nom={`stories ${g.ligne.itemId}`}>
          <GroupeStories groupe={g} onPourquoi={() => onPourquoi(g.ligne.itemId)} apres={apres} />
        </Garde>
      ))}
    </div>
  );
}

/** Les stories en vigueur d'un élément (plusieurs après un découpage), et le découpage que l'agent propose. */
function GroupeStories({ groupe, onPourquoi, apres }: { groupe: Groupe; onPourquoi: () => void; apres: () => void }) {
  const { ligne, detail } = groupe;
  const stories = detail.stories ?? [];
  const n = stories.length;
  return (
    <section className="groupe-stories" aria-label={`Stories de « ${ligne.titre} »`}>
      {stories.map((s, i) => (
        <CarteStory
          key={s.id}
          story={s}
          titre={n > 1 ? `${ligne.titre} · ${i + 1}/${n}` : ligne.titre}
          rang={ligne.rang}
          onPourquoi={onPourquoi}
          repliable
          actions={<ActionsStory story={s} enCours={(detail.decoupageEnCours ?? []).includes(s.id)} decoupagePropose={detail.decoupage?.storyId === s.id} apres={apres} />}
        />
      ))}
      {detail.decoupage ? <DecoupagePropose decoupage={detail.decoupage} titre={ligne.titre} apres={apres} /> : null}
    </section>
  );
}

/** Ce que le PO peut faire d'une story : la valider, la réécrire, ou demander à l'agent de la découper. */
function ActionsStory({ story, enCours, decoupagePropose, apres }: { story: StoryApi; enCours: boolean; decoupagePropose: boolean; apres: () => void }) {
  const notifier = useNotifier();
  const [envoi, setEnvoi] = useState<string | null>(null);
  const [edition, setEdition] = useState(false);
  const modifiable = story.statut === "brouillon" || story.statut === "prete";
  const verdict = verdictStory(story);
  const tropGrosse = verdict.refusesCles.includes("petite") || verdict.refusesCles.includes("un_seul_besoin");

  const agir = async (cle: string, action: () => Promise<unknown>, succes: string) => {
    setEnvoi(cle);
    try {
      await action();
      notifier(succes, "succes");
      apres();
    } catch (e) {
      notifier(`Action impossible : ${messageErreur(e)}`, "erreur");
    } finally {
      setEnvoi(null);
    }
  };

  if (!modifiable && !story.propositionValidation) return null;
  return (
    <div className="story-actions">
      <div className="story-actions-boutons">
        {story.propositionValidation ? (
          <button
            type="button"
            className="bouton bouton-principal"
            disabled={envoi !== null}
            onClick={() => void agir("valider", () => api.deciderProposition(story.propositionValidation!, true), "Story validée : elle passe « prête ».")}
          >
            {envoi === "valider" ? "Envoi…" : "Valider la story"}
          </button>
        ) : null}
        {modifiable ? (
          <button type="button" className="bouton bouton-secondaire" disabled={envoi !== null} aria-expanded={edition} onClick={() => setEdition((e) => !e)}>
            {edition ? "Fermer l'éditeur" : "Modifier"}
          </button>
        ) : null}
        {modifiable && tropGrosse && !decoupagePropose && !enCours ? (
          <button
            type="button"
            className="bouton bouton-secondaire"
            disabled={envoi !== null}
            title="Le juge la trouve trop grosse pour un sprint, ou mêlant plusieurs besoins : l'agent propose 2 à 4 stories plus petites, chacune jugée."
            onClick={() => void agir("decouper", () => api.decouperStory(story.id), "L'agent découpe la story : sa proposition arrive dans quelques secondes.")}
          >
            {envoi === "decouper" ? "Envoi…" : "Proposer un découpage"}
          </button>
        ) : null}
        {enCours ? <span className="discret">L'agent découpe cette story…</span> : null}
        {decoupagePropose ? <span className="discret">Un découpage attend votre décision, ci-dessous.</span> : null}
      </div>
      {edition ? (
        <EditeurStory
          story={story}
          onAnnuler={() => setEdition(false)}
          onEnregistrer={async (m) => {
            await agir("modifier", () => api.modifierStory(story.id, m), "Story enregistrée. Les contrôles du code sont refaits ; le verdict du juge reste celui de la version de l'agent.");
            setEdition(false);
          }}
        />
      ) : null}
    </div>
  );
}

/** Le PO réécrit la story. Les verbatims cités et la taille restent ceux de l'agent : chaque citation reste vérifiée. */
function EditeurStory({ story, onAnnuler, onEnregistrer }: { story: StoryApi; onAnnuler: () => void; onEnregistrer: (m: ModificationStoryApi) => Promise<void> }) {
  const [m, setM] = useState<ModificationStoryApi>({
    enTantQue: story.enTantQue ?? "",
    jeVeux: story.jeVeux ?? "",
    afinDe: story.afinDe ?? "",
    criteres: (story.criteres ?? []).map((c) => ({ ...c })),
    casLimites: [...(story.casLimites ?? [])],
  });
  const [envoi, setEnvoi] = useState(false);
  const champ = (cle: "enTantQue" | "jeVeux" | "afinDe", libelle: string) => (
    <label className="editeur-champ">
      <span>{libelle}</span>
      <textarea rows={2} value={m[cle]} onChange={(e) => setM({ ...m, [cle]: e.target.value })} />
    </label>
  );
  const critere = (i: number, cle: "etantDonne" | "quand" | "alors", valeur: string) =>
    setM({ ...m, criteres: m.criteres.map((c, j) => (j === i ? { ...c, [cle]: valeur } : c)) });
  const soumettre = async (e: FormEvent) => {
    e.preventDefault();
    setEnvoi(true);
    try {
      await onEnregistrer(m);
    } finally {
      setEnvoi(false);
    }
  };

  return (
    <form className="editeur-story" onSubmit={(e) => void soumettre(e)}>
      {champ("enTantQue", "En tant que")}
      {champ("jeVeux", "Je veux")}
      {champ("afinDe", "Afin de")}
      <fieldset>
        <legend>Critères d'acceptation</legend>
        {m.criteres.map((c, i) => (
          <div key={i} className="editeur-critere">
            <span className="editeur-numero">{i + 1}.</span>
            <div className="editeur-gwt">
              <label>
                <span className="mot-cle">Étant donné</span>
                <textarea rows={2} aria-label={`Critère ${i + 1} : étant donné`} value={c.etantDonne} onChange={(e) => critere(i, "etantDonne", e.target.value)} />
              </label>
              <label>
                <span className="mot-cle">Quand</span>
                <textarea rows={2} aria-label={`Critère ${i + 1} : quand`} value={c.quand} onChange={(e) => critere(i, "quand", e.target.value)} />
              </label>
              <label>
                <span className="mot-cle">Alors</span>
                <textarea rows={2} aria-label={`Critère ${i + 1} : alors`} value={c.alors} onChange={(e) => critere(i, "alors", e.target.value)} />
              </label>
            </div>
            <button type="button" className="lien" onClick={() => setM({ ...m, criteres: m.criteres.filter((_, j) => j !== i) })} aria-label={`Retirer le critère ${i + 1}`}>
              retirer
            </button>
          </div>
        ))}
        <button type="button" className="lien" onClick={() => setM({ ...m, criteres: [...m.criteres, { etantDonne: "", quand: "", alors: "" }] })}>
          Ajouter un critère
        </button>
      </fieldset>
      <label className="editeur-champ">
        <span>Cas limites, un par ligne</span>
        <textarea rows={3} value={m.casLimites.join("\n")} onChange={(e) => setM({ ...m, casLimites: e.target.value.split("\n") })} />
      </label>
      <p className="aide">Les verbatims cités et la taille restent ceux de l'agent. Les contrôles du code sont refaits à l'enregistrement ; le verdict du juge reste celui de la version de l'agent.</p>
      <div className="editeur-boutons">
        <button type="submit" className="bouton bouton-principal" disabled={envoi}>
          {envoi ? "Enregistrement…" : "Enregistrer"}
        </button>
        <button type="button" className="bouton bouton-secondaire" disabled={envoi} onClick={onAnnuler}>
          Annuler
        </button>
      </div>
    </form>
  );
}

/** Le découpage proposé par l'agent : les stories plus petites, chacune jugée, et la décision du PO. */
function DecoupagePropose({ decoupage, titre, apres }: { decoupage: NonNullable<DetailItemApi["decoupage"]>; titre: string; apres: () => void }) {
  const notifier = useNotifier();
  const [envoi, setEnvoi] = useState<boolean | null>(null);
  const decider = async (accepter: boolean) => {
    setEnvoi(accepter);
    try {
      await api.deciderProposition(decoupage.propositionId, accepter);
      notifier(accepter ? `Découpage accepté : ${decoupage.enfants.length} stories à valider pour « ${titre} ».` : "Découpage refusé : la story d'origine reste.", "succes");
      apres();
    } catch (e) {
      notifier(`Décision impossible : ${messageErreur(e)}`, "erreur");
    } finally {
      setEnvoi(null);
    }
  };
  return (
    <div className="decoupage" role="group" aria-label={`Découpage proposé pour « ${titre} »`}>
      <p className="decoupage-titre">
        <strong>Découpage proposé par l'agent</strong> : {decoupage.enfants.length} stories plus petites.
      </p>
      {decoupage.justification ? <p className="discret">{decoupage.justification}</p> : null}
      {decoupage.enfants.map((s, i) => (
        <CarteStory key={s.id} story={s} titre={`${titre} · ${i + 1}/${decoupage.enfants.length}`} repliable />
      ))}
      <div className="editeur-boutons">
        <button type="button" className="bouton bouton-principal" disabled={envoi !== null} onClick={() => void decider(true)}>
          {envoi === true ? "Envoi…" : "Accepter le découpage"}
        </button>
        <button type="button" className="bouton bouton-secondaire" disabled={envoi !== null} onClick={() => void decider(false)}>
          {envoi === false ? "Envoi…" : "Refuser"}
        </button>
      </div>
      <p className="aide">Accepter remplace la story d'origine par ces stories, chacune à valider ensuite. Refuser garde la story d'origine.</p>
    </div>
  );
}

/** « En tant que administratrice » devient « En tant qu'administratrice » ; idem pour « afin de », qui devient « afin » devant « que ». */
function elider(mot: string, suite: string | undefined): string {
  if (mot === "afin de" && /^qu/i.test((suite ?? "").trim())) return "afin";
  return /^[aeiouyàâäéèêëîïôöûüœ]/i.test((suite ?? "").trim()) ? `${mot.slice(0, -1)}'` : mot;
}

/** Le mot-clé, puis la suite : sans espace après une apostrophe (« qu'administratrice »). */
function Debut({ mot, suite }: { mot: string; suite: string | undefined }) {
  const debut = elider(mot, suite);
  return (
    <>
      <span className="mot-cle">{debut}</span>
      {debut.endsWith("'") ? "" : " "}
    </>
  );
}

const estOui = (v: unknown) => v === true || v === "oui";
const estNon = (v: unknown) => v === false || v === "non";

/** Le verdict d'une story en chiffres et en clair : ce que les contrôles du code et le juge ont refusé. */
function verdictStory(story: StoryApi) {
  const controles = story.controles ?? [];
  const jugement = story.jugement ?? null;
  const criteresJuge = jugement ? Object.entries(jugement).filter(([k]) => k !== "commentaire") : [];
  const refusesCles = criteresJuge.filter(([, v]) => estNon(v)).map(([k]) => k);
  const refuses = refusesCles.map((k) => LIBELLE_JUGEMENT[k] ?? k);
  const controlesKo = controles.filter((c) => !c.ok).map((c) => LIBELLE_CONTROLE[c.nom] ?? c.nom);
  return {
    controlesOk: controles.length - controlesKo.length,
    controlesTotal: controles.length,
    controlesKo,
    juge: jugement !== null,
    jugeOui: criteresJuge.filter(([, v]) => estOui(v)).length,
    jugeTotal: criteresJuge.length,
    refuses,
    refusesCles,
    commentaire: jugement && typeof jugement.commentaire === "string" && jugement.commentaire.trim() ? jugement.commentaire : null,
    // « À revoir » suit le seul juge, comme dans la boîte de l'agent : un contrôle de forme en échec reste affiché en clair.
    aRevoir: refuses.length > 0,
  };
}

function chiffresVerdict(v: ReturnType<typeof verdictStory>): string {
  const code = `Contrôles du code : ${v.controlesOk}/${v.controlesTotal}`;
  const juge = v.juge ? `Juge : ${v.jugeOui}/${v.jugeTotal}` : "Juge : pas de verdict";
  return `${code} · ${juge}`;
}

function LigneVerdict({ verdict, modifiee }: { verdict: ReturnType<typeof verdictStory>; modifiee: boolean }) {
  return (
    <div className={`story-verdict${verdict.aRevoir ? " story-verdict-revoir" : ""}`}>
      <p className="story-verdict-chiffres">
        <strong>{chiffresVerdict(verdict)}</strong>
        {verdict.aRevoir ? (
          <Badge ton="doute" titre="Le juge refuse au moins un critère : relisez la story avant de la valider">
            à revoir
          </Badge>
        ) : null}
      </p>
      {verdict.refuses.length > 0 ? <p className="story-verdict-refus">Refusé par le juge : {verdict.refuses.join(", ")}.</p> : null}
      {verdict.controlesKo.length > 0 ? <p className="story-verdict-refus">En échec dans le code : {verdict.controlesKo.join(", ")}.</p> : null}
      {verdict.commentaire ? <p className="commentaire-juge">Le juge : « {verdict.commentaire} »</p> : null}
      {modifiee && verdict.juge ? <p className="discret">Vous avez réécrit cette story : le verdict du juge porte sur la version de l'agent.</p> : null}
    </div>
  );
}

/** Les badges d'état d'une story : réécrite par le PO, issue d'un découpage, dépassée par de nouvelles preuves. */
function BadgesEtat({ story }: { story: StoryApi }) {
  return (
    <>
      {story.parentId ? <Badge ton="discret" titre={`Issue du découpage de la story ${story.parentId}`}>découpée</Badge> : null}
      {story.modifiee ? <Badge ton="accent" titre="Vous avez réécrit cette story">modifiée par vous</Badge> : null}
      {(story.preuvesDepuisRedaction ?? 0) > 0 ? (
        <Badge ton="doute" titre="Des verbatims sont arrivés après la rédaction : la story ne les a pas lus.">
          {story.preuvesDepuisRedaction} preuve{story.preuvesDepuisRedaction > 1 ? "s" : ""} depuis la rédaction
        </Badge>
      ) : null}
    </>
  );
}

export function CarteStory({
  story,
  titre,
  rang,
  onPourquoi,
  repliable = false,
  actions,
}: {
  story: StoryApi;
  titre: string | null;
  rang?: number;
  onPourquoi?: () => void;
  /** Repliée par défaut, avec une ligne de résumé (onglet Stories) ; dépliée sinon (tiroir « Pourquoi ? »). */
  repliable?: boolean;
  /** Les décisions du PO sur cette story, visibles même repliée (onglet Stories). */
  actions?: ReactNode;
}) {
  const [ouverte, setOuverte] = useState(!repliable);
  const controles = story.controles ?? [];
  const jugement = story.jugement ?? null;
  const criteresJuge = jugement ? Object.entries(jugement).filter(([k]) => k !== "commentaire") : [];
  const verdict = verdictStory(story);
  const statut = LIBELLE_STATUT_STORY[story.statut] ?? story.statut;
  const idCorps = `story-corps-${story.id}`;

  return (
    <article className={`story${repliable && !ouverte ? " story-repliee" : ""}`}>
      {titre ? (
        <header className="story-entete">
          <h3>
            {rang !== undefined ? <span className="story-rang">#{rang}</span> : null}
            {titre}
          </h3>
          <div className="story-entete-droite">
            {!repliable ? <Badge ton={story.statut === "brouillon" ? "discret" : "accent"}>{statut}</Badge> : null}
            {!repliable && story.complexite ? <Badge titre="Complexité estimée">taille {story.complexite}</Badge> : null}
            {!repliable ? <BadgesEtat story={story} /> : null}
            {story.ticket ? (
              <a className="lien" href={story.ticket.url} target="_blank" rel="noreferrer" title="Ticket créé dans l'outil de l'équipe après décision du PO">
                {story.ticket.cle}
              </a>
            ) : null}
            {onPourquoi ? (
              <button type="button" className="bouton bouton-pourquoi" onClick={onPourquoi} aria-label={`Pourquoi « ${titre} » est classé ainsi ?`}>
                Pourquoi ?
              </button>
            ) : null}
          </div>
        </header>
      ) : null}

      {repliable ? (
        <button type="button" className="story-resume" aria-expanded={ouverte} aria-controls={idCorps} onClick={() => setOuverte((o) => !o)}>
          <span className="story-chevron" aria-hidden="true">
            {ouverte ? "▾" : "▸"}
          </span>
          <span className="story-resume-besoin">
            <Debut mot="En tant que" suite={story.enTantQue} />
            {story.enTantQue}, <span className="mot-cle">je veux</span> {story.jeVeux}
          </span>
          <span className="story-resume-meta">
            {story.complexite ? <Badge titre="Complexité estimée">taille {story.complexite}</Badge> : null}
            <span className="story-resume-verdict">{chiffresVerdict(verdict)}</span>
            {verdict.aRevoir ? <Badge ton="doute">à revoir</Badge> : null}
            <Badge ton={story.statut === "brouillon" || story.statut === "proposee" ? "discret" : "accent"} titre="Statut de la story">
              {statut}
            </Badge>
            <BadgesEtat story={story} />
            <span className="visuellement-cache">{ouverte ? "Replier la story" : "Déplier la story"}</span>
          </span>
        </button>
      ) : null}

      {actions}

      {ouverte ? (
        <div id={idCorps} className="story-corps">
          <LigneVerdict verdict={verdict} modifiee={story.modifiee === true} />

          <p className="story-phrase">
            <Debut mot="En tant que" suite={story.enTantQue} />
            {story.enTantQue}, <span className="mot-cle">je veux</span> {story.jeVeux}, <Debut mot="afin de" suite={story.afinDe} />
            {story.afinDe}.
          </p>

          {story.criteres?.length ? (
            <>
              <h4>Critères d'acceptation</h4>
              <ol className="criteres">
                {story.criteres.map((c, i) => (
                  <li key={i}>
                    <span className="gwt">
                      <span className="mot-cle">Étant donné</span> {c.etantDonne}
                    </span>
                    <span className="gwt">
                      <span className="mot-cle">Quand</span> {c.quand}
                    </span>
                    <span className="gwt">
                      <span className="mot-cle">Alors</span> {c.alors}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          ) : null}

          {story.casLimites?.length ? (
            <>
              <h4>Cas limites</h4>
              <ul className="cas-limites">
                {story.casLimites.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </>
          ) : null}

          {story.citations?.length ? (
            <>
              <h4>Verbatims cités</h4>
              <ul className="story-citations">
                {story.citations.map((c, i) => (
                  <li key={i}>
                    <q className="citation">{c}</q>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <div className="verifs">
            <div>
              <h4>Contrôles du code</h4>
              <ul className="controles">
                {controles.map((c) => (
                  <li key={c.nom} className={c.ok ? "ok" : "ko"}>
                    <span className="coche" aria-label={c.ok ? "réussi" : "échoué"}>
                      {c.ok ? "✓" : "✗"}
                    </span>
                    <span>
                      {LIBELLE_CONTROLE[c.nom] ?? c.nom}
                      {c.detail && !c.ok ? <span className="discret"> · {c.detail}</span> : null}
                    </span>
                  </li>
                ))}
                {controles.length === 0 ? <li className="discret">Aucun contrôle enregistré.</li> : null}
              </ul>
            </div>
            <div>
              <h4>Juge LLM (prompt distinct)</h4>
              {jugement ? (
                <ul className="controles">
                  {criteresJuge.map(([k, v]) => {
                    const oui = estOui(v);
                    const non = estNon(v);
                    return (
                      <li key={k} className={oui ? "ok" : non ? "ko" : ""}>
                        <span className={`reponse-juge ${oui ? "oui" : non ? "non" : ""}`}>{oui ? "oui" : non ? "non" : String(v)}</span>
                        <span>{LIBELLE_JUGEMENT[k] ?? k}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="discret">Le juge ne s'est pas prononcé.</p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}
