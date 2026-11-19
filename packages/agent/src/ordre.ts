import { calculerScore, classer, numeroterRangs, PARAMETRES, type Complexite, type Filtre, type RangBacklog } from "@po-agent/domain";
import { journaliser } from "@po-agent/db";
import type { Contexte } from "./contexte.ts";
import { classement } from "./chaine.ts";
import { chargerComptes, chargerItems, chargerPreuves, prochainId } from "./depot.ts";

/**
 * Deux backlogs (cadrage, round 2) : celui que propose l'agent (le classement de la vue de référence)
 * et l'ordre officiel, que seul le PO fait évoluer en acceptant une proposition.
 */

const VUE_REFERENCE = PARAMETRES.alertes.vueReference as unknown as Filtre[];

// La numérotation des rangs vit dans le domaine (fonction pure) ; ré-exportée ici pour l'API et le cockpit.
export { numeroterRangs, type RangBacklog } from "@po-agent/domain";

export interface Simulation {
  scoreAvant: number;
  scoreApres: number;
  rangAvant: RangBacklog | null;
  rangApres: RangBacklog | null;
}

/** Ce que deviendraient le score et le rang d'un élément avec un autre Impact ou une autre taille. Rien n'est modifié. */
export async function simulerChangement(
  ctx: Contexte,
  itemId: string,
  changement: { impact?: number; complexite?: Complexite },
  filtres: readonly Filtre[] = VUE_REFERENCE,
): Promise<Simulation | null> {
  const items = await chargerItems(ctx.db);
  const item = items.find((i) => i.id === itemId);
  if (!item) return null;
  const statuts = new Map(items.map((i) => [i.id, i.statut]));
  const actuel = await classement(ctx, filtres);
  const avant = actuel.find((s) => s.itemId === itemId);
  const simule = calculerScore({
    item: { ...item, ...(changement.complexite ? { complexite: changement.complexite } : {}) },
    preuves: await chargerPreuves(ctx.db, itemId),
    impact: changement.impact ?? avant?.impact ?? 1,
    comptes: await chargerComptes(ctx.db),
    maintenant: ctx.maintenant(),
    filtres: [...filtres],
  });
  const apres = classer([...actuel.filter((s) => s.itemId !== itemId), simule]);
  return {
    scoreAvant: avant?.score ?? 0,
    scoreApres: simule.score,
    rangAvant: numeroterRangs(actuel.map((s) => s.itemId), statuts).get(itemId) ?? null,
    rangApres: numeroterRangs(apres.map((s) => s.itemId), statuts).get(itemId) ?? null,
  };
}

/** Ordre officiel : la dernière proposition d'ordre acceptée par le PO, sinon l'ordre initial du backlog. */
export async function ordreOfficiel(ctx: Contexte): Promise<string[]> {
  const items = (await chargerItems(ctx.db)).filter((i) => i.statut === "backlog" || i.statut === "pret");
  const actifs = new Set(items.map((i) => i.id));
  const r = await ctx.db.query<{ charge: { ordre: string[]; ordreAccepte?: string[] } }>(
    "SELECT charge FROM propositions WHERE type = 'ordre_backlog' AND statut = 'acceptee' ORDER BY decidee_le DESC, id DESC LIMIT 1",
  );
  // Une acceptation du seul haut de l'ordre garde l'ordre réellement accepté à côté de celui que l'agent proposait.
  const base = r.rows[0]?.charge.ordreAccepte ?? r.rows[0]?.charge.ordre ?? items.map((i) => i.id);
  const ordre = base.filter((id) => actifs.has(id));
  // Les items acceptés depuis (nouveaux besoins validés) arrivent en fin d'ordre, en attendant le prochain arbitrage.
  for (const i of items) if (!ordre.includes(i.id)) ordre.push(i.id);
  return ordre;
}

/** Ordre que propose l'agent : le classement de la vue de référence, limité aux items du backlog. */
export async function ordrePropose(ctx: Contexte): Promise<string[]> {
  const items = new Set((await chargerItems(ctx.db)).filter((i) => i.statut === "backlog" || i.statut === "pret").map((i) => i.id));
  const classes = (await classement(ctx, VUE_REFERENCE)).map((s) => s.itemId).filter((id) => items.has(id));
  for (const id of items) if (!classes.includes(id)) classes.push(id);
  return classes;
}

/**
 * Si le haut du classement proposé diffère de l'ordre officiel, l'agent soumet un nouvel ordre au PO.
 * Une seule proposition d'ordre reste en attente : la précédente expire.
 */
export async function proposerOrdre(ctx: Contexte): Promise<string | null> {
  const officiel = await ordreOfficiel(ctx);
  const propose = await ordrePropose(ctx);
  const n = PARAMETRES.alertes.tailleTop;
  if (officiel.slice(0, n).join(",") === propose.slice(0, n).join(",")) return null;

  const enAttente = await ctx.db.query<{ id: string; charge: { ordre: string[] } }>("SELECT id, charge FROM propositions WHERE type = 'ordre_backlog' AND statut = 'en_attente'");
  if (enAttente.rows.some((p) => p.charge.ordre.slice(0, n).join(",") === propose.slice(0, n).join(","))) return null;
  const titres = new Map((await chargerItems(ctx.db)).map((i) => [i.id, i.titre]));
  const mouvements = propose
    .slice(0, n)
    .map((id, i) => ({ itemId: id, avant: officiel.indexOf(id) + 1, apres: i + 1 }))
    .filter((m) => m.avant !== m.apres);
  const resume = mouvements
    .slice(0, 3)
    .map((m) => `« ${titres.get(m.itemId) ?? m.itemId} » ${m.avant > m.apres ? "monte" : "descend"} de ${m.avant} à ${m.apres}`)
    .join(" ; ");
  const id = await prochainId(ctx.db, "PR", "propositions");
  // Audit avant l'écriture : la nouvelle proposition remplace celles qui attendaient encore.
  await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "proposer_ordre", cible: id, details: { mouvements, remplace: enAttente.rows.map((p) => p.id) } });
  await ctx.db.query("UPDATE propositions SET statut = 'expiree', decidee_le = now() WHERE type = 'ordre_backlog' AND statut = 'en_attente'");
  await ctx.db.query("INSERT INTO propositions (id, type, charge, resume, creee_le) VALUES ($1, 'ordre_backlog', $2, $3, $4)", [
    id,
    JSON.stringify({ ordre: propose, filtres: VUE_REFERENCE, mouvements }),
    `Nouvel ordre du backlog proposé : ${resume || "réordonnancement du haut du backlog"}.`,
    ctx.maintenant().toISOString(),
  ]);
  ctx.diffuser({ type: "proposition", donnees: { id, type: "ordre_backlog" } });
  return id;
}
