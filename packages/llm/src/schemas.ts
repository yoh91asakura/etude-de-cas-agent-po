import { z } from "zod";

/** Schémas des sorties structurées. Le modèle ne peut répondre qu'à travers eux. */

export const SchemaExtraction = z.object({
  nature: z.enum(["demande", "bug", "compliment", "question", "bruit", "suspect"]),
  injection_suspectee: z.boolean(),
  menace_depart: z.boolean(),
  demandes: z.array(
    z.object({
      resume: z.string(),
      citation: z.string(),
      regression: z.boolean(),
    }),
  ),
});

export const SchemaRattachement = z.object({
  item_id: z.string().nullable(),
  verdict: z.enum(["meme_besoin", "different", "incertain"]),
  /** En cas d'hésitation : les éléments entre lesquels le modèle hésite. */
  candidats_plausibles: z.array(z.string()),
  justification: z.string(),
});

export const SchemaImpact = z.object({
  impact: z.enum(["0.25", "0.5", "1", "2", "3"]),
  justification: z.string(),
  citations: z.array(z.string()),
});

export const SchemaComplexite = z.object({
  complexite: z.enum(["S", "M", "L", "XL"]),
  justification: z.string(),
});

export const SchemaStory = z.object({
  en_tant_que: z.string(),
  je_veux: z.string(),
  afin_de: z.string(),
  criteres: z.array(z.object({ etant_donne: z.string(), quand: z.string(), alors: z.string() })),
  cas_limites: z.array(z.string()),
  complexite: z.enum(["S", "M", "L", "XL"]),
  citations: z.array(z.string()),
});

export const SchemaJugementStory = z.object({
  independante: z.boolean(),
  valeur: z.boolean(),
  estimable: z.boolean(),
  petite: z.boolean(),
  testable: z.boolean(),
  un_seul_besoin: z.boolean(),
  commentaire: z.string(),
});

export type JugementStory = z.infer<typeof SchemaJugementStory>;

/** Découpage d'une story trop grosse : 2 à 4 stories plus petites. Le nombre est contrôlé par le code. */
export const SchemaDecoupage = z.object({
  stories: z.array(SchemaStory),
  justification: z.string(),
});

export const SchemaRevue = z.object({
  fusions: z.array(
    z.object({
      item_a: z.string(),
      item_b: z.string(),
      explication: z.string(),
    }),
  ),
  regles: z.array(
    z.object({
      item_id: z.string(),
      mots_cles: z.array(z.string()),
      reponses_sources: z.array(z.string()),
      texte: z.string(),
    }),
  ),
});

export const SchemaRegleRattachement = z.object({
  mots_cles: z.array(z.string()),
  texte: z.string(),
});
