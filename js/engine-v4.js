// ============================================================
// DURAK AI / MOVE ENGINE v4
// ============================================================
// Monte Carlo equity is a real simulated win rate, not a heuristic score
// converted into a fake probability. 100% is reserved for exact endgame
// positions. Hidden hands and stock order are sampled without replacement.
// Opponent rollouts use a strong adversarial policy.
// ============================================================

const DURAK_DECK_SIZE = 24;
const DURAK_HAND_LIMIT = 6;
const DURAK_ANALYSIS_SAMPLES = 160;
const DURAK_ROLLOUT_DEPTH = 160;

function getCardRank(id){return typeof id==='string'?id.slice(0,-1):'';}
function getCardSuit(id){return typeof id==='string'?id.slice(-1):'';}
function getCardValue(id){return RANK_VALUES[getCardRank(id)]??0;}
function isTrump(id,s=state){return !!id&&!!s.trumpCard&&getCardSuit(id)===getCardSuit(s.trumpCard);}
function getTableCards(s=state){return(s.tablePairs||[]).flatMap(p=>[p.attack,p.defend].filter(Boolean));}
function getTableRanks(s=state){return new Set(getTableCards(s).map(getCardRank));}
function getLastPair(s=state){return s.tablePairs?.[s.tablePairs.length-1]||null;}
function needsDefense(s=state){const p=getLastPair(s);return!!p&&!p.defend;}
function getOpponentTotalCards(s=state){return s.oppKnownHand.length+s.oppUnknownCount;}
function getMyRankCounts(s=state){return s.myHand.reduce((a,c)=>(a[getCardRank(c)]=(a[getCardRank(c)]||0)+1,a),{});}
function cloneState(s){return{...s,myHand:[...s.myHand],oppKnownHand:[...s.oppKnownHand],discard:[...s.discard],tablePairs:(s.tablePairs||[]).map(p=>({attack:p.attack,defend:p.defend})),stockCards:s.stockCards?[...s.stockCards]:undefined,allCards:s.allCards?[...s.allCards]:undefined};}
function getUsedCardIds(s=state){return new Set([...s.myHand,...s.oppKnownHand,...s.discard,...getTableCards(s),...(s.trumpCard?[s.trumpCard]:[])]);}
function getRemainingDeck(s=state){return Math.max(0,DURAK_DECK_SIZE-getUsedCardIds(s).size-s.oppUnknownCount);}
function getUnknownPoolIds(s=state){const used=getUsedCardIds(s);return s.allCards.map(c=>c.id).filter(id=>!used.has(id));}

// ============================================================
// RULES
// ============================================================
function canBeatWithState(attack,defend,s){if(!attack||!defend||!s.trumpCard)return false;const as=getCardSuit(attack),ds=getCardSuit(defend),ts=getCardSuit(s.trumpCard),av=getCardValue(attack),dv=getCardValue(defend);if(as===ds)return dv>av;return ds===ts&&as!==ts;}
function getAttackLimit(s=state){const defenderCount=s.turn==='me'?getOpponentTotalCards(s):s.myHand.length;const defended=s.tablePairs.filter(p=>p.defend).length;return Math.min(6,defenderCount+defended);}
function getLegalAttacks(s,player){const hand=player==='me'?s.myHand:s.oppKnownHand;if(!hand.length||s.tablePairs.length>=getAttackLimit(s))return[];if(!s.tablePairs.length)return[...hand];const ranks=getTableRanks(s);return hand.filter(c=>ranks.has(getCardRank(c)));}
function getLegalDefenses(s,player){const p=getLastPair(s);if(!p||p.defend)return[];const hand=player==='me'?s.myHand:s.oppKnownHand;return hand.filter(c=>canBeatWithState(p.attack,c,s));}
function getLegalMoves(s,player){return needsDefense(s)?getLegalDefenses(s,player):getLegalAttacks(s,player);}

// ============================================================
// RULE-FAITHFUL SIMULATION
// ============================================================
function removeCard(s,player,card){const hand=player==='me'?s.myHand:s.oppKnownHand,i=hand.indexOf(card);if(i>=0)hand.splice(i,1);}
function simulatePlay(s,player,card){const n=cloneState(s);removeCard(n,player,card);if(needsDefense(n)){n.tablePairs[n.tablePairs.length-1].defend=card;n.turn=n.attacker;}else{n.tablePairs.push({attack:card,defend:null});n.turn=player==='me'?'opp':'me';}return n;}
function drawOne(s,player){if(!s.stockCards?.length)return false;const hand=player==='me'?s.myHand:s.oppKnownHand;if(hand.length>=6)return false;hand.push(s.stockCards.shift());return true;}
function drawAfterBout(s,first,second){for(const player of[first,second]){const hand=player==='me'?s.myHand:s.oppKnownHand;while(hand.length<6&&drawOne(s,player)){} }if(!s.trumpPickedUp&&(!s.stockCards||s.stockCards.length===0)){for(const player of[first,second]){const hand=player==='me'?s.myHand:s.oppKnownHand;if(hand.length<6){hand.push(s.trumpCard);s.trumpPickedUp=true;break;}}}}
function simulateResolveBout(s,action,player){const n=cloneState(s),cards=getTableCards(n),attacker=n.attacker,defender=attacker==='me'?'opp':'me';if(action==='TAKE'){(player==='me'?n.myHand:n.oppKnownHand).push(...cards);n.tablePairs=[];n.attacker=attacker;n.turn=attacker;drawAfterBout(n,attacker,defender);}else{n.discard.push(...cards);n.tablePairs=[];n.attacker=defender;n.turn=defender;drawAfterBout(n,defender,attacker);}return n;}
function simulateTake(s,p){return simulateResolveBout(s,'TAKE',p);}
function simulateBito(s,p){return simulateResolveBout(s,'BITO',p);}

// ============================================================
// EVALUATION / OPPONENT POLICY
// ============================================================
function cardCost(c,s){let x=getCardValue(c);if(isTrump(c,s))x+=18;if(getCardValue(c)>=13)x+=4;return x;}
function pileRisk(s){return getTableCards(s).reduce((x,c)=>x+cardCost(c,s),0);}
function evaluatePosition(s){const my=s.myHand.length,opp=getOpponentTotalCards(s);if(my===0&&opp===0)return 0;if(my===0)return 100000;if(opp===0)return-100000;let x=(opp-my)*140;x-=s.myHand.reduce((a,c)=>a+cardCost(c,s),0)*2;x+=s.oppKnownHand.reduce((a,c)=>a+cardCost(c,s),0)*1.5;const mc=getMyRankCounts(s);for(const r in mc){if(mc[r]>=2)x+=20;if(mc[r]>=3)x+=25;}if(needsDefense(s))x-=pileRisk(s)*2;if(opp<=2)x-=120;if(my<=2)x+=100;return x;}
function actionList(s,player){const out=getLegalMoves(s,player).map(card=>({type:'CARD',card}));if(needsDefense(s))out.push({type:'TAKE'});else if(s.tablePairs.length)out.push({type:'BITO'});return out;}
function applyAction(s,player,a){if(a.type==='TAKE')return simulateTake(s,player);if(a.type==='BITO')return simulateBito(s,player);return simulatePlay(s,player,a.card);}
function policyScore(s,player,a){const next=applyAction(s,player,a);if(a.type==='TAKE')return evaluatePosition(next)-pileRisk(s)*3;if(a.type==='BITO')return evaluatePosition(next);let x=evaluatePosition(next),hand=player==='me'?s.myHand:s.oppKnownHand,rank=getCardRank(a.card),count=hand.filter(c=>getCardRank(c)===rank).length;if(!needsDefense(s)){if(count>=2)x+=45;if(getCardValue(a.card)<=10)x+=15;if(isTrump(a.card,s))x-=45;}else{if(isTrump(a.card,s))x-=25;if(getCardValue(a.card)<=10)x+=20;}return x;}
function chooseRolloutAction(s,player){const actions=actionList(s,player);if(!actions.length)return null;const scored=actions.map(a=>({a,score:policyScore(s,player,a)}));const best=player==='me'?Math.max(...scored.map(x=>x.score)):Math.min(...scored.map(x=>x.score));const near=scored.filter(x=>Math.abs(x.score-best)<=18);return near[Math.floor(Math.random()*near.length)].a;}
function terminalResult(s){if(s.myHand.length===0&&getOpponentTotalCards(s)===0)return 0;if(s.myHand.length===0)return 1;if(getOpponentTotalCards(s)===0)return-1;return null;}
function rollout(s){let n=cloneState(s);for(let d=0;d<DURAK_ROLLOUT_DEPTH;d++){const t=terminalResult(n);if(t!==null)return t;const a=chooseRolloutAction(n,n.turn);if(!a)break;n=applyAction(n,n.turn,a);}const t=terminalResult(n);if(t!==null)return t;return evaluatePosition(n)>=0?1:-1;}

// ============================================================
// HIDDEN INFORMATION
// ============================================================
function shuffle(a){const x=[...a];for(let i=x.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[x[i],x[j]]=[x[j],x[i]];}return x;}
function sampleHiddenState(s){const pool=shuffle(getUnknownPoolIds(s)),n=cloneState(s);n.oppKnownHand=[...n.oppKnownHand,...pool.splice(0,s.oppUnknownCount)];n.oppUnknownCount=0;n.stockCards=pool;n.phase='playing';return n;}
function cardAnswerProbability(card,s=state){const pool=getUnknownPoolIds(s);if(!pool.length)return 0;return pool.filter(c=>canBeatWithState(card,c,s)).length/pool.length;}
function hypergeometricZero(successes,population,draws){if(successes<=0||draws<=0)return 1;if(successes>=population)return 0;let p=1;for(let i=0;i<draws;i++){if(population-i<=0)return 0;p*=Math.max(0,(population-successes-i)/(population-i));}return p;}
function getRankProbability(rank,s=state){const pool=getUnknownPoolIds(s);if(!pool.length||!s.oppUnknownCount)return 0;const matching=pool.filter(c=>getCardRank(c)===rank).length;return 1-hypergeometricZero(matching,pool.length,s.oppUnknownCount);}

// ============================================================
// EXACT ENDGAME
// ============================================================
function terminalScore(s,depth=0){const r=terminalResult(s);return r===null?null:r*100000+(r>0?-depth:depth);}
function solveEndgame(s,player,depth=0,alpha=-Infinity,beta=Infinity,memo=new Map()){const t=terminalScore(s,depth);if(t!==null)return t;if(depth>120)return evaluatePosition(s);const key=[player,s.attacker,s.myHand.slice().sort().join('.'),s.oppKnownHand.slice().sort().join('.'),s.tablePairs.map(p=>p.attack+':'+(p.defend||'-')).join(',')].join('|');if(memo.has(key))return memo.get(key);const actions=actionList(s,player);if(!actions.length)return evaluatePosition(s);let best=player==='me'?-Infinity:Infinity;for(const a of actions){const n=applyAction(s,player,a),v=solveEndgame(n,n.turn,depth+1,alpha,beta,memo);if(player==='me'){best=Math.max(best,v);alpha=Math.max(alpha,best);}else{best=Math.min(best,v);beta=Math.min(beta,best);}if(beta<=alpha)break;}memo.set(key,best);return best;}
function isExactEndgame(s=state){return getRemainingDeck(s)===0&&s.oppUnknownCount===0;}
function candidateMoves(s=state){return actionList(s,'me').map(a=>a.type==='CARD'?{type:'CARD',move:a.card}:{type:a.type,move:a.type});}
function applyCandidate(s,c){return applyAction(s,'me',c.type==='CARD'?{type:'CARD',card:c.move}:{type:c.type});}
function moveLabel(c){return c.move;}
function findBestEndgameMove(s=state){if(s.turn!=='me')return null;const cs=candidateMoves(s);if(!cs.length)return null;let best=cs[0],bestScore=-Infinity,memo=new Map();for(const c of cs){const n=applyCandidate(s,c),v=solveEndgame(n,n.turn,1,-Infinity,Infinity,memo);if(v>bestScore){bestScore=v;best=c;}}return{move:best.move,score:bestScore};}

// ============================================================
// MOVE ANALYSIS
// ============================================================
function analyzeMove(candidate,s,samples){let wins=0,losses=0,draws=0;for(let i=0;i<samples;i++){let sampled=sampleHiddenState(s);sampled=applyCandidate(sampled,candidate);const r=rollout(sampled);if(r>0)wins++;else if(r<0)losses++;else draws++;}return{candidate,equity:(wins+draws*.5)/samples,winRate:wins/samples,wins,losses,draws};}
function analyzePosition(s=state,options={}){if(s.turn!=='me')return null;const candidates=candidateMoves(s);if(!candidates.length)return null;if(isExactEndgame(s)){const exact=findBestEndgameMove(s);return{mode:'exact',samples:0,best:candidates.find(c=>moveLabel(c)===exact?.move)||candidates[0],moves:candidates.map(c=>({candidate:c,equity:exact&&moveLabel(c)===exact.move?1:0,winRate:exact&&moveLabel(c)===exact.move?1:0,wins:0,losses:0,draws:0}))};}const samples=options.samples||DURAK_ANALYSIS_SAMPLES,moves=candidates.map(c=>analyzeMove(c,s,samples));moves.sort((a,b)=>b.equity-a.equity||b.winRate-a.winRate);return{mode:'monte-carlo',samples,best:moves[0].candidate,moves};}
function getSuggestionReasons(card,s){if(!card||card==='TAKE'||card==='BITO')return[];const out=[],rank=getCardRank(card),counts=getMyRankCounts(s),p=cardAnswerProbability(card,s);if(counts[rank]>=2)out.push('rank pressure');if(!isTrump(card,s)&&getCardValue(card)<=10)out.push('sheds a low card');if(p<.15)out.push('few known answers');else if(p>.5)out.push('high answer risk');if(isTrump(card,s))out.push('spends a trump');return out.slice(0,3);}
function updateSuggestion(){const el=document.getElementById('suggestion-text');if(!el)return;if(state.phase==='drawing'){el.innerText=`DRAW PHASE: Select ${state.cardsToDraw} card(s).`;return;}if(state.phase==='gameover'){el.innerText=state.winner==='me'?'Game over: you won.':'Game over: opponent won.';return;}if(state.turn!=='me'){el.innerText="Wait for opponent's move.";return;}const a=analyzePosition(state);if(!a){el.innerText='No legal move.';return;}const rows=a.moves.slice(0,4),label=moveLabel(a.best);if(a.mode==='exact'){el.innerHTML=`<strong>FORCED: ${label}</strong><br><small>Exact endgame calculation. Every legal opponent response is accounted for.</small>`;return;}const r=a.moves[0],pct=Math.round(r.equity*100),win=Math.round(r.winRate*100),reason=label==='TAKE'?'Taking is the calculated best outcome.':label==='BITO'?'Ending the bout is the calculated best outcome.':(getSuggestionReasons(label,state).join(', ')||'best calculated outcome'),alts=rows.map(x=>`${moveLabel(x.candidate)} ${Math.round(x.equity*100)}%`).join(' · ');el.innerHTML=`<strong>${label==='TAKE'?'TAKE':label==='BITO'?'BITO':`Play ${label}`}</strong> <span class="suggestion-confidence">${pct}% equity</span><br><small>${reason}</small><br><small>Observed wins: ${win}% · ${alts}</small>`;}
function debugDurakEngine(){const a=state.turn==='me'?analyzePosition(state,{samples:400}):null;console.log('State',JSON.parse(JSON.stringify(state)));console.log('Stock',getRemainingDeck(state),'Unknown',getUnknownPoolIds(state).length,'Exact',isExactEndgame(state));console.table((a?.moves||[]).map(r=>({move:moveLabel(r.candidate),equity:`${Math.round(r.equity*100)}%`,wins:r.wins,losses:r.losses,draws:r.draws})));return a;}
window.DurakAI={analyzePosition,sampleHiddenState,cardAnswerProbability,getRankProbability,getUnknownPoolIds,findBestEndgameMove,solveEndgame,evaluatePosition,getRemainingDeck,getLegalAttacks,getLegalDefenses,simulateTake,simulateBito,simulatePlay,drawAfterBout};
