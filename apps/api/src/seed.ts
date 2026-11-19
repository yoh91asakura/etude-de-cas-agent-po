import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Compte, Feedback, ItemBacklog } from "@po-agent/domain";
import { ingerer, type Contexte } from "@po-agent/agent";
import { DOSSIER_SEED } from "./config.ts";

async function lireJson<T>(fichier: string): Promise<T> {
  return JSON.parse(await readFile(path.join(DOSSIER_SEED, fichier), "utf8")) as T;
}

/** Charge les comptes, le backlog existant et les feedbacks des six semaines précédant la démo. */
export async function chargerSeed(ctx: Contexte, ordre: "chronologique" | "inverse" = "chronologique"): Promise<{ comptes: number; items: number; feedbacks: number }> {
  const comptes = await lireJson<Compte[]>("comptes.json");
  const items = await lireJson<Array<ItemBacklog & { description?: string }>>("items.json");
  const feedbacks = await lireJson<Feedback[]>("feedbacks.json");

  for (const c of comptes) {
    await ctx.db.query("INSERT INTO comptes (id, nom, plan, mrr, risque_depart) VALUES ($1, $2, $3, $4, FALSE) ON CONFLICT (id) DO NOTHING", [c.id, c.nom, c.plan, c.mrr]);
  }
  for (const i of items) {
    await ctx.db.query(
      "INSERT INTO items (id, titre, description, type, statut, complexite, alignement_objectif, cree_par) VALUES ($1, $2, $3, $4, $5, $6, $7, 'humain') ON CONFLICT (id) DO NOTHING",
      [i.id, i.titre, i.description ?? null, i.type, i.statut, i.complexite, i.alignementObjectif],
    );
  }
  let n = 0;
  const tries = [...feedbacks].sort((a, b) => a.recuLe.localeCompare(b.recuLe));
  // L'ordre inverse sert au test métamorphique : l'ordre d'arrivée ne doit pas changer les rattachements.
  for (const f of ordre === "inverse" ? tries.reverse() : tries) {
    if ((await ingerer(ctx, f)) === "ajoute") n += 1;
  }
  return { comptes: comptes.length, items: items.length, feedbacks: n };
}

/** Feedbacks « direct » de la démo, rejoués un par un. */
export async function feedbacksDirects(): Promise<Feedback[]> {
  try {
    return await lireJson<Feedback[]>("direct.json");
  } catch {
    return [];
  }
}
