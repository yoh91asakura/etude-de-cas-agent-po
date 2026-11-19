import { fusionInterdite, PARAMETRES, proposerRegle, type Filtre } from "@po-agent/domain";
import { journaliser } from "@po-agent/db";
import { EchecLLM } from "@po-agent/llm";
import type { Contexte } from "./contexte.ts";
import { classement, creerQuestion } from "./chaine.ts";
import { chargerItems, chargerPreuves, chargerRegles, enregistrerRegle, prochainId } from "./depot.ts";
import { passerResume } from "./decisions.ts";
import { heureLocale } from "./horloge.ts";

/**
 * L'agent de fond prend du recul trois fois par jour : il relance ou fait expirer les questions,
 * repère les doublons probables (question de fusion au PO), propose des règles qui généralisent
 * des réponses du PO déjà données, puis écrit le résumé du jour. Il propose, il ne décide jamais.
 */
export async function passageDeFond(ctx: Contexte): Promise<{ fusions: number; regles: number; resume: string }> {
  const { relancees, expirees } = await passerResume(ctx);
  const relances = await relancerFeedbacksEnAttente(ctx);
  const { fusions, regles } = await revue(ctx);
  const resume = await ecrireResume(ctx, { relancees: relancees.length, expirees: expirees.length, fusions, regles, feedbacksRelances: relances });
  return { fusions, regles, resume };
}

/** Un feedback mis en attente par un échec maîtrisé du modèle est retenté au passage suivant. */
async function relancerFeedbacksEnAttente(ctx: Contexte): Promise<number> {
  const r = await ctx.db.query<{ id: string }>("SELECT id FROM feedbacks WHERE statut = 'en_attente' ORDER BY recu_le");
  if (r.rows.length > 0) await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "relancer_feedbacks_en_attente", details: { feedbacks: r.rows.map((f) => f.id) } });
  let n = 0;
  for (const f of r.rows) {
    if (await ctx.file.ajouter("traiter_feedback", { feedbackId: f.id }, { cle: `traiter:${f.id}` })) n += 1;
  }
  return n;
}

async function revue(ctx: Contexte): Promise<{ fusions: number; regles: number }> {
  const items = await chargerItems(ctx.db);
  const preuves = await chargerPreuves(ctx.db);
  const creeParAgent = new Set((await ctx.db.query<{ id: string }>("SELECT id FROM items WHERE cree_par = 'agent'")).rows.map((r) => r.id));
  const reponses = await ctx.db.query<{ id: string; enonce: string; choix: string; citation: string | null }>(
    "SELECT r.id, q.enonce, r.choix, q.contexte->>'citation' AS citation FROM reponses r JOIN questions q ON q.id = r.question_id WHERE q.type = 'rattachement' ORDER BY r.recue_le",
  );

  let resultat;
  try {
    resultat = await ctx.llm.revueDeFond({
      items: items.map((i) => {
        const siennes = preuves.filter((p) => p.itemId === i.id && p.sure);
        return { id: i.id, titre: i.titre, ...(i.description ? { description: i.description } : {}), creeParAgent: creeParAgent.has(i.id), preuves: siennes.length, verbatims: siennes.slice(-3).map((p) => p.citation) };
      }),
      reponsesPO: reponses.rows,
    });
  } catch (e) {
    if (e instanceof EchecLLM && e.motif !== "erreur") return { fusions: 0, regles: 0 };
    throw e;
  }

  const regles = await chargerRegles(ctx.db);
  const titres = new Map(items.map((i) => [i.id, i.titre]));
  let nbFusions = 0;
  for (const f of resultat.fusions) {
    // Une règle « besoins distincts » validée par le PO interdit de reposer la question.
    if (fusionInterdite(f.itemA, f.itemB, regles)) continue;
    const deja = await ctx.db.query(
      "SELECT 1 FROM questions WHERE type = 'fusion' AND ((contexte->>'itemA' = $1 AND contexte->>'itemB' = $2) OR (contexte->>'itemA' = $2 AND contexte->>'itemB' = $1))",
      [f.itemA, f.itemB],
    );
    if (deja.rows.length > 0) continue;
    await creerQuestion(ctx, {
      type: "fusion",
      enonce: `« ${titres.get(f.itemB)} » et « ${titres.get(f.itemA)} » décrivent-ils le même besoin ?`,
      options: [
        { valeur: "oui", libelle: `Oui, fusionner dans « ${titres.get(f.itemA)} »` },
        { valeur: "non", libelle: "Non, ce sont deux besoins distincts" },
      ],
      contexte: { itemA: f.itemA, itemB: f.itemB, explication: f.explication },
      enjeu: 1,
      urgente: false,
    });
    nbFusions += 1;
  }

  let nbRegles = 0;
  const reponsesConnues = new Set(reponses.rows.map((r) => r.id));
  for (const r of resultat.regles) {
    const source = r.reponsesSources.filter((s) => reponsesConnues.has(s)).at(-1);
    if (!source) continue;
    const id = `D${String(new Set(regles.map((x) => x.id)).size + nbRegles + 1).padStart(2, "0")}`;
    const regle = proposerRegle({ id, reponse: { id: source, auteur: "po" }, contenu: { type: "rattachement", motsCles: r.motsCles, itemId: r.itemId }, texte: r.texte, maintenant: ctx.maintenant() });
    await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "proposer_regle", cible: id, details: { par: "agent_de_fond", reponsesSources: r.reponsesSources } });
    await enregistrerRegle(ctx.db, regle);
    const propId = await prochainId(ctx.db, "PR", "propositions");
    await ctx.db.query("INSERT INTO propositions (id, type, charge, resume, creee_le) VALUES ($1, 'regle', $2, $3, $4)", [propId, JSON.stringify({ regleId: id, version: 1, reponsesSources: r.reponsesSources }), `Règle proposée par l'agent de fond : ${r.texte}`, ctx.maintenant().toISOString()]);
    nbRegles += 1;
  }
  if (nbRegles > 0) ctx.diffuser({ type: "regle", donnees: { statut: "proposee" } });
  return { fusions: nbFusions, regles: nbRegles };
}

/** Résumé du passage, écrit par le code à partir de l'état : aucune affirmation qui ne soit pas dans la base. */
async function ecrireResume(ctx: Contexte, n: { relancees: number; expirees: number; fusions: number; regles: number; feedbacksRelances: number }): Promise<string> {
  const items = await chargerItems(ctx.db);
  const titres = new Map(items.map((i) => [i.id, i.titre]));
  // Le top 3 du backlog, comme dans le cockpit : un candidat n'y prend pas de rang.
  const candidats = new Set(items.filter((i) => i.statut === "candidat").map((i) => i.id));
  const top = (await classement(ctx, PARAMETRES.alertes.vueReference as unknown as Filtre[])).filter((s) => titres.has(s.itemId) && !candidats.has(s.itemId)).slice(0, 3);
  const questions = (await ctx.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM questions WHERE etat IN ('ouverte', 'relancee') AND posee_le IS NOT NULL")).rows[0]?.n ?? 0;
  const propositions = (await ctx.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM propositions WHERE statut = 'en_attente'")).rows[0]?.n ?? 0;
  const morceaux = [
    `Top 3 : ${top.map((s, i) => `${i + 1}. ${titres.get(s.itemId) ?? s.itemId}`).join(", ") || "vide"}.`,
    `${questions} question(s) en attente de réponse, ${propositions} proposition(s) à décider.`,
  ];
  // Les alertes non urgentes ne sont pas poussées au fil de l'eau : le résumé en reprend au plus maxParJour,
  // les plus récentes d'abord ; les autres restent lisibles dans la boîte de l'agent.
  // « Depuis le dernier résumé » se lit sur l'ordre d'insertion (id), pas sur les dates : une base créée avant que les
  // alertes suivent l'horloge du scénario mélange les deux horloges.
  const dernier = (await ctx.db.query<{ m: unknown }>("SELECT MAX(id) AS m FROM alertes WHERE type = 'resume'")).rows[0]?.m;
  const nonUrgentes = (
    await ctx.db.query<{ message: string }>(
      "SELECT message FROM alertes WHERE NOT urgente AND type <> 'resume' AND ($1::bigint IS NULL OR id > $1) ORDER BY id DESC",
      [dernier === null || dernier === undefined ? null : Number(dernier)],
    )
  ).rows;
  if (nonUrgentes.length > 0) {
    const plafond = PARAMETRES.alertes.maxParJour;
    const reprises = nonUrgentes.slice(0, plafond).map((a) => `• ${a.message}`);
    const reste = nonUrgentes.length - reprises.length;
    morceaux.push(`Depuis le dernier résumé :\n${reprises.join("\n")}${reste > 0 ? `\n(et ${reste} autre(s) dans la boîte de l'agent)` : ""}`);
  }
  if (n.relancees + n.expirees > 0) morceaux.push(`${n.relancees} question(s) relancée(s), ${n.expirees} expirée(s) sans rien appliquer.`);
  if (n.feedbacksRelances > 0) morceaux.push(`${n.feedbacksRelances} feedback(s) en attente remis en traitement.`);
  if (n.fusions + n.regles > 0) morceaux.push(`Revue de fond : ${n.fusions} fusion(s) à trancher, ${n.regles} règle(s) proposée(s).`);
  const resume = `Résumé de ${heureLocale(ctx.maintenant()).heure} h : ${morceaux.join(" ")}`;
  await ctx.db.query("INSERT INTO alertes (type, message, urgente, creee_le) VALUES ('resume', $1, FALSE, $2)", [resume, ctx.maintenant().toISOString()]);
  await journaliser(ctx.db, { horodatage: ctx.maintenant(), acteur: "agent", action: "passage_de_fond", details: n });
  ctx.diffuser({ type: "alerte", donnees: { type: "resume", message: resume, urgente: false } });
  return resume;
}
