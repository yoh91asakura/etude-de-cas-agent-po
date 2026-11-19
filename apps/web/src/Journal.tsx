import { useState, type ReactNode } from "react";
import type { EntreeJournalApi } from "./api.ts";
import { dateCourte, explicationFr, humaniser, LIBELLE_ACTEUR, LIBELLE_CONTROLE, LIBELLE_OUTIL, LIBELLE_VALEUR, libelleCle, libelleFiltres, nombre, valeurCourte } from "./format.ts";
import { Aide, Chargement, ErreurPanneau, PuceRegle, Vide } from "./ui.tsx";

const ACTIONS: Record<string, string> = {
  extraction_en_attente: "Extraction mise en attente",
  mise_en_quarantaine: "Met en quarantaine",
  risque_depart_detecte: "Détecte un risque de départ",
  rattacher: "Rattache un feedback",
  creer_item_candidat: "Crée un item candidat",
  question_creee: "Prépare une question au PO",
  juger_impact: "Juge l'Impact (5 tirages)",
  rescorer: "Recalcule le score",
  repondre: "Répond à une question",
  trancher_rattachement: "Tranche un rattachement",
  proposer_regle: "Propose une règle",
  rejeter_regle: "Rejette une règle",
  valider_regle: "Valide une règle",
  accepter_proposition: "Accepte une proposition",
  refuser_proposition: "Refuse une proposition",
  affiner_complexite: "Affine la complexité",
  rediger_story: "Rédige une story",
  creer_item: "Crée un élément (« Un besoin nouveau »)",
  requalifier_en_bug: "Requalifie en bug",
  relancer_questions: "Relance des questions",
  relancer_feedbacks_en_attente: "Remet des feedbacks en traitement",
  proposer_ordre: "Propose un ordre du backlog",
  proposer_export: "Propose un export Jira",
  exporter_story: "Exporte une story",
  valider_moscow: "Valide le découpage MoSCoW",
  question_libre: "Pose une question à l'agent",
  fusionner: "Fusionne deux éléments",
  defaire_fusion: "Défait une fusion",
  passage_de_fond: "Passage de l'agent de fond",
  alerte_tendance: "Signale un thème émergent",
  suggestion_mcp: "Reçoit une suggestion d'un assistant",
  orienter_support: "Oriente une question vers le support",
  proposer_effort: "Propose une nouvelle taille",
  corriger_effort: "Corrige l'effort",
  corriger_rattachement: "Rattache un verbatim ailleurs",
  modifier_story: "Réécrit une story",
  demander_decoupage: "Demande un découpage de story",
  proposer_decoupage: "Propose un découpage de story",
  decoupage_impossible: "Découpage impossible",
  formulation_regle_reportee: "Reporte la formulation d'une règle",
  formulation_regle_echouee: "Formulation de règle refusée par le modèle",
};

type Filtre = "tout" | "po" | "agent";

const FILTRES: Array<{ id: Filtre; libelle: string }> = [
  { id: "po", libelle: "Décisions du PO" },
  { id: "agent", libelle: "Actions de l'agent" },
  { id: "tout", libelle: "Tout" },
];

interface Props {
  journal: EntreeJournalApi[] | null;
  erreur: string | undefined;
  /** Titres des éléments du backlog, pour afficher « Mode sombre » plutôt que « B04 ». */
  titres: Map<string, string>;
}

/** Compteurs d'un passage de l'agent de fond : affichés seulement quand ils ne valent pas zéro. */
const COMPTEURS = new Set(["regles", "fusions", "expirees", "relancees", "feedbacksRelances"]);
/** Ordre de lecture : « avant » se lit avant « après ». */
const ORDRE_CLES = ["avant", "apres"];
const MOUVEMENTS_VISIBLES = 3;
const ID_ELEMENT = /^[BN]\d{2,3}$/;

function titreElement(v: unknown, titres: Map<string, string>): string {
  const s = String(v);
  if (ID_ELEMENT.test(s)) return titres.get(s) ?? s;
  // Un choix d'Impact (« 0.5 ») s'écrit à la française, comme ailleurs dans le cockpit.
  if (/^\d+(?:\.\d+)?$/.test(s)) return nombre(Number(s), 2);
  return LIBELLE_VALEUR[s] ?? s;
}

/** Résumé lisible de l'objet d'une proposition décidée (règle, story, élément, mouvements) au lieu de son JSON. */
function resumeCharge(v: unknown, titres: Map<string, string>): string {
  if (!v || typeof v !== "object") return valeurCourte(v);
  const c = v as Record<string, unknown>;
  const morceaux: string[] = [];
  if (typeof c.regleId === "string") morceaux.push(`règle ${c.regleId}`);
  if (typeof c.storyId === "string") morceaux.push(`story ${c.storyId}`);
  if (typeof c.itemId === "string") morceaux.push(titreElement(c.itemId, titres));
  if (Array.isArray(c.mouvements)) morceaux.push(`${c.mouvements.length} mouvement${c.mouvements.length > 1 ? "s" : ""}`);
  return morceaux.length > 0 ? morceaux.join(" · ") : "aucun";
}

/** La valeur d'un détail du journal, en clair : titres d'éléments, vues, contrôles, mouvements. */
function valeurDetail(cle: string, v: unknown, titres: Map<string, string>): ReactNode {
  if (cle === "citation") return <q className="citation">{valeurCourte(v)}</q>;
  if (cle === "explication" && typeof v === "string") return explicationFr(v);
  if (cle === "vue" || cle === "vueReference" || cle === "filtres") {
    const filtres = Array.isArray(v) ? v.map(String) : String(v).split(",");
    return libelleFiltres(filtres.map((f) => f.trim()).filter(Boolean));
  }
  if (cle === "controlesKo" && Array.isArray(v)) return v.length === 0 ? "aucun" : v.map((c) => LIBELLE_CONTROLE[String(c)] ?? String(c)).join(", ");
  if (cle === "outils" && Array.isArray(v)) return v.length === 0 ? "aucun" : v.map((o) => LIBELLE_OUTIL[String(o)] ?? String(o)).join(", ");
  if (cle === "charge") return resumeCharge(v, titres);
  if (cle === "mouvements" && Array.isArray(v)) {
    const lignes = v.flatMap((m) => {
      if (!m || typeof m !== "object") return [];
      const x = m as { itemId?: unknown; avant?: unknown; apres?: unknown };
      return [`${titreElement(x.itemId, titres)} : ${x.avant ?? "nouveau"} → ${x.apres ?? "retiré"}`];
    });
    const reste = lignes.length - MOUVEMENTS_VISIBLES;
    return `${lignes.slice(0, MOUVEMENTS_VISIBLES).join(" ; ")}${reste > 0 ? ` ; et ${reste} autre${reste > 1 ? "s" : ""}` : ""}`;
  }
  // Des nombres à virgule séparés par des virgules seraient illisibles (« 0,5, 1 ») : on les sépare par un point médian.
  if (Array.isArray(v)) return v.length === 0 ? "aucun" : v.map((x) => (typeof x === "number" ? nombre(x, 2) : titreElement(x, titres))).join(v.every((x) => typeof x === "number") ? " · " : ", ");
  if (typeof v === "string") return titreElement(v, titres);
  return valeurCourte(v);
}

export function Journal({ journal, erreur, titres }: Props) {
  // Par défaut, ce que le PO a décidé : les centaines d'actions mécaniques de l'agent noient ses décisions.
  const [filtre, setFiltre] = useState<Filtre>("po");
  if (erreur && !journal) return <ErreurPanneau message={erreur} />;
  if (!journal) return <Chargement />;
  if (journal.length === 0) return <Vide titre="Le journal est vide.">Chaque action de l'agent et chaque décision du PO y sera tracée, avec les règles citées.</Vide>;
  const visibles = journal.filter((j) => filtre === "tout" || (filtre === "po" ? j.acteur === "po" : j.acteur !== "po"));
  return (
    <div className="journal">
      <div className="vue-outils">
        <div className="segment" role="group" aria-label="Filtrer le journal">
          {FILTRES.map((f) => (
            <button key={f.id} type="button" className={`bouton segment-option${filtre === f.id ? " segment-active" : ""}`} aria-pressed={filtre === f.id} onClick={() => setFiltre(f.id)}>
              {f.libelle}
            </button>
          ))}
        </div>
        <Aide>Toute action de l'agent et toute décision du PO, horodatées, avec les règles de doctrine qu'elles citent.</Aide>
      </div>
      {visibles.length === 0 ? (
        <Vide titre={filtre === "po" ? "Aucune décision du PO pour l'instant." : "Aucune action de l'agent pour l'instant."}>
          {filtre === "po"
            ? "Vos réponses aux questions, vos validations de règles et vos décisions sur les propositions s'afficheront ici. « Actions de l'agent » montre ce que l'agent a déjà fait."
            : "Les lectures, rattachements et calculs de score de l'agent s'afficheront ici."}
        </Vide>
      ) : null}
      <ol className="chronologie">
        {visibles.map((j) => {
          const details = Object.entries(j.details ?? {})
            .filter(([k, v]) => v !== null && v !== undefined && v !== "" && !(COMPTEURS.has(k) && v === 0))
            .sort(([a], [b]) => (ORDRE_CLES.indexOf(a) + 1 || 99) - (ORDRE_CLES.indexOf(b) + 1 || 99));
          const cible = j.cible ? (ID_ELEMENT.test(j.cible) ? (titres.get(j.cible) ?? j.cible) : j.cible) : null;
          return (
            <li key={j.id} className={`evenement acteur-${j.acteur}`}>
              <span className="evenement-point" aria-hidden="true" />
              <div className="evenement-corps">
                <div className="evenement-haut">
                  <span className={`acteur acteur-badge-${j.acteur}`}>{LIBELLE_ACTEUR[j.acteur] ?? j.acteur}</span>
                  <strong>{ACTIONS[j.action] ?? humaniser(j.action)}</strong>
                  {cible ? (
                    <span className={cible === j.cible ? "mono" : undefined} title={cible === j.cible ? undefined : j.cible ?? undefined}>
                      {cible}
                    </span>
                  ) : null}
                  <span className="evenement-date">{dateCourte(j.horodatage)}</span>
                </div>
                {details.length > 0 ? (
                  <dl className="details">
                    {details.slice(0, 6).map(([k, v]) => (
                      <div key={k}>
                        <dt>{libelleCle(k)}</dt>
                        <dd>{valeurDetail(k, v, titres)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {j.reglesCitees?.length ? (
                  <div className="evenement-regles">
                    <span className="discret">règles citées :</span>
                    {j.reglesCitees.map((r) => (
                      <PuceRegle key={r} id={r} />
                    ))}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
