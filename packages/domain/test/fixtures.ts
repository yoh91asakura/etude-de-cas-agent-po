import type { Canal, Compte, ItemBacklog, Plan, Preuve } from "../src/index.ts";
import type { Complexite } from "../src/parametres.ts";

export const MAINTENANT = new Date("2026-11-09T09:00:00Z");

export function ilYa(jours: number): string {
  return new Date(MAINTENANT.getTime() - jours * 24 * 60 * 60 * 1000).toISOString();
}

export function compte(id: string, plan: Plan, mrr: number, risqueDepart = false): Compte {
  return { id, nom: `Compte ${id}`, plan, mrr, risqueDepart };
}

export function item(
  id: string,
  options: { complexite?: Complexite; alignement?: boolean; type?: ItemBacklog["type"] } = {},
): ItemBacklog {
  return {
    id,
    titre: `Item ${id}`,
    type: options.type ?? "fonctionnalite",
    statut: "backlog",
    complexite: options.complexite ?? "M",
    alignementObjectif: options.alignement ?? false,
  };
}

let compteur = 0;
export function preuve(
  itemId: string,
  compteId: string,
  options: { canal?: Canal; joursAvant?: number; sure?: boolean; feedbackId?: string } = {},
): Preuve {
  compteur += 1;
  return {
    id: `P${compteur}`,
    itemId,
    feedbackId: options.feedbackId ?? `F${compteur}`,
    compteId,
    canal: options.canal ?? "ticket",
    recuLe: ilYa(options.joursAvant ?? 1),
    citation: "citation",
    sure: options.sure ?? true,
  };
}

export function annuaire(...comptes: Compte[]): Map<string, Compte> {
  return new Map(comptes.map((c) => [c.id, c]));
}
