"use strict";
/**
 * 斗地主 · Nakama 权威 Match（TypeScript）
 * 与客户端 scripts/card_defs.gd、scripts/ddz_rules.gd 的点力与牌型判定对齐。
 *
 * 消息协议（OpCode / JSON）：供日后客户端对接；当前未改 Godot 客户端。
 * 详见下方 DDZ_OP_* 与 broadcastState 中的字段说明。
 */
/** 牌型，与 ddz_rules.gd Kind 枚举顺序一致 */
var DDZ_KIND_INVALID = 0;
var DDZ_KIND_PASS = 1;
var DDZ_KIND_SINGLE = 2;
var DDZ_KIND_PAIR = 3;
var DDZ_KIND_TRIPLE = 4;
var DDZ_KIND_STRAIGHT = 5;
var DDZ_KIND_BOMB = 6;
var DDZ_KIND_ROCKET = 7;
var DDZ_KIND_TRIPLE_WITH_SINGLE = 8;
var DDZ_KIND_TRIPLE_WITH_PAIR = 9;
var DDZ_KIND_PAIR_STRAIGHT = 10;
var DDZ_KIND_FOUR_WITH_TWO = 11;
var DDZ_KIND_PLANE = 12;
var DDZ_KIND_PLANE_WITH_WINGS = 13;
/**
 * 与 Godot 客户端 `MATCH_OP_*`（1/2/3）错开，避免与旧 relay 快照混淆。
 * 权威斗地主专用：101 公共快照、102 错误、120 结算。
 */
var DDZ_OP_SNAPSHOT = 101;
var DDZ_OP_ERROR = 102;
var DDZ_OP_SETTLEMENT = 120;
/** 叫牌/抢地主：AI 连动、matchLoop 自动推进「跳过抢」与真人操作后的节奏（与出牌 AI 链式延迟同量级） */
var AI_BID_ROB_PACE_MS = 1350;
/** 新一局发牌后：给客户端播轨迹+停顿留出时间，再允许 AI 叫牌（约 51×40ms + 1s ≈ 3s） */
var AI_NEW_ROUND_BID_DELAY_MS = 3000;
/** 客户端请求（将来）：叫分 10、抢地主 11、出牌 12、过 13 */
var DDZ_REQ_BID = 10;
var DDZ_REQ_ROB = 11;
var DDZ_REQ_PLAY = 12;
var DDZ_REQ_PASS = 13;
var DDZ_REQ_CONTINUE = 14;
/** 客户端发送聊天文字；服务端原样广播给 Match 内全员 */
var DDZ_CARD_COUNT = 54;
function ddzRankValue(cardId) {
    if (cardId >= 52) {
        return 13 + (cardId - 52);
    }
    return cardId % 13;
}
function makeFullDeck() {
    var d = [];
    for (var i = 0; i < DDZ_CARD_COUNT; i++) {
        d.push(i);
    }
    return d;
}
/**
 * 部分 Nakama 版本（如 3.26）的 JS 运行时未实现 nk.secureRandomBytes，match_join 会抛错。
 * 优先用安全随机；不可用时退回 Math.random（仅影响洗牌/展示用 seed，非生产级安全场景可接受）。
 */
function randomBytesCompat(nk, count) {
    var nkAny = nk;
    if (typeof nkAny.secureRandomBytes === "function") {
        return new Uint8Array(nkAny.secureRandomBytes(count));
    }
    var out = new Uint8Array(count);
    for (var i = 0; i < count; i++) {
        out[i] = Math.floor(Math.random() * 256);
    }
    return out;
}
function randomIntBelow(nk, maxExclusive) {
    var u = randomBytesCompat(nk, 4);
    var x = u[0] | (u[1] << 8) | (u[2] << 16) | (u[3] << 24);
    return (x >>> 0) % maxExclusive;
}
/** Fisher–Yates */
function shuffleInPlace(nk, deck) {
    for (var i = deck.length - 1; i > 0; i--) {
        var j = randomIntBelow(nk, i + 1);
        var t = deck[i];
        deck[i] = deck[j];
        deck[j] = t;
    }
}
function sortHand(h) {
    h.sort(function (a, b) {
        var ra = ddzRankValue(a);
        var rb = ddzRankValue(b);
        if (ra !== rb) {
            return ra - rb;
        }
        return a - b;
    });
}
function rankCounts(cards) {
    var m = {};
    for (var i = 0; i < cards.length; i++) {
        var v = ddzRankValue(cards[i]);
        var k = String(v);
        m[k] = (m[k] || 0) + 1;
    }
    return m;
}
function sortedRanks(cards) {
    var r = [];
    for (var i = 0; i < cards.length; i++) {
        r.push(ddzRankValue(cards[i]));
    }
    r.sort(function (a, b) {
        return a - b;
    });
    return r;
}
function totalN(counts) {
    var s = 0;
    for (var k in counts) {
        if (counts.hasOwnProperty(k)) {
            s += counts[k];
        }
    }
    return s;
}
function isTripleSingle(counts) {
    if (Object.keys(counts).length !== 2) {
        return false;
    }
    var got3 = false;
    var got1 = false;
    for (var k in counts) {
        if (counts.hasOwnProperty(k)) {
            var c = counts[k];
            if (c === 3) {
                got3 = true;
            }
            else if (c === 1) {
                got1 = true;
            }
        }
    }
    return got3 && got1;
}
function tripleRankIn(counts) {
    for (var k in counts) {
        if (counts.hasOwnProperty(k) && counts[k] === 3) {
            return parseInt(k, 10);
        }
    }
    return -1;
}
function isTriplePair(counts) {
    if (Object.keys(counts).length !== 2) {
        return false;
    }
    var got3 = false;
    var got2 = false;
    for (var k in counts) {
        if (counts.hasOwnProperty(k)) {
            var c = counts[k];
            if (c === 3) {
                got3 = true;
            }
            else if (c === 2) {
                got2 = true;
            }
        }
    }
    return got3 && got2;
}
function isStraight(counts, n) {
    var keys = Object.keys(counts);
    if (keys.length !== n) {
        return false;
    }
    for (var i = 0; i < keys.length; i++) {
        if (counts[keys[i]] !== 1) {
            return false;
        }
    }
    var ranks = [];
    for (var i = 0; i < keys.length; i++) {
        ranks.push(parseInt(keys[i], 10));
    }
    ranks.sort(function (a, b) {
        return a - b;
    });
    for (var i = 0; i < ranks.length; i++) {
        if (ranks[i] === 12 || ranks[i] >= 13) {
            return false;
        }
    }
    for (var i = 1; i < ranks.length; i++) {
        if (ranks[i] !== ranks[i - 1] + 1) {
            return false;
        }
    }
    return true;
}
function isPairStraight(counts) {
    var npr = 0;
    for (var k in counts) {
        if (counts.hasOwnProperty(k)) {
            if (counts[k] !== 2) {
                return false;
            }
            npr++;
        }
    }
    if (npr < 3) {
        return false;
    }
    var ranks = [];
    for (var k in counts) {
        if (counts.hasOwnProperty(k)) {
            ranks.push(parseInt(k, 10));
        }
    }
    ranks.sort(function (a, b) {
        return a - b;
    });
    for (var i = 0; i < ranks.length; i++) {
        if (ranks[i] === 12 || ranks[i] >= 13) {
            return false;
        }
    }
    for (var i = 1; i < ranks.length; i++) {
        if (ranks[i] !== ranks[i - 1] + 1) {
            return false;
        }
    }
    return true;
}
function pairStraightRanks(counts) {
    var ranks = [];
    for (var k in counts) {
        if (counts.hasOwnProperty(k)) {
            ranks.push(parseInt(k, 10));
        }
    }
    ranks.sort(function (a, b) {
        return a - b;
    });
    return ranks;
}
function isFourTwoSingles(counts) {
    if (Object.keys(counts).length !== 3) {
        return false;
    }
    var got4 = false;
    var n1 = 0;
    for (var k in counts) {
        if (counts.hasOwnProperty(k)) {
            var c = counts[k];
            if (c === 4) {
                got4 = true;
            }
            else if (c === 1) {
                n1++;
            }
        }
    }
    return got4 && n1 === 2;
}
function isFourTwoPairs(counts) {
    if (Object.keys(counts).length !== 3) {
        return false;
    }
    var got4 = false;
    var n2 = 0;
    for (var k in counts) {
        if (counts.hasOwnProperty(k)) {
            var c = counts[k];
            if (c === 4) {
                got4 = true;
            }
            else if (c === 2) {
                n2++;
            }
        }
    }
    return got4 && n2 === 2;
}
function fourRankIn(counts) {
    for (var k in counts) {
        if (counts.hasOwnProperty(k) && counts[k] === 4) {
            return parseInt(k, 10);
        }
    }
    return -1;
}
function fourKickersNoJokerBomb(counts) {
    var fr = fourRankIn(counts);
    for (var k in counts) {
        if (!counts.hasOwnProperty(k)) {
            continue;
        }
        var rk = parseInt(k, 10);
        var c = counts[k];
        if (rk === fr) {
            continue;
        }
        if (c >= 4) {
            return false;
        }
        if (rk >= 13 && c >= 1) {
            return false;
        }
    }
    return true;
}
function tryPurePlane(counts) {
    var n = totalN(counts);
    if (n % 3 !== 0 || n < 6) {
        return null;
    }
    var k = n / 3;
    if (Object.keys(counts).length !== k) {
        return null;
    }
    for (var st = 0; st < 12; st++) {
        if (st + k - 1 > 11) {
            break;
        }
        var ok = true;
        for (var r = st; r < st + k; r++) {
            if ((counts[String(r)] || 0) !== 3) {
                ok = false;
                break;
            }
        }
        if (ok) {
            return { kind: DDZ_KIND_PLANE, main: st + k - 1, extra: k };
        }
    }
    return null;
}
function matchPlaneWingsAt(full, st, k, numPairWings) {
    var c = {};
    for (var kk in full) {
        if (full.hasOwnProperty(kk)) {
            c[kk] = full[kk];
        }
    }
    for (var r = st; r < st + k; r++) {
        var rs = String(r);
        if ((c[rs] || 0) < 3) {
            return null;
        }
        c[rs] = c[rs] - 3;
        if (c[rs] === 0) {
            delete c[rs];
        }
    }
    for (var r = st; r < st + k; r++) {
        if ((c[String(r)] || 0) !== 0) {
            return null;
        }
    }
    var singles = 0;
    var pairs = 0;
    for (var rk in c) {
        if (!c.hasOwnProperty(rk)) {
            continue;
        }
        var cnt = c[rk];
        var irk = parseInt(rk, 10);
        if (irk >= 13) {
            return null;
        }
        if (cnt !== 1 && cnt !== 2) {
            return null;
        }
        if (cnt === 1) {
            singles++;
        }
        else {
            pairs++;
        }
    }
    if (singles + pairs !== k) {
        return null;
    }
    if (pairs !== numPairWings) {
        return null;
    }
    var ex = (k << 5) | numPairWings;
    return { kind: DDZ_KIND_PLANE_WITH_WINGS, main: st + k - 1, extra: ex };
}
function tryPlaneWithWings(counts) {
    var n = totalN(counts);
    for (var k = 2; k < 13; k++) {
        var minC = 4 * k;
        var maxC = 5 * k;
        if (n < minC || n > maxC) {
            continue;
        }
        var numPairWings = n - 4 * k;
        if (numPairWings < 0 || numPairWings > k) {
            continue;
        }
        for (var st = 0; st < 12; st++) {
            if (st + k - 1 > 11) {
                break;
            }
            var pat = matchPlaneWingsAt(counts, st, k, numPairWings);
            if (pat) {
                return pat;
            }
        }
    }
    return null;
}
function classify(cards) {
    if (cards.length === 0) {
        return { kind: DDZ_KIND_PASS, main: -1, extra: null };
    }
    var n = cards.length;
    if (n === 2) {
        var a = cards[0];
        var b = cards[1];
        if ((a === 52 && b === 53) || (a === 53 && b === 52)) {
            return { kind: DDZ_KIND_ROCKET, main: 14, extra: null };
        }
    }
    var counts = rankCounts(cards);
    var vals = [];
    var keys = [];
    for (var k in counts) {
        if (counts.hasOwnProperty(k)) {
            keys.push(k);
            vals.push(counts[k]);
        }
    }
    keys.sort(function (a, b) {
        return parseInt(a, 10) - parseInt(b, 10);
    });
    if (n === 1) {
        return { kind: DDZ_KIND_SINGLE, main: ddzRankValue(cards[0]), extra: null };
    }
    if (n === 2 && vals.length === 1 && vals[0] === 2) {
        return { kind: DDZ_KIND_PAIR, main: parseInt(keys[0], 10), extra: null };
    }
    if (n === 3 && vals.length === 1 && vals[0] === 3) {
        return { kind: DDZ_KIND_TRIPLE, main: parseInt(keys[0], 10), extra: null };
    }
    if (n === 4) {
        if (vals.length === 1 && vals[0] === 4) {
            return { kind: DDZ_KIND_BOMB, main: parseInt(keys[0], 10), extra: null };
        }
        if (isTripleSingle(counts)) {
            return { kind: DDZ_KIND_TRIPLE_WITH_SINGLE, main: tripleRankIn(counts), extra: 4 };
        }
        return { kind: DDZ_KIND_INVALID, main: -1, extra: null };
    }
    if (n === 5) {
        if (isStraight(counts, n)) {
            var sr = sortedRanks(cards);
            return { kind: DDZ_KIND_STRAIGHT, main: sr[sr.length - 1], extra: n };
        }
        if (isTriplePair(counts)) {
            return { kind: DDZ_KIND_TRIPLE_WITH_PAIR, main: tripleRankIn(counts), extra: 5 };
        }
        return { kind: DDZ_KIND_INVALID, main: -1, extra: null };
    }
    if (n >= 5) {
        if (isStraight(counts, n)) {
            var sr2 = sortedRanks(cards);
            return { kind: DDZ_KIND_STRAIGHT, main: sr2[sr2.length - 1], extra: n };
        }
    }
    if (n >= 6 && n % 2 === 0 && isPairStraight(counts)) {
        var pr = pairStraightRanks(counts);
        return { kind: DDZ_KIND_PAIR_STRAIGHT, main: pr[pr.length - 1], extra: n };
    }
    if (n === 6 && isFourTwoSingles(counts) && fourKickersNoJokerBomb(counts)) {
        return { kind: DDZ_KIND_FOUR_WITH_TWO, main: fourRankIn(counts), extra: 6 };
    }
    if (n === 8 && isFourTwoPairs(counts) && fourKickersNoJokerBomb(counts)) {
        return { kind: DDZ_KIND_FOUR_WITH_TWO, main: fourRankIn(counts), extra: 8 };
    }
    var pure = tryPurePlane(counts);
    if (pure) {
        return pure;
    }
    var pww = tryPlaneWithWings(counts);
    if (pww) {
        return pww;
    }
    return { kind: DDZ_KIND_INVALID, main: -1, extra: null };
}
function samePatternKind(a, b) {
    if (a.kind !== b.kind) {
        return false;
    }
    return a.extra === b.extra;
}
function beats(last, cur) {
    if (cur.kind === DDZ_KIND_INVALID) {
        return false;
    }
    if (last.kind === DDZ_KIND_PASS) {
        return cur.kind !== DDZ_KIND_PASS && cur.kind !== DDZ_KIND_INVALID;
    }
    if (cur.kind === DDZ_KIND_ROCKET) {
        return true;
    }
    if (last.kind === DDZ_KIND_ROCKET) {
        return false;
    }
    if (cur.kind === DDZ_KIND_BOMB) {
        if (last.kind !== DDZ_KIND_BOMB) {
            return true;
        }
        return cur.main > last.main;
    }
    if (last.kind === DDZ_KIND_BOMB) {
        return false;
    }
    if (!samePatternKind(last, cur)) {
        return false;
    }
    return cur.main > last.main;
}
function roundMultiplier(s) {
    return s.multBase * s.multRob * s.multPlay;
}
function removeCardsFromHand(hand, play) {
    var rem = play.slice();
    for (var i = 0; i < rem.length; i++) {
        var found = -1;
        var want = rem[i];
        for (var j = 0; j < hand.length; j++) {
            if (hand[j] === want) {
                found = j;
                break;
            }
        }
        if (found < 0) {
            return false;
        }
        hand.splice(found, 1);
    }
    return true;
}
/** 与客户端 `_net_norm_uid` 一致；否则 RT 消息里 userId 大小写与 presences 键不一致时 seatForUser=-1，叫牌消息被静默丢弃。 */
function normUserId(uid) {
    return uid.toLowerCase();
}
function assignSeats(state) {
    var ids = Object.keys(state.presences);
    ids.sort();
    state.seatByUserId = {};
    var eh = state.expectHumans;
    state.isAiSeat = [false, false, false];
    for (var i = 0; i < ids.length; i++) {
        state.seatByUserId[normUserId(ids[i])] = i;
    }
    for (var s = eh; s < 3; s++) {
        state.isAiSeat[s] = true;
    }
}
function seatForUser(state, userId) {
    var s = state.seatByUserId[normUserId(userId)];
    return s === undefined ? -1 : s;
}
function assignSeatCats(state, nk) {
    var arr = [0, 1, 2];
    shuffleInPlace(nk, arr);
    state.seatCat = arr;
}
function resetRound(state, nk) {
    state.phase = "deal";
    state.hands = [[], [], []];
    state.bottom = [];
    state.bids = [-1, -1, -1];
    state.callCandidate = 0;
    state.robStep = 0;
    state.landlord = 0;
    state.turn = 0;
    state.lastPattern = null;
    state.lastPlayer = -1;
    state.passes = 0;
    state.winner = -1;
    state.multBase = 1;
    state.multRob = 1;
    state.multPlay = 1;
    state.robCount = 0;
    state.playBombCount = 0;
    state.playRocketCount = 0;
    state.lastRobber = -1;
    state.bidPassFlags = [false, false, false];
    state.continueReady = [false, false, false];
    state.lastRobSkippedNoBid = false;
    var deck = makeFullDeck();
    shuffleInPlace(nk, deck);
    var sb = randomBytesCompat(nk, 8);
    state.dealSeed = Array.prototype.map
        .call(sb, function (x) {
        return ("0" + x.toString(16)).slice(-2);
    })
        .join("");
    var trace = [];
    for (var i = 0; i < 51; i++) {
        trace.push({ seat: i % 3, card: deck[i] });
    }
    state.dealTrace = trace;
    for (var i = 0; i < 17; i++) {
        state.hands[0].push(deck[i]);
        state.hands[1].push(deck[i + 17]);
        state.hands[2].push(deck[i + 34]);
    }
    state.bottom = [deck[51], deck[52], deck[53]];
    sortHand(state.hands[0]);
    sortHand(state.hands[1]);
    sortHand(state.hands[2]);
    state.phase = "bidding_call";
    var first = randomIntBelow(nk, 3);
    state.awaitSeat = first;
    state.callRoundStartSeat = first;
    state.bottomRevealIds = [];
    /** 与客户端发牌动画+停顿对齐，避免「继续下一局」后 AI 瞬间叫完 */
    state.aiPlayDelayUntilMs = Date.now() + AI_NEW_ROUND_BID_DELAY_MS;
}
function finalizeLandlordFromRob(state) {
    if (state.lastRobber >= 0) {
        state.landlord = state.lastRobber;
    }
    else {
        state.landlord = state.callCandidate;
    }
    state.phase = "play";
    mergeLandlordBottom(state);
    state.turn = state.landlord;
    clearTrick(state);
}
/** 「不叫」者不可抢：该座位自动跳过抢地主轮次。每 tick 至多推进一步，以便客户端逐条播「没叫牌不能抢」气泡。 */
function autoAdvanceRob(state) {
    if (state.phase !== "bidding_rob") {
        return false;
    }
    var cand = state.callCandidate;
    var i = (cand + 1 + state.robStep) % 3;
    if (state.bids[i] !== 0) {
        /** 已在等该座位抢/不抢时勿再返回 true，否则 matchLoop 每 tick 广播并重置 aiPlayDelayUntilMs，AI 永远轮不到 */
        if (state.awaitSeat === i) {
            return false;
        }
        state.awaitSeat = i;
        state.lastRobSkippedNoBid = false;
        return true;
    }
    state.robActionSeq++;
    state.lastRobActionSeat = i;
    state.lastRobActionWasRob = false;
    state.lastRobSkippedNoBid = true;
    if (state.robStep < 2) {
        state.robStep++;
        return true;
    }
    finalizeLandlordFromRob(state);
    return true;
}
function applyBid(state, seat, bid, nk) {
    if (state.phase !== "bidding_call") {
        return "not_in_bidding_call";
    }
    if (seat !== state.awaitSeat) {
        return "not_your_turn";
    }
    if (bid !== 0 && bid !== 1) {
        return "invalid_bid";
    }
    if (bid === 1) {
        state.bids[seat] = 1;
        state.bidPassFlags[seat] = false;
        state.callCandidate = seat;
        state.multBase = 1;
        state.phase = "bidding_rob";
        state.robStep = 0;
        state.multRob = 1;
        state.robCount = 0;
        state.lastRobber = -1;
        state.lastRobActionSeat = -1;
        state.lastRobActionWasRob = false;
        state.lastRobSkippedNoBid = false;
        autoAdvanceRob(state);
        return null;
    }
    state.bids[seat] = 0;
    state.bidPassFlags[seat] = true;
    var passCount = 0;
    for (var j = 0; j < 3; j++) {
        if (state.bids[j] === 0) {
            passCount++;
        }
    }
    if (passCount >= 3) {
        resetRound(state, nk);
        return null;
    }
    state.awaitSeat = (seat + 1) % 3;
    return null;
}
function mergeLandlordBottom(state) {
    var L = state.landlord;
    state.bottomRevealIds = state.bottom.slice();
    for (var i = 0; i < state.bottom.length; i++) {
        state.hands[L].push(state.bottom[i]);
    }
    sortHand(state.hands[L]);
    state.bottom = [];
}
function clearTrick(state) {
    state.lastPattern = null;
    state.lastPlayer = -1;
    state.passes = 0;
    state.lastPlayIds = [];
}
function applyRob(state, seat, doRob) {
    if (state.phase !== "bidding_rob") {
        return "not_in_rob";
    }
    var cand = state.callCandidate;
    var i = (cand + 1 + state.robStep) % 3;
    if (seat !== i) {
        return "not_your_turn";
    }
    if (doRob) {
        state.multRob *= 2;
        state.robCount++;
        state.lastRobber = seat;
    }
    state.robActionSeq++;
    state.lastRobActionSeat = seat;
    state.lastRobActionWasRob = doRob;
    state.lastRobSkippedNoBid = false;
    if (state.robStep < 2) {
        state.robStep++;
        autoAdvanceRob(state);
    }
    else {
        finalizeLandlordFromRob(state);
    }
    return null;
}
function applyPlay(state, seat, cardIds) {
    if (state.phase !== "play") {
        return "not_in_play";
    }
    if (seat !== state.turn) {
        return "not_your_turn";
    }
    var pat = classify(cardIds);
    if (pat.kind === DDZ_KIND_PASS || pat.kind === DDZ_KIND_INVALID) {
        return "invalid_play";
    }
    var last = state.lastPattern;
    var effectiveLast = last
        ? last
        : {
            kind: DDZ_KIND_PASS,
            main: -1,
            extra: null,
        };
    var trickFree = !last || last.kind === DDZ_KIND_PASS || state.passes >= 2;
    if (!trickFree && !beats(effectiveLast, pat)) {
        return "cannot_beat";
    }
    var hand = state.hands[seat];
    var copy = hand.slice();
    if (!removeCardsFromHand(copy, cardIds)) {
        return "cards_not_in_hand";
    }
    state.hands[seat] = copy;
    if (pat.kind === DDZ_KIND_BOMB) {
        state.multPlay *= 2;
        state.playBombCount++;
    }
    else if (pat.kind === DDZ_KIND_ROCKET) {
        state.multPlay *= 4;
        state.playRocketCount++;
    }
    state.lastPattern = pat;
    state.lastPlayer = seat;
    state.lastPlayIds = cardIds.slice();
    state.passes = 0;
    if (state.hands[seat].length === 0) {
        state.winner = seat;
        state.phase = "finished";
        state.continueReady = [false, false, false];
        return null;
    }
    state.turn = (seat + 1) % 3;
    return null;
}
function applyContinue(state, seat, nk) {
    if (state.phase !== "finished") {
        return "not_in_finished";
    }
    state.continueReady[seat] = true;
    var all = true;
    for (var i = 0; i < 3; i++) {
        if (!state.continueReady[i]) {
            all = false;
            break;
        }
    }
    if (all) {
        resetRound(state, nk);
    }
    return null;
}
function applyPass(state, seat) {
    if (state.phase !== "play") {
        return "not_in_play";
    }
    if (seat !== state.turn) {
        return "not_your_turn";
    }
    var last = state.lastPattern;
    if (!last || last.kind === DDZ_KIND_PASS) {
        return "cannot_pass";
    }
    state.passes++;
    state.turn = (seat + 1) % 3;
    if (state.passes >= 2) {
        state.lastPattern = null;
        state.lastPlayIds = [];
        state.passes = 0;
        state.turn = state.lastPlayer;
    }
    return null;
}
function settlementFarmersWin(state) {
    return state.winner >= 0 && state.winner !== state.landlord;
}
/** 春天：对手全程未出牌；地主 20 张、农民各 17 张未动 */
function springBonus(state) {
    if (state.winner < 0) {
        return false;
    }
    if (settlementFarmersWin(state)) {
        return state.hands[state.landlord].length === 20;
    }
    return state.hands[(state.landlord + 1) % 3].length === 17 && state.hands[(state.landlord + 2) % 3].length === 17;
}
/** 每人游戏币 delta：基础筹码 100 × 最终倍率；地主赢 +100×m×2 / 农民各 -100×m；农民赢则相反（与客户端 main.gd 一致，不含春天加倍） */
function computeScoreDeltas(state) {
    var m = roundMultiplier(state);
    var base = 100;
    var out = [0, 0, 0];
    if (state.winner < 0) {
        return out;
    }
    var L = state.landlord;
    var isFarmWin = settlementFarmersWin(state);
    if (isFarmWin) {
        out[L] = -base * m * 2;
        var f1 = (L + 1) % 3;
        var f2 = (L + 2) % 3;
        out[f1] = base * m;
        out[f2] = base * m;
    }
    else {
        out[L] = base * m * 2;
        var f1 = (L + 1) % 3;
        var f2 = (L + 2) % 3;
        out[f1] = -base * m;
        out[f2] = -base * m;
    }
    return out;
}
function buildPublicSnapshot(state) {
    var handsPublic = [[], [], []];
    for (var s = 0; s < 3; s++) {
        handsPublic[s] = state.hands[s].map(function () {
            return -1;
        });
    }
    var payload = {
        v: 1,
        seq: state.seq,
        phase: state.phase,
        seatByUserId: state.seatByUserId,
        bids: state.bids,
        landlord: state.landlord,
        turn: state.turn,
        awaitSeat: state.awaitSeat,
        mult: roundMultiplier(state),
        multBase: state.multBase,
        multRob: state.multRob,
        multPlay: state.multPlay,
        lastPattern: state.lastPattern,
        lastPlayer: state.lastPlayer,
        passes: state.passes,
        winner: state.winner,
        bottomCount: state.bottom.length,
        handsCount: [state.hands[0].length, state.hands[1].length, state.hands[2].length],
        handsPublic: handsPublic,
        dealSeed: state.dealSeed,
        dealTrace: state.dealTrace,
        robStep: state.robStep,
        callCandidate: state.callCandidate,
        lastPlayIds: state.lastPlayIds,
        robCount: state.robCount,
        lastRobber: state.lastRobber,
        playBombCount: state.playBombCount,
        playRocketCount: state.playRocketCount,
        continueReady: state.continueReady,
        seatCat: state.seatCat,
        bottomRevealIds: state.bottomRevealIds,
        callRoundStartSeat: state.callRoundStartSeat,
        robActionSeq: state.robActionSeq,
        lastRobActionSeat: state.lastRobActionSeat,
        lastRobActionWasRob: state.lastRobActionWasRob,
        lastRobSkippedNoBid: state.lastRobSkippedNoBid,
    };
    return JSON.stringify(payload);
}
function broadcastState(dispatcher, state, logger, reason) {
    state.seq++;
    try {
        var snap = buildPublicSnapshot(state);
        dispatcher.broadcastMessage(DDZ_OP_SNAPSHOT, snap, null, null);
        var userIds = Object.keys(state.presences);
        for (var u = 0; u < userIds.length; u++) {
            var uid = userIds[u];
            var seat = seatForUser(state, uid);
            if (seat < 0) {
                logger.warn("broadcastState(%s): seat missing for userId=%s", reason, uid);
                continue;
            }
            var handMsg = JSON.stringify({
                v: 1,
                seq: state.seq,
                yourSeat: seat,
                yourHand: state.hands[seat],
            });
            var pres = state.presences[uid];
            dispatcher.broadcastMessage(DDZ_OP_SNAPSHOT, handMsg, [pres], null);
        }
        if (reason.indexOf("join") >= 0) {
            logger.info("ddz broadcastState ok [%s]: seq=%d phase=%s players=%d", reason, state.seq, state.phase, userIds.length);
        }
    }
    catch (e) {
        logger.error("ddz broadcastState FAILED [%s]: %s | phase=%s seq=%d", reason, String(e), state.phase, state.seq);
    }
}
function initialState() {
    return {
        presences: {},
        seatByUserId: {},
        expectHumans: 3,
        aiCount: 0,
        isAiSeat: [false, false, false],
        phase: "waiting",
        hands: [[], [], []],
        bottom: [],
        bids: [-1, -1, -1],
        callCandidate: 0,
        robStep: 0,
        landlord: 0,
        turn: 0,
        lastPattern: null,
        lastPlayer: -1,
        passes: 0,
        winner: -1,
        multBase: 1,
        multRob: 1,
        multPlay: 1,
        robCount: 0,
        playBombCount: 0,
        playRocketCount: 0,
        lastRobber: -1,
        dealSeed: "",
        seq: 0,
        awaitSeat: 0,
        callRoundStartSeat: 0,
        robActionSeq: 0,
        lastRobActionSeat: -1,
        lastRobActionWasRob: false,
        lastRobSkippedNoBid: false,
        bidPassFlags: [false, false, false],
        errorLog: [],
        lastPlayIds: [],
        continueReady: [false, false, false],
        seatCat: [0, 1, 2],
        aiPlayDelayUntilMs: 0,
        bottomRevealIds: [],
        dealTrace: [],
    };
}
function ddzMatchInit(ctx, logger, nk, params) {
    logger.info("ddz matchInit: params=%s", JSON.stringify(params));
    var st = initialState();
    if (params["expect_humans"]) {
        st.expectHumans = parseInt(params["expect_humans"], 10);
    }
    if (params["ai"]) {
        st.aiCount = parseInt(params["ai"], 10);
    }
    if (st.expectHumans + st.aiCount !== 3) {
        logger.warn("ddz matchInit: expect_humans+ai!=3, clamping ai");
        st.aiCount = 3 - st.expectHumans;
    }
    return {
        state: st,
        tickRate: 10,
        label: "ddz",
    };
}
function ddzMatchJoinAttempt(ctx, logger, nk, dispatcher, tick, state, presence, metadata) {
    var st = state;
    var n = Object.keys(st.presences).length;
    if (n >= st.expectHumans) {
        logger.warn("ddz matchJoinAttempt REJECT full: userId=%s username=%s currentCount=%d expectHumans=%d", presence.userId, presence.username, n, st.expectHumans);
        return { state: state, accept: false, rejectMessage: "full" };
    }
    logger.info("ddz matchJoinAttempt accept: userId=%s username=%s sessionId=%s currentCount=%d->%d", presence.userId, presence.username, presence.sessionId, n, n + 1);
    return { state: state, accept: true };
}
function ddzMatchJoin(ctx, logger, nk, dispatcher, tick, state, presences) {
    var st = state;
    var joinedIds = [];
    for (var i = 0; i < presences.length; i++) {
        var p = presences[i];
        st.presences[p.userId] = p;
        joinedIds.push(p.userId);
    }
    assignSeats(st);
    var n = Object.keys(st.presences).length;
    logger.info("ddz matchJoin: tick=%d joinedThisBatch=%s totalPlayers=%d phaseBefore=%s seatByUserId=%s", tick, JSON.stringify(joinedIds), n, st.phase, JSON.stringify(st.seatByUserId));
    if (n === st.expectHumans && st.phase === "waiting") {
        assignSeatCats(st, nk);
        resetRound(st, nk);
        logger.info("ddz matchJoin: resetRound done -> phase=%s dealSeed len=%d", st.phase, st.dealSeed.length);
        broadcastState(dispatcher, st, logger, "join-after-resetRound");
    }
    else {
        broadcastState(dispatcher, st, logger, "join");
    }
    return { state: st };
}
/**
 * Nakama `MatchMessage.data` 类型为 ArrayBuffer（见 nakama-runtime index.d.ts）。
 * 使用 String(msg.data) 会得到 "[object ArrayBuffer]"，JSON.parse 失败且被 catch 吃掉 → 叫牌/出牌等全部不生效。
 */
function decodeMatchData(data) {
    if (data === null || data === undefined) {
        return "";
    }
    if (typeof data === "string") {
        return data;
    }
    var ab = data;
    if (typeof TextDecoder !== "undefined") {
        try {
            return new TextDecoder("utf-8").decode(ab);
        }
        catch (e) {
            // fall through
        }
    }
    var u8 = new Uint8Array(ab);
    var bufAny = globalThis
        .Buffer;
    if (typeof bufAny !== "undefined") {
        return bufAny.from(u8).toString("utf8");
    }
    var s = "";
    for (var i = 0; i < u8.length; i++) {
        s += String.fromCharCode(u8[i]);
    }
    return s;
}
function ddzMatchLeave(ctx, logger, nk, dispatcher, tick, state, presences) {
    var st = state;
    for (var i = 0; i < presences.length; i++) {
        delete st.presences[presences[i].userId];
    }
    assignSeats(st);
    return { state: st };
}
function ddzMatchLoop(ctx, logger, nk, dispatcher, tick, state, messages) {
    var st = state;
    /** 与 ddz_ai_server 中 AI 连动共用 aiPlayDelayUntilMs，避免 matchLoop 每 100ms 连推抢地主跳过 */
    if (st.phase === "bidding_rob") {
        if (Date.now() >= st.aiPlayDelayUntilMs && autoAdvanceRob(st)) {
            broadcastState(dispatcher, st, logger, "autoAdvanceRob");
            st.aiPlayDelayUntilMs = Date.now() + AI_BID_ROB_PACE_MS;
        }
    }
    for (var m = 0; m < messages.length; m++) {
        var msg = messages[m];
        var senderId = msg.sender.userId;
        var seat = seatForUser(st, senderId);
        if (seat < 0) {
            logger.warn("ddz matchLoop: unknown sender userId=%s keys=%s", senderId, JSON.stringify(Object.keys(st.seatByUserId)));
            continue;
        }
        var payload = void 0;
        var rawJson = decodeMatchData(msg.data);
        try {
            payload = JSON.parse(rawJson);
        }
        catch (e) {
            logger.warn("ddz matchLoop: JSON.parse failed op=%d seat=%d err=%s raw=%s", msg.opCode, seat, String(e), rawJson.length > 120 ? rawJson.substring(0, 120) + "…" : rawJson);
            continue;
        }
        var err = null;
        if (msg.opCode === DDZ_REQ_BID) {
            var rawBid = payload.bid;
            var bidNum = -1;
            if (rawBid !== undefined && rawBid !== null) {
                if (typeof rawBid === "string") {
                    bidNum = parseInt(String(rawBid), 10);
                }
                else {
                    bidNum = Number(rawBid);
                }
            }
            if (!Number.isFinite(bidNum)) {
                bidNum = -1;
            }
            err = applyBid(st, seat, bidNum, nk);
            if (!err && !st.isAiSeat[seat]) {
                st.aiPlayDelayUntilMs = Date.now() + AI_BID_ROB_PACE_MS;
            }
        }
        else if (msg.opCode === DDZ_REQ_ROB) {
            err = applyRob(st, seat, Boolean(payload.rob));
            if (!err && !st.isAiSeat[seat]) {
                st.aiPlayDelayUntilMs = Date.now() + AI_BID_ROB_PACE_MS;
            }
        }
        else if (msg.opCode === DDZ_REQ_PLAY) {
            var cards = payload.cards || [];
            err = applyPlay(st, seat, cards);
            if (!err && !st.isAiSeat[seat]) {
                st.aiPlayDelayUntilMs = Date.now() + AI_BID_ROB_PACE_MS;
            }
        }
        else if (msg.opCode === DDZ_REQ_PASS) {
            err = applyPass(st, seat);
            if (!err && !st.isAiSeat[seat]) {
                st.aiPlayDelayUntilMs = Date.now() + AI_BID_ROB_PACE_MS;
            }
        }
        else if (msg.opCode === DDZ_REQ_CONTINUE) {
            err = applyContinue(st, seat, nk);
        }
        if (err) {
            try {
                dispatcher.broadcastMessage(DDZ_OP_ERROR, JSON.stringify({ seq: st.seq, seat: seat, error: err }), [msg.sender], null);
            }
            catch (e2) {
                logger.error("send err: %v", String(e2));
            }
        }
        else {
            broadcastState(dispatcher, st, logger, "matchLoop");
            if (st.phase === "finished") {
                var deltas = computeScoreDeltas(st);
                var settlement = JSON.stringify({
                    v: 1,
                    winner: st.winner,
                    landlord: st.landlord,
                    farmersWin: settlementFarmersWin(st),
                    spring: springBonus(st),
                    scoreDelta: deltas,
                    mult: roundMultiplier(st),
                });
                dispatcher.broadcastMessage(DDZ_OP_SETTLEMENT, settlement, null, null);
            }
        }
    }
    maybeAutoContinueWithAi(st, dispatcher, logger, nk);
    runAiUntilHumanOrDone(st, dispatcher, logger, nk);
    return { state: st };
}
function ddzMatchTerminate(ctx, logger, nk, dispatcher, tick, state, graceSeconds) {
    return { state: state };
}
function ddzMatchSignal(ctx, logger, nk, dispatcher, tick, state, data) {
    return { state: state, data: "ok" };
}
var ddzMatchHandler = {
    matchInit: ddzMatchInit,
    matchJoinAttempt: ddzMatchJoinAttempt,
    matchJoin: ddzMatchJoin,
    matchLeave: ddzMatchLeave,
    matchLoop: ddzMatchLoop,
    matchTerminate: ddzMatchTerminate,
    matchSignal: ddzMatchSignal,
};
function ddzMatchmakerMatched(ctx, logger, nk, matches) {
    logger.info("ddz matchmakerMatched: callback invoked, resultCount=%d", matches.length);
    for (var i = 0; i < matches.length; i++) {
        var row = matches[i];
        logger.info("  ddz matchmakerMatched[%d]: userId=%s username=%s sessionId=%s partyId=%s props=%s", i, row.presence.userId, row.presence.username, row.presence.sessionId, row.partyId !== undefined ? row.partyId : "", JSON.stringify(row.properties));
    }
    if (matches.length === 0) {
        logger.error("ddz matchmakerMatched: empty matches array — will not call matchCreate (clients get no match id)");
        return;
    }
    if (matches.length !== 3) {
        logger.warn("ddz matchmakerMatched: expected 3 players for ddz, got %d — matchCreate may still run", matches.length);
    }
    try {
        logger.info("ddz matchmakerMatched: calling nk.matchCreate(\"ddz\", {expect_humans:3}) ...");
        var id = nk.matchCreate("ddz", { expect_humans: "3", ai: "0" });
        if (!id || String(id).length === 0) {
            logger.error("ddz matchmakerMatched: nk.matchCreate returned empty id");
            return;
        }
        logger.info("ddz matchmakerMatched: success match_id=%s for %d players", id, matches.length);
        return id;
    }
    catch (e) {
        logger.error("ddz matchmakerMatched: nk.matchCreate threw: %s", String(e));
        return;
    }
}
var DDZ_MM_WAIT_MS = 20000;
var DDZ_MM_COLLECTION = "ddz_mm";
var DDZ_MM_STATE_KEY = "queue_state";
/** 与 nkruntime.SystemUserId 一致：服务端全局存储归属 */
var DDZ_MM_OWNER = "00000000-0000-0000-0000-000000000000";
/** 时间戳 + 随机字节生成 ticket（无模块可变状态）。 */
function ddzMmMakeTicket(nk) {
    var u = randomBytesCompat(nk, 8);
    var hex = Array.prototype.map
        .call(u, function (x) {
        return ("0" + x.toString(16)).slice(-2);
    })
        .join("");
    return "ddzmm_" + Date.now().toString(36) + "_" + hex;
}
function ddzMmLoadState(nk) {
    var rows = nk.storageRead([
        { collection: DDZ_MM_COLLECTION, key: DDZ_MM_STATE_KEY, userId: DDZ_MM_OWNER },
    ]);
    if (!rows || rows.length === 0) {
        return { state: { entries: [], results: {} }, version: "" };
    }
    var obj = rows[0];
    var clone = JSON.parse(JSON.stringify(obj.value));
    var entries = [];
    if (Array.isArray(clone.entries)) {
        for (var i = 0; i < clone.entries.length; i++) {
            var e = clone.entries[i];
            if (e && typeof e.userId === "string" && typeof e.ticket === "string") {
                entries.push({
                    userId: e.userId,
                    username: typeof e.username === "string" ? e.username : "",
                    joinedAtMs: typeof e.joinedAtMs === "number" ? e.joinedAtMs : 0,
                    ticket: e.ticket,
                });
            }
        }
    }
    var results = {};
    if (clone.results && typeof clone.results === "object" && clone.results !== null) {
        var rawR = clone.results;
        for (var k in rawR) {
            if (rawR.hasOwnProperty(k)) {
                var r = rawR[k];
                if (r && typeof r.matchId === "string") {
                    results[k] = { matchId: r.matchId };
                }
            }
        }
    }
    return { state: { entries: entries, results: results }, version: obj.version };
}
function ddzMmSaveState(nk, state, version) {
    var req = {
        collection: DDZ_MM_COLLECTION,
        key: DDZ_MM_STATE_KEY,
        userId: DDZ_MM_OWNER,
        value: {
            entries: state.entries,
            results: state.results,
        },
    };
    if (version && version.length > 0) {
        req.version = version;
    }
    nk.storageWrite([req]);
}
function ddzMmMutateState(nk, logger, mutator) {
    var maxTries = 24;
    for (var attempt = 0; attempt < maxTries; attempt++) {
        var loaded = ddzMmLoadState(nk);
        mutator(loaded.state);
        try {
            ddzMmSaveState(nk, loaded.state, loaded.version);
            return;
        }
        catch (e) {
            logger.warn("ddz_mm storage write retry %d: %s", attempt, String(e));
        }
    }
    throw new Error("ddz_mm_storage_failed");
}
function ddzMmNotifyResults(state, tickets, matchId) {
    for (var i = 0; i < tickets.length; i++) {
        state.results[tickets[i]] = { matchId: matchId };
    }
}
function ddzMmCreateMatchInner(nk, logger, entries, humans, ai) {
    var id;
    try {
        id = nk.matchCreate("ddz", {
            expect_humans: String(humans),
            ai: String(ai),
        });
    }
    catch (e) {
        logger.error("ddz_mm matchCreate: %s", String(e));
        return null;
    }
    if (!id || String(id).length === 0) {
        logger.error("ddz_mm matchCreate empty id");
        return null;
    }
    logger.info("ddz_mm: created match %s humans=%d ai=%d", id, humans, ai);
    return id;
}
function ddzMmProcessQueueCore(state, nk, logger) {
    var now = Date.now();
    var q = state.entries.slice();
    q.sort(function (a, b) {
        return a.joinedAtMs - b.joinedAtMs;
    });
    while (q.length >= 3) {
        var a = q[0];
        var b = q[1];
        var c = q[2];
        var id = ddzMmCreateMatchInner(nk, logger, [a, b, c], 3, 0);
        if (!id) {
            break;
        }
        q.splice(0, 3);
        ddzMmNotifyResults(state, [a.ticket, b.ticket, c.ticket], id);
    }
    if (q.length >= 2) {
        var a = q[0];
        var b = q[1];
        var oldest = Math.min(a.joinedAtMs, b.joinedAtMs);
        if (now - oldest >= DDZ_MM_WAIT_MS) {
            var id = ddzMmCreateMatchInner(nk, logger, [a, b], 2, 1);
            if (id) {
                q.splice(0, 2);
                ddzMmNotifyResults(state, [a.ticket, b.ticket], id);
            }
        }
    }
    if (q.length >= 1) {
        var a = q[0];
        if (now - a.joinedAtMs >= DDZ_MM_WAIT_MS) {
            var id = ddzMmCreateMatchInner(nk, logger, [a], 1, 2);
            if (id) {
                q.splice(0, 1);
                ddzMmNotifyResults(state, [a.ticket], id);
            }
        }
    }
    state.entries = q;
}
function rpcDdzMmJoin(ctx, logger, nk, payload) {
    var uid = ctx.userId;
    if (!uid) {
        return JSON.stringify({ ok: false, error: "unauthorized" });
    }
    var outTicket = "";
    try {
        ddzMmMutateState(nk, logger, function (st) {
            var nextEntries = [];
            for (var i = 0; i < st.entries.length; i++) {
                if (st.entries[i].userId !== uid) {
                    nextEntries.push(st.entries[i]);
                }
                else {
                    delete st.results[st.entries[i].ticket];
                }
            }
            var ticket = ddzMmMakeTicket(nk);
            var username = "";
            try {
                var acc = nk.accountGetId(uid);
                if (acc && acc.user && acc.user.username) {
                    username = acc.user.username;
                }
            }
            catch (e) {
                logger.warn("ddz_mm accountGetId: %s", String(e));
            }
            nextEntries.push({
                userId: uid,
                username: username,
                joinedAtMs: Date.now(),
                ticket: ticket,
            });
            st.entries = nextEntries;
            outTicket = ticket;
        });
    }
    catch (e) {
        logger.error("ddz_mm join storage: %s", String(e));
        return JSON.stringify({ ok: false, error: "storage_busy" });
    }
    logger.info("ddz_mm join user=%s ticket=%s", uid, outTicket);
    return JSON.stringify({ ok: true, ticket: outTicket });
}
function rpcDdzMmPoll(ctx, logger, nk, payload) {
    var ticket = "";
    try {
        var u = JSON.parse(payload || "{}");
        ticket = String(u.ticket || "");
    }
    catch (e) {
        return JSON.stringify({ ok: false, error: "bad_payload" });
    }
    if (!ticket) {
        return JSON.stringify({ ok: false, error: "no_ticket" });
    }
    var response = JSON.stringify({ ok: true, status: "waiting" });
    try {
        ddzMmMutateState(nk, logger, function (st) {
            ddzMmProcessQueueCore(st, nk, logger);
            var r = st.results[ticket];
            if (r && r.matchId) {
                delete st.results[ticket];
                response = JSON.stringify({ ok: true, status: "matched", match_id: r.matchId });
            }
        });
    }
    catch (e) {
        logger.error("ddz_mm poll storage: %s", String(e));
        return JSON.stringify({ ok: false, error: "storage_busy" });
    }
    return response;
}
function rpcDdzMmCancel(ctx, logger, nk, payload) {
    var ticket = "";
    try {
        var u = JSON.parse(payload || "{}");
        ticket = String(u.ticket || "");
    }
    catch (e) {
        return JSON.stringify({ ok: false });
    }
    if (!ticket) {
        return JSON.stringify({ ok: false });
    }
    try {
        ddzMmMutateState(nk, logger, function (st) {
            var next = [];
            for (var i = 0; i < st.entries.length; i++) {
                if (st.entries[i].ticket !== ticket) {
                    next.push(st.entries[i]);
                }
            }
            st.entries = next;
            delete st.results[ticket];
        });
    }
    catch (e) {
        logger.error("ddz_mm cancel storage: %s", String(e));
        return JSON.stringify({ ok: false, error: "storage_busy" });
    }
    return JSON.stringify({ ok: true });
}
var WALLET_COLLECTION = "doudizhu";
var WALLET_KEY = "wallet";
var WALLET_INITIAL = 3000;
function walletRead(nk, userId) {
    var rows = nk.storageRead([{ collection: WALLET_COLLECTION, key: WALLET_KEY, userId: userId }]);
    if (!rows || rows.length === 0) {
        return { coins: 0, version: "" };
    }
    var v = rows[0].value;
    var c = typeof v.coins === "number" && Number.isFinite(v.coins) ? Math.floor(v.coins) : 0;
    return { coins: c, version: rows[0].version || "" };
}
function walletWrite(nk, userId, coins, version) {
    var req = {
        collection: WALLET_COLLECTION,
        key: WALLET_KEY,
        userId: userId,
        value: { coins: coins },
        permissionRead: 1,
        permissionWrite: 1,
    };
    if (version && version.length > 0) {
        req.version = version;
    }
    nk.storageWrite([req]);
}
function rpcWalletSync(ctx, logger, nk, payload) {
    var uid = ctx.userId;
    if (!uid) {
        return JSON.stringify({ ok: false, error: "unauthorized" });
    }
    var r = walletRead(nk, uid);
    var coins = r.coins;
    if (coins <= 0) {
        coins = WALLET_INITIAL;
        try {
            walletWrite(nk, uid, coins, r.version);
        }
        catch (e) {
            logger.error("wallet_sync write: %s", String(e));
            return JSON.stringify({ ok: false, error: "storage_write" });
        }
    }
    return JSON.stringify({ ok: true, coins: coins });
}
function rpcWalletBuy(ctx, logger, nk, payload) {
    return rpcWalletApplyDelta(ctx, logger, nk, JSON.stringify({ delta: 100 }));
}
function rpcWalletApplyDelta(ctx, logger, nk, payload) {
    var uid = ctx.userId;
    if (!uid) {
        return JSON.stringify({ ok: false, error: "unauthorized" });
    }
    var delta = 0;
    try {
        var p = JSON.parse(payload || "{}");
        delta = Math.floor(Number(p.delta));
    }
    catch (e) {
        return JSON.stringify({ ok: false, error: "bad_payload" });
    }
    if (!Number.isFinite(delta)) {
        return JSON.stringify({ ok: false, error: "bad_delta" });
    }
    if (delta > 5000000 || delta < -5000000) {
        return JSON.stringify({ ok: false, error: "delta_out_of_range" });
    }
    var r = walletRead(nk, uid);
    var newCoins = r.coins + delta;
    if (newCoins < 0) {
        newCoins = 0;
    }
    try {
        walletWrite(nk, uid, newCoins, r.version);
    }
    catch (e) {
        logger.error("wallet_apply_delta: %s", String(e));
        return JSON.stringify({ ok: false, error: "storage_write" });
    }
    return JSON.stringify({ ok: true, coins: newCoins });
}
var InitModule = function (ctx, logger, nk, initializer) {
    initializer.registerMatch("ddz", ddzMatchHandler);
    initializer.registerMatchmakerMatched(ddzMatchmakerMatched);
    initializer.registerRpc("ddz_mm_join", rpcDdzMmJoin);
    initializer.registerRpc("ddz_mm_poll", rpcDdzMmPoll);
    initializer.registerRpc("ddz_mm_cancel", rpcDdzMmCancel);
    initializer.registerRpc("wallet_sync", rpcWalletSync);
    initializer.registerRpc("wallet_buy", rpcWalletBuy);
    initializer.registerRpc("wallet_apply_delta", rpcWalletApplyDelta);
    logger.info("Dou Dizhu authoritative match registered as 'ddz'");
};
// @ts-nocheck
/**
 * 服务端斗地主 AI：与客户端 scripts/ddz_ai.gd / ddz_ai_play.gd 策略对齐。
 * 依赖 main.ts 中的 classify、beats、ddzRankValue、DdzHandPattern、DDZ_KIND_*。
 */
var AI_STYLE_NORMAL = 0;
var AI_STYLE_AGGRESSIVE = 1;
var AI_STYLE_PASSIVE = 2;
/** 专业级：略抬叫分/抢地主积极性，记牌式跟牌更果断，少无谓让牌 */
var AI_PRO_MODE = true;
function aiProStyle(style) {
    if (!AI_PRO_MODE) {
        return style;
    }
    if (style === AI_STYLE_NORMAL) {
        return AI_STYLE_AGGRESSIVE;
    }
    if (style === AI_STYLE_PASSIVE) {
        return AI_STYLE_NORMAL;
    }
    return style;
}
function aiStyleFromCatId(catId) {
    if (catId === 1) {
        return AI_STYLE_AGGRESSIVE;
    }
    if (catId === 2) {
        return AI_STYLE_PASSIVE;
    }
    return AI_STYLE_NORMAL;
}
function aiBuckets(hand) {
    var b = {};
    for (var i = 0; i < hand.length; i++) {
        var cid = hand[i];
        var r = ddzRankValue(cid);
        var k = String(r);
        if (!b[k]) {
            b[k] = [];
        }
        b[k].push(cid);
    }
    for (var k in b) {
        if (b.hasOwnProperty(k)) {
            b[k].sort(function (a, c) {
                return a - c;
            });
        }
    }
    return b;
}
function aiRankWeightLandlord(r) {
    if (r <= 6) {
        return 0.35 + r * 0.04;
    }
    if (r <= 8) {
        return 1.05;
    }
    if (r <= 10) {
        return 1.55;
    }
    if (r === 11) {
        return 2.35;
    }
    if (r === 12) {
        return 3.6;
    }
    if (r === 13) {
        return 4.8;
    }
    if (r === 14) {
        return 5.8;
    }
    return 0.0;
}
function aiHandLandlordStrength(hand) {
    var b = aiBuckets(hand);
    var s = 0.0;
    for (var rk in b) {
        if (!b.hasOwnProperty(rk)) {
            continue;
        }
        var r = parseInt(rk, 10);
        var arr = b[rk];
        var n = arr.length;
        var w = aiRankWeightLandlord(r);
        s += n * w;
        if (n === 2 || n === 3) {
            s += 0.2 * n * w;
        }
        if (n >= 4) {
            s += 11.0;
        }
    }
    var a13 = b["13"] || [];
    var a14 = b["14"] || [];
    if (a13.length >= 1 && a14.length >= 1) {
        s += 7.0;
    }
    return s;
}
/** 仅「不叫」0 或「叫地主」1（与 main.applyBid 一致） */
function aiChooseBid(hand, style) {
    var s = aiHandLandlordStrength(hand);
    var t = 20.0;
    if (AI_PRO_MODE) {
        t -= 2.0;
    }
    if (style === AI_STYLE_AGGRESSIVE) {
        t -= 3.5;
    }
    else if (style === AI_STYLE_PASSIVE) {
        t += 3.0;
    }
    return s >= t ? 1 : 0;
}
function aiChooseRobLandlord(hand, currentMultiplier, style) {
    var s = aiHandLandlordStrength(hand);
    var floorS = 18.0;
    var need = 30.0;
    if (AI_PRO_MODE) {
        floorS -= 2.5;
        need -= 3.0;
    }
    if (currentMultiplier >= 4) {
        need = 44.0;
    }
    else if (currentMultiplier >= 2) {
        need = 36.0;
    }
    if (style === AI_STYLE_AGGRESSIVE) {
        floorS = 14.0;
        if (currentMultiplier >= 4) {
            need = 39.0;
        }
        else if (currentMultiplier >= 2) {
            need = 31.0;
        }
        else {
            need = 25.0;
        }
    }
    else if (style === AI_STYLE_PASSIVE) {
        floorS = 22.0;
        if (currentMultiplier >= 4) {
            need = 50.0;
        }
        else if (currentMultiplier >= 2) {
            need = 42.0;
        }
        else {
            need = 36.0;
        }
    }
    if (s < floorS) {
        return false;
    }
    return s >= need;
}
function aiIsFarmer(me, landlord) {
    return me !== landlord;
}
function aiTeammateFarmer(me, landlord) {
    if (me === landlord) {
        return -1;
    }
    for (var i = 0; i < 3; i++) {
        if (i !== landlord && i !== me) {
            return i;
        }
    }
    return -1;
}
function aiIsFarmerYieldPass(ctx, last) {
    if (!last || last.kind === DDZ_KIND_PASS || last.kind === DDZ_KIND_ROCKET) {
        return false;
    }
    var me = ctx.me;
    var ld = ctx.landlord;
    var lastPl = ctx.last_player;
    var passes = ctx.passes;
    var ast = ctx.ai_style;
    if (aiIsFarmer(me, ld) && passes === 1) {
        var mate = aiTeammateFarmer(me, ld);
        if (mate === lastPl) {
            if (AI_PRO_MODE) {
                return ast === AI_STYLE_PASSIVE;
            }
            return ast !== AI_STYLE_AGGRESSIVE;
        }
    }
    return false;
}
function aiShouldAvoidBomb(ctx, hand, last) {
    var lastIsBomb = last.kind === DDZ_KIND_BOMB;
    if (lastIsBomb) {
        return false;
    }
    var minO = ctx.min_opp_cards;
    var ast = ctx.ai_style;
    var longH = hand.length >= 10;
    var oppHeavy = minO >= 9;
    if (ast === AI_STYLE_AGGRESSIVE) {
        if (AI_PRO_MODE) {
            return oppHeavy && longH && minO >= 14;
        }
        return oppHeavy && longH && minO >= 12;
    }
    if (ast === AI_STYLE_PASSIVE) {
        return minO >= 6 && hand.length >= 8;
    }
    if (AI_PRO_MODE) {
        return oppHeavy && longH && minO >= 11;
    }
    return oppHeavy && longH;
}
function aiTrySamePattern(b, last) {
    var lk = last.kind;
    var main = last.main;
    var extra = last.extra;
    if (lk === DDZ_KIND_SINGLE) {
        return aiFollowSingle(b, main);
    }
    if (lk === DDZ_KIND_PAIR) {
        return aiFollowPair(b, main);
    }
    if (lk === DDZ_KIND_TRIPLE) {
        return aiFollowTriple(b, main);
    }
    if (lk === DDZ_KIND_STRAIGHT) {
        return aiFollowStraight(b, main, extra === null ? 0 : extra);
    }
    if (lk === DDZ_KIND_TRIPLE_WITH_SINGLE) {
        return aiFollowTripleSingle(b, main);
    }
    if (lk === DDZ_KIND_TRIPLE_WITH_PAIR) {
        return aiFollowTriplePair(b, main);
    }
    if (lk === DDZ_KIND_PAIR_STRAIGHT) {
        return aiFollowPairStraight(b, main, extra === null ? 0 : extra);
    }
    if (lk === DDZ_KIND_FOUR_WITH_TWO) {
        return aiFollowFourWithTwo(b, main, extra === null ? 0 : extra);
    }
    if (lk === DDZ_KIND_PLANE) {
        return aiFollowPlanePure(b, main, extra === null ? 0 : extra);
    }
    if (lk === DDZ_KIND_PLANE_WITH_WINGS) {
        return aiFollowPlaneWithWings(b, main, extra === null ? 0 : extra);
    }
    if (lk === DDZ_KIND_BOMB) {
        return [];
    }
    return [];
}
function aiFollowSingle(b, needGt) {
    for (var r = needGt + 1; r < 15; r++) {
        var arr = b[String(r)] || [];
        if (arr.length >= 1) {
            return [arr[0]];
        }
    }
    return [];
}
function aiFollowPair(b, needGt) {
    for (var r = needGt + 1; r < 15; r++) {
        var arr = b[String(r)] || [];
        if (arr.length >= 2) {
            return [arr[0], arr[1]];
        }
    }
    return [];
}
function aiFollowTriple(b, needGt) {
    for (var r = needGt + 1; r < 15; r++) {
        var arr = b[String(r)] || [];
        if (arr.length >= 3) {
            return [arr[0], arr[1], arr[2]];
        }
    }
    return [];
}
function aiFollowStraight(b, needTopGt, length) {
    if (length < 5) {
        return [];
    }
    for (var top_1 = needTopGt + 1; top_1 < 12; top_1++) {
        var bot = top_1 - (length - 1);
        if (bot < 0) {
            continue;
        }
        var ok = true;
        var out = [];
        for (var r = bot; r <= top_1; r++) {
            if (r === 12 || r >= 13) {
                ok = false;
                break;
            }
            var arr = b[String(r)] || [];
            if (arr.length < 1) {
                ok = false;
                break;
            }
            out.push(arr[0]);
        }
        if (ok) {
            return out;
        }
    }
    return [];
}
function aiFollowTripleSingle(b, needMainGt) {
    for (var tr = needMainGt + 1; tr < 13; tr++) {
        var ta = b[String(tr)] || [];
        if (ta.length < 3) {
            continue;
        }
        for (var kri = 0; kri < 15; kri++) {
            if (kri === tr) {
                continue;
            }
            var ka = b[String(kri)] || [];
            if (ka.length < 1) {
                continue;
            }
            return [ta[0], ta[1], ta[2], ka[0]];
        }
    }
    return [];
}
function aiFollowTriplePair(b, needMainGt) {
    for (var tr = needMainGt + 1; tr < 13; tr++) {
        var ta = b[String(tr)] || [];
        if (ta.length < 3) {
            continue;
        }
        for (var pri = 0; pri < 15; pri++) {
            if (pri === tr) {
                continue;
            }
            var pa = b[String(pri)] || [];
            if (pa.length < 2) {
                continue;
            }
            return [ta[0], ta[1], ta[2], pa[0], pa[1]];
        }
    }
    return [];
}
function aiFollowPairStraight(b, needTopGt, nCards) {
    var nPairs = nCards / 2;
    if (nPairs < 3) {
        return [];
    }
    for (var top_2 = needTopGt + 1; top_2 < 12; top_2++) {
        var bot = top_2 - (nPairs - 1);
        if (bot < 0) {
            continue;
        }
        var ok = true;
        var out = [];
        for (var r = bot; r <= top_2; r++) {
            if (r === 12 || r >= 13) {
                ok = false;
                break;
            }
            var pa = b[String(r)] || [];
            if (pa.length < 2) {
                ok = false;
                break;
            }
            out.push(pa[0]);
            out.push(pa[1]);
        }
        if (ok) {
            return out;
        }
    }
    return [];
}
function aiBucketsMinusFour(b, fourRank) {
    var out = {};
    for (var k in b) {
        if (!b.hasOwnProperty(k)) {
            continue;
        }
        var ki = parseInt(k, 10);
        var arr = b[k].slice();
        if (ki === fourRank) {
            for (var t = 0; t < 4 && arr.length > 0; t++) {
                arr.shift();
            }
        }
        if (arr.length > 0) {
            out[k] = arr;
        }
    }
    return out;
}
function aiPickTwoSinglesExcept(b2, fr) {
    var out = [];
    for (var r = 0; r < 15; r++) {
        if (r === fr || r >= 13) {
            continue;
        }
        var a = b2[String(r)] || [];
        if (a.length >= 1) {
            out.push(a[0]);
            if (out.length === 2) {
                return out;
            }
        }
    }
    return [];
}
function aiPickTwoPairsExcept(b2, fr) {
    var out = [];
    for (var r = 0; r < 13; r++) {
        if (r === fr) {
            continue;
        }
        var a = b2[String(r)] || [];
        if (a.length >= 2) {
            out.push(a[0], a[1]);
            if (out.length === 4) {
                return out;
            }
        }
    }
    return [];
}
function aiFollowFourWithTwo(b, needFourGt, extra) {
    for (var fr = needFourGt + 1; fr < 13; fr++) {
        var fa = b[String(fr)] || [];
        if (fa.length < 4) {
            continue;
        }
        var b2 = aiBucketsMinusFour(b, fr);
        if (extra === 6) {
            var kick = aiPickTwoSinglesExcept(b2, fr);
            if (kick.length === 2) {
                return [fa[0], fa[1], fa[2], fa[3], kick[0], kick[1]];
            }
        }
        else if (extra === 8) {
            var kickp = aiPickTwoPairsExcept(b2, fr);
            if (kickp.length === 4) {
                return [fa[0], fa[1], fa[2], fa[3], kickp[0], kickp[1], kickp[2], kickp[3]];
            }
        }
    }
    return [];
}
function aiFollowPlanePure(b, needTopGt, k) {
    if (k < 2) {
        return [];
    }
    for (var top_3 = needTopGt + 1; top_3 < 12; top_3++) {
        var st = top_3 - k + 1;
        if (st < 0) {
            continue;
        }
        var ok = true;
        var out = [];
        for (var r = st; r <= top_3; r++) {
            if (r > 11) {
                ok = false;
                break;
            }
            var arr = b[String(r)] || [];
            if (arr.length < 3) {
                ok = false;
                break;
            }
            out.push(arr[0], arr[1], arr[2]);
        }
        if (ok) {
            return out;
        }
    }
    return [];
}
function aiBucketsDup(b) {
    var o = {};
    for (var kk in b) {
        if (b.hasOwnProperty(kk)) {
            o[kk] = b[kk].slice();
        }
    }
    return o;
}
function aiPickPlaneWingCards(rest, st, k, needSingles, numPairWings) {
    var pairsLeft = numPairWings;
    var singlesLeft = needSingles;
    var taken = [];
    for (var r = 0; r < 13; r++) {
        if (r >= st && r <= st + k - 1) {
            continue;
        }
        var arr = rest[String(r)] || [];
        while (pairsLeft > 0 && arr.length >= 2) {
            taken.push(arr[0], arr[1]);
            arr = arr.slice(2);
            pairsLeft--;
            if (arr.length === 0) {
                delete rest[String(r)];
            }
            else {
                rest[String(r)] = arr;
            }
        }
        if (pairsLeft === 0) {
            break;
        }
    }
    if (pairsLeft !== 0) {
        return [];
    }
    for (var r = 0; r < 13; r++) {
        if (r >= st && r <= st + k - 1) {
            continue;
        }
        var arr2 = rest[String(r)] || [];
        while (singlesLeft > 0 && arr2.length >= 1) {
            taken.push(arr2[0]);
            arr2 = arr2.slice(1);
            singlesLeft--;
            if (arr2.length === 0) {
                delete rest[String(r)];
            }
            else {
                rest[String(r)] = arr2;
            }
        }
        if (singlesLeft === 0) {
            break;
        }
    }
    if (singlesLeft !== 0) {
        return [];
    }
    return taken;
}
function aiTryPlaneWingsCombo(b, st, k, ex) {
    var numPairWings = ex & 31;
    var needSingles = k - numPairWings;
    var rest = aiBucketsDup(b);
    var out = [];
    for (var r = st; r < st + k; r++) {
        var arr = rest[String(r)] || [];
        if (arr.length < 3) {
            return [];
        }
    }
    for (var r = st; r < st + k; r++) {
        var arr = rest[String(r)] || [];
        for (var i = 0; i < 3; i++) {
            out.push(arr.shift());
        }
        if (arr.length === 0) {
            delete rest[String(r)];
        }
        else {
            rest[String(r)] = arr;
        }
    }
    var wings = aiPickPlaneWingCards(rest, st, k, needSingles, numPairWings);
    if (wings.length === 0) {
        return [];
    }
    for (var i = 0; i < wings.length; i++) {
        out.push(wings[i]);
    }
    return out;
}
function aiFollowPlaneWithWings(b, needMainGt, ex) {
    var k = ex >> 5;
    if (k < 2) {
        return [];
    }
    for (var top_4 = needMainGt + 1; top_4 < 12; top_4++) {
        var st = top_4 - k + 1;
        if (st < 0) {
            continue;
        }
        if (st + k - 1 > 11) {
            continue;
        }
        var combo = aiTryPlaneWingsCombo(b, st, k, ex);
        if (combo.length > 0) {
            return combo;
        }
    }
    return [];
}
function aiTryBomb(b, last) {
    var lastIsBomb = last.kind === DDZ_KIND_BOMB;
    var needMain = last.main;
    for (var r = 0; r < 13; r++) {
        var arr = b[String(r)] || [];
        if (arr.length < 4) {
            continue;
        }
        if (lastIsBomb && r <= needMain) {
            continue;
        }
        return [arr[0], arr[1], arr[2], arr[3]];
    }
    return [];
}
function aiTryRocket(b) {
    var a13 = b["13"] || [];
    var a14 = b["14"] || [];
    if (a13.length >= 1 && a14.length >= 1) {
        return [a13[0], a14[0]];
    }
    return [];
}
function aiFindFollow(hand, last, ctx) {
    if (!last || last.kind === DDZ_KIND_PASS) {
        return [];
    }
    if (last.kind === DDZ_KIND_ROCKET) {
        return [];
    }
    if (ctx && aiIsFarmerYieldPass(ctx, last)) {
        return [];
    }
    var b = aiBuckets(hand);
    var same = aiTrySamePattern(b, last);
    if (same.length > 0) {
        return same;
    }
    var bomb = aiTryBomb(b, last);
    if (bomb.length > 0) {
        if (!ctx || !aiShouldAvoidBomb(ctx, hand, last)) {
            return bomb;
        }
    }
    return aiTryRocket(b);
}
function aiWeakestStraightFive(b) {
    for (var top_5 = 4; top_5 < 12; top_5++) {
        var bot = top_5 - 4;
        if (bot < 0) {
            continue;
        }
        var out = [];
        var ok = true;
        for (var r = bot; r <= top_5; r++) {
            if (r === 12 || r >= 13) {
                ok = false;
                break;
            }
            var arr = b[String(r)] || [];
            if (arr.length < 1) {
                ok = false;
                break;
            }
            out.push(arr[0]);
        }
        if (ok) {
            return out;
        }
    }
    return [];
}
function aiWeakestPair(b) {
    for (var r = 0; r < 15; r++) {
        var arr = b[String(r)] || [];
        if (arr.length >= 2) {
            return [arr[0], arr[1]];
        }
    }
    return [];
}
function aiWeakestTriple(b) {
    for (var r = 0; r < 15; r++) {
        var arr = b[String(r)] || [];
        if (arr.length >= 3) {
            return [arr[0], arr[1], arr[2]];
        }
    }
    return [];
}
function aiWeakestSingleFromHand(hand, _b) {
    var best = hand[0];
    var bestV = ddzRankValue(best);
    for (var i = 1; i < hand.length; i++) {
        var cid = hand[i];
        var v = ddzRankValue(cid);
        if (v < bestV || (v === bestV && cid < best)) {
            best = cid;
            bestV = v;
        }
    }
    return [best];
}
function aiWeakestOrphanSingle(b) {
    for (var r = 0; r < 15; r++) {
        var arr = b[String(r)] || [];
        if (arr.length === 1) {
            return [arr[0]];
        }
    }
    return [];
}
function aiSeenRankMustPlay(b, ctx) {
    var seen = ctx.seen_rank || [];
    if (seen.length < 15) {
        return [];
    }
    for (var r = 0; r < 13; r++) {
        var played = r < seen.length ? seen[r] : 0;
        if (played === 3) {
            var arr2 = b[String(r)] || [];
            if (arr2.length >= 1) {
                return [arr2[0]];
            }
        }
    }
    return [];
}
function aiChooseFreeLead(hand, ctx) {
    if (hand.length === 0) {
        return [];
    }
    var b = aiBuckets(hand);
    var st = aiWeakestStraightFive(b);
    var straightOk = false;
    if (st.length > 0) {
        var pat = classify(st);
        straightOk = pat.kind === DDZ_KIND_STRAIGHT;
    }
    var style = ctx.ai_style || 0;
    if (style === 1) {
        if (straightOk) {
            return st;
        }
        var prA = aiWeakestPair(b);
        if (prA.length > 0) {
            return prA;
        }
        var trA = aiWeakestTriple(b);
        if (trA.length > 0) {
            return trA;
        }
        var osA = aiWeakestOrphanSingle(b);
        if (osA.length > 0) {
            return osA;
        }
        var snA = aiSeenRankMustPlay(b, ctx);
        if (snA.length > 0) {
            return snA;
        }
        return aiWeakestSingleFromHand(hand, b);
    }
    if (straightOk) {
        return st;
    }
    var os = aiWeakestOrphanSingle(b);
    if (os.length > 0) {
        return os;
    }
    var pr = aiWeakestPair(b);
    if (pr.length > 0) {
        return pr;
    }
    var triplePl = aiWeakestTriple(b);
    if (triplePl.length > 0) {
        return triplePl;
    }
    var sn = aiSeenRankMustPlay(b, ctx);
    if (sn.length > 0) {
        return sn;
    }
    return aiWeakestSingleFromHand(hand, b);
}
function buildAiCtxFromState(state, seat) {
    var oa = state.hands[(seat + 1) % 3].length;
    var ob = state.hands[(seat + 2) % 3].length;
    var minOpp = oa < ob ? oa : ob;
    var cat = state.seatCat[seat] !== undefined ? state.seatCat[seat] : 0;
    var style = aiProStyle(aiStyleFromCatId(cat));
    var seen = [];
    for (var i = 0; i < 15; i++) {
        seen.push(0);
    }
    return {
        me: seat,
        landlord: state.landlord,
        last_player: state.lastPlayer,
        passes: state.passes,
        seen_rank: seen,
        min_opp_cards: minOpp,
        ai_style: style,
    };
}
function aiRunPlayTurn(state, seat) {
    var hand = state.hands[seat];
    if (hand.length === 0) {
        return;
    }
    var ctx = buildAiCtxFromState(state, seat);
    var last = state.lastPattern;
    var trickFree = !last || last.kind === DDZ_KIND_PASS || state.passes >= 2;
    var cards = [];
    if (trickFree) {
        cards = aiChooseFreeLead(hand, ctx);
        if (cards.length === 0) {
            cards = [hand[0]];
        }
    }
    else {
        cards = aiFindFollow(hand, last, ctx);
        if (cards.length === 0) {
            applyPass(state, seat);
            return;
        }
    }
    applyPlay(state, seat, cards);
}
function aiRunBidTurn(state, seat, nk) {
    var hand = state.hands[seat];
    var cat = state.seatCat[seat] !== undefined ? state.seatCat[seat] : 0;
    var style = aiProStyle(aiStyleFromCatId(cat));
    var bid = aiChooseBid(hand, style);
    applyBid(state, seat, bid, nk);
}
function aiRunRobTurn(state, seat) {
    var hand = state.hands[seat];
    var cat = state.seatCat[seat] !== undefined ? state.seatCat[seat] : 0;
    var style = aiProStyle(aiStyleFromCatId(cat));
    var curMult = state.multBase * state.multRob;
    var rob = aiChooseRobLandlord(hand, curMult, style);
    applyRob(state, seat, rob);
}
/** 叫牌/抢地主：AI 连动间隔（与 main.ts AI_BID_ROB_PACE_MS、出牌链式延迟同量级） */
var AI_BID_ROB_CHAIN_DELAY_MS = 1350;
function runAiUntilHumanOrDone(st, dispatcher, logger, nk) {
    var guard = 0;
    while (guard++ < 96) {
        if (st.phase === "waiting" || st.phase === "deal") {
            break;
        }
        if (st.phase === "finished") {
            break;
        }
        if (st.phase === "bidding_call") {
            var awaitS = st.awaitSeat;
            if (!st.isAiSeat[awaitS]) {
                break;
            }
            if (Date.now() < st.aiPlayDelayUntilMs) {
                break;
            }
            aiRunBidTurn(st, awaitS, nk);
            broadcastState(dispatcher, st, logger, "ai_bid");
            st.aiPlayDelayUntilMs = Date.now() + AI_BID_ROB_CHAIN_DELAY_MS;
        }
        else if (st.phase === "bidding_rob") {
            var cand = st.callCandidate;
            var i = (cand + 1 + st.robStep) % 3;
            if (!st.isAiSeat[i]) {
                break;
            }
            if (Date.now() < st.aiPlayDelayUntilMs) {
                break;
            }
            aiRunRobTurn(st, i);
            broadcastState(dispatcher, st, logger, "ai_rob");
            st.aiPlayDelayUntilMs = Date.now() + AI_BID_ROB_CHAIN_DELAY_MS;
        }
        else if (st.phase === "play") {
            var t = st.turn;
            if (!st.isAiSeat[t]) {
                break;
            }
            if (Date.now() < st.aiPlayDelayUntilMs) {
                break;
            }
            aiRunPlayTurn(st, t);
            /** 人类已出过牌时用 aiPlayDelayUntilMs；AI 连出时须额外等待，否则客户端上一手动画未完下一快照已到 */
            var AI_PLAY_CHAIN_DELAY_MS = 1350;
            var nextTurn = st.turn;
            if (st.phase === "play" && st.isAiSeat[nextTurn]) {
                st.aiPlayDelayUntilMs = Date.now() + AI_PLAY_CHAIN_DELAY_MS;
            }
            else {
                st.aiPlayDelayUntilMs = 0;
            }
            broadcastState(dispatcher, st, logger, "ai_play");
            if (st.phase === "finished") {
                var deltas = computeScoreDeltas(st);
                var settlement = JSON.stringify({
                    v: 1,
                    winner: st.winner,
                    landlord: st.landlord,
                    farmersWin: settlementFarmersWin(st),
                    spring: springBonus(st),
                    scoreDelta: deltas,
                    mult: roundMultiplier(st),
                });
                try {
                    dispatcher.broadcastMessage(DDZ_OP_SETTLEMENT, settlement, null, null);
                }
                catch (e) {
                    logger.error("ai settlement: %s", String(e));
                }
            }
        }
        else {
            break;
        }
    }
}
function maybeAutoContinueWithAi(st, dispatcher, logger, nk) {
    if (st.phase !== "finished") {
        return;
    }
    for (var s = 0; s < 3; s++) {
        if (st.isAiSeat[s]) {
            st.continueReady[s] = true;
        }
    }
    var all = true;
    for (var i = 0; i < 3; i++) {
        if (!st.continueReady[i]) {
            all = false;
            break;
        }
    }
    if (all) {
        resetRound(st, nk);
        broadcastState(dispatcher, st, logger, "continue_all");
    }
}
