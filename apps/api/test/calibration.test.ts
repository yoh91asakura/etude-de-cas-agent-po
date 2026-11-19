import { describe, expect, it } from "vitest";
import { accord } from "../src/calibrer-juge.ts";

describe("accord entre le juge et l'humain", () => {
  it("vaut 1 en accord parfait, avec un kappa de 1", () => {
    expect(accord([true, false, true, false], [true, false, true, false])).toEqual({ accord: 1, kappa: 1 });
  });
  it("corrige l'accord dû au hasard : un juge qui dit toujours oui n'a pas de kappa positif", () => {
    const r = accord([true, true, true, false], [true, true, true, true]);
    expect(r.accord).toBe(0.75);
    expect(r.kappa).toBe(0);
  });
  it("refuse des séries de longueurs différentes", () => {
    expect(() => accord([true], [true, false])).toThrow();
  });
});
