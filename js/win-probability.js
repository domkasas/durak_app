// ============================================================
// DURAK EQUITY / WIN ESTIMATE v2
// ============================================================
// This is now based on the same sampled-information analysis as the move
// suggestion engine. It is still an estimate, not a mathematically exact
// probability while hidden cards remain unknown.
// ============================================================

(function () {
  'use strict';

  let lastSignature = '';
  let lastAnalysis = null;
  let analysisBusy = false;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function stateSignature(s) {
    return [
      s.phase,
      s.turn,
      s.attacker,
      s.winner,
      s.trumpCard,
      s.oppUnknownCount,
      s.myHand.slice().sort().join(','),
      s.oppKnownHand.slice().sort().join(','),
      s.discard.slice().sort().join(','),
      s.tablePairs.map(p => `${p.attack}:${p.defend || '-'}`).join('|')
    ].join('||');
  }

  function exactWinProbability(s) {
    if (!isExactEndgame(s)) return null;
    if (s.myHand.length === 0) return 100;
    if (s.oppKnownHand.length === 0) return 0;

    const result = findBestEndgameMove(s);
    if (!result) return null;
    return result.score >= 90000 ? 100 : result.score <= -90000 ? 0 : 50;
  }

  function calculateWinProbability(s = state) {
    if (s.phase === 'gameover') return s.winner === 'me' ? 100 : 0;

    const exact = exactWinProbability(s);
    if (exact !== null) return exact;

    // The current position's best-move equity is the cleanest estimate of
    // how favorable the position is from the information available to us.
    const analysis = analyzePosition(s, { samples: 40 });
    if (!analysis || !analysis.moves.length) return 50;

    const best = analysis.moves[0];
    return clamp(Math.round(best.equity * 100), 1, 99);
  }

  function updateWinProbability() {
    const el = document.getElementById('win-probability-value');
    const box = document.getElementById('win-probability');
    const fill = box && box.querySelector('.win-probability-fill');
    if (!el || !box || typeof state === 'undefined') return;

    const signature = stateSignature(state);
    if (signature !== lastSignature && !analysisBusy) {
      lastSignature = signature;
      analysisBusy = true;

      // Defer the expensive calculation until after the board has rendered.
      setTimeout(() => {
        try {
          if (state.turn === 'me' && state.phase === 'playing') {
            lastAnalysis = analyzePosition(state, { samples: 40 });
          } else {
            lastAnalysis = null;
          }
        } finally {
          analysisBusy = false;
          renderWinProbability();
        }
      }, 0);
    }

    renderWinProbability();
  }

  function renderWinProbability() {
    const el = document.getElementById('win-probability-value');
    const box = document.getElementById('win-probability');
    const fill = box && box.querySelector('.win-probability-fill');
    if (!el || !box || typeof state === 'undefined') return;

    let probability;
    let note;

    if (state.phase === 'gameover') {
      probability = state.winner === 'me' ? 100 : 0;
      note = 'Final result.';
    } else if (state.turn !== 'me') {
      // Do not pretend the old estimate is freshly calculated while it is
      // the opponent's turn. Keep the last value but label it honestly.
      probability = lastAnalysis?.moves?.[0]?.equity != null
        ? Math.round(lastAnalysis.moves[0].equity * 100)
        : 50;
      note = 'Last calculated equity from your previous decision point.';
    } else if (lastAnalysis) {
      probability = Math.round(lastAnalysis.moves[0].equity * 100);
      note = lastAnalysis.mode === 'exact'
        ? 'Exact endgame calculation.'
        : `Monte Carlo equity, ${lastAnalysis.samples} samples per move.`;
    } else {
      probability = 50;
      note = 'Calculating...';
    }

    probability = clamp(probability, 0, 100);
    el.textContent = `${probability}%`;
    box.dataset.probability = probability;
    box.style.setProperty('--win-probability', probability);
    if (fill) fill.style.width = `${probability}%`;

    if (probability >= 90) box.dataset.level = 'dominant';
    else if (probability >= 70) box.dataset.level = 'favored';
    else if (probability <= 10) box.dataset.level = 'critical';
    else if (probability <= 30) box.dataset.level = 'behind';
    else box.dataset.level = 'even';

    const noteEl = box.querySelector('.win-probability-note');
    if (noteEl) noteEl.textContent = note;
  }

  window.calculateWinProbability = calculateWinProbability;
  window.updateWinProbability = updateWinProbability;
  window.getLastDurakAnalysis = () => lastAnalysis;

  const previousUpdatePlayingUI = window.updatePlayingUI;
  if (typeof previousUpdatePlayingUI === 'function') {
    window.updatePlayingUI = function updatePlayingUIWithWinProbability() {
      previousUpdatePlayingUI();
      updateWinProbability();
    };
  }
})();