-- Les assistants du socle (via le serveur MCP) peuvent déposer une suggestion pour le PO. Ils ne décident jamais.
ALTER TABLE propositions DROP CONSTRAINT propositions_type_check;
ALTER TABLE propositions ADD CONSTRAINT propositions_type_check
  CHECK (type IN ('ordre_backlog', 'story_prete', 'export_jira', 'fusion', 'nouvel_item', 'regle', 'moscow', 'suggestion'));
