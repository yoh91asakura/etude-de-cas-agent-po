-- La valeur du tirage dont la justification est gardée. Vide pour un jugement plus ancien :
-- l'agent gardait alors la justification du premier tirage, quelle que soit sa valeur.
ALTER TABLE jugements_impact ADD COLUMN valeur_justification NUMERIC;
