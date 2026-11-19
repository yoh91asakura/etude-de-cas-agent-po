/** Coupe un titre sur un mot, avec « … », au lieu de le trancher au milieu d'un mot. */
export function couperTitre(texte: string, max = 90): string {
  const t = texte.trim().replace(/\s+/g, " ").replace(/[.\s]+$/, "");
  if (t.length <= max) return t;
  const coupe = t.slice(0, max);
  const espace = coupe.lastIndexOf(" ");
  return `${(espace > max * 0.6 ? coupe.slice(0, espace) : coupe).replace(/[,;:\s]+$/, "")}…`;
}
