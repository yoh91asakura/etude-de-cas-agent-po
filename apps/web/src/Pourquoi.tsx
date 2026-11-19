import { useEffect, useRef, useState } from "react";
import { api, messageErreur, type DetailItemApi, type FiltreVue, type LigneClassement } from "./api.ts";
import { dateCourte, ECHELLE_IMPACT, effort, euros, explicationFr, libelleImpact, LIBELLE_CANAL, mediane, nombre, PLANS, pourcent, reach, score, uniteReach } from "./format.ts";
import { CarteStory } from "./Stories.tsx";
import { Badge, BadgePlan, Chargement, ErreurPanneau, Garde, PuceRegle, Sparkline, useNotifier } from "./ui.tsx";

interface Props {
  itemId: string;
  filtres: FiltreVue[];
  versionDetails: number;
  titres: Map<string, string>;
  onFermer: () => void;
  onOuvrirItem: (id: string) => void;
  onOuvrirFeedback: (id: string) => void;
}

export function Pourquoi({ itemId, filtres, versionDetails, titres, onFermer, onOuvrirItem, onOuvrirFeedback }: Props) {
  const [detail, setDetail] = useState<{ id: string; d: DetailItemApi } | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const fermer = useRef<HTMLButtonElement>(null);
  const cleFiltres = filtres.join(",");

  useEffect(() => {
    let actif = true;
    api
      .item(itemId, cleFiltres ? (cleFiltres.split(",") as FiltreVue[]) : [])
      .then((d) => {
        if (!actif) return;
        setDetail({ id: itemId, d });
        setErreur(null);
      })
      .catch((e: unknown) => {
        if (actif) setErreur(messageErreur(e));
      });
    return () => {
      actif = false;
    };
  }, [itemId, cleFiltres, versionDetails]);

  // Focus sur « Fermer » à l'ouverture, retour au déclencheur à la fermeture, Échap pour fermer.
  useEffect(() => {
    const precedent = document.activeElement as HTMLElement | null;
    fermer.current?.focus();
    const touche = (e: KeyboardEvent) => {
      if (e.key === "Escape") onFermer();
    };
    window.addEventListener("keydown", touche);
    return () => {
      window.removeEventListener("keydown", touche);
      if (precedent && document.contains(precedent)) precedent.focus();
    };
  }, [onFermer]);

  const d = detail && detail.id === itemId ? detail.d : null;
  const l = d?.ligne ?? null;
  const titre = l?.titre ?? titres.get(itemId) ?? itemId;

  return (
    <>
      <div className="voile" onClick={onFermer} aria-hidden="true" />
      <aside className="tiroir" role="dialog" aria-modal="true" aria-labelledby="titre-tiroir">
        <div className="tiroir-entete">
          <div>
            <p className="surtitre">Pourquoi ce score ?{l ? (l.statut === "candidat" ? ` · candidat, se placerait au rang ${l.rang}` : ` · rang ${l.rang}`) : ""}</p>
            <h2 id="titre-tiroir">{titre}</h2>
          </div>
          <button ref={fermer} type="button" className="bouton-icone" onClick={onFermer} aria-label="Fermer le détail">
            ×
          </button>
        </div>
        <div className="tiroir-corps">
          {erreur && !d ? <ErreurPanneau message={erreur} /> : null}
          {!d && !erreur ? <Chargement /> : null}
          {d ? (
            <Garde nom="détail de l'item">
              <ContenuDetail itemId={itemId} d={d} titres={titres} onOuvrirItem={onOuvrirItem} onOuvrirFeedback={onOuvrirFeedback} />
            </Garde>
          ) : null}
        </div>
      </aside>
    </>
  );
}

function ContenuDetail({
  itemId,
  d,
  titres,
  onOuvrirItem,
  onOuvrirFeedback,
}: {
  itemId: string;
  d: DetailItemApi;
  titres: Map<string, string>;
  onOuvrirItem: (id: string) => void;
  onOuvrirFeedback: (id: string) => void;
}) {
  const l = d.ligne;
  const stories = d.stories?.length ? d.stories : d.story ? [d.story] : [];
  const historique = (d.historique ?? []).map((h) => h.score).filter((v) => Number.isFinite(v));
  return (
    <>
      {d.description ? <p className="description">{d.description}</p> : null}

      {l ? (
        <>
          <Formule l={l} />
          <CorrigerEffort itemId={itemId} complexite={l.complexite} />
          {l.explication ? (
            <section className="bloc">
              <h3>Dernier changement</h3>
              <p className="explication">{explicationFr(l.explication)}</p>
            </section>
          ) : null}
          {historique.length > 0 ? (
            <section className="bloc bloc-ligne">
              <h3>Historique du score</h3>
              <div className="historique">
                <Sparkline valeurs={historique} />
                <span className="historique-legende">
                  {historique.length} calcul{historique.length > 1 ? "s" : ""} · dernier : {score(historique[historique.length - 1])}
                </span>
              </div>
            </section>
          ) : null}
          <Segments l={l} />
          <Tirages l={l} justification={d.justificationImpact} valeurJustification={d.valeurJustificationImpact ?? null} />
        </>
      ) : (
        <p className="aide">Cet item n'est pas classé (terminé ou sans score pour ces filtres).</p>
      )}

      <Preuves itemId={itemId} d={d} titres={titres} onOuvrirItem={onOuvrirItem} onOuvrirFeedback={onOuvrirFeedback} />

      {stories.length > 0 ? (
        <section className="bloc">
          <h3>{stories.length > 1 ? `Les ${stories.length} stories de l'élément, après découpage` : "Story rédigée par l'agent"}</h3>
          {stories.map((s) => (
            <CarteStory key={s.id} story={s} titre={null} />
          ))}
        </section>
      ) : null}
    </>
  );
}

function Formule({ l }: { l: LigneClassement }) {
  const multiplicateurs = l.multiplicateurs ?? [];
  const produit = multiplicateurs.reduce((a, m) => a * m.valeur, 1);
  const recalcule = l.effort > 0 ? (l.reach * l.impact * l.confidence * produit) / l.effort : NaN;
  const coherent = Number.isFinite(recalcule) && Math.abs(recalcule - l.score) <= Math.max(0.01, Math.abs(l.score) * 0.01);
  return (
    <section className="bloc">
      <h3>Le calcul (fait par le code)</h3>
      <div className="formule" aria-label="Formule RICE avec les valeurs">
        <Facteur lettre="R" nom="Reach" valeur={reach(l.reach, l.uniteReach)} note={uniteReach(l.uniteReach)} />
        <span className="op">×</span>
        <Facteur lettre="I" nom="Impact" valeur={nombre(l.impact, 2)} note="médiane de 5 jugements" />
        <span className="op">×</span>
        <Facteur lettre="C" nom="Confidence (confiance)" valeur={pourcent(l.confidence)} note="monte avec le nombre de comptes et de canaux" />
        {multiplicateurs.map((m) => (
          <span key={m.raison} className="formule-groupe">
            <span className="op">×</span>
            <Facteur lettre="m" nom="Multiplicateur" valeur={nombre(m.valeur, 2)} note={m.raison} />
          </span>
        ))}
        <span className="op">÷</span>
        <Facteur lettre="E" nom="Effort" valeur={nombre(l.effort, 2)} note={`${effort(l.effort)} (taille ${l.complexite})`} />
        {/* « = » et le résultat passent à la ligne ensemble quand un multiplicateur allonge la formule. */}
        <span className="formule-egal">
          <span className="op">=</span>
          <span className="formule-resultat">{score(l.score)}</span>
        </span>
      </div>
      {!coherent ? <p className="aide">Score fourni par le moteur de calcul ; certains arrondis ne sont pas affichés.</p> : null}
      {l.uniteReach === "kEUR" ? <ExplicationReachMrr l={l} /> : null}
      {multiplicateurs.length === 0 ? (
        <p className="aide">
          Aucun multiplicateur. {l.uniteReach === "kEUR" ? "Le filtre « MRR » ne multiplie pas le score : il change ce que mesure le Reach." : "Le filtre « MRR » est inactif."} Le bonus « objectif du trimestre » ne s'applique qu'aux éléments alignés sur l'objectif, quand ce filtre est actif.
        </p>
      ) : null}
    </section>
  );
}

/** Avec le filtre MRR, le Reach est le revenu mensuel des comptes demandeurs, majoré pour ceux qui menacent de partir. */
function ExplicationReachMrr({ l }: { l: LigneClassement }) {
  const seg = l.parSegment;
  if (!seg) return null;
  const mrrComptes = PLANS.reduce((a, p) => a + (seg[p]?.mrr ?? 0), 0) / 1000;
  const majoration = l.reach - mrrComptes;
  return (
    <p className="aide">
      Avec le filtre « MRR », le Reach est le revenu mensuel des comptes qui demandent cet élément : {nombre(mrrComptes, 1)} k€
      {majoration > 0.05 ? `, plus ${nombre(majoration, 1)} k€ de majoration pour les comptes à risque de départ` : ""}.
    </p>
  );
}

function Facteur({ lettre, nom, valeur, note }: { lettre: string; nom: string; valeur: string; note: string }) {
  return (
    <span className="facteur" title={nom}>
      <span className="facteur-lettre">{lettre}</span>
      <span className="facteur-valeur">{valeur}</span>
      <span className="facteur-note">{note}</span>
    </span>
  );
}

function Segments({ l }: { l: LigneClassement }) {
  const seg = l.parSegment;
  if (!seg) return null;
  const total = PLANS.reduce(
    (acc, p) => ({ comptes: acc.comptes + (seg[p]?.comptes ?? 0), messages: acc.messages + (seg[p]?.messages ?? 0), mrr: acc.mrr + (seg[p]?.mrr ?? 0) }),
    { comptes: 0, messages: 0, mrr: 0 },
  );
  return (
    <section className="bloc">
      <h3>Qui le demande ?</h3>
      <p className="aide">Le nombre de comptes (qui fait le Reach) est distinct du volume de messages : un client bavard ne compte qu'une fois.</p>
      <table className="tableau">
        <thead>
          <tr>
            <th scope="col">Segment</th>
            <th scope="col">Comptes</th>
            <th scope="col">Messages</th>
            <th scope="col">MRR</th>
          </tr>
        </thead>
        <tbody>
          {PLANS.map((p) => (
            <tr key={p}>
              <th scope="row">
                <BadgePlan plan={p} />
              </th>
              <td>{seg[p]?.comptes ?? 0}</td>
              <td>{seg[p]?.messages ?? 0}</td>
              <td>{euros(seg[p]?.mrr ?? 0)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td>{total.comptes}</td>
            <td>{total.messages}</td>
            <td>{euros(total.mrr)}</td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

function Tirages({ l, justification, valeurJustification }: { l: LigneClassement; justification: string | null; valeurJustification: number | null }) {
  const tirages = l.tiragesImpact ?? [];
  const med = mediane(tirages);
  const echelle = [...new Set([...ECHELLE_IMPACT, ...tirages])].sort((a, b) => a - b);
  const largeur = 360;
  const marge = 24;
  const pas = echelle.length > 1 ? (largeur - marge * 2) / (echelle.length - 1) : 0;
  const x = (v: number) => marge + echelle.indexOf(v) * pas;
  const empiles = new Map<number, number>();
  const doute = l.ecartImpact > 1;

  return (
    <section className="bloc">
      <h3>L'Impact : 5 jugements du LLM</h3>
      {tirages.length === 0 ? (
        <p className="aide">Pas encore de tirages d'Impact pour cet item.</p>
      ) : (
        <>
          <svg className="tirages" viewBox={`0 0 ${largeur} 92`} width="100%" role="img" aria-label={`Tirages : ${tirages.map((t) => nombre(t, 2)).join(", ")}. Médiane retenue : ${med === null ? "aucune" : nombre(med, 2)}.`}>
            <line x1={marge} x2={largeur - marge} y1={62} y2={62} className="tirages-axe" />
            {echelle.map((v) => (
              <g key={v}>
                <line x1={x(v)} x2={x(v)} y1={58} y2={66} className="tirages-axe" />
                <text x={x(v)} y={84} textAnchor="middle" className="tirages-graduation">
                  {nombre(v, 2)}
                </text>
              </g>
            ))}
            {med !== null ? <rect x={x(med) - 13} y={4} width={26} height={62} rx={6} className="tirages-mediane" /> : null}
            {tirages.map((t, i) => {
              const n = empiles.get(t) ?? 0;
              empiles.set(t, n + 1);
              return <circle key={i} cx={x(t)} cy={52 - n * 11} r={5} className={doute ? "tirage tirage-doute" : "tirage"} />;
            })}
          </svg>
          <p className="tirages-legende">
            Médiane des tirages : <strong>{med === null ? "—" : libelleImpact(med)}</strong>
            {l.impactTranchePO ? (
              <>
                {" "}
                · Impact retenu par le PO : <strong>{libelleImpact(l.impact)}</strong>
              </>
            ) : null}
            {doute ? <Badge ton="doute">écart de {l.ecartImpact} crans : l'agent doute</Badge> : <span className="discret"> · écart de {l.ecartImpact} cran{l.ecartImpact > 1 ? "s" : ""}</span>}
          </p>
        </>
      )}
      {justification ? (
        <>
          {/* Un jugement ancien garde la justification du premier tirage : on dit sa valeur quand elle diffère de la médiane. */}
          {valeurJustification !== null && med !== null && valeurJustification !== med ? (
            <p className="aide">
              Justification d'un tirage à <strong>{libelleImpact(valeurJustification)}</strong>, pas de la médiane.
            </p>
          ) : null}
          <blockquote className="justification">{justification}</blockquote>
        </>
      ) : null}
    </section>
  );
}

/** D'où vient le rattachement d'une preuve : le PO veut savoir qui a décidé. */
function provenance(p: DetailItemApi["preuves"][number]): string {
  if (!p.sure) return "en attente de votre réponse";
  if (p.regleId) return `rattachée par la règle ${p.regleId}`;
  if (p.itemOrigine && !p.origineFusionnee) return "rattachée par votre réponse";
  if (p.origineFusionnee) return "venue d'une fusion";
  return "rattachée par l'agent (lectures concordantes)";
}

function Preuves({
  itemId,
  d,
  titres,
  onOuvrirItem,
  onOuvrirFeedback,
}: {
  itemId: string;
  d: DetailItemApi;
  titres: Map<string, string>;
  onOuvrirItem: (id: string) => void;
  onOuvrirFeedback: (id: string) => void;
}) {
  const preuves = d.preuves ?? [];
  const sures = preuves.filter((p) => p.sure).length;
  return (
    <section className="bloc">
      <h3>
        Les verbatims cités <span className="discret">({sures} compté{sures > 1 ? "s" : ""} sur {preuves.length})</span>
      </h3>
      {preuves.length === 0 ? <p className="aide">Aucun verbatim rattaché pour l'instant.</p> : null}
      <ul className="preuves">
        {preuves.map((p) => (
          <li key={p.id} className={`preuve${p.sure ? "" : " preuve-incertaine"}`}>
            <div className="preuve-meta">
              <strong>{p.compte.nom}</strong>
              <BadgePlan plan={p.compte.plan} />
              <span>{LIBELLE_CANAL[p.canal] ?? p.canal}</span>
              <span>{dateCourte(p.recuLe)}</span>
              {!p.sure ? <Badge ton="discret" titre="Rattachement incertain : en attente d'une réponse du PO">non comptée</Badge> : null}
              {p.regleId ? <PuceRegle id={p.regleId} /> : null}
            </div>
            <q className="citation">{p.citation}</q>
            <p className="preuve-origine">
              {provenance(p)} ·{" "}
              <button type="button" className="lien" onClick={() => onOuvrirFeedback(p.feedbackId)}>
                lire le message complet
              </button>
            </p>
            <RattacherAilleurs preuveId={p.id} itemId={itemId} sure={p.sure} titres={titres} />
            {p.itemOrigine ? (
              <p className="preuve-origine">
                déplacée depuis{" "}
                <button type="button" className="lien" onClick={() => onOuvrirItem(p.itemOrigine!)}>
                  {titres.get(p.itemOrigine) ?? p.itemOrigine}
                </button>
                {p.origineFusionnee ? (
                  <>
                    {" · "}
                    <DefaireFusion itemId={p.itemOrigine} />
                  </>
                ) : null}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {preuves.length > 0 ? <p className="aide">Chaque citation a été vérifiée mot pour mot contre le feedback source. Une citation grisée n'entre pas dans le score tant que le PO n'a pas tranché.</p> : null}
    </section>
  );
}

const TAILLES = ["S", "M", "L", "XL"] as const;

/**
 * Le PO corrige l'effort (audit du 15/11/2026) : c'est l'estimation la moins rigoureuse de l'agent, un seul tirage
 * sans contexte technique, et elle divise le score. La correction est journalisée et compte dans la Santé.
 */
function CorrigerEffort({ itemId, complexite }: { itemId: string; complexite: string }) {
  const notifier = useNotifier();
  const [taille, setTaille] = useState(complexite);
  const [envoi, setEnvoi] = useState(false);
  useEffect(() => setTaille(complexite), [complexite]);
  const corriger = async () => {
    setEnvoi(true);
    try {
      const r = await api.corrigerEffort(itemId, taille);
      notifier(`Effort corrigé : ${r.avant} → ${r.apres}. Le score est recalculé.`, "succes");
    } catch (e) {
      notifier(`Correction impossible : ${messageErreur(e)}`, "erreur");
    } finally {
      setEnvoi(false);
    }
  };
  return (
    <div className="correction">
      <label>
        <span className="discret">Taille : </span>
        <select value={taille} onChange={(e) => setTaille(e.target.value)} disabled={envoi} aria-label="Taille de l'élément">
          {TAILLES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="bouton bouton-petit" disabled={envoi || taille === complexite} onClick={() => void corriger()}>
        {envoi ? "Envoi…" : "Corriger l'effort"}
      </button>
      <span className="discret">Une estimation de l'agent, à confirmer avec l'équipe.</span>
    </div>
  );
}

/** Le PO rattache un verbatim à un autre élément, ou le retire de tout score. La preuve garde son élément d'origine. */
function RattacherAilleurs({ preuveId, itemId, sure, titres }: { preuveId: string; itemId: string; sure: boolean; titres: Map<string, string> }) {
  const notifier = useNotifier();
  const [ouvert, setOuvert] = useState(false);
  const [cible, setCible] = useState("");
  const [envoi, setEnvoi] = useState(false);
  const autres = [...titres.entries()].filter(([id]) => id !== itemId).sort((a, b) => a[1].localeCompare(b[1]));
  const rattacher = async () => {
    setEnvoi(true);
    try {
      await api.rattacherPreuve(preuveId, cible);
      notifier(cible === "ignorer" ? "Verbatim retiré : il ne compte plus dans aucun score." : `Verbatim rattaché à « ${titres.get(cible) ?? cible} ». Les deux scores sont recalculés.`, "succes");
      setOuvert(false);
    } catch (e) {
      notifier(`Rattachement impossible : ${messageErreur(e)}`, "erreur");
    } finally {
      setEnvoi(false);
    }
  };
  if (!ouvert) {
    return (
      <p className="preuve-origine">
        <button type="button" className="lien" onClick={() => setOuvert(true)}>
          {sure ? "rattacher ailleurs" : "trancher : rattacher ici ou ailleurs"}
        </button>
      </p>
    );
  }
  return (
    <div className="correction">
      <select value={cible} onChange={(e) => setCible(e.target.value)} disabled={envoi} aria-label="Élément auquel rattacher ce verbatim">
        <option value="">Choisir un élément…</option>
        {!sure ? <option value={itemId}>Le compter ici : {titres.get(itemId) ?? itemId}</option> : null}
        {autres.map(([id, t]) => (
          <option key={id} value={id}>
            {t}
          </option>
        ))}
        <option value="ignorer">Ne compter nulle part</option>
      </select>
      <button type="button" className="bouton bouton-petit" disabled={envoi || !cible} onClick={() => void rattacher()}>
        {envoi ? "Envoi…" : "Rattacher"}
      </button>
      <button type="button" className="lien" disabled={envoi} onClick={() => setOuvert(false)}>
        annuler
      </button>
    </div>
  );
}

/** La fusion est réversible : le PO peut rendre ses preuves à l'item absorbé. */
function DefaireFusion({ itemId }: { itemId: string }) {
  const notifier = useNotifier();
  const [enCours, setEnCours] = useState(false);
  return (
    <button
      type="button"
      className="lien"
      disabled={enCours}
      onClick={() => {
        setEnCours(true);
        api
          .defaireFusion(itemId)
          .then((r) => notifier(`Fusion défaite : ${r.preuvesRendues} preuve(s) rendue(s).`, "succes"))
          .catch((e) => notifier(messageErreur(e), "erreur"))
          .finally(() => setEnCours(false));
      }}
    >
      défaire la fusion
    </button>
  );
}
