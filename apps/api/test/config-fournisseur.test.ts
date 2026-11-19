import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Db } from "@po-agent/db";
import { chargerEnvLocal, choisirFournisseur, fetchOpenRouter, lireEtapes, modeleOpenRouter } from "../src/config.ts";

// Aucune vraie clé ici : des valeurs factices au bon préfixe, et aucune requête n'est envoyée.
const CLE_OR = "sk-or-v1-factice";
const db = {} as Db;

describe("Configuration du fournisseur", () => {
  it("lit .env sans écraser l'environnement, et ignore les valeurs vides", () => {
    const dossier = mkdtempSync(path.join(tmpdir(), "po-agent-env-"));
    const fichier = path.join(dossier, ".env");
    writeFileSync(fichier, "# commentaire\nLLM_FOURNISSEUR=\nANTHROPIC_API_KEY=sk-or-v1-factice\nLLM_MODELE=\"claude-haiku-5-5\"\nDEJA=fichier\n");
    const env: NodeJS.ProcessEnv = { DEJA: "environnement" };
    expect(chargerEnvLocal(fichier, env)).toEqual(["ANTHROPIC_API_KEY", "LLM_MODELE"]);
    expect(env).toEqual({ DEJA: "environnement", ANTHROPIC_API_KEY: CLE_OR, LLM_MODELE: "claude-haiku-5-5" });
    expect(chargerEnvLocal(path.join(dossier, "absent.env"), env)).toEqual([]);
  });

  it("traduit les identifiants de modèles pour OpenRouter", () => {
    expect(modeleOpenRouter("claude-opus-5-5")).toBe("anthropic/claude-opus-5.5");
    expect(modeleOpenRouter("claude-haiku-5-5")).toBe("anthropic/claude-haiku-5.5");
    expect(modeleOpenRouter("claude-sonnet-5-5")).toBe("anthropic/claude-sonnet-5.5");
    expect(modeleOpenRouter("anthropic/claude-haiku-5.5")).toBe("anthropic/claude-haiku-5.5");
  });

  it("fait passer une clé OpenRouter par OpenRouter, épinglée sur Anthropic", () => {
    const f = choisirFournisseur(db, { ANTHROPIC_API_KEY: CLE_OR, LLM_MODELE: "claude-haiku-5-5" });
    expect(f.nom).toBe("claude (anthropic/claude-haiku-5.5) via OpenRouter, fournisseur anthropic");
    // Sans LLM_MODELE, chaque étape garde son modèle par défaut, traduit pour OpenRouter.
    const parEtape = choisirFournisseur(db, { OPENROUTER_API_KEY: CLE_OR }).nom;
    expect(parEtape).toMatch(/^claude \(modèle par étape ; /);
    expect(parEtape).toContain("extraction : anthropic/claude-sonnet-5.5");
    expect(parEtape).toContain("revue : anthropic/claude-opus-5.5");
    expect(choisirFournisseur(db, { OPENROUTER_API_KEY: CLE_OR, LLM_MODELE_EXTRACTION: "claude-haiku-5-5" }).nom).toContain("extraction : anthropic/claude-haiku-5.5");
  });

  it("lit le modèle et l'effort de chaque étape, et refuse une entrée mal formée", () => {
    expect(lireEtapes("extraction=claude-haiku-5-5:low, impact=claude-opus-5-5:high, revue=:high")).toEqual({
      modeles: { extraction: "claude-haiku-5-5", impact: "claude-opus-5-5" },
      efforts: { extraction: "low", impact: "high", revue: "high" },
    });
    expect(() => lireEtapes("impact=claude-opus-5-5:enorme")).toThrow(/effort inconnu/);
    expect(() => lireEtapes("impact")).toThrow(/mal formée/);
    const f = choisirFournisseur(db, { OPENROUTER_API_KEY: CLE_OR, LLM_MODELE: "claude-haiku-5-5", LLM_ETAPES: "impact=claude-opus-5-5:high" });
    expect(f.nom).toBe("claude (anthropic/claude-haiku-5.5 ; impact : anthropic/claude-opus-5.5, high) via OpenRouter, fournisseur anthropic");
  });

  it("refuse d'envoyer une clé OpenRouter vers une autre passerelle", () => {
    expect(() => choisirFournisseur(db, { LLM_API_KEY: CLE_OR, LLM_BASE_URL: "http://passerelle-llm:4000/anthropic" })).toThrow(/OpenRouter/);
  });

  it("garde le faux fournisseur quand il est demandé, et sans clé", () => {
    expect(choisirFournisseur(db, { LLM_FOURNISSEUR: "faux", ANTHROPIC_API_KEY: CLE_OR }).nom).toMatch(/^faux/);
    expect(choisirFournisseur(db, { LLM_API_KEY: "" }).nom).toMatch(/^faux/);
    expect(choisirFournisseur(db, { ANTHROPIC_API_KEY: "sk-ant-factice" }).nom).toMatch(/^claude \(modèle par étape ; extraction : claude-sonnet-5-5, /);
    expect(choisirFournisseur(db, { ANTHROPIC_API_KEY: "sk-ant-factice", LLM_MODELE: "claude-opus-5-5" }).nom).toBe("claude (claude-opus-5-5)");
  });

  it("ajoute l'épinglage au corps des requêtes, sans toucher aux en-têtes", async () => {
    let vu: RequestInit | undefined;
    const transport = (async (_url: unknown, init?: RequestInit) => {
      vu = init;
      return new Response("{}");
    }) as typeof fetch;
    await fetchOpenRouter(transport)("https://openrouter.ai/api/v1/messages", { method: "POST", headers: { "x-api-key": "k" }, body: JSON.stringify({ model: "m" }) });
    expect(JSON.parse(String(vu?.body))).toEqual({ model: "m", provider: { order: ["anthropic"], allow_fallbacks: false } });
    expect(vu?.headers).toEqual({ "x-api-key": "k" });
  });
});
