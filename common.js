console.log("🔥 common.js 最終版 読み込まれたよ！");

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
   参加判定（schedule: {name:[{from,to},...]}）
====================================================== */

function isAvailableAtRound(name, roundNumber) {
  const schedule = getSchedule();
  const segs = schedule[name] || [];
  return segs.some(seg => seg.from <= roundNumber && roundNumber <= seg.to);
}

function getAvailablePlayerIndexes(players, roundNumber, schedule) {
  const arr = [];
  players.forEach((p, i) => {
    const segs = schedule[p.name] || [];
    const ok = segs.some(seg => seg.from <= roundNumber && roundNumber <= seg.to);
    if (ok) arr.push(i);
  });
  return arr;
}

/* ======================================================
   プレイヤー正規化（Set/履歴/基準点付き）
   ※ index.html から必ずこれを呼ぶ
====================================================== */

function normalizePlayers(names) {
  return (names || []).map((name, idx) => ({
    name,
    idx,

    // カウント
    games: 0,
    refs: 0,
    rests: 0,

    // 直近
    lastRoundPlayed: 0,
    lastRefRound: 0,
    lastRestRound: 0,

    // 履歴（被り回数のために count で持つ）
    partnersCount: {},   // { idx: count }
    opponentsCount: {},  // { idx: count }

    // 表示/互換用（Setも一応持たせる：事故防止）
    partners: new Set(),
    opponents: new Set(),

    // ★追い上げ禁止の基準点（途中参加・復帰用）
    joinRound: 1,
    gamesAtJoin: 0,
    refsAtJoin: 0,
    restsAtJoin: 0,
  }));
}

/* ======================================================
   AI重み（最強公平固定）
====================================================== */

function getAiWeights() {
  return {
    partnerBias: 8,            // ペア被り罰
    opponentBias: 6,           // 対戦被り罰
    consecutivePlayBias: 6,    // 連戦を避ける
    consecutiveRestBias: 4,    // 連休憩を避ける（休みすぎ防止）
    rateBias: 10,              // 出場率（追い上げ禁止方式）
    refRateBias: 8,            // 審判率
    restRateBias: 6,           // 休憩率
    noise: 0.01                // 同点割れ
  };
}

/* ======================================================
   追い上げ禁止の率計算（参加期間内で割る）
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
   履歴更新（回数カウント + Setも更新）
====================================================== */

function _incCount(obj, key) {
  obj[key] = (obj[key] || 0) + 1;
}

function updateHistory(players, teamA, teamB) {
  const pairs = [
    [teamA[0], teamA[1]],
    [teamB[0], teamB[1]],
  ];
  const opp = [
    [teamA[0], teamB[0]], [teamA[0], teamB[1]],
    [teamA[1], teamB[0]], [teamA[1], teamB[1]],
  ];

  pairs.forEach(([x, y]) => {
    _incCount(players[x].partnersCount, y);
    _incCount(players[y].partnersCount, x);
    players[x].partners.add(y);
    players[y].partners.add(x);
  });

  opp.forEach(([x, y]) => {
    _incCount(players[x].opponentsCount, y);
    _incCount(players[y].opponentsCount, x);
    players[x].opponents.add(y);
    players[y].opponents.add(x);
  });
}

/* ======================================================
   4人の組み方（2vs2の3パターンから最良を選ぶ）
====================================================== */

function bestTeamSplit(players, four, round, w) {
  const [a, b, c, d] = four;

  const candidates = [
    { teamA: [a, b], teamB: [c, d] },
    { teamA: [a, c], teamB: [b, d] },
    { teamA: [a, d], teamB: [b, c] },
  ];

  let best = candidates[0];
  let bestScore = -Infinity;

  for (const cand of candidates) {
    const s = scoreMatch(players, cand.teamA, cand.teamB, round, w);
    if (s > bestScore) {
      bestScore = s;
      best = cand;
    }
  }
  return best;
}

function scoreMatch(players, teamA, teamB, round, w) {
  let score = 0;

  // ペア被り（回数×罰）
  const pa = players[teamA[0]].partnersCount[teamA[1]] || 0;
  const pb = players[teamB[0]].partnersCount[teamB[1]] || 0;
  score -= (pa + pb) * w.partnerBias;

  // 対戦被り（回数×罰）
  const oppPairs = [
    [teamA[0], teamB[0]], [teamA[0], teamB[1]],
    [teamA[1], teamB[0]], [teamA[1], teamB[1]],
  ];
  for (const [x, y] of oppPairs) {
    const c = players[x].opponentsCount[y] || 0;
    score -= c * w.opponentBias;
  }

  // 連戦/連休憩の抑制（4人それぞれ）
  const four = [teamA[0], teamA[1], teamB[0], teamB[1]];
  for (const i of four) {
    const p = players[i];

    // 連戦を避ける
    if ((p.lastRoundPlayed || 0) === round - 1) score -= w.consecutivePlayBias;

    // 連休憩が続いてる人は出しやすくする（＝出場にボーナス）
    // ※「休みが連続」を避けるので、休み続きの人は“試合に出やすく”
    if ((p.lastRestRound || 0) === round - 1) score += w.consecutiveRestBias;

    // 出場率（参加期間内）を均す：低い人を優先しすぎないよう“平均との差”で
    // ここは候補選びで使うため、ざっくり負担として扱う
    score -= participationRate(p, round) * w.rateBias;
  }

  // ちょいランダム
  score += Math.random() * w.noise;
  return score;
}

/* ======================================================
   審判選択（休憩側から優先、いなければ兼任）
====================================================== */

function chooseReferee(refCandidates, players, round, w) {
  if (refCandidates.length === 0) return null;

  let best = refCandidates[0];
  let bestScore = Infinity;

  for (const i of refCandidates) {
    const p = players[i];
    const s = refRate(p, round) * w.refRateBias + (p.refs || 0) * 0.01;
    if (s < bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return best;
}

/* ======================================================
   ラウンド生成（最強公平・途中参加/抜け対応）
   - 4人で試合
   - 審判は可能なら休憩側、無理なら兼任
====================================================== */

function generateRound(players, roundNumber, courtCount, weights, schedule) {
  // 安全策：Set が壊れてても復旧
  players.forEach(p => {
    if (!(p.partners instanceof Set)) p.partners = new Set();
    if (!(p.opponents instanceof Set)) p.opponents = new Set();
    if (!p.partnersCount) p.partnersCount = {};
    if (!p.opponentsCount) p.opponentsCount = {};
  });

  const activeIdx = getAvailablePlayerIndexes(players, roundNumber, schedule);
  if (activeIdx.length < 4) return null;

  const usedPlayers = new Set();
  const usedRefs = new Set();

  const rounds = [];
  const refs = [];
  const benches = [];

  const maxCourtsByPlayers = Math.floor(activeIdx.length / 4);
  const courts = Math.max(1, Math.min(courtCount, maxCourtsByPlayers));

  for (let ct = 0; ct < courts; ct++) {
    let bestFour = null;
    let bestScore = -Infinity;

    // 4人選ぶ
    for (let a = 0; a < activeIdx.length; a++) {
      for (let b = a + 1; b < activeIdx.length; b++) {
        for (let c = b + 1; c < activeIdx.length; c++) {
          for (let d = c + 1; d < activeIdx.length; d++) {
            const four = [activeIdx[a], activeIdx[b], activeIdx[c], activeIdx[d]];
            if (four.some(i => usedPlayers.has(i))) continue;

            const split = bestTeamSplit(players, four, roundNumber, weights);
            const s = scoreMatch(players, split.teamA, split.teamB, roundNumber, weights);

            if (s > bestScore) {
              bestScore = s;
              bestFour = { four, split };
            }
          }
        }
      }
    }

    if (!bestFour) break;

    // このコートの試合メンバー確定
    const { four, split } = bestFour;

    // 先に試合メンバーを使用済みにする
    four.forEach(i => usedPlayers.add(i));

    // 審判候補：このラウンドで試合に出てない & 参加中
    const refCandidates = activeIdx.filter(i => !usedPlayers.has(i) && !usedRefs.has(i));
    let refIndex = chooseReferee(refCandidates, players, roundNumber, weights);

    // 審判が取れなければ「兼任」：試合メンバーから一番審判率が低い人
    if (refIndex === null) {
      refIndex = chooseReferee(four, players, roundNumber, weights);
    } else {
      usedRefs.add(refIndex);
    }

    // 登録
    rounds.push({ teamA: split.teamA, teamB: split.teamB });
    refs.push(refIndex);

    // 試合カウント
    split.teamA.concat(split.teamB).forEach(i => {
      players[i].games++;
      players[i].lastRoundPlayed = roundNumber;
    });

    // 審判カウント（審判が誰であれカウント）
    players[refIndex].refs++;
    players[refIndex].lastRefRound = roundNumber;

    // 履歴更新（1試合につき1回）
    updateHistory(players, split.teamA, split.teamB);
  }

  // 休憩（このラウンドで「試合にも審判にも入ってない人」）
  activeIdx.forEach(i => {
    const isPlaying = usedPlayers.has(i);
    const isRefing = usedRefs.has(i) || refs.includes(i); // 兼任も含む
    if (!isPlaying && !isRefing) benches.push(i);
  });

  benches.forEach(i => {
    players[i].rests++;
    players[i].lastRestRound = roundNumber;
  });

  return { rounds, refs, benches };
}
