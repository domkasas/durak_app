// ============================================================
// DURAK AI / MOVE ENGINE v3
// ============================================================
// Rule-faithful information-set Monte Carlo engine.
// Hidden cards are sampled without replacement. The trump card stays
// outside the stock until the stock is exhausted, and drawing follows
// Durak order. Opponent decisions are stochastic but competence-weighted
// rather than a single deterministic greedy line.
// ============================================================

const DURAK_DECK_SIZE = 24;
const DURAK_HAND_LIMIT = 6;
const DURAK_ANALYSIS_SAMPLES = 96;
const DURAK_ROLLOUT_DEPTH = 80;

function getCardRank(cardId) { return typeof cardId === 'string' ? cardId.slice(0, -1) : ''; }
function getCardSuit(cardId) { return typeof cardId === 'string' ? cardId.slice(-1) : ''; }
function getCardValue(cardId) { return RANK_VALUES[getCardRank(cardId)] ?? 0; }
function isTrump(cardId, s = state) { return !!cardId && !!s.trumpCard && getCardSuit(cardId) === getCardSuit(s.trumpCard); }
function isHighCard(cardId) { return getCardValue(cardId) >= 12; }
function isLowCard(cardId) { return getCardValue(cardId) <= 10; }

function cloneState(s) {
  return {
    ...s,
    myHand: [...s.myHand],
    oppKnownHand: [...s.oppKnownHand],
    discard: [...s.discard],
    tablePairs: (s.tablePairs || []).map(p => ({ attack: p.attack, defend: p.defend })),
    stockCards: s.stockCards ? [...s.stockCards] : undefined,
    allCards: s.allCards ? [...s.allCards] : undefined
  };
}

function getTableCards(s = state) { return (s.tablePairs || []).flatMap(p => [p.attack, p.defend].filter(Boolean)); }
function getTableRanks(s = state) { return new Set(getTableCards(s).map(getCardRank)); }
function getTableCardCount(s = state) { return getTableCards(s).length; }
function getLastPair(s = state) { return s.tablePairs?.[s.tablePairs.length - 1] || null; }
function needsDefense(s = state) { const pair = getLastPair(s); return !!pair && !pair.defend; }
function getOpponentTotalCards(s = state) { return s.oppKnownHand.length + s.oppUnknownCount; }
function getMyRankCounts(s = state) { return s.myHand.reduce((o, c) => { const r = getCardRank(c); o[r] = (o[r] || 0) + 1; return o; }, {}); }
function getOppKnownRankCounts(s = state) { return s.oppKnownHand.reduce((o, c) => { const r = getCardRank(c); o[r] = (o[r] || 0) + 1; return o; }, {}); }

function getUsedCardIds(s = state) {
  return new Set([...s.myHand, ...s.oppKnownHand, ...s.discard, ...getTableCards(s), ...(s.trumpCard ? [s.trumpCard] : [])]);
}

// trumpCard is already counted as used, so this is the real face-down stock.
function getRemainingDeck(s = state) { return Math.max(0, DURAK_DECK_SIZE - getUsedCardIds(s).size - s.oppUnknownCount); }
function isExactEndgame(s = state) { return getRemainingDeck(s) === 0 && s.oppUnknownCount === 0; }
function getMyTrumpCount(s = state) { return s.myHand.filter(c => isTrump(c, s)).length; }
function getKnownOpponentTrumpCount(s = state) { return s.oppKnownHand.filter(c => isTrump(c, s)).length; }

function getUnknownPoolIds(s = state) {
  const used = getUsedCardIds(s);
  return s.allCards.map(c => c.id).filter(id => !used.has(id));
}

function getEstimatedUnknownTrumpCount(s = state) {
  if (!s.trumpCard || s.trumpPickedUp) return 0;
  const suit = getCardSuit(s.trumpCard);
  const known = [...getUsedCardIds(s)].filter(id => getCardSuit(id) === suit).length;
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
  const rank = getCardRank(card), value = getCardValue(card);
  const myCounts = getMyRankCounts(s), oppCounts = getOppKnownRankCounts(s);
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

function getRankAttackPotential(rank, s = state, player = 'me') {
  const hand = player === 'me' ? s.myHand : s.oppKnownHand;
  const other = player === 'me' ? s.oppKnownHand : s.myHand;
  const mine = hand.filter(c => getCardRank(c) === rank).length;
  const opp = other.filter(c => getCardRank(c) === rank).length;
  return mine * 10 + (mine >= 2 ? 10 : 0) + (mine >= 3 ? 10 : 0) + opp * 4;
}
function getAttackPotential(card, s = state) {
  let score = getRankAttackPotential(getCardRank(card), s);
  score += 16 - getCardValue(card);
  if (isTrump(card, s)) score -= 10;
  return score;
}
function countKnownAnswers(card, s = state) { return s.oppKnownHand.filter(c => canBeat(card, c)).length; }
function getPileRisk(s = state) {
  let risk = 0;
  for (const card of getTableCards(s)) {
    risk += getCardValue(card);
    if (isTrump(card, s)) risk += 8;
    if (getCardValue(card) >= 12) risk += 5;
  }
  return risk + Math.max(0, getTableCardCount(s) - 2) * 5;
}

function evaluateState(s, perspective = 'me') {
  const my = s.myHand.length, opp = getOpponentTotalCards(s);
  if (my === 0 && opp === 0) return 0;
  if (my === 0) return perspective === 'me' ? 100000 : -100000;
  if (opp === 0) return perspective === 'me' ? -100000 : 100000;
  let score = (opp - my) * 100;
  if (opp === 1) score -= 280; else if (opp === 2) score -= 120;
  if (my === 1) score += 220; else if (my === 2) score += 100;
  score -= s.myHand.reduce((n, c) => n + cardStrategicValue(c, s), 0) * 1.8;
  score += s.oppKnownHand.reduce((n, c) => n + cardStrategicValue(c, s), 0) * 1.4;
  score += (getMyTrumpCount(s) - getKnownOpponentTrumpCount(s)) * 8;
  const myHighTrumps = s.myHand.filter(c => isTrump(c, s) && getCardValue(c) >= 12).length;
  const oppHighTrumps = s.oppKnownHand.filter(c => isTrump(c, s) && getCardValue(c) >= 12).length;
  score += (myHighTrumps - oppHighTrumps) * 10;
  const ranks = getMyRankCounts(s);
  for (const rank in ranks) { if (ranks[rank] >= 2) score += 10; if (ranks[rank] >= 3) score += 12; }
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
function getLegalMovesForPlayer(s, player) { return needsDefense(s) ? getLegalDefenses(s, player) : getLegalAttacks(s, player); }

// ============================================================
// RULE-FAITHFUL BOUT RESOLUTION / DRAWING
// ============================================================

function removeCardFromHand(s, player, card) {
  const key = player === 'me' ? 'myHand' : 'oppKnownHand';
  const i = s[key].indexOf(card);
  if (i >= 0) s[key].splice(i, 1);
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
function drawOne(next, player) {
  if (!next.stockCards?.length) return false;
  const hand = player === 'me' ? next.myHand : next.oppKnownHand;
  if (hand.length >= DURAK_HAND_LIMIT) return false;
  hand.push(next.stockCards.shift());
  return true;
}
function drawAfterBout(next, firstPlayer, secondPlayer) {
  for (const player of [firstPlayer, secondPlayer]) {
    const hand = player === 'me' ? next.myHand : next.oppKnownHand;
    const need = Math.max(0, DURAK_HAND_LIMIT - hand.length);
    for (let i = 0; i < need; i++) if (!drawOne(next, player)) break;
  }
  // Trump is outside the stock and is taken only as the final draw, by the
  // last player in draw order who still needs a card.
  if (!next.trumpPickedUp && (!next.stockCards || next.stockCards.length === 0)) {
    for (const player of [firstPlayer, secondPlayer]) {
      const hand = player === 'me' ? next.myHand : next.oppKnownHand;
      if (hand.length < DURAK_HAND_LIMIT) {
        hand.push(next.trumpCard);
        next.trumpPickedUp = true;
        break;
      }
    }
  }
}
function simulateResolveBout(s, action, player) {
  const next = cloneState(s);
  const cards = getTableCards(next);
  const originalAttacker = next.attacker;
  const defender = originalAttacker === 'me' ? 'opp' : 'me';

  if (action === 'TAKE') {
    const hand = player === 'me' ? next.myHand : next.oppKnownHand;
    hand.push(...cards);
    next.tablePairs = [];
    next.attacker = originalAttacker;
    next.turn = originalAttacker;
    drawAfterBout(next, originalAttacker, defender);
  } else {
    next.discard.push(...cards);
    next.tablePairs = [];
    next.attacker = defender;
    next.turn = defender;
    drawAfterBout(next, defender, originalAttacker);
  }
  next.oppUnknownCount = 0;
  return next;
}
function simulateTake(s, player) { return simulateResolveBout(s, 'TAKE', player); }
function simulateBito(s, player) { return simulateResolveBout(s, 'BITO', player); }

// ============================================================
// EXACT ENDGAME SOLVER
// ============================================================

function terminalScore(s, depth = 0) {
  const my = s.myHand.length, opp = getOpponentTotalCards(s);
  if (my === 0 && opp === 0) return 0;
  if (my === 0) return 100000 - depth;
  if (opp === 0) return -100000 + depth;
  return null;
}
function solveEndgame(s, player, depth = 0, alpha = -Infinity, beta = Infinity, memo = new Map()) {
  const terminal = terminalScore(s, depth);
  if (terminal !== null) return terminal;
  if (depth >= 80) return evaluateState(s);
  const key = [player, s.attacker, s.tablePairs.map(p => `${p.attack}:${p.defend || '-'}`).join(','), s.myHand.slice().sort().join('.'), s.oppKnownHand.slice().sort().join('.')].join('|');
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
  if (!defending && s.tablePairs.length > 0) {
    const bito = simulateBito(s, player);
    const score = solveEndgame(bito, bito.turn, depth + 1, alpha, beta, memo);
    best = isMax ? Math.max(best, score) : Math.min(best, score);
  }
  if (!Number.isFinite(best)) best = evaluateState(s);
  memo.set(key, best);
  return best;
}
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
function moveLabel(candidate) { return candidate.type === 'CARD' ? candidate.move : candidate.move; }
function findBestEndgameMove(s = state) {
  if (s.turn !== 'me') return null;
  const candidates = candidateMoves(s);
  if (!candidates.length) return null;
  let best = candidates[0], bestScore = -Infinity;
  const memo = new Map();
  for (const candidate of candidates) {
    const next = applyCandidate(s, candidate);
    const score = solveEndgame(next, next.turn, 1, -Infinity, Infinity, memo);
    if (score > bestScore) { bestScore = score; best = candidate; }
  }
  return { move: best.move, score: bestScore };
}

// ============================================================
// HIDDEN INFORMATION MODEL
// ============================================================

function randomInt(max) { return Math.floor(Math.random() * max); }
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
  const sampled = cloneState(s);
  const opp = pool.splice(0, s.oppUnknownCount);
  sampled.oppKnownHand = [...sampled.oppKnownHand, ...opp];
  sampled.oppUnknownCount = 0;
  sampled.stockCards = pool;
  sampled.phase = 'playing';
  return sampled;
}
function cardAnswerProbability(card, s = state) {
  const pool = getUnknownPoolIds(s);
  if (!pool.length) return 0;
  return pool.filter(id => canBeat(card, id)).length / pool.length;
}
function hypergeometricZero(successes, population, draws) {
  if (successes <= 0 || draws <= 0) return 1;
  if (successes >= population) return 0;
  let p = 1;
  for (let i = 0; i < draws; i++) {
    if (population - i <= 0) return 0;
    p *= (population - successes - i) / (population - i);
    if (p <= 0) return 0;
  }
  return p;
}
function getRankProbability(rank, s = state) {
  const pool = getUnknownPoolIds(s);
  if (!pool.length || !s.oppUnknownCount) return 0;
  const matching = pool.filter(id => getCardRank(id) === rank).length;
  return 1 - hypergeometricZero(matching, pool.length, s.oppUnknownCount);
}

// ============================================================
// OPPONENT DECISION MODEL
// ============================================================
// The opponent knows their sampled hand and public information, but never
// sees the user's hidden cards. A softmax policy gives strong moves higher
// probability while retaining realistic imperfect decisions.

function opponentCandidateActions(s, player) {
  const actions = getLegalMovesForPlayer(s, player).map(card => ({ type: 'CARD', card }));
  if (needsDefense(s)) actions.push({ type: 'TAKE' });
  else if (s.tablePairs.length) actions.push({ type: 'BITO' });
  return actions;
}
function scoreAttackForPolicy(card, s, player) {
  const hand = player === 'me' ? s.myHand : s.oppKnownHand;
  const counts = hand.reduce((o, c) => { const r = getCardRank(c); o[r] = (o[r] || 0) + 1; return o; }, {});
  const rank = getCardRank(card), value = getCardValue(card);
  let score = (16 - value) * 4;
  if (counts[rank] >= 2) score += 28;
  if (counts[rank] >= 3) score += 16;
  if (isTrump(card, s)) score -= 30;
  if (!isTrump(card, s)) score += 5;
  if (hand.length <= 2) score += 20;
  const targetCount = player === 'me' ? getOpponentTotalCards(s) : s.myHand.length;
  if (targetCount <= 2) score += 20;
  score += getRankAttackPotential(rank, s, player);
  return score;
}
function scoreDefenseForPolicy(card, s, player) {
  const hand = player === 'me' ? s.myHand : s.oppKnownHand;
  const rank = getCardRank(card), count = hand.filter(c => getCardRank(c) === rank).length;
  let score = -cardStrategicValue(card, s) * 2.0;
  if (isLowCard(card)) score += 16;
  if (count >= 2) score -= 10;
  if (isTrump(card, s)) score -= 24;
  return score;
}
function scoreActionForPolicy(s, player, action) {
  if (action.type === 'TAKE') {
    const hand = player === 'me' ? s.myHand : s.oppKnownHand;
    return -getPileRisk(s) * 1.8 - getTableCardCount(s) * 10 - Math.max(0, 6 - hand.length) * 8;
  }
  if (action.type === 'BITO') return 18 + getTableCardCount(s) * 5;
  return needsDefense(s) ? scoreDefenseForPolicy(action.card, s, player) : scoreAttackForPolicy(action.card, s, player);
}
function chooseWeightedAction(s, player) {
  const actions = opponentCandidateActions(s, player);
  if (!actions.length) return null;
  const scored = actions.map(action => ({ action, score: scoreActionForPolicy(s, player, action) }));
  const max = Math.max(...scored.map(x => x.score));
  const temperature = 15;
  const weights = scored.map(x => Math.exp((x.score - max) / temperature));
  const total = weights.reduce((a, b) => a + b, 0);
  let pick = Math.random() * total;
  for (let i = 0; i < scored.length; i++) {
    pick -= weights[i];
    if (pick <= 0) return scored[i].action;
  }
  return scored[scored.length - 1].action;
}
function chooseRolloutMove(s, player) { return chooseWeightedAction(s, player); }
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
    const action = chooseRolloutMove(current, current.turn);
    if (!action) return evaluateState(current);
    current = applySearchAction(current, current.turn, action);
    if (!current) return evaluateState(s);
  }
  return evaluateState(current);
}

// ============================================================
// MOVE ANALYSIS
// ============================================================

function getMoveTacticalScore(card, s) {
  const rank = getCardRank(card), counts = getMyRankCounts(s), value = getCardValue(card);
  let score = (16 - value) * 3;
  if (counts[rank] >= 2) score += 22;
  if (counts[rank] >= 3) score += 14;
  score -= cardAnswerProbability(card, s) * 28;
  if (isTrump(card, s)) score -= 24;
  if (getOpponentTotalCards(s) <= 2) score += 18;
  return score;
}
function evaluateTake(sAfter, before) { return evaluateState(sAfter) - getPileRisk(before) * 1.7 - getTableCardCount(before) * 10; }
function deterministicMoveScore(candidate, s) {
  const next = applyCandidate(s, candidate);
  if (candidate.type === 'TAKE') return evaluateTake(next, s);
  if (candidate.type === 'BITO') return evaluateState(next);
  return evaluateState(next) + getMoveTacticalScore(candidate.move, s);
}
function analyzeMove(candidate, s, samples) {
  let wins = 0, total = 0, scoreSum = 0;
  const nextVisible = applyCandidate(s, candidate);
  for (let i = 0; i < samples; i++) {
    let sampled;
    if (s.oppUnknownCount > 0) {
      sampled = applyCandidate(sampleHiddenState(s), candidate);
    } else {
      sampled = cloneState(nextVisible);
      sampled.oppUnknownCount = 0;
      sampled.stockCards = sampled.stockCards || [];
    }
    const result = terminalScore(sampled);
    const score = result !== null ? result : rollout(sampled);
    scoreSum += score;
    if (score > 50000) wins += 1;
    else if (score > 0) wins += 0.5;
    total++;
  }
  return { candidate, equity: total ? wins / total : 0.5, avgScore: total ? scoreSum / total : 0 };
}
function analyzePosition(s = state, options = {}) {
  if (s.turn !== 'me') return null;
  const candidates = candidateMoves(s);
  if (!candidates.length) return null;
  if (isExactEndgame(s)) {
    const exact = findBestEndgameMove(s);
    return {
      mode: 'exact', samples: 0,
      best: exact ? candidates.find(c => moveLabel(c) === exact.move) || candidates[0] : candidates[0],
      moves: candidates.map(c => ({ candidate: c, equity: exact && moveLabel(c) === exact.move ? 1 : 0, avgScore: deterministicMoveScore(c, s) })).sort((a, b) => b.equity - a.equity || b.avgScore - a.avgScore)
    };
  }
  const samples = options.samples || DURAK_ANALYSIS_SAMPLES;
  const results = candidates.map(c => analyzeMove(c, s, samples));
  results.sort((a, b) => b.equity - a.equity || b.avgScore - a.avgScore);
  return { mode: 'monte-carlo', samples, best: results[0].candidate, moves: results };
}
function getSuggestionReasons(card, s) {
  if (!card || card === 'TAKE' || card === 'BITO') return [];
  const reasons = [], rank = getCardRank(card), counts = getMyRankCounts(s), answerProb = cardAnswerProbability(card, s);
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
  if (state.phase === 'drawing') { el.innerText = `DRAW PHASE: Select ${state.cardsToDraw} card(s).`; return; }
  if (state.phase === 'gameover') { el.innerText = state.winner === 'me' ? 'Game over: you won.' : 'Game over: opponent won.'; return; }
  if (state.turn !== 'me') { el.innerText = "Wait for opponent's move."; return; }
  const analysis = analyzePosition(state);
  if (!analysis) { el.innerText = 'No legal move.'; return; }
  const best = analysis.best, label = moveLabel(best), rows = analysis.moves.slice(0, 4);
  if (analysis.mode === 'exact') { el.innerHTML = `<strong>ENDGAME: ${label}</strong><br><small>Exact calculation, no hidden cards.</small>`; return; }
  const bestResult = analysis.moves[0], pct = Math.round(bestResult.equity * 100);
  const reason = label === 'TAKE' || label === 'BITO' ? 'best calculated outcome' : getSuggestionReasons(label, state).join(', ') || 'best calculated outcome';
  const alternatives = rows.map((r, i) => `${i === 0 ? 'BEST' : moveLabel(r.candidate)}: ${Math.round(r.equity * 100)}%`).join(' · ');
  el.innerHTML = `<strong>${label === 'TAKE' ? 'TAKE' : label === 'BITO' ? 'BITO' : `Play ${label}`}</strong> <span class="suggestion-confidence">${pct}% equity</span><br><small>${reason}</small><br><small>${alternatives}</small>`;
}
function debugDurakEngine() {
  const analysis = state.turn === 'me' ? analyzePosition(state, { samples: 160 }) : null;
  console.log('State:', JSON.parse(JSON.stringify(state)));
  console.log('Remaining stock:', getRemainingDeck(state));
  console.log('Unknown pool:', getUnknownPoolIds(state).length);
  console.log('Exact endgame:', isExactEndgame(state));
  console.log('Trump picked up:', !!state.trumpPickedUp);
  console.log('Pile risk:', getPileRisk(state));
  console.log('Evaluation:', evaluateState(state));
  console.table((analysis?.moves || []).map(r => ({ move: moveLabel(r.candidate), equity: `${Math.round(r.equity * 100)}%`, score: Math.round(r.avgScore) })));
  return analysis;
}
window.DurakAI = { analyzePosition, sampleHiddenState, cardAnswerProbability, getRankProbability, getUnknownPoolIds, findBestEndgameMove, solveEndgame, evaluateState, getRemainingDeck, getLegalAttacks, getLegalDefenses, simulateTake, simulateBito, simulatePlay, drawAfterBout };
