import { useEffect, useRef, useState } from "react";
import { api, messageErreur, type ProduitApi } from "./api.ts";
import { euros, LIBELLE_PLAN } from "./format.ts";
import { BadgePlan, Chargement, ErreurPanneau } from "./ui.tsx";

const CANAUX: Record<string, string> = { email: "e-mails", ticket: "tickets", commentaire: "commentaires", direct: "messages directs" };

/** Le produit fictif du scénario : ce qu'il faut savoir pour juger une demande client. */
export function Produit({ onFermer }: { onFermer: () => void }) {
  const [produit, setProduit] = useState<ProduitApi | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const fermer = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    api
      .produit()
      .then(setProduit)
      .catch((e: unknown) => setErreur(messageErreur(e)));
  }, []);

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

  return (
    <>
      <div className="voile voile-fiche" onClick={onFermer} aria-hidden="true" />
      <aside className="tiroir tiroir-fiche" role="dialog" aria-modal="true" aria-labelledby="titre-produit">
        <div className="tiroir-entete">
          <div>
            <p className="surtitre">Le produit</p>
            <h2 id="titre-produit">{produit?.nom ?? "Le produit"}</h2>
          </div>
          <button ref={fermer} type="button" className="bouton bouton-petit" onClick={onFermer}>
            Fermer
          </button>
        </div>
        <div className="tiroir-corps">
          {erreur ? <ErreurPanneau message={erreur} /> : null}
          {!produit && !erreur ? <Chargement /> : null}
          {produit ? (
            <>
              <section className="bloc">
                <h3>{produit.activite}</h3>
                <p>
                  <strong>Objectif du trimestre :</strong> « {produit.objectifTrimestre} ». Le filtre « Objectif du trimestre » donne un bonus aux éléments du backlog qui servent cet objectif.
                </p>
                <p className="discret">{produit.dateScenario}</p>
              </section>

              <section className="bloc">
                <h3>Les clients : {euros(produit.mrrTotal)} de revenu mensuel (MRR)</h3>
                <table className="tableau">
                  <thead>
                    <tr>
                      <th scope="col">Plan</th>
                      <th scope="col">Comptes</th>
                      <th scope="col">MRR total</th>
                      <th scope="col">MRR par compte</th>
                    </tr>
                  </thead>
                  <tbody>
                    {produit.comptes.map((c) => (
                      <tr key={c.plan}>
                        <th scope="row">
                          <BadgePlan plan={c.plan} />
                        </th>
                        <td>{c.nombre}</td>
                        <td>{euros(c.mrrTotal)}</td>
                        <td>{c.mrrMax === 0 ? "gratuit" : `${euros(c.mrrMin)} à ${euros(c.mrrMax)}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="aide">
                  Un compte {LIBELLE_PLAN.business} pèse jusqu'à quelques milliers d'euros par mois ; un compte {LIBELLE_PLAN.free} ne paie rien. C'est pourquoi le filtre « Pondérer par le MRR » change autant le classement.
                </p>
              </section>

              <section className="bloc">
                <h3>Ce que l'agent traite</h3>
                <p>
                  {produit.feedbacks.total} feedbacks :{" "}
                  {Object.entries(produit.feedbacks.parCanal)
                    .map(([canal, n]) => `${n} ${CANAUX[canal] ?? canal}`)
                    .join(", ")}
                  . Un backlog de {produit.itemsBacklog} éléments.
                </p>
              </section>

              {/* La note de provenance cite un fichier du dépôt : repliée, elle reste consultable sans occuper l'écran projeté. */}
              <details className="aide">
                <summary>Source de cette fiche</summary>
                {produit.source}
              </details>
            </>
          ) : null}
        </div>
      </aside>
    </>
  );
}
