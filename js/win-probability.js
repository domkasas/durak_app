// ============================================================
// DURAK WIN PROBABILITY v4
// ============================================================
// A displayed 100% means an exact forced win, not merely that all sampled
// rollouts happened to win. Monte Carlo positions are capped at 99% and are
// explicitly labelled as sampled equity.
// ============================================================
(function(){
  'use strict';
  let lastSignature='';
  let lastAnalysis=null;
  let analysisBusy=false;
  function clamp(v,min,max){return Math.max(min,Math.min(max,v));}
  function signature(s){return[s.phase,s.turn,s.attacker,s.winner,s.trumpCard,s.trumpPickedUp,s.cardsToDraw,s.oppUnknownCount,s.myHand.slice().sort().join(','),s.oppKnownHand.slice().sort().join(','),s.discard.slice().sort().join(','),s.tablePairs.map(p=>`${p.attack}:${p.defend||'-'}`).join('|')].join('||');}
  function exactProbability(s){
    if(!isExactEndgame(s))return null;
    if(s.myHand.length===0&&s.oppKnownHand.length===0)return 100;
    const result=findBestEndgameMove(s);
    if(!result)return null;
    if(result.score>=90000)return 100;
    if(result.score<=-90000)return 0;
    return 50;
  }
  function calculateWinProbability(s=state){
    if(s.phase==='gameover')return s.winner==='me'?100:0;
    const exact=exactProbability(s);if(exact!==null)return exact;
    const analysis=analyzePosition(s,{samples:DURAK_ANALYSIS_SAMPLES});
    if(!analysis||!analysis.moves.length)return 50;
    return clamp(Math.round(analysis.moves[0].equity*100),1,99);
  }
  function updateWinProbability(){
    const el=document.getElementById('win-probability-value'),box=document.getElementById('win-probability');
    if(!el||!box||typeof state==='undefined')return;
    const sig=signature(state);
    if(sig!==lastSignature&&!analysisBusy){
      lastSignature=sig;analysisBusy=true;
      setTimeout(()=>{
        try{lastAnalysis=state.turn==='me'&&state.phase==='playing'?analyzePosition(state,{samples:DURAK_ANALYSIS_SAMPLES}):null;}
        finally{analysisBusy=false;render();}
      },0);
    }
    render();
  }
  function render(){
    const el=document.getElementById('win-probability-value'),box=document.getElementById('win-probability');
    if(!el||!box||typeof state==='undefined')return;
    let p,note,exact=false;
    if(state.phase==='gameover'){p=state.winner==='me'?100:0;note='Final result.';}
    else if(state.turn!=='me'){
      p=lastAnalysis?.moves?.[0]?.equity!=null?Math.round(lastAnalysis.moves[0].equity*100):50;
      p=clamp(p,1,99);note='Last calculated sampled equity. Not a guarantee.';
    }else if(lastAnalysis){
      p=Math.round(lastAnalysis.moves[0].equity*100);
      exact=lastAnalysis.mode==='exact';
      if(exact)note='FORCED result from exact endgame calculation.';
      else{p=clamp(p,1,99);note=`Sampled win equity, ${lastAnalysis.samples} simulations. 100% is reserved for a proven forced win.`;}
    }else{p=50;note='Calculating...';}
    el.textContent=`${p}%`;box.dataset.probability=p;box.style.setProperty('--win-probability',p);
    const fill=box.querySelector('.win-probability-fill');if(fill)fill.style.width=`${p}%`;
    if(exact&&p===100)box.dataset.level='forced';
    else if(p>=90)box.dataset.level='dominant';
    else if(p>=70)box.dataset.level='favored';
    else if(p<=10)box.dataset.level='critical';
    else if(p<=30)box.dataset.level='behind';
    else box.dataset.level='even';
    const noteEl=box.querySelector('.win-probability-note');if(noteEl)noteEl.textContent=note;
  }
  window.calculateWinProbability=calculateWinProbability;
  window.updateWinProbability=updateWinProbability;
  window.getLastDurakAnalysis=()=>lastAnalysis;
  const previousUpdatePlayingUI=window.updatePlayingUI;
  if(typeof previousUpdatePlayingUI==='function')window.updatePlayingUI=function(){previousUpdatePlayingUI();updateWinProbability();};
})();
