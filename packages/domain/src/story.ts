import type { Complexite } from "./parametres.ts";

export interface CritereAcceptation {
  etantDonne: string;
  quand: string;
  alors: string;
}

export interface Story {
  itemId: string;
  enTantQue: string;
  jeVeux: string;
  afinDe: string;
  criteres: CritereAcceptation[];
  casLimites: string[];
  complexite: Complexite;
  /** Citations des verbatims qui fondent la story. */
  citations: string[];
}

export interface ControleStory {
  nom: "gabarit_complet" | "un_seul_besoin" | "criteres_given_when_then" | "au_moins_deux_criteres" | "citations_presentes";
  ok: boolean;
  detail?: string;
}

/** « En tant que » devient « En tant qu' » devant une voyelle ; « afin de » devient « afin d' », ou « afin » devant « que ». */
function lier(mot: "En tant que" | "afin de", suite: string): string {
  const s = suite.trim();
  if (mot === "afin de" && /^qu/i.test(s)) return `afin ${s}`;
  return /^[aeiouyàâäéèêëîïôöûüœ]/i.test(s) ?`${mot.slice(0, -1)}'${s}` : `${mot} ${s}`;
}

/** La phrase de la story, bien liée : « En tant qu'administratrice, je veux…, afin que chaque client… ». */
export function phraseStory(s: Pick<Story, "enTantQue" | "jeVeux" | "afinDe">): string {
  return `${lier("En tant que", s.enTantQue)}, je veux ${s.jeVeux.trim()}, ${lier("afin de", s.afinDe)}.`;
}

const CONJONCTIONS_MULTIPLES =/\b(et aussi|ainsi que|de plus|en plus de)\b/i;

/**
 * Contrôles déterministes, passés avant le juge LLM.
 * Ils ne jugent pas la qualité du besoin, seulement la forme vérifiable.
 */
export function controlerStory(s: Story): ControleStory[] {
  const vide = (t: string) => t.trim().length < 3;
  return [
    {
      nom: "gabarit_complet",
      ok: !vide(s.enTantQue) && !vide(s.jeVeux) && !vide(s.afinDe),
      detail: "En tant que… je veux… afin de…",
    },
    {
      nom: "un_seul_besoin",
      ok: !CONJONCTIONS_MULTIPLES.test(s.jeVeux) && (s.jeVeux.match(/ et /g) ?? []).length <= 1,
      detail: "Le « je veux » ne doit porter qu'un besoin",
    },
    {
      nom: "criteres_given_when_then",
      ok: s.criteres.length > 0 && s.criteres.every((c) => !vide(c.etantDonne) && !vide(c.quand) && !vide(c.alors)),
      detail: "Chaque critère a un Étant donné, un Quand et un Alors",
    },
    { nom: "au_moins_deux_criteres", ok: s.criteres.length >= 2 },
    { nom: "citations_presentes", ok: s.citations.length > 0, detail: "La story renvoie aux verbatims qui la fondent" },
  ];
}
