-- Canaux de notification du PO (Telegram, optionnel) : on retient ce qui a déjà été envoyé.
ALTER TABLE questions ADD COLUMN envoyee_le TIMESTAMPTZ;
