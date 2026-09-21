import { promptChooseAbility, promptChooseOption, promptChooseMany,
         promptKeepOne } from './choice-prompts.mjs';

const MODULE_ID = 'deck-of-many-more-things';
export const SOCKET = `module.${MODULE_ID}`;

/**
 * Asking a player a card's question, from the GM's client.
 *
 * The GM is the one resolving a pending card, but the dialog has to open on
 * the player's screen, so the question goes out over a socket and the answer
 * comes back the same way. Everything else — planning, confirming, writing —
 * stays on the GM's client, so the player answers a question and nothing more.
 *
 * A player who does not answer must not wedge the card. The request times out
 * and hands the decision back to the GM, which is also what happens when the
 * player closes the dialog: they had their say and declined to use it.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const pending = new Map();

/** GM side: ask `user` and wait. Resolves to the choice, or null to fall back. */
export function askPlayer({ user, card, kind, prompt, options = [], delta = 1, count = 1,
                            timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!user?.id) return Promise.resolve(null);
  const id = foundry.utils.randomID();

  return new Promise((resolve) => {
    const done = (value) => {
      if (!pending.has(id)) return;
      clearTimeout(pending.get(id).timer);
      pending.delete(id);
      resolve(value);
    };
    const timer = setTimeout(() => {
      ui.notifications.warn(game.i18n.format('DOMMT.Choice.NoAnswer', { user: user.name }));
      done(null);
    }, timeoutMs);
    pending.set(id, { done, timer });

    game.socket.emit(SOCKET, {
      type: 'choice-request',
      id,
      userId: user.id,
      cardName: card.name,
      rulesText: card.rules?.summary ?? '',
      kind, prompt, options, delta, count
    });
    ui.notifications.info(game.i18n.format('DOMMT.Choice.Waiting',
      { user: user.name, card: card.name }));
  });
}

/**
 * Registered on every client. A player answers questions addressed to them;
 * the GM listens for the answers coming back.
 */
export function registerChoiceSocket() {
  game.socket.on(SOCKET, async (msg) => {
    if (msg?.type === 'choice-response') {
      pending.get(msg.id)?.done(msg.choice ?? null);
      return;
    }
    if (msg?.type !== 'choice-request' || msg.userId !== game.user.id) return;

    const card = { name: msg.cardName, rules: { summary: msg.rulesText } };
    let choice;
    if (msg.kind === 'choose_ability') choice = await promptChooseAbility(card, msg.delta);
    else if (msg.kind === 'choose_many') {
      choice = await promptChooseMany(card, msg.prompt, msg.options, msg.count);
    } else if (msg.kind === 'keep_one') {
      choice = await promptKeepOne(card, msg.prompt, msg.options);
    } else choice = await promptChooseOption(card, msg.prompt, msg.options);

    game.socket.emit(SOCKET, {
      type: 'choice-response',
      id: msg.id,
      choice: !choice || choice === 'cancel'
        || (Array.isArray(choice) && !choice.length) ? null : choice
    });
  });
}
