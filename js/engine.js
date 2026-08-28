// ============================================================
// DURAK AI / MOVE ENGINE v2
// ============================================================
// Strategy layer used by the suggestion UI.
//
// The engine deliberately does NOT know hidden opponent cards during
// normal analysis. It samples plausible hidden hands, completes the
// unseen stock, and evaluates candidate moves by Monte Carlo rollouts.
// Fully known positions still use the exact endgame solver.
// ============================================================

const DURAK_DECK_SIZE = 24;
const DURAK_HAND_LIMIT = 6;
const DURAK_ANALYSIS_SAMPLES = 56;
const DURAK_ROLLOUT_DEPTH = 28;

function getCardRank(cardId) {
  return typeof cardId === 'string' ? cardId.slice(0, -1) : '';
}

function getCardSuit(cardId) {
  return typeof cardId === 'string' ? cardId.slice(-1) : '';
}

function getCardValue(cardId) {
  return RANK_VALUES[getCardRank(cardId)] ?? 0;
}

function isTrump(cardId, s = state) {
  return !!cardId && !!s.trumpCard && getCardSuit(cardId) === getCardSuit(s.trumpCard);
}

function isHighCard(cardId) {
  return getCardValue(cardId) >= 12;
}

function isLowCard(cardId) {
  return getCardValue(cardId) <= 10;
}

function cloneState(s) {
  return {
    ...s,
    myHand: [...s.myHand],
    oppKnownHand: [...s.oppKnownHand],
    discard: [...s.discard],
    tablePairs: s.tablePairs.map(p => ({ attack: p.attack, defend: p.defend })),
    stockCards: s.stockCards ? [...s.stockCards] : undefined
  };
}

function getTableCards(s = state) {
  return s.tablePairs.flatMap(p => [p.attack, p.defend].filter(Boolean));
}

function getTableRanks(s = state) {
  return new Set(getTableCards(s).map(getCardRank));
}

function getTableCardCount(s = state) {
  return getTableCards(s).length;
}

function getLastPair(s = state) {
  return s.tablePairs[s.tablePairs.length - 1] || null;
}

function needsDefense(s = state) {
  const pair = getLastPair(s);
  return !!pair && !pair.defend;
}

function getMyRankCounts(s = state) {
  return s.myHand.reduce((out, card) => {
    const rank = getCardRank(card);
    out[rank] = (out[rank] || 0) + 1;
    return out;
  }, {});
}

function getOppKnownRankCounts(s = state) {
  return s.oppKnownHand.reduce((out, card) => {
    const rank = getCardRank(card);
    out[rank] = (out[rank] || 0) + 1;
    return out;
  }, {});
}

function getOpponentTotalCards(s = state) {
  return s.oppKnownHand.length + s.oppUnknownCount;
}

function getUsedCardIds(s = state) {
  return new Set([
    ...s.myHand,
    ...s.oppKnownHand,
    ...s.discard,
    ...getTableCards(s),
    ...(s.trumpCard ? [s.trumpCard] : [])
  ]);
}

function getRemainingDeck(s = state) {
  const used = getUsedCardIds(s).size;
  return Math.max(0, DURAK_DECK_SIZE - used - s.oppUnknownCount);
}

function isExactEndgame(s = state) {
  return getRemainingDeck(s) === 0 && s.oppUnknownCount === 0;
}

function getMyTrumpCount(s = state) {
  return s.myHand.filter(c => isTrump(c, s)).length;
}

function getKnownOpponentTrumpCount(s = state) {
  return s.oppKnownHand.filter(c => isTrump(c, s)).length;
}

function getUnknownPoolIds(s = state) {
  const used = getUsedCardIds(s);
  return s.allCards.map(c => c.id).filter(id => !used.has(id));
}

function getEstimatedUnknownTrumpCount(s = state) {
  if (!s.trumpCard) return 0;
  const suit = getCardSuit(s.trumpCard);
  const known = [...getUsedCardIds(s)].filter(c => getCardSuit(c) === suit).length;
  return Math.max(0, 6 - known);
}

function getTrumpScarcityMultiplier(s = state) {
  const remaining = getEstimatedUnknownTrumpCount(s);
  if (remaining <= 1) return 1.35;
  if (remaining <= 2) return 1.20;
  if (remaining <= 3) return 1.10;
  return 1;
}

// ============================================================
// POSITION EVALUATION
// ============================================================

function cardStrategicValue(card, s = state) {
  const rank = getCardRank(card);
  const value = getCardValue(card);
  const myCounts = getMyRankCounts(s);
  const oppCounts = getOppKnownRankCounts(s);
  let score = value;

  if (isTrump(card, s)) {
    score += 10;
    if (value >= 12) score += 6;
    if (value >= 14) score += 5;
    score *= getTrumpScarcityMultiplier(s);
  }

  if (myCounts[rank] >= 2) score -= 7;
  if (myCounts[rank] >= 3) score -= 5;
  if (oppCounts[rank]) score -= Math.min(6, oppCounts[rank] * 2);
  if (!isTrump(card, s) && value >= 13) score -= 3;
  if (!isTrump(card, s) && value <= 10) score -= 4;

  return score;
}

function getRankAttackPotential(rank, s = state) {
  const mine = s.myHand.filter(c => getCardRank(c) === rank).length;
  const opp = s.oppKnownHand.filter(c => getCardRank(c) === rank).length;
  let score = mine * 10;
  if (mine >= 2) score += 10;
  if (mine >= 3) score += 10;
  score += opp * 4;
  return score;
}

function getAttackPotential(card, s = state) {
  let score = getRankAttackPotential(getCardRank(card), s);
  score += 16 - getCardValue(card);
  if (isTrump(card, s)) score -= 10;
  return score;
}

function countKnownAnswers(card, s = state) {
  return s.oppKnownHand.filter(c => canBeat(card, c)).length;
}

function getPileRisk(s = state) {
  const cards = getTableCards(s);
  if (!cards.length) return 0;
  let risk = 0;
  for (const card of cards) {
    risk += getCardValue(card);
    if (isTrump(card, s)) risk += 8;
    if (getCardValue(card) >= 12) risk += 5;
  }
  return risk + Math.max(0, cards.length - 2) * 5;
}

function evaluateState(s, perspective = 'me') {
  const my = s.myHand.length;
  const opp = getOpponentTotalCards(s);

  if (my === 0 && opp === 0) return 0;
  if (my === 0) return perspective === 'me' ? 100000 : -100000;
  if (opp === 0) return perspective === 'me' ? -100000 : 100000;

  let score = (opp - my) * 100;

  if (opp === 1) score -= 280;
  else if (opp === 2) score -= 120;
  if (my === 1) score += 220;
  else if (my === 2) score += 100;

  const myBurden = s.myHand.reduce((n, c) => n + cardStrategicValue(c, s), 0);
  const oppBurden = s.oppKnownHand.reduce((n, c) => n + cardStrategicValue(c, s), 0);
  score -= myBurden * 1.8;
  score += oppBurden * 1.4;
  score += (getMyTrumpCount(s) - getKnownOpponentTrumpCount(s)) * 8;

  const myHighTrumps = s.myHand.filter(c => isTrump(c, s) && getCardValue(c) >= 12).length;
  const oppHighTrumps = s.oppKnownHand.filter(c => isTrump(c, s) && getCardValue(c) >= 12).length;
  score += (myHighTrumps - oppHighTrumps) * 10;

  const ranks = getMyRankCounts(s);
  for (const rank in ranks) {
    if (ranks[rank] >= 2) score += 10;
    if (ranks[rank] >= 3) score += 12;
  }

  if (needsDefense(s)) score -= getPileRisk(s) * 0.35;
  return perspective === 'me' ? score : -score;
}

// ============================================================
// LEGAL MOVES
// ============================================================

function getAttackLimit(s = state) {
  const defenderCount = s.turn === 'me' ? getOpponentTotalCards(s) : s.myHand.length;
  const defended = s.tablePairs.filter(p => p.defend).length;
  return Math.min(DURAK_HAND_LIMIT, defenderCount + defended);
}

function getLegalAttacks(s = state, player = 'me') {
  const hand = player === 'me' ? s.myHand : s.oppKnownHand;
  if (!hand.length || s.tablePairs.length >= getAttackLimit(s)) return [];
  if (!s.tablePairs.length) return [...hand];
  const ranks = getTableRanks(s);
  return hand.filter(card => ranks.has(getCardRank(card)));
}

function getLegalDefenses(s = state, player = 'me') {
  const pair = getLastPair(s);
  if (!pair || pair.defend) return [];
  const hand = player === 'me' ? s.myHand : s.oppKnownHand;
  return hand.filter(card => canBeat(pair.attack, card));
}

function getLegalMovesForPlayer(s, player) {
  return needsDefense(s) ? getLegalDefenses(s, player) : getLegalAttacks(s, player);
}

// ============================================================
// STATE SIMULATION
// ============================================================

function removeCardFromHand(s, player, card) {
  const key = player === 'me' ? 'myHand' : 'oppKnownHand';
  const index = s[key].indexOf(card);
  if (index >= 0) s[key].splice(index, 1);
}

function simulatePlay(s, player, card) {
  const next = cloneState(s);
  removeCardFromHand(next, player, card);

  if (needsDefense(next)) {
    next.tablePairs[next.tablePairs.length - 1].defend = card;
    next.turn = next.attacker;
  } else {
    next.tablePairs.push({ attack: card, defend: null });
    next.turn = player === 'me' ? 'opp' : 'me';
  }
  return next;
}

function drawForSearch(s, player, count) {
  if (!s.stockCards || !s.stockCards.length || count <= 0) return;
  const hand = player === 'me' ? s.myHand : s.oppKnownHand;
  const drawn = Math.min(count, s.stockCards.length, DURAK_HAND_LIMIT - hand.length);
  for (let i = 0; i < drawn; i++) hand.push(s.stockCards.shift());
}

function simulateResolveBout(s, action, player) {
  const next = cloneState(s);
  const cards = getTableCards(next);
  const originalAttacker = next.attacker;

  if (action === 'TAKE') {
    const hand = player === 'me' ? next.myHand : next.oppKnownHand;
    hand.push(...cards);
    next.attacker = player === 'me' ? 'opp' : 'me';
    next.turn = next.attacker;
  } else {
    next.discard.push(...cards);
    next.attacker = originalAttacker === 'me' ? 'opp' : 'me';
    next.turn = next.attacker;
  }

  next.tablePairs = [];

  const attacker = originalAttacker;
  const defender = attacker === 'me' ? 'opp' : 'me';
  const first = attacker;
  const second = defender;
  const firstHand = first === 'me' ? next.myHand : next.oppKnownHand;
  const secondHand = second === 'me' ? next.myHand : next.oppKnownHand;

  const firstNeed = Math.max(0, 6 - firstHand.length);
  const secondNeed = Math.max(0, 6 - secondHand.length);
  drawForSearch(next, first, firstNeed);
  drawForSearch(next, second, secondNeed);

  if (!next.stockCards || !next.stockCards.length) {
    next.trumpPickedUp = true;
  }

  next.oppUnknownCount = 0;
  return next;
}

function simulateTake(s, player) {
  return simulateResolveBout(s, 'TAKE', player);
}

function simulateBito(s, player) {
  return simulateResolveBout(s, 'BITO', player);
}

function isTerminalSearchState(s) {
  return s.myHand.length === 0 || s.oppKnownHand.length === 0;
}

function terminalScore(s, depth = 0) {
  const my = s.myHand.length;
  const opp = s.oppKnownHand.length;
  if (my === 0 && opp === 0) return 0;
  if (my === 0) return 100000 - depth;
  if (opp === 0) return -100000 + depth;
  return null;
}

// ============================================================
// EXACT ENDGAME SOLVER
// ============================================================

function solveEndgame(s, player, depth = 0, alpha = -Infinity, beta = Infinity, memo = new Map()) {
  const terminal = terminalScore(s, depth);
  if (terminal !== null) return terminal;
  if (depth >= 80) return evaluateState(s);

  const key = [
    player,
    s.attacker,
    s.tablePairs.map(p => `${p.attack}:${p.defend || '-'}`).join(','),
    s.myHand.slice().sort().join('.'),
    s.oppKnownHand.slice().sort().join('.')
  ].join('|');
  if (memo.has(key)) return memo.get(key);

  const isMax = player === 'me';
  let best = isMax ? -Infinity : Infinity;
  const defending = needsDefense(s);
  const moves = getLegalMovesForPlayer(s, player);

  if (defending) {
    const taken = simulateTake(s, player);
    const score = solveEndgame(taken, taken.turn, depth + 1, alpha, beta, memo);
    best = isMax ? Math.max(best, score) : Math.min(best, score);
    if (isMax) alpha = Math.max(alpha, best); else beta = Math.min(beta, best);
  }

  for (const card of moves) {
    const next = simulatePlay(s, player, card);
    const score = solveEndgame(next, next.turn, depth + 1, alpha, beta, memo);
    best = isMax ? Math.max(best, score) : Math.min(best, score);
    if (isMax) alpha = Math.max(alpha, best); else beta = Math.min(beta, best);
    if (beta <= alpha) break;
  }

  if (!defending && s.tablePairs.length > 0 && beta > alpha) {
    const bito = simulateBito(s, player);
    const score = solveEndgame(bito, bito.turn, depth + 1, alpha, beta, memo);
    best = isMax ? Math.max(best, score) : Math.min(best, score);
  }

  if (!Number.isFinite(best)) best = evaluateState(s);
  memo.set(key, best);
  return best;
}

function findBestEndgameMove(s = state) {
  if (s.turn !== 'me') return null;
  const defending = needsDefense(s);
  const candidates = getLegalMovesForPlayer(s, 'me').map(card => ({ type: 'CARD', move: card }));
  if (defending) candidates.push({ type: 'TAKE', move: 'TAKE' });
  else if (s.tablePairs.length > 0) candidates.push({ type: 'BITO', move: 'BITO' });
  if (!candidates.length) return null;

  let best = candidates[0];
  let bestScore = -Infinity;
  const memo = new Map();
  for (const candidate of candidates) {
    const next = candidate.type === 'TAKE'
      ? simulateTake(s, 'me')
      : candidate.type === 'BITO'
        ? simulateBito(s, 'me')
        : simulatePlay(s, 'me', candidate.move);
    const score = solveEndgame(next, next.turn, 1, -Infinity, Infinity, memo);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return { move: best.move, score: bestScore };
}

// ============================================================
// HIDDEN CARD MODEL
// ============================================================

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function shuffle(cards) {
  const out = [...cards];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function sampleHiddenState(s = state) {
  const pool = shuffle(getUnknownPoolIds(s));
  const opponentCount = s.oppUnknownCount;
  const opp = pool.splice(0, opponentCount);

  const sampled = cloneState(s);
  sampled.oppKnownHand = [...sampled.oppKnownHand, ...opp];
  sampled.oppUnknownCount = 0;
  sampled.stockCards = pool;
  sampled.phase = 'playing';
  return sampled;
}

function cardAnswerProbability(card, s = state) {
  const pool = getUnknownPoolIds(s);
  if (!pool.length) return 0;
  const answers = pool.filter(id => canBeat(card, id)).length;
  return answers / pool.length;
}

function getRankProbability(rank, s = state) {
  const pool = getUnknownPoolIds(s);
  if (!pool.length || !s.oppUnknownCount) return 0;
  const matching = pool.filter(id => getCardRank(id) === rank).length;
  return 1 - hypergeometricZero(matching, pool.length, s.oppUnknownCount);
}

function hypergeometricZero(successes, population, draws) {
  if (successes <= 0 || draws <= 0) return 1;
  if (successes >= population) return 0;
  let p = 1;
  for (let i = 0; i < draws; i++) {
    p *= (population - successes - i) / (population - i);
    if (p <= 0) return 0;
  }
  return p;
}

// ============================================================
// HEURISTIC ROLLOUT POLICY
// ============================================================

function scoreAttackForRollout(card, s, player) {
  const hand = player === 'me' ? s.myHand : s.oppKnownHand;
  const counts = hand.reduce((o, c) => {
    const r = getCardRank(c); o[r] = (o[r] || 0) + 1; return o;
  }, {});
  const value = getCardValue(card);
  let score = (16 - value) * 4;
  const rank = getCardRank(card);
  if (counts[rank] >= 2) score += 25;
  if (counts[rank] >= 3) score += 12;
  if (isTrump(card, s)) score -= 25;
  if (s.oppKnownHand.length <= 2 && player === 'me') score += 25;
  if (s.myHand.length <= 2 && player === 'opp') score += 25;
  if (!isTrump(card, s)) score += 4;
  return score + getRankAttackPotentialForPlayer(rank, s, player) * 1.2;
}

function getRankAttackPotentialForPlayer(rank, s, player) {
  const hand = player === 'me' ? s.myHand : s.oppKnownHand;
  const other = player === 'me' ? s.oppKnownHand : s.myHand;
  const mine = hand.filter(c => getCardRank(c) === rank).length;
  const opp = other.filter(c => getCardRank(c) === rank).length;
  return mine * 10 + (mine >= 2 ? 10 : 0) + (mine >= 3 ? 10 : 0) + opp * 4;
}

function scoreDefenseForRollout(card, s, player) {
  const hand = player === 'me' ? s.myHand : s.oppKnownHand;
  const rank = getCardRank(card);
  const count = hand.filter(c => getCardRank(c) === rank).length;
  let score = -cardStrategicValue(card, s) * 2.2;
  if (isLowCard(card)) score += 12;
  if (count >= 2) score -= 12;
  if (isTrump(card, s)) score -= 22;
  return score;
}

function chooseRolloutMove(s, player) {
  const defending = needsDefense(s);
  const cards = defending ? getLegalDefenses(s, player) : getLegalAttacks(s, player);

  if (defending) {
    if (!cards.length) return { type: 'TAKE' };
    let best = cards[0], bestScore = -Infinity;
    for (const card of cards) {
      const score = scoreDefenseForRollout(card, s, player);
      if (score > bestScore) { bestScore = score; best = card; }
    }
    // Taking is compared against the best defense.
    const pile = getPileRisk(s);
    const takePenalty = pile * 1.6 + getTableCardCount(s) * 8;
    if (s.myHand.length + getTableCardCount(s) > 6 && player === 'me') return { type: 'TAKE' };
    if (s.oppKnownHand.length + getTableCardCount(s) > 6 && player === 'opp') return { type: 'TAKE' };
    if (takePenalty > bestScore + 45) return { type: 'TAKE' };
    return { type: 'CARD', card: best };
  }

  if (!cards.length) {
    return s.tablePairs.length ? { type: 'BITO' } : null;
  }

  let best = cards[0], bestScore = -Infinity;
  for (const card of cards) {
    const score = scoreAttackForRollout(card, s, player);
    if (score > bestScore) { bestScore = score; best = card; }
  }
  return { type: 'CARD', card: best };
}

function applySearchAction(s, player, action) {
  if (!action) return null;
  if (action.type === 'TAKE') return simulateTake(s, player);
  if (action.type === 'BITO') return simulateBito(s, player);
  return simulatePlay(s, player, action.card);
}

function rollout(s, depthLimit = DURAK_ROLLOUT_DEPTH) {
  let current = cloneState(s);
  for (let depth = 0; depth < depthLimit; depth++) {
    const terminal = terminalScore(current, depth);
    if (terminal !== null) return terminal;

    const player = current.turn;
    const action = chooseRolloutMove(current, player);
    if (!action) return evaluateState(current);
    current = applySearchAction(current, player, action);
  }
  return evaluateState(current);
}

// ============================================================
// MOVE ANALYSIS
// ============================================================

function candidateMoves(s = state) {
  const moves = getLegalMovesForPlayer(s, 'me').map(card => ({ type: 'CARD', move: card }));
  if (needsDefense(s)) moves.push({ type: 'TAKE', move: 'TAKE' });
  else if (s.tablePairs.length) moves.push({ type: 'BITO', move: 'BITO' });
  return moves;
}

function applyCandidate(s, candidate) {
  if (candidate.type === 'TAKE') return simulateTake(s, 'me');
  if (candidate.type === 'BITO') return simulateBito(s, 'me');
  return simulatePlay(s, 'me', candidate.move);
}

function moveLabel(candidate) {
  return candidate.type === 'CARD' ? candidate.move : candidate.move;
}

function deterministicMoveScore(candidate, s) {
  const next = applyCandidate(s, candidate);
  if (candidate.type === 'TAKE') return evaluateTake(next, s);
  if (candidate.type === 'BITO') return evaluateState(next);
  return evaluateState(next) + getMoveTacticalScore(candidate.move, s);
}

function getMoveTacticalScore(card, s) {
  let score = 0;
  const rank = getCardRank(card);
  const counts = getMyRankCounts(s);
  const value = getCardValue(card);
  const answerProb = cardAnswerProbability(card, s);

  score += (16 - value) * 3;
  if (counts[rank] >= 2) score += 22;
  if (counts[rank] >= 3) score += 14;
  score -= answerProb * 28;
  if (isTrump(card, s)) score -= 24;
  if (getOpponentTotalCards(s) <= 2) score += 18;
  return score;
}

function evaluateTake(sAfter, before) {
  const pile = getTableCardCount(before);
  return evaluateState(sAfter) - getPileRisk(before) * 1.7 - pile * 10;
}

function analyzeMove(candidate, s, samples) {
  const next = applyCandidate(s, candidate);
  const outcomes = [];
  let wins = 0;
  let total = 0;

  for (let i = 0; i < samples; i++) {
    let sampled;
    if (s.oppUnknownCount > 0) {
      // Re-sample the hidden cards for every trial. This makes the result an
      // equity estimate over the information actually available to the user.
      sampled = sampleHiddenState(s);
      sampled = applyCandidate(sampled, candidate);
    } else {
      sampled = cloneState(next);
      sampled.oppUnknownCount = 0;
      sampled.stockCards = sampled.stockCards || [];
    }

    const result = terminalScore(sampled);
    const score = result !== null ? result : rollout(sampled);
    outcomes.push(score);
    if (score > 50000) wins++;
    else if (score < -50000) wins += 0;
    else if (score > 0) wins += 0.5;
    total += 1;
  }

  const equity = total ? wins / total : 0.5;
  const avgScore = outcomes.reduce((a, b) => a + b, 0) / Math.max(1, outcomes.length);
  return { candidate, equity, avgScore };
}

function analyzePosition(s = state, options = {}) {
  if (s.turn !== 'me') return null;
  const candidates = candidateMoves(s);
  if (!candidates.length) return null;

  if (isExactEndgame(s)) {
    const exact = findBestEndgameMove(s);
    return {
      mode: 'exact',
      samples: 0,
      best: exact ? candidates.find(c => moveLabel(c) === exact.move) || candidates[0] : candidates[0],
      moves: candidates.map(c => ({ candidate: c, equity: exact && moveLabel(c) === exact.move ? 1 : 0, avgScore: deterministicMoveScore(c, s) }))
        .sort((a, b) => b.avgScore - a.avgScore)
    };
  }

  const samples = options.samples || DURAK_ANALYSIS_SAMPLES;
  const results = candidates.map(c => analyzeMove(c, s, samples));
  results.sort((a, b) => b.equity - a.equity || b.avgScore - a.avgScore);
  return { mode: 'monte-carlo', samples, best: results[0].candidate, moves: results };
}

function getSuggestionReasons(card, s) {
  if (!card || card === 'TAKE' || card === 'BITO') return [];
  const reasons = [];
  const rank = getCardRank(card);
  const counts = getMyRankCounts(s);
  const answerProb = cardAnswerProbability(card, s);

  if (counts[rank] >= 3) reasons.push('triple pressure');
  else if (counts[rank] >= 2) reasons.push('keeps rank pressure');
  if (!isTrump(card, s) && getCardValue(card) <= 10) reasons.push('sheds a low card');
  if (answerProb < 0.15) reasons.push('low chance of an answer');
  else if (answerProb < 0.35) reasons.push('moderate answer risk');
  if (isTrump(card, s)) reasons.push('spends a trump');
  if (getOpponentTotalCards(s) <= 2) reasons.push('pressures a short hand');
  return reasons.slice(0, 3);
}

function updateSuggestion() {
  const el = document.getElementById('suggestion-text');
  if (!el) return;

  if (state.phase === 'drawing') {
    el.innerText = `DRAW PHASE: Select ${state.cardsToDraw} card(s).`;
    return;
  }
  if (state.phase === 'gameover') {
    el.innerText = state.winner === 'me' ? 'Game over: you won.' : 'Game over: opponent won.';
    return;
  }
  if (state.turn !== 'me') {
    el.innerText = "Wait for opponent's move.";
    return;
  }

  const analysis = analyzePosition(state);
  if (!analysis) {
    el.innerText = 'No legal move.';
    return;
  }

  const best = analysis.best;
  const label = moveLabel(best);
  const rows = analysis.moves.slice(0, 4);

  if (analysis.mode === 'exact') {
    el.innerHTML = `<strong>ENDGAME: ${label}</strong><br><small>Exact calculation, no hidden cards.</small>`;
    return;
  }

  const bestResult = analysis.moves[0];
  const pct = Math.round(bestResult.equity * 100);
  const reason = label === 'TAKE' ? 'best calculated outcome' : label === 'BITO' ? 'best calculated outcome' : getSuggestionReasons(label, state).join(', ') || 'best calculated outcome';
  const alternatives = rows.map((r, i) => {
    const name = moveLabel(r.candidate);
    return `${i === 0 ? 'BEST' : name}: ${Math.round(r.equity * 100)}%`;
  }).join(' · ');

  el.innerHTML = `<strong>${label === 'TAKE' ? 'TAKE' : label === 'BITO' ? 'BITO' : `Play ${label}`}</strong> <span class="suggestion-confidence">${pct}% equity</span><br><small>${reason}</small><br><small>${alternatives}</small>`;
}

// ============================================================
// DEBUG / PUBLIC API
// ============================================================

function debugDurakEngine() {
  const analysis = state.turn === 'me' ? analyzePosition(state, { samples: 100 }) : null;
  console.log('State:', JSON.parse(JSON.stringify(state)));
  console.log('Remaining deck:', getRemainingDeck(state));
  console.log('Exact endgame:', isExactEndgame(state));
  console.log('Pile risk:', getPileRisk(state));
  console.log('Evaluation:', evaluateState(state));
  console.table((analysis?.moves || []).map(r => ({
    move: moveLabel(r.candidate),
    equity: `${Math.round(r.equity * 100)}%`,
    score: Math.round(r.avgScore)
  })));
  return analysis;
}

window.DurakAI = {
  analyzePosition,
  sampleHiddenState,
  cardAnswerProbability,
  getRankProbability,
  getUnknownPoolIds,
  findBestEndgameMove,
  solveEndgame,
  evaluateState
};