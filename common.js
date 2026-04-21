console.log("🔥 common.js 統合最新版（審判ゼロ潰し/ベンチ審判優先/ペア被り激減/復帰OK）");

/* ======================================================
   localStorage 共通
====================================================== */

function getAllPlayers() {
  return JSON.parse(localStorage.getItem("allPlayers") || "[]");
}

function setAllPlayers(list) {
  localStorage.setItem("allPlayers", JSON.stringify(list || []));
}

function getActivePlayers() {
  return JSON.parse(localStorage.getItem("activePlayers") || "[]");
}

function setActivePlayers(list) {
  localStorage.setItem("activePlayers", JSON.stringify(list || []));
}

function getSchedule() {
  return JSON.parse(localStorage.getItem("scheduleData") || "{}");
}

function saveSchedule(s) {
  localStorage.setItem("scheduleData", JSON.stringify(s || {}));
}

/* ======================================================
   schedule 判定
   schedule[name] = [{from,to}, ...]
====================================================== */

function isAvailableAtRound(name, roundNumber, schedule) {
  const sch = schedule || getSchedule();
  const segs = sch[name] || [];
  return segs.some(seg => seg.from <= roundNumber && roundNumber <= seg.to);
}

function getAvailablePlayerIndexes(players, roundNumber, schedule) {
  const sch = schedule || getSchedule();
  const arr = [];
  players.forEach((p, i) => {
    const segs = sch[p.name] || [];
    if (segs.some(seg => seg.from <= roundNumber && roundNumber <= seg.to)) arr.push(i);
  });
  return arr;
}

/* ======================================================
   players 初期化（追い上げ禁止の基準点つき）
====================================================== */

function normalizePlayers(names) {
  return (names || []).map((name, idx) => ({
    name,
    idx,

    // カウント
    games: 0,
    refs: 0,
    rests: 0,

    // 履歴（回数で持つ＝同じペア/対戦が増えるほど避ける）
    partnersCount: {},   // { otherIdx: count }
    opponentsCount: {},  // { otherIdx: count }

    // 直近
    lastRoundPlayed: 0,
    lastRefRound: 0,
    lastRestRound: 0,

    // ★追いつき防止（途中参加・復帰時に基準点を更新）
    joinRound: 1,
    gamesAtJoin: 0,
    refsAtJoin: 0,
    restsAtJoin: 0,
  }));
}

/* ======================================================
   重み（最強公平固定）
   ※ 今回は審判/休憩の偏りが強かったので、審判側を強めてる
====================================================== */

function getAiWeights() {
  return {
    // 被り回避（回数×罰）
    partnerBias: 30,
    opponentBias: 18,

    // 連続抑制
    consecutivePlayPenalty: 35, // 連戦を強烈に避ける
    breakRestBonus: 24,         // ★休み続き救済を強化（14→24）

    // 追いつき禁止（参加期間で割った率を均す）
    rateBias: 22,
    refRateBias: 10,
    restRateBias: 10,

    // 同点割り
    noise: 0.01
  };
}

/* ======================================================
   追い上げ禁止の “率” 計算（参加期間だけで割る）
====================================================== */

function _span(p, currentRound) {
  const jr = p.joinRound || 1;
  return Math.max(1, currentRound - jr + 1);
}

function participationRate(p, currentRound) {
  const span = _span(p, currentRound);
  const g = (p.games || 0) - (p.gamesAtJoin || 0);
  return g / span;
}

function refRate(p, currentRound) {
  const span = _span(p, currentRound);
  const r = (p.refs || 0) - (p.refsAtJoin || 0);
  return r / span;
}

function restRate(p, currentRound) {
  const span = _span(p, currentRound);
  const b = (p.rests || 0) - (p.restsAtJoin || 0);
  return b / span;
}

/* ======================================================
   回数mapユーティリティ
====================================================== */

function _getCount(map, key) {
  return map && map[key] ? map[key] : 0;
}

function _incCount(map, key, n = 1) {
  map[key] = (map[key] || 0) + n;
}

/* ======================================================
   履歴更新（回数で増やす）
====================================================== */

function updateHistory(players, teamA, teamB) {
  const [a1, a2] = teamA;
  const [b1, b2] = teamB;

  // ペア（両方向）
  _incCount(players[a1].partnersCount, a2);
  _incCount(players[a2].partnersCount, a1);
  _incCount(players[b1].partnersCount, b2);
  _incCount(players[b2].partnersCount, b1);

  // 対戦（4通り・両方向）
  const opp = [
    [a1, b1], [a1, b2],
    [a2, b1], [a2, b2],
  ];
  opp.forEach(([x, y]) => {
    _incCount(players[x].opponentsCount, y);
    _incCount(players[y].opponentsCount, x);
  });
}

/* ======================================================
   4人→2vs2の3通りを試して一番マシな分け方を採用
====================================================== */

function scoreTeamsCount(players, teamA, teamB, w) {
  const [a1, a2] = teamA;
  const [b1, b2] = teamB;
  let s = 0;

  // ペア回数（多いほど重く罰）
  s -= _getCount(players[a1].partnersCount, a2) * w.partnerBias;
  s -= _getCount(players[b1].partnersCount, b2) * w.partnerBias;

  // 対戦回数（多いほど罰）
  const opp = [
    [a1, b1], [a1, b2],
    [a2, b1], [a2, b2],
  ];
  opp.forEach(([x, y]) => {
    s -= _getCount(players[x].opponentsCount, y) * w.opponentBias;
  });

  return s;
}

function chooseBestTeams(group4, players, w) {
  const [p0, p1, p2, p3] = group4;

  const candidates = [
    { teamA: [p0, p1], teamB: [p2, p3] },
    { teamA: [p0, p2], teamB: [p1, p3] },
    { teamA: [p0, p3], teamB: [p1, p2] },
  ];

  let best = candidates[0];
  let bestScore = -Infinity;

  candidates.forEach(c => {
    const s = scoreTeamsCount(players, c.teamA, c.teamB, w);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  });

  return best;
}

/* ======================================================
   平均率計算（参加期間内の率）
====================================================== */

function computeAvgRates(players, activeIdx, round) {
  if (!activeIdx || activeIdx.length === 0) {
    return { avgGame: 0, avgRef: 0, avgRest: 0 };
  }

  let sumG = 0, sumR = 0, sumB = 0;
  activeIdx.forEach(i => {
    sumG += participationRate(players[i], round);
    sumR += refRate(players[i], round);
    sumB += restRate(players[i], round);
  });

  return {
    avgGame: sumG / activeIdx.length,
    avgRef: sumR / activeIdx.length,
    avgRest: sumB / activeIdx.length
  };
}

/* ======================================================
   4人セットの評価（偏り/連続/率 + チーム分け評価）
====================================================== */

function scoreGroup(players, group4, round, w, avg) {
  let score = 0;

  // 連戦強烈回避 / 連休を救う
  group4.forEach(i => {
    const p = players[i];
    if ((p.lastRoundPlayed || 0) === round - 1) score -= w.consecutivePlayPenalty;
    if ((p.lastRestRound || 0) === round - 1) score += w.breakRestBonus;
  });

  // 追い上げ禁止：参加期間内の率を均す
  group4.forEach(i => {
    const p = players[i];
    score -= Math.abs(participationRate(p, round) - avg.avgGame) * w.rateBias;
    score -= Math.abs(refRate(p, round) - avg.avgRef) * w.refRateBias;
    score -= Math.abs(restRate(p, round) - avg.avgRest) * w.restRateBias;
  });

  // チーム分けのベスト（回数ペナルティ）
  const bestTeams = chooseBestTeams(group4, players, w);
  score += scoreTeamsCount(players, bestTeams.teamA, bestTeams.teamB, w);

  // 同点割り
  score += Math.random() * w.noise;

  return { score, bestTeams };
}

/* ======================================================
   審判選択（ゼロ潰し + 連続禁止 + 率均し）
   ★ refPoolIdx は「ベンチ優先」で渡される
====================================================== */

function chooseReferee(refPoolIdx, players, round, w, avg) {
  if (!refPoolIdx || refPoolIdx.length === 0) return null;

  let best = refPoolIdx[0];
  let bestScore = Infinity;

  refPoolIdx.forEach(i => {
    const p = players[i];

    // 連続審判は絶対避ける
    const consecutivePenalty = ((p.lastRefRound || 0) === round - 1) ? 9999 : 0;

    // 審判ゼロ（or少ない）を強く優先
    const refCountPenalty = (p.refs || 0) * 120;

    // 審判率の平均との差
    const ratePenalty = Math.abs(refRate(p, round) - avg.avgRef) * (w.refRateBias * 30);

    const s = consecutivePenalty + refCountPenalty + ratePenalty;

    if (s < bestScore) {
      bestScore = s;
      best = i;
    }
  });

  return best;
}

/* ======================================================
   ラウンド生成（メイン）
   返り値: { rounds, refs, benches }
====================================================== */

function generateRound(players, roundNumber, courtCount, weights, schedule) {
  const w = weights || getAiWeights();

  // ガード（必要プロパティ保証）
  players.forEach(p => {
    if (!p.partnersCount) p.partnersCount = {};
    if (!p.opponentsCount) p.opponentsCount = {};
    if (p.joinRound == null) p.joinRound = 1;
    if (p.gamesAtJoin == null) p.gamesAtJoin = 0;
    if (p.refsAtJoin == null) p.refsAtJoin = 0;
    if (p.restsAtJoin == null) p.restsAtJoin = 0;
  });

  const activeIdx = getAvailablePlayerIndexes(players, roundNumber, schedule);
  if (activeIdx.length < 4) return null;

  // 作れる最大コート数（4人/コート）
  const maxCourts = Math.floor(activeIdx.length / 4);
  const courts = Math.max(1, Math.min(courtCount, maxCourts));

  const avg = computeAvgRates(players, activeIdx, roundNumber);

  const rounds = [];
  const refs = [];
  const benches = [];

  const usedForPlay = new Set();
  const usedForRef = new Set();

  // ---- コートごとに「4人」を決める ----
  for (let ct = 0; ct < courts; ct++) {
    let best = null;
    let bestScore = -Infinity;

    const pool = activeIdx.filter(i => !usedForPlay.has(i));
    if (pool.length < 4) break;

    for (let a = 0; a < pool.length; a++) {
      for (let b = a + 1; b < pool.length; b++) {
        for (let c = b + 1; c < pool.length; c++) {
          for (let d = c + 1; d < pool.length; d++) {
            const group4 = [pool[a], pool[b], pool[c], pool[d]];

            const judged = scoreGroup(players, group4, roundNumber, w, avg);
            if (judged.score > bestScore) {
              bestScore = judged.score;
              best = { group4, bestTeams: judged.bestTeams };
            }
          }
        }
      }
    }

    if (!best) break;

    best.group4.forEach(i => usedForPlay.add(i));
    rounds.push({ teamA: best.bestTeams.teamA, teamB: best.bestTeams.teamB });
  }

  if (rounds.length === 0) return null;

  // ---- 審判選定（ベンチ優先 + ゼロ潰し） ----
  for (let i = 0; i < rounds.length; i++) {
    const playingSet = new Set([...rounds[i].teamA, ...rounds[i].teamB]);

    // ✅ 審判はまず「ベンチ（このラウンド試合に出ない人）」から選ぶ
    let pool = activeIdx.filter(idx => !usedForPlay.has(idx) && !usedForRef.has(idx) && !playingSet.has(idx));

    // ベンチがいない等の非常時だけ、制約を緩める（でも同一コートの4人は避ける）
    if (pool.length === 0) {
      pool = activeIdx.filter(idx => !usedForRef.has(idx) && !playingSet.has(idx));
    }

    // それでも無理なら兼任（そのコートの4人から）
    let ref = chooseReferee(pool, players, roundNumber, w, avg);
    if (ref === null) {
      const four = [...playingSet];
      ref = chooseReferee(four, players, roundNumber, w, avg);
    }

    refs.push(ref);
    usedForRef.add(ref);
  }

  // ---- benches（試合にも審判にも入ってない人） ----
  const played = new Set();
  rounds.forEach(r => {
    r.teamA.forEach(i => played.add(i));
    r.teamB.forEach(i => played.add(i));
  });

  activeIdx.forEach(i => {
    const isPlayed = played.has(i);
    const isRef = usedForRef.has(i);
    if (!isPlayed && !isRef) benches.push(i);
  });

  // ---- カウント更新 ----

  // 試合
  rounds.forEach(r => {
    const four = [...r.teamA, ...r.teamB];
    four.forEach(i => {
      players[i].games++;
      players[i].lastRoundPlayed = roundNumber;
    });
    updateHistory(players, r.teamA, r.teamB);
  });

  // 審判
  refs.forEach(i => {
    players[i].refs++;
    players[i].lastRefRound = roundNumber;
  });

  // 休憩
  benches.forEach(i => {
    players[i].rests++;
    players[i].lastRestRound = roundNumber;
  });

  return { rounds, refs, benches };
}
