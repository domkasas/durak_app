/*
 * Durak app hardening / work-in-progress fixes.
 * Loaded after app.js so the existing UI stays intact while the
 * fragile state calculations are corrected in one place.
 */

(function () {
  'use strict';

  const ORIGINAL_DECK_SIZE = 24;
  const HAND_LIMIT = 6;

  function cardIdIsValid(cardId) {
    return typeof cardId === 'string' && state.allCards.some(card => card.id === cardId);
  }

  function getKnownCardsSet() {
    return new Set([
      ...state.myHand,
      ...state.oppKnownHand,
      ...state.discard,
      ...getTableCards(),
      ...(state.trumpCard ? [state.trumpCard] : [])
    ]);
  }

  // The stock is what is genuinely still in the draw pile. The trump card is
  // already removed from the stock while it is face-up, so it must not be
  // counted as an extra card after it is picked up either.
  window.getAvailableStock = function getAvailableStockFixed() {
    const used = getKnownCardsSet();
    return Math.max(0, ORIGINAL_DECK_SIZE - used.size - state.oppUnknownCount);
  };

  // A card may only be attacked if its rank is already represented on the
  // table after the first attack. The attack cap is the defender's original
  // hand size, not simply their current hand size.
  window.canAttack = function canAttackFixed(cardId) {
    if (!cardIdIsValid(cardId)) return false;
    if (state.phase !== 'playing') return false;

    const tableCards = getTableCards();
    const tableRanks = new Set(tableCards.map(getCardRank));
    const defendedCount = state.tablePairs.filter(pair => pair.defend).length;
    const defenderCards = getDefenderCardCount();
    const attackLimit = Math.min(HAND_LIMIT, defenderCards + defendedCount);

    if (state.tablePairs.length >= attackLimit) return false;
    return tableCards.length === 0 || tableRanks.has(getCardRank(cardId));
  };

  window.canResolveBout = function canResolveBoutFixed(action) {
    if (state.phase !== 'playing' || state.tablePairs.length === 0) return false;

    const hasUnansweredAttack = state.tablePairs.some(pair => !pair.defend);

    if (action === 'take') {
      // Only the current defender may take.
      return hasUnansweredAttack;
    }

    if (action === 'bito') {
      // Bito is only legal after every attack has been defended.
      return !hasUnansweredAttack;
    }

    return false;
  };

  // Reveal the opponent's unknown cards only when every non-hand card is
  // accounted for. This avoids turning a temporarily exhausted stock into
  // a false deduction while a draw phase is still being resolved.
  window.deduceOpponentHand = function deduceOpponentHandFixed() {
    if (state.oppUnknownCount <= 0) return;

    const used = getKnownCardsSet();
    const unknownCards = state.allCards
      .map(card => card.id)
      .filter(id => !used.has(id));

    // Every unknown opponent card must be among the remaining unassigned
    // cards once the stock is empty.
    const stock = Math.max(0, ORIGINAL_DECK_SIZE - used.size - state.oppUnknownCount);
    if (stock !== 0) return;

    const revealCount = Math.min(state.oppUnknownCount, unknownCards.length);
    state.oppKnownHand.push(...unknownCards.slice(0, revealCount));
    state.oppUnknownCount -= revealCount;
  };

  // Keep state internally consistent after undo or a hand update. These are
  // assertions rather than silent repairs, so bad state is visible during WIP.
  window.validateGameState = function validateGameState() {
    const zones = [
      ...state.myHand,
      ...state.oppKnownHand,
      ...state.discard,
      ...getTableCards(),
      ...(state.trumpCard ? [state.trumpCard] : [])
    ];

    if (new Set(zones).size !== zones.length) {
      console.warn('Durak state warning: duplicate known card detected.', zones);
      return false;
    }

    if (state.oppUnknownCount < 0) {
      console.warn('Durak state warning: negative unknown opponent count.');
      return false;
    }

    if (state.myHand.length > HAND_LIMIT && state.phase !== 'gameover') {
      console.warn('Durak state warning: player hand exceeds six cards.');
      return false;
    }

    return true;
  };

  // Wrap the existing UI updater so every rendered state gets a cheap
  // consistency check without changing the current rendering code.
  const originalUpdatePlayingUI = window.updatePlayingUI;
  if (typeof originalUpdatePlayingUI === 'function') {
    window.updatePlayingUI = function updatePlayingUIFixed() {
      validateGameState();
      originalUpdatePlayingUI();
    };
  }
})();
