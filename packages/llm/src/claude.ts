import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { phraseStory, type Complexite, type Extraction, type ItemBacklog, type Story, type ValeurImpact } from "@po-agent/domain";
import { z } from "zod";
import { EchecLLM, type CandidatItem, type DemandeARattacher, type EntreeDecoupage, type EntreeImpact, type EtatRevue, type FournisseurLLM, type ImpactLLM, type MessageConversation, type OutilConversation, type ReponseConversation, type ResultatRevue, type VerdictLLM } from "./fournisseur.ts";
import { encadrerDonnee, PROMPT_COMPLEXITE, PROMPT_DECOUPAGE, PROMPT_EXTRACTION, PROMPT_FORMULER_REGLE, PROMPT_JUGE_STORY, PROMPT_CONVERSATION, PROMPT_RATTACHEMENT, PROMPT_REVUE, PROMPT_STORY, promptImpact } from "./prompts.ts";
import { SchemaComplexite, SchemaDecoupage, SchemaExtraction, SchemaImpact, SchemaJugementStory, SchemaRattachement, SchemaRegleRattachement, SchemaRevue, SchemaStory, type JugementStory } from "./schemas.ts";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface TraceAppel {
  etape: string;
  modele: string;
  effort: Effort;
  dureeMs: number;
  tokensEntree?: number;
  tokensSortie?: number;
  stopReason?: string;
  statut: "ok" | "refus" | "schema_invalide" | "erreur";
  erreur?: string;
}

/** Sous-ensemble du client Anthropic utilisé ici. Permet d'injecter un client factice dans les tests. */
export interface ClientMessages {
  messages: { parse: Anthropic["messages"]["parse"]; create?: Anthropic["messages"]["create"] };
}

/** Nombre maximal d'allers-retours d'outils pour une question du PO. */
const TOURS_MAX_CONVERSATION = 8;

export interface OptionsClaude {
  /**
   * Modèle imposé à toutes les étapes (LLM_MODELE), pour un test. Sans lui, chaque étape prend son modèle de MODELE_PAR_ETAPE,
   * et claude-opus-5-5 sert aux étapes qui n'y figurent pas.
   */
  modele?: string;
  /** URL de la passerelle LLM du socle. */
  baseURL?: string;
  apiKey?: string;
  traceur?: (t: TraceAppel) => Promise<void> | void;
  client?: ClientMessages;
  /** Modèle propre à certaines étapes, par exemple { extraction: "claude-haiku-5-5" } pour mesurer un modèle plus léger. */
  modeleParEtape?: Partial<Record<string, string>>;
  /** Effort propre à certaines étapes, prioritaire sur EFFORT_PAR_ETAPE (comparaison des modèles, réglage par l'humain). */
  effortParEtape?: Partial<Record<string, Effort>>;
  /** Transport HTTP du SDK, remplacé pour ajuster le corps des requêtes (voir la configuration OpenRouter de l'API). */
  fetch?: typeof fetch;
  /** Route suivie par les appels, affichée dans le nom du fournisseur (par exemple « via OpenRouter, fournisseur anthropic »). */
  route?: string;
  /** Traduit un identifiant de modèle pour la route suivie (OpenRouter écrit « anthropic/claude-haiku-5.5 »). */
  traduireModele?: (modele: string) => string;
}

/**
 * Modèle de chaque étape, adopté par l'humain sur le comparatif des modèles et des efforts
 * (docs/decisions/013-choix-modele-par-etape.md) : Sonnet lit les feedbacks, Haiku rend les jugements courts,
 * Opus fait la revue de fond et juge les stories, ce qui garde le juge indépendant du rédacteur.
 */
export const MODELE_PAR_ETAPE: Record<string, string> = {
  extraction: "claude-sonnet-5-5",
  rattachement: "claude-sonnet-5-5",
  formuler_regle: "claude-haiku-5-5",
  revue: "claude-opus-5-5",
  impact: "claude-haiku-5-5",
  complexite: "claude-haiku-5-5",
  story: "claude-haiku-5-5",
  // Découpage (audit du 15/11/2026) : une rédaction, comme la story ; pas encore passé au comparatif des modèles.
  decoupage: "claude-haiku-5-5",
  juge_story: "claude-opus-5-5",
  conversation: "claude-haiku-5-5",
};

/** Niveau d'effort de chaque étape, adopté avec MODELE_PAR_ETAPE (docs/decisions/013-choix-modele-par-etape.md). */
export const EFFORT_PAR_ETAPE: Record<string, Effort> = {
  extraction: "low",
  rattachement: "low",
  formuler_regle: "low",
  revue: "low",
  impact: "low",
  complexite: "low",
  story: "high",
  decoupage: "high",
  juge_story: "low",
  conversation: "high",
};

/** Rotation déterministe : chaque tirage voit les éléments dans un ordre différent (biais de position). */
function rotation<T>(liste: T[], decalage: number): T[] {
  if (liste.length === 0) return liste;
  const d = decalage % liste.length;
  return [...liste.slice(d), ...liste.slice(0, d)];
}

export class FournisseurClaude implements FournisseurLLM {
  readonly nom: string;
  private readonly modele: string;
  private readonly client: ClientMessages;
  private readonly traceur?: OptionsClaude["traceur"];
  private readonly modeleParEtape: Partial<Record<string, string>>;
  private readonly effortParEtape: Partial<Record<string, Effort>>;

  constructor(options: OptionsClaude = {}) {
    const traduire = options.traduireModele ?? ((m: string) => m);
    this.modele = traduire(options.modele ?? "claude-opus-5-5");
    // Un modèle imposé vaut pour toutes les étapes ; sans lui, chaque étape prend le sien. Les réglages par étape passés
    // en option (LLM_ETAPES) restent prioritaires dans les deux cas.
    const parEtape = { ...(options.modele ? {} : MODELE_PAR_ETAPE), ...options.modeleParEtape };
    this.modeleParEtape = Object.fromEntries(Object.entries(parEtape).flatMap(([e, m]) => (m ? [[e, traduire(m)]] : [])));
    this.effortParEtape = options.effortParEtape ?? {};
    const etapes = [...new Set([...Object.keys(this.modeleParEtape), ...Object.keys(this.effortParEtape)])];
    const variantes = etapes.map((e) => `${e} : ${[this.modeleParEtape[e], this.effortParEtape[e]].filter(Boolean).join(", ")}`);
    // Le libellé du cockpit lit ce qui précède le premier « ; » : le modèle imposé, ou « modèle par étape ».
    const principal = options.modele ? this.modele : "modèle par étape";
    this.nom = `claude (${principal}${variantes.length > 0 ? ` ; ${variantes.join(", ")}` : ""})${options.route ? ` ${options.route}` : ""}`;
    this.traceur = options.traceur;
    this.client =
      options.client ??
      new Anthropic({
        ...(options.baseURL ? { baseURL: options.baseURL } : {}),
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
  }

  private async tracer(t: TraceAppel): Promise<void> {
    try {
      await this.traceur?.(t);
    } catch {
      // Une trace perdue ne doit jamais casser le traitement.
    }
  }

  /** Appel unique, sans outils, à sortie structurée. Une seconde tentative si la sortie ne respecte pas le schéma. */
  private async appeler<S extends z.ZodType>(etape: string, systeme: string, contenu: string, schema: S): Promise<z.infer<S>> {
    const effort = this.effortParEtape[etape] ?? EFFORT_PAR_ETAPE[etape] ?? "medium";
    const modele = this.modeleParEtape[etape] ?? this.modele;
    for (let essai = 1; essai <= 2; essai++) {
      const debut = performance.now();
      const base = { etape, modele, effort };
      let reponse;
      try {
        reponse = await this.client.messages.parse({
          model: modele,
          max_tokens: 16000,
          system: systeme,
          messages: [{ role: "user", content: contenu }],
          output_config: { format: zodOutputFormat(schema), effort },
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await this.tracer({ ...base, dureeMs: performance.now() - debut, statut: "erreur", erreur: message });
        throw new EchecLLM(etape, "erreur", message);
      }
      const mesure = {
        ...base,
        dureeMs: performance.now() - debut,
        tokensEntree: reponse.usage?.input_tokens,
        tokensSortie: reponse.usage?.output_tokens,
        stopReason: reponse.stop_reason ?? undefined,
      };
      if (reponse.stop_reason === "refusal") {
        await this.tracer({ ...mesure, statut: "refus" });
        throw new EchecLLM(etape, "refus", "le modèle a refusé de répondre");
      }
      if (reponse.parsed_output == null) {
        await this.tracer({ ...mesure, statut: "schema_invalide" });
        if (essai === 2) throw new EchecLLM(etape, "schema_invalide", "sortie non conforme au schéma après deux essais");
        continue;
      }
      await this.tracer({ ...mesure, statut: "ok" });
      return reponse.parsed_output as z.infer<S>;
    }
    throw new EchecLLM(etape, "erreur", "boucle d'essais épuisée");
  }

  async extraire(feedback: { id: string; texte: string }): Promise<Extraction> {
    const r = await this.appeler("extraction", PROMPT_EXTRACTION, encadrerDonnee("feedback", feedback.texte), SchemaExtraction);
    return {
      feedbackId: feedback.id,
      nature: r.nature,
      injectionSuspectee: r.injection_suspectee,
      menaceDepart: r.menace_depart,
      demandes: r.demandes.map((d) => ({ resume: d.resume, citation: d.citation, regression: d.regression })),
    };
  }

  async jugerRattachement(demande: DemandeARattacher, candidats: CandidatItem[], tirage: number): Promise<VerdictLLM> {
    const liste = rotation(candidats, tirage)
      .map((c) => `- ${c.id} · ${c.titre}${c.description ? ` : ${c.description}` : ""}`)
      .join("\n");
    const contenu = `Demande : ${demande.resume}\n${encadrerDonnee("citation", demande.citation)}\n\nÉléments candidats :\n${liste}`;
    const r = await this.appeler("rattachement", PROMPT_RATTACHEMENT, contenu, SchemaRattachement);
    const ids = new Set(candidats.map((c) => c.id));
    const connu = r.item_id !== null && ids.has(r.item_id);
    return {
      itemId: connu ? r.item_id : null,
      verdict: connu || r.verdict !== "meme_besoin" ? r.verdict : "incertain",
      alternatives: r.candidats_plausibles.filter((id) => ids.has(id)),
      justification: r.justification,
    };
  }

  async jugerImpact(entree: EntreeImpact, tirage: number): Promise<ImpactLLM> {
    const verbatims = rotation(entree.citations, tirage)
      .map((c) => encadrerDonnee("verbatim", c))
      .join("\n");
    const contenu = `Élément : ${entree.item.titre}${entree.item.description ? `\n${entree.item.description}` : ""}\n\nVerbatims :\n${verbatims}`;
    const r = await this.appeler("impact", promptImpact(tirage), contenu, SchemaImpact);
    return { impact: Number(r.impact) as ValeurImpact, justification: r.justification, citations: r.citations };
  }

  async estimerComplexite(item: Pick<ItemBacklog, "titre" | "description">, citations: string[]): Promise<{ complexite: Complexite; justification: string }> {
    const contenu = `Élément : ${item.titre}${item.description ? `\n${item.description}` : ""}\n\n${citations.map((c) => encadrerDonnee("verbatim", c)).join("\n")}`;
    return this.appeler("complexite", PROMPT_COMPLEXITE, contenu, SchemaComplexite);
  }

  async redigerStory(entree: { item: ItemBacklog; citations: string[] }): Promise<Story> {
    const contenu = `Élément : ${entree.item.titre}${entree.item.description ? `\n${entree.item.description}` : ""}\n\nVerbatims :\n${entree.citations.map((c) => encadrerDonnee("verbatim", c)).join("\n")}`;
    const r = await this.appeler("story", PROMPT_STORY, contenu, SchemaStory);
    return {
      itemId: entree.item.id,
      enTantQue: r.en_tant_que,
      jeVeux: r.je_veux,
      afinDe: r.afin_de,
      criteres: r.criteres.map((c) => ({ etantDonne: c.etant_donne, quand: c.quand, alors: c.alors })),
      casLimites: r.cas_limites,
      complexite: r.complexite,
      citations: r.citations,
    };
  }

  async decouperStory(entree: EntreeDecoupage): Promise<{ stories: Story[]; justification: string }> {
    const s = entree.story;
    const contenu = [
      `Élément : ${entree.item.titre}${entree.item.description ? ` (${entree.item.description})` : ""}`,
      "",
      "Story à découper :",
      phraseStory(s),
      ...s.criteres.map((c, i) => `${i + 1}. Étant donné ${c.etantDonne}, quand ${c.quand}, alors ${c.alors}.`),
      `Cas limites : ${s.casLimites.join(" ; ") || "aucun"}`,
      "",
      `Reproches du relecteur : ${entree.reproches.join(" ; ") || "aucun"}`,
      "",
      "Verbatims :",
      ...entree.citations.map((c) => encadrerDonnee("verbatim", c)),
    ].join("\n");
    const r = await this.appeler("decoupage", PROMPT_DECOUPAGE, contenu, SchemaDecoupage);
    if (r.stories.length < 2 || r.stories.length > 4) throw new EchecLLM("decoupage", "schema_invalide", `${r.stories.length} story(s) au lieu de 2 à 4`);
    return {
      justification: r.justification,
      stories: r.stories.map((x) => ({
        itemId: entree.item.id,
        enTantQue: x.en_tant_que,
        jeVeux: x.je_veux,
        afinDe: x.afin_de,
        criteres: x.criteres.map((c) => ({ etantDonne: c.etant_donne, quand: c.quand, alors: c.alors })),
        casLimites: x.cas_limites,
        complexite: x.complexite,
        citations: x.citations,
      })),
    };
  }

  async jugerStory(story: Story): Promise<JugementStory> {
    const contenu = [
      phraseStory(story),
      "Critères d'acceptation :",
      ...story.criteres.map((c, i) => `${i + 1}. Étant donné ${c.etantDonne}, quand ${c.quand}, alors ${c.alors}.`),
      `Cas limites : ${story.casLimites.join(" ; ") || "aucun"}`,
    ].join("\n");
    return this.appeler("juge_story", PROMPT_JUGE_STORY, contenu, SchemaJugementStory);
  }

  /**
   * Boucle d'outils écrite à la main sur la Messages API (sans dépendance bêta).
   * Chaque entrée d'outil est validée par son schéma avant exécution ; une entrée invalide renvoie une erreur à l'agent.
   */
  async converser(entree: { message: string; historique: MessageConversation[]; outils: OutilConversation[] }): Promise<ReponseConversation> {
    const creer = this.client.messages.create;
    if (!creer) throw new EchecLLM("conversation", "erreur", "client sans messages.create");
    const outils = new Map(entree.outils.map((o) => [o.nom, o]));
    const tools: Anthropic.Tool[] = entree.outils.map((o) => {
      const { $schema: _ignore, ...schema } = z.toJSONSchema(o.schema) as Record<string, unknown>;
      return { name: o.nom, description: o.description, input_schema: schema as Anthropic.Tool.InputSchema };
    });
    const messages: Anthropic.MessageParam[] = [
      ...entree.historique.map((m) => ({ role: m.role, content: m.texte })),
      { role: "user", content: entree.message },
    ];
    const appels: ReponseConversation["appels"] = [];
    const effort: Effort = this.effortParEtape.conversation ?? EFFORT_PAR_ETAPE.conversation ?? "medium";
    const modele = this.modeleParEtape.conversation ?? this.modele;

    for (let tour = 0; tour < TOURS_MAX_CONVERSATION; tour++) {
      const debut = performance.now();
      let r: Anthropic.Message;
      try {
        r = (await creer.call(this.client.messages, {
          model: modele,
          max_tokens: 16000,
          system: PROMPT_CONVERSATION,
          tools,
          messages,
          output_config: { effort },
        })) as Anthropic.Message;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await this.tracer({ etape: "conversation", modele, effort, dureeMs: performance.now() - debut, statut: "erreur", erreur: message });
        throw new EchecLLM("conversation", "erreur", message);
      }
      await this.tracer({
        etape: "conversation",
        modele,
        effort,
        dureeMs: performance.now() - debut,
        tokensEntree: r.usage?.input_tokens,
        tokensSortie: r.usage?.output_tokens,
        statut: r.stop_reason === "refusal" ? "refus" : "ok",
        ...(r.stop_reason ? { stopReason: r.stop_reason } : {}),
      });
      if (r.stop_reason === "refusal") throw new EchecLLM("conversation", "refus", "le modèle a refusé de répondre");
      if (r.stop_reason !== "tool_use") {
        const texte = r.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
        return { texte, appels };
      }
      messages.push({ role: "assistant", content: r.content });
      const resultats: Anthropic.ToolResultBlockParam[] = [];
      for (const bloc of r.content) {
        if (bloc.type !== "tool_use") continue;
        const outil = outils.get(bloc.name);
        const valide = outil?.schema.safeParse(bloc.input);
        if (!outil || !valide?.success) {
          resultats.push({ type: "tool_result", tool_use_id: bloc.id, content: `Entrée invalide pour l'outil ${bloc.name}.`, is_error: true });
          continue;
        }
        appels.push({ outil: bloc.name, entree: valide.data });
        try {
          resultats.push({ type: "tool_result", tool_use_id: bloc.id, content: await outil.executer(valide.data) });
        } catch (e) {
          resultats.push({ type: "tool_result", tool_use_id: bloc.id, content: `Erreur : ${e instanceof Error ? e.message : String(e)}`, is_error: true });
        }
      }
      messages.push({ role: "user", content: resultats });
    }
    return { texte: "Je n'ai pas pu conclure en un nombre raisonnable d'étapes. Reformulez la question, plus précisément.", appels };
  }

  async revueDeFond(etat: EtatRevue): Promise<ResultatRevue> {
    const items = etat.items
      .map((i) => `- ${i.id} · ${i.titre}${i.creeParAgent ? " (créé par l'agent)" : ""} · ${i.preuves} preuve(s)\n${i.verbatims.slice(0, 3).map((v) => `  ${encadrerDonnee("verbatim", v)}`).join("\n")}`)
      .join("\n");
    const reponses = etat.reponsesPO.map((r) => `- ${r.id} : « ${r.enonce} » → ${r.choix}${r.citation ? `\n  ${encadrerDonnee("citation", r.citation)}` : ""}`).join("\n") || "aucune";
    const r = await this.appeler("revue", PROMPT_REVUE, `Éléments du backlog :\n${items}\n\nRéponses déjà données par le PO :\n${reponses}`, SchemaRevue);
    const ids = new Set(etat.items.map((i) => i.id));
    const reponsesConnues = new Set(etat.reponsesPO.map((x) => x.id));
    return {
      fusions: r.fusions.filter((f) => ids.has(f.item_a) && ids.has(f.item_b) && f.item_a !== f.item_b).map((f) => ({ itemA: f.item_a, itemB: f.item_b, explication: f.explication })),
      // Une règle sans réponse du PO connue à l'origine est écartée ici, avant même d'atteindre le domaine.
      regles: r.regles
        .filter((x) => ids.has(x.item_id) && x.reponses_sources.length > 0 && x.reponses_sources.every((s) => reponsesConnues.has(s)))
        .map((x) => ({ itemId: x.item_id, motsCles: x.mots_cles, reponsesSources: x.reponses_sources, texte: x.texte })),
    };
  }

  async formulerRegleRattachement(entree: { citation: string; itemChoisi: CandidatItem; itemsEcartes: CandidatItem[] }): Promise<{ motsCles: string[]; texte: string }> {
    const contenu = [
      encadrerDonnee("citation", entree.citation),
      `Élément choisi par le PO : ${entree.itemChoisi.id} · ${entree.itemChoisi.titre}`,
      `Éléments écartés : ${entree.itemsEcartes.map((c) => `${c.id} · ${c.titre}`).join(" ; ") || "aucun"}`,
    ].join("\n");
    const r = await this.appeler("formuler_regle", PROMPT_FORMULER_REGLE, contenu, SchemaRegleRattachement);
    return { motsCles: r.mots_cles, texte: r.texte };
  }
}
