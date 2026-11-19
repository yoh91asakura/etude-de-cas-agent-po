import { phraseStory, type Story } from "@po-agent/domain";
import type { OutilDeSuivi } from "@po-agent/agent";

/**
 * Export vers Jira Cloud (REST v3). Il n'est appelé qu'après une décision du PO (proposition « export_jira »).
 * Vérifié dans la doc Atlassian : authentification Basic (email + jeton d'API), description au format ADF
 * (racine « doc », version 1, nœuds paragraph, text, bulletList, listItem).
 * À vérifier avec un vrai site Jira : le chemin POST /rest/api/3/issue et la réponse { id, key, self },
 * dont la page de référence n'a pas pu être lue (rendue côté navigateur).
 */

type NoeudAdf = Record<string, unknown>;

const paragraphe = (texte: string): NoeudAdf => ({ type: "paragraph", content: [{ type: "text", text: texte }] });
const liste = (elements: string[]): NoeudAdf => ({ type: "bulletList", content: elements.map((e) => ({ type: "listItem", content: [paragraphe(e)] })) });

/** Description de la story au format ADF (Atlassian Document Format). */
export function descriptionAdf(s: Story): NoeudAdf {
  const contenu: NoeudAdf[] = [
    paragraphe(phraseStory(s)),
    paragraphe("Critères d'acceptation :"),
    liste(s.criteres.map((c) => `Étant donné ${c.etantDonne}, quand ${c.quand}, alors ${c.alors}.`)),
  ];
  if (s.casLimites.length > 0) contenu.push(paragraphe("Cas limites :"), liste(s.casLimites));
  if (s.citations.length > 0) contenu.push(paragraphe("Verbatims clients :"), liste(s.citations.map((c) => `« ${c} »`)));
  contenu.push(paragraphe(`Complexité estimée : ${s.complexite}. Story rédigée par l'agent PO et validée par le PO.`));
  return { version: 1, type: "doc", content: contenu };
}

export interface OptionsJira {
  /** Par exemple https://mon-site.atlassian.net */
  site: string;
  email: string;
  jetonApi: string;
  projet: string;
  typeTicket?: string;
  fetch?: typeof fetch;
}

export function outilJira(o: OptionsJira): OutilDeSuivi {
  const f = o.fetch ?? fetch;
  const site = o.site.replace(/\/+$/, "");
  const auth = `Basic ${Buffer.from(`${o.email}:${o.jetonApi}`, "utf8").toString("base64")}`;
  return {
    nom: "Jira",
    async creerTicket(story, titre) {
      const r = await f(`${site}/rest/api/3/issue`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          fields: {
            project: { key: o.projet },
            issuetype: { name: o.typeTicket ?? "Story" },
            summary: titre.slice(0, 250),
            description: descriptionAdf(story),
          },
        }),
      });
      const corps = (await r.json().catch(() => ({}))) as { key?: string; errorMessages?: string[]; errors?: Record<string, string> };
      if (!r.ok || !corps.key) {
        const detail = [...(corps.errorMessages ?? []), ...Object.values(corps.errors ?? {})].join(" ; ");
        throw new Error(`Jira a refusé la création (${r.status})${detail ? ` : ${detail}` : ""}`);
      }
      return { cle: corps.key, url: `${site}/browse/${corps.key}` };
    },
  };
}

/** Jira n'est branché que si toute sa configuration est présente. */
export function outilJiraDepuisEnv(env = process.env): OutilDeSuivi | undefined {
  if (!env.JIRA_SITE || !env.JIRA_EMAIL || !env.JIRA_API_TOKEN || !env.JIRA_PROJET) return undefined;
  return outilJira({ site: env.JIRA_SITE, email: env.JIRA_EMAIL, jetonApi: env.JIRA_API_TOKEN, projet: env.JIRA_PROJET, ...(env.JIRA_TYPE_TICKET ? { typeTicket: env.JIRA_TYPE_TICKET } : {}) });
}
