console.log("🔥 common.js 最新版 読み込まれてるよ！");

/* ======================================================
   共通：localStorage
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
   players 正規化（Set を必ず持たせる）
====================================================== */

function normalizePlayers(names) {
  return names.map((name, idx) => ({
    name,
    idx,
    games: 0,
    refs: 0,
    rests: 0,
    partners: new Set(),
    opponents: new Set(),
    lastRoundPlayed: 0,
    lastRefRound: 0,
    lastRestRound: 0,
  }));
}

/* ======================================================
   参加判定
====================================================== */

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
   AI 重み（最強公平固定）
====================================================== */

function getAiWeights() {
  return {
    partnerBias: 15,            // ペア被り強回避
    opponentBias: 12,           // 対戦被り強回避
    gameBias: 7.0,              // 試合数が多い人を出しにくく（均等化の核）
    restCatchUpBias: 2.0,       // 休憩が多い人を出しやすく
    consecutivePlayPenalty: 6,  // 連戦を避ける
    refBias: 2.0,               // 審判偏り防止
    refConsecutivePenalty: 2.5, // 審判連続を避ける
    restBias: 2.0               // 休憩偏り（補助）
  };
}

/* ======================================================
   途中参加/復帰の「追いつかせない」補正（★追加）
====================================================== */
/**
 * 途中参加/復帰した人を「現状の少ない人の水準」に合わせる（追いつかせない用）
 * - 欠席分を取り戻さない
 * - 連戦になりにくくする
 */
function applyJoinBaseline(players, joinName, roundNumber, schedule) {
  const joinP = players.find(p => p.name === joinName);
  if (!joinP) return;

  const activeIdxAll = getAvailablePlayerIndexes(players, roundNumber, schedule);
  if (activeIdxAll.length === 0) return;

  // ✅ join本人を除いた「既存参加者」を基準にする（超重要）
  const activeIdx = activeIdxAll.filter(i => i !== joinP.idx);
  const baseIdx = (activeIdx.length > 0) ? activeIdx : activeIdxAll;

  const minGames = Math.min(...baseIdx.map(i => players[i].games));
  const minRefs  = Math.min(...baseIdx.map(i => players[i].refs));
  const minRests = Math.min(...baseIdx.map(i => players[i].rests));

  // ✅ 下回ってる分だけ引き上げ（追いつかせない）
  if (joinP.games < minGames) joinP.games = minGames;
  if (joinP.refs  < minRefs)  joinP.refs  = minRefs;
  if (joinP.rests < minRests) joinP.rests = minRests;

  // ✅ 「ずっと出てない扱い」を避ける（連戦誘発を防ぐ）
  joinP.lastRoundPlayed = Math.max(joinP.lastRoundPlayed, roundNumber - 1);
  joinP.lastRefRound    = Math.max(joinP.lastRefRound,    roundNumber - 1);
  joinP.lastRestRound   = Math.max(joinP.lastRestRound,   roundNumber - 1);
}

/* ======================================================
   履歴更新（Setには idx を入れる）
====================================================== */

function updateHistory(players, teamA, teamB) {
  const pairs = [
    [teamA[0], teamA[1]],
    [teamB[0], teamB[1]],
  ];

  const opponents = [
    [teamA[0], teamB[0]], [teamA[0], teamB[1]],
    [teamA[1], teamB[0]], [teamA[1], teamB[1]],
  ];

  pairs.forEach(([x, y]) => {
    players[x].partners.add(y);
    players[y].partners.add(x);
  });

  opponents.forEach(([x, y]) => {
    players[x].opponents.add(y);
    players[y].opponents.add(x);
  });
}

/* ======================================================
   4人のチーム分け（3パターンから最善を選ぶ）
====================================================== */

function bestTeamSplit(group4, players, round, w) {
  const [a, b, c, d] = group4;

  const patterns = [
    { A: [a, b], B: [c, d] },
    { A: [a, c], B: [b, d] },
    { A: [a, d], B: [b, c] },
  ];

  let best = null;
  let bestScore = -Infinity;

  for (const pat of patterns) {
    const teamA = pat.A;
    const teamB = pat.B;

    let score = 0;

    // ペア被り
    if (players[teamA[0]].partners.has(teamA[1])) score -= w.partnerBias;
    if (players[teamB[0]].partners.has(teamB[1])) score -= w.partnerBias;

    // 対戦被り（クロス4本）
    const oppPairs = [
      [teamA[0], teamB[0]], [teamA[0], teamB[1]],
      [teamA[1], teamB[0]], [teamA[1], teamB[1]],
    ];
    for (const [x, y] of oppPairs) {
      if (players[x].opponents.has(y)) score -= w.opponentBias;
    }

    // 試合数の均等化（核）
    for (const i of group4) {
      score -= players[i].games * w.gameBias;
      score += players[i].rests * w.restCatchUpBias;

      // 連戦回避（直前ラウンドに出てたら減点）
      if (round - players[i].lastRoundPlayed === 1) score -= w.consecutivePlayPenalty;
    }

    // 微ランダムで同点割れ
    score += Math.random() * 0.01;

    if (score > bestScore) {
      bestScore = score;
      best = { teamA, teamB, score };
    }
  }

  return best; // { teamA:[i,i], teamB:[i,i], score }
}

/* ======================================================
   審判選択：プレイしてない人から選ぶ（かぶり防止）
====================================================== */

function chooseRefereeFromPool(poolIdx, players, round, w) {
  if (!poolIdx || poolIdx.length === 0) return null;

  let best = poolIdx[0];
  let bestScore = Infinity;

  for (const i of poolIdx) {
    let score = players[i].refs * w.refBias;

    // 審判連続は避けたい
    if (round - players[i].lastRefRound === 1) score += w.refConsecutivePenalty;

    // ちょいランダム
    score += Math.random() * 0.01;

    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/* ======================================================
   ラウンド生成（最強公平・審判かぶり無し）
====================================================== */

function generateRound(players, roundNumber, courtCount, weights, schedule) {
  const activeIdx = getAvailablePlayerIndexes(players, roundNumber, schedule);
  if (activeIdx.length < 4) return null;

  const rounds = [];
  const refs = [];
  const benches = [];
  const used = new Set(); // このラウンドで「プレイ or 審判」した人

  for (let court = 0; court < courtCount; court++) {
    let bestGroup = null;
    let bestSplit = null;
    let bestScore = -Infinity;

    // 残り候補（まだ使ってない人）
    const candidates = activeIdx.filter(i => !used.has(i));
    if (candidates.length < 4) break;

    // 4人の組み合わせを総当り → その中でベストのチーム分けを選ぶ
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        for (let k = j + 1; k < candidates.length; k++) {
          for (let l = k + 1; l < candidates.length; l++) {
            const group4 = [candidates[i], candidates[j], candidates[k], candidates[l]];

            const split = bestTeamSplit(group4, players, roundNumber, weights);
            if (!split) continue;

            if (split.score > bestScore) {
              bestScore = split.score;
              bestGroup = group4;
              bestSplit = split;
            }
          }
        }
      }
    }

    if (!bestGroup || !bestSplit) break;

    // ✅ この試合でプレイする4人
    const play = bestGroup.slice();

    // ✅ 審判は「この4人以外」から選ぶ（かぶり防止）
    const refPool = activeIdx.filter(i => !used.has(i) && !play.includes(i));
    const refIndex = chooseRefereeFromPool(refPool, players, roundNumber, weights);

    // 登録
    rounds.push({ teamA: bestSplit.teamA, teamB: bestSplit.teamB });
    refs.push(refIndex); // null あり得る（人数不足のとき）

    // 使用済み
    play.forEach(i => used.add(i));
    if (refIndex !== null) used.add(refIndex);

    // カウント更新：プレイヤー
    play.forEach(i => {
      players[i].games++;
      players[i].lastRoundPlayed = roundNumber;
    });

    // カウント更新：審判
    if (refIndex !== null) {
      players[refIndex].refs++;
      players[refIndex].lastRefRound = roundNumber;
    }

    // 履歴更新（1試合につき1回）
    updateHistory(players, bestSplit.teamA, bestSplit.teamB);
  }

  // 休憩（参加可能だが「プレイも審判もしなかった」人）
  const restPlayers = activeIdx.filter(i => !used.has(i));
  restPlayers.forEach(i => {
    players[i].rests++;
    players[i].lastRestRound = roundNumber;
  });

  benches.push(...restPlayers);

  return { rounds, refs, benches };
}
