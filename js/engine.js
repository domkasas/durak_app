// ============================================================
// DURAK AI / MOVE ENGINE
// ============================================================
// The engine is a suggestion layer. app.js remains authoritative for
// applying moves and resolving a bout.
//
// Important model:
//   state.attacker = player who started the current bout
//   state.turn     = player who must act now
//   tablePairs    = [{ attack, defend }]
//
// A defended attack returns the turn to the attacker. The attacker may
// add another legal throw-in or finish with BITO. The defender may defend
// an unanswered attack or TAKE. This is the actual Durak turn structure.
// ============================================================

const DURAK_DECK_SIZE = 24;
const DURAK_HAND_LIMIT = 6;

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
  return !!cardId && !!s.trumpCard &&
    getCardSuit(cardId) === getCardSuit(s.trumpCard);
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
    tablePairs: s.tablePairs.map(p => ({ attack: p.attack, defend: p.defend }))
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

function getRemainingDeck(s = state) {
  const knownUsed = new Set([
    ...s.myHand,
    ...s.oppKnownHand,
    ...s.discard,
    ...getTableCards(s),
    ...(s.trumpCard ? [s.trumpCard] : [])
  ]).size;

  return Math.max(0, DURAK_DECK_SIZE - knownUsed - s.oppUnknownCount);
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

function getEstimatedUnknownTrumpCount(s = state) {
  if (!s.trumpCard) return 0;
  const suit = getCardSuit(s.trumpCard);
  const total = s.allCards.filter(c => c.suit === suit).length;
  const known = [
    ...s.myHand,
    ...s.oppKnownHand,
    ...getTableCards(s),
    ...s.discard
  ].filter(c => getCardSuit(c) === suit).length;
  return Math.max(0, total - known);
}

function getTrumpScarcityMultiplier(s = state) {
  const remaining = getEstimatedUnknownTrumpCount(s);
  if (remaining <= 1) return 1.35;
  if (remaining <= 2) return 1.20;
  if (remaining <= 3) return 1.10;
  return 1;
}

// ============================================================
// CARD / POSITION VALUE
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

  // Duplicates are expendable because they preserve attack options.
  if (myCounts[rank] >= 2) score -= 7;
  if (myCounts[rank] >= 3) score -= 5;

  // Known opponent copies make this rank useful for throw-ins, so avoid
  // treating the card as completely disposable.
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

function opponentCanBeatKnown(card, s = state) {
  return countKnownAnswers(card, s) > 0;
}

function attackSafety(card, s = state) {
  const answers = countKnownAnswers(card, s);
  let score = answers === 0 ? 15 : -answers * 6;
  if (getCardValue(card) >= 13) score -= 3;
  if (isTrump(card, s)) score -= 8;
  return score;
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

// Positive means good for us.
function evaluateState(s, perspective = 'me') {
  const my = s.myHand.length;
  const opp = getOpponentTotalCards(s);

  if (my === 0 && opp === 0) return 0;
  if (my === 0) return perspective === 'me' ? 100000 : -100000;
  if (opp === 0) return perspective === 'me' ? -100000 : 100000;

  let score = (opp - my) * 100;

  // A one-card opponent is an immediate threat. A one-card own hand is
  // valuable, but only if we can actually finish the bout.
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

function getSortedHand(s = state) {
  return [...s.myHand].sort((a, b) => {
    const diff = cardStrategicValue(a, s) - cardStrategicValue(b, s);
    return diff || getCardValue(a) - getCardValue(b);
  });
}

// ============================================================
// LEGAL MOVES
// ============================================================

function getAttackLimit(s = state) {
  const defenderCount = s.turn === 'me'
    ? getOpponentTotalCards(s)
    : s.myHand.length;
  const defended = s.tablePairs.filter(p => p.defend).length;
  return Math.min(DURAK_HAND_LIMIT, defenderCount + defended);
}

function getLegalAttacks(s = state) {
  if (!s.myHand.length) return [];
  if (s.tablePairs.length >= getAttackLimit(s)) return [];

  if (!s.tablePairs.length) return [...s.myHand];
  const ranks = getTableRanks(s);
  return s.myHand.filter(card => ranks.has(getCardRank(card)));
}

function getLegalDefenses(s = state) {
  const pair = getLastPair(s);
  if (!pair || pair.defend) return [];
  return s.myHand.filter(card => canBeat(pair.attack, card));
}

function getLegalMovesForPlayer(s, player) {
  const hand = player === 'me' ? s.myHand : s.oppKnownHand;
  if (!hand.length) return [];

  if (needsDefense(s)) {
    return hand.filter(card => canBeat(getLastPair(s).attack, card));
  }

  if (!s.tablePairs.length) return [...hand];
  const ranks = getTableRanks(s);
  return hand.filter(card => ranks.has(getCardRank(card)));
}

// ============================================================
// SIMULATION
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

function simulateTake(s, player) {
  const next = cloneState(s);
  const cards = getTableCards(next);
  if (player === 'me') next.myHand.push(...cards);
  else next.oppKnownHand.push(...cards);
  next.tablePairs = [];
  next.turn = player === 'me' ? 'opp' : 'me';
  next.attacker = player === 'me' ? 'opp' : 'me';
  return next;
}

function simulateBito(s, player) {
  const next = cloneState(s);
  next.discard.push(...getTableCards(next));
  next.tablePairs = [];
  next.attacker = player === 'me' ? 'opp' : 'me';
  next.turn = next.attacker;
  return next;
}

// ============================================================
// HEURISTIC DECISIONS
// ============================================================

function evaluateAttack(card, s = state) {
  let score = 0;
  const rank = getCardRank(card);
  const value = getCardValue(card);
  const counts = getMyRankCounts(s);
  const answers = countKnownAnswers(card, s);

  // Dumping cheap cards is usually good, but duplicate rank attacks are
  // even more valuable because they retain future legal throw-ins.
  score += (16 - value) * 4;
  if (counts[rank] >= 2) score += 32;
  if (counts[rank] >= 3) score += 20;
  score += getAttackPotential(card, s) * 1.7;
  score += attackSafety(card, s) * 2;

  if (isTrump(card, s)) score -= 28;

  // Do not blindly attack a known answer. When the opponent has a short
  // hand, however, pressure becomes more important.
  if (answers > 0) score -= answers * 7;
  if (getOpponentTotalCards(s) <= 2) score += 18;

  // Throwing a high singleton early can be good bait, but only if it is
  // currently safe and we have no duplicate of its rank.
  if (!isTrump(card, s) && value >= 13 && counts[rank] === 1 && answers === 0) {
    score += 12;
  }

  const next = simulatePlay(s, 'me', card);
  score += evaluateState(next) * 0.12;
  return score;
}

function chooseBestAttack(s = state) {
  const attacks = getLegalAttacks(s);
  if (!attacks.length) return null;
  let best = attacks[0];
  let bestScore = -Infinity;
  for (const card of attacks) {
    const score = evaluateAttack(card, s);
    if (score > bestScore) {
      bestScore = score;
      best = card;
    }
  }
  return { card: best, score: bestScore };
}

function evaluateDefense(card, s = state) {
  const pair = getLastPair(s);
  if (!pair) return -Infinity;

  let score = -cardStrategicValue(card, s) * 2.5;
  const rank = getCardRank(card);
  const count = getMyRankCounts(s)[rank] || 0;

  // Prefer the weakest legal card that works.
  if (isLowCard(card)) score += 10;
  if (count >= 2) score -= 10;
  if (count >= 3) score -= 7;

  if (isTrump(card, s)) {
    score -= 18;
    if (getCardValue(card) >= 12) score -= 12;
  }

  if (!isTrump(pair.attack, s) && !isTrump(card, s)) score += 8;

  // Against a nearly empty opponent, conserving the ability to continue
  // attacking matters more than making a pretty defense.
  if (getOpponentTotalCards(s) <= 2) score += 10;

  score += evaluateState(simulatePlay(s, 'me', card)) * 0.12;
  return score;
}

function chooseBestDefense(s = state) {
  const defenses = getLegalDefenses(s);
  if (!defenses.length) return null;
  let best = defenses[0];
  let bestScore = -Infinity;
  for (const card of defenses) {
    const score = evaluateDefense(card, s);
    if (score > bestScore) {
      bestScore = score;
      best = card;
    }
  }
  return { card: best, score: bestScore };
}

function evaluateTake(s = state) {
  const pile = getTableCards(s);
  if (!pile.length) return -Infinity;
  let score = evaluateState(simulateTake(s, 'me'));
  score -= getPileRisk(s) * 2.0;
  score -= pile.length * 8;
  if (getOpponentTotalCards(s) <= 2) score -= 100;
  return score;
}

function evaluateBestDefenseVsTake(s = state) {
  const defenses = getLegalDefenses(s);
  if (!defenses.length) {
    return { action: 'TAKE', card: null, score: evaluateTake(s) };
  }

  let bestDefense = defenses[0];
  let bestDefenseScore = -Infinity;
  for (const card of defenses) {
    const score = evaluateDefense(card, s);
    if (score > bestDefenseScore) {
      bestDefenseScore = score;
      bestDefense = card;
    }
  }

  const takeScore = evaluateTake(s);
  return takeScore > bestDefenseScore
    ? { action: 'TAKE', card: null, score: takeScore }
    : { action: 'DEFEND', card: bestDefense, score: bestDefenseScore };
}

// ============================================================
// EXACT ENDGAME SOLVER
// ============================================================
// This replaces the old alternating-move minimax. In Durak, the attacker
// gets the turn back after every successful defense, so simply alternating
// players after every card produces illegal strategic lines.
// ============================================================

function terminalScore(s, depth) {
  const my = s.myHand.length;
  const opp = s.oppKnownHand.length;
  if (my === 0 && opp === 0) return 0;
  if (my === 0) return 100000 - depth;
  if (opp === 0) return -100000 + depth;
  return null;
}

function solveEndgame(s, player, depth = 0, alpha = -Infinity, beta = Infinity, memo = new Map()) {
  const terminal = terminalScore(s, depth);
  if (terminal !== null) return terminal;

  const key = [
    player,
    s.attacker,
    s.tablePairs.map(p => `${p.attack}:${p.defend || '-'}`).join(','),
    s.myHand.slice().sort().join('.'),
    s.oppKnownHand.slice().sort().join('.')
  ].join('|');

  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  // Endgame states should be small, but cap recursion defensively.
  if (depth >= 80) return evaluateState(s);

  const defending = needsDefense(s);
  let moves;

  if (defending) {
    moves = getLegalMovesForPlayer(s, player);
  } else {
    moves = getLegalMovesForPlayer(s, player);
  }

  // If attacker has a completed table, BITO is always a legal resolution.
  const canBito = !defending && s.tablePairs.length > 0;
  const isMax = player === 'me';
  let best = isMax ? -Infinity : Infinity;

  // Defending player can also TAKE when no defense is selected. Model it as
  // an explicit option, rather than pretending TAKE is a card move.
  if (defending) {
    const taken = simulateTake(s, player);
    const score = solveEndgame(taken, taken.turn, depth + 1, alpha, beta, memo);
    best = isMax ? Math.max(best, score) : Math.min(best, score);
    if (isMax) alpha = Math.max(alpha, best);
    else beta = Math.min(beta, best);
  }

  for (const card of moves) {
    const next = simulatePlay(s, player, card);
    const score = solveEndgame(next, next.turn, depth + 1, alpha, beta, memo);
    best = isMax ? Math.max(best, score) : Math.min(best, score);
    if (isMax) alpha = Math.max(alpha, best);
    else beta = Math.min(beta, best);
    if (beta <= alpha) break;
  }

  if (canBito && beta > alpha) {
    const bito = simulateBito(s, player);
    const score = solveEndgame(bito, bito.turn, depth + 1, alpha, beta, memo);
    best = isMax ? Math.max(best, score) : Math.min(best, score);
  }

  if (best === Infinity || best === -Infinity) best = evaluateState(s);
  memo.set(key, best);
  return best;
}

function findBestEndgameMove(s = state) {
  if (s.turn !== 'me') return null;

  const defending = needsDefense(s);
  const moves = getLegalMovesForPlayer(s, 'me');
  const candidates = moves.map(card => ({ type: 'CARD', move: card }));

  if (defending) candidates.push({ type: 'TAKE', move: 'TAKE' });
  else if (s.tablePairs.length > 0) candidates.push({ type: 'BITO', move: 'BITO' });

  if (!candidates.length) return null;

  let best = candidates[0];
  let bestScore = -Infinity;
  const memo = new Map();

  for (const candidate of candidates) {
    let next;
    if (candidate.type === 'TAKE') next = simulateTake(s, 'me');
    else if (candidate.type === 'BITO') next = simulateBito(s, 'me');
    else next = simulatePlay(s, 'me', candidate.move);

    const score = solveEndgame(next, next.turn, 1, -Infinity, Infinity, memo);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return { move: best.move, score: bestScore };
}

// ============================================================
// SUGGESTION UI
// ============================================================

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

  if (isExactEndgame(state)) {
    const result = findBestEndgameMove(state);
    if (!result) {
      el.innerText = 'No legal move.';
      return;
    }
    if (result.move === 'TAKE') {
      el.innerText = 'ENDGAME: TAKE.';
      return;
    }
    if (result.move === 'BITO') {
      el.innerText = 'ENDGAME: Click BITO.';
      return;
    }
    el.innerText = `ENDGAME: Play ${result.move}.`;
    return;
  }

  if (needsDefense(state)) {
    const defenses = getLegalDefenses(state);
    if (!defenses.length) {
      el.innerText = 'No valid defense. You must Take.';
      return;
    }

    const decision = evaluateBestDefenseVsTake(state);
    if (decision.action === 'TAKE') {
      el.innerText = `TAKE. Pile: ${getTableCardCount(state)} cards, risk ${Math.round(getPileRisk(state))}.`;
      return;
    }

    const card = decision.card;
    let reason = isTrump(card, state)
      ? 'cheapest available trump'
      : isLowCard(card)
        ? 'cheap defense'
        : 'best resulting position';
    el.innerText = `Defend with ${card} (${reason}).`;
    return;
  }

  const attacks = getLegalAttacks(state);
  if (!attacks.length) {
    el.innerText = state.tablePairs.length ? 'No valid attacks. Click BITO.' : 'No valid attack.';
    return;
  }

  const result = chooseBestAttack(state);
  const card = result.card;
  const rank = getCardRank(card);
  const counts = getMyRankCounts(state);
  const answers = countKnownAnswers(card, state);

  let reason;
  if (counts[rank] >= 3) reason = 'triple pressure';
  else if (counts[rank] >= 2) reason = 'pair pressure';
  else if (!isTrump(card, state) && getCardValue(card) <= 10) reason = 'dump low card';
  else if (answers === 0) reason = 'no known answer';
  else if (getOpponentTotalCards(state) <= 2) reason = 'pressure short hand';
  else reason = 'best overall position';

  if (isTrump(card, state)) reason += ', costs trump';
  el.innerText = `Attack with ${card} (${reason}).`;
}

// ============================================================
// DEBUG
// ============================================================

function debugDurakEngine() {
  console.table(getLegalAttacks(state).map(card => ({
    card,
    value: getCardValue(card),
    trump: isTrump(card, state),
    strategicValue: Math.round(cardStrategicValue(card, state) * 100) / 100,
    attackScore: Math.round(evaluateAttack(card, state) * 100) / 100,
    knownAnswers: countKnownAnswers(card, state)
  })));

  console.table(getLegalDefenses(state).map(card => ({
    card,
    value: getCardValue(card),
    trump: isTrump(card, state),
    strategicValue: Math.round(cardStrategicValue(card, state) * 100) / 100,
    defenseScore: Math.round(evaluateDefense(card, state) * 100) / 100
  })));

  console.log('State:', JSON.parse(JSON.stringify(state)));
  console.log('Remaining deck:', getRemainingDeck(state));
  console.log('Exact endgame:', isExactEndgame(state));
  console.log('Pile risk:', getPileRisk(state));
  console.log('Evaluation:', evaluateState(state));
}
