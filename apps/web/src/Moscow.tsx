import { useState } from "react";
import { api, messageErreur, type FiltreVue, type MoscowApi } from "./api.ts";
import type { Cle } from "./donnees.ts";
import { dateCourte, libelleFiltres, memeVue, nombre, score, tailleEffort } from "./format.ts";
import { Aide, Badge, Chargement, ErreurPanneau, useNotifier, Vide } from "./ui.tsx";

type Categorie = MoscowApi["propositions"][number]["categorie"];

const COLONNES: Array<{ cle: Categorie; titre: string; sous: string }> = [
  { cle: "must", titre: "Must", sous: "Indispensable" },
  { cle: "should", titre: "Should", sous: "Important, tient dans la capacité" },
  { cle: "could", titre: "Could", sous: "Si la release avance bien" },
  { cle: "wont", titre: "Won't", sous: "Pas pour cette release" },
];

const titreDe = (c: Categorie) => COLONNES.find((o) => o.cle === c)?.titre ?? c;

interface Props {
  moscow: MoscowApi | null;
  erreur: string | undefined;
  filtres: FiltreVue[];
  rafraichir: (cles: Cle[]) => void;
  onPourquoi: (id: string) => void;
}

export function Moscow({ moscow, erreur, filtres, rafraichir, onPourquoi }: Props) {
  const [ajustements, setAjustements] = useState<Record<string, Categorie>>({});
  const [envoi, setEnvoi] = useState(false);
  const notifier = useNotifier();
  if (erreur && !moscow) return <ErreurPanneau message={erreur} />;
  if (!moscow) return <Chargement />;
  const proposees = moscow.propositions ?? [];
  if (proposees.length === 0) {
    return <Vide titre="Rien à découper pour l'instant.">La proposition MoSCoW apparaît dès que le backlog contient des items classés.</Vide>;
  }
  // Un item que le PO a déplacé à la validation garde la catégorie validée ; tous les autres suivent
  // la proposition actuelle de l'agent, même si elle a changé depuis. Les changements en cours s'appliquent par-dessus.
  const valide = moscow.valide;
  const categoriesValidees = valide?.categories ?? {};
  const deplacesValides = new Set(valide?.deplaces ?? []);
  const props = proposees.map((p) => {
    const validee: Categorie | undefined = categoriesValidees[p.itemId];
    const deplace = validee !== undefined && deplacesValides.has(p.itemId);
    const base = deplace ? validee : p.categorie;
    return {
      ...p,
      proposee: p.categorie,
      validee,
      deplace,
      base,
      categorie: ajustements[p.itemId] ?? base,
      enCours: p.itemId in ajustements,
      // La proposition de l'agent a bougé depuis la validation, pour un item que le PO n'avait pas déplacé.
      aChange: !deplace && validee !== undefined && validee !== p.categorie,
    };
  });
  const nbModifies = props.filter((p) => p.categorie !== p.base).length;
  const nbChanges = props.filter((p) => p.aChange).length;
  const vueDifferente = !!valide && !memeVue(valide.filtres ?? [], filtres);
  // Seuls les vrais déplacements partent vers l'API, et donc dans le journal : les items que le PO place
  // ailleurs que la proposition actuelle de l'agent (ceux qu'il avait déjà déplacés, et ses changements en cours).
  const ecarts = Object.fromEntries(props.filter((p) => p.categorie !== p.proposee).map((p) => [p.itemId, p.categorie]));
  const nbEcarts = Object.keys(ecarts).length;
  const valider = async () => {
    setEnvoi(true);
    try {
      await api.validerMoscow(filtres, ecarts);
      notifier(`Découpage validé${nbEcarts > 0 ? ` (${nbEcarts} écart${nbEcarts > 1 ? "s" : ""} avec la proposition de l'agent)` : ""}.`, "succes");
      setAjustements({});
      rafraichir(["moscow", "journal"]);
    } catch (e) {
      notifier(messageErreur(e), "erreur");
    } finally {
      setEnvoi(false);
    }
  };

  const somme = (c: Categorie) => props.filter((p) => p.categorie === c).reduce((a, p) => a + (p.effort ?? 0), 0);
  const must = somme("must");
  const should = somme("should");
  const could = somme("could");
  const engage = must + should;
  const capacite = moscow.capacite;
  const echelle = Math.max(capacite * 1.5, engage + could, 0.0001);
  const pc = (v: number) => `${(v / echelle) * 100}%`;
  const depasse = engage > capacite;

  return (
    <div className="moscow">
      <div className="vue-outils">
        <p className="vue-principe">Proposition de l'agent : le PO tranche.</p>
        <Aide>
          Les Must viennent de règles explicites (régression sur des comptes payants, risque de départ d'un compte Business) ; le reste suit le score dans la limite de la capacité. Déplacez un item avec son
          menu, puis validez le découpage. Les items que vous avez déplacés gardent votre choix ; les autres suivent la proposition de l'agent.
        </Aide>
      </div>
      {valide && nbChanges > 0 ? (
        <div className="moscow-bandeau-change" role="status">
          <strong>
            {nbChanges} item{nbChanges > 1 ? "s ont" : " a"} changé de catégorie depuis votre validation du {dateCourte(valide.decideLe)}.
          </strong>{" "}
          La proposition de l'agent a évolué et vous n'aviez pas déplacé {nbChanges > 1 ? "ces items" : "cet item"} : le tableau suit la nouvelle proposition. Validez pour l'entériner, ou déplacez-{nbChanges > 1 ? "les" : "le"}.
          {vueDifferente ? ` Ce découpage a été validé dans la vue « ${libelleFiltres(valide.filtres)} » et vous regardez la vue « ${libelleFiltres(filtres)} » : une partie de ces changements vient de la vue.` : ""}
        </div>
      ) : null}
      <div className="moscow-validation">
        <button type="button" className="bouton bouton-principal" onClick={() => void valider()} disabled={envoi}>
          {envoi ? "Validation…" : `Valider ce découpage${nbModifies > 0 ? ` (${nbModifies} modifié${nbModifies > 1 ? "s" : ""})` : ""}`}
        </button>
        {nbModifies > 0 ? (
          <button type="button" className="bouton" onClick={() => setAjustements({})}>
            Annuler mes changements
          </button>
        ) : null}
        <span className="discret">
          {valide
            ? `Dernier découpage validé le ${dateCourte(valide.decideLe)}, vue « ${libelleFiltres(valide.filtres)} »${valide.deplaces.length > 0 ? `, ${valide.deplaces.length} item${valide.deplaces.length > 1 ? "s" : ""} déplacé${valide.deplaces.length > 1 ? "s" : ""} par vous` : ", sans déplacement"}.${vueDifferente ? ` Vous regardez la vue « ${libelleFiltres(filtres)} ».` : ""}`
            : "Aucun découpage validé pour l'instant."}
        </span>
      </div>

      <div className="capacite">
        <div className="capacite-legende">
          <span>
            Capacité de la release : <strong>{nombre(capacite, 1)} personnes-mois</strong>
          </span>
          <span className={depasse ? "texte-risque" : ""}>
            Engagé (Must + Should) : <strong>{nombre(engage, 1)}</strong>
            {depasse ? " · dépasse la capacité" : ""}
          </span>
        </div>
        <div className="capacite-barre" role="img" aria-label={`Must ${nombre(must, 1)}, Should ${nombre(should, 1)}, Could ${nombre(could, 1)} personnes-mois pour une capacité de ${nombre(capacite, 1)}`}>
          <span className="capacite-seg seg-must" style={{ width: pc(must) }} />
          <span className="capacite-seg seg-should" style={{ width: pc(should) }} />
          <span className="capacite-seg seg-could" style={{ width: pc(could) }} />
          <span className="capacite-repere" style={{ left: pc(capacite) }} aria-hidden="true" />
        </div>
        <div className="capacite-cles" aria-hidden="true">
          <span>
            <i className="seg-must" /> Must
          </span>
          <span>
            <i className="seg-should" /> Should
          </span>
          <span>
            <i className="seg-could" /> Could
          </span>
          <span>
            <i className="repere" /> capacité
          </span>
        </div>
      </div>

      <div className="moscow-colonnes">
        {COLONNES.map((c) => {
          const items = props.filter((p) => p.categorie === c.cle);
          return (
            <section key={c.cle} className={`moscow-col moscow-${c.cle}`} aria-label={`${c.titre} : ${c.sous}`}>
              <header>
                <h3>{c.titre}</h3>
                <span className="discret">
                  {c.sous} · {items.length} item{items.length > 1 ? "s" : ""} · {nombre(somme(c.cle), 1)} pers.-mois
                </span>
              </header>
              {items.length === 0 ? <p className="discret moscow-vide">Aucun item.</p> : null}
              <ul>
                {items.map((p) => (
                  <li key={p.itemId} className="moscow-carte">
                    <button type="button" className="moscow-titre" onClick={() => onPourquoi(p.itemId)} aria-label={`Pourquoi « ${p.titre} » ?`}>
                      {p.titre}
                    </button>
                    <p className="moscow-raison">
                      {p.categorie === p.proposee
                        ? p.raison
                        : p.enCours
                          ? `Déplacé, à valider : l'agent propose ${titreDe(p.proposee)}.`
                          : `Tranché par le PO : l'agent propose ${titreDe(p.proposee)}.`}
                    </p>
                    <p className="moscow-chiffres">
                      Effort {tailleEffort(p.effort)} · score {score(p.score)}
                    </p>
                    <div className="moscow-actions">
                      <label className="visuellement-cache" htmlFor={`moscow-${p.itemId}`}>
                        Catégorie de « {p.titre} »
                      </label>
                      <select
                        id={`moscow-${p.itemId}`}
                        value={p.categorie}
                        onChange={(e) => {
                          const v = e.target.value as Categorie;
                          setAjustements((a) => {
                            const suivant = { ...a };
                            if (v === p.base) delete suivant[p.itemId];
                            else suivant[p.itemId] = v;
                            return suivant;
                          });
                        }}
                      >
                        {COLONNES.map((o) => (
                          <option key={o.cle} value={o.cle}>
                            {o.titre}
                          </option>
                        ))}
                      </select>
                      {valide && p.validee === undefined ? (
                        <Badge ton="discret" titre="Item apparu après le dernier découpage validé : placé selon la proposition de l'agent">
                          nouveau
                        </Badge>
                      ) : null}
                      {valide && p.aChange && p.validee ? (
                        <span className="moscow-change">
                          <Badge ton="doute" titre={`Vous n'aviez pas déplacé cet item : il suit la proposition actuelle de l'agent (${titreDe(p.proposee)}). Validé le ${dateCourte(valide.decideLe)} en ${titreDe(p.validee)}.`}>
                            a changé depuis votre validation (validé : {titreDe(p.validee)})
                          </Badge>
                        </span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
