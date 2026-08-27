/*
 * Durak app hardening / work-in-progress fixes.
 * Loaded after app.js so the existing UI stays intact while the
 * fragile state calculations are corrected in one place.
 */

(function () {
  'use strict';

  const DECK_SIZE = 24;
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

  window.getAvailableStock = function getAvailableStockFixed() {
    const used = getKnownCardsSet();
    return Math.max(0, DECK_SIZE - used.size - state.oppUnknownCount);
  };

  window.canAttack = function canAttackFixed(cardId) {
    if (!cardIdIsValid(cardId) || state.phase !== 'playing') return false;

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

    if (action === 'take') return hasUnansweredAttack;
    if (action === 'bito') return !hasUnansweredAttack;
    return false;
  };

  // The 24-card game has 6 cards per suit, not the 8 trumps used by the
  // engine's original 36-card assumption. Keep AI evaluation consistent with
  // the actual deck represented by app.js.
  window.getEstimatedUnknownTrumpCount = function getEstimatedUnknownTrumpCountFixed(s = state) {
    if (!s.trumpCard) return 0;

    const trumpSuit = getCardSuit(s.trumpCard);
    const totalTrumps = s.allCards.filter(card => card.suit === trumpSuit).length;
    const knownTrumps = [
      ...s.myHand,
      ...s.oppKnownHand,
      ...getTableCards(s),
      ...s.discard
    ].filter(card => getCardSuit(card) === trumpSuit).length;

    return Math.max(0, totalTrumps - knownTrumps);
  };

  window.getTrumpScarcityMultiplier = function getTrumpScarcityMultiplierFixed(s = state) {
    const remaining = getEstimatedUnknownTrumpCount(s);
    if (remaining <= 1) return 1.35;
    if (remaining <= 2) return 1.20;
    if (remaining <= 3) return 1.10;
    return 1.0;
  };

  window.deduceOpponentHand = function deduceOpponentHandFixed() {
    if (state.oppUnknownCount <= 0) return;

    const used = getKnownCardsSet();
    const unknownCards = state.allCards
      .map(card => card.id)
      .filter(id => !used.has(id));

    const stock = Math.max(0, DECK_SIZE - used.size - state.oppUnknownCount);
    if (stock !== 0) return;

    const revealCount = Math.min(state.oppUnknownCount, unknownCards.length);
    state.oppKnownHand.push(...unknownCards.slice(0, revealCount));
    state.oppUnknownCount -= revealCount;
  };

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

  const originalUpdatePlayingUI = window.updatePlayingUI;
  if (typeof originalUpdatePlayingUI === 'function') {
    window.updatePlayingUI = function updatePlayingUIFixed() {
      validateGameState();
      originalUpdatePlayingUI();
    };
  }
})();
