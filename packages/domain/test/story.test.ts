import { describe, expect, it } from "vitest";
import { controlerStory, phraseStory, type Story } from "../src/index.ts";

const story: Story = {
  itemId: "B02",
  enTantQue: "administrateur d'un espace Business",
  jeVeux: "restreindre l'accès d'un projet à certains membres",
  afinDe: "inviter des prestataires sans exposer les autres projets",
  criteres: [
    { etantDonne: "un projet restreint", quand: "un invité ouvre la liste des projets", alors: "il ne voit pas ce projet" },
    { etantDonne: "un membre en lecture seule", quand: "il tente de modifier une tâche", alors: "la modification est refusée" },
  ],
  casLimites: ["Un invité déjà membre d'un autre projet"],
  complexite: "L",
  citations: ["cacher un projet à un client invité"],
};

describe("controlerStory", () => {
  it("valide une story bien formée", () => {
    expect(controlerStory(story).every((c) => c.ok)).toBe(true);
  });
  it("signale un « je veux » qui porte plusieurs besoins", () => {
    const r = controlerStory({ ...story, jeVeux: "restreindre l'accès et aussi exporter les droits en CSV" });
    expect(r.find((c) => c.nom === "un_seul_besoin")?.ok).toBe(false);
  });
  it("signale un critère incomplet et une story sans citation", () => {
    const r = controlerStory({ ...story, criteres: [{ etantDonne: "", quand: "x x x", alors: "y y y" }], citations: [] });
    expect(r.filter((c) => !c.ok).map((c) => c.nom)).toEqual(["criteres_given_when_then", "au_moins_deux_criteres", "citations_presentes"]);
  });
});

describe("phraseStory", () => {
  it("lie « en tant que » et « afin de » selon ce qui suit (audit du 15/11/2026 : « afin de que »)", () => {
    expect(phraseStory({ enTantQue: "administratrice", jeVeux: "masquer un projet", afinDe: "que chaque client ne voie que le sien" })).toBe(
      "En tant qu'administratrice, je veux masquer un projet, afin que chaque client ne voie que le sien.",
    );
    expect(phraseStory({ enTantQue: "chef de projet", jeVeux: "exporter", afinDe: "éviter les recopies" })).toBe("En tant que chef de projet, je veux exporter, afin d'éviter les recopies.");
  });
});
