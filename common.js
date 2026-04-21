console.log("🔥 common.js 統合最新版v4（mustInclude+底上げ加点で試合数均等化強化）");

/* =========================
   localStorage
========================= */
function getAllPlayers(){ return JSON.parse(localStorage.getItem("allPlayers")||"[]"); }
function setAllPlayers(list){ localStorage.setItem("allPlayers", JSON.stringify(list||[])); }
function getActivePlayers(){ return JSON.parse(localStorage.getItem("activePlayers")||"[]"); }
function setActivePlayers(list){ localStorage.setItem("activePlayers", JSON.stringify(list||[])); }
function getSchedule(){ return JSON.parse(localStorage.getItem("scheduleData")||"{}"); }
function saveSchedule(s){ localStorage.setItem("scheduleData", JSON.stringify(s||{})); }

/* =========================
   schedule判定
========================= */
function isAvailableAtRound(name, roundNumber, schedule){
  const sch = schedule || getSchedule();
  const segs = sch[name] || [];
  return segs.some(seg => seg.from <= roundNumber && roundNumber <= seg.to);
}
function getAvailablePlayerIndexes(players, roundNumber, schedule){
  const sch = schedule || getSchedule();
  const arr = [];
  players.forEach((p,i)=>{
    const segs = sch[p.name] || [];
    if(segs.some(seg=>seg.from<=roundNumber && roundNumber<=seg.to)) arr.push(i);
  });
  return arr;
}

/* =========================
   初期化（追いつき禁止＋履歴カウント＋直近記録）
========================= */
function normalizePlayers(names){
  return (names||[]).map((name, idx)=>({
    name, idx,
    games:0, refs:0, rests:0,
    partnersCount:{}, opponentsCount:{},
    lastRoundPlayed:0, lastRefRound:0, lastRestRound:0,

    // 直近ペア/直近対戦（相手idx→最後のラウンド）
    lastPairedRound:{},
    lastOppRound:{},

    // 追いつき禁止（途中参加/復帰で更新）
    joinRound:1,
    gamesAtJoin:0, refsAtJoin:0, restsAtJoin:0,
  }));
}

/* =========================
   重み（強め）
========================= */
function getAiWeights(){
  return {
    // 回数罰（長期の被り）
    partnerBias: 40,
    opponentBias: 24,

    // 直近クールダウン罰（体感偏り潰し）
    recentPartnerBias: 240,
    recentOpponentBias: 140,
    recentWindow: 6, // 直近6試合以内は強く避ける

    // 連続抑制
    consecutivePlayPenalty: 60,
    breakRestBonus: 40,          // 休み続き救済（連休防止）
    consecutiveRefPenalty: 9999, // 連続審判ほぼ禁止

    // 追いつき禁止：率を均す
    rateBias: 20,
    refRateBias: 14,
    restRateBias: 14,

    // 審判ゼロ潰し
    refCountHardBias: 140,

    // ★底上げ加点（最小との差×係数）
    underplayBoost: 25,

    // 同点割り
    noise: 0.01
  };
}

/* =========================
   率計算（参加期間で割る）
========================= */
function _span(p, round){
  const jr = p.joinRound || 1;
  return Math.max(1, round - jr + 1);
}
function participationRate(p, round){
  const span = _span(p, round);
  const g = (p.games||0) - (p.gamesAtJoin||0);
  return g / span;
}
function refRate(p, round){
  const span = _span(p, round);
  const r = (p.refs||0) - (p.refsAtJoin||0);
  return r / span;
}
function restRate(p, round){
  const span = _span(p, round);
  const b = (p.rests||0) - (p.restsAtJoin||0);
  return b / span;
}

/* =========================
   回数map
========================= */
function _getCount(map, key){ return map && map[key] ? map[key] : 0; }
function _incCount(map, key, n=1){ map[key] = (map[key]||0) + n; }
function _setLast(map, key, round){ map[key] = round; }

/* =========================
   履歴更新（回数 + 直近）
========================= */
function updateHistory(players, teamA, teamB, round){
  const [a1,a2]=teamA, [b1,b2]=teamB;

  // ペア回数
  _incCount(players[a1].partnersCount, a2);
  _incCount(players[a2].partnersCount, a1);
  _incCount(players[b1].partnersCount, b2);
  _incCount(players[b2].partnersCount, b1);

  // 直近ペア
  _setLast(players[a1].lastPairedRound, a2, round);
  _setLast(players[a2].lastPairedRound, a1, round);
  _setLast(players[b1].lastPairedRound, b2, round);
  _setLast(players[b2].lastPairedRound, b1, round);

  // 対戦回数 + 直近対戦
  const opp = [[a1,b1],[a1,b2],[a2,b1],[a2,b2]];
  opp.forEach(([x,y])=>{
    _incCount(players[x].opponentsCount, y);
    _incCount(players[y].opponentsCount, x);
    _setLast(players[x].lastOppRound, y, round);
    _setLast(players[y].lastOppRound, x, round);
  });
}

/* =========================
   2vs2の3通りから最良を選ぶ
========================= */
function scoreTeams(players, teamA, teamB, round, w){
  const [a1,a2]=teamA, [b1,b2]=teamB;
  let s = 0;

  // ペア回数罰
  s -= _getCount(players[a1].partnersCount, a2) * w.partnerBias;
  s -= _getCount(players[b1].partnersCount, b2) * w.partnerBias;

  // 直近ペア罰（K試合以内）
  const lpA = players[a1].lastPairedRound[a2] || 0;
  const lpB = players[b1].lastPairedRound[b2] || 0;
  if (lpA && (round - lpA) <= w.recentWindow) s -= w.recentPartnerBias;
  if (lpB && (round - lpB) <= w.recentWindow) s -= w.recentPartnerBias;

  // 対戦回数罰＋直近対戦罰
  const opp = [[a1,b1],[a1,b2],[a2,b1],[a2,b2]];
  opp.forEach(([x,y])=>{
    s -= _getCount(players[x].opponentsCount, y) * w.opponentBias;

    const lo = players[x].lastOppRound[y] || 0;
    if (lo && (round - lo) <= w.recentWindow) s -= w.recentOpponentBias;
  });

  return s;
}

function chooseBestTeams(group4, players, round, w){
  const [p0,p1,p2,p3] = group4;
  const cands = [
    {teamA:[p0,p1], teamB:[p2,p3]},
    {teamA:[p0,p2], teamB:[p1,p3]},
    {teamA:[p0,p3], teamB:[p1,p2]},
  ];

  let best = cands[0], bestScore = -Infinity;
  cands.forEach(c=>{
    const s = scoreTeams(players, c.teamA, c.teamB, round, w);
    if(s > bestScore){ bestScore=s; best=c; }
  });
  return best;
}

/* =========================
   平均率
========================= */
function computeAvgRates(players, activeIdx, round){
  let sumG=0,sumR=0,sumB=0;
  activeIdx.forEach(i=>{
    sumG += participationRate(players[i], round);
    sumR += refRate(players[i], round);
    sumB += restRate(players[i], round);
  });
  const n = activeIdx.length || 1;
  return { avgGame: sumG/n, avgRef: sumR/n, avgRest: sumB/n };
}

/* =========================
   4人セット評価（偏り潰し）
   ★ minGames を渡して「底上げ加点」も適用
========================= */
function scoreGroup(players, group4, round, w, avg, minGames){
  let score = 0;

  // 連戦/連休
  group4.forEach(i=>{
    const p = players[i];
    if((p.lastRoundPlayed||0) === round-1) score -= w.consecutivePlayPenalty;
    if((p.lastRestRound||0) === round-1) score += w.breakRestBonus;
  });

  // 率の均し（追いつかない）
  group4.forEach(i=>{
    const p = players[i];
    score -= Math.abs(participationRate(p, round) - avg.avgGame) * w.rateBias;
    score -= Math.abs(refRate(p, round) - avg.avgRef) * w.refRateBias;
    score -= Math.abs(restRate(p, round) - avg.avgRest) * w.restRateBias;
  });

  // ★底上げ加点：試合数が少ないほど加点
  group4.forEach(i=>{
    score += (minGames - players[i].games) * w.underplayBoost;
  });

  // チーム分け（回数＋直近）
  const bestTeams = chooseBestTeams(group4, players, round, w);
  score += scoreTeams(players, bestTeams.teamA, bestTeams.teamB, round, w);

  // 同点割り
  score += Math.random() * w.noise;

  return { score, bestTeams };
}

/* =========================
   審判選び（ベンチ優先＋ゼロ潰し＋連続禁止）
========================= */
function chooseReferee(refPoolIdx, players, round, w, avg){
  if(!refPoolIdx || refPoolIdx.length===0) return null;

  let best = refPoolIdx[0];
  let bestScore = Infinity;

  refPoolIdx.forEach(i=>{
    const p = players[i];

    const consecutive = ((p.lastRefRound||0) === round-1) ? w.consecutiveRefPenalty : 0;
    const refCountPenalty = (p.refs||0) * w.refCountHardBias;
    const ratePenalty = Math.abs(refRate(p, round) - avg.avgRef) * (w.refRateBias * 30);

    const s = consecutive + refCountPenalty + ratePenalty;
    if(s < bestScore){ bestScore=s; best=i; }
  });

  return best;
}

/* =========================
   ラウンド生成（メイン）
   ★試合数均等ガード（min+1）＋ mustInclude（minを必ず1人）
========================= */
function generateRound(players, roundNumber, courtCount, weights, schedule){
  const w = weights || getAiWeights();

  // ガード
  players.forEach(p=>{
    if(!p.partnersCount) p.partnersCount = {};
    if(!p.opponentsCount) p.opponentsCount = {};
    if(!p.lastPairedRound) p.lastPairedRound = {};
    if(!p.lastOppRound) p.lastOppRound = {};
    if(p.joinRound == null) p.joinRound = 1;
    if(p.gamesAtJoin == null) p.gamesAtJoin = 0;
    if(p.refsAtJoin == null) p.refsAtJoin = 0;
    if(p.restsAtJoin == null) p.restsAtJoin = 0;
  });

  const activeIdx = getAvailablePlayerIndexes(players, roundNumber, schedule);
  if(activeIdx.length < 4) return null;

  // 作れる最大コート数
  const maxCourts = Math.floor(activeIdx.length / 4);
  const courts = Math.max(1, Math.min(courtCount, maxCourts));

  const avg = computeAvgRates(players, activeIdx, roundNumber);

  // 試合数の上限ガード（min+1）
  const minGames = Math.min(...activeIdx.map(i => players[i].games));
  const allowedToPlay = new Set(activeIdx.filter(i => players[i].games <= minGames + 1));

  // ★最小試合数の人（置いてかれ防止）
  const mustInclude = new Set(activeIdx.filter(i => players[i].games === minGames));

  const rounds = [];
  const refs = [];
  const benches = [];
  const usedForPlay = new Set();
  const usedForRef = new Set();

  // ---- コートごとに「4人」を決める ----
  for(let ct=0; ct<courts; ct++){
    let best = null;
    let bestScore = -Infinity;

    // 試合に出れる人だけ
    const pool = activeIdx.filter(i => !usedForPlay.has(i) && allowedToPlay.has(i));
    if(pool.length < 4) break;

    for(let a=0; a<pool.length; a++){
      for(let b=a+1; b<pool.length; b++){
        for(let c=b+1; c<pool.length; c++){
          for(let d=c+1; d<pool.length; d++){
            const group4 = [pool[a], pool[b], pool[c], pool[d]];

            // ★最小試合数の人を最低1人は含める（放置防止）
            if (!group4.some(i => mustInclude.has(i))) continue;

            const judged = scoreGroup(players, group4, roundNumber, w, avg, minGames);
            if(judged.score > bestScore){
              bestScore = judged.score;
              best = { group4, bestTeams: judged.bestTeams };
            }
          }
        }
      }
    }

    if(!best) break;

    best.group4.forEach(i => usedForPlay.add(i));
    rounds.push({ teamA: best.bestTeams.teamA, teamB: best.bestTeams.teamB });
  }

  if(rounds.length === 0) return null;

  // ---- 審判（ベンチ優先） ----
  for(let i=0; i<rounds.length; i++){
    const playingSet = new Set([...rounds[i].teamA, ...rounds[i].teamB]);

    // ベンチ（このラウンド試合に出ない人）から
    let pool = activeIdx.filter(idx =>
      !usedForPlay.has(idx) && !usedForRef.has(idx) && !playingSet.has(idx)
    );

    // 非常時は緩める（同一コート4人は避ける）
    if(pool.length === 0){
      pool = activeIdx.filter(idx => !usedForRef.has(idx) && !playingSet.has(idx));
    }

    // それでも無理なら兼任（そのコートの4人）
    let ref = chooseReferee(pool, players, roundNumber, w, avg);
    if(ref === null){
      const four = [...playingSet];
      ref = chooseReferee(four, players, roundNumber, w, avg);
    }

    refs.push(ref);
    usedForRef.add(ref);
  }

  // ---- benches（試合にも審判にも入ってない人） ----
  const played = new Set();
  rounds.forEach(r=>{
    r.teamA.forEach(i=>played.add(i));
    r.teamB.forEach(i=>played.add(i));
  });

  activeIdx.forEach(i=>{
    const isPlayed = played.has(i);
    const isRef = usedForRef.has(i);
    if(!isPlayed && !isRef) benches.push(i);
  });

  // ---- カウント更新 ----
  rounds.forEach(r=>{
    const four = [...r.teamA, ...r.teamB];
    four.forEach(i=>{
      players[i].games++;
      players[i].lastRoundPlayed = roundNumber;
    });
    updateHistory(players, r.teamA, r.teamB, roundNumber);
  });

  refs.forEach(i=>{
    players[i].refs++;
    players[i].lastRefRound = roundNumber;
  });

  benches.forEach(i=>{
    players[i].rests++;
    players[i].lastRestRound = roundNumber;
  });

  return { rounds, refs, benches };
}
