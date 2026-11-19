import { normaliser } from "./citation.ts";
import type { Plan } from "./types.ts";

/**
 * Doctrine produit : des règles explicites, versionnées, validées par le PO.
 * Invariant : une règle ne naît que d'une réponse du PO, jamais d'un feedback client.
 */

export interface ReponsePO {
  id: string;
  questionId: string;
  auteur: "po";
  choix: string;
  recueLe: string;
}

export type ContenuRegle =
  /** Les demandes qui contiennent l'un de ces mots-clés se rattachent à cet item. */
  | { type: "rattachement"; motsCles: string[]; itemId: string }
  /** Ces deux items sont des besoins distincts : ne jamais les fusionner. */
  | { type: "paire_distincte"; itemA: string; itemB: string }
  /** Quand un compte de ce plan demande un item (aligné ou non sur l'objectif), l'Impact bouge de N crans. */
  | { type: "ajustement_impact"; plan: Plan; alignementObjectif: boolean; crans: number };

export type StatutRegle = "proposee" | "active" | "rejetee" | "retiree";

export interface Regle {
  id: string;
  version: number;
  contenu: ContenuRegle;
  /** Formulation lisible, citée dans les décisions. */
  texte: string;
  sourceReponseId: string;
  statut: StatutRegle;
  creeeLe: string;
  valideeLe?: string;
}

function validerContenu(c: ContenuRegle): void {
  switch (c.type) {
    case "rattachement":
      if (c.motsCles.length === 0 || c.motsCles.some((m) => normaliser(m).length < 2)) {
        throw new Error("Une règle de rattachement exige des mots-clés d'au moins 2 caractères");
      }
      return;
    case "paire_distincte":
      if (c.itemA === c.itemB) throw new Error("Une paire distincte exige deux items différents");
      return;
    case "ajustement_impact":
      if (!Number.isInteger(c.crans) || c.crans === 0 || Math.abs(c.crans) > 2) {
        throw new Error("Un ajustement d'Impact se fait par 1 ou 2 crans, vers le haut ou vers le bas");
      }
      return;
  }
}

/** Seule une réponse du PO peut faire naître une règle. Le contrôle se fait aussi à l'exécution. */
export function proposerRegle(args: {
  id: string;
  reponse: { id: string; auteur: string };
  contenu: ContenuRegle;
  texte: string;
  maintenant: Date;
}): Regle {
  if (args.reponse.auteur !== "po") {
    throw new Error("Refusé : une règle de doctrine ne peut naître que d'une réponse du PO");
  }
  validerContenu(args.contenu);
  return {
    id: args.id,
    version: 1,
    contenu: args.contenu,
    texte: args.texte,
    sourceReponseId: args.reponse.id,
    statut: "proposee",
    creeeLe: args.maintenant.toISOString(),
  };
}

function motsClesNormalises(c: ContenuRegle): string[] {
  return c.type === "rattachement" ? c.motsCles.map((m) => normaliser(m).toLowerCase()) : [];
}

/** Liste les contradictions entre une règle et les règles actives (hors versions de la même règle). */
export function contradictions(regle: Regle, toutes: Regle[]): string[] {
  const actives = toutes.filter((r) => r.statut === "active" && r.id !== regle.id);
  const raisons: string[] = [];
  const c = regle.contenu;
  for (const autre of actives) {
    const a = autre.contenu;
    if (c.type === "rattachement" && a.type === "rattachement" && c.itemId !== a.itemId) {
      const communs = motsClesNormalises(c).filter((m) => motsClesNormalises(a).includes(m));
      if (communs.length > 0) {
        raisons.push(`Le mot-clé « ${communs.join(", ")} » est déjà rattaché à ${a.itemId} par ${autre.id}`);
      }
    }
    if (
      c.type === "ajustement_impact" &&
      a.type === "ajustement_impact" &&
      c.plan === a.plan &&
      c.alignementObjectif === a.alignementObjectif &&
      Math.sign(c.crans) !== Math.sign(a.crans)
    ) {
      raisons.push(`L'ajustement d'Impact va en sens inverse de ${autre.id}`);
    }
  }
  return raisons;
}

/** Active une règle proposée, sauf si elle contredit une règle active. */
export function activerRegle(
  regle: Regle,
  toutes: Regle[],
  maintenant: Date,
): { regle: Regle; contradictions: string[] } {
  if (regle.statut !== "proposee") throw new Error(`Seule une règle proposée peut être activée (statut : ${regle.statut})`);
  const conflits = contradictions(regle, toutes);
  if (conflits.length > 0) return { regle, contradictions: conflits };
  return { regle: { ...regle, statut: "active", valideeLe: maintenant.toISOString() }, contradictions: [] };
}

/** Réviser une règle crée une nouvelle version proposée et retire l'ancienne. Les ajouts sont incrémentaux. */
export function reviserRegle(args: {
  regle: Regle;
  reponse: { id: string; auteur: string };
  contenu: ContenuRegle;
  texte: string;
  maintenant: Date;
}): { ancienne: Regle; nouvelle: Regle } {
  const nouvelle = proposerRegle({
    id: args.regle.id,
    reponse: args.reponse,
    contenu: args.contenu,
    texte: args.texte,
    maintenant: args.maintenant,
  });
  return {
    ancienne: { ...args.regle, statut: "retiree" },
    nouvelle: { ...nouvelle, version: args.regle.version + 1 },
  };
}

function echapper(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function contientMot(texte: string, mot: string): boolean {
  const motif = new RegExp(`(^|[^\\p{L}\\p{N}])${echapper(mot)}($|[^\\p{L}\\p{N}])`, "u");
  return motif.test(texte);
}

/**
 * Application déterministe des règles de rattachement.
 * Si plusieurs règles désignent des items différents, aucune ne s'applique : c'est un cas de doute.
 */
export function appliquerRattachement(texte: string, regles: Regle[]): { itemId: string; regleId: string } | null {
  const t = normaliser(texte).toLowerCase();
  const touches = new Map<string, string>();
  for (const r of regles) {
    if (r.statut !== "active" || r.contenu.type !== "rattachement") continue;
    if (motsClesNormalises(r.contenu).some((m) => contientMot(t, m))) touches.set(r.contenu.itemId, r.id);
  }
  if (touches.size !== 1) return null;
  const [itemId, regleId] = [...touches.entries()][0] as [string, string];
  return { itemId, regleId };
}

/** Le cas d'origine d'une règle de rattachement : le texte sur lequel le PO a tranché, et l'item qu'il a choisi. */
export interface CasSource {
  regleId: string;
  texte: string;
  itemAttendu: string;
}

/**
 * Test de non-régression de la doctrine : avec l'ensemble de règles donné, chaque règle de rattachement
 * doit encore rattacher son cas d'origine à l'item choisi par le PO. Renvoie les cas cassés.
 */
export function verifierDoctrine(regles: Regle[], cas: CasSource[]): Array<CasSource & { obtenu: string | null }> {
  const casses: Array<CasSource & { obtenu: string | null }> = [];
  for (const c of cas) {
    const r = appliquerRattachement(c.texte, regles);
    if (r?.itemId !== c.itemAttendu) casses.push({ ...c, obtenu: r?.itemId ?? null });
  }
  return casses;
}

/** Vrai si une règle active interdit de fusionner ces deux items. */
export function fusionInterdite(itemA: string, itemB: string, regles: Regle[]): Regle | undefined {
  return regles.find(
    (r) =>
      r.statut === "active" &&
      r.contenu.type === "paire_distincte" &&
      ((r.contenu.itemA === itemA && r.contenu.itemB === itemB) ||
        (r.contenu.itemA === itemB && r.contenu.itemB === itemA)),
  );
}

/** Applique les ajustements d'Impact actifs à un index de l'échelle. Le bornage se fait à l'appel. */
export function ajusterImpact(
  index: number,
  contexte: { plans: ReadonlySet<Plan>; alignementObjectif: boolean },
  regles: Regle[],
): { index: number; reglesAppliquees: string[] } {
  let resultat = index;
  const appliquees: string[] = [];
  for (const r of regles) {
    if (r.statut !== "active" || r.contenu.type !== "ajustement_impact") continue;
    if (contexte.plans.has(r.contenu.plan) && contexte.alignementObjectif === r.contenu.alignementObjectif) {
      resultat += r.contenu.crans;
      appliquees.push(r.id);
    }
  }
  return { index: resultat, reglesAppliquees: appliquees };
}
