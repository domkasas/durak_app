// ============================================================
// WIN PROBABILITY / EQUITY ESTIMATE
// ============================================================
// This is an estimate while hidden opponent cards remain unknown.
// Exact endgames use the engine's solved position when decisive.
// The estimate is recalculated after every rendered game state.
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
      strength += value;

      if (isTrump(card, s)) {
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

    Object.values(counts).forEach(count => {
      if (count >= 2) strength += 7;
      if (count >= 3) strength += 8;
    });

    return strength;
  }

  function expectedHiddenOpponentStrength(s, pool) {
    if (s.oppUnknownCount <= 0 || !pool.length) return 0;

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

    const result = findBestEndgameMove(s);
    if (!result) return null;
    if (result.score >= 90000) return 100;
    if (result.score <= -90000) return 0;

    return clamp(Math.round(sigmoid(result.score / 900) * 100), 1, 99);
  }

  function calculateWinProbability(s = state) {
    if (s.phase === 'gameover') return s.winner === 'me' ? 100 : 0;

    const exact = getExactEndgameProbability(s);
    if (exact !== null) return exact;

    const myCount = s.myHand.length;
    const oppCount = getOpponentTotalCards(s);
    const pool = getUnknownPool(s);

    // Hand count is the strongest general signal.
    let edge = (oppCount - myCount) * 16;

    const myStrength = handStrength(s.myHand, s);
    const expectedOpp = expectedHiddenOpponentStrength(s, pool);
    edge += (myStrength - expectedOpp) * 1.15;

    const knownOppStrength = handStrength(s.oppKnownHand, s);
    if (s.oppUnknownCount === 0) {
      edge += (myStrength - knownOppStrength) * 1.0;
    } else {
      edge -= knownOppStrength * 0.9;
    }

    // Trump ownership and quality.
    const myTrumps = getMyTrumpCount(s);
    const oppKnownTrumps = getKnownOpponentTrumpCount(s);
    const unknownTrumps = getEstimatedUnknownTrumpCount(s);
    const expectedUnknownTrumpsForOpp = s.oppUnknownCount > 0 && pool.length
      ? unknownTrumps * (s.oppUnknownCount / pool.length)
      : 0;

    edge += (myTrumps - oppKnownTrumps - expectedUnknownTrumpsForOpp) * 12;

    const myHighTrumps = s.myHand.filter(c => isTrump(c, s) && getCardValue(c) >= 12).length;
    const oppHighTrumps = s.oppKnownHand.filter(c => isTrump(c, s) && getCardValue(c) >= 12).length;
    edge += (myHighTrumps - oppHighTrumps) * 9;

    // With fewer unknown cards, known information should matter more.
    const stock = getRemainingDeck(s);
    const uncertainty = clamp(stock / 12, 0, 1);
    edge *= 0.72 + (1 - uncertainty) * 0.28;

    if (s.turn === 'me') edge += 5;
    if (s.attacker === 'me') edge += 3;

    if (needsDefense(s)) {
      edge -= clamp(getPileRisk(s) * 0.18, 0, 24);
    }

    if (myCount === 1) edge += 20;
    if (oppCount === 1) edge -= 32;

    // Neutral state maps to exactly 50%, while extreme edges approach but
    // do not falsely claim certainty while hidden cards still exist.
    const probability = sigmoid(edge / 34) * 100;
    return clamp(Math.round(probability), 1, 99);
  }

  function updateWinProbability() {
    const el = document.getElementById('win-probability-value');
    const box = document.getElementById('win-probability');
    const fill = box && box.querySelector('.win-probability-fill');
    if (!el || !box || typeof state === 'undefined') return;

    const probability = calculateWinProbability(state);
    if (probability === null) return;

    el.textContent = `${probability}%`;
    box.dataset.probability = probability;
    box.style.setProperty('--win-probability', probability);
    if (fill) fill.style.width = `${probability}%`;

    if (probability >= 90) box.dataset.level = 'dominant';
    else if (probability >= 70) box.dataset.level = 'favored';
    else if (probability <= 10) box.dataset.level = 'critical';
    else if (probability <= 30) box.dataset.level = 'behind';
    else box.dataset.level = 'even';
  }

  window.calculateWinProbability = calculateWinProbability;
  window.updateWinProbability = updateWinProbability;

  const previousUpdatePlayingUI = window.updatePlayingUI;
  if (typeof previousUpdatePlayingUI === 'function') {
    window.updatePlayingUI = function updatePlayingUIWithWinProbability() {
      previousUpdatePlayingUI();
      updateWinProbability();
    };
  }
})();
