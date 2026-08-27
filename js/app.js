const SUITS = ['♠', '♥', '♦', '♣'];
const SUIT_NAMES = { '♠': 'spades', '♥': 'hearts', '♦': 'diamonds', '♣': 'clubs' };
const RANKS = ['9', '10', 'J', 'Q', 'K', 'A'];

let state = {
  phase: 'setup',
  cardsToDraw: 0,
  setupStep: 'hand',
  turn: null, 
  attacker: null,
  deckSize: 24,
  trumpCard: null,
  trumpPickedUp: false,
  myHand: [],
  oppKnownHand: [],
  oppUnknownCount: 6,
  tablePairs: [],
  discard: [],
  winner: null,
  allCards: []
};

function formatCard(id) {
  if (!id) return '?';
  return `<span class="c-rank">${id.slice(0, -1)}</span><span class="c-suit">${id.slice(-1)}</span>`;
}

function getTrumpClass(id) {
  if (!state.trumpCard || !id || id === '?') return '';
  return id.slice(-1) === state.trumpCard.slice(-1) ? ' trump-glow' : '';
}

// Initialize all cards
RANKS.forEach(r => {
  SUITS.forEach(s => {
    state.allCards.push({ id: `${r}${s}`, suit: s, suitName: SUIT_NAMES[s] });
  });
});

let stateHistory = [];

function getTableCards() {
  return state.tablePairs.flatMap(pair => [pair.attack, pair.defend].filter(Boolean));
}

function getUsedCardIds() {
  return new Set([
    ...state.myHand,
    ...state.oppKnownHand,
    ...state.discard,
    ...getTableCards(),
    ...(state.trumpCard ? [state.trumpCard] : [])
  ]);
}

function getAvailableStock() {
  return Math.max(0, state.deckSize - getUsedCardIds().size - state.oppUnknownCount);
}

function getDefenderCardCount() {
  return state.turn === 'me'
    ? state.oppKnownHand.length + state.oppUnknownCount
    : state.myHand.length;
}

function canAttack(cardId) {
  const lastPair = state.tablePairs[state.tablePairs.length - 1];
  const tableRanks = new Set(getTableCards().map(card => card.slice(0, -1)));
  
  // Add the cards already used for defense in this bout back to the current hand size
  const cardsDefended = state.tablePairs.filter(p => p.defend).length;
  const attackLimit = Math.min(6, getDefenderCardCount() + cardsDefended);
  
  if (state.tablePairs.length >= attackLimit) return false;
  return !lastPair || tableRanks.has(cardId.slice(0, -1));
}

function canResolveBout(action) {
  if (state.phase !== 'playing' || state.tablePairs.length === 0) return false;
  const needsDefense = state.tablePairs.some(pair => !pair.defend);
  
  if (action === 'bito') return !needsDefense;
  if (action === 'take') return needsDefense; 
  return false;
}

function checkGameOver() {
  if (state.phase === 'drawing' || getAvailableStock() > 0) return;
  const opponentCards = state.oppKnownHand.length + state.oppUnknownCount;
  if (state.myHand.length === 0) state.winner = 'me';
  if (opponentCards === 0) state.winner = 'opp';
  if (state.winner) state.phase = 'gameover';
}

function saveState() {
  stateHistory.push(JSON.parse(JSON.stringify(state)));
}

function undo() {
  if (stateHistory.length > 0) {
    state = stateHistory.pop();
    updatePlayingUI();
  }
}

function renderSetup() {
  const grid = document.getElementById('setup-palette');
  grid.innerHTML = '';
  
  // Create Column Headers
  const emptyHead = document.createElement('div');
  emptyHead.className = 'grid-header';
  grid.appendChild(emptyHead);
  
  SUITS.forEach(s => {
    const colHead = document.createElement('div');
    colHead.className = `grid-header suit-header ${SUIT_NAMES[s]}`;
    colHead.innerText = s;
    grid.appendChild(colHead);
  });

  // Create Rows (Rank header + 4 suit cards)
  RANKS.forEach(r => {
    const rowHead = document.createElement('div');
    rowHead.className = 'grid-header rank-header';
    rowHead.innerText = r;
    grid.appendChild(rowHead);

    SUITS.forEach(s => {
      const cardId = `${r}${s}`;
      const card = state.allCards.find(c => c.id === cardId);
      const el = document.createElement('div');
      el.className = `card ${card.suitName}`;
      el.innerHTML = formatCard(card.id);
      el.onclick = () => handleSetupClick(card.id, el);
      grid.appendChild(el);
    });
  });
}

function handleSetupClick(cardId, element) {
  if (state.setupStep === 'hand') {
    if (state.myHand.includes(cardId)) {
      state.myHand = state.myHand.filter(c => c !== cardId);
      element.style.opacity = '1';
    } else if (state.myHand.length < 6) {
      state.myHand.push(cardId);
      element.style.opacity = '0.3';
    }
    if (state.myHand.length === 6) {
      state.setupStep = 'trump';
      document.getElementById('setup-instruction').innerText = '2. Click the Trump Card';
    }
  } else if (state.setupStep === 'trump') {
    if (state.myHand.includes(cardId)) {
      state.myHand = state.myHand.filter(card => card !== cardId);
      state.setupStep = 'hand';
      state.trumpCard = null;
      document.getElementById('setup-instruction').innerText = `1. Click your ${6 - state.myHand.length} remaining starting card(s)`;
      document.getElementById('btn-start-me').disabled = true;
      document.getElementById('btn-start-opp').disabled = true;
      renderSetup();
    } else {
      state.trumpCard = cardId;
      document.getElementById('setup-instruction').innerText = `Trump: ${cardId}. 3. Who starts?`;
      document.getElementById('btn-start-me').disabled = false;
      document.getElementById('btn-start-opp').disabled = false;
    }
  }
}

function startGame(startingTurn) {
  state.phase = 'playing';
  state.turn = startingTurn;
  state.attacker = startingTurn;
  document.getElementById('setup-panel').style.display = 'none';
  document.getElementById('game-panel').style.display = 'flex';
  updatePlayingUI();
}

function handlePlayClick(cardId) {
  if (state.phase === 'drawing') {
    if (state.myHand.includes(cardId) || getUsedCardIds().has(cardId)) return;
    saveState();
    state.myHand.push(cardId);
    state.cardsToDraw -= 1;
    
    if (state.cardsToDraw <= 0) {
      state.phase = 'playing';
      // NEW: Force calculation of opponent's remaining cards immediately after drawing
      deduceOpponentHand(); 
    }
    
    checkGameOver();
    updatePlayingUI();
    return;
  }

  if (state.phase !== 'playing') return;

  // Block clicking your own hand when it is the opponent's turn
  if (state.turn === 'opp' && state.myHand.includes(cardId)) {
    alert("It is the opponent's turn! Select their card from the main palette, not your hand.");
    return;
  }

  const lastPair = state.tablePairs[state.tablePairs.length - 1];
  const needsDefense = lastPair && !lastPair.defend;

  function removeOpponentCard(id) {
    if (state.oppKnownHand.includes(id)) {
      state.oppKnownHand = state.oppKnownHand.filter(c => c !== id);
    } else {
      state.oppUnknownCount = Math.max(0, state.oppUnknownCount - 1);
    }
  }

  if (state.turn === 'opp') {
    if (!needsDefense) {
      if (!canAttack(cardId)) return;
      saveState();
      state.tablePairs.push({ attack: cardId, defend: null });
      removeOpponentCard(cardId);
      state.turn = 'me';
    } else {
      if (!canBeat(lastPair.attack, cardId)) {
        alert("Invalid move: Card cannot beat the attack.");
        return;
      }
      saveState();
      lastPair.defend = cardId;
      removeOpponentCard(cardId);
      state.turn = 'me';
    }
  } else if (state.turn === 'me') {
    if (needsDefense && state.myHand.includes(cardId)) {
      if (!canBeat(lastPair.attack, cardId)) {
        alert("Invalid move: Card cannot beat the attack.");
        return;
      }
      saveState();
      lastPair.defend = cardId;
      state.myHand = state.myHand.filter(c => c !== cardId);
      state.turn = 'opp';
    } else if (!needsDefense && state.myHand.includes(cardId)) {
      if (!canAttack(cardId)) return;
      saveState();
      state.tablePairs.push({ attack: cardId, defend: null });
      state.myHand = state.myHand.filter(c => c !== cardId);
      state.turn = 'opp';
    }
  }
  updatePlayingUI();
}

function resolveBout(action) {
  if (!canResolveBout(action)) return;
  saveState();
  const currentCards = getTableCards();
  let nextAttacker = state.attacker;
  let nextTurn = state.attacker;

  if (action === 'bito') {
    state.discard.push(...currentCards);
    nextAttacker = state.attacker === 'me' ? 'opp' : 'me';
    nextTurn = nextAttacker;
  } else if (action === 'take') {
    if (state.turn === 'me') {
      state.myHand.push(...currentCards);
      nextAttacker = 'opp';
      nextTurn = 'opp';
    } else {
      state.oppKnownHand.push(...currentCards);
      nextAttacker = 'me';
      nextTurn = 'me';
    }
  }

  state.tablePairs = [];
  let myTotal = state.myHand.length;
  let oppTotal = state.oppKnownHand.length + state.oppUnknownCount;
  let availableToDraw = getAvailableStock();
  const myNeed = Math.max(0, 6 - myTotal);
  const oppNeed = Math.max(0, 6 - oppTotal);
  let myDraw = 0;
  let oppDraw = 0;

  if (state.attacker === 'me') {
    myDraw = Math.min(availableToDraw, myNeed);
    availableToDraw -= myDraw;
    oppDraw = Math.min(availableToDraw, oppNeed);
    availableToDraw -= oppDraw;
  } else {
    oppDraw = Math.min(availableToDraw, oppNeed);
    availableToDraw -= oppDraw;
    myDraw = Math.min(availableToDraw, myNeed);
    availableToDraw -= myDraw;
  }

  if (!state.trumpPickedUp && myDraw + oppDraw < myNeed + oppNeed) {
    let trumpGoesTo = (state.attacker === 'me') 
      ? (oppNeed > 0 ? 'opp' : 'me') 
      : (myNeed > 0 ? 'me' : 'opp');
    
    if (trumpGoesTo === 'me') {
      state.myHand.push(state.trumpCard);
    } else {
      state.oppKnownHand.push(state.trumpCard);
    }
    state.trumpPickedUp = true;
  }

  state.oppUnknownCount += oppDraw;
  state.attacker = nextAttacker;
  state.turn = nextTurn;

  if (myDraw > 0) {
    state.phase = 'drawing';
    state.cardsToDraw = myDraw;
  }

  deduceOpponentHand();
  checkGameOver();
  updatePlayingUI();
}

function deduceOpponentHand() {
  const usedCards = getUsedCardIds();
  
  const remainingDeck = state.deckSize - (usedCards.size + state.oppUnknownCount);
  
  if (remainingDeck === 0 && state.oppUnknownCount > 0) {
    state.allCards.forEach(c => {
      if (!usedCards.has(c.id)) {
        state.oppKnownHand.push(c.id);
      }
    });
    state.oppUnknownCount = 0;
  }
}

function updatePlayingUI() {
  const turnEl = document.getElementById('turn-indicator');
  if (state.phase === 'drawing') {
    turnEl.innerText = `DRAW PHASE: Select ${state.cardsToDraw} card(s) you drew from the deck.`;
    turnEl.style.color = "#10b981"; 
  } else {
    turnEl.style.color = "#fbbf24"; 
    const needsDefense = state.tablePairs.length > 0 && !state.tablePairs[state.tablePairs.length - 1].defend;
    
    // Dynamically rename the take button
    const takeBtn = document.getElementById('btn-take');
    if (takeBtn) takeBtn.innerText = state.turn === 'me' ? "I Take" : "He Takes";

    if (state.turn === 'opp') {
      turnEl.innerText = needsDefense ? "Opponent's Turn: Select what they defend with" : "Opponent's Turn: Select what they threw (Attack)";
    } else {
      turnEl.innerText = needsDefense ? "Your Turn: Click a card from your hand to defend" : "Your Turn: Click a card from your hand to attack";
    }
  }

  // Draw My Hand
  const myHandHTML = state.myHand.map(c => `<div class="card ${SUIT_NAMES[c.slice(-1)]}${getTrumpClass(c)}" onclick="handlePlayClick('${c}')">${formatCard(c)}</div>`).join('');
  document.getElementById('my-hand').innerHTML = myHandHTML;
  
  const quickMyHandEl = document.getElementById('quick-my-hand');
  if (quickMyHandEl) quickMyHandEl.innerHTML = myHandHTML;

  // Draw Opponent Hand
  document.getElementById('opp-count').innerText = state.oppUnknownCount + state.oppKnownHand.length;
  
  const oppKnownHTML = state.oppKnownHand.map(c => 
    `<div class="card ${SUIT_NAMES[c.slice(-1)]}${getTrumpClass(c)}" onclick="handlePlayClick('${c}')">${formatCard(c)}</div>`
  ).join('');
  
  // Combine known cards and unknown face-down cards
  let oppHandHTML = oppKnownHTML + Array(state.oppUnknownCount).fill('<div class="card-back-sm"></div>').join('');

  // Send to Quick Access panel
  const quickOppHandEl = document.getElementById('quick-opp-hand');
  if (quickOppHandEl) quickOppHandEl.innerHTML = oppHandHTML;

  // Render on main board
  document.getElementById('opp-hand-unknown').innerHTML = oppHandHTML;

  // Draw Table
  document.getElementById('active-bouts').innerHTML = state.tablePairs.map(p => `
    <div class="bout-pair">
      <div class="card ${SUIT_NAMES[p.attack.slice(-1)]}${getTrumpClass(p.attack)}">${formatCard(p.attack)}</div>
      ${p.defend ? `<div class="card bout-defend ${SUIT_NAMES[p.defend.slice(-1)]}${getTrumpClass(p.defend)}">${formatCard(p.defend)}</div>` : ''}
    </div>
  `).join('');

  // Update Deck & Trump
  const deckContainer = document.getElementById('deck-container');
  const tableCardsCount = state.tablePairs.flatMap(p => [p.attack, p.defend].filter(Boolean)).length;
  
  if (state.trumpPickedUp) {
    deckContainer.style.visibility = 'hidden';
  } else {
    deckContainer.style.visibility = 'visible';
    const remainingDeck = state.deckSize - (state.myHand.length + state.oppKnownHand.length + state.oppUnknownCount + state.discard.length + tableCardsCount);
    document.getElementById('deck-count').innerText = Math.max(0, remainingDeck);
    
    const trumpEl = document.getElementById('trump-card');
    trumpEl.className = `card trump-rotate ${SUIT_NAMES[state.trumpCard.slice(-1)]}${getTrumpClass(state.trumpCard)}`;
    trumpEl.innerHTML = formatCard(state.trumpCard);
  }

  // Draw Control Panel Palette
  const usedCards = new Set([...state.myHand, ...state.discard, state.trumpCard, ...state.tablePairs.flatMap(p => [p.attack, p.defend].filter(Boolean))]);
  const paletteEl = document.getElementById('play-palette');
  paletteEl.innerHTML = '';
  
  const emptyHead = document.createElement('div');
  emptyHead.className = 'grid-header';
  paletteEl.appendChild(emptyHead);
  
  SUITS.forEach(s => {
    const colHead = document.createElement('div');
    colHead.className = `grid-header suit-header ${SUIT_NAMES[s]}`;
    colHead.innerText = s;
    paletteEl.appendChild(colHead);
  });

  RANKS.forEach(r => {
    const rowHead = document.createElement('div');
    rowHead.className = 'grid-header rank-header';
    rowHead.innerText = r;
    paletteEl.appendChild(rowHead);

    SUITS.forEach(s => {
      const cardId = `${r}${s}`;
      const card = state.allCards.find(c => c.id === cardId);
      
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `card ${card.suitName}${getTrumpClass(card.id)}`;
      el.innerHTML = formatCard(card.id);
      
      const isDrawingPhase = state.phase === 'drawing';
      
      if (usedCards.has(card.id) || (isDrawingPhase && state.oppKnownHand.includes(card.id))) {
        el.classList.add('used');
        el.disabled = true;
      } else {
        el.onclick = () => handlePlayClick(card.id);
      }
      
      paletteEl.appendChild(el);
    });
  });
  
  if (typeof updateSuggestion === "function") {
      updateSuggestion();
  }
}

renderSetup();