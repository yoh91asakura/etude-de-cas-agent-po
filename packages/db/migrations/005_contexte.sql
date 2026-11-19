-- Une alerte désigne ce qu'elle concerne (un item ou un feedback) : le PO peut l'ouvrir d'un clic.
ALTER TABLE alertes ADD COLUMN cible TEXT;
