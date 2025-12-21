console.log("🔥 common.js 最終版 読み込まれたよ！");

/* ======================================================
   localStorage
====================================================== */
function getAllPlayers() {
  return JSON.parse(localStorage.getItem("allPlayers") || "[]");
}
function getActivePlayers() {
  return JSON.parse(localStorage.getItem("activePlayers") || "[]");
}
function getSchedule() {
  return JSON.parse(localStorage.getItem("scheduleData") || "{}");
}
function saveSchedule(s) {
  localStorage.setItem("scheduleData", JSON.stringify(s));
}

/* ======================================================
   スケジュール（途中参加／途中抜け）モデル
   schedule[name] = [{from,to},{from,to}...]
====================================================== */
function ensureScheduleFor(names, schedule) {
  names.forEach(n => {
    if (!schedule[n] || !Array.isArray(schedule[n]) || schedule[n].length === 0) {
      schedule[n] = []; // 未参加扱い（index側でjoinすると追加される）
    }
  });
  return schedule;
}

function isAvailableAtRound(name, roundNumber, schedule) {
  const segs = schedule[name] || [];
  return segs.some(seg => seg.from <= roundNumber && roundNumber <= seg.to);
}

function getAvailablePlayerIndexes(players, roundNumber, schedule) {
  const arr = [];
  players.forEach((p, i) => {
    if (isAvailableAtRound(p.name, roundNumber, schedule)) arr.push(i);
  });
  return arr;
}

/* ======================================================
   プレイヤー初期化
   partners/opponents は「回数map」で管理（シリアライズ地雷回避）
====================================================== */
function normalizePlayers(names) {
  return names.map((name, idx) => ({
    name,
    idx,
    games: 0,
    refs: 0,
    rests: 0,
    partners: {},      // {otherIdx: count}
    opponents: {},     // {otherIdx: count}
    lastRoundPlayed: 0,
    lastRefRound: 0,
    lastRestRound: 0
  }));
}

function addPlayerToSession(players, name) {
  // すでに存在してたらそのまま返す
  const exists = players.find(p => p.name === name);
  if (exists) return players;

  const idx = players.length;
  players.push({
    name,
    idx,
    games: 0,
    refs: 0,
    rests: 0,
    partners: {},
    opponents: {},
    lastRoundPlayed: 0,
    lastRefRound: 0,
    lastRestRound: 0
  });
  return players;
}

/* ======================================================
   最強公平：重み（固定）
   ※ partner/opponent を強く避けつつ、連続や偏りも抑える
====================================================== */
function getAiWeights() {
  return {
    partnerBias: 18,        // 同ペア回数ペナルティ
    opponentBias: 14,       // 同対戦回数ペナルティ
    streakPlayBias: 3.0,    // 連続出場ペナルティ
    streakRestBias: 3.6,    // 連続休憩ペナルティ
    refBias: 3.0,           // 審判偏りペナルティ
    restBias: 2.8,          // 休憩偏りペナルティ
    balanceBias: 1.8,       // 試合数バランス
    randomness: 0.01
  };
}

/* ======================================================
   回数mapヘルパー
====================================================== */
function getCount(mapObj, key) {
  return mapObj && mapObj[key] ? mapObj[key] : 0;
}
function incCount(mapObj, key, inc=1) {
  mapObj[key] = (mapObj[key] || 0) + inc;
}

/* ======================================================
   チーム割り（4人→2vs2）は 3通り試してベストを選ぶ
====================================================== */
function allTeamSplits(four) {
  const [a,b,c,d] = four;
  return [
    { teamA:[a,b], teamB:[c,d] },
    { teamA:[a,c], teamB:[b,d] },
    { teamA:[a,d], teamB:[b,c] },
  ];
}

/* ======================================================
   評価：4人の並び（チーム）スコア
====================================================== */
function scoreTeams(players, teamA, teamB, round, w) {
  let score = 0;

  // ペア回数ペナルティ（回数が多いほど重い）
  const pa = getCount(players[teamA[0]].partners, teamA[1]);
  const pb = getCount(players[teamB[0]].partners, teamB[1]);
  score -= (pa * w.partnerBias);
  score -= (pb * w.partnerBias);

  // 対戦回数ペナルティ（4通り）
  const oppPairs = [
    [teamA[0], teamB[0]], [teamA[0], teamB[1]],
    [teamA[1], teamB[0]], [teamA[1], teamB[1]],
  ];
  oppPairs.forEach(([x,y]) => {
    const cnt = getCount(players[x].opponents, y);
    score -= (cnt * w.opponentBias);
  });

  // 連続出場を嫌う（その4人の中で、直前も出てた人が多いほど減点）
  const playedLast = [...teamA, ...teamB].filter(i => players[i].lastRoundPlayed === round - 1).length;
  score -= playedLast * w.streakPlayBias;

  // 試合数バランス（平均との差の絶対値で軽く減点）
  const games = [...teamA, ...teamB].map(i => players[i].games);
  const avg = games.reduce((a,b)=>a+b,0) / games.length;
  score -= games.reduce((s,g)=>s + Math.abs(g - avg), 0) * w.balanceBias;

  return score;
}

/* ======================================================
   審判の選び方
   - まず「ベンチ(今回試合に出ない人)」から選ぶ
   - ベンチがいない場合だけプレイヤーから選ぶ（現実対応）
====================================================== */
function chooseReferee(players, candidatesIdx, round, w) {
  // refs少ない + 直前審判じゃない を優先
  let best = candidatesIdx[0];
  let bestScore = Infinity;

  candidatesIdx.forEach(i => {
    const p = players[i];
    let s = 0;
    s += p.refs * w.refBias;
    if (p.lastRefRound === round - 1) s += 4; // 連続審判は強めに避ける
    bestScore = Math.min(bestScore, s);
    if (s <= bestScore) best = i;
  });

  return best;
}

/* ======================================================
   ラウンド生成（本体）
   - まず各コートの「4人」を選ぶ（履歴/偏り/連続を見て最大スコア）
   - 次に審判はベンチから選ぶ（可能なら）
   - 休憩は「連続休憩」を嫌って選ばれにくくする（スコアに反映済）
====================================================== */
function generateRound(players, roundNumber, courtCount, weights, schedule) {
  const activeIdx = getAvailablePlayerIndexes(players, roundNumber, schedule);
  if (activeIdx.length < 4) return null;

  const usedPlay = new Set();
  const rounds = [];
  const refs = [];
  const benches = [];

  // 1コート=4人必要。足りなければ作れるだけ作る
  for (let ct = 0; ct < courtCount; ct++) {

    let bestPick = null;       // { four:[...], split:{teamA,teamB}, score }
    let bestScore = -Infinity;

    // 候補から「未使用」だけで4人組を探す
    const pool = activeIdx.filter(i => !usedPlay.has(i));
    if (pool.length < 4) break;

    for (let a = 0; a < pool.length; a++) {
      for (let b = a + 1; b < pool.length; b++) {
        for (let c = b + 1; c < pool.length; c++) {
          for (let d = c + 1; d < pool.length; d++) {
            const four = [pool[a], pool[b], pool[c], pool[d]];

            // 3通りのチーム分けで一番いいやつを採用
            const splits = allTeamSplits(four);
            let localBest = null;
            let localBestScore = -Infinity;

            splits.forEach(sp => {
              const s = scoreTeams(players, sp.teamA, sp.teamB, roundNumber, weights);
              if (s > localBestScore) {
                localBestScore = s;
                localBest = sp;
              }
            });

            // 連続休憩が多い人を “今回の4人” に入れる（休憩ばかりを救う）
            const restLast = four.filter(i => players[i].lastRestRound === roundNumber - 1).length;
            const rescueScore = restLast * weights.streakRestBias;

            const finalScore = localBestScore + rescueScore + (Math.random() * weights.randomness);

            if (finalScore > bestScore) {
              bestScore = finalScore;
              bestPick = { four, split: localBest, score: finalScore };
            }
          }
        }
      }
    }

    if (!bestPick) break;

    // 採用した4人をプレイに確定
    bestPick.four.forEach(i => usedPlay.add(i));

    rounds.push({
      teamA: bestPick.split.teamA,
      teamB: bestPick.split.teamB
    });
  }

  // ベンチ（今回プレイに入らなかった参加可能者）
  activeIdx.forEach(i => {
    if (!usedPlay.has(i)) benches.push(i);
  });

  // 審判：可能ならベンチから
  // コート数ぶん選ぶ（ベンチ不足ならプレイヤーから）
  for (let i = 0; i < rounds.length; i++) {
    let candidates = benches.length > 0 ? benches : [...rounds[i].teamA, ...rounds[i].teamB];
    const ref = chooseReferee(players, candidates, roundNumber, weights);
    refs.push(ref);

    // 審判がベンチの中にいるなら、同じ人を2コート審判にしないようベンチから除外
    const idxInBench = benches.indexOf(ref);
    if (idxInBench >= 0) benches.splice(idxInBench, 1);
  }

  // ===== 更新処理 =====
  // 試合（games）更新
  rounds.forEach(r => {
    const four = [...r.teamA, ...r.teamB];
    four.forEach(i => {
      players[i].games++;
      players[i].lastRoundPlayed = roundNumber;
    });

    // 履歴（回数）更新
    updateHistory(players, r.teamA, r.teamB);
  });

  // 審判更新（審判がベンチだったら rest も加算されるようにする）
  refs.forEach(refIdx => {
    players[refIdx].refs++;
    players[refIdx].lastRefRound = roundNumber;
  });

  // 休憩更新（※審判がベンチだった場合も休憩に含まれる）
  const playedSet = new Set();
  rounds.forEach(r => [...r.teamA, ...r.teamB].forEach(i => playedSet.add(i)));

  activeIdx.forEach(i => {
    if (!playedSet.has(i)) {
      players[i].rests++;
      players[i].lastRestRound = roundNumber;
    }
  });

  return { rounds, refs, benches: activeIdx.filter(i => !playedSet.has(i)) };
}

/* ======================================================
   履歴更新（回数で持つ）
====================================================== */
function updateHistory(players, teamA, teamB) {
  // ペア
  const pairList = [
    [teamA[0], teamA[1]],
    [teamB[0], teamB[1]]
  ];
  pairList.forEach(([x,y]) => {
    incCount(players[x].partners, y, 1);
    incCount(players[y].partners, x, 1);
  });

  // 対戦（4通り）
  const oppList = [
    [teamA[0], teamB[0]],[teamA[0], teamB[1]],
    [teamA[1], teamB[0]],[teamA[1], teamB[1]],
  ];
  oppList.forEach(([x,y]) => {
    incCount(players[x].opponents, y, 1);
    incCount(players[y].opponents, x, 1);
  });
}
