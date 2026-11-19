/** Petits composants partagés : badges, états vides, icônes, garde d'erreur, sparkline, notifications. */
import { Component, createContext, useCallback, useContext, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import type { Plan } from "./api.ts";
import { LIBELLE_CANAL, LIBELLE_PLAN } from "./format.ts";

export type Ton = "neutre" | "accent" | "doute" | "risque" | "orange" | "discret";

export function Badge({ ton = "neutre", children, titre }: { ton?: Ton; children: ReactNode; titre?: string }) {
  return (
    <span className={`badge badge-${ton}`} title={titre}>
      {children}
    </span>
  );
}

export function BadgePlan({ plan }: { plan: Plan }) {
  return <span className={`plan plan-${plan}`}>{LIBELLE_PLAN[plan] ?? plan}</span>;
}

export function PuceRegle({ id }: { id: string }) {
  return (
    <span className="puce-regle" title={`Règle de doctrine ${id}`}>
      <svg viewBox="0 0 16 16" aria-hidden="true" width="12" height="12">
        <path d="M3 2h7l3 3v9H3z" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5 8h6M5 11h4" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      {id}
    </span>
  );
}

/**
 * L'explication d'une vue, repliée derrière un « ? » (décision 014). À placer dans une rangée `.vue-outils` :
 * le bouton se range à droite, le texte déplié prend toute la largeur en dessous.
 */
export function Aide({ children, titre = "Comment lire cette vue" }: { children: ReactNode; titre?: string }) {
  const [ouverte, setOuverte] = useState(false);
  return (
    <>
      <button type="button" className="aide-bouton" aria-expanded={ouverte} aria-label={titre} title={titre} onClick={() => setOuverte((o) => !o)}>
        ?
      </button>
      {ouverte ? <div className="aide aide-depliee">{children}</div> : null}
    </>
  );
}

export function Vide({ titre, children }: { titre: string; children?: ReactNode }) {
  return (
    <div className="vide">
      <p className="vide-titre">{titre}</p>
      {children ? <p className="vide-texte">{children}</p> : null}
    </div>
  );
}

export function Chargement({ texte = "Chargement…" }: { texte?: string }) {
  return (
    <div className="chargement" role="status">
      <span className="rond-chargement" aria-hidden="true" />
      {texte}
    </div>
  );
}

export function ErreurPanneau({ message }: { message: string }) {
  return (
    <div className="erreur-panneau" role="alert">
      Impossible de charger ce panneau : {message}.
    </div>
  );
}

export function IconeCanal({ canal }: { canal: string }) {
  const chemins: Record<string, ReactNode> = {
    email: (
      <>
        <rect x="2" y="4" width="16" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M3 5.5l7 5 7-5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      </>
    ),
    ticket: (
      <>
        <path d="M3 5h14v3a2 2 0 000 4v3H3v-3a2 2 0 000-4z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M12 5v10" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 2" />
      </>
    ),
    commentaire: <path d="M3 4h14v9H8l-4 3v-3H3z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />,
    direct: (
      <>
        <circle cx="10" cy="10" r="2.4" fill="currentColor" />
        <path d="M5.5 5.5a6.4 6.4 0 000 9M14.5 5.5a6.4 6.4 0 010 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </>
    ),
  };
  return (
    <span className="canal" title={LIBELLE_CANAL[canal] ?? canal}>
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        {chemins[canal] ?? <circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />}
      </svg>
      <span className="canal-libelle">{LIBELLE_CANAL[canal] ?? canal}</span>
    </span>
  );
}

/** Courbe minuscule de l'historique d'un score. */
export function Sparkline({ valeurs, largeur = 160, hauteur = 36 }: { valeurs: number[]; largeur?: number; hauteur?: number }) {
  if (valeurs.length === 0) return null;
  const min = Math.min(...valeurs);
  const max = Math.max(...valeurs);
  const marge = 4;
  const etendue = max - min || 1;
  const pas = valeurs.length > 1 ? (largeur - marge * 2) / (valeurs.length - 1) : 0;
  const points = valeurs.map((v, i) => {
    const x = valeurs.length > 1 ? marge + i * pas : largeur / 2;
    const y = max === min ? hauteur / 2 : hauteur - marge - ((v - min) / etendue) * (hauteur - marge * 2);
    return [x, y] as const;
  });
  const dernier = points[points.length - 1]!;
  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${largeur} ${hauteur}`}
      width={largeur}
      height={hauteur}
      role="img"
      aria-label={`Évolution du score sur ${valeurs.length} calculs, de ${min.toFixed(1)} à ${max.toFixed(1)}`}
    >
      {points.length > 1 ? <polyline points={points.map(([x, y]) => `${x},${y}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /> : null}
      <circle cx={dernier[0]} cy={dernier[1]} r="3.5" fill="currentColor" />
    </svg>
  );
}

/** Garde d'erreur : un panneau qui casse n'emporte pas le cockpit entier. */
export class Garde extends Component<{ nom: string; children: ReactNode }, { erreur: Error | null }> {
  override state: { erreur: Error | null } = { erreur: null };

  static getDerivedStateFromError(erreur: Error) {
    return { erreur };
  }

  override componentDidCatch(erreur: Error, info: ErrorInfo) {
    // Trace utile au débogage ; le panneau affiche un message calme.
    console.warn(`Panneau « ${this.props.nom} » :`, erreur, info.componentStack);
  }

  override render() {
    if (this.state.erreur) {
      return (
        <div className="erreur-panneau" role="alert">
          <p>Ce panneau ({this.props.nom}) n'a pas pu s'afficher.</p>
          <button type="button" className="bouton bouton-secondaire" onClick={() => this.setState({ erreur: null })}>
            Réessayer
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ---------- Notifications ---------- */

type GenreNotif = "info" | "succes" | "erreur";
interface Notif {
  id: number;
  texte: string;
  genre: GenreNotif;
}

const ContexteNotif = createContext<(texte: string, genre?: GenreNotif) => void>(() => {});

export function useNotifier() {
  return useContext(ContexteNotif);
}

export function FournisseurNotifications({ children }: { children: ReactNode }) {
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const suivant = useRef(1);

  const retirer = useCallback((id: number) => setNotifs((n) => n.filter((x) => x.id !== id)), []);

  const notifier = useCallback(
    (texte: string, genre: GenreNotif = "info") => {
      const id = suivant.current++;
      setNotifs((n) => [...n.slice(-3), { id, texte, genre }]);
      setTimeout(() => retirer(id), genre === "erreur" ? 7000 : 4500);
    },
    [retirer],
  );

  const valeur = useMemo(() => notifier, [notifier]);

  return (
    <ContexteNotif.Provider value={valeur}>
      {children}
      <div className="notifs" role="status" aria-live="polite">
        {notifs.map((n) => (
          <div key={n.id} className={`notif notif-${n.genre}`}>
            <span>{n.texte}</span>
            <button type="button" className="notif-fermer" aria-label="Fermer la notification" onClick={() => retirer(n.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ContexteNotif.Provider>
  );
}
