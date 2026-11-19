import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, messageErreur, type FicheFeedbackApi } from "./api.ts";
import { dateCourte, LIBELLE_CANAL, LIBELLE_NATURE, mrr } from "./format.ts";
import { Badge, BadgePlan, Chargement, ErreurPanneau, PuceRegle } from "./ui.tsx";

/** Met en évidence, dans un message, les passages que l'agent a cités. */
export function Surligne({ texte, citations }: { texte: string; citations: string[] }): ReactNode {
  const zones: Array<[number, number]> = [];
  for (const c of citations) {
    if (c.trim().length < 3) continue;
    const i = texte.indexOf(c);
    if (i >= 0) zones.push([i, i + c.length]);
  }
  zones.sort((a, b) => a[0] - b[0]);
  const morceaux: ReactNode[] = [];
  let pos = 0;
  for (const [debut, fin] of zones) {
    if (debut < pos) continue;
    if (debut > pos) morceaux.push(texte.slice(pos, debut));
    morceaux.push(<mark key={debut}>{texte.slice(debut, fin)}</mark>);
    pos = fin;
  }
  if (pos < texte.length) morceaux.push(texte.slice(pos));
  return <>{morceaux}</>;
}

interface Props {
  feedbackId: string;
  onFermer: () => void;
  onOuvrirItem: (id: string) => void;
}

/** La fiche d'un message client : le texte complet, le client, ce que l'agent a compris, et où le message compte. */
export function FicheFeedback({ feedbackId, onFermer, onOuvrirItem }: Props) {
  const [fiche, setFiche] = useState<FicheFeedbackApi | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [montrerSuspect, setMontrerSuspect] = useState(false);
  const fermer = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let actif = true;
    setFiche(null);
    api
      .feedback(feedbackId)
      .then((f) => {
        if (actif) setFiche(f);
      })
      .catch((e: unknown) => {
        if (actif) setErreur(messageErreur(e));
      });
    return () => {
      actif = false;
    };
  }, [feedbackId]);

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

  const suspect = fiche?.statut === "suspect";
  return (
    <>
      <div className="voile voile-fiche" onClick={onFermer} aria-hidden="true" />
      <aside className="tiroir tiroir-fiche" role="dialog" aria-modal="true" aria-labelledby="titre-fiche">
        <div className="tiroir-entete">
          <div>
            <p className="surtitre">Message {feedbackId}</p>
            <h2 id="titre-fiche">{fiche ? fiche.compte.nom : "Message client"}</h2>
          </div>
          <button ref={fermer} type="button" className="bouton bouton-petit" onClick={onFermer}>
            Fermer
          </button>
        </div>
        <div className="tiroir-corps">
          {erreur ? <ErreurPanneau message={erreur} /> : null}
          {!fiche && !erreur ? <Chargement /> : null}
          {fiche ? (
            <>
              <p className="fiche-meta">
                <BadgePlan plan={fiche.compte.plan} />
                <span>{mrr(fiche.compte.mrr)}</span>
                <span className="discret">
                  {LIBELLE_CANAL[fiche.canal] ?? fiche.canal} · {dateCourte(fiche.recuLe)}
                </span>
                {fiche.compte.risqueDepart ? <Badge ton="risque">compte à risque de départ</Badge> : null}
                {fiche.menaceDepart ? <Badge ton="risque">ce message menace de partir</Badge> : null}
                {fiche.nature ? <Badge ton="discret">{LIBELLE_NATURE[fiche.nature] ?? fiche.nature}</Badge> : null}
              </p>

              <section className="bloc">
                <h3>Le message</h3>
                {suspect && !montrerSuspect ? (
                  <p className="aide">
                    Message mis en quarantaine : il tente de donner des instructions à l'agent, qui n'en a rien tiré.{" "}
                    <button type="button" className="lien" onClick={() => setMontrerSuspect(true)}>
                      Afficher le texte quand même
                    </button>
                  </p>
                ) : (
                  <p className="fiche-texte">
                    <Surligne texte={fiche.texte} citations={fiche.demandes.map((d) => d.citation)} />
                  </p>
                )}
                {fiche.demandes.length > 0 && !suspect ? <p className="aide">Surligné : les passages que l'agent a cités, vérifiés mot pour mot.</p> : null}
              </section>

              <section className="bloc">
                <h3>Ce que l'agent a compris</h3>
                {fiche.demandes.length === 0 ? (
                  <p className="aide">{suspect ? "Rien : un message en quarantaine ne produit aucune demande." : "Aucune demande produit dans ce message (compliment, question, bruit)."}</p>
                ) : (
                  <ul className="fiche-demandes">
                    {fiche.demandes.map((d, i) => (
                      <li key={i}>
                        <strong>{d.resume}</strong>
                        {d.regression ? (
                          <>
                            {" "}
                            <Badge ton="risque">régression signalée</Badge>
                          </>
                        ) : null}
                        <q className="citation">{d.citation}</q>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="bloc">
                <h3>Où ce message compte</h3>
                {fiche.rattachements.length === 0 ? (
                  <p className="aide">Il ne compte dans aucun score.</p>
                ) : (
                  <ul className="fiche-rattachements">
                    {fiche.rattachements.map((r) => (
                      <li key={r.itemId}>
                        <button type="button" className="lien" onClick={() => onOuvrirItem(r.itemId)}>
                          {r.titre}
                        </button>{" "}
                        {r.sure ? <Badge ton="accent">compté dans le score</Badge> : <Badge ton="doute">en attente de votre réponse</Badge>}
                        {r.regleId ? (
                          <>
                            {" "}
                            <PuceRegle id={r.regleId} />
                          </>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          ) : null}
        </div>
      </aside>
    </>
  );
}
