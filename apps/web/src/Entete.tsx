import { useEffect, useState, type ReactNode } from "react";
import type { EtatApi, FiltreVue } from "./api.ts";
import type { EtatFlux } from "./donnees.ts";
import { Produit } from "./Produit.tsx";
import { Badge } from "./ui.tsx";

interface Props {
  etat: EtatApi | null;
  flux: EtatFlux;
  /** Heure (ms) du dernier événement reçu du flux. */
  derniereActivite: number | null;
  /** Ouvre la vue Feedbacks sur les messages en quarantaine. */
  onQuarantaine: () => void;
  /** La seconde ligne de l'en-tête : la navigation et les filtres. */
  children?: ReactNode;
}

/** « claude (anthropic/claude-haiku-5.5) via OpenRouter, fournisseur anthropic » devient « Claude Haiku 5.5 · OpenRouter ». */
export function libelleFournisseur(nom: string): string {
  const m = /\(([^);]+)/.exec(nom);
  const brut = (m?.[1] ?? nom).replace(/^anthropic\//, "").trim();
  // Un modèle par étape : on nomme les familles utilisées (« Sonnet, Haiku, Opus selon l'étape »).
  if (brut === "modèle par étape") {
    const familles = [...new Set([...nom.matchAll(/claude-(haiku|sonnet|opus|fable)/g)].map((x) => x[1] ?? ""))].filter(Boolean);
    return `${familles.map((f) => f.charAt(0).toUpperCase() + f.slice(1)).join(", ")} selon l'étape${nom.includes("OpenRouter") ? " · OpenRouter" : ""}`;
  }
  const morceaux = brut.split("-");
  const version = morceaux.filter((x) => /^\d/.test(x)).join(".");
  const noms = morceaux.filter((x) => !/^\d/.test(x)).map((x) => x.charAt(0).toUpperCase() + x.slice(1));
  return `${[...noms, version].filter(Boolean).join(" ")}${nom.includes("OpenRouter") ? " · OpenRouter" : ""}`;
}

export function Entete({ etat, flux, derniereActivite, onQuarantaine, children }: Props) {
  const [produitOuvert, setProduitOuvert] = useState(false);
  const suspects = etat?.compteurs.suspects ?? 0;

  return (
    <header className="entete">
      <div className="entete-ligne">
        <div className="entete-marque">
          <span className="logo" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="28" height="28">
              <rect width="32" height="32" rx="8" fill="currentColor" />
              <path d="M8 22l5-6 4 4 6-10" stroke="white" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <h1>Jalonne · Agent PO</h1>
          <button type="button" className="lien lien-produit" onClick={() => setProduitOuvert(true)} title="Le produit fictif du scénario : activité, clients, objectif du trimestre">
            Le produit
          </button>
        </div>

        <EtatAgent etat={etat} flux={flux} derniereActivite={derniereActivite} />

        <div className="entete-puces">
          {/* La défense contre l'injection reste visible en permanence : un message suspect est isolé, jamais lu par un appel qui a des outils. */}
          {suspects > 0 ? (
            <button type="button" className="puce-quarantaine" onClick={onQuarantaine} title="Messages qui tentent de donner des ordres à l'agent : isolés, aucune preuve ni écriture n'en est tirée. Cliquer pour les voir.">
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M8 1.5l6 2.2v4.1c0 3.4-2.5 5.8-6 6.7-3.5-.9-6-3.3-6-6.7V3.7z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                <path d="M8 5v3.6M8 10.8v.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              {suspects} message{suspects > 1 ? "s" : ""} en quarantaine
            </button>
          ) : null}
          {etat && !etat.parametresValides ? (
            <Badge ton="doute" titre="Formules et seuils proposés par l'IA, en attente de relecture humaine.">
              Paramètres à valider
            </Badge>
          ) : null}
          {etat?.fournisseurFactice ? (
            <Badge ton="orange" titre="Aucune clé d'API : le fournisseur factice renvoie des réponses fixes.">
              Démo sans clé : résultats factices
            </Badge>
          ) : null}
        </div>
      </div>
      {children}
      {produitOuvert ? <Produit onFermer={() => setProduitOuvert(false)} /> : null}
    </header>
  );
}

const LIBELLE_FLUX: Record<EtatFlux, string> = {
  connexion: "connexion…",
  direct: "à jour",
  reconnexion: "reconnexion…",
};

/** Délai pendant lequel l'agent est dit « au travail » après le dernier événement du flux. */
const DUREE_ACTIVITE_MS = 6000;

/** Une ligne d'état : ce que fait l'agent en ce moment, d'après le flux en direct et les messages à lire. */
function EtatAgent({ etat, flux, derniereActivite }: { etat: EtatApi | null; flux: EtatFlux; derniereActivite: number | null }) {
  const [maintenant, setMaintenant] = useState(() => Date.now());
  const recent = derniereActivite !== null && maintenant - derniereActivite < DUREE_ACTIVITE_MS;
  useEffect(() => {
    if (derniereActivite === null) return;
    setMaintenant(Date.now());
    // Repasse à « à jour » quand l'activité retombe, sans horloge permanente.
    const id = setTimeout(() => setMaintenant(Date.now()), DUREE_ACTIVITE_MS + 50);
    return () => clearTimeout(id);
  }, [derniereActivite]);

  const aLire = etat?.compteurs.enAttente ?? 0;
  let texte: string;
  let ton: "pret" | "travail" | "attente";
  if (flux !== "direct") {
    texte = LIBELLE_FLUX[flux];
    ton = "attente";
  } else if (aLire > 0) {
    texte = `lit ${aLire} message${aLire > 1 ? "s" : ""}…`;
    ton = "travail";
  } else if (recent) {
    texte = "met le backlog à jour…";
    ton = "travail";
  } else {
    texte = "à jour";
    ton = "pret";
  }
  return (
    <span className={`etat-agent etat-agent-${ton}`} role="status" title="L'agent travaille en continu : il lit chaque message, recalcule les scores et vous soumet ce qui demande une décision. Mises à jour en direct.">
      <span className="etat-agent-point" aria-hidden="true" />
      Agent : {texte}
    </span>
  );
}

interface FiltresProps {
  etat: EtatApi | null;
  filtres: FiltreVue[];
  setFiltres: (f: FiltreVue[]) => void;
  /** Libellé de la vue sur laquelle l'agent raisonne. */
  vueReference: string;
}

/** Les deux filtres du classement, et un retour à la vue de l'agent quand le PO s'en écarte. */
export function Filtres({ etat, filtres, setFiltres, vueReference }: FiltresProps) {
  const reference = [...(etat?.vueReference ?? [])].sort();
  const surLaVueAgent = reference.join(",") === [...filtres].sort().join(",");
  const basculer = (f: FiltreVue) => {
    setFiltres(filtres.includes(f) ? filtres.filter((x) => x !== f) : [...filtres, f].sort());
  };
  return (
    <div className="filtres" role="group" aria-label="Filtres du classement">
      <button type="button" className="bascule" aria-pressed={filtres.includes("mrr")} onClick={() => basculer("mrr")} title="Le Reach devient le MRR exposé (k€), majoré pour les comptes à risque de départ.">
        <span className="bascule-piste" aria-hidden="true" />
        MRR
      </button>
      <button type="button" className="bascule" aria-pressed={filtres.includes("objectif")} onClick={() => basculer("objectif")} title="Bonus pour les items alignés sur l'objectif du trimestre (voir « Le produit »).">
        <span className="bascule-piste" aria-hidden="true" />
        Objectif du trimestre
      </button>
      {etat && !surLaVueAgent ? (
        <button type="button" className="lien lien-vue-agent" onClick={() => setFiltres(reference as FiltreVue[])} title={`L'agent raisonne sur la vue ${vueReference} : ses alertes, ses stories et l'ordre qu'il propose en dépendent.`}>
          Revenir à la vue de l'agent
        </button>
      ) : null}
    </div>
  );
}
