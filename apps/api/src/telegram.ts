/**
 * Canal Telegram, optionnel : il ne s'active que si ses jetons sont configurés (cadrage, validation finale).
 * Sans lui, les questions et les réponses passent par la boîte de l'application.
 *
 * Implémentation sur l'API Bot officielle (https://core.telegram.org/bots/api) : réception par getUpdates
 * (long polling, sans URL publique), boutons en inline_keyboard, acquittement par answerCallbackQuery.
 * Le cadrage prévoyait Chat SDK ; son acquittement des clics n'étant pas documenté et non vérifiable sans jeton,
 * le canal est derrière l'interface CanalPO pour pouvoir changer d'implémentation (Chat SDK, Teams, Slack).
 *
 * Au démarrage, chaque bot est vérifié (getMe) et ce que Telegram a gardé pendant l'arrêt de l'API est écarté.
 * Chaque erreur de l'API Bot est écrite dans le terminal : une panne du canal ne doit pas passer en silence.
 */

export interface QuestionPourCanal {
  id: string;
  enonce: string;
  options: Array<{ valeur: string; libelle: string }>;
  urgente: boolean;
  citation?: string | null;
  /** Le contexte complet (client, message, lectures de l'agent, effet de chaque réponse) : prioritaire sur la citation. */
  contexte?: string | null;
}

export interface CanalPO {
  readonly nom: string;
  envoyerQuestion(q: QuestionPourCanal): Promise<void>;
  envoyerMessage(texte: string): Promise<void>;
  /** Propose au PO de valider ou rejeter une règle de doctrine née de sa réponse. */
  envoyerRegle(regle: { id: string; texte: string; motsCles?: string[] }): Promise<void>;
  demarrer(): void;
  arreter(): void;
}

type Fetch = typeof fetch;

/** Où le canal écrit ce qui lui arrive : le terminal de l'API par défaut, un collecteur dans les tests. */
export type Journal = (message: string) => void;
export const journalConsole: Journal = (message) => console.log(message);

interface MiseAJour {
  update_id: number;
  message?: { chat: { id: number }; from?: { id: number }; text?: string };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { chat: { id: number }; message_id: number } };
}

type AppelTelegram = <T = unknown>(methode: string, corps: Record<string, unknown>) => Promise<T>;

/** Client minimal de l'API Bot. */
export function clientTelegram(jeton: string, f: Fetch = fetch, base = "https://api.telegram.org"): AppelTelegram {
  return async <T = unknown>(methode: string, corps: Record<string, unknown>): Promise<T> => {
    const r = await f(`${base}/bot${jeton}/${methode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps) });
    const json = (await r.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(`Telegram ${methode} : ${json.description ?? r.status}`);
    return json.result as T;
  };
}

/** Le message d'erreur de l'API Bot, suivi du geste qui la corrige quand on le connaît. */
export function expliquerErreurTelegram(e: unknown): string {
  const brut = e instanceof Error ? e.message : String(e);
  if (/Unauthorized/i.test(brut)) return `${brut}. Le jeton est refusé : vérifiez-le auprès de @BotFather.`;
  if (/terminated by other getUpdates/i.test(brut)) return `${brut}. Un autre processus lit déjà ce bot (une seconde API, Docker Compose) : arrêtez-le.`;
  if (/chat not found|can't initiate conversation|bot was blocked/i.test(brut)) return `${brut}. Envoyez /start au bot depuis ce compte Telegram.`;
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(brut)) return `${brut}. Telegram est injoignable : nouvel essai dans quelques secondes. Le cockpit reste la référence.`;
  return brut;
}

/**
 * La boucle de réception d'un bot. Avant la première lecture, et tant qu'elle n'a pas réussi :
 * - getMe vérifie le jeton ;
 * - deleteWebhook avec drop_pending_updates écarte ce que Telegram a gardé pendant l'arrêt de l'API (jusqu'à 24 h) :
 *   un essai envoyé au bot support la veille n'arrive pas dans la démo, et un webhook oublié ne bloque pas getUpdates.
 * Une erreur de réception est écrite une fois, jusqu'à ce qu'elle change ou que la réception reprenne.
 */
function recevoir(o: {
  appel: AppelTelegram;
  /** Le nom du bot dans le terminal. */
  nom: string;
  types: string[];
  traiter: (m: MiseAJour) => Promise<void>;
  /** Contrôles propres au bot, une fois le jeton vérifié : ils signalent, ils n'empêchent pas la réception. */
  verifier?: () => Promise<void>;
  journal: Journal;
  delaiReessaiMs: number;
}): { demarrer: () => void; arreter: () => void } {
  let actif = false;
  let pret = false;
  let decalage = 0;
  let erreur: string | null = null;

  const boucle = async () => {
    while (actif) {
      try {
        if (!pret) {
          const bot = await o.appel<{ username?: string }>("getMe", {});
          await o.appel("deleteWebhook", { drop_pending_updates: true });
          pret = true;
          erreur = null;
          o.journal(`Telegram, ${o.nom} : @${bot.username ?? "?"} joignable. Les messages reçus pendant l'arrêt de l'API sont écartés.`);
          await o.verifier?.();
        }
        const maj = await o.appel<MiseAJour[]>("getUpdates", { offset: decalage, timeout: 30, allowed_updates: o.types });
        if (erreur) {
          o.journal(`Telegram, ${o.nom} : réception rétablie.`);
          erreur = null;
        }
        for (const m of maj) {
          decalage = m.update_id + 1;
          await o.traiter(m).catch((e) => o.journal(`Telegram, ${o.nom} : un message n'a pas été traité. ${expliquerErreurTelegram(e)}`));
        }
      } catch (e) {
        const texte = expliquerErreurTelegram(e);
        if (texte !== erreur) o.journal(`Telegram, ${o.nom} : ${texte}`);
        erreur = texte;
        await new Promise((r) => setTimeout(r, o.delaiReessaiMs));
      }
    }
  };

  return {
    demarrer() {
      if (actif) return;
      actif = true;
      void boucle();
    },
    arreter() {
      actif = false;
    },
  };
}

/** Données de bouton : « r:<question>:<index> », bien sous la limite de 64 octets de Telegram. */
export function donneesBouton(questionId: string, index: number): string {
  const d = `r:${questionId}:${index}`;
  if (Buffer.byteLength(d, "utf8") > 64) throw new Error("callback_data trop long");
  return d;
}

export function lireDonneesBouton(d: string | undefined): { questionId: string; index: number } | null {
  const m = d?.match(/^r:([A-Za-z0-9_-]+):(\d+)$/);
  return m ? { questionId: m[1]!, index: Number(m[2]) } : null;
}

/** Données d'un bouton de décision sur une règle : « g:<règle>:1 » (valider) ou « g:<règle>:0 » (rejeter). */
export function lireDecisionRegle(d: string | undefined): { regleId: string; accepter: boolean } | null {
  const m = d?.match(/^g:([A-Za-z0-9_-]+):([01])$/);
  return m ? { regleId: m[1]!, accepter: m[2] === "1" } : null;
}

export interface OptionsTelegram {
  jeton: string;
  /** Identifiants Telegram autorisés (liste blanche). Un message d'un inconnu est ignoré. */
  autorises: string[];
  /** Le PO a cliqué : renvoie le texte de confirmation. */
  surReponse: (questionId: string, index: number) => Promise<string>;
  /** Le PO a écrit un message libre : renvoie la réponse de l'agent conversationnel. */
  surMessage: (texte: string) => Promise<string>;
  /** Le PO valide ou rejette une règle : renvoie le texte de confirmation. */
  surDecisionRegle: (regleId: string, accepter: boolean) => Promise<string>;
  fetch?: Fetch;
  journal?: Journal;
  delaiReessaiMs?: number;
}

export function canalTelegram(o: OptionsTelegram): CanalPO & { traiter: (m: MiseAJour) => Promise<void> } {
  const appel = clientTelegram(o.jeton, o.fetch);
  const autorises = new Set(o.autorises.map(String));
  const journal = o.journal ?? journalConsole;

  const envoyerA = async (chatId: string, texte: string, boutons?: Array<Array<{ text: string; callback_data: string }>>) => {
    await appel("sendMessage", { chat_id: chatId, text: texte.slice(0, 4000), ...(boutons ? { reply_markup: { inline_keyboard: boutons } } : {}) });
  };

  // Un acquittement refusé ne doit pas empêcher de traiter la réponse ni d'envoyer la confirmation.
  const acquitter = (id: string, texte: string) =>
    appel("answerCallbackQuery", { callback_query_id: id, text: texte.slice(0, 190) }).catch((e) =>
      journal(`Telegram, bot du PO : clic non acquitté. ${expliquerErreurTelegram(e)}`),
    );

  const traiter = async (m: MiseAJour) => {
    if (m.callback_query) {
      const cq = m.callback_query;
      if (!autorises.has(String(cq.from.id))) {
        journal(`Telegram, bot du PO : clic ignoré du compte ${cq.from.id}, absent de TELEGRAM_ALLOWED_USERS.`);
        await acquitter(cq.id, "Accès réservé au PO.");
        return;
      }
      // Acquitter d'abord : répondre à une question de rattachement attend que le modèle formule la règle,
      // et Telegram refuse un acquittement trop tardif. Les boutons partent aussitôt : un second clic ne peut plus partir.
      await acquitter(cq.id, "Reçu : l'agent traite votre réponse.");
      if (cq.message) {
        // Purement visuel : si le retrait échoue, la question déjà close refusera le second clic.
        await appel("editMessageReplyMarkup", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      }
      const d = lireDonneesBouton(cq.data);
      const g = lireDecisionRegle(cq.data);
      let confirmation = "Réponse non reconnue.";
      try {
        if (d) confirmation = await o.surReponse(d.questionId, d.index);
        else if (g) confirmation = await o.surDecisionRegle(g.regleId, g.accepter);
      } catch (e) {
        confirmation = `Réponse refusée : ${e instanceof Error ? e.message : String(e)}`;
      }
      // Dans une conversation privée, l'identifiant de la conversation est celui du compte.
      await envoyerA(String(cq.message?.chat.id ?? cq.from.id), confirmation);
      return;
    }
    const msg = m.message;
    if (!msg?.text || !msg.from) return;
    if (!autorises.has(String(msg.from.id))) {
      // L'identifiant s'affiche dans le terminal : c'est aussi le moyen de le trouver pour TELEGRAM_ALLOWED_USERS.
      journal(`Telegram, bot du PO : message ignoré du compte ${msg.from.id}, absent de TELEGRAM_ALLOWED_USERS.`);
      return;
    }
    if (msg.text.startsWith("/start")) {
      await envoyerA(String(msg.chat.id), "Bonjour. Je vous enverrai ici les questions de l'agent et les alertes urgentes. Vous pouvez aussi me poser une question libre sur le backlog.");
      return;
    }
    await envoyerA(String(msg.chat.id), await o.surMessage(msg.text));
  };

  const reception = recevoir({
    appel,
    nom: "bot du PO",
    types: ["message", "callback_query"],
    traiter,
    journal,
    delaiReessaiMs: o.delaiReessaiMs ?? 5000,
    // Un bot ne peut pas ouvrir une conversation : chaque compte autorisé doit lui avoir écrit au moins une fois.
    verifier: async () => {
      if (autorises.size === 0) {
        journal("Telegram, bot du PO : TELEGRAM_ALLOWED_USERS est vide. Le bot n'enverra rien et ignorera tous les messages.");
        return;
      }
      for (const id of autorises) {
        await appel("getChat", { chat_id: id }).catch((e) => journal(`Telegram, bot du PO : le compte ${id} est injoignable. ${expliquerErreurTelegram(e)}`));
      }
    },
  });

  return {
    nom: "telegram",
    traiter,
    async envoyerQuestion(q) {
      const entete = q.urgente ? "Question urgente de l'agent" : "Question de l'agent";
      const detail = q.contexte ?? (q.citation ? `« ${q.citation} »` : "");
      const texte = `${entete}\n\n${q.enonce}${detail ? `\n\n${detail}` : ""}`.slice(0, 4000);
      const boutons = q.options.map((op, i) => [{ text: op.libelle.slice(0, 60), callback_data: donneesBouton(q.id, i) }]);
      for (const chat of autorises) await envoyerA(chat, texte, boutons);
    },
    async envoyerMessage(texte) {
      for (const chat of autorises) await envoyerA(chat, texte);
    },
    async envoyerRegle(regle) {
      const boutons = [[{ text: "Valider la règle", callback_data: `g:${regle.id}:1` }, { text: "Rejeter", callback_data: `g:${regle.id}:0` }]];
      // Ce sont les mots-clés qui agissent : le PO valide le comportement réel de la règle, pas seulement sa phrase.
      const motsCles = regle.motsCles && regle.motsCles.length > 0 ? `\n\nMots-clés : ${regle.motsCles.join(", ")}. Une demande qui en contient un sera rattachée sans vous demander.` : "";
      for (const chat of autorises) await envoyerA(chat, `Règle proposée (${regle.id}), née de votre réponse :\n\n${regle.texte}${motsCles}`, boutons);
    },
    demarrer: reception.demarrer,
    arreter: reception.arreter,
  };
}

export interface OptionsSupport {
  jeton: string;
  /** Le client a écrit au support : on ingère son message comme feedback, et on renvoie l'accusé de réception. */
  surFeedback: (texte: string, utilisateurTelegram: string) => Promise<void>;
  fetch?: Fetch;
  journal?: Journal;
  delaiReessaiMs?: number;
}

/** Bot « support client » de la startup fictive : il sert à envoyer l'escalade en direct pendant la démo. */
export function botSupport(o: OptionsSupport): { traiter: (m: MiseAJour) => Promise<void>; demarrer: () => void; arreter: () => void } {
  const appel = clientTelegram(o.jeton, o.fetch);
  const traiter = async (m: MiseAJour) => {
    const msg = m.message;
    if (!msg?.text || !msg.from || msg.text.startsWith("/start")) return;
    await o.surFeedback(msg.text, String(msg.from.id));
    await appel("sendMessage", { chat_id: msg.chat.id, text: "Merci, votre message a bien été transmis à l'équipe produit de Jalonne." });
  };
  const reception = recevoir({ appel, nom: "bot support", types: ["message"], traiter, journal: o.journal ?? journalConsole, delaiReessaiMs: o.delaiReessaiMs ?? 5000 });
  return { traiter, demarrer: reception.demarrer, arreter: reception.arreter };
}
