import { PARAMETRES } from "@po-agent/domain";

/** Date et heure locales (fuseau du PO) d'un instant, sous la forme « 2026-11-09 » et 13. */
export function heureLocale(t: Date, fuseau: string = PARAMETRES.agentDeFond.fuseau): { jour: string; heure: number } {
  const parties = Object.fromEntries(
    new Intl.DateTimeFormat("fr-FR", { timeZone: fuseau, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(t)
      .map((p) => [p.type, p.value]),
  );
  return { jour: `${parties.year}-${parties.month}-${parties.day}`, heure: Number(parties.hour) };
}
