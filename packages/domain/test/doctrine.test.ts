import { describe, expect, it } from "vitest";
import { activerRegle, ajusterImpact, appliquerRattachement, fusionInterdite, proposerRegle, reviserRegle, verifierDoctrine } from "../src/index.ts";
import type { Regle } from "../src/index.ts";
import { MAINTENANT } from "./fixtures.ts";

const reponsePO = { id: "R1", auteur: "po" };

function regleRattachement(id: string, motsCles: string[], itemId: string): Regle {
  const r = proposerRegle({ id, reponse: reponsePO, contenu: { type: "rattachement", motsCles, itemId }, texte: `${motsCles.join("/")} → ${itemId}`, maintenant: MAINTENANT });
  return activerRegle(r, [], MAINTENANT).regle;
}

describe("proposerRegle", () => {
  it("refuse toute règle qui ne vient pas d'une réponse du PO", () => {
    expect(() =>
      proposerRegle({ id: "X", reponse: { id: "F9", auteur: "client" }, contenu: { type: "paire_distincte", itemA: "B02", itemB: "B03" }, texte: "", maintenant: MAINTENANT }),
    ).toThrow(/réponse du PO/);
  });
  it("crée une règle proposée, donc inactive tant que le PO ne l'a pas validée", () => {
    const r = proposerRegle({ id: "D1", reponse: reponsePO, contenu: { type: "paire_distincte", itemA: "B02", itemB: "B03" }, texte: "SSO ≠ permissions", maintenant: MAINTENANT });
    expect(r.statut).toBe("proposee");
    expect(fusionInterdite("B02", "B03", [r])).toBeUndefined();
  });
  it("rejette un contenu incohérent", () => {
    expect(() => proposerRegle({ id: "D", reponse: reponsePO, contenu: { type: "ajustement_impact", plan: "business", alignementObjectif: true, crans: 5 }, texte: "", maintenant: MAINTENANT })).toThrow();
  });
});

describe("activerRegle", () => {
  it("refuse d'activer une règle qui contredit une règle active", () => {
    const existante = regleRattachement("D1", ["Okta", "SSO"], "B03");
    const nouvelle = proposerRegle({ id: "D2", reponse: reponsePO, contenu: { type: "rattachement", motsCles: ["okta"], itemId: "B02" }, texte: "", maintenant: MAINTENANT });
    const r = activerRegle(nouvelle, [existante], MAINTENANT);
    expect(r.regle.statut).toBe("proposee");
    expect(r.contradictions[0]).toMatch(/okta/);
  });
});

describe("appliquerRattachement", () => {
  const regles = [regleRattachement("D1", ["Okta", "Entra ID", "SAML"], "B03")];
  it("rattache de façon déterministe et cite la règle", () => {
    expect(appliquerRattachement("On voudrait se connecter via Entra ID", regles)).toEqual({ itemId: "B03", regleId: "D1" });
  });
  it("ne se déclenche pas sur un mot qui en contient un autre", () => {
    expect(appliquerRattachement("Le rapport de oktaèdre est faux", regles)).toBeNull();
  });
  it("s'abstient si deux règles désignent des items différents", () => {
    const deux = [...regles, regleRattachement("D2", ["permissions"], "B02")];
    expect(appliquerRattachement("SAML et permissions par projet", deux)).toBeNull();
  });
});

describe("verifierDoctrine (non-régression par règle)", () => {
  it("vérifie que chaque règle rattache encore son cas d'origine", () => {
    const sso = regleRattachement("D1", ["Okta"], "B03");
    const cas = [{ regleId: "D1", texte: "Connexion via Okta possible ?", itemAttendu: "B03" }];
    expect(verifierDoctrine([sso], cas)).toEqual([]);
  });
  it("détecte une nouvelle règle qui casserait le cas d'origine d'une règle existante", () => {
    const sso = regleRattachement("D1", ["Okta"], "B03");
    const trop = regleRattachement("D2", ["connexion"], "B02");
    const cas = [{ regleId: "D1", texte: "Connexion via Okta possible ?", itemAttendu: "B03" }];
    // « connexion » et « Okta » désignent deux items : le cas de D1 devient ambigu.
    expect(verifierDoctrine([sso, trop], cas)).toEqual([{ ...cas[0], obtenu: null }]);
  });
});

describe("reviserRegle", () => {
  it("crée une nouvelle version et retire l'ancienne", () => {
    const v1 = regleRattachement("D1", ["Okta"], "B03");
    const { ancienne, nouvelle } = reviserRegle({ regle: v1, reponse: { id: "R2", auteur: "po" }, contenu: { type: "rattachement", motsCles: ["Okta", "SAML"], itemId: "B03" }, texte: "v2", maintenant: MAINTENANT });
    expect(ancienne.statut).toBe("retiree");
    expect(nouvelle).toMatchObject({ id: "D1", version: 2, statut: "proposee", sourceReponseId: "R2" });
  });
});

describe("ajusterImpact", () => {
  it("applique les ajustements actifs dont la condition est remplie", () => {
    const r = activerRegle(
      proposerRegle({ id: "D3", reponse: reponsePO, contenu: { type: "ajustement_impact", plan: "business", alignementObjectif: true, crans: 1 }, texte: "Business + objectif : +1 cran", maintenant: MAINTENANT }),
      [],
      MAINTENANT,
    ).regle;
    expect(ajusterImpact(2, { plans: new Set(["business"]), alignementObjectif: true }, [r])).toEqual({ index: 3, reglesAppliquees: ["D3"] });
    expect(ajusterImpact(2, { plans: new Set(["pro"]), alignementObjectif: true }, [r]).index).toBe(2);
  });
});
