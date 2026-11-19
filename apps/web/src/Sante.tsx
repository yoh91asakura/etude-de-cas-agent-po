import type { EtatApi, SanteApi } from "./api.ts";
import { libelleFournisseur } from "./Entete.tsx";
import { duree, nombre, pourcent } from "./format.ts";
import { Aide, Chargement, ErreurPanneau } from "./ui.tsx";

interface Props {
  sante: SanteApi | null;
  erreur: string | undefined;
  /** Pour nommer les modèles utilisés (le badge quitte l'en-tête, décision 014). */
  etat: EtatApi | null;
}

export function Sante({ sante, erreur, etat }: Props) {
  if (erreur && !sante) return <ErreurPanneau message={erreur} />;
  if (!sante) return <Chargement />;
  const llm = sante.appelsLLM;
  const tauxEchec = llm && llm.total > 0 ? llm.echecs / llm.total : null;
  const e = sante.effectifs;
  // Un taux sans son effectif trompe : « 100 % » sur 2 décisions ne dit pas la même chose que sur 200.
  const sur = (n: number, total: number, unite: string) => `${nombre(n, 0)} sur ${nombre(total, 0)} ${unite}`;
  return (
    <div className="sante">
      <div className="vue-outils">
        <p className="vue-principe">Les quatre indicateurs de succès de l'agent</p>
        <Aide>Calculés sur les décisions réelles du PO. Chaque taux est donné avec son effectif : « 100 % » sur 2 décisions ne dit pas la même chose que sur 200.</Aide>
      </div>
      <div className="indicateurs">
        <Indicateur
          titre="Taux d'acceptation"
          valeur={pourcent(sante.tauxAcceptation)}
          effectif={e ? sur(e.acceptees, e.decidees, e.decidees > 1 ? "propositions décidées" : "proposition décidée") : undefined}
          mesure="Part des propositions de l'agent acceptées par le PO. La validation du découpage MoSCoW, que le PO fait lui-même, n'est pas comptée."
          sens="La confiance du PO"
          vide={sante.tauxAcceptation === null}
        />
        <Indicateur
          titre="Taux de correction"
          valeur={pourcent(sante.tauxCorrection)}
          effectif={e ? sur(e.corrections, e.reponses + (e.correctionsDirectes ?? 0), e.reponses + (e.correctionsDirectes ?? 0) > 1 ? "décisions" : "décision") : undefined}
          mesure="Part des réponses et des corrections du PO (effort, rattachement, texte d'une story) qui contredisent l'agent."
          sens="La qualité du jugement"
          vide={sante.tauxCorrection === null}
        />
        <Indicateur
          titre="Délai signal → décision"
          valeur={duree(sante.delaiDecisionMinutes)}
          effectif={e ? `moyenne sur ${nombre(e.delaisMesures, 0)} réponse${e.delaisMesures > 1 ? "s" : ""}` : undefined}
          mesure="Temps moyen, mesuré en temps réel, entre la création d'une question et la réponse du PO, attente en file comprise."
          sens="La réactivité"
          vide={sante.delaiDecisionMinutes === null}
        />
        <Indicateur
          titre="Alertes par jour"
          valeur={nombre(sante.alertesParJour, 0)}
          mesure={`Alertes des dernières 24 h · part ignorée : ${sante.partAlertesIgnorees === null ? "pas encore mesurée" : pourcent(sante.partAlertesIgnorees)}.`}
          sens="La charge mentale"
          vide={false}
        />
      </div>

      <h3 className="sante-titre">Appels au modèle de langage</h3>
      {etat ? (
        <p className="sante-modeles" title={`Modèle de langage : ${etat.fournisseur}`}>
          {etat.fournisseurFactice ? "Fournisseur factice (démo sans clé) : réponses fixes, non évaluées." : `Modèles : ${libelleFournisseur(etat.fournisseur)}.`}
        </p>
      ) : null}
      <div className="indicateurs indicateurs-petits">
        <Indicateur titre="Appels" valeur={nombre(llm?.total ?? 0, 0)} mesure="Total des appels tracés." vide={false} />
        <Indicateur titre="Échecs" valeur={`${nombre(llm?.echecs ?? 0, 0)}${tauxEchec !== null ? ` (${pourcent(tauxEchec)})` : ""}`} mesure="Refus, schéma invalide ou erreur : l'élément est mis en attente." vide={false} alerte={(llm?.echecs ?? 0) > 0} />
        <Indicateur titre="Durée moyenne" valeur={llm?.dureeMoyenneMs == null ? "—" : `${nombre(llm.dureeMoyenneMs / 1000, 1)} s`} mesure="Par appel." vide={llm?.dureeMoyenneMs == null} />
        <Indicateur titre="Jetons" valeur={`${nombre(llm?.tokensEntree ?? 0, 0)} / ${nombre(llm?.tokensSortie ?? 0, 0)}`} mesure="Entrée / sortie." vide={false} />
      </div>

      <p className="hypothese">Le temps gagné par le PO reste une hypothèse à mesurer : ces indicateurs ne le prouvent pas à eux seuls.</p>
    </div>
  );
}

function Indicateur({ titre, valeur, effectif, mesure, sens, vide, alerte }: { titre: string; valeur: string; effectif?: string | undefined; mesure: string; sens?: string; vide: boolean; alerte?: boolean }) {
  return (
    <div className={`indicateur${alerte ? " indicateur-alerte" : ""}`}>
      <p className="indicateur-titre">{titre}</p>
      <p className="indicateur-valeur">{valeur}</p>
      {effectif && !vide ? <p className="indicateur-effectif">{effectif}</p> : null}
      {vide ? <p className="discret">Pas encore de données.</p> : null}
      <p className="indicateur-mesure">{mesure}</p>
      {sens ? <p className="indicateur-sens">{sens}</p> : null}
    </div>
  );
}
