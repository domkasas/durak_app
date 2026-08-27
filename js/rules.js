const RANK_VALUES = {
  '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
  'J': 11, 'Q': 12, 'K': 13, 'A': 14
};

function canBeat(attackId, defendId) {
  // Ensure the state exists and a trump card is set
  if (!state || !state.trumpCard) return false;

  const trumpSuit = state.trumpCard.slice(-1);
  
  const attSuit = attackId.slice(-1);
  const defSuit = defendId.slice(-1);
  
  const attVal = RANK_VALUES[attackId.slice(0, -1)];
  const defVal = RANK_VALUES[defendId.slice(0, -1)];

  // If the suits match, the higher value wins
  if (defSuit === attSuit) {
    return defVal > attVal;
  }
  
  // If the suits are different, the defense only wins if it's a trump card against a non-trump
  if (defSuit === trumpSuit && attSuit !== trumpSuit) {
    return true;
  }
  
  return false;
}