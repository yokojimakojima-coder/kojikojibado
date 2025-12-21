console.log("🔥 common.js 最強公平版 読み込まれたよ！");

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
   players 正規化（履歴は “回数” で持つ：偏り対策）
====================================================== */
function normalizePlayers(names) {
  return names.map((name, idx) => ({
    name,
    idx,

    games: 0,
    refs: 0,
    rests: 0,

    // 回数で持つ（Setだと「1回やった/やってない」しか分からず弱い）
    partnerCount: {},     // key: 相手idx -> 回数
    opponentCount: {},    // key: 相手idx -> 回数

    lastRoundPlayed: 0,
    lastRefRound: 0,
    lastRestRound: 0,

    // 連続対策（これが効く）
    playStreak: 0,
    restStreak: 0,
  }));
}

/* ======================================================
   参加判定（scheduleが無い人は “参加扱い” にする）
   ※途中参加/途中抜けを使わない日でも壊れない
====================================================== */
function isAvailableAtRound(name, roundNumber, schedule) {
  const segs = schedule?.[name];
  if (!segs || segs.length === 0) return true; // ←ここ大事
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
   最強公平（固定）
====================================================== */
function getAiWeights() {
  return {
    // ペア/対戦の被りは強烈に嫌う
    partnerBias: 30,
    opponentBias: 18,

    // 出場・休憩の偏りを抑える
    balanceBias: 6,

    // 連続出場/連続休憩を嫌う（ここが今回の主役）
    consecutivePlayBias: 12,
    consecutiveRestBias: 16,

    // 審判の偏り抑制
    refBias: 8,

    // 同点割り用（小さく）
    noise: 0.001,
  };
}

/* ======================================================
   内部ユーティリティ
====================================================== */
function getCount(map, key) {
  return map[key] || 0;
}
function inc(map, key, n = 1) {
  map[key] = (map[key] || 0) + n;
}

/* ======================================================
   履歴更新：ペア/対戦の “回数” を積む
====================================================== */
function updateHistory(players, teamA, teamB) {
  const [a1, a2] = teamA;
  const [b1, b2] = teamB;

  // ペア（両方向）
  inc(players[a1].partnerCount, a2);
  inc(players[a2].partnerCount, a1);
  inc(players[b1].partnerCount, b2);
  inc(players[b2].partnerCount, b1);

  // 対戦（4通り・両方向）
  const oppPairs = [
    [a1, b1], [a1, b2],
    [a2, b1], [a2, b2],
  ];
  oppPairs.forEach(([x, y]) => {
    inc(players[x].opponentCount, y);
    inc(players[y].opponentCount, x);
  });
}

/* ======================================================
   4人から “チーム分け3通り” を試して一番良いのを採用
   （これで同じペアが激減する）
====================================================== */
function bestTeamsForFour(players, four, roundNumber, w, targetGames, targetRests) {
  const [a, b, c, d] = four;

  const candidates = [
    { teamA: [a, b], teamB: [c, d] },
    { teamA: [a, c], teamB: [b, d] },
    { teamA: [a, d], teamB: [b, c] },
  ];

  let best = null;
  let bestScore = -Infinity;

  for (const cand of candidates) {
    const s = scoreTeams(players, cand.teamA, cand.teamB, roundNumber, w, targetGames, targetRests);
    if (s > bestScore) {
      bestScore = s;
      best = cand;
    }
  }

  return { ...best, score: bestScore };
}

/* ======================================================
   チームスコア：偏り潰し（ペア/対戦/連続/バランス）
====================================================== */
function scoreTeams(players, teamA, teamB, roundNumber, w, targetGames, targetRests) {
  let score = 0;

  const [a1, a2] = teamA;
  const [b1, b2] = teamB;

  // ペア被り（回数が多いほど重く罰）
  score -= getCount(players[a1].partnerCount, a2) * w.partnerBias;
  score -= getCount(players[b1].partnerCount, b2) * w.partnerBias;

  // 対戦被り（回数が多いほど重く罰）
  const oppPairs = [
    [a1, b1], [a1, b2],
    [a2, b1], [a2, b2],
  ];
  oppPairs.forEach(([x, y]) => {
    score -= getCount(players[x].opponentCount, y) * w.opponentBias;
  });

  // 連続出場抑制：前試合出てた人は減点（playStreakが長いほど重い）
  const four = [a1, a2, b1, b2];
  four.forEach(i => {
    const p = players[i];
    if (p.lastRoundPlayed === roundNumber - 1) score -= w.consecutivePlayBias;
    if (p.playStreak >= 2) score -= (p.playStreak - 1) * (w.consecutivePlayBias * 0.7);
  });

  // 休憩連続抑制は「出す側」にボーナスを付ける（休み続きの人を優先して試合へ）
  four.forEach(i => {
    const p = players[i];
    if (p.lastRestRound === roundNumber - 1) score += w.consecutiveRestBias; // 休み続きなら “出してあげる”
    if (p.restStreak >= 2) score += (p.restStreak - 1) * (w.consecutiveRestBias * 0.6);
  });

  // バランス：ゲーム数が平均からズレてる人を優先して埋める
  four.forEach(i => {
    const p = players[i];
    const afterGames = p.games + 1;
    score -= Math.abs(afterGames - targetGames) * w.balanceBias;
  });

  return score;
}

/* ======================================================
   審判選択：基本 “休憩メンバー” から選ぶ（被り防止）
====================================================== */
function chooseRefereeFromBench(players, benchIdx, roundNumber, w) {
  if (!benchIdx || benchIdx.length === 0) return null;

  // refsが少ない + 直近で審判してない人を優先
  let best = benchIdx[0];
  let bestScore = Infinity;

  benchIdx.forEach(i => {
    const p = players[i];
    const recentPenalty = (p.lastRefRound === roundNumber - 1) ? 1000 : 0;
    const s = p.refs * w.refBias + recentPenalty + (p.restStreak >= 2 ? -2 : 0);
    if (s < bestScore) {
      bestScore = s;
      best = i;
    }
  });

  return best;
}

/* ======================================================
   ラウンド生成（最強公平・偏り潰し版）
   - 1コートなら4人が試合、残りが休憩（休憩から審判を選ぶ）
   - 2コートなら8人が試合、残りが休憩（同様）
====================================================== */
function generateRound(players, roundNumber, courtCount, weights, schedule) {
  const activeIdx = getAvailablePlayerIndexes(players, roundNumber, schedule);
  if (activeIdx.length < 4) return null;

  const w = weights || getAiWeights();

  // 1ラウンドで出る人数
  const playSlots = Math.min(activeIdx.length, 4 * courtCount);
  const targetGames = (roundNumber * playSlots) / activeIdx.length;
  const targetRests = (roundNumber * (activeIdx.length - playSlots)) / activeIdx.length;

  const rounds = [];
  const refs = [];
  const benches = [];

  const usedForPlay = new Set();

  // コートごとに “4人” を選ぶ（同じ人を同ラウンドで重複させない）
  for (let ct = 0; ct < courtCount; ct++) {
    // 残り候補
    const pool = activeIdx.filter(i => !usedForPlay.has(i));
    if (pool.length < 4) break;

    let bestFour = null;
    let bestSplit = null;
    let bestScore = -Infinity;

    // 4人組を総当たりで評価（n<=20想定なら余裕）
    for (let a = 0; a < pool.length; a++) {
      for (let b = a + 1; b < pool.length; b++) {
        for (let c = b + 1; c < pool.length; c++) {
          for (let d = c + 1; d < pool.length; d++) {
            const four = [pool[a], pool[b], pool[c], pool[d]];

            const split = bestTeamsForFour(players, four, roundNumber, w, targetGames, targetRests);
            const s = split.score + Math.random() * w.noise;

            if (s > bestScore) {
              bestScore = s;
              bestFour = four;
              bestSplit = split;
            }
          }
        }
      }
    }

    if (!bestFour || !bestSplit) break;

    bestFour.forEach(i => usedForPlay.add(i));

    rounds.push({ teamA: bestSplit.teamA, teamB: bestSplit.teamB });
  }

  // 休憩（このラウンドで試合に出なかった人）
  activeIdx.forEach(i => {
    if (!usedForPlay.has(i)) benches.push(i);
  });

  // 審判：基本ベンチから（コート数分選ぶ）
  for (let ct = 0; ct < rounds.length; ct++) {
    const ref = chooseRefereeFromBench(players, benches, roundNumber, w);

    // どうしてもベンチがいない（人数ギリ）場合の保険
    // その場合は “とりあえずベンチなしで null” を返すのではなく、
    // 仕方なくコートの4人から refs最少を選ぶ（※被る可能性あり）
    if (ref === null) {
      const four = [...rounds[ct].teamA, ...rounds[ct].teamB];
      let best = four[0];
      let bestScore = Infinity;
      four.forEach(i => {
        const s = players[i].refs * w.refBias;
        if (s < bestScore) { bestScore = s; best = i; }
      });
      refs.push(best);
    } else {
      refs.push(ref);
      // 同一ラウンドで審判を複数コートにしない
      const idx = benches.indexOf(ref);
      if (idx >= 0) benches.splice(idx, 1);
    }
  }

  // ====== 集計更新（ここ重要） ======
  // まず休憩の更新（審判も休憩扱い）
  const playedThisRound = new Set();
  rounds.forEach(r => {
    r.teamA.forEach(i => playedThisRound.add(i));
    r.teamB.forEach(i => playedThisRound.add(i));
  });

  activeIdx.forEach(i => {
    const p = players[i];
    if (playedThisRound.has(i)) {
      p.games++;
      p.lastRoundPlayed = roundNumber;
      p.playStreak++;
      p.restStreak = 0;
    } else {
      p.rests++;
      p.lastRestRound = roundNumber;
      p.restStreak++;
      p.playStreak = 0;
    }
  });

  // 審判更新（審判も休憩側なので games は増えない）
  refs.forEach(refIdx => {
    const p = players[refIdx];
    p.refs++;
    p.lastRefRound = roundNumber;
  });

  // 履歴更新（試合ごとに1回）
  rounds.forEach(r => updateHistory(players, r.teamA, r.teamB));

  return { rounds, refs, benches: activeIdx.filter(i => !playedThisRound.has(i)) };
}
