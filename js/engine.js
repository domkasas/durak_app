// ============================================================
// DURAK MOVE ENGINE
// ============================================================
// Requires existing globals:
//   state
//   RANK_VALUES
//   canBeat(cardA, cardB)
//
// Expected state fields:
//   state.phase
//   state.turn
//   state.tablePairs
//   state.deckSize
//   state.myHand
//   state.oppKnownHand
//   state.oppUnknownCount
//   state.discard
//   state.trumpCard
//
// Special UI moves:
//   BITO = finish attack / throw in no more cards
//   TAKE = take the table
// ============================================================


// ============================================================
// 1. BASIC CARD HELPERS
// ============================================================

function getCardRank(cardId) {
  return cardId.slice(0, -1);
}

function getCardSuit(cardId) {
  return cardId.slice(-1);
}

function getCardValue(cardId) {
  return RANK_VALUES[getCardRank(cardId)];
}

function isTrump(cardId) {
  if (!cardId || !state.trumpCard) return false;
  return getCardSuit(cardId) === getCardSuit(state.trumpCard);
}

function isHighCard(cardId) {
  return getCardValue(cardId) >= 12;
}

function isLowCard(cardId) {
  return getCardValue(cardId) <= 8;
}

function cloneState(s) {
  return {
    ...s,
    myHand: [...s.myHand],
    oppKnownHand: [...s.oppKnownHand],
    discard: [...s.discard],
    tablePairs: s.tablePairs.map(p => ({
      attack: p.attack,
      defend: p.defend
    }))
  };
}


// ============================================================
// 2. TABLE / HAND HELPERS
// ============================================================

function getTableCards(s = state) {
  return s.tablePairs.flatMap(p =>
    [p.attack, p.defend].filter(Boolean)
  );
}

function getTableRanks(s = state) {
  return new Set(
    getTableCards(s).map(getCardRank)
  );
}

function getTableCardCount(s = state) {
  return getTableCards(s).length;
}

function getLastPair(s = state) {
  return s.tablePairs[s.tablePairs.length - 1];
}

function needsDefense(s = state) {
  const lastPair = getLastPair(s);
  return !!(lastPair && !lastPair.defend);
}

function getMyRankCounts(s = state) {
  const counts = {};

  for (const card of s.myHand) {
    const rank = getCardRank(card);
    counts[rank] = (counts[rank] || 0) + 1;
  }

  return counts;
}

function getOppKnownRankCounts(s = state) {
  const counts = {};

  for (const card of s.oppKnownHand) {
    const rank = getCardRank(card);
    counts[rank] = (counts[rank] || 0) + 1;
  }

  return counts;
}


// ============================================================
// 3. DECK / UNKNOWN CARD INFORMATION
// ============================================================

function getRemainingDeck(s = state) {
  const tableCount = getTableCardCount(s);

  return Math.max(
    0,
    s.deckSize -
      (
        s.myHand.length +
        s.oppKnownHand.length +
        s.oppUnknownCount +
        s.discard.length +
        tableCount
      )
  );
}

function isExactEndgame(s = state) {
  return (
    getRemainingDeck(s) <= 0 &&
    s.oppUnknownCount === 0
  );
}

function getOpponentTotalCards(s = state) {
  return s.oppKnownHand.length + s.oppUnknownCount;
}

function getKnownRemainingCards(s = state) {
  return (
    s.myHand.length +
    s.oppKnownHand.length +
    s.oppUnknownCount +
    getRemainingDeck(s)
  );
}


// ============================================================
// 4. TRUMP ECONOMY
// ============================================================

function getMyTrumpCount(s = state) {
  return s.myHand.filter(c => isTrump(c)).length;
}

function getKnownOpponentTrumpCount(s = state) {
  return s.oppKnownHand.filter(c => isTrump(c)).length;
}

function getEstimatedUnknownTrumpCount(s = state) {
  // Estimate how many unknown trumps remain.
  //
  // There are 8 trump cards in a standard 36-card Durak deck.
  // If your game uses another deck size, this still gives a
  // reasonable estimate based on the standard Durak structure.
  const totalTrumps = 8;

  const knownTrumps =
    getMyTrumpCount(s) +
    getKnownOpponentTrumpCount(s) +
    getTableCards(s).filter(c => isTrump(c)).length +
    s.discard.filter(c => isTrump(c)).length;

  return Math.max(0, totalTrumps - knownTrumps);
}

function getTrumpScarcityMultiplier(s = state) {
  const remaining = getEstimatedUnknownTrumpCount(s);

  if (remaining <= 1) return 1.35;
  if (remaining <= 2) return 1.20;
  if (remaining <= 3) return 1.10;

  return 1.0;
}


// ============================================================
// 5. CARD STRATEGIC VALUE
// ============================================================
// Higher value = more painful to lose / more useful to keep.
//
// This is deliberately different from card rank.
//
// A 10 may be more strategically valuable than a K if it is
// your only card of that rank and helps preserve future attacks.
// ============================================================

function cardStrategicValue(card, s = state) {
  const rank = getCardRank(card);
  const value = getCardValue(card);

  const myCounts = getMyRankCounts(s);
  const oppCounts = getOppKnownRankCounts(s);

  let score = value;

  // ----------------------------------------------------------
  // Trump cards are strategically valuable.
  // ----------------------------------------------------------

  if (isTrump(card)) {
    score += 12;

    // High trumps are especially valuable.
    if (value >= 12) score += 7;
    if (value >= 14) score += 5;

    score *= getTrumpScarcityMultiplier(s);
  }

  // ----------------------------------------------------------
  // Duplicate ranks are useful for attacking.
  // ----------------------------------------------------------

  if (myCounts[rank] >= 2) {
    score -= 7;
  }

  if (myCounts[rank] >= 3) {
    score -= 5;
  }

  // ----------------------------------------------------------
  // A rank known to exist in opponent's hand is useful for
  // future attacks because it may create a throw-in.
  // ----------------------------------------------------------

  if (oppCounts[rank]) {
    score -= 3 * oppCounts[rank];
  }

  // ----------------------------------------------------------
  // High non-trumps are generally liabilities.
  // ----------------------------------------------------------

  if (!isTrump(card) && value >= 12) {
    score -= 3;
  }

  // ----------------------------------------------------------
  // Low cards are good to get rid of.
  // ----------------------------------------------------------

  if (!isTrump(card) && value <= 8) {
    score -= 4;
  }

  return score;
}


// ============================================================
// 6. ATTACK POTENTIAL
// ============================================================

function getRankAttackPotential(rank, s = state) {
  const myCount = s.myHand.filter(
    c => getCardRank(c) === rank
  ).length;

  const oppCount = s.oppKnownHand.filter(
    c => getCardRank(c) === rank
  ).length;

  let score = myCount * 10;

  if (myCount >= 2) score += 8;
  if (myCount >= 3) score += 10;

  // Known opponent copies mean this rank is likely to become
  // available as a legal throw-in later.
  score += oppCount * 4;

  return score;
}

function getAttackPotential(card, s = state) {
  const rank = getCardRank(card);

  let score = getRankAttackPotential(rank, s);

  // Prefer low cards when all else is equal.
  score += (15 - getCardValue(card));

  // Trump attacks are powerful but expensive.
  if (isTrump(card)) {
    score -= 8;
  }

  return score;
}


// ============================================================
// 7. HOW SAFE IS AN ATTACK?
// ============================================================

function opponentCanBeatKnown(card, s = state) {
  return s.oppKnownHand.some(
    oppCard => canBeat(card, oppCard)
  );
}

function countKnownAnswers(card, s = state) {
  return s.oppKnownHand.filter(
    oppCard => canBeat(card, oppCard)
  ).length;
}

function attackSafety(card, s = state) {
  let score = 0;

  const answers = countKnownAnswers(card, s);

  // No known answer is good.
  if (answers === 0) {
    score += 12;
  } else {
    score -= answers * 5;
  }

  // High cards are harder to recover from.
  if (getCardValue(card) >= 13) {
    score -= 3;
  }

  // Trump attack is expensive.
  if (isTrump(card)) {
    score -= 7;
  }

  return score;
}


// ============================================================
// 8. PILE VALUE
// ============================================================

function getPileStrategicValue(s = state) {
  return getTableCards(s).reduce(
    (total, card) => total + cardStrategicValue(card, s),
    0
  );
}

function getPileRisk(s = state) {
  const cards = getTableCards(s);

  if (!cards.length) return 0;

  let score = 0;

  for (const card of cards) {
    score += getCardValue(card);

    if (isTrump(card)) {
      score += 8;
    }

    if (getCardValue(card) >= 12) {
      score += 5;
    }
  }

  // Larger piles become increasingly dangerous.
  score += Math.max(0, cards.length - 2) * 5;

  return score;
}


// ============================================================
// 9. INITIATIVE / TEMPO
// ============================================================
// This is intentionally approximate because the actual turn
// transition is controlled elsewhere by the application.
//
// Positive = position tends to favor us.
// ============================================================

function estimateInitiative(s = state) {
  const myCards = s.myHand.length;
  const oppCards = getOpponentTotalCards(s);

  let score = 0;

  // Having fewer cards is generally good.
  score += (oppCards - myCards) * 8;

  // If opponent is down to very few cards, avoiding giving
  // them initiative becomes much more important.
  if (oppCards <= 2) {
    score += (myCards - oppCards) * 12;
  }

  // If we are down to very few cards, aggressively getting
  // rid of cards becomes more valuable.
  if (myCards <= 2) {
    score += (oppCards - myCards) * 15;
  }

  return score;
}


// ============================================================
// 10. OPPONENT PRESSURE
// ============================================================

function opponentPressure(s = state) {
  const oppCards = getOpponentTotalCards(s);

  if (oppCards <= 1) return 50;
  if (oppCards === 2) return 35;
  if (oppCards === 3) return 20;
  if (oppCards === 4) return 10;

  return 0;
}


// ============================================================
// 11. STATE EVALUATION
// ============================================================
// Positive = good for us.
// Negative = good for opponent.
//
// This is the core strategic evaluator used by the search.
// ============================================================

function evaluateState(s, perspective = 'me') {
  const myCards = s.myHand.length;
  const oppCards = getOpponentTotalCards(s);

  // ----------------------------------------------------------
  // Terminal states
  // ----------------------------------------------------------

  if (myCards === 0 && oppCards === 0) {
    return 0;
  }

  if (myCards === 0) {
    return 100000;
  }

  if (oppCards === 0) {
    return -100000;
  }

  let score = 0;

  // ----------------------------------------------------------
  // Hand-size advantage
  // ----------------------------------------------------------

  score += (oppCards - myCards) * 120;

  // ----------------------------------------------------------
  // Strongly punish allowing opponent to reach 1-2 cards.
  // ----------------------------------------------------------

  if (oppCards === 1) {
    score -= 250;
  } else if (oppCards === 2) {
    score -= 120;
  }

  // ----------------------------------------------------------
  // Reward being close to empty.
  // ----------------------------------------------------------

  if (myCards === 1) {
    score += 250;
  } else if (myCards === 2) {
    score += 120;
  }

  // ----------------------------------------------------------
  // Card-quality burden.
  // ----------------------------------------------------------

  const myCardBurden = s.myHand.reduce(
    (total, card) => total + cardStrategicValue(card, s),
    0
  );

  const oppKnownBurden = s.oppKnownHand.reduce(
    (total, card) => total + cardStrategicValue(card, s),
    0
  );

  score -= myCardBurden * 2;
  score += oppKnownBurden * 1.5;

  // Unknown opponent cards receive an average estimated
  // burden. We cannot know what they are, so don't overvalue it.
  score += s.oppUnknownCount * 2;

  // ----------------------------------------------------------
  // Trump economy
  // ----------------------------------------------------------

  const myTrumps = getMyTrumpCount(s);
  const oppTrumps = getKnownOpponentTrumpCount(s);

  score += (myTrumps - oppTrumps) * 8;

  // High trump advantage.
  const myHighTrumps = s.myHand.filter(
    c => isTrump(c) && getCardValue(c) >= 12
  ).length;

  const oppHighTrumps = s.oppKnownHand.filter(
    c => isTrump(c) && getCardValue(c) >= 12
  ).length;

  score += (myHighTrumps - oppHighTrumps) * 12;

  // ----------------------------------------------------------
  // Duplicate rank / attack potential
  // ----------------------------------------------------------

  const myRanks = getMyRankCounts(s);

  for (const rank in myRanks) {
    if (myRanks[rank] >= 2) {
      score += 10;
    }

    if (myRanks[rank] >= 3) {
      score += 12;
    }
  }

  // ----------------------------------------------------------
  // Initiative
  // ----------------------------------------------------------

  score += estimateInitiative(s) * 1.5;

  // ----------------------------------------------------------
  // Dangerous pile
  // ----------------------------------------------------------

  if (s.tablePairs.length > 0) {
    score -= getPileRisk(s) * 0.5;
  }

  // ----------------------------------------------------------
  // Opponent pressure
  // ----------------------------------------------------------

  score -= opponentPressure(s);

  // ----------------------------------------------------------
  // Perspective
  // ----------------------------------------------------------

  return perspective === 'me' ? score : -score;
}


// ============================================================
// 12. SORT HAND
// ============================================================

function getSortedHand(s = state) {
  return [...s.myHand].sort((a, b) => {
    const strategicA = cardStrategicValue(a, s);
    const strategicB = cardStrategicValue(b, s);

    if (strategicA !== strategicB) {
      return strategicA - strategicB;
    }

    return getCardValue(a) - getCardValue(b);
  });
}


// ============================================================
// 13. LEGAL ATTACKS
// ============================================================

function getLegalAttacks(s = state) {
  if (s.myHand.length === 0) {
    return [];
  }

  // First attack of a round.
  if (s.tablePairs.length === 0) {
    return [...s.myHand];
  }

  const tableRanks = getTableRanks(s);

  return s.myHand.filter(
    card => tableRanks.has(getCardRank(card))
  );
}


// ============================================================
// 14. LEGAL DEFENSES
// ============================================================

function getLegalDefenses(s = state) {
  const pair = getLastPair(s);

  if (!pair || pair.defend) {
    return [];
  }

  return s.myHand.filter(
    card => canBeat(pair.attack, card)
  );
}


// ============================================================
// 15. SIMULATE ATTACK
// ============================================================

function simulateAttack(s, card) {
  const next = cloneState(s);

  next.tablePairs.push({
    attack: card,
    defend: null
  });

  next.myHand = next.myHand.filter(
    c => c !== card
  );

  return next;
}


// ============================================================
// 16. SIMULATE DEFENSE
// ============================================================

function simulateDefense(s, card) {
  const next = cloneState(s);

  const index = next.tablePairs.length - 1;

  if (index >= 0) {
    next.tablePairs[index].defend = card;
  }

  next.myHand = next.myHand.filter(
    c => c !== card
  );

  return next;
}


// ============================================================
// 17. SIMULATE TAKE
// ============================================================

function simulateTake(s, isMyTurn = true) {
  const next = cloneState(s);

  const tableCards = getTableCards(next);

  if (isMyTurn) {
    next.myHand.push(...tableCards);
  } else {
    next.oppKnownHand.push(...tableCards);
  }

  next.tablePairs = [];

  return next;
}


// ============================================================
// 18. SIMULATE BITO
// ============================================================

function simulateBito(s) {
  const next = cloneState(s);

  next.tablePairs = [];

  return next;
}


// ============================================================
// 19. DEFENSE EVALUATION
// ============================================================

function evaluateDefense(card, s = state) {
  const pair = getLastPair(s);

  if (!pair) return -Infinity;

  let score = 0;

  const attack = pair.attack;

  // ----------------------------------------------------------
  // Basic cost of spending the card.
  // ----------------------------------------------------------

  score -= cardStrategicValue(card, s) * 3;

  // ----------------------------------------------------------
  // Strong preference for preserving trump.
  // ----------------------------------------------------------

  if (isTrump(card)) {
    score -= 18;

    if (getCardValue(card) >= 12) {
      score -= 15;
    }

    if (getTrumpScarcityMultiplier(s) > 1.1) {
      score -= 10;
    }
  }

  // ----------------------------------------------------------
  // Don't destroy a pair unnecessarily.
  // ----------------------------------------------------------

  const rank = getCardRank(card);
  const rankCount = s.myHand.filter(
    c => getCardRank(c) === rank
  ).length;

  if (rankCount >= 2) {
    score -= 12;
  }

  if (rankCount >= 3) {
    score -= 8;
  }

  // ----------------------------------------------------------
  // Preserve high cards only when they have strategic value.
  // ----------------------------------------------------------

  if (getCardValue(card) >= 13 && !isTrump(card)) {
    score -= 5;
  }

  // ----------------------------------------------------------
  // Low-card defense is usually ideal.
  // ----------------------------------------------------------

  if (isLowCard(card)) {
    score += 8;
  }

  // ----------------------------------------------------------
  // If opponent is close to empty, surviving efficiently
  // becomes more important.
  // ----------------------------------------------------------

  const oppCards = getOpponentTotalCards(s);

  if (oppCards <= 2) {
    score += 15;
  }

  // ----------------------------------------------------------
  // Consider resulting state.
  // ----------------------------------------------------------

  const next = simulateDefense(s, card);

  score += evaluateState(next) * 0.15;

  // ----------------------------------------------------------
  // If we defend with a non-trump against a non-trump,
  // that's generally preferable.
  // ----------------------------------------------------------

  if (!isTrump(attack) && !isTrump(card)) {
    score += 10;
  }

  return score;
}


// ============================================================
// 20. ATTACK EVALUATION
// ============================================================

function evaluateAttack(card, s = state) {
  let score = 0;

  const rank = getCardRank(card);
  const value = getCardValue(card);

  const rankCounts = getMyRankCounts(s);

  // ----------------------------------------------------------
  // Getting rid of low cards is good.
  // ----------------------------------------------------------

  score += (16 - value) * 4;

  // ----------------------------------------------------------
  // Duplicate ranks are very useful.
  // ----------------------------------------------------------

  if (rankCounts[rank] >= 2) {
    score += 35;
  }

  if (rankCounts[rank] >= 3) {
    score += 20;
  }

  // ----------------------------------------------------------
  // Attack potential.
  // ----------------------------------------------------------

  score += getAttackPotential(card, s) * 2;

  // ----------------------------------------------------------
  // Don't waste trump without a reason.
  // ----------------------------------------------------------

  if (isTrump(card)) {
    score -= 30;

    if (s.myHand.length <= 3) {
      score += 15;
    }
  }

  // ----------------------------------------------------------
  // Known opponent response.
  // ----------------------------------------------------------

  const answers = countKnownAnswers(card, s);

  if (answers === 0) {
    score += 25;
  } else {
    score -= answers * 8;
  }

  // ----------------------------------------------------------
  // High non-trump baiting.
  //
  // Only worthwhile when:
  // - the card is high
  // - we have no duplicate
  // - opponent's known hand doesn't punish it
  // ----------------------------------------------------------

  if (
    s.tablePairs.length === 0 &&
    !isTrump(card) &&
    value >= 13 &&
    rankCounts[rank] === 1 &&
    answers === 0
  ) {
    score += 15;
  }

  // ----------------------------------------------------------
  // If opponent has very few cards, pressure them hard.
  // ----------------------------------------------------------

  const oppCards = getOpponentTotalCards(s);

  if (oppCards <= 2) {
    score += value >= 12 ? 18 : 10;
  }

  // ----------------------------------------------------------
  // Resulting state evaluation.
  // ----------------------------------------------------------

  const next = simulateAttack(s, card);

  score += evaluateState(next) * 0.15;

  return score;
}


// ============================================================
// 21. CHOOSE BEST ATTACK
// ============================================================

function chooseBestAttack(s = state) {
  const attacks = getLegalAttacks(s);

  if (!attacks.length) {
    return null;
  }

  let bestCard = attacks[0];
  let bestScore = -Infinity;

  for (const card of attacks) {
    const score = evaluateAttack(card, s);

    if (score > bestScore) {
      bestScore = score;
      bestCard = card;
    }
  }

  return {
    card: bestCard,
    score: bestScore
  };
}


// ============================================================
// 22. CHOOSE BEST DEFENSE
// ============================================================

function chooseBestDefense(s = state) {
  const defenses = getLegalDefenses(s);

  if (!defenses.length) {
    return null;
  }

  let bestCard = defenses[0];
  let bestScore = -Infinity;

  for (const card of defenses) {
    const score = evaluateDefense(card, s);

    if (score > bestScore) {
      bestScore = score;
      bestCard = card;
    }
  }

  return {
    card: bestCard,
    score: bestScore
  };
}


// ============================================================
// 23. TAKE VS DEFEND
// ============================================================
// Important:
// Taking is not automatically bad.
//
// We compare:
//   A) taking the pile
//   B) defending with the best available card
//
// The pile's actual strategic value is considered.
// ============================================================

function evaluateTake(s = state) {
  const next = simulateTake(s, true);

  let score = evaluateState(next);

  const pileRisk = getPileRisk(s);

  // Taking a dangerous pile is heavily punished.
  score -= pileRisk * 2;

  // However, taking a tiny pile of worthless cards is not
  // nearly as bad.
  if (getTableCardCount(s) <= 2) {
    score += 20;
  }

  // If opponent has very few cards, taking becomes dangerous.
  const oppCards = getOpponentTotalCards(s);

  if (oppCards <= 2) {
    score -= 100;
  }

  return score;
}

function evaluateBestDefenseVsTake(s = state) {
  const defenses = getLegalDefenses(s);

  if (!defenses.length) {
    return {
      action: 'TAKE',
      card: null,
      score: evaluateTake(s)
    };
  }

  let bestDefense = null;
  let bestDefenseScore = -Infinity;

  for (const card of defenses) {
    const next = simulateDefense(s, card);

    let score = evaluateState(next);

    score += evaluateDefense(card, s);

    if (score > bestDefenseScore) {
      bestDefenseScore = score;
      bestDefense = card;
    }
  }

  const takeScore = evaluateTake(s);

  if (takeScore > bestDefenseScore) {
    return {
      action: 'TAKE',
      card: null,
      score: takeScore
    };
  }

  return {
    action: 'DEFEND',
    card: bestDefense,
    score: bestDefenseScore
  };
}


// ============================================================
// 24. ENDGAME LEGAL MOVES
// ============================================================

function getEndgameMoves(s, isMyTurn) {
  const pair = getLastPair(s);
  const defending = pair && !pair.defend;

  const hand = isMyTurn
    ? s.myHand
    : s.oppKnownHand;

  if (defending) {
    const moves = hand.filter(
      card => canBeat(pair.attack, card)
    );

    moves.push('TAKE');

    return moves;
  }

  if (s.tablePairs.length === 0) {
    return [...hand];
  }

  const ranks = getTableRanks(s);

  const moves = hand.filter(
    card => ranks.has(getCardRank(card))
  );

  // Bito is only meaningful once there is already a table.
  moves.push('BITO');

  return moves;
}


// ============================================================
// 25. APPLY ENDGAME MOVE
// ============================================================

function applyEndgameMove(s, move, isMyTurn) {
  const next = cloneState(s);

  const defending = needsDefense(next);

  if (move === 'BITO') {
    next.tablePairs = [];
    return next;
  }

  if (move === 'TAKE') {
    const tableCards = getTableCards(next);

    if (isMyTurn) {
      next.myHand.push(...tableCards);
    } else {
      next.oppKnownHand.push(...tableCards);
    }

    next.tablePairs = [];

    return next;
  }

  const handKey = isMyTurn
    ? 'myHand'
    : 'oppKnownHand';

  const hand = next[handKey];

  const cardIndex = hand.indexOf(move);

  if (cardIndex !== -1) {
    hand.splice(cardIndex, 1);
  }

  if (defending) {
    const index = next.tablePairs.length - 1;

    if (index >= 0) {
      next.tablePairs[index].defend = move;
    }
  } else {
    next.tablePairs.push({
      attack: move,
      defend: null
    });
  }

  return next;
}


// ============================================================
// 26. ENDGAME MINIMAX
// ============================================================
// This is only used when opponent's entire hand is known.
//
// We use alpha-beta pruning and a dynamic depth limit.
//
// NOTE:
// The surrounding application still controls actual Durak
// turn transitions. This solver evaluates the tactical state
// under the same simplified transition model used by your
// previous engine.
// ============================================================

function solveEndgame(
  simState,
  isMyTurn,
  depth = 0,
  alpha = -Infinity,
  beta = Infinity
) {
  const myCount = simState.myHand.length;
  const oppCount = simState.oppKnownHand.length;

  // ----------------------------------------------------------
  // Terminal states
  // ----------------------------------------------------------

  if (myCount === 0 && oppCount === 0) {
    return 0;
  }

  if (myCount === 0) {
    return 100000 - depth;
  }

  if (oppCount === 0) {
    return -100000 + depth;
  }

  // ----------------------------------------------------------
  // Dynamic search limit.
  //
  // Small hands can be solved deeper.
  // ----------------------------------------------------------

  const totalCards =
    myCount +
    oppCount +
    getTableCardCount(simState);

  const maxDepth =
    totalCards <= 6 ? 40 :
    totalCards <= 8 ? 30 :
    totalCards <= 10 ? 24 :
    18;

  if (depth >= maxDepth) {
    return evaluateState(simState);
  }

  const moves = getEndgameMoves(simState, isMyTurn);

  if (!moves.length) {
    return evaluateState(simState);
  }

  let bestScore = isMyTurn
    ? -Infinity
    : Infinity;

  for (const move of moves) {
    const nextState =
      applyEndgameMove(
        simState,
        move,
        isMyTurn
      );

    // --------------------------------------------------------
    // Turn model.
    //
    // We retain the same basic turn alternation model as the
    // original solver, but after TAKE the player who took gets
    // the next decision.
    // --------------------------------------------------------

    let nextTurn = !isMyTurn;

    if (move === 'TAKE') {
      nextTurn = isMyTurn;
    }

    const score = solveEndgame(
      nextState,
      nextTurn,
      depth + 1,
      alpha,
      beta
    );

    if (isMyTurn) {
      bestScore = Math.max(bestScore, score);
      alpha = Math.max(alpha, bestScore);
    } else {
      bestScore = Math.min(bestScore, score);
      beta = Math.min(beta, bestScore);
    }

    // Alpha-beta pruning.
    if (beta <= alpha) {
      break;
    }
  }

  return bestScore;
}


// ============================================================
// 27. FIND BEST ENDGAME MOVE
// ============================================================

function findBestEndgameMove(s = state) {
  const moves = getEndgameMoves(s, true);

  if (!moves.length) {
    return null;
  }

  let bestMove = moves[0];
  let bestScore = -Infinity;

  for (const move of moves) {
    const nextState =
      applyEndgameMove(
        s,
        move,
        true
      );

    let nextTurn = false;

    if (move === 'TAKE') {
      nextTurn = true;
    }

    const score = solveEndgame(
      nextState,
      nextTurn,
      0,
      -Infinity,
      Infinity
    );

    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }
  }

  return {
    move: bestMove,
    score: bestScore
  };
}


// ============================================================
// 28. MAIN SUGGESTION FUNCTION
// ============================================================

function updateSuggestion() {
  const sugEl = document.getElementById('suggestion-text');

  if (!sugEl) {
    return;
  }

  // ----------------------------------------------------------
  // Phase checks
  // ----------------------------------------------------------

  if (state.phase === 'drawing') {
    sugEl.innerText = "Select drawn cards.";
    return;
  }

  if (state.turn === 'opp') {
    sugEl.innerText = "Wait for opponent's move.";
    return;
  }

  // ----------------------------------------------------------
  // Basic state
  // ----------------------------------------------------------

  const lastPair = getLastPair(state);
  const defending = needsDefense(state);

  const tableCardsCount =
    getTableCardCount(state);

  const opponentCards =
    getOpponentTotalCards(state);

  const remainingDeck =
    getRemainingDeck(state);

  const exactEndgame =
    isExactEndgame(state);

  // ==========================================================
  // ENDGAME
  // ==========================================================

  if (exactEndgame) {
    const result =
      findBestEndgameMove(state);

    if (!result) {
      sugEl.innerText =
        "No legal move.";
      return;
    }

    const move = result.move;

    if (move === 'TAKE') {
      sugEl.innerText =
        `ENDGAME: TAKE (forced/optimal)`;
      return;
    }

    if (move === 'BITO') {
      sugEl.innerText =
        `ENDGAME: Click BITO`;
      return;
    }

    sugEl.innerText =
      `ENDGAME: Play ${move}`;

    return;
  }


  // ==========================================================
  // DEFENSE
  // ==========================================================

  if (defending) {
    const defenses =
      getLegalDefenses(state);

    // --------------------------------------------------------
    // No defense exists.
    // --------------------------------------------------------

    if (!defenses.length) {
      sugEl.innerText =
        "No valid defense. You must Take.";
      return;
    }

    const decision =
      evaluateBestDefenseVsTake(state);

    // --------------------------------------------------------
    // TAKE
    // --------------------------------------------------------

    if (decision.action === 'TAKE') {
      const pileCount =
        getTableCardCount(state);

      const pileRisk =
        Math.round(getPileRisk(state));

      if (pileCount >= 4) {
        sugEl.innerText =
          `TAKE. Dangerous pile (${pileCount} cards, risk ${pileRisk}).`;
      } else if (opponentCards <= 2) {
        sugEl.innerText =
          `TAKE. Opponent has only ${opponentCards} cards, so wasting a strong defense is risky.`;
      } else {
        sugEl.innerText =
          `TAKE. Better than spending a valuable defense card.`;
      }

      return;
    }

    // --------------------------------------------------------
    // DEFEND
    // --------------------------------------------------------

    const card =
      decision.card;

    if (!card) {
      sugEl.innerText =
        "No valid defense.";
      return;
    }

    let reason = "";

    if (isTrump(card)) {
      reason = "low-cost trump defense";
    } else if (
      getCardValue(card) <= 8
    ) {
      reason = "cheap defense";
    } else if (
      getMyRankCounts(state)[getCardRank(card)] >= 2
    ) {
      reason = "preserves valuable structure";
    } else {
      reason = "best resulting position";
    }

    sugEl.innerText =
      `Defend with ${card} (${reason}).`;

    return;
  }


  // ==========================================================
  // ATTACK
  // ==========================================================

  const attacks =
    getLegalAttacks(state);

  // ----------------------------------------------------------
  // No attack available.
  // ----------------------------------------------------------

  if (!attacks.length) {
    sugEl.innerText =
      "No valid attacks. Click Bito.";
    return;
  }

  const result =
    chooseBestAttack(state);

  if (!result) {
    sugEl.innerText =
      "No valid attack.";
    return;
  }

  const bestAttack =
    result.card;

  const rank =
    getCardRank(bestAttack);

  const rankCounts =
    getMyRankCounts(state);

  const opponentAnswers =
    countKnownAnswers(bestAttack, state);

  // ----------------------------------------------------------
  // Explain why.
  // ----------------------------------------------------------

  let reason = "";

  if (rankCounts[rank] >= 3) {
    reason = "triple pressure";
  } else if (rankCounts[rank] >= 2) {
    reason = "pair pressure";
  } else if (
    !isTrump(bestAttack) &&
    getCardValue(bestAttack) <= 8
  ) {
    reason = "dump low card";
  } else if (opponentAnswers === 0) {
    reason = "no known answer";
  } else if (
    opponentCards <= 2
  ) {
    reason = "pressure opponent's short hand";
  } else if (
    !isTrump(bestAttack) &&
    getCardValue(bestAttack) >= 13
  ) {
    reason = "bait high non-trump";
  } else {
    reason = "best overall position";
  }

  // ----------------------------------------------------------
  // Additional warning when attacking with trump.
  // ----------------------------------------------------------

  if (isTrump(bestAttack)) {
    reason += ", but costs trump";
  }

  sugEl.innerText =
    `Attack with ${bestAttack} (${reason}).`;
}


// ============================================================
// 29. OPTIONAL DEBUG FUNCTION
// ============================================================
// Run from the browser console:
//   debugDurakEngine()
//
// Useful while tuning the engine.
// ============================================================

function debugDurakEngine() {
  const attacks =
    getLegalAttacks(state);

  const defenses =
    getLegalDefenses(state);

  console.table(
    attacks.map(card => ({
      card,
      value: getCardValue(card),
      trump: isTrump(card),
      strategicValue:
        Math.round(cardStrategicValue(card, state) * 100) / 100,
      attackScore:
        Math.round(evaluateAttack(card, state) * 100) / 100,
      knownAnswers:
        countKnownAnswers(card, state)
    }))
  );

  console.table(
    defenses.map(card => ({
      card,
      value: getCardValue(card),
      trump: isTrump(card),
      strategicValue:
        Math.round(cardStrategicValue(card, state) * 100) / 100,
      defenseScore:
        Math.round(evaluateDefense(card, state) * 100) / 100
    }))
  );

  console.log("My hand:", state.myHand);
  console.log(
    "Opponent known:",
    state.oppKnownHand
  );
  console.log(
    "Opponent unknown:",
    state.oppUnknownCount
  );
  console.log(
    "Opponent total:",
    getOpponentTotalCards(state)
  );
  console.log(
    "Remaining deck:",
    getRemainingDeck(state)
  );
  console.log(
    "My trumps:",
    getMyTrumpCount(state)
  );
  console.log(
    "Known opponent trumps:",
    getKnownOpponentTrumpCount(state)
  );
  console.log(
    "Estimated unknown trumps:",
    getEstimatedUnknownTrumpCount(state)
  );
  console.log(
    "Pile risk:",
    getPileRisk(state)
  );
  console.log(
    "State evaluation:",
    evaluateState(state)
  );
}