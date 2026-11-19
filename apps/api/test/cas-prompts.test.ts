import { describe, expect, it } from "vitest";
import { citationVerifiee, controlerStory, type Story } from "@po-agent/domain";
import { EchecLLM, FournisseurFaux, type FournisseurLLM, type JugementStory } from "@po-agent/llm";
import { casNonValides, chargerDonnees, controlerCas, extraitRepresentatif } from "../src/evals/donnees.ts";
import { etapeJuge, etapeStories } from "../src/evals/etapes.ts";

/** Fournisseur de test qui n'accepte qu'une méthode : tout autre appel au modèle fait échouer l'étape. */
function seulement<M extends keyof FournisseurLLM>(methode: M, impl: FournisseurLLM[M]): FournisseurLLM {
  return new Proxy({} as FournisseurLLM, {
    get: (_cible, prop) => {
      if (prop === "nom") return "test";
      if (prop === methode) return impl;
      return typeof prop === "string"
        ? () => {
            throw new Error(`appel inattendu : ${prop}`);
          }
        : undefined;
    },
  });
}
const sansEtat = () => Promise.reject(new Error("l'étape ne doit pas construire d'état de test"));

describe("Fichiers de cas du banc des prompts", () => {
  it("sont cohérents avec le jeu de données et la vérité terrain", async () => {
    const d = await chargerDonnees();
    expect(d.cas.paraphrases.cas.length).toBeGreaterThan(0);
    // Tant que l'humain ne les a pas validés, le banc les signale comme non probants.
    expect(casNonValides(d)).toEqual(expect.arrayContaining(["paraphrases", "stories", "juge"]));
  });

  it("refusent une citation qui ne figure pas mot pour mot, ou une réponse contraire à la vérité terrain", async () => {
    const d = await chargerDonnees();
    const regle = d.cas.regles.cas[0]!;
    const altere = { ...d, cas: { ...d.cas, regles: { ...d.cas.regles, cas: [{ ...regle, citation: "une citation inventée de toutes pièces" }] } } };
    expect(() => controlerCas(altere)).toThrow(/mot pour mot/);
    const contraire = { ...d, cas: { ...d.cas, regles: { ...d.cas.regles, cas: [{ ...regle, itemChoisi: "B04" }] } } };
    expect(() => controlerCas(contraire)).toThrow(/vérité terrain/);
  });

  it("tirent un extrait significatif, sans formule de politesse", () => {
    expect(extraitRepresentatif("Bonjour,\n\nNous utilisons Teams au quotidien. Merci !")).toBe("Nous utilisons Teams au quotidien.");
  });

  it("rédaction : B02, B05 et B06, chacun avec 2 à 4 extraits mot pour mot de feedbacks qui lui sont rattachés", async () => {
    const d = await chargerDonnees();
    expect(d.cas.stories.cas.map((c) => c.itemId)).toEqual(["B02", "B05", "B06"]);
    for (const c of d.cas.stories.cas) {
      expect(c.verbatims.length).toBeGreaterThanOrEqual(2);
      expect(c.verbatims.length).toBeLessThanOrEqual(4);
      for (const v of c.verbatims) {
        expect(citationVerifiee(v.extrait, d.textes.get(v.feedbackId)!.texte)).toBe(true);
        expect(d.attendus.get(v.feedbackId)).toBe(c.itemId);
      }
    }
  });

  it("rédaction : refusent un extrait inventé, un extrait d'un autre élément, ou trop peu d'extraits", async () => {
    const d = await chargerDonnees();
    const s = d.cas.stories.cas[0]!;
    const avec = (cas: typeof s) => ({ ...d, cas: { ...d.cas, stories: { ...d.cas.stories, cas: [cas] } } });
    const [v1, v2] = s.verbatims;
    expect(() => controlerCas(avec({ ...s, verbatims: [{ ...v1!, extrait: "Un extrait inventé de toutes pièces." }, v2!] }))).toThrow(/mot pour mot/);
    // F046 est un vrai feedback, mais la vérité terrain le rattache à l'export Excel (B06), pas aux permissions (B02).
    expect(() => controlerCas(avec({ ...s, verbatims: [v1!, { feedbackId: "F046", extrait: "Est-ce qu'on peut exporter la liste des tâches vers Excel ?" }] }))).toThrow(/vérité terrain/);
    expect(() => controlerCas(avec({ ...s, verbatims: [v1!] }))).toThrow(/de 2 à 4/);
  });

  it("juge : deux stories saines conformes au domaine, deux défectueuses, une par défaut flagrant", async () => {
    const d = await chargerDonnees();
    const saines = d.cas.juge.stories.filter((j) => j.nature === "saine");
    const defectueuses = d.cas.juge.stories.filter((j) => j.nature === "defectueuse");
    expect([saines.length, defectueuses.length]).toEqual([2, 2]);
    for (const j of saines) expect(controlerStory(j.story).filter((c) => !c.ok)).toEqual([]);
    const melange = defectueuses.find((j) => j.attendus.un_seul_besoin === false);
    expect(melange).toBeDefined();
    expect(defectueuses.some((j) => j.attendus.petite === false)).toBe(true);
    // Le contrôle lexical du domaine laisse passer la story aux trois besoins : seul le juge peut la repérer.
    expect(controlerStory(melange!.story).find((c) => c.nom === "un_seul_besoin")?.ok).toBe(true);
  });

  it("juge : refusent une citation inventée ou des attendus incohérents avec la nature de la story", async () => {
    const d = await chargerDonnees();
    const j = d.cas.juge.stories[0]!;
    const avec = (story: typeof j) => ({ ...d, cas: { ...d.cas, juge: { ...d.cas.juge, stories: [story] } } });
    expect(() => controlerCas(avec({ ...j, story: { ...j.story, citations: ["Une citation que personne n'a écrite."] } }))).toThrow(/mot pour mot/);
    expect(() => controlerCas(avec({ ...j, attendus: { un_seul_besoin: true } }))).toThrow(/saine/);
    expect(() => controlerCas(avec({ ...j, nature: "defectueuse" }))).toThrow(/défectueuse/);
  });
});

describe("Étapes stories et juge du banc des prompts", () => {
  it("rédaction : n'appelle que redigerStory, et refuse une citation recousue sur deux verbatims", async () => {
    const d = await chargerDonnees();
    const faux = new FournisseurFaux();
    const bilan = await etapeStories(seulement("redigerStory", (e) => faux.redigerStory(e)), d, sansEtat);
    expect(bilan.resultats.filter((r) => !r.ok)).toEqual([]);
    expect(bilan.mesures["Critères d'acceptation par story"]).toBe("B02 2, B05 2, B06 2");

    const recousue = seulement("redigerStory", async (e) => ({ ...(await faux.redigerStory(e)), citations: [e.citations.slice(0, 2).join(" ")] }));
    const ko = (await etapeStories(recousue, d, sansEtat)).resultats.filter((r) => !r.ok).map((r) => r.nom);
    expect(ko).toEqual(d.cas.stories.cas.map((c) => `${c.id} ${c.itemId} citations mot pour mot dans les verbatims fournis`));
  });

  it("juge : n'appelle que jugerStory, et un juge qui repère les défauts passe toutes les vérifications", async () => {
    const d = await chargerDonnees();
    let appels = 0;
    const discernant = seulement("jugerStory", async (s: Story): Promise<JugementStory> => {
      appels += 1;
      const plusieurs = s.jeVeux.includes(",") && s.jeVeux.includes(" et ");
      return { independante: true, valeur: true, estimable: true, petite: s.complexite !== "XL", testable: true, un_seul_besoin: !plusieurs, commentaire: "" };
    });
    const bilan = await etapeJuge(discernant, d, sansEtat);
    expect(appels).toBe(d.cas.juge.stories.length * d.cas.juge.appels);
    expect(bilan.resultats.filter((r) => !r.ok)).toEqual([]);

    // Le juge factice dit toujours oui : il est stable mais manque les deux défauts, sans faire tomber le banc.
    const complaisant = await etapeJuge(seulement("jugerStory", () => new FournisseurFaux().jugerStory()), d, sansEtat);
    expect(complaisant.resultats.filter((r) => !r.ok).map((r) => r.nom)).toEqual(["J3 défaut repéré : un_seul_besoin", "J4 défaut repéré : petite"]);

    // Un échec maîtrisé du modèle compte comme un échec du cas, pas comme une panne.
    const refus = await etapeJuge(seulement("jugerStory", () => Promise.reject(new EchecLLM("juge_story", "refus", "refus"))), d, sansEtat);
    expect(refus.resultats.map((r) => r.ok)).toEqual(d.cas.juge.stories.map(() => false));
  });
});
