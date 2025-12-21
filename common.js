console.log("🔥 common.js 最終版（途中参加が追いつかない版） 読み込まれたよ！");

/* ======================================================
   localStorage（共通）
====================================================== */

function getAllPlayers() {
  return JSON.parse(localStorage.getItem("allPlayers") || "[]");
}

function saveAllPlayers(list) {
  localStorage.setItem("allPlayers", JSON.stringify(list));
}

function getActivePlayers() {
  return JSON.parse(localStorage.getItem("activePlayers") || "[]");
}

function saveActivePlayersList(list) {
  localStorage.setItem("activePlayers", JSON.stringify(list));
}

function getSchedule() {
  return JSON.parse(localStorage.getItem("scheduleData") || "{}");
}

function saveSchedule(s) {
  localStorage.setItem("scheduleData", JSON.stringify(s));
}

/* ======================================================
   名簿管理（players.html用）
====================================================== */

function loadPlayers() {
  const listEl = document.getElementById("playerList");
  if (!listEl) return;

  listEl.innerHTML = "";
  const players = getAllPlayers();

  players.forEach((name, index) => {
    const li = document.createElement("li");
    li.className = "list-item";
    li.innerHTML = `
      <span class="name">${escapeHtml(name)}</span>
      <button class="del-btn" data-index="${index}">削除</button>
    `;
    listEl.appendChild(li);
  });

  listEl.querySelectorAll(".del-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.index);
      deletePlayer(idx);
    });
  });
}

function addPlayer() {
  const input = document.getElementById("newPlayer");
  if (!input) return;

  const name = input.value.trim();
  if (!name) return;

  const players = getAllPlayers();
  players.push(name);
  saveAllPlayers(players);

  input.value = "";
  loadPlayers();
}

function deletePlayer(index) {
  const players = getAllPlayers();
  players.splice(index, 1);
  saveAllPlayers(players);

  // 参加者にも残ってたら消す
  const active = getActivePlayers().filter(n => n !== players[index]);
  saveActivePlayersList(active);

  loadPlayers();
}

function savePlayers() {
  alert("名簿は自動保存です💖（削除/追加が反映されてるよ）");
}

/* ======================================================
   参加者チェック（attendance.html用）
====================================================== */

function loadPlayersToAttendance() {
  const list = document.getElementById("activeList");
  if (!list) return;

  list.innerHTML = "";

  const all = getAllPlayers();
  const active = new Set(getActivePlayers());

  all.forEach(name => {
    const li = document.createElement("li");
    li.className = "list-item";
    li.innerHTML = `
      <label class="checkline">
        <input type="checkbox" class="chk" data-name="${escapeAttr(name)}" ${active.has(name) ? "checked" : ""}>
        <span class="name">${escapeHtml(name)}</span>
      </label>
    `;
    list.appendChild(li);
  });
}

function checkAll() {
  document.querySelectorAll(".chk").forEach(cb => (cb.checked = true));
}

function uncheckAll() {
  document.querySelectorAll(".chk").forEach(cb => (cb.checked = false));
}

function saveActivePlayers() {
  const checked = [];
  document.querySelectorAll(".chk").forEach(cb => {
    if (cb.checked) checked.push(cb.dataset.name);
  });

  if (checked.length < 4) {
    alert("参加者は最低4人必要だよ💦");
    return;
  }

  saveActivePlayersList(checked);
  alert("保存したよ💖 試合作成へ移動するね！");
  location.href = "index.html";
}

/* ======================================================
   index.html 用：players配列の正規化（Set必須）
====================================================== */

function normalizePlayers(names) {
  return names.map((name, idx) => ({
    name,
    idx,
    games: 0,
    refs: 0,
    rests: 0,

    partners: new Set(),   // Set（ペア履歴）
    opponents: new Set(),  // Set（対戦履歴）

    lastRoundPlayed: 0,
    lastRefRound: 0,
    lastRestRound: 0,
  }));
}

/* ======================================================
   スケジュール（途中参加/途中抜け）判定
   ※ 今は「参加できる/できない」の判定だけ使う
====================================================== */

function isAvailableAtRound(name, roundNumber, schedule) {
  const segs = schedule[name] || [];
  // seg = {from,to}
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
   最強公平モード（固定）
   ★ 途中参加が“追いつこうとして連戦”しないように
   「総数の差」じゃなく「参加できたラウンド内の比率」で公平化する
====================================================== */

function getAiWeights() {
  return {
    partnerBias: 15,
    opponentBias: 12,

    // ✅ 参加率（games/availableRounds）で均等化 → 追いつき連戦が消える
    rateBias: 18,

    // ✅ 連戦/連休を抑える
    consecutivePlayPenalty: 30, // 連戦は強烈にマイナス
    breakRestBonus: 16,         // 前回休みなら次に出しやすい（連休防止）

    fatigueBias: 0.8,           // 出場間隔は軽め（連戦ペナルティが本体）
    refBias: 2.0,
    restBias: 2.0,
  };
}

/* ======================================================
   参加可能ラウンド数（途中参加/抜けで変化）
====================================================== */

function countAvailableRounds(name, upToRoundInclusive, schedule) {
  const segs = schedule[name] || [];
  let cnt = 0;

  segs.forEach(seg => {
    const from = Math.max(1, seg.from);
    const to = Math.min(seg.to, upToRoundInclusive);
    if (to >= from) cnt += (to - from + 1);
  });

  return cnt;
}

function computeAvgRates(players, roundNumber, schedule) {
  const upTo = roundNumber - 1; // 直前ラウンドまで
  let n = 0;
  let sumGame = 0, sumRef = 0, sumRest = 0;

  players.forEach(p => {
    const avail = countAvailableRounds(p.name, upTo, schedule);
    if (avail > 0) {
      n++;
      sumGame += p.games / avail;
      sumRef  += p.refs  / avail;
      sumRest += p.rests / avail;
    }
  });

  return {
    avgGameRate: n ? (sumGame / n) : 0,
    avgRefRate:  n ? (sumRef  / n) : 0,
    avgRestRate: n ? (sumRest / n) : 0,
  };
}

/* ======================================================
   履歴更新（Setに idx を入れる）
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
    if (!players[x] || !players[y]) return;
    players[x].partners.add(y);
    players[y].partners.add(x);
  });

  opponents.forEach(([x, y]) => {
    if (!players[x] || !players[y]) return;
    players[x].opponents.add(y);
    players[y].opponents.add(x);
  });
}

/* ======================================================
   4人グループの評価（途中参加追いつき防止入り）
====================================================== */

function calcGroupScore(players, group, round, w, schedule) {
  let score = 0;

  const [a, b, c, d] = group;

  // ペア被り
  if (players[a].partners.has(b)) score -= w.partnerBias;
  if (players[c].partners.has(d)) score -= w.partnerBias;

  // 対戦被り
  if (players[a].opponents.has(c)) score -= w.opponentBias;
  if (players[a].opponents.has(d)) score -= w.opponentBias;
  if (players[b].opponents.has(c)) score -= w.opponentBias;
  if (players[b].opponents.has(d)) score -= w.opponentBias;

  // ✅ 連戦を強烈に嫌う
  group.forEach(i => {
    if (players[i].lastRoundPlayed === round - 1) {
      score -= w.consecutivePlayPenalty;
    }
  });

  // ✅ 連休防止（前回休みなら加点）
  group.forEach(i => {
    if (players[i].lastRestRound === round - 1) {
      score += w.breakRestBonus;
    }
  });

  // ✅ 参加率（追いつき防止）
  const avgs = computeAvgRates(players, round, schedule);

  group.forEach(i => {
    const p = players[i];
    const avail = Math.max(1, countAvailableRounds(p.name, round - 1, schedule));

    const gameRate = p.games / avail;
    const refRate  = p.refs  / avail;
    const restRate = p.rests / avail;

    score -= Math.abs(gameRate - avgs.avgGameRate) * w.rateBias;
    score -= Math.abs(refRate  - avgs.avgRefRate)  * (w.rateBias * 0.4);
    score -= Math.abs(restRate - avgs.avgRestRate) * (w.rateBias * 0.4);

    // 出場間隔（軽め）
    score += Math.min(3, (round - p.lastRoundPlayed)) * w.fatigueBias;
  });

  return score + Math.random() * 0.01; // 同点割り
}

/* ======================================================
   チーム分け：3通りから一番マシなのを選ぶ
====================================================== */

function scoreTeams(players, teamA, teamB, w) {
  let s = 0;

  // ペア被り
  if (players[teamA[0]].partners.has(teamA[1])) s -= w.partnerBias;
  if (players[teamB[0]].partners.has(teamB[1])) s -= w.partnerBias;

  // 対戦被り（4通り）
  const opp = [
    [teamA[0], teamB[0]], [teamA[0], teamB[1]],
    [teamA[1], teamB[0]], [teamA[1], teamB[1]],
  ];
  opp.forEach(([x, y]) => {
    if (players[x].opponents.has(y)) s -= w.opponentBias;
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
    const s = scoreTeams(players, c.teamA, c.teamB, w);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  });

  return best;
}

/* ======================================================
   審判選択（“追いつき”防止のため参加率ベース）
   ※ 審判は「その試合でプレイしてない人」から優先。
   ※ いない場合は null（＝セルフ）にする。
====================================================== */

function chooseReferee(refPoolIdx, players, round, w, schedule) {
  if (!refPoolIdx || refPoolIdx.length === 0) return null;

  const avgs = computeAvgRates(players, round, schedule);

  let best = refPoolIdx[0];
  let bestScore = Infinity;

  refPoolIdx.forEach(i => {
    const p = players[i];
    const avail = Math.max(1, countAvailableRounds(p.name, round - 1, schedule));
    const refRate = p.refs / avail;

    // 連続審判は嫌う
    const consecutiveRefPenalty = (p.lastRefRound === round - 1) ? 50 : 0;

    // “審判率”が平均から離れるほどペナルティ
    const score = Math.abs(refRate - avgs.avgRefRate) * 20 + consecutiveRefPenalty;

    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });

  return best;
}

/* ======================================================
   ラウンド生成（最強公平）
   - 4人を選んで2vs2
   - 審判は基本「プレイしてない人」から選ぶ
   - 途中参加は “追いつかせない”（参加率で見る）
====================================================== */

function generateRound(players, roundNumber, courtCount, weights, schedule) {
  const activeIdx = getAvailablePlayerIndexes(players, roundNumber, schedule);
  if (activeIdx.length < 4) return null;

  const rounds = [];
  const refs = [];
  const benches = [];
  const used = new Set(); // このラウンドで使った人（プレイ/審判）

  for (let court = 0; court < courtCount; court++) {
    let bestGroup = null;
    let bestScore = -Infinity;

    // まだ使ってない人だけから4人組を作る
    const candidates = activeIdx.filter(i => !used.has(i));
    if (candidates.length < 4) break;

    for (let a = 0; a < candidates.length; a++) {
      for (let b = a + 1; b < candidates.length; b++) {
        for (let c = b + 1; c < candidates.length; c++) {
          for (let d = c + 1; d < candidates.length; d++) {
            const group = [candidates[a], candidates[b], candidates[c], candidates[d]];
            const score = calcGroupScore(players, group, roundNumber, weights, schedule);
            if (score > bestScore) {
              bestScore = score;
              bestGroup = group;
            }
          }
        }
      }
    }

    if (!bestGroup) break;

    // チーム分け（3通りから最善）
    const teams = chooseBestTeams(bestGroup, players, weights);
    const teamA = teams.teamA;
    const teamB = teams.teamB;

    // 審判候補（このコートのプレイヤー以外、かつ未使用の人）
    const refPool = activeIdx.filter(i => !used.has(i) && !bestGroup.includes(i));
    const refIndex = chooseReferee(refPool, players, roundNumber, weights, schedule); // nullの可能性あり

    rounds.push({ teamA, teamB });
    refs.push(refIndex);

    // 使用済み登録（プレイヤー）
    bestGroup.forEach(i => used.add(i));

    // 審判がいるなら使用済み登録
    if (refIndex !== null && refIndex !== undefined) {
      used.add(refIndex);
      players[refIndex].refs++;
      players[refIndex].lastRefRound = roundNumber;
    }

    // プレイヤーの試合数更新
    bestGroup.forEach(i => {
      players[i].games++;
      players[i].lastRoundPlayed = roundNumber;
    });

    // 履歴更新（1コート=1試合につき1回）
    updateHistory(players, teamA, teamB);
  }

  // 休憩（参加可能だけどこのラウンドで使われなかった人）
  activeIdx
    .filter(i => !used.has(i))
    .forEach(i => {
      benches.push(i);
      players[i].rests++;
      players[i].lastRestRound = roundNumber;
    });

  return { rounds, refs, benches };
}

/* ======================================================
   便利：HTMLエスケープ
====================================================== */

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(str) {
  // 属性用に最低限
  return escapeHtml(str).replaceAll("\n", " ");
}
