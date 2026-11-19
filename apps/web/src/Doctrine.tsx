import { useCallback, useEffect, useRef, useState } from "react";
import { api, messageErreur, type ApercuRegleApi, type OrigineRegleApi, type RegleApi } from "./api.ts";
import type { Cle } from "./donnees.ts";
import { jour, LIBELLE_STATUT_REGLE } from "./format.ts";
import { Aide, Badge, Chargement, ErreurPanneau, Vide, useNotifier, type Ton } from "./ui.tsx";

const TON_STATUT: Record<string, Ton> = { proposee: "doute", active: "accent", rejetee: "discret", retiree: "discret" };
const ORDRE: Record<string, number> = { proposee: 0, active: 1, rejetee: 2, retiree: 3 };
const A_RAFRAICHIR: Cle[] = ["regles", "propositions", "classement", "journal", "etat"];
const AIDE_MOTS_CLES: Record<string, string> = {
  active: "Une demande qui contient l'un de ces mots est rattachée d'office, sans lecture par le modèle ni question.",
  proposee: "Une fois validée, une demande qui contient l'un de ces mots sera rattachée d'office, sans lecture par le modèle ni question.",
  rejetee: "Rejetée : ces mots-clés n'ont jamais été appliqués.",
  retiree: "Retirée : ces mots-clés ne rattachent plus les nouvelles demandes.",
};

type EtatApercu = { apercu: ApercuRegleApi } | { erreur: string };
type DemandeCaptee = ApercuRegleApi["captees"][number];

interface Props {
  regles: RegleApi[] | null;
  erreur: string | undefined;
  rafraichir: (cles: Cle[]) => void;
}

/** Ce que change le retrait d'une règle, selon son type : la phrase est affichée à côté du bouton. */
function effetRetrait(r: RegleApi): string {
  if (r.contenu.type === "paire_distincte") return "Rien n'est défait : les deux éléments restent séparés. L'agent pourra de nouveau vous proposer de les fusionner.";
  if (r.contenu.type === "ajustement_impact") return "Les scores déjà calculés restent. Les prochains calculs de l'Impact ne l'appliqueront plus.";
  return "Les rattachements qu'elle a déjà faits restent. Les nouveaux feedbacks ne l'appliqueront plus : l'agent lira lui-même ces demandes, ou vous posera la question.";
}

export function Doctrine({ regles, erreur, rafraichir }: Props) {
  const notifier = useNotifier();
  const [enCours, setEnCours] = useState<string | null>(null);
  const [aRetirer, setARetirer] = useState<string | null>(null);
  // L'aperçu est recalculé par l'API à chaque ouverture de l'onglet : les raisons d'un refus restent visibles.
  const [apercus, setApercus] = useState<Record<string, EtatApercu>>({});
  const monte = useRef(true);

  const tri = [...(regles ?? [])].sort((a, b) => (ORDRE[a.statut] ?? 9) - (ORDRE[b.statut] ?? 9) || a.id.localeCompare(b.id) || b.version - a.version);
  const actives = tri.filter((r) => r.statut === "active").length;
  const idsAValider = tri.filter((r) => r.statut === "proposee").map((r) => r.id).join(",");
  // L'aperçu dépend des règles actives : on le recalcule quand elles changent, pas à chaque rafraîchissement.
  const signature = `${idsAValider}|${tri
    .filter((r) => r.statut === "active")
    .map((r) => `${r.id}:${r.version}`)
    .join(",")}`;

  const chargerApercus = useCallback(async (ids: string[]) => {
    const resultats = await Promise.all(
      ids.map(async (id): Promise<[string, EtatApercu]> => {
        try {
          return [id, { apercu: await api.apercuRegle(id) }];
        } catch (e) {
          return [id, { erreur: messageErreur(e) }];
        }
      }),
    );
    if (monte.current) setApercus((a) => ({ ...a, ...Object.fromEntries(resultats) }));
  }, []);

  useEffect(() => {
    monte.current = true;
    return () => {
      monte.current = false;
    };
  }, []);

  useEffect(() => {
    const ids = idsAValider ? idsAValider.split(",") : [];
    if (ids.length > 0) void chargerApercus(ids);
  }, [signature, idsAValider, chargerApercus]);

  const decider = async (r: RegleApi, accepter: boolean) => {
    setEnCours(r.id);
    try {
      const res = await api.deciderRegle(r.id, accepter);
      if (accepter && res.statut !== "active") {
        notifier(`La règle ${r.id} n'a pas été validée : elle entre en conflit avec la doctrine active. Les raisons restent affichées sous la règle.`, "erreur");
        await chargerApercus([r.id]);
      } else {
        notifier(accepter ? `Règle ${r.id} validée : elle s'applique désormais aux nouveaux feedbacks.` : `Règle ${r.id} rejetée.`, "succes");
      }
      rafraichir(A_RAFRAICHIR);
    } catch (e) {
      notifier(`Décision impossible : ${messageErreur(e)}`, "erreur");
    } finally {
      setEnCours(null);
    }
  };

  const retirer = async (r: RegleApi) => {
    setEnCours(r.id);
    try {
      await api.retirerRegle(r.id);
      setARetirer(null);
      notifier(`Règle ${r.id} retirée. ${effetRetrait(r)}`, "succes");
      rafraichir(A_RAFRAICHIR);
    } catch (e) {
      notifier(`Retrait impossible : ${messageErreur(e)}`, "erreur");
    } finally {
      setEnCours(null);
    }
  };

  return (
    <div className="doctrine">
      <div className="vue-outils">
        <p className="vue-principe">
          Les règles que l'agent applique, nées de vos réponses
          {regles && regles.length > 0 ? (
            <span className="discret">
              {" "}
              · {actives} active{actives > 1 ? "s" : ""} sur {regles.length} version{regles.length > 1 ? "s" : ""}
            </span>
          ) : null}
        </p>
        <Aide>
          La doctrine produit : chaque règle naît d'une de vos réponses, jamais d'un feedback client, et ne s'applique qu'une fois validée par vous. Avant de valider, l'aperçu montre ce qu'elle changerait. Une
          règle active peut être retirée.
        </Aide>
      </div>
      {erreur && !regles ? <ErreurPanneau message={erreur} /> : null}
      {!regles && !erreur ? <Chargement /> : null}
      {regles && regles.length === 0 ? (
        <Vide titre="Aucune règle pour l'instant.">
          Répondez aux questions de l'agent dans la file « À décider » : il en tire des règles explicites, que vous validez ici.
        </Vide>
      ) : null}
      <ul className="regles">
        {tri.map((r) => {
          const etat = r.statut === "proposee" ? apercus[r.id] : undefined;
          const bloquante = !!etat && "apercu" in etat && etat.apercu.bloquante;
          return (
            <li key={`${r.id}-v${r.version}`} className={`regle regle-${r.statut}`}>
              <div className="regle-meta">
                <span className="regle-id">{r.id}</span>
                <span className="discret">version {r.version}</span>
                <Badge ton={TON_STATUT[r.statut] ?? "neutre"}>{LIBELLE_STATUT_REGLE[r.statut] ?? r.statut}</Badge>
                <span className="regle-citations" title="Nombre de décisions de l'agent qui citent cette règle">
                  citée par {r.citations} décision{r.citations > 1 ? "s" : ""}
                </span>
              </div>
              <p className="regle-texte">{r.texte}</p>
              <DetailRegle r={r} />
              <p className="regle-source">
                Née de votre réponse <span className="mono">{r.sourceReponseId}</span> · proposée le {jour(r.creeeLe)}
                {r.valideeLe ? ` · validée le ${jour(r.valideeLe)}` : ""}
                {r.retireeLe ? ` · retirée le ${jour(r.retireeLe)}` : ""}
              </p>

              {r.statut === "proposee" ? (
                <>
                  <Apercu etat={etat} />
                  <div className="regle-actions">
                    <button
                      type="button"
                      className="bouton bouton-principal"
                      disabled={enCours === r.id || bloquante}
                      title={bloquante ? "Impossible tant que les conflits ci-dessus demeurent" : undefined}
                      onClick={() => void decider(r, true)}
                      aria-label={`Valider la règle ${r.id}`}
                    >
                      Valider
                    </button>
                    <button type="button" className="bouton bouton-secondaire" disabled={enCours === r.id} onClick={() => void decider(r, false)} aria-label={`Rejeter la règle ${r.id}`}>
                      Rejeter
                    </button>
                  </div>
                  {bloquante ? <p className="regle-aide">Valider est impossible tant que ces conflits demeurent : rejetez cette règle, ou retirez d'abord la règle en cause.</p> : null}
                </>
              ) : null}

              {r.statut === "active" ? (
                aRetirer === r.id ? (
                  <div className="regle-retrait" role="group" aria-label={`Confirmer le retrait de la règle ${r.id}`}>
                    <p>
                      <strong>Retirer la règle {r.id} ?</strong> {effetRetrait(r)} Le retrait est consigné au journal.
                    </p>
                    <div className="regle-actions">
                      <button type="button" className="bouton bouton-principal" disabled={enCours === r.id} onClick={() => void retirer(r)}>
                        Confirmer le retrait
                      </button>
                      <button type="button" className="bouton bouton-secondaire" disabled={enCours === r.id} onClick={() => setARetirer(null)}>
                        Annuler
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="regle-actions regle-retrait-ligne">
                    <button type="button" className="bouton bouton-secondaire" onClick={() => setARetirer(r.id)} aria-label={`Retirer la règle ${r.id}`}>
                      Retirer
                    </button>
                    <span className="regle-aide">{effetRetrait(r)}</span>
                  </div>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Ce qui pilote vraiment la règle : ses mots-clés, l'élément visé (par son titre) et le cas dont elle est née. */
function DetailRegle({ r }: { r: RegleApi }) {
  return (
    <dl className="regle-details">
      {r.contenu.type === "rattachement" ? (
        <div>
          <dt>Mots-clés</dt>
          <dd>
            {r.motsCles.length > 0
              ? r.motsCles.map((m) => (
                  <code key={m} className="mot-cle">
                    {m}
                  </code>
                ))
              : "aucun"}
            <span className="regle-aide">{AIDE_MOTS_CLES[r.statut] ?? AIDE_MOTS_CLES.active}</span>
          </dd>
        </div>
      ) : null}
      {r.elements.length > 0 ? (
        <div>
          <dt>{r.elements.length > 1 ? "Éléments visés" : "Élément visé"}</dt>
          <dd>
            {r.elements.map((e, i) => (
              <span key={e.id}>
                {i > 0 ? " et " : ""}« {e.titre} »
              </span>
            ))}
          </dd>
        </div>
      ) : null}
      <div>
        <dt>Cas d'origine</dt>
        <dd>{r.origine ? <CasOrigine o={r.origine} /> : <span className="discret">introuvable</span>}</dd>
      </div>
    </dl>
  );
}

function CasOrigine({ o }: { o: OrigineRegleApi }) {
  const resume = o.resume && o.resume !== o.citation ? o.resume : null;
  return (
    <div className="regle-origine">
      <p>
        <span className="discret">Question : </span>
        {o.question}
      </p>
      {resume || o.citation ? (
        <p>
          <span className="discret">Demande : </span>
          {resume ? `${resume} ` : null}
          {o.citation ? <q className="citation">{o.citation}</q> : null}
          {o.feedbackId ? <span className="discret"> (message {o.feedbackId})</span> : null}
        </p>
      ) : null}
      <p>
        {/* Sans la date de la réponse : l'API la donne sur l'horloge réelle, la règle sur celle du scénario, et les deux se contredisaient. */}
        <span className="discret">Votre réponse : </span>
        <strong>« {o.choixLibelle} »</strong>
      </p>
    </div>
  );
}

function effetCapture(d: DemandeCaptee, cible: string): string {
  if (!d.actuel) return `aujourd'hui sans rattachement propre : la règle la placerait sur « ${cible} »`;
  const attente = d.actuel.sure ? "" : " (en attente de votre réponse)";
  if (d.changerait) return `aujourd'hui sur « ${d.actuel.element.titre} »${attente} : passerait sur « ${cible} »`;
  return `déjà sur « ${cible} »${attente}`;
}

function phraseAmbigues(k: number, autres: boolean): string {
  if (k === 1) return `${autres ? "1 autre demande" : "1 demande"} deviendrait ambiguë : une règle active l'envoie ailleurs, aucune des deux ne s'appliquerait et le modèle la lirait.`;
  return `${k} ${autres ? "autres " : ""}demandes deviendraient ambiguës : une règle active les envoie ailleurs, aucune des deux ne s'appliquerait et le modèle les lirait.`;
}

/** L'aperçu avant décision : ce que la règle changerait, et ce qui empêche de la valider, en clair. */
function Apercu({ etat }: { etat: EtatApercu | undefined }) {
  if (!etat) {
    return (
      <p className="apercu discret" role="status">
        Calcul de l'aperçu sur les demandes déjà reçues…
      </p>
    );
  }
  if ("erreur" in etat) {
    return <p className="apercu texte-risque">Aperçu indisponible : {etat.erreur}. Le serveur refusera quand même une règle qui contredit la doctrine.</p>;
  }
  const a = etat.apercu;
  const cible = a.elements[0]?.titre ?? "?";
  const n = a.captees.length;
  return (
    <section className="apercu" aria-label={`Aperçu de la règle ${a.regleId} avant décision`}>
      <p className="apercu-resume">{a.resume}</p>
      {a.type === "rattachement" ? (
        <p className="regle-aide">
          Calculé par le code sur les {a.demandesLues} demandes déjà reçues. Les rattachements déjà faits ne bougent pas : l'aperçu montre ce que la règle décidera pour les prochaines demandes
          qui leur ressemblent.
        </p>
      ) : null}
      {n > 0 ? (
        <details className="apercu-liste">
          <summary>
            {n === 1
              ? `Voir la demande${a.changements > 0 ? ", qui changerait d'élément" : ""}`
              : `Voir les ${n} demandes${a.changements > 0 ? `, dont ${a.changements} qui changerai${a.changements > 1 ? "ent" : "t"} d'élément` : ""}`}
          </summary>
          <ul>
            {a.captees.map((d, i) => (
              <li key={`${d.feedbackId}-${i}`} className={d.changerait ? "apercu-change" : undefined}>
                <q className="citation">{d.citation}</q> <span className="discret">(message {d.feedbackId})</span>
                <span className="apercu-effet">{effetCapture(d, cible)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {a.ambigues.length > 0 ? (
        <details className="apercu-liste">
          <summary>{phraseAmbigues(a.ambigues.length, n > 0)}</summary>
          <ul>
            {a.ambigues.map((d, i) => (
              <li key={`${d.feedbackId}-${i}`}>
                <q className="citation">{d.citation}</q> <span className="discret">(message {d.feedbackId})</span>
                <span className="apercu-effet">en concurrence avec {d.concurrentes.map((c) => `la règle ${c.regleId}, qui l'envoie sur « ${c.element.titre} »`).join(" et ")}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {a.proches.length > 0 ? (
        <div className="apercu-proches">
          <strong>{a.proches.length > 1 ? "Règles proches" : "Règle proche"} :</strong>
          <ul>
            {a.proches.map((p) => (
              <li key={p.regleId}>{p.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {a.bloquante ? (
        <div className="contradictions" role="alert">
          <strong>Cette règle ne peut pas être validée en l'état.</strong>
          {a.contradictions.length > 0 ? (
            <>
              <p>Elle contredit la doctrine active :</p>
              <ul>
                {a.contradictions.map((c) => (
                  <li key={c.regleId}>{c.message}</li>
                ))}
              </ul>
            </>
          ) : null}
          {a.casCasses.length > 0 ? (
            <>
              <p>Elle casserait des cas que vous avez déjà tranchés :</p>
              <ul>
                {a.casCasses.map((c) => (
                  <li key={c.regleId}>{c.message}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
