import { useEffect, useState, type ReactNode } from "react";
import { api, messageErreur, type FiltreVue, type LigneClassement, type LigneOfficielle } from "./api.ts";
import type { Mouvement, Mouvements } from "./donnees.ts";
import { explicationFr, mrr, score } from "./format.ts";
import { Aide, Badge, Chargement, ErreurPanneau, PuceRegle, Vide } from "./ui.tsx";

type Vue = "propose" | "moscow" | "officiel";

interface Props {
  lignes: LigneClassement[] | null;
  erreur: string | undefined;
  mouvements: Mouvements;
  filtres: FiltreVue[];
  itemOuvert: string | null;
  onPourquoi: (id: string) => void;
}

const VUES: Array<{ id: Vue; libelle: string }> = [
  { id: "propose", libelle: "Proposé par l'agent" },
  { id: "moscow", libelle: "MoSCoW" },
  { id: "officiel", libelle: "Validé par le PO" },
];

/** Le backlog et ses trois lectures (décision 014) : le classement de l'agent, le découpage MoSCoW, l'ordre validé par le PO. */
export function Backlog({ vueMoscow, ...props }: Props & { vueMoscow: ReactNode }) {
  const [vue, setVue] = useState<Vue>("propose");
  const candidats = (props.lignes ?? []).some((l) => l.statut === "candidat");
  return (
    <div className="backlog-vues">
      <div className="vue-outils">
        <div className="segment" role="group" aria-label="Quelle vue du backlog afficher">
          {VUES.map((v) => (
            <button key={v.id} type="button" className={`bouton segment-option${vue === v.id ? " segment-active" : ""}`} aria-pressed={vue === v.id} onClick={() => setVue(v.id)}>
              {v.libelle}
            </button>
          ))}
        </div>
        {vue === "moscow" ? null : vue === "propose" ? (
          <Aide>
            Score RICE = Reach × Impact × Confidence ÷ Effort, calculé par le code. L'Impact est la médiane de 5 jugements du LLM. Le détail de chaque facteur est dans « Pourquoi ? ».
            {props.filtres.length > 0 ? ` Filtres actifs : ${props.filtres.map((f) => (f === "mrr" ? "MRR" : "objectif du trimestre")).join(" et ")}.` : ""}
            {candidats ? " Un candidat (bordure pointillée), créé par l'agent, n'entre au backlog officiel qu'avec votre accord : son rang dit où il se placerait." : ""}
          </Aide>
        ) : (
          <Aide>
            L'ordre officiel ne bouge que lorsque vous acceptez une proposition d'ordre de l'agent, dans la file « À décider ». L'écart avec le rang proposé est indiqué à droite. Ces rangs ne comptent que les
            éléments du backlog : les candidats, qui attendent votre accord, n'y figurent pas.
          </Aide>
        )}
      </div>
      {vue === "propose" ? <BacklogPropose {...props} /> : vue === "moscow" ? vueMoscow : <BacklogOfficiel filtres={props.filtres} rafraichir={props.lignes} />}
    </div>
  );
}

/** Ordre officiel : il ne change que lorsque le PO accepte une proposition d'ordre de l'agent. */
function BacklogOfficiel({ filtres, rafraichir }: { filtres: FiltreVue[]; rafraichir: unknown }) {
  const [lignes, setLignes] = useState<LigneOfficielle[] | null>(null);
  const [erreur, setErreur] = useState<string | undefined>();
  useEffect(() => {
    let actif = true;
    api
      .backlogOfficiel(filtres)
      .then((l) => {
        if (actif) {
          setLignes(l);
          setErreur(undefined);
        }
      })
      .catch((e) => actif && setErreur(messageErreur(e)));
    return () => {
      actif = false;
    };
  }, [filtres, rafraichir]);
  if (erreur && !lignes) return <ErreurPanneau message={erreur} />;
  if (!lignes) return <Chargement />;
  return (
    <div className="backlog">
      <ol className="lignes" aria-label="Backlog validé par le PO">
        {lignes.map((l) => {
          const ecart = l.rangPropose === null ? null : l.rang - l.rangPropose;
          return (
            <li key={l.itemId} className="ligne">
              <div className="ligne-rang">
                <span className="rang">{l.rang}</span>
              </div>
              <div className="ligne-corps">
                <div className="ligne-titre">{l.titre}</div>
              </div>
              <div className="ligne-score">
                {l.score !== null ? <span className="score">{score(l.score)}</span> : <span className="sans-score">pas encore de score</span>}
                {ecart !== null && ecart !== 0 ? (
                  <Badge ton={ecart > 0 ? "accent" : "discret"} titre={`L'agent le place au rang ${l.rangPropose}`}>
                    l'agent : {l.rangPropose}
                  </Badge>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function BacklogPropose({ lignes, erreur, mouvements, itemOuvert, onPourquoi }: Props) {
  if (erreur && !lignes) return <ErreurPanneau message={erreur} />;
  if (!lignes) return <Chargement />;
  if (lignes.length === 0) {
    return (
      <Vide titre="Le backlog est vide.">
        Dès qu'un feedback est rattaché à un item, l'agent calcule son score RICE et le classe ici.
      </Vide>
    );
  }
  return (
    <div className="backlog">
      <ol className="lignes" aria-label="Backlog classé par score">
        {lignes.map((l) => (
          <Ligne key={l.itemId} l={l} m={mouvements.parItem.get(l.itemId)} generation={mouvements.generation} ouverte={itemOuvert === l.itemId} onPourquoi={onPourquoi} />
        ))}
      </ol>
    </div>
  );
}

function Delta({ m }: { m: Mouvement | undefined }) {
  if (!m) return <span className="delta delta-nul" aria-hidden="true" />;
  if (m.nouveau) return <span className="delta delta-nouveau" title="Nouvel item dans le classement">nouveau</span>;
  if (m.delta > 0)
    return (
      <span className="delta delta-haut" title={`Monte de ${m.delta} place${m.delta > 1 ? "s" : ""}`}>
        ▲{m.delta}
      </span>
    );
  if (m.delta < 0)
    return (
      <span className="delta delta-bas" title={`Descend de ${-m.delta} place${m.delta < -1 ? "s" : ""}`}>
        ▼{-m.delta}
      </span>
    );
  return <span className="delta delta-nul" aria-hidden="true" />;
}

/** « 3 comptes · 18 300 €/mois » : qui demande l'élément, tous plans confondus. */
function quiDemande(l: LigneClassement): string {
  const segments = Object.values(l.parSegment ?? {});
  const comptes = segments.reduce((s, x) => s + x.comptes, 0);
  const total = segments.reduce((s, x) => s + x.mrr, 0);
  if (comptes === 0) return "Aucun compte ne le demande encore";
  return `${comptes} compte${comptes > 1 ? "s" : ""} · ${mrr(total)}`;
}

/**
 * Une ligne du backlog (décision 014) : le rang et son mouvement, le titre, le score, une seule phrase (la cause du
 * dernier mouvement, sinon qui le demande), deux badges au plus (doute, risque de départ) et les règles citées.
 * Les facteurs R, I, C et E sont dans « Pourquoi ? ».
 */
function Ligne({ l, m, generation, ouverte, onPourquoi }: { l: LigneClassement; m: Mouvement | undefined; generation: number; ouverte: boolean; onPourquoi: (id: string) => void }) {
  const bouge = !!m && (m.nouveau || m.delta !== 0 || (m.scoreAvant !== null && Math.abs(m.scoreAvant - l.score) > 1e-9));
  const doute = l.ecartImpact > 1;
  const candidat = l.statut === "candidat";
  return (
    <li
      className={`ligne${bouge ? " ligne-bouge" : ""}${ouverte ? " ligne-ouverte" : ""}${candidat ? " ligne-candidat" : ""}`}
      style={bouge ? { animationName: generation % 2 === 0 ? "flash-a" : "flash-b" } : undefined}
    >
      <div className="ligne-rang">
        {/* Un candidat n'a pas de rang à lui : sa mention dit où il se placerait s'il était accepté. */}
        {candidat ? null : <span className="rang">{l.rang}</span>}
        <Delta m={m} />
      </div>
      <div className="ligne-corps">
        <div className="ligne-titre">
          {l.titre} <span className="ligne-id" title="Identifiant de l'élément, celui qu'emploient l'agent et la doctrine">{l.itemId}</span>
          {candidat ? (
            <span className="ligne-candidat-mention" title="Créé par l'agent : il n'entre au backlog officiel qu'avec votre accord">
              candidat, se placerait au rang {l.rang}
            </span>
          ) : null}
        </div>
        <p className={`ligne-phrase${l.explication ? " ligne-phrase-mouvement" : ""}`}>{l.explication ? explicationFr(l.explication) : quiDemande(l)}</p>
        {doute || l.risqueDepart || l.reglesCitees.length > 0 ? (
          <div className="ligne-badges">
            {doute ? (
              <Badge ton="doute" titre={`Les 5 tirages d'Impact s'écartent de ${l.ecartImpact} crans`}>
                doute sur l'Impact
              </Badge>
            ) : null}
            {l.risqueDepart ? <Badge ton="risque">risque de départ</Badge> : null}
            {/* La règle citée s'affiche toujours : c'est la conclusion du twist (décision 014). */}
            {l.reglesCitees.map((r) => (
              <PuceRegle key={r} id={r} />
            ))}
          </div>
        ) : null}
      </div>
      <div className="ligne-score">
        <span className="score" aria-label={`Score ${score(l.score)}`}>
          {score(l.score)}
        </span>
        <button type="button" className="bouton bouton-pourquoi" onClick={() => onPourquoi(l.itemId)} aria-label={`Pourquoi ce score pour « ${l.titre} » ?`} aria-expanded={ouverte}>
          Pourquoi ?
        </button>
      </div>
    </li>
  );
}
