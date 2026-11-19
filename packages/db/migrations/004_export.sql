-- Export des stories validées vers l'outil de suivi de l'équipe (Jira), après décision du PO.
ALTER TABLE stories ADD COLUMN ticket_cle TEXT;
ALTER TABLE stories ADD COLUMN ticket_url TEXT;
