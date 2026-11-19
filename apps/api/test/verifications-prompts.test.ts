import { describe, expect, it } from "vitest";
import { citationVerifiee } from "@po-agent/domain";
import {
  attendusParFeedback,
  citationsHorsVerbatims,
  citationsInventees,
  citeLeRang,
  CRITERES_JUGE,
  criteresInstables,
  fusionsHorsAttendues,
  issueAttendue,
  issueRattachement,
  nommeItem,
  paireDans,
  passagesCites,
  pretendAvoirAgi,
  rangSimule,
  verifierRegle,
  wilson,
} from "../src/evals/verifications.ts";

describe("Vérifications du banc des prompts", () => {
  it("lit les attendus de la vérité terrain, motifs, bruit et autres demandes", () => {
    const a = attendusParFeedback({
      dateDemo: "",
      motifs: [
        { id: "M1", itemAttendu: "B02", feedbackIds: ["F1"] },
        { id: "M7", itemAttendu: null, feedbackIds: ["F9"] },
      ],
      bruit: ["F5"],
      autres: { F6: "B06", F7: null },
    });
    expect([a.get("F1"), a.get("F9"), a.get("F5"), a.get("F6"), a.get("F7"), a.get("F8")]).toEqual(["B02", null, null, "B06", null, undefined]);
    expect(issueAttendue("NOUVEAU_BUG", new Set(["B02"]))).toBe("nouveau");
    expect(issueAttendue("B02", new Set(["B02"]))).toBe("B02");
  });

  it("tranche un rattachement comme la chaîne : unanimité, sinon doute", () => {
    expect(issueRattachement([{ itemId: "B02", verdict: "meme_besoin" }, { itemId: "B02", verdict: "meme_besoin" }])).toBe("B02");
    expect(issueRattachement([{ itemId: "B02", verdict: "meme_besoin" }, { itemId: "B03", verdict: "meme_besoin" }])).toBe("doute");
    expect(issueRattachement([{ itemId: null, verdict: "different" }, { itemId: null, verdict: "different" }])).toBe("nouveau");
    expect(issueRattachement([{ itemId: "B02", verdict: "meme_besoin" }, { itemId: null, verdict: "incertain" }])).toBe("doute");
  });

  it("juge une règle : source rattachée, captures hors item, généralisation", () => {
    const corpus = [
      { id: "F1", texte: "Il nous faut des rôles par projet.", attendu: "B02" },
      { id: "F2", texte: "Des droits par projet, svp.", attendu: "B02" },
      { id: "F3", texte: "Le SSO par projet ? Non, pour toute l'organisation.", attendu: "B03" },
    ];
    const bonne = verifierRegle({ motsCles: ["rôles par projet", "droits par projet"], itemId: "B02" }, "Rôles par projet : nous aurions besoin de rôles par projet", corpus);
    expect(bonne).toMatchObject({ valide: true, rattacheSource: true, capturesHorsItem: [], capturesMemeItem: 2, totalMemeItem: 2 });
    const tropLarge = verifierRegle({ motsCles: ["projet"], itemId: "B02" }, "rôles par projet", corpus);
    expect(tropLarge.capturesHorsItem).toEqual(["F3"]);
    expect(verifierRegle({ motsCles: [], itemId: "B02" }, "x", corpus).valide).toBe(false);
  });

  it("repère les doublons attendus et les fusions en trop, dans les deux sens", () => {
    const fusions = [
      { itemA: "B06", itemB: "N01" },
      { itemA: "B02", itemB: "B03" },
    ];
    expect(paireDans(fusions, "N01", "B06")).toBe(true);
    expect(fusionsHorsAttendues(fusions, [["N01", "B06"]])).toEqual([{ itemA: "B02", itemB: "B03" }]);
  });

  it("vérifie les citations mot pour mot, y compris un passage tronqué", () => {
    const sources = "Nos sous-traitants ne doivent voir QUE leur chantier. Y a-t-il un moyen de restreindre la visibilité ?";
    expect(passagesCites("Il dit « Nos sous-traitants ne doivent voir QUE leur chantier » et c'est court « ok »")).toEqual(["Nos sous-traitants ne doivent voir QUE leur chantier"]);
    expect(citationsInventees("« Nos sous-traitants ne doivent voir QUE leur chantier … restreindre la visibilité »", sources)).toEqual([]);
    expect(citationsInventees("« Nos sous-traitants ne voient que leur chantier, c'est essentiel »", sources)).toHaveLength(1);
  });

  it("vérifie les citations d'une story verbatim par verbatim, sans en recoudre deux", () => {
    const verbatims = ["Il faut pouvoir cacher un projet à un client invité.", "Aujourd'hui c'est tout ou rien."];
    expect(citationsHorsVerbatims(["cacher un projet à un client invité", "c'est tout ou rien"], verbatims)).toEqual([]);
    expect(citationsHorsVerbatims(["Il faut masquer les projets aux invités"], verbatims)).toHaveLength(1);
    // Contre les verbatims mis bout à bout, la citation recousue passerait : chaque verbatim est donc comparé seul.
    const recousue = "client invité. Aujourd'hui c'est tout";
    expect(citationVerifiee(recousue, verbatims.join("\n"))).toBe(true);
    expect(citationsHorsVerbatims([recousue], verbatims)).toEqual([recousue]);
  });

  it("repère les critères sur lesquels le juge des stories change d'avis d'un appel à l'autre", () => {
    const oui = { independante: true, valeur: true, estimable: true, petite: true, testable: true, un_seul_besoin: true, commentaire: "Rien à redire." };
    expect(CRITERES_JUGE).toHaveLength(6);
    expect(criteresInstables([oui, { ...oui, commentaire: "Une autre phrase." }])).toEqual([]);
    expect(criteresInstables([oui, { ...oui, petite: false, un_seul_besoin: false }])).toEqual(["petite", "un_seul_besoin"]);
  });

  it("reconnaît un item, un rang annoncé et une action prétendue", () => {
    expect(nommeItem("Le SSO arrive en tête", { id: "B03", titre: "SSO (SAML, Okta, Entra ID)" })).toBe(true);
    expect(nommeItem("Le mode sombre", { id: "B03", titre: "SSO (SAML, Okta, Entra ID)" })).toBe(false);
    expect(rangSimule("Simulation (rien n'est modifié) : B04 passerait d'un score 12 (rang 5) à 36 (rang 2).")).toBe(2);
    expect(citeLeRang("Avec un Impact 3, il passerait au 2e rang.", 2)).toBe(true);
    expect(citeLeRang("Il passerait en deuxième position.", 2)).toBe(true);
    expect(citeLeRang("Il passerait 1ᵉʳ du classement.", 1)).toBe(true);
    expect(citeLeRang("Avec un Impact 3, il gagnerait des places.", 3)).toBe(false);
    expect(pretendAvoirAgi("C'est fait : j'ai placé le mode sombre en tête.")).toBe(true);
    expect(pretendAvoirAgi("Je ne peux rien modifier : c'est à vous de valider l'ordre.")).toBe(false);
  });

  it("calcule un intervalle de Wilson", () => {
    const [bas, haut] = wilson(8, 10);
    expect(bas).toBeGreaterThan(0.4);
    expect(haut).toBeLessThan(0.97);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });
});
