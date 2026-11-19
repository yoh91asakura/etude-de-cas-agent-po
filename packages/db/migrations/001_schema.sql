-- Schéma de l'agent PO. L'état vit ici, pas dans un framework.

CREATE TABLE comptes (
  id            TEXT PRIMARY KEY,
  nom           TEXT NOT NULL,
  plan          TEXT NOT NULL CHECK (plan IN ('free', 'pro', 'business')),
  mrr           INTEGER NOT NULL DEFAULT 0,
  risque_depart BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE feedbacks (
  id        TEXT PRIMARY KEY,
  compte_id TEXT NOT NULL REFERENCES comptes(id),
  canal     TEXT NOT NULL CHECK (canal IN ('email', 'ticket', 'commentaire', 'direct')),
  recu_le   TIMESTAMPTZ NOT NULL,
  texte     TEXT NOT NULL,
  -- Anti-doublon : deux feedbacks de même empreinte ne comptent qu'une fois.
  empreinte TEXT NOT NULL UNIQUE,
  -- recu → extrait | suspect | en_attente (échec maîtrisé du modèle) → traite
  statut    TEXT NOT NULL DEFAULT 'recu' CHECK (statut IN ('recu', 'extrait', 'suspect', 'en_attente', 'traite')),
  cree_le   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sortie structurée de l'extraction en quarantaine : la seule vue d'un feedback qu'a le reste de la chaîne.
CREATE TABLE extractions (
  feedback_id         TEXT PRIMARY KEY REFERENCES feedbacks(id),
  nature              TEXT NOT NULL,
  injection_suspectee BOOLEAN NOT NULL,
  menace_depart       BOOLEAN NOT NULL,
  demandes            JSONB NOT NULL,
  demandes_rejetees   JSONB NOT NULL DEFAULT '[]',
  cree_le             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE items (
  id                   TEXT PRIMARY KEY,
  titre                TEXT NOT NULL,
  description          TEXT,
  type                 TEXT NOT NULL CHECK (type IN ('fonctionnalite', 'bug')),
  statut               TEXT NOT NULL CHECK (statut IN ('candidat', 'backlog', 'pret', 'termine')),
  complexite           TEXT NOT NULL CHECK (complexite IN ('S', 'M', 'L', 'XL')),
  alignement_objectif  BOOLEAN NOT NULL DEFAULT FALSE,
  cree_par             TEXT NOT NULL DEFAULT 'humain' CHECK (cree_par IN ('humain', 'agent')),
  cree_le              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE preuves (
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES items(id),
  feedback_id TEXT NOT NULL REFERENCES feedbacks(id),
  compte_id   TEXT NOT NULL REFERENCES comptes(id),
  canal       TEXT NOT NULL,
  recu_le     TIMESTAMPTZ NOT NULL,
  citation    TEXT NOT NULL,
  sure        BOOLEAN NOT NULL,
  regle_id    TEXT,
  -- Une fusion réversible : une preuve déplacée garde la trace de son item d'origine.
  item_origine TEXT,
  cree_le     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_id, feedback_id)
);

CREATE TABLE jugements_impact (
  item_id       TEXT PRIMARY KEY REFERENCES items(id),
  tirages       JSONB NOT NULL,
  mediane       NUMERIC NOT NULL,
  ecart_crans   INTEGER NOT NULL,
  justification TEXT NOT NULL,
  citations     JSONB NOT NULL,
  regles        JSONB NOT NULL DEFAULT '[]',
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Instantanés de scores, pour expliquer les écarts d'un calcul à l'autre.
CREATE TABLE scores (
  id         BIGSERIAL PRIMARY KEY,
  item_id    TEXT NOT NULL REFERENCES items(id),
  filtres    TEXT NOT NULL,
  detail     JSONB NOT NULL,
  calcule_le TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scores_item_filtres ON scores (item_id, filtres, calcule_le DESC);

-- Tout ce que l'agent propose et que le PO décide.
CREATE TABLE propositions (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN ('ordre_backlog', 'story_prete', 'export_jira', 'fusion', 'nouvel_item', 'regle', 'moscow')),
  charge     JSONB NOT NULL,
  resume     TEXT NOT NULL,
  statut     TEXT NOT NULL DEFAULT 'en_attente' CHECK (statut IN ('en_attente', 'acceptee', 'refusee', 'expiree')),
  creee_le   TIMESTAMPTZ NOT NULL DEFAULT now(),
  decidee_le TIMESTAMPTZ
);

CREATE TABLE questions (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('rattachement', 'fusion', 'impact', 'requalification')),
  enonce      TEXT NOT NULL,
  options     JSONB NOT NULL,
  contexte    JSONB NOT NULL,
  enjeu       NUMERIC NOT NULL DEFAULT 0,
  urgente     BOOLEAN NOT NULL DEFAULT FALSE,
  etat        TEXT NOT NULL DEFAULT 'ouverte' CHECK (etat IN ('ouverte', 'relancee', 'repondue', 'expiree')),
  relances    INTEGER NOT NULL DEFAULT 0,
  posee_le    TIMESTAMPTZ,
  creee_le    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reponses (
  id          TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id),
  -- Seul le PO répond. Une règle de doctrine ne peut naître que d'ici.
  auteur      TEXT NOT NULL CHECK (auteur = 'po'),
  choix       TEXT NOT NULL,
  canal       TEXT NOT NULL CHECK (canal IN ('application', 'telegram')),
  recue_le    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE regles (
  id                 TEXT NOT NULL,
  version            INTEGER NOT NULL,
  contenu            JSONB NOT NULL,
  texte              TEXT NOT NULL,
  source_reponse_id  TEXT NOT NULL REFERENCES reponses(id),
  statut             TEXT NOT NULL CHECK (statut IN ('proposee', 'active', 'rejetee', 'retiree')),
  creee_le           TIMESTAMPTZ NOT NULL,
  validee_le         TIMESTAMPTZ,
  PRIMARY KEY (id, version)
);

CREATE TABLE stories (
  id        TEXT PRIMARY KEY,
  item_id   TEXT NOT NULL REFERENCES items(id),
  contenu   JSONB NOT NULL,
  controles JSONB NOT NULL,
  jugement  JSONB,
  statut    TEXT NOT NULL DEFAULT 'brouillon' CHECK (statut IN ('brouillon', 'prete', 'exportee')),
  creee_le  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE alertes (
  id        BIGSERIAL PRIMARY KEY,
  type      TEXT NOT NULL,
  message   TEXT NOT NULL,
  urgente   BOOLEAN NOT NULL DEFAULT FALSE,
  creee_le  TIMESTAMPTZ NOT NULL DEFAULT now(),
  envoyee_le TIMESTAMPTZ,
  canal     TEXT
);

-- Audit : toute écriture de l'agent est consignée avant d'être exécutée.
CREATE TABLE journal_activite (
  id            BIGSERIAL PRIMARY KEY,
  acteur        TEXT NOT NULL CHECK (acteur IN ('agent', 'po', 'systeme')),
  action        TEXT NOT NULL,
  cible         TEXT,
  details       JSONB NOT NULL DEFAULT '{}',
  regles_citees JSONB NOT NULL DEFAULT '[]',
  horodatage    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Traces de chaque appel au modèle : coût, durée, issue.
CREATE TABLE traces_llm (
  id             BIGSERIAL PRIMARY KEY,
  etape          TEXT NOT NULL,
  modele         TEXT NOT NULL,
  effort         TEXT,
  duree_ms       INTEGER NOT NULL,
  tokens_entree  INTEGER,
  tokens_sortie  INTEGER,
  stop_reason    TEXT,
  statut         TEXT NOT NULL CHECK (statut IN ('ok', 'refus', 'schema_invalide', 'erreur')),
  erreur         TEXT,
  horodatage     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- File de tâches durable (version minimale du service du socle).
CREATE TABLE taches (
  id            BIGSERIAL PRIMARY KEY,
  type          TEXT NOT NULL,
  charge        JSONB NOT NULL DEFAULT '{}',
  -- Clé d'idempotence : une même tâche n'est jamais mise deux fois en file.
  cle           TEXT UNIQUE,
  statut        TEXT NOT NULL DEFAULT 'a_faire' CHECK (statut IN ('a_faire', 'en_cours', 'faite', 'echec')),
  tentatives    INTEGER NOT NULL DEFAULT 0,
  disponible_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  prise_le      TIMESTAMPTZ,
  erreur        TEXT,
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX taches_a_faire ON taches (statut, disponible_le) WHERE statut = 'a_faire';
