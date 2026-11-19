import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, messageErreur, type FiltreVue } from "./api.ts";
import { LIBELLE_OUTIL } from "./format.ts";
import { Badge } from "./ui.tsx";

interface Message {
  role: "user" | "assistant";
  texte: string;
  outils?: string[];
}

// Le nom de l'élément d'abord, pour le jury ; son identifiant entre parenthèses, que l'agent sait aussi lire.
const SUGGESTIONS = [
  "Pourquoi le SSO (B03) est-il classé ainsi ?",
  "Et si les permissions par projet (B02) avaient un impact 3 ?",
  "Quel est le top 5 pondéré par le MRR ?",
  "Quelles règles de doctrine sont actives ?",
];

/**
 * Questions libres du PO. L'agent n'a que des outils de lecture et de simulation : il explique, il ne modifie rien.
 * Il raisonne sur la vue affichée (`filtres`), pour que ses rangs et ses scores soient ceux de l'écran.
 */
export function Conversation({ filtres, libelleVue }: { filtres: FiltreVue[]; libelleVue: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [saisie, setSaisie] = useState("");
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const fin = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fin.current?.scrollIntoView({ block: "end" });
  }, [messages, enCours]);

  const envoyer = async (texte: string) => {
    const question = texte.trim();
    if (question.length < 2 || enCours) return;
    const historique = messages.map((m) => ({ role: m.role, texte: m.texte }));
    setMessages((m) => [...m, { role: "user", texte: question }]);
    setSaisie("");
    setErreur(null);
    setEnCours(true);
    try {
      const r = await api.converser(question, historique, filtres);
      setMessages((m) => [...m, { role: "assistant", texte: r.reponse, outils: r.outils }]);
    } catch (e) {
      setErreur(messageErreur(e));
    } finally {
      setEnCours(false);
    }
  };

  const soumettre = (e: FormEvent) => {
    e.preventDefault();
    void envoyer(saisie);
  };

  return (
    <div className="conversation">
      <p className="aide" title="Outils en lecture seule : classement, détail d'un item, simulation « et si », recherche dans les feedbacks, doctrine.">
        L'agent répond sur la vue affichée (<strong>{libelleVue}</strong>), avec des outils en lecture seule. Il ne modifie rien : les décisions restent dans la file « À décider ».
      </p>
      {messages.length === 0 ? (
        <div className="conversation-suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="bouton" onClick={() => void envoyer(s)}>
              {s}
            </button>
          ))}
        </div>
      ) : null}
      <div className="conversation-fil" aria-live="polite">
        {messages.map((m, i) => (
          <div key={i} className={`bulle bulle-${m.role === "user" ? "po" : "agent"}`}>
            <div className="bulle-auteur">{m.role === "user" ? "Vous" : "Agent"}</div>
            <div className="bulle-texte">{m.texte}</div>
            {m.outils && m.outils.length > 0 ? (
              <div className="bulle-outils">
                {m.outils.map((o, j) => (
                  <Badge key={j} ton="discret" titre="Outil utilisé par l'agent">
                    {LIBELLE_OUTIL[o] ?? o}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        ))}
        {enCours ? <div className="bulle bulle-agent bulle-attente">L'agent consulte le backlog…</div> : null}
        <div ref={fin} />
      </div>
      {erreur ? (
        <p className="conversation-erreur" role="alert">
          {erreur}
        </p>
      ) : null}
      <form className="conversation-saisie" onSubmit={soumettre}>
        <label htmlFor="question-po" className="visuellement-cache">
          Votre question
        </label>
        <input id="question-po" type="text" value={saisie} onChange={(e) => setSaisie(e.target.value)} placeholder="Pourquoi le SSO passe-t-il devant le mode sombre ?" disabled={enCours} autoComplete="off" />
        <button type="submit" className="bouton bouton-principal" disabled={enCours || saisie.trim().length < 2}>
          Demander
        </button>
      </form>
    </div>
  );
}
