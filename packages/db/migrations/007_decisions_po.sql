-- Audit du 15/11/2026, arbitré par l'humain : le PO corrige, et l'agent propose au lieu d'imposer.

-- Deux propositions nouvelles :
-- « effort » : la rédaction d'une story estime une autre taille ; le PO l'accepte ou la refuse.
-- « decoupage » : une story refusée par le juge (trop grosse, plusieurs besoins) est découpée en stories plus petites.
ALTER TABLE propositions DROP CONSTRAINT propositions_type_check;
ALTER TABLE propositions ADD CONSTRAINT propositions_type_check
  CHECK (type IN ('ordre_backlog', 'story_prete', 'export_jira', 'fusion', 'nouvel_item', 'regle', 'moscow', 'suggestion', 'effort', 'decoupage'));

-- Une story issue d'un découpage garde sa story d'origine (parent_id). Tant que le PO n'a pas tranché,
-- les stories proposées sont « proposee » ; acceptées, elles deviennent des brouillons et la story d'origine
-- passe « remplacee » ; refusées, elles passent « refusee ».
ALTER TABLE stories ADD COLUMN parent_id TEXT REFERENCES stories(id);
ALTER TABLE stories DROP CONSTRAINT stories_statut_check;
ALTER TABLE stories ADD CONSTRAINT stories_statut_check
  CHECK (statut IN ('brouillon', 'prete', 'exportee', 'proposee', 'remplacee', 'refusee'));

-- Le PO peut réécrire une story : la version de l'agent est gardée, pour l'audit et le taux de correction.
ALTER TABLE stories ADD COLUMN contenu_agent JSONB;
ALTER TABLE stories ADD COLUMN modifiee_le TIMESTAMPTZ;
