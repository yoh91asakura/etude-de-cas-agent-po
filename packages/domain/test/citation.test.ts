import { describe, expect, it } from "vitest";
import { citationVerifiee, demandesExploitables, empreinteFeedback } from "../src/index.ts";
import type { Extraction } from "../src/index.ts";

const TEXTE = "Bonjour, ce serait bien que l’export PDF garde les dépendances.  Ça marchait avant !";

describe("citationVerifiee", () => {
  it("accepte une citation présente mot pour mot", () => {
    expect(citationVerifiee("l'export PDF garde les dépendances", TEXTE)).toBe(true);
  });
  it("tolère les apostrophes typographiques et les espaces multiples", () => {
    expect(citationVerifiee("dépendances. Ça marchait avant", TEXTE)).toBe(true);
  });
  it("refuse une citation reformulée ou inventée", () => {
    expect(citationVerifiee("l'export PDF perd les dépendances", TEXTE)).toBe(false);
  });
  it("respecte la casse", () => {
    expect(citationVerifiee("L'EXPORT PDF", TEXTE)).toBe(false);
  });
  it("refuse une citation trop courte pour prouver quoi que ce soit", () => {
    expect(citationVerifiee("PD", TEXTE)).toBe(false);
  });
});

describe("empreinteFeedback", () => {
  it("donne la même empreinte malgré des différences d'espaces ou de casse", () => {
    const a = empreinteFeedback({ compteId: "C1", canal: "email", texte: "Mode sombre  svp" });
    const b = empreinteFeedback({ compteId: "C1", canal: "email", texte: "mode sombre svp" });
    expect(a).toBe(b);
  });
  it("distingue deux comptes qui écrivent la même chose", () => {
    const a = empreinteFeedback({ compteId: "C1", canal: "email", texte: "Mode sombre svp" });
    const b = empreinteFeedback({ compteId: "C2", canal: "email", texte: "Mode sombre svp" });
    expect(a).not.toBe(b);
  });
});

describe("demandesExploitables", () => {
  const base: Extraction = {
    feedbackId: "F1",
    nature: "bug",
    injectionSuspectee: false,
    menaceDepart: false,
    demandes: [
      { resume: "Export PDF sans dépendances", citation: "l'export PDF garde les dépendances", regression: true },
      { resume: "Citation inventée", citation: "le PDF est cassé depuis la v3", regression: false },
    ],
  };

  it("garde les demandes à citation vérifiée et rejette les autres", () => {
    const r = demandesExploitables(base, TEXTE);
    expect(r.exploitables).toHaveLength(1);
    expect(r.rejetees).toEqual([{ resume: "Citation inventée", raison: "citation_introuvable" }]);
  });

  it("ne laisse rien passer d'un feedback suspect, même avec une citation exacte", () => {
    const r = demandesExploitables({ ...base, injectionSuspectee: true }, TEXTE);
    expect(r.exploitables).toHaveLength(0);
    expect(r.rejetees.every((d) => d.raison === "feedback_suspect")).toBe(true);
  });
});
