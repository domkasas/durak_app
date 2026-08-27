// ============================================================
// WIN PROBABILITY / EQUITY ESTIMATE
// ============================================================
// This is an estimate, not a mathematically exact probability while
// hidden opponent cards remain unknown. Exact endgames are solved by the
// engine and therefore report 100% / 0% when the result is forced.
//
// The estimate is recalculated from the CURRENT state after every move.
// It considers:
//   - hand size
//   - card quality
//   - trump count and quality
//   - known opponent cards
//   - estimated hidden opponent strength
//   - remaining deck
//   - attacker / defender position
//   - current table pressure
// ============================================================

(function () {
  'use strict';

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
  }

  function getUnknownPool(s) {
    const used = new Set([
      ...s.myHand,
      ...s.oppKnownHand,
      ...s.discard,
      ...getTableCards(s),
      ...(s.trumpCard ? [s.trumpCard] : [])
    ]);

    return s.allCards.filter(card => !used.has(card.id));
  }

  function averageCardValue(cards) {
    if (!cards.length) return 0;
    return cards.reduce((sum, card) => sum + getCardValue(card.id || card), 0) / cards.length;
  }

  function handStrength(hand, s) {
    if (!hand.length) return 0;

    let strength = 0;
    for (const card of hand) {
      const value = getCardValue(card);
      const trump = isTrump(card, s);

      // Base rank value. Low cards are easier to dump, while high cards
      // have greater defensive/attack power.
      strength += value;

      if (trump) {
        strength += 8;
        if (value >= 12) strength += 5;
        if (value >= 14) strength += 4;
      }
    }

    const counts = {};
    hand.forEach(card => {
      const rank = getCardRank(card);
      counts[rank] = (counts[rank] || 0) + 1;
    });

    // Pairs/triples are strategically useful because they create legal
    // throw-ins later in the bout.
    Object.values(counts).forEach(count => {
      if (count >= 2) strength += 7;
      if (count >= 3) strength += 8;
    });

    return strength;
  }

  function expectedHiddenOpponentStrength(s, pool) {
    if (s.oppUnknownCount <= 0) return 0;
    if (!pool.length) return 0;

    // Average random remaining cards are a reasonable prior for cards we
    // have not seen. This avoids pretending that unknown cards are weak.
    const avgValue = averageCardValue(pool);
    const trumpSuit = s.trumpCard ? getCardSuit(s.trumpCard) : null;
    const trumpCount = trumpSuit
      ? pool.filter(card => card.suit === trumpSuit).length
      : 0;

    const trumpChance = trumpCount / pool.length;
    return s.oppUnknownCount * (avgValue + trumpChance * 12);
  }

  function getExactEndgameProbability(s) {
    if (!isExactEndgame(s)) return null;
    if (s.myHand.length === 0) return 100;
    if (s.oppKnownHand.length === 0) return 0;

    // The exact solver's score is decisive when it finds a forced result.
    // Use a shallow fallback only if a non-terminal state somehow reaches
    // the recursion guard.
    const result = findBestEndgameMove(s);
    if (!result) return null;
    if (result.score >= 90000) return 100;
    if (result.score <= -90000) return 0;

    return clamp(Math.round(sigmoid(result.score / 900) * 100), 1, 99);
  }

  function calculateWinProbability(s = state) {
    if (s.phase === 'gameover') {
      return s.winner === 'me' ? 100 : 0;
    }

    const exact = getExactEndgameProbability(s);
    if (exact !== null) return exact;

    const myCount = s.myHand.length;
    const oppCount = getOpponentTotalCards(s);
    const pool = getUnknownPool(s);

    // Hand-size advantage is the strongest general predictor.
    let edge = (oppCount - myCount) * 16;

    // Compare our actual hand against the expected quality of the hidden
    // opponent hand. Known opponent cards are added separately below.
    const myStrength = handStrength(s.myHand, s);
    const expectedOpp = expectedHiddenOpponentStrength(s, pool);
    edge += (myStrength - expectedOpp) * 1.15;

    const knownOppStrength = handStrength(s.oppKnownHand, s);
    if (s.oppUnknownCount === 0) {
      edge += (myStrength - knownOppStrength) * 1.0;
    } else {
      // Known opponent cards are valuable information. Weight them more
      // heavily than a purely random hidden-card assumption.
      edge -= knownOppStrength * 0.9;
    }

    // Trump advantage matters a lot, especially as the deck gets smaller.
    const myTrumps = getMyTrumpCount(s);
    const oppKnownTrumps = getKnownOpponentTrumpCount(s);
    const unknownTrumps = getEstimatedUnknownTrumpCount(s);
    const expectedUnknownTrumpsForOpp = s.oppUnknownCount > 0 && pool.length
      ? unknownTrumps * (s.oppUnknownCount / pool.length)
      : 0;

    edge += (myTrumps - oppKnownTrumps - expectedUnknownTrumpsForOpp) * 12;

    // High trumps are disproportionately valuable.
    const myHighTrumps = s.myHand.filter(c => isTrump(c, s) && getCardValue(c) >= 12).length;
    const oppHighTrumps = s.oppKnownHand.filter(c => isTrump(c, s) && getCardValue(c) >= 12).length;
    edge += (myHighTrumps - oppHighTrumps) * 9;

    // Remaining stock makes the estimate less certain. With no stock,
    // card information becomes much more decisive.
    const stock = getRemainingDeck(s);
    const uncertainty = clamp(stock / 12, 0, 1);

    // Initiative: being attacker is useful, but defending a tiny pile can
    // be better than attacking blindly, so keep this deliberately modest.
    if (s.turn === 'me') edge += 5;
    if (s.attacker === 'me') edge += 3;

    // Defender with an unanswered attack is under immediate pressure.
    if (needsDefense(s)) {
      const pileRisk = getPileRisk(s);
      edge -= clamp(pileRisk * 0.18, 0, 24);
    }

    // A player on one card is close to winning, but not automatically safe.
    if (myCount === 1) edge += 20;
    if (oppCount === 1) edge -= 32;

    // Reduce the impact of noisy hidden-card estimates early in the game.
    edge *= 0.72 + (1 - uncertainty) * 0.28;

    // 50% is the neutral baseline. The logistic curve keeps ordinary hands
    // in a believable range while still allowing very strong positions to
    // reach the 80-95% range and clearly losing positions to fall below 20%.
    const probability = sigmoid(edge / 34) * 100;

    return clamp(Math.round(probability), 1, 99);
  }

  function updateWinProbability() {
    const el = document.getElementById('win-probability-value');
    const box = document.getElementById('win-probability');
    if (!el || !box || typeof state === 'undefined') return;

    const probability = calculateWinProbability(state);
    if (probability === null) return;

    el.textContent = `${probability}%`;
    box.dataset.probability = probability;

    if (probability >= 90) {
      box.dataset.level = 'dominant';
    } else if (probability >= 70) {
      box.dataset.level = 'favored';
    } else if (probability <= 10) {
      box.dataset.level = 'critical';
    } else if (probability <= 30) {
      box.dataset.level = 'behind';
    } else {
      box.dataset.level = 'even';
    }
  }

  window.calculateWinProbability = calculateWinProbability;
  window.updateWinProbability = updateWinProbability;

  // updatePlayingUI is declared by app.js before this script executes.
  // Wrap it so the percentage is refreshed every time the board is drawn.
  const previousUpdatePlayingUI = window.updatePlayingUI;
  if (typeof previousUpdatePlayingUI === 'function') {
    window.updatePlayingUI = function updatePlayingUIWithWinProbability() {
      previousUpdatePlayingUI();
      updateWinProbability();
    };
  }
})();
