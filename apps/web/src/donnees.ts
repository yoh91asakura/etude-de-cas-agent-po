/**
 * État partagé du cockpit : chargement des panneaux, flux SSE, sondage de secours.
 * Chaque ressource porte un numéro de séquence : une réponse plus ancienne que la dernière demandée est ignorée.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ErreurApi,
  messageErreur,
  type AlerteApi,
  type EntreeJournalApi,
  type EtatApi,
  type EvenementFlux,
  type FeedbackApi,
  type FiltreVue,
  type LigneClassement,
  type MoscowApi,
  type PropositionApi,
  type QuestionApi,
  type RegleApi,
  type SanteApi,
  type TypeEvenementApi,
} from "./api.ts";

export type Cle = "etat" | "feedbacks" | "classement" | "moscow" | "regles" | "journal" | "sante" | "questions" | "propositions" | "alertes";

export const TOUTES: Cle[] = ["etat", "feedbacks", "classement", "moscow", "regles", "journal", "sante", "questions", "propositions", "alertes"];

interface Ressources {
  etat: EtatApi;
  feedbacks: FeedbackApi[];
  classement: LigneClassement[];
  moscow: MoscowApi;
  regles: RegleApi[];
  journal: EntreeJournalApi[];
  sante: SanteApi;
  questions: QuestionApi[];
  propositions: PropositionApi[];
  alertes: AlerteApi[];
}

export type Donnees = { [K in Cle]: Ressources[K] | null };

/** Mouvement d'une ligne du backlog entre les deux derniers classements différents. */
export interface Mouvement {
  /** Positif : la ligne monte. */
  delta: number;
  nouveau: boolean;
  scoreAvant: number | null;
}

export interface Mouvements {
  parItem: Map<string, Mouvement>;
  /** Incrémenté à chaque changement de classement : relance l'animation des lignes qui bougent. */
  generation: number;
}

export type EtatFlux = "connexion" | "direct" | "reconnexion";

/** Dernier message client arrivé par le flux : le cockpit l'annonce (notification, ligne d'état). `n` change à chaque arrivée. */
export interface Arrivee {
  id: string;
  statut: "recu" | "suspect";
  n: number;
}

/** Panneaux à recharger pour chaque type d'événement du flux. Le journal et la santé suivent toute activité. */
const PANNEAUX_PAR_EVENEMENT: Record<TypeEvenementApi, Cle[]> = {
  feedback: ["etat", "feedbacks", "journal", "sante"],
  classement: ["etat", "classement", "moscow", "journal"],
  alerte: ["alertes", "sante", "journal"],
  question: ["etat", "questions", "journal", "sante"],
  proposition: ["etat", "propositions", "classement", "journal", "sante"],
  regle: ["regles", "propositions", "classement", "journal"],
  story: ["classement", "propositions", "journal"],
  journal: ["journal", "sante"],
};

const VIDE: Donnees = {
  etat: null,
  feedbacks: null,
  classement: null,
  moscow: null,
  regles: null,
  journal: null,
  sante: null,
  questions: null,
  propositions: null,
  alertes: null,
};

function charger(cle: Cle, filtres: FiltreVue[]): Promise<unknown> {
  switch (cle) {
    case "etat":
      return api.etat();
    case "feedbacks":
      // Tout le fil (le jeu en compte une centaine) : le PO filtre dans le cockpit, et les anciens messages restent accessibles.
      return api.feedbacks(500);
    case "classement":
      return api.classement(filtres);
    case "moscow":
      return api.moscow(filtres);
    case "regles":
      return api.regles();
    case "journal":
      return api.journal(100);
    case "sante":
      return api.sante();
    case "questions":
      return api.questions();
    case "propositions":
      return api.propositions();
    case "alertes":
      return api.alertes();
  }
}

function calculerMouvements(avant: LigneClassement[], apres: LigneClassement[]): Map<string, Mouvement> | null {
  const rangsAvant = new Map(avant.map((l) => [l.itemId, l]));
  const change =
    avant.length !== apres.length || apres.some((l) => {
      const a = rangsAvant.get(l.itemId);
      return !a || a.rang !== l.rang || Math.abs(a.score - l.score) > 1e-9;
    });
  if (!change) return null;
  const parItem = new Map<string, Mouvement>();
  for (const l of apres) {
    const a = rangsAvant.get(l.itemId);
    parItem.set(l.itemId, { delta: a ? a.rang - l.rang : 0, nouveau: !a, scoreAvant: a ? a.score : null });
  }
  return parItem;
}

export function useCockpit() {
  const [donnees, setDonnees] = useState<Donnees>(VIDE);
  const [erreurs, setErreurs] = useState<Partial<Record<Cle, string>>>({});
  const [joignable, setJoignable] = useState(true);
  const [flux, setFlux] = useState<EtatFlux>("connexion");
  const [filtres, setFiltresEtat] = useState<FiltreVue[]>([]);
  const [mouvements, setMouvements] = useState<Mouvements>({ parItem: new Map(), generation: 0 });
  /** Incrémenté à chaque événement qui peut changer le détail d'un item (tiroir, stories). */
  const [versionDetails, setVersionDetails] = useState(0);
  /** Heure (ms) du dernier événement du flux : la ligne d'état dit si l'agent travaille. */
  const [derniereActivite, setDerniereActivite] = useState<number | null>(null);
  const [arrivee, setArrivee] = useState<Arrivee | null>(null);
  /** Messages présents à l'ouverture du cockpit : les suivants sont marqués « nouveau » pour la séance. */
  const idsInitiaux = useRef<Set<string> | null>(null);

  const sequences = useRef<Record<Cle, number>>(Object.fromEntries(TOUTES.map((c) => [c, 0])) as Record<Cle, number>);
  const filtresRef = useRef<FiltreVue[]>([]);
  const classementPrecedent = useRef<LigneClassement[] | null>(null);
  const joignableRef = useRef(true);
  const etatPrecedent = useRef<EtatApi | null>(null);
  const enAttente = useRef<Set<Cle>>(new Set());
  const minuterie = useRef<ReturnType<typeof setTimeout> | null>(null);

  const appliquerClassement = useCallback((lignes: LigneClassement[]) => {
    const avant = classementPrecedent.current;
    classementPrecedent.current = lignes;
    if (!avant) return;
    const parItem = calculerMouvements(avant, lignes);
    if (parItem) setMouvements((m) => ({ parItem, generation: m.generation + 1 }));
  }, []);

  const marquerJoignable = useCallback((ok: boolean) => {
    joignableRef.current = ok;
    setJoignable(ok);
  }, []);

  const rafraichir = useCallback(
    (cles: Iterable<Cle>) => {
      for (const cle of new Set(cles)) {
        const seq = ++sequences.current[cle];
        const filtresDemandes = filtresRef.current;
        charger(cle, filtresDemandes)
          .then((valeur) => {
            if (seq !== sequences.current[cle]) return;
            if (cle === "classement") appliquerClassement(valeur as LigneClassement[]);
            if (cle === "feedbacks" && !idsInitiaux.current) idsInitiaux.current = new Set((valeur as FeedbackApi[]).map((f) => f.id));
            setDonnees((d) => ({ ...d, [cle]: valeur }));
            setErreurs((e) => (e[cle] ? { ...e, [cle]: undefined } : e));
            if (cle === "etat") marquerJoignable(true);
          })
          .catch((e: unknown) => {
            if (seq !== sequences.current[cle]) return;
            setErreurs((er) => ({ ...er, [cle]: messageErreur(e) }));
            if (cle === "etat" || (e instanceof ErreurApi && e.statut === null)) marquerJoignable(false);
          });
      }
    },
    [appliquerClassement, marquerJoignable],
  );

  /** Regroupe les rechargements demandés pendant ~300 ms. */
  const planifier = useCallback(
    (cles: Iterable<Cle>) => {
      for (const c of cles) enAttente.current.add(c);
      if (minuterie.current) clearTimeout(minuterie.current);
      minuterie.current = setTimeout(() => {
        const lot = [...enAttente.current];
        enAttente.current.clear();
        minuterie.current = null;
        rafraichir(lot);
        // Le détail d'un item (tiroir, stories) suit le classement et les questions : un seul rechargement par lot.
        if (lot.includes("classement") || lot.includes("questions")) setVersionDetails((v) => v + 1);
      }, 300);
    },
    [rafraichir],
  );

  /**
   * Change la vue du backlog. Un changement à la main montre les montées et les descentes qu'il provoque.
   * `silencieux` (ouverture du cockpit sur la vue de l'agent) repart de zéro : sans cela, la première vue affichée
   * montrerait des flèches de mouvement alors que rien ne s'est passé.
   */
  const setFiltres = useCallback(
    (f: FiltreVue[], options?: { silencieux?: boolean }) => {
      filtresRef.current = f;
      setFiltresEtat(f);
      if (options?.silencieux) {
        classementPrecedent.current = null;
        setMouvements((m) => ({ parItem: new Map(), generation: m.generation }));
      }
      rafraichir(["classement", "moscow"]);
      setVersionDetails((v) => v + 1);
    },
    [rafraichir],
  );

  // Premier chargement.
  useEffect(() => {
    rafraichir(TOUTES);
    return () => {
      if (minuterie.current) clearTimeout(minuterie.current);
    };
  }, [rafraichir]);

  // Flux SSE, avec reconnexion manuelle quand le navigateur abandonne (réponse non 200 pendant un redémarrage de l'API).
  useEffect(() => {
    let source: EventSource | null = null;
    let relance: ReturnType<typeof setTimeout> | null = null;
    let actif = true;
    let dejaConnecte = false;

    const ouvrir = () => {
      if (!actif) return;
      source = new EventSource("/api/flux");
      source.onopen = () => {
        setFlux("direct");
        // Après une coupure, des événements ont pu être manqués : tout recharger.
        if (dejaConnecte) planifier(TOUTES);
        dejaConnecte = true;
      };
      source.onmessage = (m: MessageEvent<string>) => {
        let evt: EvenementFlux | null = null;
        try {
          evt = JSON.parse(m.data) as EvenementFlux;
        } catch {
          return;
        }
        setDerniereActivite(Date.now());
        if (evt?.type === "feedback") {
          const d = evt.donnees as { id?: unknown; statut?: unknown } | null;
          const id = typeof d?.id === "string" ? d.id : null;
          if (id && (d?.statut === "recu" || d?.statut === "suspect")) {
            const statut = d.statut;
            setArrivee((a) => ({ id, statut, n: (a?.n ?? 0) + 1 }));
          }
        }
        const cles = evt && PANNEAUX_PAR_EVENEMENT[evt.type];
        planifier(cles ?? TOUTES);
      };
      source.onerror = () => {
        if (!source) return;
        if (source.readyState === EventSource.CLOSED) {
          source.close();
          source = null;
          setFlux("reconnexion");
          relance = setTimeout(ouvrir, 3000);
        } else {
          setFlux("reconnexion");
        }
      };
    };
    ouvrir();
    return () => {
      actif = false;
      if (relance) clearTimeout(relance);
      source?.close();
    };
  }, [planifier]);

  // Sondage de secours de /api/etat toutes les 5 s : si les compteurs bougent, recharger les panneaux concernés.
  useEffect(() => {
    const id = setInterval(() => {
      const seq = ++sequences.current.etat;
      api
        .etat()
        .then((etat) => {
          if (seq !== sequences.current.etat) return;
          const avant = etatPrecedent.current;
          setDonnees((d) => ({ ...d, etat }));
          setErreurs((e) => (e.etat ? { ...e, etat: undefined } : e));
          // Retour de l'API après une coupure : tout recharger.
          if (!joignableRef.current) planifier(TOUTES);
          marquerJoignable(true);
          if (!avant) return;
          const a = avant.compteurs;
          const n = etat.compteurs;
          const cles = new Set<Cle>();
          if (a.feedbacks !== n.feedbacks || a.traites !== n.traites || a.enAttente !== n.enAttente || a.suspects !== n.suspects || avant.simulateurRestants !== etat.simulateurRestants) {
            ["feedbacks", "classement", "moscow", "alertes", "journal", "sante"].forEach((c) => cles.add(c as Cle));
          }
          if (a.questionsOuvertes !== n.questionsOuvertes) ["questions", "journal"].forEach((c) => cles.add(c as Cle));
          if (a.propositionsEnAttente !== n.propositionsEnAttente) ["propositions", "regles", "classement"].forEach((c) => cles.add(c as Cle));
          if (cles.size > 0) planifier(cles);
        })
        .catch((e: unknown) => {
          if (seq !== sequences.current.etat) return;
          setErreurs((er) => ({ ...er, etat: messageErreur(e) }));
          marquerJoignable(false);
        });
    }, 5000);
    return () => clearInterval(id);
  }, [planifier, marquerJoignable]);

  // Mémorise le dernier état reçu, quelle que soit sa source, pour comparer au sondage suivant.
  useEffect(() => {
    if (donnees.etat) etatPrecedent.current = donnees.etat;
  }, [donnees.etat]);

  const titres = useMemo(() => new Map((donnees.classement ?? []).map((l) => [l.itemId, l.titre])), [donnees.classement]);

  const feedbacksNouveaux = useMemo(() => {
    const initiaux = idsInitiaux.current;
    return new Set(initiaux ? (donnees.feedbacks ?? []).filter((f) => !initiaux.has(f.id)).map((f) => f.id) : []);
  }, [donnees.feedbacks]);

  return { donnees, erreurs, joignable, flux, filtres, setFiltres, mouvements, versionDetails, rafraichir, planifier, titres, derniereActivite, arrivee, feedbacksNouveaux };
}

export type Cockpit = ReturnType<typeof useCockpit>;
