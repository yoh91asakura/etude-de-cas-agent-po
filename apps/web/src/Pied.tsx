import { useCallback, useEffect, useRef, useState } from "react";
import { api, messageErreur, type EtatApi } from "./api.ts";
import type { Cle } from "./donnees.ts";
import { useNotifier } from "./ui.tsx";

interface Props {
  etat: EtatApi | null;
  rafraichir: (cles: Cle[]) => void;
}

/**
 * Le bas de l'écran : les commandes qui déclenchent l'agent à la demande (passage de fond, simulateur de démo).
 * Elles quittent l'en-tête du produit (décision 014) : chacune appelle le modèle, donc coûte.
 */
export function Pied({ etat, rafraichir }: Props) {
  const notifier = useNotifier();
  const [envoi, setEnvoi] = useState(false);
  const [passage, setPassage] = useState(false);
  const restants = etat?.simulateurRestants ?? null;

  const suivant = useCallback(async () => {
    setEnvoi(true);
    try {
      const r = await api.simulateurSuivant();
      if (!r.id) notifier("Plus aucun message à injecter dans le simulateur.", "info");
      rafraichir(["etat", "feedbacks", "journal"]);
    } catch (e) {
      notifier(`Injection impossible : ${messageErreur(e)}`, "erreur");
    } finally {
      setEnvoi(false);
    }
  }, [notifier, rafraichir]);

  const passageDeFond = async () => {
    setPassage(true);
    try {
      const r = await api.passageDeFond();
      notifier(r.resume, "info");
      rafraichir(["etat", "questions", "propositions", "alertes", "journal"]);
    } catch (e) {
      notifier(`Passage impossible : ${messageErreur(e)}`, "erreur");
    } finally {
      setPassage(false);
    }
  };

  // Raccourci du présentateur : Alt+N injecte le message suivant, une fois par appui.
  const peutInjecter = !envoi && restants !== 0;
  const suivantRef = useRef(suivant);
  suivantRef.current = suivant;
  useEffect(() => {
    const touche = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.repeat || e.key.toLowerCase() !== "n") return;
      e.preventDefault();
      if (peutInjecter) void suivantRef.current();
    };
    window.addEventListener("keydown", touche);
    return () => window.removeEventListener("keydown", touche);
  }, [peutInjecter]);

  return (
    <footer className="pied" aria-label="Commandes de l'agent à la demande">
      <button
        type="button"
        className="pied-bouton"
        onClick={() => void passageDeFond()}
        disabled={passage}
        title="Déclenche un passage de l'agent de fond (prévu à 9 h, 13 h et 17 h) : relances, fusions à trancher, règles qui généralisent vos réponses, résumé. Appelle le modèle."
      >
        {passage ? "Passage…" : "Passage de fond"}
      </button>
      <button
        type="button"
        className="pied-bouton pied-demo"
        title="Simulateur de démo : injecte le prochain message client du scénario. L'agent le traite aussitôt (appels au modèle). Raccourci : Alt+N."
        onClick={() => void suivant()}
        disabled={!peutInjecter}
        aria-keyshortcuts="Alt+N"
        aria-label={`Démo : injecter le message suivant${restants !== null ? `, ${restants} restants` : ""}`}
      >
        {envoi ? "Injection…" : "Démo : message suivant"}
        {restants !== null ? <span className="bouton-compte">{restants}</span> : null}
        <kbd>Alt+N</kbd>
      </button>
    </footer>
  );
}
