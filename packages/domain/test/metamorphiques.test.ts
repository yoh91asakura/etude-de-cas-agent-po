import { describe, expect, it } from "vitest";
import { calculerScore, classer, decrireEcart, expliquerEcart, mouvementsTop } from "../src/index.ts";
import type { Preuve } from "../src/index.ts";
import { annuaire, compte, item, MAINTENANT, preuve } from "./fixtures.ts";

/**
 * Tests métamorphiques : on transforme les entrées d'une façon dont on connaît l'effet attendu,
 * et on vérifie que le score réagit dans le bon sens. Ils valent pour le code déterministe ;
 * les mêmes relations seront reprises dans les évaluations de la chaîne avec le LLM.
 */

const comptes = annuaire(
  compte("F1", "free", 0),
  compte("F2", "free", 0),
  compte("P1", "pro", 900),
  compte("B1", "business", 5000),
);
const I = item("I1", { complexite: "M", alignement: true });

function score(preuves: Preuve[], filtres: Array<"mrr" | "objectif"> = []) {
  return calculerScore({ item: I, preuves, impact: 2, comptes, maintenant: MAINTENANT, filtres });
}

describe("relations métamorphiques du scoring", () => {
  const base = [preuve("I1", "F1"), preuve("I1", "P1", { canal: "email" }), preuve("I1", "F2")];

  it("un feedback en double (même feedback) ne change rien", () => {
    const doublon = { ...(base[0] as Preuve), id: "P-doublon" };
    expect(score([...base, doublon]).score).toBe(score(base).score);
  });

  it("un second message d'un compte déjà compté ne change pas le Reach, seulement le volume", () => {
    const s = score([...base, preuve("I1", "F1")]);
    expect(s.reach).toBe(score(base).reach);
    expect(s.parSegment.free.messages).toBe(score(base).parSegment.free.messages + 1);
  });

  it("l'ordre d'arrivée des preuves ne change pas le score", () => {
    expect(score([...base].reverse()).score).toBe(score(base).score);
  });

  it("ajouter une preuve d'un nouveau compte ne fait jamais baisser le score, quel que soit le filtre", () => {
    const plus = [...base, preuve("I1", "B1")];
    for (const filtres of [[], ["mrr"], ["objectif"], ["mrr", "objectif"]] as const) {
      expect(score(plus, [...filtres]).score).toBeGreaterThanOrEqual(score(base, [...filtres]).score);
    }
  });

  it("une preuve incertaine ne compte pas", () => {
    expect(score([...base, preuve("I1", "B1", { sure: false })]).score).toBe(score(base).score);
  });
});

describe("explication des écarts", () => {
  it("attribue l'écart aux facteurs et aux nouvelles preuves", () => {
    const existantes = [preuve("I1", "F1"), preuve("I1", "F2")];
    const avant = score(existantes);
    const nouvelle = preuve("I1", "P1", { canal: "email" });
    const apres = score([...existantes, nouvelle]);
    const e = expliquerEcart(avant, apres);
    expect(e.causes.map((c) => c.facteur)).toEqual(["reach", "confidence"]);
    expect(e.nouvellesPreuves).toHaveLength(1);
    expect(decrireEcart(e)).toMatch(/Reach 2 → 3 ; Confidence 0.5 → 0.8 ; 1 nouvelle preuve/);
  });

  it("repère les entrées et sorties du top", () => {
    expect(mouvementsTop(["a", "b", "c", "d"], ["a", "d", "b", "c"], 2)).toEqual({ entrees: ["d"], sorties: ["b"] });
  });

  it("le classement reste déterministe", () => {
    const s1 = score([preuve("I1", "F1")]);
    expect(classer([s1, { ...s1, itemId: "I0" }]).map((s) => s.itemId)).toEqual(["I0", "I1"]);
  });
});
