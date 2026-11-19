import { useRef, useState } from "react";
import type { Plan } from "./api.ts";
import type { FeedbackApi } from "./api.ts";
import { dateCourte, LIBELLE_NATURE, LIBELLE_STATUT_FEEDBACK, mrr } from "./format.ts";
import { Badge, BadgePlan, Chargement, ErreurPanneau, IconeCanal, Vide, type Ton } from "./ui.tsx";

const LONGUEUR_COURTE = 180;

const TON_NATURE: Record<string, Ton> = {
  demande: "accent",
  bug: "neutre",
  compliment: "discret",
  question: "discret",
  bruit: "discret",
  suspect: "risque",
};

interface Props {
  feedbacks: FeedbackApi[] | null;
  erreur: string | undefined;
  titres: Map<string, string>;
  /** Messages arrivés depuis l'ouverture du cockpit : marqués « nouveau ». */
  nouveaux: Set<string>;
  /** Filtre de nature à l'ouverture de la vue (la puce de quarantaine ouvre les suspects). */
  natureInitiale?: FiltreNature;
  onOuvrirItem: (id: string) => void;
}

export type FiltreNature = "toutes" | "demande" | "bug" | "question" | "compliment" | "bruit" | "suspect";

/** Les filtres du fil (audit du 15/11/2026) : un PO cherche « ce qui n'est rattaché à rien », un client, un plan. */
function filtrer(feedbacks: FeedbackApi[], f: { nature: FiltreNature; plan: Plan | "tous"; nonRattaches: boolean; texte: string }): FeedbackApi[] {
  const cherche = f.texte.trim().toLowerCase();
  return feedbacks.filter(
    (x) =>
      (f.nature === "toutes" || x.nature === f.nature) &&
      (f.plan === "tous" || x.compte.plan === f.plan) &&
      (!f.nonRattaches || (x.items.length === 0 && x.statut === "traite")) &&
      (!cherche || x.texte.toLowerCase().includes(cherche) || x.compte.nom.toLowerCase().includes(cherche)),
  );
}

export function Feedbacks({ feedbacks, erreur, titres, nouveaux, natureInitiale = "toutes", onOuvrirItem }: Props) {
  const [nature, setNature] = useState<FiltreNature>(natureInitiale);
  const [plan, setPlan] = useState<Plan | "tous">("tous");
  const [nonRattaches, setNonRattaches] = useState(false);
  const [texte, setTexte] = useState("");
  const filtresActifs = nature !== "toutes" || plan !== "tous" || nonRattaches || texte.trim() !== "";
  const affiches = feedbacks ? filtrer(feedbacks, { nature, plan, nonRattaches, texte }) : null;
  // Les messages déjà affichés à l'ouverture de la vue ne glissent pas en entrée ; ceux qui arrivent ensuite, si.
  const vus = useRef<Set<string> | null>(null);
  if (feedbacks && !vus.current) vus.current = new Set(feedbacks.map((f) => f.id));

  return (
    <section className="vue-feedbacks" aria-labelledby="titre-fil">
      <div className="vue-entete">
        <h2 id="titre-fil">Feedbacks</h2>
        {feedbacks && affiches ? <span className="colonne-compte">{filtresActifs ? `${affiches.length} sur ${feedbacks.length}` : `${feedbacks.length} messages`}</span> : null}
      </div>
      {feedbacks && feedbacks.length > 0 ? (
        <div className="fil-filtres" role="search" aria-label="Filtrer les feedbacks">
          <input type="search" value={texte} onChange={(e) => setTexte(e.target.value)} placeholder="Chercher un client, un mot…" aria-label="Chercher dans les feedbacks" />
          <select value={nature} onChange={(e) => setNature(e.target.value as FiltreNature)} aria-label="Nature">
            <option value="toutes">Toutes natures</option>
            <option value="demande">Demandes</option>
            <option value="bug">Bugs</option>
            <option value="question">Questions</option>
            <option value="compliment">Compliments</option>
            <option value="bruit">Bruit</option>
            <option value="suspect">Suspects</option>
          </select>
          <select value={plan} onChange={(e) => setPlan(e.target.value as Plan | "tous")} aria-label="Plan">
            <option value="tous">Tous plans</option>
            <option value="business">Business</option>
            <option value="pro">Pro</option>
            <option value="free">Free</option>
          </select>
          <label className="fil-case">
            <input type="checkbox" checked={nonRattaches} onChange={(e) => setNonRattaches(e.target.checked)} /> Rattachés à rien
          </label>
        </div>
      ) : null}
      {erreur && !feedbacks ? <ErreurPanneau message={erreur} /> : null}
      {!feedbacks && !erreur ? <Chargement /> : null}
      {feedbacks && feedbacks.length === 0 ? (
        <Vide titre="Aucun feedback pour l'instant.">
          Cliquez sur « Démo : message suivant », en bas à droite, pour envoyer un message client : l'agent le lit, le classe et le rattache au backlog.
        </Vide>
      ) : null}
      {affiches && feedbacks && feedbacks.length > 0 && affiches.length === 0 ? <p className="vide-court">Aucun message pour ces filtres.</p> : null}
      <ul className="fil">
        {affiches?.map((f) => (
          <CarteFeedback key={f.id} f={f} nouveau={nouveaux.has(f.id)} entree={!(vus.current?.has(f.id) ?? true)} titres={titres} onOuvrirItem={onOuvrirItem} />
        ))}
      </ul>
    </section>
  );
}

function CarteFeedback({ f, nouveau, entree, titres, onOuvrirItem }: { f: FeedbackApi; nouveau: boolean; entree: boolean; titres: Map<string, string>; onOuvrirItem: (id: string) => void }) {
  const [deplie, setDeplie] = useState(false);
  const suspect = f.statut === "suspect" || f.nature === "suspect";
  const [texteVisible, setTexteVisible] = useState(!suspect);
  const long = f.texte.length > LONGUEUR_COURTE;
  const texte = deplie || !long ? f.texte : `${f.texte.slice(0, LONGUEUR_COURTE).trimEnd()}…`;

  return (
    <li className={`carte-fb${suspect ? " carte-fb-suspect" : ""}${entree ? " entree" : ""}${nouveau ? " carte-fb-nouveau" : ""}${f.menaceDepart ? " carte-fb-menace" : ""}`}>
      <div className="carte-fb-haut">
        <IconeCanal canal={f.canal} />
        <span className="carte-fb-date">{dateCourte(f.recuLe)}</span>
        {nouveau ? <span className="marque-nouveau">nouveau</span> : null}
        {/* « traité » est l'état normal : seul un autre état s'affiche (en cours de lecture, en quarantaine…). */}
        {f.statut !== "traite" ? <span className={`statut-fb statut-${f.statut}`}>{LIBELLE_STATUT_FEEDBACK[f.statut] ?? f.statut}</span> : null}
      </div>
      <div className="carte-fb-compte">
        <strong>{f.compte.nom}</strong>
        <BadgePlan plan={f.compte.plan} />
        <span className="mrr">{mrr(f.compte.mrr)}</span>
      </div>

      {suspect ? (
        <div className="quarantaine">
          <strong>Quarantaine.</strong> Ce message tente de donner des ordres à l'agent : il est isolé, aucune preuve ni écriture n'en est tirée.
          <button type="button" className="lien" onClick={() => setTexteVisible((v) => !v)} aria-expanded={texteVisible}>
            {texteVisible ? "Masquer le texte" : "Voir le texte brut"}
          </button>
        </div>
      ) : null}

      {texteVisible ? (
        <p className={`carte-fb-texte${suspect ? " texte-suspect" : ""}`}>
          {texte}
          {long ? (
            <button type="button" className="lien" onClick={() => setDeplie((d) => !d)} aria-expanded={deplie} aria-label={deplie ? "Réduire le feedback" : "Lire tout le feedback"}>
              {deplie ? " réduire" : " lire tout"}
            </button>
          ) : null}
        </p>
      ) : null}

      <div className="carte-fb-bas">
        {f.nature ? <Badge ton={TON_NATURE[f.nature] ?? "neutre"}>{LIBELLE_NATURE[f.nature] ?? f.nature}</Badge> : null}
        {f.menaceDepart ? <Badge ton="risque">menace de départ</Badge> : f.compte.risqueDepart ? <Badge ton="risque" titre="Compte signalé à risque de départ">compte à risque</Badge> : null}
        {f.items.map((id) => (
          <button key={id} type="button" className="puce-item" onClick={() => onOuvrirItem(id)} title={`Voir pourquoi « ${titres.get(id) ?? id} » est classé ainsi`}>
            → {titres.get(id) ?? id}
          </button>
        ))}
      </div>
    </li>
  );
}
