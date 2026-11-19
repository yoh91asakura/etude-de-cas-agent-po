import { describe, expect, it } from "vitest";
import { analyserTirages, analyserVerdicts, detecterTendance, etatApresResume, proposerMoscow, selectionnerQuestions } from "../src/index.ts";
import { ilYa, MAINTENANT } from "./fixtures.ts";

describe("detecterTendance", () => {
  it("détecte le motif M5 : 2 demandes anciennes, 7 sur les deux dernières semaines", () => {
    const dates = [ilYa(35), ilYa(25), ...[1, 2, 4, 6, 8, 10, 12].map(ilYa)];
    const r = detecterTendance(dates, MAINTENANT);
    expect(r).toEqual({ recent: 7, precedent: 1, tendance: true });
  });
  it("ne voit pas de tendance dans un flux stable", () => {
    const dates = [ilYa(3), ilYa(9), ilYa(16), ilYa(22), ilYa(26)];
    expect(detecterTendance(dates, MAINTENANT).tendance).toBe(false);
  });
  it("exige un minimum d'occurrences récentes, même sans historique", () => {
    expect(detecterTendance([ilYa(2), ilYa(3)], MAINTENANT).tendance).toBe(false);
  });
});

describe("analyserTirages", () => {
  it("retient la médiane et ne doute pas quand les tirages sont proches", () => {
    expect(analyserTirages([2, 2, 3, 2, 1])).toEqual({ mediane: 2, ecartCrans: 2, doute: true });
    expect(analyserTirages([2, 2, 3, 2, 2])).toEqual({ mediane: 2, ecartCrans: 1, doute: false });
  });
  it("refuse une valeur hors de l'échelle RICE", () => {
    expect(() => analyserTirages([1.5])).toThrow(/hors échelle/);
  });
});

describe("analyserVerdicts", () => {
  it("ne tranche que sur un accord unanime", () => {
    expect(analyserVerdicts(["meme_besoin", "meme_besoin", "meme_besoin"])).toEqual({ verdict: "meme_besoin", doute: false });
    expect(analyserVerdicts(["meme_besoin", "different", "meme_besoin"])).toEqual({ verdict: "incertain", doute: true });
    expect(analyserVerdicts(["incertain", "incertain", "incertain"]).doute).toBe(true);
  });
});

describe("selectionnerQuestions", () => {
  const q = (id: string, enjeu: number, urgente = false) => ({ id, enjeu, urgente });
  it("laisse partir les urgences et plafonne le reste en triant par enjeu", () => {
    const r = selectionnerQuestions([q("a", 1), q("b", 9), q("u", 0, true), q("c", 5)], 3);
    expect(r.aPoser.map((x) => x.id)).toEqual(["u", "b", "c"]);
    expect(r.enAttente.map((x) => x.id)).toEqual(["a"]);
  });
});

describe("etatApresResume", () => {
  it("relance une fois une question sans réponse, puis la fait expirer", () => {
    const une = etatApresResume({ etat: "ouverte", relances: 0 });
    expect(une).toEqual({ etat: "relancee", relances: 1 });
    expect(etatApresResume(une)).toEqual({ etat: "expiree", relances: 1 });
    expect(etatApresResume({ etat: "repondue", relances: 0 }).etat).toBe("repondue");
  });
});

describe("proposerMoscow", () => {
  it("met en Must les régressions payantes et les risques de départ, puis remplit selon la capacité", () => {
    const r = proposerMoscow([
      { itemId: "bug", score: 1, effort: 1, regressionPayante: true, risqueDepartBusiness: false },
      { itemId: "sso", score: 2, effort: 1, regressionPayante: false, risqueDepartBusiness: true },
      { itemId: "gros", score: 9, effort: 4, regressionPayante: false, risqueDepartBusiness: false },
      { itemId: "moyen", score: 5, effort: 2, regressionPayante: false, risqueDepartBusiness: false },
      { itemId: "petit", score: 3, effort: 0.5, regressionPayante: false, risqueDepartBusiness: false },
    ]);
    const cat = Object.fromEntries(r.map((p) => [p.itemId, p.categorie]));
    // Capacité 6 : Must 2 → gros (6) Should → moyen (8) Could → petit (8.5) Could ; seuil Could = 9
    expect(cat).toEqual({ bug: "must", sso: "must", gros: "should", moyen: "could", petit: "could" });
  });
});
