import { citationVerifiee, controlerStory, PARAMETRES, type Complexite, type Filtre, type Story } from "@po-agent/domain";
import { journaliser } from "@po-agent/db";
import { EchecLLM } from "@po-agent/llm";
import type { Contexte } from "./contexte.ts";
import { classement } from "./chaine.ts";
import { chargerItem, chargerPreuves, prochainId } from "./depot.ts";

/** Brouillon de story pour un item : rédaction, contrôles déterministes, puis juge LLM distinct. */
export async function redigerStory(ctx: Contexte, itemId: string): Promise<string | null> {
  const item = await chargerItem(ctx.db, itemId);
  if (!item) return null;
  const preuves = (await chargerPreuves(ctx.db, itemId)).filter((p) => p.sure);
  const citations = preuves.slice(-10).map((p) => p.citation);
  if (citations.length === 0) return null;

  let story;
  let jugement = null;
  try {
    story = await ctx.llm.redigerStory({ item, citations });
    jugement = await ctx.llm.jugerStory(story);
  } catch (e) {
    if (e instanceof EchecLLM && e.motif !== "erreur") return null;
    throw e;
  }

  // Chaque citation doit figurer dans UN verbatim : comparée aux verbatims recollés, une citation recousue
  // à cheval sur deux verbatims passait (la normalisation efface le saut de ligne qui les sépare).
  const controles = controlerAvecCitations(story, citations);
  const id = await prochainId(ctx.db, "S", "stories");
  await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "rediger_story", cible: id, details: { itemId, controlesKo: controles.filter((c) => !c.ok).map((c) => c.nom) } });
  await ctx.db.query("INSERT INTO stories (id, item_id, contenu, controles, jugement) VALUES ($1, $2, $3, $4, $5)", [
    id,
    itemId,
    JSON.stringify(story),
    JSON.stringify(controles),
    JSON.stringify(jugement),
  ]);

  // La rédaction estime la taille plus finement. Elle ne réécrit plus l'effort en silence : un seul tirage pouvait
  // doubler ou diviser par deux un score. L'agent propose la nouvelle taille, le PO l'accepte ou la refuse.
  if (story.complexite !== item.complexite) await proposerEffort(ctx, itemId, item.titre, item.complexite, story.complexite, id);

  const propId = await prochainId(ctx.db, "PR", "propositions");
  await ctx.db.query("INSERT INTO propositions (id, type, charge, resume, creee_le) VALUES ($1, 'story_prete', $2, $3, $4)", [
    propId,
    JSON.stringify({ storyId: id, itemId }),
    `Story à valider pour « ${item.titre} »`,
    ctx.maintenant().toISOString(),
  ]);
  ctx.diffuser({ type: "story", donnees: { id, itemId } });
  return id;
}

const LIBELLE_CRITERE_JUGE: Record<string, string> = {
  independante: "pas indépendante",
  valeur: "valeur pour le client peu explicite",
  estimable: "pas estimable",
  petite: "trop grosse pour un sprint",
  testable: "critères difficiles à tester",
  un_seul_besoin: "mélange plusieurs besoins",
};

/** Ce que le juge reproche à une story : les critères refusés, puis son commentaire. */
export function reprochesDuJuge(jugement: Record<string, unknown> | null): string[] {
  if (!jugement) return [];
  const refus = Object.entries(jugement)
    .filter(([k, v]) => k !== "commentaire" && v === false)
    .map(([k]) => LIBELLE_CRITERE_JUGE[k] ?? k);
  return typeof jugement.commentaire === "string" && jugement.commentaire ? [...refus, jugement.commentaire] : refus;
}

/** Contrôles du code d'une story : le gabarit, puis chaque citation retrouvée mot pour mot dans un verbatim. */
function controlerAvecCitations(story: Story, verbatims: string[]) {
  return [
    ...controlerStory(story),
    {
      nom: "citations_verifiees",
      ok: story.citations.every((c) => verbatims.some((v) => citationVerifiee(c, v))),
      detail: "Chaque citation de la story figure mot pour mot dans un verbatim",
    },
  ];
}

/**
 * Découpage d'une story refusée par le juge (audit du 15/11/2026, décision de l'humain).
 * Le PO le demande depuis l'onglet Stories : l'agent rédige 2 à 4 stories plus petites, chacune contrôlée par le code
 * puis jugée, et propose le découpage. Rien ne remplace la story d'origine sans l'accord du PO.
 * Pas de découpage automatique : il coûte un appel de rédaction et un jugement par story, et le préchargement
 * en aurait déclenché un pour presque chaque story.
 */
export async function decouperStory(ctx: Contexte, storyId: string): Promise<string | null> {
  const r = await ctx.db.query<{ id: string; item_id: string; statut: string; contenu: Story; jugement: Record<string, unknown> | null }>(
    "SELECT id, item_id, statut, contenu, jugement FROM stories WHERE id = $1",
    [storyId],
  );
  const parent = r.rows[0];
  if (!parent) throw new Error(`Story introuvable : ${storyId}`);
  if (parent.statut !== "brouillon" && parent.statut !== "prete") throw new Error(`Cette story ne peut plus être découpée (${parent.statut})`);
  const enAttente = await ctx.db.query<{ id: string }>("SELECT id FROM propositions WHERE type = 'decoupage' AND statut = 'en_attente' AND charge->>'storyId' = $1", [storyId]);
  if (enAttente.rows[0]) return enAttente.rows[0].id;

  const item = await chargerItem(ctx.db, parent.item_id);
  if (!item) return null;
  const citations = (await chargerPreuves(ctx.db, item.id)).filter((p) => p.sure).slice(-10).map((p) => p.citation);
  let resultat;
  try {
    resultat = await ctx.llm.decouperStory({ item, story: parent.contenu, citations, reproches: reprochesDuJuge(parent.jugement) });
  } catch (e) {
    if (e instanceof EchecLLM && e.motif !== "erreur") {
      await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "decoupage_impossible", cible: storyId, details: { motif: e.motif } });
      return null;
    }
    throw e;
  }

  const enfants: string[] = [];
  for (const enfant of resultat.stories) {
    const s: Story = { ...enfant, itemId: item.id };
    let jugement = null;
    try {
      jugement = await ctx.llm.jugerStory(s);
    } catch (e) {
      if (!(e instanceof EchecLLM) || e.motif === "erreur") throw e;
    }
    const id = await prochainId(ctx.db, "S", "stories");
    await ctx.db.query("INSERT INTO stories (id, item_id, contenu, controles, jugement, statut, parent_id) VALUES ($1, $2, $3, $4, $5, 'proposee', $6)", [
      id,
      item.id,
      JSON.stringify(s),
      JSON.stringify(controlerAvecCitations(s, citations)),
      JSON.stringify(jugement),
      storyId,
    ]);
    enfants.push(id);
  }

  const propId = await prochainId(ctx.db, "PR", "propositions");
  await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "proposer_decoupage", cible: storyId, details: { itemId: item.id, enfants, propositionId: propId } });
  await ctx.db.query("INSERT INTO propositions (id, type, charge, resume, creee_le) VALUES ($1, 'decoupage', $2, $3, $4)", [
    propId,
    JSON.stringify({ storyId, itemId: item.id, enfants, justification: resultat.justification }),
    `Découper la story de « ${item.titre} » en ${enfants.length} stories`,
    ctx.maintenant().toISOString(),
  ]);
  ctx.diffuser({ type: "proposition", donnees: { id: propId, type: "decoupage" } });
  return propId;
}

/** Propose au PO la taille estimée par la rédaction d'une story. Une seule proposition d'effort attend par élément. */
export async function proposerEffort(ctx: Contexte, itemId: string, titre: string, avant: Complexite, apres: Complexite, storyId: string): Promise<string> {
  const id = await prochainId(ctx.db, "PR", "propositions");
  await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "proposer_effort", cible: itemId, details: { avant, apres, storyId, propositionId: id } });
  await ctx.db.query("UPDATE propositions SET statut = 'expiree', decidee_le = now() WHERE type = 'effort' AND statut = 'en_attente' AND charge->>'itemId' = $1", [itemId]);
  await ctx.db.query("INSERT INTO propositions (id, type, charge, resume, creee_le) VALUES ($1, 'effort', $2, $3, $4)", [
    id,
    JSON.stringify({ itemId, avant, apres, storyId }),
    `Effort de « ${titre} » : ${avant} → ${apres}, selon la story rédigée`,
    ctx.maintenant().toISOString(),
  ]);
  ctx.diffuser({ type: "proposition", donnees: { id, type: "effort" } });
  return id;
}

/** Met en file un brouillon de story pour chaque item du top de la vue de référence qui n'en a pas encore. */
export async function planifierStories(ctx: Contexte): Promise<string[]> {
  const top = (await classement(ctx, PARAMETRES.alertes.vueReference as unknown as Filtre[])).slice(0, PARAMETRES.alertes.tailleTop);
  const planifies: string[] = [];
  for (const s of top) {
    const existe = await ctx.db.query("SELECT 1 FROM stories WHERE item_id = $1", [s.itemId]);
    if (existe.rows.length > 0 || s.score <= 0) continue;
    const id = await ctx.file.ajouter("rediger_story", { itemId: s.itemId }, { cle: `story:${s.itemId}` });
    if (id) planifies.push(s.itemId);
  }
  return planifies;
}
