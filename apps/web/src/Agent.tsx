import { useState } from "react";
import type { EntreeJournalApi, EtatApi, SanteApi } from "./api.ts";
import { Journal } from "./Journal.tsx";
import { Sante } from "./Sante.tsx";

interface Props {
  journal: EntreeJournalApi[] | null;
  erreurJournal: string | undefined;
  sante: SanteApi | null;
  erreurSante: string | undefined;
  etat: EtatApi | null;
  titres: Map<string, string>;
}

type Vue = "activite" | "sante";

/** Ce que fait l'agent et ce qu'il vaut (décision 014) : son activité (le journal d'audit) et sa santé (les indicateurs). */
export function Agent({ journal, erreurJournal, sante, erreurSante, etat, titres }: Props) {
  const [vue, setVue] = useState<Vue>("activite");
  return (
    <div className="vue-agent-onglet">
      <div className="segment segment-agent" role="group" aria-label="Activité ou santé de l'agent">
        <button type="button" className={`bouton segment-option${vue === "activite" ? " segment-active" : ""}`} aria-pressed={vue === "activite"} onClick={() => setVue("activite")}>
          Activité
        </button>
        <button type="button" className={`bouton segment-option${vue === "sante" ? " segment-active" : ""}`} aria-pressed={vue === "sante"} onClick={() => setVue("sante")}>
          Santé
        </button>
      </div>
      {vue === "activite" ? <Journal journal={journal} erreur={erreurJournal} titres={titres} /> : <Sante sante={sante} erreur={erreurSante} etat={etat} />}
    </div>
  );
}
