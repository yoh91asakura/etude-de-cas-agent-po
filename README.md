# Agent PO : le code de la démonstration

Cet agent IA assiste le Product Owner de Jalonne, une startup SaaS fictive de gestion de projet. Il lit les feedbacks clients, aide à prioriser le backlog et rédige les user stories. Le PO valide tout ce qui entre au backlog.

## Lancer la démo

La démo a été testée avec Node 24.

```bash
npm install
npm run demo
```

- Le cockpit s'ouvre sur http://localhost:5173, et l'API tourne sur le port 3000.
- La démo part d'un état déjà traité : une centaine de feedbacks reçus sur six semaines. Ils sont chargés depuis `donnees/instantanes/etat-demo.json`, sans appel au modèle.
- Sans clé d'API, un modèle simulé, qui raisonne par mots-clés, fait tourner l'interface, et le cockpit le signale.
- Pour travailler avec Claude, copiez `.env.example` en `.env` et renseignez `ANTHROPIC_API_KEY`. Les nouveaux feedbacks et les actions du PO appellent alors Claude.
- `npm run demo -- --reinitialiser` revient à l'état de départ.

## Tester

```bash
npm test
npm run typecheck
npm run evals -w @po-agent/api -- --depuis-instantane
```

- `npm test` lance les tests unitaires, métamorphiques, de la chaîne et de l'API, sans appel au modèle.
- La dernière commande juge l'état de démo contre la vérité terrain du jeu de données (`donnees/seed/verite-terrain.json`), sans appel au modèle. Son rapport arrive dans `evals/resultats/`.

## Lancer comme chez un client (Docker Compose)

```bash
cp .env.example .env
docker compose up -d postgres passerelle-llm
npm run socle:cle-projet
docker compose up --build
```

Renseignez `ANTHROPIC_API_KEY` dans `.env` avant la deuxième commande. Le cockpit est alors sur http://localhost:8080. Le compose démarre Postgres, une passerelle LLM (LiteLLM, avec une clé et un budget par projet), l'API, un worker séparé et le cockpit. `LLM_FOURNISSEUR=faux docker compose up --build` le lance sans clé.

## Organisation du code

| Dossier | Rôle |
|---|---|
| `packages/domain` | Le cœur métier, sans base ni modèle : RICE, filtres, tendances, doute, MoSCoW, doctrine, contrôles des stories. Toutes les valeurs sont dans `parametres.ts`. |
| `packages/llm` | Les appels à Claude par le SDK officiel d'Anthropic, avec des sorties structurées, les prompts et le modèle simulé. |
| `packages/db` | Le schéma Postgres, la file de tâches durable, le journal d'audit et les traces des appels. |
| `packages/agent` | La chaîne : extraction en quarantaine, rattachement, Impact sur cinq tirages, scores, questions, règles, stories, agent de fond. |
| `apps/api` | L'API Fastify, le flux en direct, le préchargement et les bancs d'évaluation. |
| `apps/web` | Le cockpit du PO, en React. |
| `socle/` | Le socle fictif du client : Postgres et la passerelle LLM. |
| `donnees/` | Le jeu de données, sa vérité terrain et l'état de démo. |
| `evals/cas/` | Les cas du banc des prompts. |
