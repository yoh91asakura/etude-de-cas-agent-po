import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Agent } from "./Agent.tsx";
import { Backlog } from "./Backlog.tsx";
import { Boite } from "./Boite.tsx";
import { Conversation } from "./Conversation.tsx";
import { Doctrine } from "./Doctrine.tsx";
import { useCockpit } from "./donnees.ts";
import { Entete, Filtres } from "./Entete.tsx";
import { FicheFeedback } from "./FicheFeedback.tsx";
import { Feedbacks, type FiltreNature } from "./Feedbacks.tsx";
import { LIBELLE_PLAN } from "./format.ts";
import { Moscow } from "./Moscow.tsx";
import { Pied } from "./Pied.tsx";
import { Pourquoi } from "./Pourquoi.tsx";
import { Stories } from "./Stories.tsx";
import { Garde, useNotifier } from "./ui.tsx";

type Onglet = "backlog" | "feedbacks" | "stories" | "doctrine" | "agent";

/** Cinq entrées (décision 014) : MoSCoW et l'ordre validé sont des vues du backlog ; le journal et la santé, des vues de l'agent. */
const ONGLETS: Array<{ id: Onglet; libelle: string }> = [
  { id: "backlog", libelle: "Backlog vivant" },
  { id: "feedbacks", libelle: "Feedbacks" },
  { id: "stories", libelle: "Stories" },
  { id: "doctrine", libelle: "Doctrine" },
  { id: "agent", libelle: "Agent" },
];

/** « pondérée par le MRR », « sans filtre »… */
export function libelleVue(filtres: readonly string[]): string {
  if (filtres.length === 0) return "sans filtre";
  const parties = [filtres.includes("mrr") ? "pondérée par le MRR" : null, filtres.includes("objectif") ? "alignée sur l'objectif du trimestre" : null].filter(Boolean);
  return parties.join(", ");
}

/**
 * Deux zones (décision 014) : à gauche la vue choisie, à droite la file « À décider », visible quelle que soit la vue.
 * Pendant le twist, l'arrivée du message, le classement qui change et la question au PO tiennent sur un seul écran.
 */
export function App() {
  const cockpit = useCockpit();
  const { donnees, erreurs, joignable, flux, filtres, setFiltres, mouvements, versionDetails, rafraichir, titres, derniereActivite, arrivee, feedbacksNouveaux } = cockpit;
  const notifier = useNotifier();
  const [onglet, setOnglet] = useState<Onglet>("backlog");
  // Change à chaque ouverture demandée d'ailleurs (puce de quarantaine, file) : la vue repart avec le bon filtre.
  const [ouverture, setOuverture] = useState<{ nature?: FiltreNature; storiesAValider?: boolean; n: number }>({ n: 0 });
  const [itemOuvert, setItemOuvert] = useState<string | null>(null);
  const [feedbackOuvert, setFeedbackOuvert] = useState<string | null>(null);
  const [conversation, setConversation] = useState<"jamais" | "ouverte" | "fermee">("jamais");
  const boutonsOnglets = useRef<Array<HTMLButtonElement | null>>([]);

  const fermerTiroir = useCallback(() => setItemOuvert(null), []);
  const fermerFiche = useCallback(() => setFeedbackOuvert(null), []);
  // Depuis la fiche d'un message, ouvrir un élément ferme la fiche et ouvre le détail de l'élément.
  const ouvrirItemDepuisFiche = useCallback((id: string) => {
    setFeedbackOuvert(null);
    setItemOuvert(id);
  }, []);

  const changerOnglet = (o: Onglet, options: { nature?: FiltreNature; storiesAValider?: boolean } = {}) => {
    setOnglet(o);
    setOuverture((x) => ({ ...options, n: x.n + 1 }));
  };

  // Le cockpit s'ouvre sur la vue où raisonne l'agent (alertes, stories, ordre proposé) : sinon, deux classements se contredisent à l'écran.
  const vueInitialisee = useRef(false);
  useEffect(() => {
    if (vueInitialisee.current || !donnees.etat) return;
    vueInitialisee.current = true;
    setFiltres([...donnees.etat.vueReference].sort(), { silencieux: true });
  }, [donnees.etat, setFiltres]);
  const vueReference = libelleVue(donnees.etat?.vueReference ?? []);

  // Chaque arrivée se voit, quelle que soit la vue ouverte : une notification nomme le client dès que le fil le connaît.
  const annoncee = useRef(0);
  useEffect(() => {
    if (!arrivee || annoncee.current === arrivee.n) return;
    const f = (donnees.feedbacks ?? []).find((x) => x.id === arrivee.id);
    if (!f) return;
    annoncee.current = arrivee.n;
    const client = `${f.compte.nom} (${LIBELLE_PLAN[f.compte.plan] ?? f.compte.plan})`;
    notifier(arrivee.statut === "suspect" ? `Message de ${client} mis en quarantaine : il tente de donner des ordres à l'agent.` : `Nouveau message de ${client} : l'agent le lit et met le backlog à jour.`, "info");
  }, [arrivee, donnees.feedbacks, notifier]);

  // Pastille de l'onglet Feedbacks : les messages arrivés depuis la dernière visite de la vue.
  const [nouveauxVus, setNouveauxVus] = useState(0);
  useEffect(() => {
    if (onglet === "feedbacks") setNouveauxVus(feedbacksNouveaux.size);
  }, [onglet, feedbacksNouveaux]);
  const nouveauxNonVus = onglet === "feedbacks" ? 0 : Math.max(0, feedbacksNouveaux.size - nouveauxVus);

  // « Demander » : un tiroir qu'on ouvre de partout. Il reste monté une fois ouvert, pour garder la conversation.
  useEffect(() => {
    if (conversation !== "ouverte") return;
    const touche = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setConversation("fermee");
    };
    window.addEventListener("keydown", touche);
    return () => window.removeEventListener("keydown", touche);
  }, [conversation]);

  const toucheOnglets = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = ONGLETS.findIndex((o) => o.id === onglet);
    let j = i;
    if (e.key === "ArrowRight") j = (i + 1) % ONGLETS.length;
    else if (e.key === "ArrowLeft") j = (i - 1 + ONGLETS.length) % ONGLETS.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = ONGLETS.length - 1;
    else return;
    e.preventDefault();
    changerOnglet(ONGLETS[j]!.id);
    boutonsOnglets.current[j]?.focus();
  };

  return (
    <div className="app">
      <Garde nom="en-tête">
        <Entete etat={donnees.etat} flux={flux} derniereActivite={derniereActivite} onQuarantaine={() => changerOnglet("feedbacks", { nature: "suspect" })}>
          <div className="entete-nav">
            <div className="onglets" role="tablist" aria-label="Vues" onKeyDown={toucheOnglets}>
              {ONGLETS.map((o, i) => (
                <button
                  key={o.id}
                  ref={(el) => {
                    boutonsOnglets.current[i] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`onglet-${o.id}`}
                  aria-selected={onglet === o.id}
                  aria-controls="panneau-vue"
                  tabIndex={onglet === o.id ? 0 : -1}
                  className="onglet"
                  onClick={() => changerOnglet(o.id)}
                >
                  {o.libelle}
                  {o.id === "feedbacks" && nouveauxNonVus > 0 ? (
                    <span className="pastille" aria-label={`${nouveauxNonVus} nouveau${nouveauxNonVus > 1 ? "x" : ""} message${nouveauxNonVus > 1 ? "s" : ""}`}>
                      {nouveauxNonVus}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
            <Filtres etat={donnees.etat} filtres={filtres} setFiltres={setFiltres} vueReference={vueReference} />
            <button type="button" className="bouton bouton-secondaire bouton-demander" aria-expanded={conversation === "ouverte"} onClick={() => setConversation("ouverte")} title="Poser une question libre à l'agent (lecture seule)">
              <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                <path d="M3 4h14v9H8l-4 3v-3H3z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
              </svg>
              Demander
            </button>
          </div>
        </Entete>
      </Garde>

      {!joignable ? (
        <div className="bandeau-api" role="alert">
          <strong>API injoignable.</strong> Le cockpit réessaie toutes les 5 secondes ; les données affichées peuvent être en retard.
        </div>
      ) : null}

      <main className="grille">
        <section className="colonne colonne-centre" aria-label="Vue">
          <div className="colonne-defile" role="tabpanel" id="panneau-vue" aria-labelledby={`onglet-${onglet}`} tabIndex={0}>
            <Garde key={`${onglet}-${ouverture.n}`} nom={ONGLETS.find((o) => o.id === onglet)?.libelle ?? onglet}>
              {onglet === "backlog" ? (
                <Backlog
                  lignes={donnees.classement}
                  erreur={erreurs.classement}
                  mouvements={mouvements}
                  filtres={filtres}
                  itemOuvert={itemOuvert}
                  onPourquoi={setItemOuvert}
                  vueMoscow={<Moscow moscow={donnees.moscow} erreur={erreurs.moscow} filtres={filtres} rafraichir={rafraichir} onPourquoi={setItemOuvert} />}
                />
              ) : null}
              {onglet === "feedbacks" ? <Feedbacks feedbacks={donnees.feedbacks} erreur={erreurs.feedbacks} titres={titres} nouveaux={feedbacksNouveaux} natureInitiale={ouverture.nature} onOuvrirItem={setItemOuvert} /> : null}
              {onglet === "stories" ? (
                <Stories lignes={donnees.classement} filtres={filtres} versionDetails={versionDetails} onPourquoi={setItemOuvert} rafraichir={rafraichir} aValiderSeulement={ouverture.storiesAValider ?? false} />
              ) : null}
              {onglet === "doctrine" ? <Doctrine regles={donnees.regles} erreur={erreurs.regles} rafraichir={rafraichir} /> : null}
              {onglet === "agent" ? <Agent journal={donnees.journal} erreurJournal={erreurs.journal} sante={donnees.sante} erreurSante={erreurs.sante} etat={donnees.etat} titres={titres} /> : null}
            </Garde>
          </div>
        </section>

        <Garde nom="file À décider">
          <Boite
            questions={donnees.questions}
            propositions={donnees.propositions}
            alertes={donnees.alertes}
            erreurs={erreurs}
            vueReference={vueReference}
            questionsEnFile={donnees.etat?.questionsEnFile ?? 0}
            rafraichir={rafraichir}
            onOuvrirItem={setItemOuvert}
            onOuvrirFeedback={setFeedbackOuvert}
            onOuvrirOnglet={(o) => changerOnglet(o, o === "stories" ? { storiesAValider: true } : {})}
          />
        </Garde>
      </main>

      <Garde nom="pied de page">
        <Pied etat={donnees.etat} rafraichir={rafraichir} />
      </Garde>

      {itemOuvert ? (
        <Garde key={itemOuvert} nom="pourquoi">
          <Pourquoi itemId={itemOuvert} filtres={filtres} versionDetails={versionDetails} titres={titres} onFermer={fermerTiroir} onOuvrirItem={setItemOuvert} onOuvrirFeedback={setFeedbackOuvert} />
        </Garde>
      ) : null}

      {feedbackOuvert ? (
        <Garde key={feedbackOuvert} nom="fiche du message">
          <FicheFeedback feedbackId={feedbackOuvert} onFermer={fermerFiche} onOuvrirItem={ouvrirItemDepuisFiche} />
        </Garde>
      ) : null}

      {conversation !== "jamais" ? (
        <div hidden={conversation !== "ouverte"}>
          <div className="voile" onClick={() => setConversation("fermee")} aria-hidden="true" />
          <aside className="tiroir tiroir-conversation" role="dialog" aria-modal="true" aria-labelledby="titre-conversation">
            <div className="tiroir-entete">
              <h2 id="titre-conversation">Demander à l'agent</h2>
              <button type="button" className="bouton-icone" onClick={() => setConversation("fermee")} aria-label="Fermer la conversation">
                ×
              </button>
            </div>
            <div className="tiroir-corps">
              <Garde nom="conversation">
                <Conversation filtres={filtres} libelleVue={libelleVue(filtres)} />
              </Garde>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
