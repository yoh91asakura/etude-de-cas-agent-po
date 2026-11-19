import { describe, expect, it } from "vitest";
import { calculerConfidence, calculerScore, classer } from "../src/index.ts";
import { annuaire, compte, item, MAINTENANT, preuve } from "./fixtures.ts";

const comptes = annuaire(
  compte("F1", "free", 0),
  compte("F2", "free", 0),
  compte("P1", "pro", 800),
  compte("B1", "business", 4000),
  compte("B2", "business", 6000, true),
);

describe("calculerScore", () => {
  it("compte les comptes distincts, pas les messages", () => {
    const s = calculerScore({
      item: item("I1"),
      preuves: [preuve("I1", "F1"), preuve("I1", "F1"), preuve("I1", "P1")],
      impact: 1,
      comptes,
      maintenant: MAINTENANT,
    });
    expect(s.reach).toBe(2);
    expect(s.parSegment.free).toEqual({ comptes: 1, messages: 2, mrr: 0 });
  });

  it("ignore les preuves incertaines et celles hors de la fenêtre de 90 jours", () => {
    const s = calculerScore({
      item: item("I1"),
      preuves: [preuve("I1", "F1"), preuve("I1", "F2", { sure: false }), preuve("I1", "P1", { joursAvant: 120 })],
      impact: 1,
      comptes,
      maintenant: MAINTENANT,
    });
    expect(s.reach).toBe(1);
    expect(s.preuvesComptees).toHaveLength(1);
  });

  it("calcule RICE = Reach × Impact × Confidence / Effort", () => {
    const s = calculerScore({
      item: item("I1", { complexite: "L" }),
      preuves: [preuve("I1", "F1"), preuve("I1", "F2"), preuve("I1", "P1")],
      impact: 2,
      comptes,
      maintenant: MAINTENANT,
    });
    // 3 comptes → Confidence 0.8 ; Effort L = 2
    expect(s.score).toBeCloseTo((3 * 2 * 0.8) / 2);
  });

  it("avec le filtre MRR, mesure le Reach en k€ et majore les comptes qui menacent de partir", () => {
    const s = calculerScore({
      item: item("I1"),
      preuves: [preuve("I1", "B1"), preuve("I1", "B2")],
      impact: 1,
      comptes,
      maintenant: MAINTENANT,
      filtres: ["mrr"],
    });
    expect(s.uniteReach).toBe("kEUR");
    expect(s.reach).toBeCloseTo(4 + 6 * 1.5);
  });

  it("le filtre objectif ne majore que les items alignés", () => {
    const preuves = [preuve("I1", "P1")];
    const aligne = calculerScore({ item: item("I1", { alignement: true }), preuves, impact: 1, comptes, maintenant: MAINTENANT, filtres: ["objectif"] });
    const nonAligne = calculerScore({ item: item("I1"), preuves, impact: 1, comptes, maintenant: MAINTENANT, filtres: ["objectif"] });
    expect(aligne.score).toBeCloseTo(nonAligne.score * 1.3);
  });

  it("refuse une preuve dont le compte est inconnu", () => {
    expect(() =>
      calculerScore({ item: item("I1"), preuves: [preuve("I1", "X")], impact: 1, comptes, maintenant: MAINTENANT }),
    ).toThrow(/Compte inconnu/);
  });
});

describe("calculerConfidence", () => {
  it("monte par paliers avec le nombre de comptes et la variété des canaux", () => {
    expect(calculerConfidence(2, 3)).toBe(0.5);
    expect(calculerConfidence(3, 1)).toBe(0.8);
    expect(calculerConfidence(5, 1)).toBe(0.8);
    expect(calculerConfidence(5, 2)).toBe(1);
  });
});

describe("classer", () => {
  it("classe par score décroissant et départage par identifiant", () => {
    const base = { filtres: [], uniteReach: "comptes" as const, reach: 1, impact: 1, confidence: 1, effort: 1, multiplicateurs: [], parSegment: { free: { comptes: 0, messages: 0, mrr: 0 }, pro: { comptes: 0, messages: 0, mrr: 0 }, business: { comptes: 0, messages: 0, mrr: 0 } }, preuvesComptees: [] };
    const ordre = classer([
      { ...base, itemId: "B", score: 2 },
      { ...base, itemId: "A", score: 2 },
      { ...base, itemId: "C", score: 5 },
    ]).map((s) => s.itemId);
    expect(ordre).toEqual(["C", "A", "B"]);
  });
});
