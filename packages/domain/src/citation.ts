import { createHash } from "node:crypto";
import type { Extraction, Feedback } from "./types.ts";

/** Normalisation minimale : Unicode, apostrophes et guillemets typographiques, espaces. La casse est conservée. */
export function normaliser(texte: string): string {
  return texte
    .normalize("NFC")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/[  ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Une citation est valide seulement si elle figure mot pour mot (après normalisation) dans le texte source. */
export function citationVerifiee(citation: string, texteSource: string): boolean {
  const c = normaliser(citation);
  if (c.length < 3) return false;
  return normaliser(texteSource).includes(c);
}

/** Passages cités entre guillemets (« », " ", “ ”) d'au moins `longueurMin` caractères, dans un texte libre du modèle. */
export function passagesCites(texte: string, longueurMin = 20): string[] {
  const motifs = [/«\s*([^»]+?)\s*»/g, /"([^"\n]+)"/g, /“([^”]+)”/g];
  const passages = motifs.flatMap((m) => [...texte.matchAll(m)].map((x) => (x[1] ?? "").trim()));
  return [...new Set(passages)].filter((p) => p.length >= longueurMin);
}

/**
 * Passages cités qui ne figurent pas mot pour mot dans les sources (après normalisation).
 * Un passage tronqué par des points de suspension est comparé morceau par morceau.
 */
export function citationsInventees(texte: string, sources: string, longueurMin = 20): string[] {
  return passagesCites(texte, longueurMin).filter((p) =>
    p
      .split(/\s*(?:\.\.\.|…|\[\.\.\.\]|\[…\])\s*/)
      .filter((morceau) => morceau.length >= 3)
      .some((morceau) => !citationVerifiee(morceau, sources)),
  );
}

/** Empreinte d'un feedback : deux feedbacks de même empreinte ne comptent qu'une fois. */
export function empreinteFeedback(f: Pick<Feedback, "compteId" | "canal" | "texte">): string {
  const contenu = `${f.compteId}\u0000${f.canal}\u0000${normaliser(f.texte).toLowerCase()}`;
  return createHash("sha256").update(contenu).digest("hex");
}

export interface DemandeRejetee {
  resume: string;
  raison: "feedback_suspect" | "citation_introuvable";
}

/**
 * Garde-fou entre l'extraction et la suite de la chaîne.
 * Un feedback suspect ne produit aucune demande exploitable.
 * Une demande dont la citation ne figure pas dans le texte source est rejetée.
 */
export function demandesExploitables(
  extraction: Extraction,
  texteSource: string,
): { exploitables: Extraction["demandes"]; rejetees: DemandeRejetee[] } {
  if (extraction.injectionSuspectee || extraction.nature === "suspect") {
    return {
      exploitables: [],
      rejetees: extraction.demandes.map((d) => ({ resume: d.resume, raison: "feedback_suspect" as const })),
    };
  }
  const exploitables: Extraction["demandes"] = [];
  const rejetees: DemandeRejetee[] = [];
  for (const d of extraction.demandes) {
    if (citationVerifiee(d.citation, texteSource)) exploitables.push(d);
    else rejetees.push({ resume: d.resume, raison: "citation_introuvable" });
  }
  return { exploitables, rejetees };
}
