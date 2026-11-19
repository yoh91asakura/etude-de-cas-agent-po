import type { Canal, Compte, Feedback, ItemBacklog, Plan, Preuve, Regle } from "@po-agent/domain";
import type { Db } from "@po-agent/db";

/** Accès aux données. Conversion des lignes SQL (snake_case) vers les types du domaine. */

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

export async function chargerComptes(db: Db): Promise<Map<string, Compte>> {
  const r = await db.query<{ id: string; nom: string; plan: Plan; mrr: number; risque_depart: boolean }>("SELECT * FROM comptes");
  return new Map(r.rows.map((c) => [c.id, { id: c.id, nom: c.nom, plan: c.plan, mrr: Number(c.mrr), risqueDepart: c.risque_depart }]));
}

type LigneItem = { id: string; titre: string; description: string | null; type: ItemBacklog["type"]; statut: ItemBacklog["statut"]; complexite: ItemBacklog["complexite"]; alignement_objectif: boolean };

function versItem(i: LigneItem): ItemBacklog {
  return {
    id: i.id,
    titre: i.titre,
    ...(i.description ? { description: i.description } : {}),
    type: i.type,
    statut: i.statut,
    complexite: i.complexite,
    alignementObjectif: i.alignement_objectif,
  };
}

export async function chargerItems(db: Db, avecTermines = false): Promise<ItemBacklog[]> {
  const r = await db.query<LigneItem>(`SELECT * FROM items ${avecTermines ? "" : "WHERE statut <> 'termine'"} ORDER BY id`);
  return r.rows.map(versItem);
}

export async function chargerItem(db: Db, id: string): Promise<ItemBacklog | undefined> {
  const r = await db.query<LigneItem>("SELECT * FROM items WHERE id = $1", [id]);
  return r.rows[0] ? versItem(r.rows[0]) : undefined;
}

type LignePreuve = { id: string; item_id: string; feedback_id: string; compte_id: string; canal: Canal; recu_le: unknown; citation: string; sure: boolean; regle_id: string | null };

function versPreuve(p: LignePreuve): Preuve {
  return {
    id: p.id,
    itemId: p.item_id,
    feedbackId: p.feedback_id,
    compteId: p.compte_id,
    canal: p.canal,
    recuLe: iso(p.recu_le),
    citation: p.citation,
    sure: p.sure,
    ...(p.regle_id ? { regleId: p.regle_id } : {}),
  };
}

export async function chargerPreuves(db: Db, itemId?: string): Promise<Preuve[]> {
  const r = itemId
    ? await db.query<LignePreuve>("SELECT * FROM preuves WHERE item_id = $1 ORDER BY recu_le, id", [itemId])
    : await db.query<LignePreuve>("SELECT * FROM preuves ORDER BY recu_le, id");
  return r.rows.map(versPreuve);
}

export async function chargerFeedback(db: Db, id: string): Promise<(Feedback & { statut: string }) | undefined> {
  const r = await db.query<{ id: string; compte_id: string; canal: Canal; recu_le: unknown; texte: string; statut: string }>("SELECT * FROM feedbacks WHERE id = $1", [id]);
  const f = r.rows[0];
  return f ? { id: f.id, compteId: f.compte_id, canal: f.canal, recuLe: iso(f.recu_le), texte: f.texte, statut: f.statut } : undefined;
}

export async function chargerRegles(db: Db): Promise<Regle[]> {
  const r = await db.query<{ id: string; version: number; contenu: Regle["contenu"]; texte: string; source_reponse_id: string; statut: Regle["statut"]; creee_le: unknown; validee_le: unknown }>(
    "SELECT * FROM regles ORDER BY id, version",
  );
  return r.rows.map((x) => ({
    id: x.id,
    version: x.version,
    contenu: x.contenu,
    texte: x.texte,
    sourceReponseId: x.source_reponse_id,
    statut: x.statut,
    creeeLe: iso(x.creee_le),
    ...(x.validee_le ? { valideeLe: iso(x.validee_le) } : {}),
  }));
}

export async function enregistrerRegle(db: Db, r: Regle): Promise<void> {
  await db.query(
    `INSERT INTO regles (id, version, contenu, texte, source_reponse_id, statut, creee_le, validee_le)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id, version) DO UPDATE SET statut = EXCLUDED.statut, validee_le = EXCLUDED.validee_le`,
    [r.id, r.version, JSON.stringify(r.contenu), r.texte, r.sourceReponseId, r.statut, r.creeeLe, r.valideeLe ?? null],
  );
}

/** Identifiant court et lisible, unique par préfixe (N001, Q001, D001…). */
export async function prochainId(db: Db, prefixe: string, table: string): Promise<string> {
  const r = await db.query<{ n: number }>(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM ${prefixe.length + 1}) AS INTEGER)), 0) + 1 AS n FROM ${table} WHERE id ~ $1`,
    [`^${prefixe}[0-9]+$`],
  );
  return `${prefixe}${String(r.rows[0]?.n ?? 1).padStart(3, "0")}`;
}
