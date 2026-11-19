import { PARAMETRES } from "./parametres.ts";

const JOUR_MS = 24 * 60 * 60 * 1000;

export interface ResultatTendance {
  recent: number;
  precedent: number;
  tendance: boolean;
}

/**
 * Une tendance est calculée par le code, jamais déclarée par le LLM.
 * On compare la fenêtre récente à la fenêtre précédente de même durée.
 */
export function detecterTendance(dates: string[], maintenant: Date, p = PARAMETRES.tendances): ResultatTendance {
  const fin = maintenant.getTime();
  const milieu = fin - p.fenetreJours * JOUR_MS;
  const debut = milieu - p.fenetreJours * JOUR_MS;
  let recent = 0;
  let precedent = 0;
  for (const d of dates) {
    const t = Date.parse(d);
    if (Number.isNaN(t) || t > fin) continue;
    if (t > milieu) recent += 1;
    else if (t > debut) precedent += 1;
  }
  const seuil = Math.max(p.minimumRecent, p.facteur * precedent);
  return { recent, precedent, tendance: recent >= seuil };
}
