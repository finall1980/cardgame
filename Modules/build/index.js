"use strict";
/**
 * 安全随机：优先 nk.secureRandomBytes，缺失时回退 Math.random（与洗牌/展示 seed 等非密钥场景一致）。
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
/** RPC 统一 JSON 字符串形态，便于多游戏复用 */
function rpcOk(fields) {
    if (fields === void 0) { fields = {}; }
    var o = { ok: true };
    for (var k in fields) {
        if (fields.hasOwnProperty(k)) {
            o[k] = fields[k];
        }
    }
    return JSON.stringify(o);
}
function rpcErr(error, fields) {
    if (fields === void 0) { fields = {}; }
    var o = { ok: false, error: error };
    for (var k in fields) {
        if (fields.hasOwnProperty(k)) {
            o[k] = fields[k];
        }
    }
    return JSON.stringify(o);
}
/**
 * 全游戏通用游戏币（与匹配分离：各游戏自建 mm 队列，余额共用本 Storage）。
 * 新数据：collection player / key wallet。
 * 兼容旧版：曾写在 doudizhu/wallet，读取时若无新键则回退；之后写入只进 player。
 */
var WALLET_COLLECTION = "player";
var WALLET_KEY = "wallet";
var WALLET_COLLECTION_LEGACY = "doudizhu";
var WALLET_INITIAL = 3000;
function walletParseCoins(value) {
    var v = value;
    return typeof v.coins === "number" && Number.isFinite(v.coins) ? Math.floor(v.coins) : 0;
}
function walletLoad(nk, userId) {
    var pr = nk.storageRead([{ collection: WALLET_COLLECTION, key: WALLET_KEY, userId: userId }]);
    if (pr && pr.length > 0) {
        return {
            coins: walletParseCoins(pr[0].value),
            playerWriteVersion: pr[0].version || "",
            hadPlayerRow: true,
        };
    }
    var lr = nk.storageRead([{ collection: WALLET_COLLECTION_LEGACY, key: WALLET_KEY, userId: userId }]);
    if (lr && lr.length > 0) {
        return {
            coins: walletParseCoins(lr[0].value),
            playerWriteVersion: "",
            hadPlayerRow: false,
        };
    }
    return { coins: 0, playerWriteVersion: "", hadPlayerRow: false };
}
function walletWritePlayer(nk, userId, coins, playerWriteVersion) {
    var req = {
        collection: WALLET_COLLECTION,
        key: WALLET_KEY,
        userId: userId,
        value: { coins: coins },
        permissionRead: 1,
        permissionWrite: 1,
    };
    if (playerWriteVersion && playerWriteVersion.length > 0) {
        req.version = playerWriteVersion;
    }
    nk.storageWrite([req]);
}
function rpcWalletSync(ctx, logger, nk, payload) {
    var uid = ctx.userId;
    if (!uid) {
        return rpcErr("unauthorized");
    }
    var r = walletLoad(nk, uid);
    if (!r.hadPlayerRow && r.coins > 0) {
        try {
            walletWritePlayer(nk, uid, r.coins, "");
            r = walletLoad(nk, uid);
        }
        catch (e) {
            logger.error("wallet_sync migrate legacy: %s", String(e));
            return rpcErr("storage_write");
        }
    }
    var coins = r.coins;
    if (coins <= 0) {
        coins = WALLET_INITIAL;
        try {
            walletWritePlayer(nk, uid, coins, r.hadPlayerRow ? r.playerWriteVersion : "");
        }
        catch (e) {
            logger.error("wallet_sync write: %s", String(e));
            return rpcErr("storage_write");
        }
    }
    return rpcOk({ coins: coins });
}
function rpcWalletBuy(ctx, logger, nk, payload) {
    return rpcWalletApplyDelta(ctx, logger, nk, JSON.stringify({ delta: 100 }));
}
function rpcWalletApplyDelta(ctx, logger, nk, payload) {
    var uid = ctx.userId;
    if (!uid) {
        return rpcErr("unauthorized");
    }
    var delta = 0;
    try {
        var p = JSON.parse(payload || "{}");
        delta = Math.floor(Number(p.delta));
    }
    catch (e) {
        return rpcErr("bad_payload");
    }
    if (!Number.isFinite(delta)) {
        return rpcErr("bad_delta");
    }
    if (delta > 5000000 || delta < -5000000) {
        return rpcErr("delta_out_of_range");
    }
    var r = walletLoad(nk, uid);
    var newCoins = r.coins + delta;
    if (newCoins < 0) {
        newCoins = 0;
    }
    try {
        walletWritePlayer(nk, uid, newCoins, r.hadPlayerRow ? r.playerWriteVersion : "");
    }
    catch (e) {
        logger.error("wallet_apply_delta: %s", String(e));
        return rpcErr("storage_write");
    }
    return rpcOk({ coins: newCoins });
}
/**
 * 全局 Storage 乐观锁写入 + 重试（多实例 / 并发 RPC 下避免覆盖丢失）。
 */
function mutateGlobalStorage(nk, logger, collection, stateKey, ownerUserId, defaultState, revive, toStorageValue, mutator, logPrefix) {
    var maxTries = 24;
    for (var attempt = 0; attempt < maxTries; attempt++) {
        var rows = nk.storageRead([{ collection: collection, key: stateKey, userId: ownerUserId }]);
        var state = void 0;
        var version = "";
        if (!rows || rows.length === 0) {
            state = defaultState();
        }
        else {
            var obj = rows[0];
            version = obj.version || "";
            var clone = JSON.parse(JSON.stringify(obj.value));
            state = revive(clone);
        }
        mutator(state);
        try {
            var req = {
                collection: collection,
                key: stateKey,
                userId: ownerUserId,
                value: toStorageValue(state),
            };
            if (version && version.length > 0) {
                req.version = version;
            }
            nk.storageWrite([req]);
            return;
        }
        catch (e) {
            logger.warn("%s storage write retry %d: %s", logPrefix, attempt, String(e));
        }
    }
    throw new Error(logPrefix + "_storage_failed");
}
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
    state.seenCount = [];
    for (var i = 0; i < 15; i++) {
        state.seenCount.push(0);
    }
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
    if (!state.seenCount || state.seenCount.length < 15) {
        state.seenCount = [];
        for (var i = 0; i < 15; i++) {
            state.seenCount.push(0);
        }
    }
    for (var i = 0; i < cardIds.length; i++) {
        var r = ddzRankValue(cardIds[i]);
        if (r >= 0 && r < 15) {
            state.seenCount[r]++;
        }
    }
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
        seenCount: (function () {
            var a = [];
            for (var i = 0; i < 15; i++) {
                a.push(0);
            }
            return a;
        })(),
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
    /** Nakama/goja 等运行时未必有 globalThis / Buffer，避免 ReferenceError */
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
    /** 与 games/ddz/ai_server 中 AI 连动共用 aiPlayDelayUntilMs，避免 matchLoop 每 100ms 连推抢地主跳过 */
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
var DDZ_MM_WAIT_MS = 10000;
var DDZ_MM_COLLECTION = "ddz_mm";
var DDZ_MM_STATE_KEY = "queue_state";
var DDZ_MM_OWNER = "00000000-0000-0000-0000-000000000000";
function ddzMmDefaultState() {
    return { entries: [], results: {} };
}
function ddzMmRevive(raw) {
    var clone = raw;
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
    return { entries: entries, results: results };
}
function ddzMmToValue(state) {
    return {
        entries: state.entries,
        results: state.results,
    };
}
function ddzMmMakeTicket(nk) {
    var u = randomBytesCompat(nk, 8);
    var hex = Array.prototype.map
        .call(u, function (x) {
        return ("0" + x.toString(16)).slice(-2);
    })
        .join("");
    return "ddzmm_" + Date.now().toString(36) + "_" + hex;
}
function ddzMmMutateState(nk, logger, mutator) {
    mutateGlobalStorage(nk, logger, DDZ_MM_COLLECTION, DDZ_MM_STATE_KEY, DDZ_MM_OWNER, ddzMmDefaultState, ddzMmRevive, ddzMmToValue, mutator, "ddz_mm");
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
        return rpcErr("unauthorized");
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
        return rpcErr("storage_busy");
    }
    logger.info("ddz_mm join user=%s ticket=%s", uid, outTicket);
    return rpcOk({ ticket: outTicket });
}
function rpcDdzMmPoll(ctx, logger, nk, payload) {
    var ticket = "";
    try {
        var u = JSON.parse(payload || "{}");
        ticket = String(u.ticket || "");
    }
    catch (e) {
        return rpcErr("bad_payload");
    }
    if (!ticket) {
        return rpcErr("no_ticket");
    }
    var response = rpcOk({ status: "waiting" });
    try {
        ddzMmMutateState(nk, logger, function (st) {
            ddzMmProcessQueueCore(st, nk, logger);
            var r = st.results[ticket];
            if (r && r.matchId) {
                delete st.results[ticket];
                response = rpcOk({ status: "matched", match_id: r.matchId });
            }
        });
    }
    catch (e) {
        logger.error("ddz_mm poll storage: %s", String(e));
        return rpcErr("storage_busy");
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
        return rpcErr("storage_busy");
    }
    return rpcOk();
}
/**
 * 掼蛋（Guan Dan）服务端状态与常量。
 * 与 docs/guandan_DESIGN.md 一致：
 *   - 4 人 2 队，108 张牌（2 副 × 54），每人 27 张。
 *   - 级牌 rawRank 编码：3→0, 4→1, ..., T→7, J→8, Q→9, K→10, A→11, 2→12, 小王→13, 大王→14。
 *   - 起始「打 2」，rawRank=12；升到「打 A」=11（11 为 A 顶顺子用点也是 A）。
 *   - 升级轨迹：2(12) → 3(0) → 4(1) → ... → A(11) → 毕业。
 */
/** 牌型 kind（全局唯一 id 段，不与 DDZ_KIND_* 冲突） */
var GD_KIND_INVALID = 0;
var GD_KIND_PASS = 1;
var GD_KIND_SINGLE = 2;
var GD_KIND_PAIR = 3;
var GD_KIND_TRIPLE = 4;
var GD_KIND_TRIPLE_WITH_PAIR = 5; // 三带二（五张）
var GD_KIND_STRAIGHT = 6; // 5 张顺子，顶 A（TJQKA），不过 2
var GD_KIND_PAIR_STRAIGHT = 7; // 连对：≥3 对连续点，len=张数（6/8/10…），straightLen=对数
var GD_KIND_TRIPLE_STRAIGHT = 8; // 钢板 2 连三 = 6 张
var GD_KIND_STRAIGHT_FLUSH = 9; // 同花顺（5 张）
var GD_KIND_BOMB = 10; // 普通 n 炸，n ∈ [4,8]
var GD_KIND_KING_BOMB = 11; // 天王炸（2 小王 + 2 大王）
/** 炸弹链的档位（同 kind 下再比点）；用于 beats 判定 */
var GD_BOMB_TIER_NONE = 0;
var GD_BOMB_TIER_4 = 1;
var GD_BOMB_TIER_5 = 2;
var GD_BOMB_TIER_SF = 3; // 同花顺
var GD_BOMB_TIER_6 = 4;
var GD_BOMB_TIER_7 = 5;
var GD_BOMB_TIER_8 = 6;
var GD_BOMB_TIER_KING = 7;
/** 服务端 → 客户端 opcode（与 DDZ_OP_* 错开） */
var GD_OP_SNAPSHOT = 201;
var GD_OP_ERROR = 202;
var GD_OP_SETTLEMENT = 220;
var GD_OP_HINT = 203; // 仅发给请求者：{ v, pass, ids }
/** 客户端 → 服务端 REQ（与 DDZ_REQ_* 错开） */
var GD_REQ_PLAY = 30;
var GD_REQ_PASS = 31;
var GD_REQ_TRIBUTE = 32;
var GD_REQ_TRIBUTE_RESIST = 33;
var GD_REQ_RETURN = 34;
var GD_REQ_CONTINUE = 35;
var GD_REQ_DECLARE_WILD = 36; // 预留：客户端主动声明百搭替代（M2 接入）
var GD_REQ_DELEGATE = 38; // AI 托管：为 true 时本 tick 起该座按 AI 出牌
var GD_REQ_HINT = 39; // 智能提示：仅返回建议，不代出（与 gdAiPickPlay 同源）
/** 总牌数与单人手牌数 */
var GD_DECK_COUNT = 108;
var GD_HAND_SIZE = 27;
/** rawRank 常量 */
var GD_RAW_RANK_A = 11;
var GD_RAW_RANK_2 = 12;
var GD_RAW_RANK_SMALL_JOKER = 13;
var GD_RAW_RANK_BIG_JOKER = 14;
/** 升级级牌推进表（index 0 起：打 2 → 打 A） */
var GD_LEVEL_ORDER = [12, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
/** 节奏：AI 出牌最小间隔（避免客户端动画重叠；略长于单手出牌动画） */
var GD_AI_PLAY_PACE_MS = 700;
/** 新一局发牌后让客户端播动画的等待 */
var GD_AI_NEW_ROUND_DELAY_MS = 1400;
/** deal 阶段最短时长（ms），供客户端播发牌动画；结束后进入 play 或贡牌 */
var GD_DEAL_PHASE_MS = 4500;
/** 发牌结束后再隔多久允许 AI 出牌（略短于整局 NEW_ROUND，因 deal 内已等待） */
var GD_AI_POST_DEAL_DELAY_MS = 520;
/**
 * 掼蛋牌型识别 / 比大小。与 docs/guandan_DESIGN.md §1、§4 对齐。
 *
 * 关键口径（已确认）：
 *  - 108 张，2 副牌；id 空间 0..107，其中 `baseId = id % 54`：
 *      0..51 花色牌（0..12 ♠3..♠A..♠2）…（按 rawRank % 13 = 0 为 3，…12 为 2）；52 小王，53 大王。
 *  - 级牌 rawRank：起始 12（打 2），最终 11（打 A）。
 *  - 红心级牌（♥ + rawRank == levelRank）= 百搭，最多 2 张/手。
 *  - 顺子：普通 34567…TJQKA；另允许**最小顺 A2345**（main 哨兵低于 34567）。**仅 ♥ 级牌**为百搭；**非红心级牌**仍按面点参与顺/连对/钢板/同花顺。
 *  - 红心级牌允许参与同花顺（作为该 suit 的空位填充），不参与天王炸。
 *  - 非打 2 时普通 2 点力全场最小（仅大于无牌）；打 2 时 2 作级牌。
 */
/** 顺子 A2345（最小顺）的 main 哨兵，恒小于普通顺子 */
var GD_STRAIGHT_MAIN_WHEEL_LOW = -100;
/** baseId：把两副牌映射到同义面 0..53 */
function gdBaseId(id) {
    return id < 54 ? id : id - 54;
}
/** rawRank：3→0, 4→1, ..., T→7, J→8, Q→9, K→10, A→11, 2→12, 小王→13, 大王→14 */
function gdRawRank(id) {
    var b = gdBaseId(id);
    if (b < 52) {
        return b % 13;
    }
    return 13 + (b - 52);
}
/** suit：0 ♠ / 1 ♥ / 2 ♣ / 3 ♦；王为 -1 */
function gdSuit(id) {
    var b = gdBaseId(id);
    if (b >= 52) {
        return -1;
    }
    return Math.floor(b / 13);
}
function gdIsHeartLevelCard(id, levelRank) {
    return gdSuit(id) === 1 && gdRawRank(id) === levelRank;
}
/** 把 rawRank 映射为本局生效的点力（见 §3.1 表） */
function gdRankValueFromRaw(rr, levelRank) {
    if (rr === 14) {
        return 16;
    }
    if (rr === 13) {
        return 15;
    }
    if (rr === levelRank) {
        return 14;
    }
    // 非「打 2」时，普通 2 为全场最小（小于 3…A）；「打 2」时 2 已在上一分支作级牌
    if (rr === 12) {
        return -1;
    }
    if (rr === 11) {
        return 12;
    }
    return rr;
}
function gdRankValue(id, levelRank) {
    return gdRankValueFromRaw(gdRawRank(id), levelRank);
}
/** 拆出红心级牌（百搭）与普通牌 */
function gdSplitWilds(ids, levelRank) {
    var w = [];
    var n = [];
    for (var i = 0; i < ids.length; i++) {
        if (gdIsHeartLevelCard(ids[i], levelRank)) {
            w.push(ids[i]);
        }
        else {
            n.push(ids[i]);
        }
    }
    return { wilds: w, normals: n };
}
function gdRankCountsOfNormals(normals) {
    var m = {};
    for (var i = 0; i < normals.length; i++) {
        var r = gdRawRank(normals[i]);
        var k = String(r);
        m[k] = (m[k] || 0) + 1;
    }
    return m;
}
function gdMakePattern(kind, main, len, bombTier, wildUsed, straightLen, suit) {
    return {
        kind: kind,
        main: main,
        len: len,
        bombTier: bombTier,
        wildUsed: wildUsed,
        straightLen: straightLen,
        suit: suit,
    };
}
/** 天王炸：正好 2 小王 + 2 大王（不允许 wild） */
function gdTryKingBomb(normals, wilds) {
    if (wilds.length !== 0) {
        return null;
    }
    if (normals.length !== 4) {
        return null;
    }
    var small = 0;
    var big = 0;
    for (var i = 0; i < normals.length; i++) {
        var r = gdRawRank(normals[i]);
        if (r === 13) {
            small++;
        }
        else if (r === 14) {
            big++;
        }
        else {
            return null;
        }
    }
    if (small !== 2 || big !== 2) {
        return null;
    }
    return gdMakePattern(GD_KIND_KING_BOMB, 100, 4, GD_BOMB_TIER_KING, 0, 0, -1);
}
/** 普通 n 炸：同 rawRank，n ∈ [4,8]，允许 0..2 wild；禁止王组普通炸 */
function gdTryBomb(normals, wilds, levelRank) {
    var n = normals.length + wilds.length;
    if (n < 4 || n > 8) {
        return null;
    }
    if (normals.length === 0) {
        return null;
    }
    var r0 = gdRawRank(normals[0]);
    if (r0 >= 13) {
        return null;
    }
    for (var i = 1; i < normals.length; i++) {
        if (gdRawRank(normals[i]) !== r0) {
            return null;
        }
    }
    var tier = GD_BOMB_TIER_4;
    if (n === 5) {
        tier = GD_BOMB_TIER_5;
    }
    else if (n === 6) {
        tier = GD_BOMB_TIER_6;
    }
    else if (n === 7) {
        tier = GD_BOMB_TIER_7;
    }
    else if (n === 8) {
        tier = GD_BOMB_TIER_8;
    }
    return gdMakePattern(GD_KIND_BOMB, gdRankValueFromRaw(r0, levelRank), n, tier, wilds.length, 0, -1);
}
function gdTrySingle(ids, levelRank) {
    if (ids.length !== 1) {
        return null;
    }
    return gdMakePattern(GD_KIND_SINGLE, gdRankValue(ids[0], levelRank), 1, 0, 0, 0, -1);
}
function gdTryPair(normals, wilds, levelRank) {
    var n = normals.length + wilds.length;
    if (n !== 2) {
        return null;
    }
    if (normals.length === 2) {
        var r0 = gdRawRank(normals[0]);
        var r1 = gdRawRank(normals[1]);
        if (r0 !== r1) {
            return null;
        }
        return gdMakePattern(GD_KIND_PAIR, gdRankValueFromRaw(r0, levelRank), 2, 0, 0, 0, -1);
    }
    if (normals.length === 1 && wilds.length === 1) {
        var r0 = gdRawRank(normals[0]);
        if (r0 >= 13) {
            return null;
        }
        return gdMakePattern(GD_KIND_PAIR, gdRankValueFromRaw(r0, levelRank), 2, 0, 1, 0, -1);
    }
    return null;
}
function gdTryTriple(normals, wilds, levelRank) {
    var n = normals.length + wilds.length;
    if (n !== 3) {
        return null;
    }
    if (normals.length === 0) {
        return null;
    }
    var r0 = gdRawRank(normals[0]);
    if (r0 >= 13) {
        return null;
    }
    for (var i = 1; i < normals.length; i++) {
        if (gdRawRank(normals[i]) !== r0) {
            return null;
        }
    }
    return gdMakePattern(GD_KIND_TRIPLE, gdRankValueFromRaw(r0, levelRank), 3, 0, wilds.length, 0, -1);
}
function gdTryTriplePair(normals, wilds, levelRank) {
    var n = normals.length + wilds.length;
    if (n !== 5) {
        return null;
    }
    var wc = wilds.length;
    var cnt = gdRankCountsOfNormals(normals);
    var ranks = [];
    for (var k in cnt) {
        if (cnt.hasOwnProperty(k)) {
            var r = parseInt(k, 10);
            if (r >= 13) {
                return null;
            }
            ranks.push(r);
        }
    }
    if (ranks.length < 1 || ranks.length > 2) {
        return null;
    }
    function tryAs(tripleR, pairR) {
        var tCnt = cnt[String(tripleR)] || 0;
        var pCnt = pairR === tripleR ? 0 : (cnt[String(pairR)] || 0);
        var tNeed = 3 - tCnt;
        var pNeed = 2 - pCnt;
        if (tNeed < 0 || pNeed < 0) {
            return null;
        }
        if (tNeed + pNeed !== wc) {
            return null;
        }
        return gdMakePattern(GD_KIND_TRIPLE_WITH_PAIR, gdRankValueFromRaw(tripleR, levelRank), 5, 0, wc, 0, -1);
    }
    if (ranks.length === 2) {
        var a = ranks[0];
        var b = ranks[1];
        var r = tryAs(a, b);
        if (r) {
            return r;
        }
        return tryAs(b, a);
    }
    return null;
}
function gdSeqForbidden23456(seq) {
    return (seq.length === 5 &&
        seq[0] === 12 &&
        seq[1] === 0 &&
        seq[2] === 1 &&
        seq[3] === 2 &&
        seq[4] === 3);
}
function gdSeqAllowedForStraight(seq, levelRank) {
    if (gdSeqForbidden23456(seq)) {
        return false;
    }
    for (var i = 0; i < seq.length; i++) {
        if (seq[i] < 0 || seq[i] > 11) {
            return false;
        }
    }
    return true;
}
/**
 * 非「打二」时连对可含普通 2（raw=12）：点序 …10,J,Q,K,A,2,3…（A 接 2、2 接 3）。
 * 打二时 2 为级牌，连对仍只在 3—A 上连续（由 gdSeqAllowedForStraight 约束）。
 */
function gdBuildPairStraightSeqWheel(start, numPairs) {
    if (numPairs < 1 || start < 0 || start > 12) {
        return null;
    }
    var seq = [start];
    var cur = start;
    for (var j = 1; j < numPairs; j++) {
        var nx = void 0;
        if (cur === 12) {
            nx = 0;
        }
        else if (cur === 11) {
            nx = 12;
        }
        else if (cur >= 0 && cur <= 10) {
            nx = cur + 1;
        }
        else {
            return null;
        }
        seq.push(nx);
        cur = nx;
    }
    return seq;
}
/** 连对序列合法性（打二走 3—A；非打二可走含 2 的环序） */
function gdSeqAllowedForPairStraight(seq, levelRank) {
    if (gdSeqForbidden23456(seq)) {
        return false;
    }
    if (levelRank === 12) {
        return gdSeqAllowedForStraight(seq, levelRank);
    }
    for (var i = 0; i < seq.length; i++) {
        if (seq[i] < 0 || seq[i] > 12) {
            return false;
        }
    }
    return true;
}
/** 枚举连对「点数模板」（不含百搭分配）；供识别与 AI 共用 */
function gdForEachPairStraightSeqTemplate(levelRank, numPairs, cb) {
    if (numPairs < 3) {
        return;
    }
    if (levelRank === 12) {
        for (var top_1 = numPairs - 1; top_1 <= 11; top_1++) {
            var low = top_1 - numPairs + 1;
            if (low < 0) {
                continue;
            }
            var seq = [];
            for (var r = low; r <= top_1; r++) {
                seq.push(r);
            }
            if (!gdSeqAllowedForStraight(seq, levelRank)) {
                continue;
            }
            cb(seq);
        }
    }
    else {
        for (var start = 0; start <= 12; start++) {
            var seq = gdBuildPairStraightSeqWheel(start, numPairs);
            if (seq === null) {
                continue;
            }
            if (!gdSeqAllowedForPairStraight(seq, levelRank)) {
                continue;
            }
            cb(seq);
        }
    }
}
function gdHasExtraRankOutside(cnt, seq) {
    for (var k in cnt) {
        if (!cnt.hasOwnProperty(k)) {
            continue;
        }
        var r = parseInt(k, 10);
        var inSeq = false;
        for (var i = 0; i < seq.length; i++) {
            if (seq[i] === r) {
                inSeq = true;
                break;
            }
        }
        if (!inSeq) {
            return true;
        }
    }
    return false;
}
function gdTryStraight(normals, wilds, levelRank) {
    var n = normals.length + wilds.length;
    if (n !== 5) {
        return null;
    }
    var wc = wilds.length;
    var cnt = gdRankCountsOfNormals(normals);
    for (var k in cnt) {
        if (!cnt.hasOwnProperty(k)) {
            continue;
        }
        var r = parseInt(k, 10);
        if (r >= 13) {
            return null;
        }
        if (cnt[k] > 1) {
            return null;
        }
    }
    for (var top_2 = 4; top_2 <= 11; top_2++) {
        var seq = [top_2 - 4, top_2 - 3, top_2 - 2, top_2 - 1, top_2];
        if (!gdSeqAllowedForStraight(seq, levelRank)) {
            continue;
        }
        var need = 0;
        for (var i = 0; i < seq.length; i++) {
            var have = cnt[String(seq[i])] || 0;
            need += 1 - have;
        }
        if (need !== wc) {
            continue;
        }
        if (gdHasExtraRankOutside(cnt, seq)) {
            continue;
        }
        return gdMakePattern(GD_KIND_STRAIGHT, gdRankValueFromRaw(top_2, levelRank), 5, 0, wc, 5, -1);
    }
    var wheel = gdTryStraightWheelA2345(cnt, wc, levelRank);
    if (wheel) {
        return wheel;
    }
    return null;
}
/** 最小顺 A2345（可含 ♥ 级牌作百搭补位） */
function gdTryStraightWheelA2345(cnt, wc, levelRank) {
    var seq = [11, 12, 0, 1, 2];
    var need = 0;
    for (var i = 0; i < seq.length; i++) {
        var r = seq[i];
        if (r === levelRank) {
            need += 1;
            continue;
        }
        var have = cnt[String(r)] || 0;
        need += 1 - have;
    }
    if (need !== wc) {
        return null;
    }
    if (gdHasExtraRankOutside(cnt, seq)) {
        return null;
    }
    return gdMakePattern(GD_KIND_STRAIGHT, GD_STRAIGHT_MAIN_WHEEL_LOW, 5, 0, wc, 5, -1);
}
function gdTryPairStraight(normals, wilds, levelRank) {
    var n = normals.length + wilds.length;
    /** 掼蛋连对：至少三对连续点，可 6/8/10…张（至多到 A 共 12 对 = 24 张） */
    if (n < 6 || n % 2 !== 0) {
        return null;
    }
    var numPairs = (n / 2) | 0;
    if (numPairs < 3 || numPairs > 12) {
        return null;
    }
    var wc = wilds.length;
    var cnt = gdRankCountsOfNormals(normals);
    for (var k in cnt) {
        if (!cnt.hasOwnProperty(k)) {
            continue;
        }
        var r = parseInt(k, 10);
        if (r >= 13) {
            return null;
        }
        if (cnt[k] > 2) {
            return null;
        }
    }
    function mainOfPairStraightSeq(seq) {
        var mb = gdRankValueFromRaw(seq[0], levelRank);
        for (var u = 1; u < seq.length; u++) {
            var v = gdRankValueFromRaw(seq[u], levelRank);
            if (v > mb) {
                mb = v;
            }
        }
        return mb;
    }
    var found = null;
    gdForEachPairStraightSeqTemplate(levelRank, numPairs, function (seq) {
        if (found !== null) {
            return;
        }
        var need = 0;
        for (var i = 0; i < seq.length; i++) {
            var have = cnt[String(seq[i])] || 0;
            need += 2 - have;
        }
        if (need !== wc) {
            return;
        }
        if (gdHasExtraRankOutside(cnt, seq)) {
            return;
        }
        found = gdMakePattern(GD_KIND_PAIR_STRAIGHT, mainOfPairStraightSeq(seq), n, 0, wc, numPairs, -1);
    });
    return found;
}
function gdTryTripleStraight(normals, wilds, levelRank) {
    var n = normals.length + wilds.length;
    if (n !== 6) {
        return null;
    }
    var wc = wilds.length;
    var cnt = gdRankCountsOfNormals(normals);
    for (var k in cnt) {
        if (!cnt.hasOwnProperty(k)) {
            continue;
        }
        var r = parseInt(k, 10);
        if (r >= 13) {
            return null;
        }
        if (cnt[k] > 3) {
            return null;
        }
    }
    for (var top_3 = 1; top_3 <= 11; top_3++) {
        var seq = [top_3 - 1, top_3];
        if (!gdSeqAllowedForStraight(seq, levelRank)) {
            continue;
        }
        var need = 0;
        for (var i = 0; i < seq.length; i++) {
            var have = cnt[String(seq[i])] || 0;
            need += 3 - have;
        }
        if (need !== wc) {
            continue;
        }
        if (gdHasExtraRankOutside(cnt, seq)) {
            continue;
        }
        return gdMakePattern(GD_KIND_TRIPLE_STRAIGHT, gdRankValueFromRaw(top_3, levelRank), 6, 0, wc, 2, -1);
    }
    return null;
}
function gdTryStraightFlush(normals, wilds, levelRank) {
    var n = normals.length + wilds.length;
    if (n !== 5) {
        return null;
    }
    var wc = wilds.length;
    for (var suit = 0; suit < 4; suit++) {
        var suitCnt = {};
        var bad = false;
        for (var i = 0; i < normals.length; i++) {
            var id = normals[i];
            var r = gdRawRank(id);
            if (r >= 13) {
                bad = true;
                break;
            }
            if (gdSuit(id) !== suit) {
                bad = true;
                break;
            }
            var key = String(r);
            suitCnt[key] = (suitCnt[key] || 0) + 1;
            if (suitCnt[key] > 1) {
                bad = true;
                break;
            }
        }
        if (bad) {
            continue;
        }
        for (var top_4 = 4; top_4 <= 11; top_4++) {
            var seq = [top_4 - 4, top_4 - 3, top_4 - 2, top_4 - 1, top_4];
            if (!gdSeqAllowedForStraight(seq, levelRank)) {
                continue;
            }
            var need = 0;
            for (var i = 0; i < seq.length; i++) {
                var have = suitCnt[String(seq[i])] || 0;
                need += 1 - have;
            }
            if (need !== wc) {
                continue;
            }
            if (gdHasExtraRankOutside(suitCnt, seq)) {
                continue;
            }
            return gdMakePattern(GD_KIND_STRAIGHT_FLUSH, gdRankValueFromRaw(top_4, levelRank), 5, GD_BOMB_TIER_SF, wc, 5, suit);
        }
        {
            var seq = [11, 12, 0, 1, 2];
            var need = 0;
            for (var i = 0; i < seq.length; i++) {
                var r = seq[i];
                if (r === levelRank) {
                    need += 1;
                    continue;
                }
                var have = suitCnt[String(r)] || 0;
                need += 1 - have;
            }
            if (need === wc && !gdHasExtraRankOutside(suitCnt, seq)) {
                return gdMakePattern(GD_KIND_STRAIGHT_FLUSH, GD_STRAIGHT_MAIN_WHEEL_LOW, 5, GD_BOMB_TIER_SF, wc, 5, suit);
            }
        }
    }
    return null;
}
/** 主入口：对一手牌进行分类 */
function gdClassify(ids, levelRank) {
    if (ids.length === 0) {
        return gdMakePattern(GD_KIND_PASS, -1, 0, 0, 0, 0, -1);
    }
    var sp = gdSplitWilds(ids, levelRank);
    var nm = sp.normals;
    var wd = sp.wilds;
    var n = ids.length;
    var kb = gdTryKingBomb(nm, wd);
    if (kb) {
        return kb;
    }
    if (n >= 4 && n <= 8) {
        var b = gdTryBomb(nm, wd, levelRank);
        if (b) {
            return b;
        }
    }
    if (n === 1) {
        var s = gdTrySingle(ids, levelRank);
        if (s) {
            return s;
        }
    }
    if (n === 2) {
        var p = gdTryPair(nm, wd, levelRank);
        if (p) {
            return p;
        }
    }
    if (n === 3) {
        var t = gdTryTriple(nm, wd, levelRank);
        if (t) {
            return t;
        }
    }
    if (n === 5) {
        var sf = gdTryStraightFlush(nm, wd, levelRank);
        if (sf) {
            return sf;
        }
        var st = gdTryStraight(nm, wd, levelRank);
        if (st) {
            return st;
        }
        var tp = gdTryTriplePair(nm, wd, levelRank);
        if (tp) {
            return tp;
        }
    }
    /** 连对：6/8/10…24 张（偶数）；须先于同张数的其它尝试（此处仅连对 + 6 张钢板） */
    if (n >= 6 && n % 2 === 0 && n <= 24) {
        var ps = gdTryPairStraight(nm, wd, levelRank);
        if (ps) {
            return ps;
        }
    }
    if (n === 6) {
        var ts = gdTryTripleStraight(nm, wd, levelRank);
        if (ts) {
            return ts;
        }
    }
    return gdMakePattern(GD_KIND_INVALID, -1, 0, 0, 0, 0, -1);
}
/**
 * 比较两手牌；`last` 可为 PASS（领出）。规则：
 *   - PASS 被任何合法手压；
 *   - 任意 bombTier>0 压 bombTier=0；
 *   - 同属炸弹（含同花顺/天王炸）：先比 tier，再比 main；
 *   - 非炸：kind 与 len 必须相同，再比 main。
 */
function gdBeats(last, cur) {
    if (cur.kind === GD_KIND_INVALID) {
        return false;
    }
    if (last.kind === GD_KIND_PASS) {
        return cur.kind !== GD_KIND_PASS && cur.kind !== GD_KIND_INVALID;
    }
    var lastIsBomb = last.bombTier > 0;
    var curIsBomb = cur.bombTier > 0;
    if (curIsBomb && !lastIsBomb) {
        return true;
    }
    if (!curIsBomb && lastIsBomb) {
        return false;
    }
    if (curIsBomb && lastIsBomb) {
        if (cur.bombTier !== last.bombTier) {
            return cur.bombTier > last.bombTier;
        }
        return cur.main > last.main;
    }
    if (cur.kind !== last.kind) {
        return false;
    }
    if (cur.len !== last.len) {
        return false;
    }
    return cur.main > last.main;
}
/** 升级推进：以当前 level rawRank 前进 step 档，封顶停在 A（rawRank 11） */
function gdNextLevel(currentRawRank, step) {
    var idx = -1;
    for (var i = 0; i < GD_LEVEL_ORDER.length; i++) {
        if (GD_LEVEL_ORDER[i] === currentRawRank) {
            idx = i;
            break;
        }
    }
    if (idx < 0) {
        return currentRawRank;
    }
    var next = idx + step;
    if (next >= GD_LEVEL_ORDER.length) {
        next = GD_LEVEL_ORDER.length - 1;
    }
    return GD_LEVEL_ORDER[next];
}
/**
 * 掼蛋 Match 的纯逻辑层：发牌、出牌/过/贡/还、升级、快照、结算。
 *
 * 注意：Nakama 3.1+ JS 运行时禁止在 matchLoop / matchJoin 之外保持可变闭包状态；
 * 所有持久字段都挂在 GdMatchState 上，函数无副作用（除传入 state/dispatcher/nk/logger）。
 */
function gdNormUserId(uid) {
    return uid.toLowerCase();
}
function gdSeatForUser(state, userId) {
    var s = state.seatByUserId[gdNormUserId(userId)];
    return s === undefined ? -1 : s;
}
function gdMakeFullDeck() {
    var d = [];
    for (var i = 0; i < GD_DECK_COUNT; i++) {
        d.push(i);
    }
    return d;
}
function gdSortHand(h, levelRank) {
    h.sort(function (a, b) {
        var va = gdRankValue(a, levelRank);
        var vb = gdRankValue(b, levelRank);
        if (va !== vb) {
            return va - vb;
        }
        return a - b;
    });
}
function gdInitialState() {
    return {
        presences: {},
        seatByUserId: {},
        expectHumans: 4,
        aiCount: 0,
        isAiSeat: [false, false, false, false],
        phase: "waiting",
        teams: [
            { seats: [0, 2], level: GD_RAW_RANK_2, overALocked: false },
            { seats: [1, 3], level: GD_RAW_RANK_2, overALocked: false },
        ],
        dealerTeam: 0,
        levelRankActive: GD_RAW_RANK_2,
        isFirstRound: true,
        lastRoundWinnerSeat: -1,
        lastRoundLoserSeat: -1,
        lastRoundDoubleDown: false,
        hands: [[], [], [], []],
        dealTrace: [],
        dealSeed: "",
        dealEndAtMs: 0,
        pendingFirstPlaySeat: -1,
        tribute: {
            mode: "none",
            payers: [],
            receivers: [],
            given: {},
            returned: {},
            pendingPayer: -1,
            pendingReceiver: -1,
        },
        turn: 0,
        finishedOrder: [],
        lastPattern: null,
        lastPlayer: -1,
        lastPlayIds: [],
        passes: 0,
        seq: 0,
        aiPlayDelayUntilMs: 0,
        winnerTeam: -1,
        continueReady: [false, false, false, false],
        aiDelegate: [false, false, false, false],
        seatCat: [0, 1, 2, 0],
        errorLog: [],
        tributeEvent: null,
    };
}
function gdAssignSeats(state) {
    var ids = Object.keys(state.presences);
    ids.sort();
    state.seatByUserId = {};
    state.isAiSeat = [false, false, false, false];
    for (var i = 0; i < ids.length; i++) {
        state.seatByUserId[gdNormUserId(ids[i])] = i;
    }
    var eh = state.expectHumans;
    for (var s = eh; s < 4; s++) {
        state.isAiSeat[s] = true;
    }
}
function gdAssignSeatCats(state, nk) {
    var arr = [0, 1, 2, 3];
    shuffleInPlace(nk, arr);
    state.seatCat = arr;
}
/** 同队：座 (0,2) 一队；(1,3) 一队 */
function gdTeamOfSeat(seat) {
    return seat % 2 === 0 ? 0 : 1;
}
function gdTeammateSeat(seat) {
    return (seat + 2) % 4;
}
function gdRemoveCardsFromHand(hand, play) {
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
/**
 * 重置为「新一局」：洗牌 / 发牌 / 准备贡牌阶段。
 * 入口职责：
 *   - 本局 dealerTeam 已由上一局 finalize 设置（或整场初局为 0）；
 *   - 本局生效级牌 = teams[dealerTeam].level；
 *   - 先进入 deal（供客户端播发牌动画）；首局结束后进入 play（首出随机），非首局进入 tribute_wait。
 */
function gdResetRound(state, nk) {
    state.phase = "deal";
    state.hands = [[], [], [], []];
    state.turn = -1;
    state.lastPattern = null;
    state.lastPlayer = -1;
    state.lastPlayIds = [];
    state.passes = 0;
    state.finishedOrder = [];
    state.continueReady = [false, false, false, false];
    state.aiDelegate = [false, false, false, false];
    state.winnerTeam = -1; // 只在整场 finalize 时才置 0/1
    state.tribute = {
        mode: "none",
        payers: [],
        receivers: [],
        given: {},
        returned: {},
        pendingPayer: -1,
        pendingReceiver: -1,
    };
    state.levelRankActive = state.teams[state.dealerTeam].level;
    var deck = gdMakeFullDeck();
    shuffleInPlace(nk, deck);
    var sb = randomBytesCompat(nk, 8);
    state.dealSeed = Array.prototype.map
        .call(sb, function (x) {
        return ("0" + x.toString(16)).slice(-2);
    })
        .join("");
    var trace = [];
    for (var i = 0; i < GD_DECK_COUNT; i++) {
        trace.push({ seat: i % 4, card: deck[i] });
    }
    state.dealTrace = trace;
    for (var i = 0; i < GD_HAND_SIZE; i++) {
        state.hands[0].push(deck[i * 4 + 0]);
        state.hands[1].push(deck[i * 4 + 1]);
        state.hands[2].push(deck[i * 4 + 2]);
        state.hands[3].push(deck[i * 4 + 3]);
    }
    for (var s = 0; s < 4; s++) {
        gdSortHand(state.hands[s], state.levelRankActive);
    }
    state.pendingFirstPlaySeat = -1;
    if (state.isFirstRound) {
        state.pendingFirstPlaySeat = randomIntBelow(nk, 4);
    }
    var dealUntil = Date.now() + GD_DEAL_PHASE_MS;
    state.dealEndAtMs = dealUntil;
    state.aiPlayDelayUntilMs = dealUntil + GD_AI_POST_DEAL_DELAY_MS;
}
/** deal 计时结束 → play（首局）或贡牌；由 matchLoop 每 tick 调用 */
function gdTryAdvanceDealPhase(state, nk) {
    if (state.phase !== "deal") {
        return false;
    }
    if (Date.now() < state.dealEndAtMs) {
        return false;
    }
    state.dealEndAtMs = 0;
    if (state.isFirstRound) {
        state.turn = state.pendingFirstPlaySeat;
        state.pendingFirstPlaySeat = -1;
        state.phase = "play";
    }
    else {
        gdBeginTributePhase(state);
    }
    state.aiPlayDelayUntilMs = Date.now() + GD_AI_POST_DEAL_DELAY_MS;
    return true;
}
function gdBeginTributePhase(state) {
    state.phase = "tribute_wait";
    var winner = state.lastRoundWinnerSeat;
    var loser = state.lastRoundLoserSeat;
    if (winner < 0 || loser < 0) {
        state.phase = "play";
        state.turn = 0;
        return;
    }
    if (state.lastRoundDoubleDown) {
        var winnerTeammate = gdTeammateSeat(winner);
        var loserTeammate = gdTeammateSeat(loser);
        state.tribute.mode = "double";
        state.tribute.payers = [loser, loserTeammate];
        state.tribute.receivers = [winner, winnerTeammate];
    }
    else {
        state.tribute.mode = "single";
        state.tribute.payers = [loser];
        state.tribute.receivers = [winner];
    }
    state.tribute.pendingPayer = state.tribute.payers[0];
    state.tribute.pendingReceiver = -1;
}
/** 手里大王数（不计红心级牌） */
function gdCountBigJokers(hand) {
    var c = 0;
    for (var i = 0; i < hand.length; i++) {
        if (gdRawRank(hand[i]) === GD_RAW_RANK_BIG_JOKER) {
            c++;
        }
    }
    return c;
}
/** 能否抗贡：末游方几家的大王合计 ≥2（含一家两张或两家各一张） */
function gdCanResistTribute(state) {
    var sum = 0;
    for (var i = 0; i < state.tribute.payers.length; i++) {
        sum += gdCountBigJokers(state.hands[state.tribute.payers[i]]);
    }
    return sum >= 2;
}
function gdApplyTribute(state, seat, cardId) {
    if (state.phase !== "tribute_wait") {
        return "bad_phase";
    }
    if (state.tribute.pendingPayer !== seat) {
        return "not_your_turn";
    }
    if (gdIsHeartLevelCard(cardId, state.levelRankActive)) {
        return "tribute_heart_level_forbidden";
    }
    var idx = state.hands[seat].indexOf(cardId);
    if (idx < 0) {
        return "card_not_in_hand";
    }
    state.tribute.given[String(seat)] = cardId;
    state.hands[seat].splice(idx, 1);
    var pos = state.tribute.payers.indexOf(seat);
    var recv0 = pos >= 0 ? state.tribute.receivers[pos] : -1;
    state.tributeEvent = { kind: "give", from: seat, to: recv0, card: cardId };
    // 推进下一个 payer / 进入 return_wait
    if (pos + 1 < state.tribute.payers.length) {
        state.tribute.pendingPayer = state.tribute.payers[pos + 1];
    }
    else {
        state.tribute.pendingPayer = -1;
        gdEnterReturnPhase(state);
    }
    return null;
}
function gdApplyTributeResist(state, seat) {
    if (state.phase !== "tribute_wait") {
        return "bad_phase";
    }
    if (state.tribute.payers.indexOf(seat) < 0) {
        return "not_payer";
    }
    if (!gdCanResistTribute(state)) {
        return "no_resist_right";
    }
    state.tribute.mode = "resist";
    state.tribute.pendingPayer = -1;
    state.tribute.pendingReceiver = -1;
    // 抗贡：由上局头游先出
    state.phase = "play";
    state.turn = state.lastRoundWinnerSeat;
    return null;
}
function gdEnterReturnPhase(state) {
    state.phase = "return_wait";
    if (state.tribute.receivers.length === 0) {
        gdFinalizeTributeExchange(state);
        return;
    }
    state.tribute.pendingReceiver = state.tribute.receivers[0];
}
function gdApplyReturn(state, seat, cardId) {
    if (state.phase !== "return_wait") {
        return "bad_phase";
    }
    if (state.tribute.pendingReceiver !== seat) {
        return "not_your_turn";
    }
    var rr = gdRawRank(cardId);
    if (rr >= GD_RAW_RANK_SMALL_JOKER) {
        return "return_too_big";
    }
    if (gdIsHeartLevelCard(cardId, state.levelRankActive)) {
        return "return_too_big";
    }
    // 3..10（raw 0..7）；非打 2 时普通 2 可作还贡（2 非当前级牌）
    var okSmall = rr <= 7;
    var okPlainTwo = rr === GD_RAW_RANK_2 && state.levelRankActive !== GD_RAW_RANK_2;
    if (!okSmall && !okPlainTwo) {
        return "return_too_big";
    }
    var idx = state.hands[seat].indexOf(cardId);
    if (idx < 0) {
        return "card_not_in_hand";
    }
    state.tribute.returned[String(seat)] = cardId;
    state.hands[seat].splice(idx, 1);
    var pos = state.tribute.receivers.indexOf(seat);
    var payerBack = pos >= 0 ? state.tribute.payers[pos] : -1;
    state.tributeEvent = { kind: "return", from: seat, to: payerBack, card: cardId };
    if (pos + 1 < state.tribute.receivers.length) {
        state.tribute.pendingReceiver = state.tribute.receivers[pos + 1];
    }
    else {
        state.tribute.pendingReceiver = -1;
        gdFinalizeTributeExchange(state);
    }
    return null;
}
/**
 * 贡完+还完：合并手牌、排序、进入 play。
 * - 单下：末游先出。
 * - 双下：贡牌大的一家先出；贡牌同大则头游的下家先出；头游收较大贡牌、二游收较小贡牌；
 *   头游的还牌给进贡大的一方，二游的还牌给另一方。
 */
function gdFinalizeTributeExchange(state) {
    var lvl = state.levelRankActive;
    var mode = state.tribute.mode;
    if (mode === "resist") {
        return;
    }
    if (mode === "single") {
        var p = state.tribute.payers[0];
        var r = state.tribute.receivers[0];
        var gift = state.tribute.given[String(p)];
        var back = state.tribute.returned[String(r)];
        if (gift !== undefined) {
            state.hands[r].push(gift);
        }
        if (back !== undefined) {
            state.hands[p].push(back);
        }
        for (var s = 0; s < 4; s++) {
            gdSortHand(state.hands[s], lvl);
        }
        state.phase = "play";
        state.turn = state.lastRoundLoserSeat;
        return;
    }
    if (mode === "double") {
        var p0 = state.tribute.payers[0];
        var p1 = state.tribute.payers[1];
        var w = state.tribute.receivers[0];
        var w2 = state.tribute.receivers[1];
        var g0 = state.tribute.given[String(p0)];
        var g1 = state.tribute.given[String(p1)];
        var rv0 = g0 !== undefined ? gdRankValue(g0, lvl) : -999999;
        var rv1 = g1 !== undefined ? gdRankValue(g1, lvl) : -999999;
        var bigP = p0;
        var smallP = p1;
        if (rv1 > rv0) {
            bigP = p1;
            smallP = p0;
        }
        var bg = state.tribute.given[String(bigP)];
        var sg = state.tribute.given[String(smallP)];
        if (bg === undefined || sg === undefined) {
            return;
        }
        state.hands[w].push(bg);
        state.hands[w2].push(sg);
        var backW = state.tribute.returned[String(w)];
        var backW2 = state.tribute.returned[String(w2)];
        if (backW !== undefined) {
            state.hands[bigP].push(backW);
        }
        if (backW2 !== undefined) {
            state.hands[smallP].push(backW2);
        }
        for (var s = 0; s < 4; s++) {
            gdSortHand(state.hands[s], lvl);
        }
        state.phase = "play";
        if (rv0 === rv1) {
            state.turn = (w + 1) % 4;
        }
        else {
            state.turn = bigP;
        }
        return;
    }
    for (var i = 0; i < state.tribute.payers.length; i++) {
        var p = state.tribute.payers[i];
        var r = state.tribute.receivers[i];
        var gift = state.tribute.given[String(p)];
        var back = state.tribute.returned[String(r)];
        if (gift !== undefined) {
            state.hands[r].push(gift);
        }
        if (back !== undefined) {
            state.hands[p].push(back);
        }
    }
    for (var s = 0; s < 4; s++) {
        gdSortHand(state.hands[s], lvl);
    }
    state.phase = "play";
    state.turn = state.lastRoundWinnerSeat;
}
/** 推进到下一个仍有手牌的座位（跳过已完成） */
function gdAdvanceTurn(state, from) {
    var t = (from + 1) % 4;
    for (var i = 0; i < 4; i++) {
        if (state.hands[t].length > 0) {
            return t;
        }
        t = (t + 1) % 4;
    }
    return from;
}
/**
 * 接风：某人刚出完最后一手，其余仍有牌者均 pass 后，由**其对家**领出（对家也已出完时退化为顺时针下一家仍有牌者）。
 */
function gdPartnerLeadAfterFinishedFree(state, finishedSeat) {
    var mate = gdTeammateSeat(finishedSeat);
    if (state.hands[mate].length > 0) {
        return mate;
    }
    return gdAdvanceTurn(state, finishedSeat);
}
/** 出牌 */
function gdApplyPlay(state, seat, ids) {
    if (state.phase !== "play") {
        return "bad_phase";
    }
    if (state.turn !== seat) {
        return "not_your_turn";
    }
    if (!ids || ids.length === 0) {
        return "empty_play";
    }
    // 校验手里都有
    var hand = state.hands[seat].slice();
    if (!gdRemoveCardsFromHand(hand, ids)) {
        return "card_not_in_hand";
    }
    var pat = gdClassify(ids, state.levelRankActive);
    if (pat.kind === GD_KIND_INVALID) {
        return "invalid_pattern";
    }
    var last = state.lastPattern !== null
        ? state.lastPattern
        : { kind: GD_KIND_PASS, main: -1, len: 0, bombTier: 0, wildUsed: 0, straightLen: 0, suit: -1 };
    if (!gdBeats(last, pat)) {
        return "cannot_beat";
    }
    // 落地
    gdRemoveCardsFromHand(state.hands[seat], ids);
    state.lastPattern = pat;
    state.lastPlayer = seat;
    state.lastPlayIds = ids.slice();
    state.passes = 0;
    // 检测出完
    if (state.hands[seat].length === 0 && state.finishedOrder.indexOf(seat) < 0) {
        state.finishedOrder.push(seat);
    }
    // 本局结束？某队两人都出完
    if (gdIsRoundOver(state)) {
        gdFinalizeRound(state);
        return null;
    }
    // 推进 turn：若自己出完了，从自己往后找下一个有牌的座位；否则正常推进
    state.turn = gdAdvanceTurn(state, seat);
    return null;
}
function gdApplyPass(state, seat) {
    if (state.phase !== "play") {
        return "bad_phase";
    }
    if (state.turn !== seat) {
        return "not_your_turn";
    }
    if (state.lastPattern === null || state.lastPattern.kind === GD_KIND_PASS) {
        return "cannot_pass_on_free_lead";
    }
    state.passes++;
    state.turn = gdAdvanceTurn(state, seat);
    // 本局结束？（极端情况：pass 后所有人都出完）
    if (gdIsRoundOver(state)) {
        gdFinalizeRound(state);
        return null;
    }
    // 一圈过完？两种场景：
    //   (a) lastPlayer 仍有牌：advance 后 turn 回到 lastPlayer → free lead；
    //   (b) lastPlayer 已出完：gdAdvanceTurn 会跳过他，永远走不回去。
    //       此时应以「所有仍有牌且非 lastPlayer 的座位都 pass 过一轮」作为一圈结束判据。
    var lpAlive = state.hands[state.lastPlayer].length > 0;
    var roundEnded = false;
    if (lpAlive && state.turn === state.lastPlayer) {
        roundEnded = true;
    }
    else if (!lpAlive) {
        var aliveOpp = 0;
        for (var s = 0; s < 4; s++) {
            if (s !== state.lastPlayer && state.hands[s].length > 0) {
                aliveOpp++;
            }
        }
        if (state.passes >= aliveOpp) {
            roundEnded = true;
        }
    }
    if (roundEnded) {
        state.lastPattern = null;
        state.lastPlayIds = [];
        state.passes = 0;
        if (!lpAlive) {
            state.turn = gdPartnerLeadAfterFinishedFree(state, state.lastPlayer);
        }
    }
    return null;
}
/** 某队两人都出完即为本局结束（剩 2 人 / 3 人的具体名次由 finishedOrder 补齐） */
function gdIsRoundOver(state) {
    var teamDone = [0, 0];
    for (var i = 0; i < state.finishedOrder.length; i++) {
        teamDone[gdTeamOfSeat(state.finishedOrder[i])]++;
    }
    return teamDone[0] === 2 || teamDone[1] === 2;
}
/** 结算本局：补齐 finishedOrder 至全 4 人 → 升级 → 判定整场毕业 */
function gdFinalizeRound(state) {
    // 补齐剩余玩家名次：按手牌数量升序（更少的排更前）
    var remaining = [];
    for (var s = 0; s < 4; s++) {
        if (state.finishedOrder.indexOf(s) < 0) {
            remaining.push(s);
        }
    }
    remaining.sort(function (a, b) {
        return state.hands[a].length - state.hands[b].length;
    });
    for (var i = 0; i < remaining.length; i++) {
        state.finishedOrder.push(remaining[i]);
    }
    // 头游 / 二游 / 三游 / 末游
    var winner = state.finishedOrder[0];
    var second = state.finishedOrder[1];
    var loser = state.finishedOrder[3];
    var winnerTeam = gdTeamOfSeat(winner);
    var doubleDown = gdTeamOfSeat(second) === winnerTeam;
    var thirdIsWinnerTeam = gdTeamOfSeat(state.finishedOrder[2]) === winnerTeam;
    // 升级：按头游的队友名次
    var upStep = 1;
    if (doubleDown) {
        upStep = 3;
    }
    else if (thirdIsWinnerTeam) {
        upStep = 2;
    }
    var team = state.teams[winnerTeam];
    var prevLevel = team.level;
    // 过 A 检查：若本局 dealerTeam==winnerTeam 且 teams[winnerTeam].overALocked 为真（即已在 A 上打），则毕业
    var isOverARound = state.dealerTeam === winnerTeam && team.overALocked;
    if (isOverARound) {
        state.winnerTeam = winnerTeam;
        state.phase = "finished";
    }
    else {
        // 推进 level；若升到 A，设置 overALocked
        var nl = gdNextLevel(prevLevel, upStep);
        team.level = nl;
        if (nl === GD_RAW_RANK_A) {
            team.overALocked = true;
        }
        state.dealerTeam = winnerTeam;
        state.levelRankActive = team.level;
        // 记录本局信息供下一局贡牌
        state.lastRoundWinnerSeat = winner;
        state.lastRoundLoserSeat = loser;
        state.lastRoundDoubleDown = doubleDown;
        state.isFirstRound = false;
        state.phase = "finished"; // finished 阶段等待四人点继续
    }
}
/** 切换本座「AI 托管」；仅真人可设。 */
function gdApplyDelegate(state, seat, on) {
    if (state.isAiSeat[seat]) {
        return "ai_seat_no_delegate";
    }
    state.aiDelegate[seat] = on;
    return null;
}
/** 全员（含 AI）点「继续」后开新局。AI 在 matchLoop 里自动 READY。 */
function gdApplyContinue(state, seat, nk) {
    if (state.phase !== "finished") {
        return "bad_phase";
    }
    if (state.winnerTeam >= 0) {
        return "match_finished";
    }
    state.continueReady[seat] = true;
    var all = true;
    for (var s = 0; s < 4; s++) {
        if (!state.continueReady[s]) {
            all = false;
            break;
        }
    }
    if (all) {
        gdResetRound(state, nk);
    }
    return null;
}
/** 钱包 delta：名次 1/2/3/4 依次 + / + / - / -；具体数字见 docs/guandan_DESIGN.md §9.1 */
function gdComputeScoreDeltas(state) {
    var deltas = [0, 0, 0, 0];
    if (state.finishedOrder.length < 4) {
        return deltas;
    }
    var winner = state.finishedOrder[0];
    var second = state.finishedOrder[1];
    var third = state.finishedOrder[2];
    var loser = state.finishedOrder[3];
    var winnerTeam = gdTeamOfSeat(winner);
    var doubleDown = gdTeamOfSeat(second) === winnerTeam;
    var thirdSameTeam = gdTeamOfSeat(third) === winnerTeam;
    var payout = [0, 0, 0, 0];
    if (doubleDown) {
        payout = [1000, 1000, -500, -500];
    }
    else if (thirdSameTeam) {
        payout = [600, 200, -200, -600];
    }
    else {
        payout = [400, 100, 100, -600];
    }
    deltas[winner] += payout[0];
    deltas[second] += payout[1];
    deltas[third] += payout[2];
    deltas[loser] += payout[3];
    if (state.winnerTeam >= 0) {
        // 整场毕业额外奖励
        deltas[winner] += 2000;
        deltas[gdTeammateSeat(winner)] += 2000;
    }
    return deltas;
}
function gdBuildRoster(state) {
    var uidForSeat = [null, null, null, null];
    for (var uid in state.seatByUserId) {
        if (!Object.prototype.hasOwnProperty.call(state.seatByUserId, uid)) {
            continue;
        }
        var s = state.seatByUserId[uid];
        if (s >= 0 && s < 4) {
            uidForSeat[s] = uid;
        }
    }
    var roster = [];
    for (var s = 0; s < 4; s++) {
        var uid = uidForSeat[s];
        var username = "";
        if (uid !== null) {
            var pr = state.presences[uid];
            if (pr) {
                username = pr.username || "";
            }
        }
        if (username === "" && state.isAiSeat[s]) {
            username = "AI";
        }
        roster.push({
            seat: s,
            user_id: uid !== null ? uid : "",
            username: username,
            is_ai: state.isAiSeat[s],
        });
    }
    return roster;
}
function gdBuildSnapshot(state) {
    var handLens = [0, 0, 0, 0];
    for (var s = 0; s < 4; s++) {
        handLens[s] = state.hands[s].length;
    }
    var levels = [state.teams[0].level, state.teams[1].level];
    var tribute = state.phase === "tribute_wait" || state.phase === "return_wait"
        ? {
            mode: state.tribute.mode,
            payers: state.tribute.payers.slice(),
            receivers: state.tribute.receivers.slice(),
            pending_payer: state.tribute.pendingPayer,
            pending_receiver: state.tribute.pendingReceiver,
        }
        : null;
    var last = state.lastPattern
        ? {
            player: state.lastPlayer,
            kind: state.lastPattern.kind,
            main: state.lastPattern.main,
            len: state.lastPattern.len,
            bomb_tier: state.lastPattern.bombTier,
            wild_used: state.lastPattern.wildUsed,
            ids: state.lastPlayIds.slice(),
        }
        : null;
    return {
        v: 1,
        phase: state.phase,
        dealer_team: state.dealerTeam,
        level_active: state.levelRankActive,
        levels: levels,
        turn: state.turn,
        last: last,
        hand_lens: handLens,
        finished: state.finishedOrder.slice(),
        seat_cats: state.seatCat.slice(),
        seq: state.seq,
        tribute: tribute,
        winner_team: state.winnerTeam,
        is_first_round: state.isFirstRound,
        roster: gdBuildRoster(state),
        tribute_event: state.tributeEvent,
        ai_delegate: state.aiDelegate.slice(),
        deal_end_ms: state.phase === "deal" ? state.dealEndAtMs : 0,
        first_draw_seat: 0,
        first_play_seat: state.phase === "deal" && state.isFirstRound && state.pendingFirstPlaySeat >= 0
            ? state.pendingFirstPlaySeat
            : -1,
    };
}
/** 广播状态：每个真人看到自己的手牌（self_hand） */
function gdBroadcastState(dispatcher, state, logger, reason) {
    state.seq++;
    var base = gdBuildSnapshot(state);
    state.tributeEvent = null;
    // 真人用户：按 presence 单独发送含 self_hand 的快照
    var presList = [];
    for (var uid in state.presences) {
        if (state.presences.hasOwnProperty(uid)) {
            presList.push(state.presences[uid]);
        }
    }
    for (var i = 0; i < presList.length; i++) {
        var p = presList[i];
        var seat = gdSeatForUser(state, p.userId);
        var packet = {};
        for (var k in base) {
            if (base.hasOwnProperty(k)) {
                packet[k] = base[k];
            }
        }
        packet["self_seat"] = seat;
        packet["self_hand"] = seat >= 0 ? state.hands[seat].slice() : [];
        // 若本人已出完（上游），在 play/finished 阶段把队友明牌公开给他看（托管/陪同观战体验）
        if (seat >= 0 && state.finishedOrder.indexOf(seat) >= 0) {
            var mate = gdTeammateSeat(seat);
            packet["teammate_hand"] = state.hands[mate].slice();
            packet["teammate_seat"] = mate;
        }
        try {
            dispatcher.broadcastMessage(GD_OP_SNAPSHOT, JSON.stringify(packet), [p], null);
        }
        catch (e) {
            logger.warn("gd broadcast to %s failed: %s", p.userId, String(e));
        }
    }
    if (presList.length === 0) {
        // 全 AI 桌：仍广播一份用于观察（无 self_hand）
        var packet = {};
        for (var k in base) {
            if (base.hasOwnProperty(k)) {
                packet[k] = base[k];
            }
        }
        packet["self_seat"] = -1;
        packet["self_hand"] = [];
        try {
            dispatcher.broadcastMessage(GD_OP_SNAPSHOT, JSON.stringify(packet), null, null);
        }
        catch (e) {
            logger.warn("gd broadcast (no presence) failed: %s", String(e));
        }
    }
}
/**
 * 掼蛋 Match Handler（Nakama MatchHandler 契约）。
 * 与 ddz 同样走「全员加满 → resetRound → 广播快照」的流程；AI 由 ai_server 推动。
 */
function gdMatchInit(ctx, logger, nk, params) {
    logger.info("guandan matchInit: params=%s", JSON.stringify(params));
    var st = gdInitialState();
    if (params["expect_humans"]) {
        st.expectHumans = parseInt(params["expect_humans"], 10);
    }
    if (params["ai"]) {
        st.aiCount = parseInt(params["ai"], 10);
    }
    if (st.expectHumans + st.aiCount !== 4) {
        logger.warn("guandan matchInit: expect_humans+ai!=4, clamping ai");
        st.aiCount = 4 - st.expectHumans;
    }
    return {
        state: st,
        tickRate: 5,
        label: "guandan",
    };
}
function gdMatchJoinAttempt(ctx, logger, nk, dispatcher, tick, state, presence, metadata) {
    var st = state;
    var n = Object.keys(st.presences).length;
    if (n >= st.expectHumans) {
        logger.warn("guandan matchJoinAttempt REJECT full: userId=%s current=%d expectHumans=%d", presence.userId, n, st.expectHumans);
        return { state: state, accept: false, rejectMessage: "full" };
    }
    return { state: state, accept: true };
}
function gdMatchJoin(ctx, logger, nk, dispatcher, tick, state, presences) {
    var st = state;
    for (var i = 0; i < presences.length; i++) {
        var p = presences[i];
        st.presences[p.userId] = p;
    }
    gdAssignSeats(st);
    var n = Object.keys(st.presences).length;
    logger.info("guandan matchJoin: total=%d phase=%s", n, st.phase);
    if (n === st.expectHumans && st.phase === "waiting") {
        gdAssignSeatCats(st, nk);
        // 随机庄家队
        st.dealerTeam = randomIntBelow(nk, 2);
        gdResetRound(st, nk);
        gdBroadcastState(dispatcher, st, logger, "join-after-resetRound");
    }
    else {
        gdBroadcastState(dispatcher, st, logger, "join");
    }
    return { state: st };
}
function gdMatchLeave(ctx, logger, nk, dispatcher, tick, state, presences) {
    var st = state;
    for (var i = 0; i < presences.length; i++) {
        delete st.presences[presences[i].userId];
    }
    gdAssignSeats(st);
    return { state: st };
}
/** 解码 Match 消息（同 ddz 的实现，避免 String(ArrayBuffer) 得到 "[object ArrayBuffer]"） */
function gdDecodeMatchData(data) {
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
    var s = "";
    for (var i = 0; i < u8.length; i++) {
        s += String.fromCharCode(u8[i]);
    }
    return s;
}
function gdSendError(dispatcher, logger, st, presence, seat, code) {
    try {
        dispatcher.broadcastMessage(GD_OP_ERROR, JSON.stringify({ seq: st.seq, seat: seat, error: code }), [presence], null);
    }
    catch (e) {
        logger.error("guandan send err: %s", String(e));
    }
}
function gdMatchLoop(ctx, logger, nk, dispatcher, tick, state, messages) {
    var st = state;
    for (var m = 0; m < messages.length; m++) {
        var msg = messages[m];
        var senderId = msg.sender.userId;
        var seat = gdSeatForUser(st, senderId);
        if (seat < 0) {
            logger.warn("guandan matchLoop: unknown sender=%s", senderId);
            continue;
        }
        var payload = void 0;
        var rawJson = gdDecodeMatchData(msg.data);
        try {
            payload = rawJson.length > 0 ? JSON.parse(rawJson) : {};
        }
        catch (e) {
            logger.warn("guandan matchLoop: bad json op=%d seat=%d", msg.opCode, seat);
            continue;
        }
        var err = null;
        if (msg.opCode === GD_REQ_PLAY) {
            var cards = payload.ids || [];
            err = gdApplyPlay(st, seat, cards);
            if (!err) {
                st.aiPlayDelayUntilMs = Date.now() + GD_AI_PLAY_PACE_MS;
            }
        }
        else if (msg.opCode === GD_REQ_PASS) {
            err = gdApplyPass(st, seat);
            if (!err) {
                st.aiPlayDelayUntilMs = Date.now() + GD_AI_PLAY_PACE_MS;
            }
        }
        else if (msg.opCode === GD_REQ_TRIBUTE) {
            var cid = typeof payload.id === "number" ? payload.id : -1;
            err = gdApplyTribute(st, seat, cid);
        }
        else if (msg.opCode === GD_REQ_TRIBUTE_RESIST) {
            err = gdApplyTributeResist(st, seat);
        }
        else if (msg.opCode === GD_REQ_RETURN) {
            var cid = typeof payload.id === "number" ? payload.id : -1;
            err = gdApplyReturn(st, seat, cid);
        }
        else if (msg.opCode === GD_REQ_CONTINUE) {
            err = gdApplyContinue(st, seat, nk);
        }
        else if (msg.opCode === GD_REQ_DELEGATE) {
            var on = payload.on === true;
            err = gdApplyDelegate(st, seat, on);
        }
        else if (msg.opCode === GD_REQ_HINT) {
            if (st.phase !== "play" || st.turn !== seat) {
                gdSendError(dispatcher, logger, st, msg.sender, seat, "hint_bad_phase");
                continue;
            }
            var pick = gdAiPickPlay(st, seat);
            try {
                dispatcher.broadcastMessage(GD_OP_HINT, JSON.stringify({ v: 1, pass: pick.pass, ids: pick.ids || [] }), [msg.sender], null);
            }
            catch (e) {
                logger.warn("guandan hint: %s", String(e));
            }
            continue;
        }
        else {
            // 未知 op：忽略
            continue;
        }
        if (err) {
            gdSendError(dispatcher, logger, st, msg.sender, seat, err);
        }
        else {
            gdBroadcastState(dispatcher, st, logger, "matchLoop");
            if (st.phase === "finished") {
                var deltas = gdComputeScoreDeltas(st);
                var settlement = JSON.stringify({
                    v: 1,
                    finished_order: st.finishedOrder.slice(),
                    winner_team: st.winnerTeam,
                    levels: [st.teams[0].level, st.teams[1].level],
                    score_delta: deltas,
                });
                try {
                    dispatcher.broadcastMessage(GD_OP_SETTLEMENT, settlement, null, null);
                }
                catch (e) {
                    logger.warn("guandan settlement broadcast: %s", String(e));
                }
            }
        }
    }
    if (gdTryAdvanceDealPhase(st, nk)) {
        gdBroadcastState(dispatcher, st, logger, "dealElapsed");
    }
    gdRunAiUntilHumanOrDone(st, dispatcher, logger, nk);
    return { state: st };
}
function gdMatchTerminate(ctx, logger, nk, dispatcher, tick, state, graceSeconds) {
    return { state: state };
}
function gdMatchSignal(ctx, logger, nk, dispatcher, tick, state, data) {
    return { state: state, data: "ok" };
}
var guandanMatchHandler = {
    matchInit: gdMatchInit,
    matchJoinAttempt: gdMatchJoinAttempt,
    matchJoin: gdMatchJoin,
    matchLeave: gdMatchLeave,
    matchLoop: gdMatchLoop,
    matchTerminate: gdMatchTerminate,
    matchSignal: gdMatchSignal,
};
/**
 * 掼蛋匹配队列（自建 RPC 版）。与 ddz/mm_queue 同策略：
 *   - 独立 Storage collection "guandan_mm"；
 *   - 4 人成局立即 matchCreate；
 *   - 2–3 人累计等待超过 GD_MM_WAIT_MS 用 AI 补位；
 *   - 1 人同样等待超时后开「1 真 + 3 AI」桌。
 */
var GD_MM_WAIT_MS = 10000;
var GD_MM_COLLECTION = "guandan_mm";
var GD_MM_STATE_KEY = "queue_state";
var GD_MM_OWNER = "00000000-0000-0000-0000-000000000000";
function gdMmDefaultState() {
    return { entries: [], results: {} };
}
function gdMmRevive(raw) {
    var clone = raw;
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
    return { entries: entries, results: results };
}
function gdMmToValue(state) {
    return {
        entries: state.entries,
        results: state.results,
    };
}
function gdMmMakeTicket(nk) {
    var u = randomBytesCompat(nk, 8);
    var hex = Array.prototype.map
        .call(u, function (x) {
        return ("0" + x.toString(16)).slice(-2);
    })
        .join("");
    return "gdmm_" + Date.now().toString(36) + "_" + hex;
}
function gdMmMutateState(nk, logger, mutator) {
    mutateGlobalStorage(nk, logger, GD_MM_COLLECTION, GD_MM_STATE_KEY, GD_MM_OWNER, gdMmDefaultState, gdMmRevive, gdMmToValue, mutator, "guandan_mm");
}
function gdMmNotifyResults(state, tickets, matchId) {
    for (var i = 0; i < tickets.length; i++) {
        state.results[tickets[i]] = { matchId: matchId };
    }
}
function gdMmCreateMatchInner(nk, logger, humans, ai) {
    var id;
    try {
        id = nk.matchCreate("guandan", {
            expect_humans: String(humans),
            ai: String(ai),
        });
    }
    catch (e) {
        logger.error("guandan_mm matchCreate: %s", String(e));
        return null;
    }
    if (!id || String(id).length === 0) {
        logger.error("guandan_mm matchCreate empty id");
        return null;
    }
    logger.info("guandan_mm: created match %s humans=%d ai=%d", id, humans, ai);
    return id;
}
function gdMmProcessQueueCore(state, nk, logger) {
    var now = Date.now();
    var q = state.entries.slice();
    q.sort(function (a, b) {
        return a.joinedAtMs - b.joinedAtMs;
    });
    while (q.length >= 4) {
        var a = q[0];
        var b = q[1];
        var c = q[2];
        var d = q[3];
        var id = gdMmCreateMatchInner(nk, logger, 4, 0);
        if (!id) {
            break;
        }
        q.splice(0, 4);
        gdMmNotifyResults(state, [a.ticket, b.ticket, c.ticket, d.ticket], id);
    }
    // 2–3 人等待超过窗口 → AI 补位
    if (q.length >= 2 && q.length < 4) {
        var oldest = q[0].joinedAtMs;
        if (now - oldest >= GD_MM_WAIT_MS) {
            var humans = q.length;
            var ai = 4 - humans;
            var id = gdMmCreateMatchInner(nk, logger, humans, ai);
            if (id) {
                var tickets = [];
                for (var i = 0; i < humans; i++) {
                    tickets.push(q[i].ticket);
                }
                q.splice(0, humans);
                gdMmNotifyResults(state, tickets, id);
            }
        }
    }
    if (q.length === 1) {
        if (now - q[0].joinedAtMs >= GD_MM_WAIT_MS) {
            var id = gdMmCreateMatchInner(nk, logger, 1, 3);
            if (id) {
                gdMmNotifyResults(state, [q[0].ticket], id);
                q.splice(0, 1);
            }
        }
    }
    state.entries = q;
}
function rpcGuandanMmJoin(ctx, logger, nk, payload) {
    var uid = ctx.userId;
    if (!uid) {
        return rpcErr("unauthorized");
    }
    var outTicket = "";
    try {
        gdMmMutateState(nk, logger, function (st) {
            var nextEntries = [];
            for (var i = 0; i < st.entries.length; i++) {
                if (st.entries[i].userId !== uid) {
                    nextEntries.push(st.entries[i]);
                }
                else {
                    delete st.results[st.entries[i].ticket];
                }
            }
            var ticket = gdMmMakeTicket(nk);
            var username = "";
            try {
                var acc = nk.accountGetId(uid);
                if (acc && acc.user && acc.user.username) {
                    username = acc.user.username;
                }
            }
            catch (e) {
                logger.warn("guandan_mm accountGetId: %s", String(e));
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
        logger.error("guandan_mm join storage: %s", String(e));
        return rpcErr("storage_busy");
    }
    logger.info("guandan_mm join user=%s ticket=%s", uid, outTicket);
    return rpcOk({ ticket: outTicket });
}
function rpcGuandanMmPoll(ctx, logger, nk, payload) {
    var ticket = "";
    try {
        var u = JSON.parse(payload || "{}");
        ticket = String(u.ticket || "");
    }
    catch (e) {
        return rpcErr("bad_payload");
    }
    if (!ticket) {
        return rpcErr("no_ticket");
    }
    var response = rpcOk({ status: "waiting" });
    try {
        gdMmMutateState(nk, logger, function (st) {
            gdMmProcessQueueCore(st, nk, logger);
            var r = st.results[ticket];
            if (r && r.matchId) {
                delete st.results[ticket];
                response = rpcOk({ status: "matched", match_id: r.matchId });
            }
        });
    }
    catch (e) {
        logger.error("guandan_mm poll storage: %s", String(e));
        return rpcErr("storage_busy");
    }
    return response;
}
function rpcGuandanMmCancel(ctx, logger, nk, payload) {
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
        gdMmMutateState(nk, logger, function (st) {
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
        logger.error("guandan_mm cancel storage: %s", String(e));
        return rpcErr("storage_busy");
    }
    return rpcOk();
}
/**
 * 猫猫杀：牌堆、身份包与装备（简化规则包）。
 * 身份：家猫、同伴猫、野猫、独行猫（数值 0–3）。
 */
/** 家猫（公开身份） */
var MK_ROLE_HOUSE = 0;
/** 同伴猫 */
var MK_ROLE_COMPANION = 1;
/** 野猫 */
var MK_ROLE_WILD = 2;
/** 独行猫 */
var MK_ROLE_LONE = 3;
/** 杀实例 id：0..19 */
var MK_SLASH_MAX = 20;
/** 闪：20..34 */
var MK_JINK_MAX = 35;
/** 桃：35..42 */
var MK_PEACH_MAX = 43;
/** 毛线球（无视距离）；43 */
var MK_EQUIP_YARN_ID = 43;
/** 猫爬架（攻击距离 +1）；44 */
var MK_EQUIP_WEAPON_ID = 44;
function mkRulesCardLabelZh(instanceId) {
    var k = mkRulesCardKey(instanceId);
    if (k === "slash") {
        return "杀";
    }
    if (k === "jink") {
        return "闪";
    }
    if (k === "peach") {
        return "桃";
    }
    if (k === "equip_ball") {
        return "毛线球";
    }
    if (k === "equip_weapon") {
        return "猫爬架";
    }
    return "?";
}
function mkRulesCardKey(instanceId) {
    if (instanceId >= 0 && instanceId < MK_SLASH_MAX) {
        return "slash";
    }
    if (instanceId >= MK_SLASH_MAX && instanceId < MK_JINK_MAX) {
        return "jink";
    }
    if (instanceId >= MK_JINK_MAX && instanceId < MK_PEACH_MAX) {
        return "peach";
    }
    if (instanceId === MK_EQUIP_YARN_ID) {
        return "equip_ball";
    }
    if (instanceId === MK_EQUIP_WEAPON_ID) {
        return "equip_weapon";
    }
    return "unknown";
}
/** 精简牌堆：基本牌 + 少量装备 */
function mkRulesBuildDeck() {
    var d = [];
    var i;
    for (i = 0; i < MK_SLASH_MAX; i++) {
        d.push(i);
    }
    for (i = MK_SLASH_MAX; i < MK_JINK_MAX; i++) {
        d.push(i);
    }
    for (i = MK_JINK_MAX; i < MK_PEACH_MAX; i++) {
        d.push(i);
    }
    d.push(MK_EQUIP_YARN_ID, MK_EQUIP_YARN_ID, MK_EQUIP_WEAPON_ID, MK_EQUIP_WEAPON_ID);
    return d;
}
/** 环上最短距离（无 ±1 马）；攻击范围基础为 1 */
function mkRulesRingDistance(a, b, n) {
    if (n <= 1) {
        return 0;
    }
    var f = (b - a + n) % n;
    var g = (a - b + n) % n;
    return f < g ? f : g;
}
function mkRulesDefaultAttackRange() {
    return 1;
}
function mkRulesEquipIgnoresDistance(instanceId) {
    return mkRulesCardKey(instanceId) === "equip_ball";
}
function mkRulesEquipBonusRange(instanceId) {
    return mkRulesCardKey(instanceId) === "equip_weapon" ? 1 : 0;
}
/** 5人：1家1伴2野1独行；8人：1家2伴4野1独行 */
function mkRulesIdentityPack(playerCount) {
    if (playerCount === 5) {
        return [MK_ROLE_HOUSE, MK_ROLE_COMPANION, MK_ROLE_WILD, MK_ROLE_WILD, MK_ROLE_LONE];
    }
    if (playerCount === 8) {
        return [
            MK_ROLE_HOUSE,
            MK_ROLE_COMPANION,
            MK_ROLE_COMPANION,
            MK_ROLE_WILD,
            MK_ROLE_WILD,
            MK_ROLE_WILD,
            MK_ROLE_WILD,
            MK_ROLE_LONE,
        ];
    }
    var out = [];
    for (var i = 0; i < playerCount; i++) {
        out.push(MK_ROLE_WILD);
    }
    out[0] = MK_ROLE_HOUSE;
    return out;
}
function mkRulesRoleNameZh(role) {
    if (role === MK_ROLE_HOUSE) {
        return "家猫";
    }
    if (role === MK_ROLE_COMPANION) {
        return "同伴猫";
    }
    if (role === MK_ROLE_WILD) {
        return "野猫";
    }
    if (role === MK_ROLE_LONE) {
        return "独行猫";
    }
    return "?";
}
/** 结算展示（与服务端 winner 字段一致） */
function mkRulesWinnerLabelZh(winner) {
    if (winner === "house") {
        return "家猫阵营胜利";
    }
    if (winner === "wild") {
        return "野猫阵营胜利";
    }
    if (winner === "lone") {
        return "独行猫胜利";
    }
    return "";
}
/**
 * 猫猫杀：状态结构、opcode、座位与错误发送。
 */
/** 服务端 → 客户端 */
var MK_OP_SNAPSHOT = 301;
var MK_OP_ERROR = 302;
var MK_REQ_PING = 50;
/** 出牌：{ hand_index, target_seat? } 杀需指定目标 */
var MK_REQ_PLAY_CARD = 52;
/** 对杀出闪：{ use: boolean, hand_index?: number } */
var MK_REQ_RESPOND_JINK = 53;
/** 结束出牌阶段 → 进入弃牌 */
var MK_REQ_END_PLAY = 54;
/** 弃牌：{ hand_indices: number[] } */
var MK_REQ_DISCARD = 55;
/** 濒死使用桃：{ hand_index } */
var MK_REQ_PEACH_DYING = 56;
/** 濒死跳过（不救） */
var MK_REQ_PASS_DYING = 57;
/** 抽取/确认身份（全员确认后发游戏牌） */
var MK_REQ_CONFIRM_IDENTITY = 58;
/** AI 托管：{ on: boolean } */
var MK_REQ_DELEGATE = 59;
/** 抽取/确认猫种（全员确认后发游戏牌） */
var MK_REQ_CONFIRM_BREED = 60;
function mkInitialState() {
    var hands = [[], [], [], [], [], [], [], []];
    return {
        label: "meow_kill",
        seq: 0,
        phase: "waiting",
        playerCount: 5,
        expectHumans: 5,
        aiCount: 0,
        presences: {},
        seatUserIds: ["", "", "", "", "", "", "", ""],
        isAiSeat: [false, false, false, false, false, false, false, false],
        identities: [0, 0, 0, 0, 0, 0, 0, 0],
        identityConfirmed: [false, false, false, false, false, false, false, false],
        breedConfirmed: [false, false, false, false, false, false, false, false],
        breeds: ["", "", "", "", "", "", "", ""],
        pickStage: "identity",
        breedPool: [],
        breedPoolIdx: 0,
        lordSeat: -1,
        equippedWeapon: [-1, -1, -1, -1, -1, -1, -1, -1],
        lastDamageSourceSeat: -1,
        alive: [true, true, true, true, true, false, false, false],
        hp: [4, 4, 4, 4, 4, 0, 0, 0],
        maxHp: [4, 4, 4, 4, 4, 0, 0, 0],
        hands: hands,
        deck: [],
        discard: [],
        turnSeat: -1,
        subPhase: "play",
        shaUsedThisTurn: false,
        pending: null,
        winner: null,
        aiPlayDelayUntilMs: 0,
        eventLog: [],
        aiDelegate: [false, false, false, false, false, false, false, false],
    };
}
/**
 * Nakama 每 tick 将 match state 经 JSON 再注入 goja 时，嵌套的 hands 行有时不是可原地变长的 Array，
 * 对 st.hands[s].push 可能不写入最终持久化对象（表现为 deck 已 pop 但 hand_total 仍为 0）。
 * 在 matchLoop 开头把八行手牌拷贝为普通 number[]。
 */
function mkRepairHandsForRuntime(st) {
    var fresh = [[], [], [], [], [], [], [], []];
    for (var s = 0; s < 8; s++) {
        var h = st.hands[s];
        if (h == null) {
            continue;
        }
        var row = h;
        var len = typeof row.length === "number" ? row.length : 0;
        for (var i = 0; i < len; i++) {
            fresh[s].push(Math.floor(Number(row[i])));
        }
    }
    st.hands = fresh;
}
/** 是否存在阻塞出牌/结束阶段的询问（闪、濒死）。空对象 {} 在 JSON 回灌后可能被当成 truthy，不得视为有效 pending。 */
function mkPendingIsActive(st) {
    var p = st.pending;
    if (p === null || p === undefined) {
        return false;
    }
    if (typeof p !== "object") {
        return false;
    }
    var o = p;
    if (o.kind === "jink" || o.kind === "dying") {
        return true;
    }
    return false;
}
/** 每 tick 清理无效的 pending，避免 AI/人类被卡死。 */
function mkSanitizePending(st) {
    var p = st.pending;
    if (p === null || p === undefined) {
        st.pending = null;
        return;
    }
    if (typeof p !== "object") {
        st.pending = null;
        return;
    }
    var o = p;
    if (o.kind !== "jink" && o.kind !== "dying") {
        st.pending = null;
        return;
    }
    if (o.kind === "jink") {
        var j = p;
        if (typeof j.attacker !== "number" || typeof j.victim !== "number") {
            st.pending = null;
        }
        return;
    }
    var d = p;
    if (typeof d.seat !== "number" || typeof d.askIdx !== "number" || !Array.isArray(d.askOrder)) {
        st.pending = null;
    }
}
function mkRepairMkAuxFields(st) {
    if (typeof st.aiPlayDelayUntilMs !== "number" || isNaN(st.aiPlayDelayUntilMs)) {
        st.aiPlayDelayUntilMs = 0;
    }
    if (!st.eventLog || !Array.isArray(st.eventLog)) {
        st.eventLog = [];
    }
    if (!st.equippedWeapon || !Array.isArray(st.equippedWeapon)) {
        st.equippedWeapon = [-1, -1, -1, -1, -1, -1, -1, -1];
    }
    else {
        while (st.equippedWeapon.length < 8) {
            st.equippedWeapon.push(-1);
        }
    }
    if (typeof st.lastDamageSourceSeat !== "number" || isNaN(st.lastDamageSourceSeat)) {
        st.lastDamageSourceSeat = -1;
    }
    if (!st.aiDelegate || !Array.isArray(st.aiDelegate)) {
        st.aiDelegate = [false, false, false, false, false, false, false, false];
    }
    else {
        while (st.aiDelegate.length < 8) {
            st.aiDelegate.push(false);
        }
    }
    if (!st.breedConfirmed || !Array.isArray(st.breedConfirmed)) {
        st.breedConfirmed = [false, false, false, false, false, false, false, false];
    }
    else {
        while (st.breedConfirmed.length < 8) {
            st.breedConfirmed.push(false);
        }
    }
    if (!st.breeds || !Array.isArray(st.breeds)) {
        st.breeds = ["", "", "", "", "", "", "", ""];
    }
    else {
        while (st.breeds.length < 8) {
            st.breeds.push("");
        }
    }
    if (st.pickStage !== "identity" && st.pickStage !== "breed") {
        st.pickStage = "identity";
    }
    if (!st.breedPool || !Array.isArray(st.breedPool)) {
        st.breedPool = [];
    }
    if (typeof st.breedPoolIdx !== "number" || isNaN(st.breedPoolIdx)) {
        st.breedPoolIdx = 0;
    }
}
function mkConfigureTableSize(st, n) {
    st.playerCount = n === 8 ? 8 : 5;
    for (var s = 0; s < 8; s++) {
        if (s < st.playerCount) {
            st.alive[s] = true;
            st.hp[s] = 4;
            st.maxHp[s] = 4;
            st.hands[s] = [];
            st.equippedWeapon[s] = -1;
            st.identityConfirmed[s] = false;
            st.breedConfirmed[s] = false;
            st.breeds[s] = "";
            st.aiDelegate[s] = false;
        }
        else {
            st.alive[s] = false;
            st.hp[s] = 0;
            st.maxHp[s] = 0;
            st.hands[s] = [];
            st.seatUserIds[s] = "";
            st.isAiSeat[s] = false;
            st.identityConfirmed[s] = false;
            st.breedConfirmed[s] = false;
            st.breeds[s] = "";
            st.aiDelegate[s] = false;
        }
    }
}
/** 真人占 0..expectHumans-1；expectHumans..playerCount-1 为 AI */
function mkAssignSeats(st) {
    var ids = [];
    for (var k in st.presences) {
        if (st.presences.hasOwnProperty(k)) {
            ids.push(k);
        }
    }
    ids.sort();
    var eh = Math.max(0, Math.min(st.playerCount, st.expectHumans));
    for (var s = 0; s < 8; s++) {
        st.seatUserIds[s] = "";
        st.isAiSeat[s] = false;
    }
    for (var i = 0; i < ids.length && i < eh; i++) {
        st.seatUserIds[i] = ids[i];
    }
    for (var s = eh; s < st.playerCount; s++) {
        st.isAiSeat[s] = true;
    }
}
function mkSendError(dispatcher, logger, st, presence, code) {
    try {
        dispatcher.broadcastMessage(MK_OP_ERROR, JSON.stringify({ seq: st.seq, error: code }), [presence], null);
    }
    catch (e) {
        logger.error("meow_kill send err: %s", String(e));
    }
}
function mkSeatForUser(st, userId) {
    for (var s = 0; s < st.playerCount; s++) {
        if (st.seatUserIds[s] === userId) {
            return s;
        }
    }
    return -1;
}
function mkDecodeMatchData(data) {
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
    var s = "";
    for (var i = 0; i < u8.length; i++) {
        s += String.fromCharCode(u8[i]);
    }
    return s;
}
/**
 * 猫猫杀牌手 AI（全信息）：家猫/同伴 vs 野猫 vs 独行猫目标不同。
 */
function mkAiAliveCount(st) {
    var c = 0;
    for (var s = 0; s < st.playerCount; s++) {
        if (st.alive[s]) {
            c++;
        }
    }
    return c;
}
/** 存活野猫人数 */
function mkAiAliveWildCount(st) {
    var c = 0;
    for (var s = 0; s < st.playerCount; s++) {
        if (st.alive[s] && st.identities[s] === MK_ROLE_WILD) {
            c++;
        }
    }
    return c;
}
function mkAiIsHouseFaction(role) {
    return role === MK_ROLE_HOUSE || role === MK_ROLE_COMPANION;
}
/** 独行猫「伪装」阶段：场上仍有野猫时假装同伴压制野猫 */
function mkAiLoneHideAgainstWild(st) {
    return mkAiAliveWildCount(st) > 0;
}
function mkAiIsEnemy(st, selfSeat, otherSeat) {
    var rs = st.identities[selfSeat];
    var ro = st.identities[otherSeat];
    if (mkAiIsHouseFaction(rs)) {
        return ro === MK_ROLE_WILD || ro === MK_ROLE_LONE;
    }
    if (rs === MK_ROLE_WILD) {
        return mkAiIsHouseFaction(ro) || ro === MK_ROLE_LONE;
    }
    if (rs === MK_ROLE_LONE) {
        if (mkAiLoneHideAgainstWild(st)) {
            return ro === MK_ROLE_WILD;
        }
        return mkAiIsHouseFaction(ro) || ro === MK_ROLE_WILD;
    }
    return true;
}
/**
 * 出杀目标优先级（越高越优先）。
 */
function mkAiEnemyScore(st, attackerSeat, targetSeat) {
    var me = st.identities[attackerSeat];
    var them = st.identities[targetSeat];
    var thp = st.hp[targetSeat];
    if (mkAiIsHouseFaction(me)) {
        if (them === MK_ROLE_WILD) {
            return 100 + (8 - thp) * 3;
        }
        if (them === MK_ROLE_LONE) {
            return 92 + (8 - thp) * 3;
        }
        return -200;
    }
    if (me === MK_ROLE_WILD) {
        if (them === MK_ROLE_HOUSE) {
            return 115 + (8 - thp) * 4;
        }
        if (them === MK_ROLE_COMPANION) {
            return 78 + (8 - thp) * 3;
        }
        if (them === MK_ROLE_LONE) {
            return 42 + (8 - thp);
        }
        return -200;
    }
    if (me === MK_ROLE_LONE) {
        if (mkAiLoneHideAgainstWild(st)) {
            if (them === MK_ROLE_WILD) {
                return 98 + (8 - thp) * 3;
            }
            if (them === MK_ROLE_COMPANION) {
                return 25;
            }
            if (them === MK_ROLE_HOUSE) {
                return -260;
            }
            return -200;
        }
        if (them === MK_ROLE_HOUSE) {
            return 108 + (8 - thp) * 4;
        }
        if (them === MK_ROLE_COMPANION) {
            return 88 + (8 - thp) * 3;
        }
        if (them === MK_ROLE_WILD) {
            return 48 + (8 - thp);
        }
        return -200;
    }
    return 0;
}
function mkAiPickSlashTarget(st, seat) {
    var n = st.playerCount;
    var bestT = -1;
    var bestScore = -1;
    var bestHp = 99;
    for (var t = 0; t < n; t++) {
        if (t === seat || !st.alive[t]) {
            continue;
        }
        if (!mkMkAttackRangeOk(st, seat, t)) {
            continue;
        }
        var sc = mkAiEnemyScore(st, seat, t);
        if (sc <= 0) {
            continue;
        }
        var thp = st.hp[t];
        if (sc > bestScore || (sc === bestScore && thp < bestHp)) {
            bestScore = sc;
            bestHp = thp;
            bestT = t;
        }
    }
    return bestT;
}
function mkAiFindFirstCardIndex(st, seat, key) {
    var hand = st.hands[seat];
    for (var i = 0; i < hand.length; i++) {
        if (mkRulesCardKey(hand[i]) === key) {
            return i;
        }
    }
    return -1;
}
function mkAiShouldUseJink(st, victimSeat) {
    if (st.pending === null || st.pending.kind !== "jink") {
        return false;
    }
    var hand = st.hands[victimSeat];
    var hasJink = false;
    for (var i = 0; i < hand.length; i++) {
        if (mkRulesCardKey(hand[i]) === "jink") {
            hasJink = true;
            break;
        }
    }
    if (!hasJink) {
        return false;
    }
    var attacker = st.pending.attacker;
    if (st.hp[victimSeat] <= 1) {
        return true;
    }
    return mkAiIsEnemy(st, victimSeat, attacker);
}
function mkAiShouldPeachVictim(st, saverSeat, victimSeat) {
    if (saverSeat === victimSeat) {
        return true;
    }
    var rs = st.identities[saverSeat];
    var rv = st.identities[victimSeat];
    if (rs === MK_ROLE_LONE) {
        if (rv === MK_ROLE_HOUSE) {
            return mkAiAliveCount(st) > 2;
        }
        if (mkAiIsHouseFaction(rv) || rv === MK_ROLE_WILD) {
            return false;
        }
    }
    return !mkAiIsEnemy(st, saverSeat, victimSeat);
}
function mkAiDiscardCardRank(st, seat, instanceId) {
    var k = mkRulesCardKey(instanceId);
    var me = st.identities[seat];
    if (k === "slash") {
        if (me === MK_ROLE_WILD && mkAiAliveWildCount(st) > 0) {
            return 2;
        }
        return 0;
    }
    if (k === "jink") {
        return 1;
    }
    if (k === "peach") {
        return 4;
    }
    if (k === "equip_ball" || k === "equip_weapon") {
        return 3;
    }
    return 3;
}
/** 弃置 excess 张：优先弃低价值牌 */
function mkAiPickDiscardIndices(st, seat) {
    var hand = st.hands[seat];
    var need = hand.length - st.hp[seat];
    if (need <= 0) {
        return [];
    }
    var scored = [];
    for (var i = 0; i < hand.length; i++) {
        scored.push({ idx: i, rank: mkAiDiscardCardRank(st, seat, hand[i]) });
    }
    scored.sort(function (a, b) {
        if (a.rank !== b.rank) {
            return a.rank - b.rank;
        }
        return b.idx - a.idx;
    });
    var out = [];
    for (var j = 0; j < need && j < scored.length; j++) {
        out.push(scored[j].idx);
    }
    out.sort(function (a, b) {
        return b - a;
    });
    return out;
}
/**
 * 猫猫杀：发牌、回合、杀闪桃、濒死、胜负、广播（白板 4 血、无装备无武将技能）。
 */
var MK_AI_PLAY_PACE_MS = 750;
var MK_EVENT_LOG_MAX = 48;
function mkPushEvent(st, line) {
    if (!st.eventLog || !Array.isArray(st.eventLog)) {
        st.eventLog = [];
    }
    st.eventLog.push(line);
    while (st.eventLog.length > MK_EVENT_LOG_MAX) {
        st.eventLog.shift();
    }
}
function mkSeatDisplayName(st, seat) {
    if (seat < 0 || seat >= st.playerCount) {
        return "?";
    }
    if (st.isAiSeat[seat] === true) {
        return "座" + seat + "·牌手";
    }
    var uid = st.seatUserIds[seat] || "";
    if (uid && st.presences[uid]) {
        var u = st.presences[uid].username || "";
        if (u && u.length > 0) {
            return "座" + seat + "·" + u;
        }
    }
    return "座" + seat;
}
/** AI 逻辑座位：原生 AI 或真人托管 */
function mkSeatActsAsAi(st, seat) {
    if (seat < 0 || seat >= st.playerCount) {
        return false;
    }
    return st.isAiSeat[seat] === true || st.aiDelegate[seat] === true;
}
var MK_BREED_POOL_8 = [
    "breed_white",
    "breed_ragdoll",
    "breed_orange",
    "breed_british_shorthair",
    "breed_black",
    "breed_siamese",
    "breed_tabby",
    "breed_sphynx",
];
function mkBreedNameZh(stem) {
    if (stem === "breed_white")
        return "白猫";
    if (stem === "breed_ragdoll")
        return "布偶猫";
    if (stem === "breed_orange")
        return "橘猫";
    if (stem === "breed_british_shorthair")
        return "英短";
    if (stem === "breed_black")
        return "黑猫";
    if (stem === "breed_siamese")
        return "暹罗猫";
    if (stem === "breed_tabby")
        return "狸花猫";
    if (stem === "breed_sphynx")
        return "无毛猫";
    return "猫咪";
}
function mkPrepareBreedPool(st, nk) {
    var pool = MK_BREED_POOL_8.slice();
    for (var i = pool.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = pool[i];
        pool[i] = pool[j];
        pool[j] = t;
    }
    st.breedPool = pool;
    st.breedPoolIdx = 0;
}
function mkAssignBreedIfNeeded(st, seat) {
    if (st.breeds[seat] && st.breeds[seat].length > 0) {
        return st.breeds[seat];
    }
    if (st.breedPoolIdx < 0) {
        st.breedPoolIdx = 0;
    }
    if (st.breedPoolIdx >= st.breedPool.length) {
        return "";
    }
    var g = st.breedPool[st.breedPoolIdx] || "";
    st.breedPoolIdx++;
    st.breeds[seat] = g;
    return g;
}
function mkConfirmAllAiBreeds(st) {
    if (st.pickStage !== "breed") {
        return false;
    }
    var anyHumanPicked = false;
    var humanSeats = 0;
    for (var s = 0; s < st.playerCount; s++) {
        if (!mkSeatActsAsAi(st, s)) {
            humanSeats++;
            if (st.breedConfirmed[s]) {
                anyHumanPicked = true;
            }
        }
    }
    if (humanSeats > 0 && !anyHumanPicked) {
        return false;
    }
    var changed = false;
    for (var s = 0; s < st.playerCount; s++) {
        if (mkSeatActsAsAi(st, s) && !st.breedConfirmed[s]) {
            var g = mkAssignBreedIfNeeded(st, s);
            st.breedConfirmed[s] = true;
            mkPushEvent(st, mkSeatDisplayName(st, s) + " 已抽取猫种：" + mkBreedNameZh(g));
            changed = true;
        }
    }
    return changed;
}
/** 杀可达（毛线球无视距离；猫爬架 +1） */
function mkMkAttackRangeOk(st, attacker, target) {
    var dist = mkRulesRingDistance(attacker, target, st.playerCount);
    var ew = st.equippedWeapon[attacker];
    if (ew >= 0 && mkRulesEquipIgnoresDistance(ew)) {
        return true;
    }
    var rng = mkRulesDefaultAttackRange();
    if (ew >= 0) {
        rng += mkRulesEquipBonusRange(ew);
    }
    return dist <= rng;
}
/** 人类出牌 / AI 出牌后统一节拍，避免 AI 同一帧连动 */
function mkBumpPlayPaceDeadline(st) {
    st.aiPlayDelayUntilMs = Date.now() + MK_AI_PLAY_PACE_MS;
}
function mkBroadcastState(dispatcher, st, logger, reason) {
    st.seq++;
    var base = mkBuildSnapshotBase(st);
    var presList = [];
    for (var uid in st.presences) {
        if (st.presences.hasOwnProperty(uid)) {
            presList.push(st.presences[uid]);
        }
    }
    for (var i = 0; i < presList.length; i++) {
        var p = presList[i];
        var seat = mkSeatForUser(st, p.userId);
        var packet = {};
        for (var k in base) {
            if (base.hasOwnProperty(k)) {
                packet[k] = base[k];
            }
        }
        packet["self_seat"] = seat;
        var handSlice = seat >= 0 && seat < st.playerCount ? st.hands[seat].slice() : [];
        packet["self_hand"] = handSlice.map(function (cid) {
            return Math.floor(cid);
        });
        packet["self_hand_count"] = handSlice.length;
        if (st.phase === "picking_identity" && seat >= 0 && seat < st.playerCount) {
            packet["self_role"] = st.identities[seat];
        }
        else {
            packet["self_role"] =
                seat >= 0 && seat < st.playerCount && st.identityConfirmed[seat] === true
                    ? st.identities[seat]
                    : -1;
        }
        packet["self_general_id"] =
            seat >= 0 && seat < st.playerCount && st.breedConfirmed[seat] === true ? st.breeds[seat] : "";
        if (seat < 0) {
            logger.warn("meow_kill broadcast: no seat for userId=%s reason=%s", p.userId, reason);
        }
        try {
            dispatcher.broadcastMessage(MK_OP_SNAPSHOT, JSON.stringify(packet), [p], null);
        }
        catch (e) {
            logger.warn("meow_kill broadcast to %s failed: %s", p.userId, String(e));
        }
    }
    if (presList.length === 0) {
        var packet = {};
        for (var k in base) {
            if (base.hasOwnProperty(k)) {
                packet[k] = base[k];
            }
        }
        packet["self_seat"] = -1;
        packet["self_hand"] = [];
        packet["self_hand_count"] = 0;
        packet["self_role"] = -1;
        packet["self_general_id"] = "";
        try {
            dispatcher.broadcastMessage(MK_OP_SNAPSHOT, JSON.stringify(packet), null, null);
        }
        catch (e) {
            logger.warn("meow_kill broadcast (no presence) failed: %s", String(e));
        }
    }
    logger.debug("meow_kill snapshot seq=%d reason=%s", st.seq, reason);
}
function mkPublicRoleForSeat(st, seat) {
    if (seat < 0 || seat >= st.playerCount) {
        return null;
    }
    if (st.phase === "picking_identity") {
        return null;
    }
    if (st.phase === "finished") {
        return st.identities[seat];
    }
    if (!st.alive[seat]) {
        return st.identities[seat];
    }
    if (seat === st.lordSeat) {
        return MK_ROLE_HOUSE;
    }
    return null;
}
function mkBuildSnapshotBase(st) {
    var seatsLobby = [];
    for (var s = 0; s < st.playerCount; s++) {
        var uid = st.seatUserIds[s] || "";
        var username = "";
        if (uid && st.presences[uid]) {
            username = st.presences[uid].username || "";
        }
        var isAi = st.isAiSeat[s] === true;
        if (isAi && username === "") {
            username = "牌手";
        }
        seatsLobby.push({ seat: s, user_id: uid, username: username, is_ai: isAi });
    }
    var idConf = [];
    for (var s = 0; s < st.playerCount; s++) {
        idConf.push(st.identityConfirmed[s] === true);
    }
    var players = [];
    for (var s = 0; s < st.playerCount; s++) {
        var rp = mkPublicRoleForSeat(st, s);
        players.push({
            seat: s,
            hp: st.hp[s],
            max_hp: st.maxHp[s],
            alive: st.alive[s],
            hand_count: st.hands[s].length,
            equipped_weapon: st.equippedWeapon[s],
            role_public: rp,
            identity_confirmed: st.identityConfirmed[s] === true,
            breed_confirmed: st.breedConfirmed[s] === true,
            general_id: st.breedConfirmed[s] === true ? st.breeds[s] : "",
            general_name: st.breedConfirmed[s] === true && st.breeds[s] ? mkBreedNameZh(st.breeds[s]) : "",
            is_ai: st.isAiSeat[s],
            user_id: st.seatUserIds[s] || "",
            username: seatsLobby[s].username,
        });
    }
    return {
        v: 2,
        seq: st.seq,
        phase: st.phase,
        player_count: st.playerCount,
        expect_humans: st.expectHumans,
        ai_count: st.aiCount,
        seats: seatsLobby,
        players: players,
        identity_confirmed: idConf,
        pick_stage: st.pickStage,
        lord_seat: st.phase === "picking_identity" ? -1 : st.lordSeat,
        turn_seat: st.turnSeat,
        sub_phase: st.subPhase,
        sha_used: st.shaUsedThisTurn,
        pending: st.pending,
        winner: st.winner,
        winner_label_zh: mkRulesWinnerLabelZh(st.winner),
        roles_fully_revealed: st.phase === "finished",
        deck_count: st.deck.length,
        discard_count: st.discard.length,
        event_log: st.eventLog.slice(),
        ai_delegate: (function () {
            var ad = [];
            for (var s = 0; s < st.playerCount; s++) {
                ad.push(st.aiDelegate[s] === true);
            }
            return ad;
        })(),
    };
}
function mkReshuffleDeckFromDiscard(st, nk) {
    if (st.discard.length === 0) {
        return;
    }
    st.deck = st.discard.slice();
    st.discard = [];
    shuffleInPlace(nk, st.deck);
}
function mkDrawForSeat(st, nk, seat, count) {
    var row = st.hands[seat];
    var next = [];
    for (var i = 0; i < row.length; i++) {
        next.push(Math.floor(Number(row[i])));
    }
    for (var i = 0; i < count; i++) {
        if (st.deck.length === 0) {
            mkReshuffleDeckFromDiscard(st, nk);
        }
        if (st.deck.length === 0) {
            break;
        }
        var c = st.deck.pop();
        if (c !== undefined) {
            next.push(Math.floor(Number(c)));
        }
    }
    st.hands[seat] = next;
}
function mkBeginTurn(st, nk) {
    st.subPhase = "play";
    st.shaUsedThisTurn = false;
    mkDrawForSeat(st, nk, st.turnSeat, 2);
    mkPushEvent(st, mkSeatDisplayName(st, st.turnSeat) + " 摸牌阶段：摸 2 张");
}
/** 三国杀流程：洗牌发身份 → 全员「抽取/确认」身份 → 再发游戏牌并主公先动（起始 4 张 + 主公摸牌阶段 2 张）。 */
function mkBeginIdentityPhase(st, nk, dispatcher, logger) {
    if (st.phase !== "lobby") {
        return;
    }
    var n = st.playerCount;
    var pack = mkRulesIdentityPack(n);
    var perm = [];
    for (var i = 0; i < n; i++) {
        perm.push(i);
    }
    shuffleInPlace(nk, perm);
    for (var s = 0; s < n; s++) {
        st.identities[s] = pack[perm[s]];
        st.identityConfirmed[s] = false;
        st.alive[s] = true;
        st.hp[s] = 4;
        st.maxHp[s] = 4;
        st.equippedWeapon[s] = -1;
        st.hands[s] = [];
    }
    st.lordSeat = -1;
    for (var s = 0; s < n; s++) {
        if (st.identities[s] === MK_ROLE_HOUSE) {
            st.lordSeat = s;
            break;
        }
    }
    if (st.lordSeat >= 0 && st.lordSeat < n) {
        st.maxHp[st.lordSeat] = 5;
        st.hp[st.lordSeat] = 5;
    }
    st.deck = [];
    st.discard = [];
    st.pending = null;
    st.winner = null;
    st.turnSeat = -1;
    st.shaUsedThisTurn = false;
    st.subPhase = "play";
    st.phase = "picking_identity";
    st.pickStage = "identity";
    mkPrepareBreedPool(st, nk);
    st.breedPoolIdx = 0;
    st.eventLog = [];
    st.aiPlayDelayUntilMs = 0;
    for (var s = 0; s < n; s++) {
        st.breedConfirmed[s] = false;
        st.breeds[s] = "";
    }
    mkPushEvent(st, "请在桌面中央先抽取身份牌并确认。");
    mkBroadcastState(dispatcher, st, logger, "identity-phase");
}
function mkBeginDealAndFirstTurn(st, nk, dispatcher, logger) {
    var n = st.playerCount;
    st.deck = mkRulesBuildDeck();
    shuffleInPlace(nk, st.deck);
    st.discard = [];
    for (var s = 0; s < n; s++) {
        mkDrawForSeat(st, nk, s, 4);
    }
    mkPushEvent(st, "发起始手牌：每名角色摸 4 张");
    st.phase = "playing";
    st.pending = null;
    st.winner = null;
    st.turnSeat = st.lordSeat >= 0 ? st.lordSeat : 0;
    mkBeginTurn(st, nk);
    var handTotal = 0;
    for (var s = 0; s < n; s++) {
        handTotal += st.hands[s].length;
    }
    logger.info("meow_kill deal-start: n=%d deck_left=%d hand_total=%d lord=%d turn=%d", n, st.deck.length, handTotal, st.lordSeat, st.turnSeat);
    mkBroadcastState(dispatcher, st, logger, "deal-start");
    if (st.turnSeat >= 0 && st.turnSeat < st.playerCount && mkSeatActsAsAi(st, st.turnSeat)) {
        mkBumpPlayPaceDeadline(st);
    }
}
function mkTryAdvanceFromIdentityPhase(st, nk, dispatcher, logger) {
    if (st.phase !== "picking_identity") {
        return;
    }
    if (st.pickStage === "identity") {
        for (var s = 0; s < st.playerCount; s++) {
            if (!st.identityConfirmed[s]) {
                return;
            }
        }
        st.pickStage = "breed";
        mkPushEvent(st, "身份确认完成，请抽取猫咪种类。");
        mkBroadcastState(dispatcher, st, logger, "pick-breed-stage");
        return;
    }
    for (var s = 0; s < st.playerCount; s++) {
        if (!st.breedConfirmed[s]) {
            return;
        }
    }
    mkBeginDealAndFirstTurn(st, nk, dispatcher, logger);
}
function mkConfirmAllAiIdentities(st) {
    if (st.pickStage !== "identity") {
        return false;
    }
    var changed = false;
    for (var s = 0; s < st.playerCount; s++) {
        if ((st.isAiSeat[s] || st.aiDelegate[s]) && !st.identityConfirmed[s]) {
            st.identityConfirmed[s] = true;
            mkPushEvent(st, mkSeatDisplayName(st, s) + " 已确认身份");
            changed = true;
        }
    }
    return changed;
}
function mkApplyConfirmIdentity(st, seat) {
    if (st.phase !== "picking_identity") {
        return "bad_phase";
    }
    if (st.pickStage !== "identity") {
        return "bad_pick_stage";
    }
    if (seat < 0 || seat >= st.playerCount) {
        return "bad_seat";
    }
    if (st.identityConfirmed[seat]) {
        return "already_confirmed";
    }
    st.identityConfirmed[seat] = true;
    mkPushEvent(st, mkSeatDisplayName(st, seat) + " 已确认身份");
    return null;
}
function mkApplyConfirmBreed(st, seat) {
    if (st.phase !== "picking_identity") {
        return "bad_phase";
    }
    if (st.pickStage !== "breed") {
        return "bad_pick_stage";
    }
    if (seat < 0 || seat >= st.playerCount) {
        return "bad_seat";
    }
    if (st.breedConfirmed[seat]) {
        return "already_confirmed";
    }
    var g = mkAssignBreedIfNeeded(st, seat);
    if (!g) {
        return "no_breed_left";
    }
    st.breedConfirmed[seat] = true;
    mkPushEvent(st, mkSeatDisplayName(st, seat) + " 已抽取猫种：" + mkBreedNameZh(g));
    return null;
}
function mkApplyDelegate(st, seat, on) {
    if (seat < 0 || seat >= st.playerCount) {
        return "bad_seat";
    }
    if (st.isAiSeat[seat]) {
        return "ai_seat_no_delegate";
    }
    st.aiDelegate[seat] = on;
    mkPushEvent(st, mkSeatDisplayName(st, seat) + (on ? " 开启 AI 托管" : " 取消 AI 托管"));
    return null;
}
function mkAdvanceTurn(st, nk) {
    var n = st.playerCount;
    var s = st.turnSeat;
    for (var k = 0; k < n + 2; k++) {
        s = (s + 1) % n;
        if (st.alive[s]) {
            st.turnSeat = s;
            mkBeginTurn(st, nk);
            return;
        }
    }
}
function mkCheckWin(st, lastVictim, killerSeat) {
    if (st.phase === "finished") {
        return;
    }
    var n = st.playerCount;
    if (st.lordSeat >= 0 && !st.alive[st.lordSeat]) {
        var wildAlive = false;
        for (var s = 0; s < n; s++) {
            if (st.alive[s] && st.identities[s] === MK_ROLE_WILD) {
                wildAlive = true;
                break;
            }
        }
        if (wildAlive) {
            st.winner = "wild";
        }
        else if (killerSeat >= 0 &&
            killerSeat < n &&
            st.identities[killerSeat] === MK_ROLE_LONE &&
            lastVictim === st.lordSeat) {
            st.winner = "lone";
        }
        else {
            st.winner = "wild";
        }
        st.phase = "finished";
        st.pending = null;
        mkPushEvent(st, "游戏结束：" + mkRulesWinnerLabelZh(st.winner));
        return;
    }
    var foeAlive = false;
    for (var s = 0; s < n; s++) {
        if (!st.alive[s]) {
            continue;
        }
        var r = st.identities[s];
        if (r === MK_ROLE_WILD || r === MK_ROLE_LONE) {
            foeAlive = true;
            break;
        }
    }
    if (!foeAlive) {
        st.winner = "house";
        st.phase = "finished";
        st.pending = null;
        mkPushEvent(st, "游戏结束：" + mkRulesWinnerLabelZh(st.winner));
    }
}
function mkResolveDeath(st, seat, nk) {
    var killerSeat = st.lastDamageSourceSeat;
    st.pending = null;
    mkPushEvent(st, mkSeatDisplayName(st, seat) + " 阵亡，身份：" + mkRulesRoleNameZh(st.identities[seat]));
    for (var i = 0; i < st.hands[seat].length; i++) {
        st.discard.push(st.hands[seat][i]);
    }
    st.hands[seat] = [];
    if (st.equippedWeapon[seat] >= 0) {
        st.discard.push(st.equippedWeapon[seat]);
        st.equippedWeapon[seat] = -1;
    }
    st.alive[seat] = false;
    st.hp[seat] = 0;
    mkCheckWin(st, seat, killerSeat);
    if (st.phase === "playing" && st.winner === null) {
        var ts = st.turnSeat;
        if (ts < 0 || ts >= st.playerCount || !st.alive[ts]) {
            mkAdvanceTurn(st, nk);
        }
    }
}
/** 濒死求桃：从当前回合角色起按行动顺序询问（含濒死者本人在轮到其顺序时可自救）。 */
function mkDyingAskOrder(st, _victim) {
    var n = st.playerCount;
    var out = [];
    var start = st.turnSeat >= 0 && st.turnSeat < n ? st.turnSeat : 0;
    for (var k = 0; k < n; k++) {
        var s = (start + k) % n;
        if (st.alive[s]) {
            out.push(s);
        }
    }
    return out;
}
function mkStartDying(st, victim, nk) {
    if (st.hp[victim] > 0) {
        return;
    }
    var order = mkDyingAskOrder(st, victim);
    if (order.length === 0) {
        mkResolveDeath(st, victim, nk);
        return;
    }
    st.pending = { kind: "dying", seat: victim, askIdx: 0, askOrder: order };
    mkPushEvent(st, mkSeatDisplayName(st, victim) + " 濒死（依次询问是否出桃）");
}
function mkApplyDamage(st, victim, source, nk) {
    st.lastDamageSourceSeat = source;
    st.hp[victim]--;
    if (st.hp[victim] < 0) {
        st.hp[victim] = 0;
    }
    if (st.hp[victim] <= 0) {
        mkStartDying(st, victim, nk);
    }
}
function mkApplyPlayCard(st, seat, handIndex, targetSeat, nk) {
    if (st.phase !== "playing" || st.winner) {
        return "bad_phase";
    }
    if (mkPendingIsActive(st)) {
        return "pending_response";
    }
    if (seat !== st.turnSeat || st.subPhase !== "play") {
        return "not_your_turn";
    }
    var hand = st.hands[seat];
    if (handIndex < 0 || handIndex >= hand.length) {
        return "bad_hand_index";
    }
    var cid = hand[handIndex];
    var key = mkRulesCardKey(cid);
    if (key === "peach") {
        if (st.hp[seat] >= st.maxHp[seat]) {
            return "peach_full_hp";
        }
        hand.splice(handIndex, 1);
        st.discard.push(cid);
        st.hp[seat]++;
        mkPushEvent(st, mkSeatDisplayName(st, seat) + " 使用「" + mkRulesCardLabelZh(cid) + "」，回复 1 体力");
        return null;
    }
    if (key === "equip_ball" || key === "equip_weapon") {
        hand.splice(handIndex, 1);
        var prev = st.equippedWeapon[seat];
        if (prev >= 0) {
            st.discard.push(prev);
        }
        st.equippedWeapon[seat] = cid;
        mkPushEvent(st, mkSeatDisplayName(st, seat) + " 装备了「" + mkRulesCardLabelZh(cid) + "」");
        return null;
    }
    if (key === "slash") {
        if (st.shaUsedThisTurn) {
            return "sha_already_used";
        }
        if (targetSeat < 0 || targetSeat >= st.playerCount || !st.alive[targetSeat]) {
            return "bad_target";
        }
        if (targetSeat === seat) {
            return "cannot_target_self";
        }
        if (!mkMkAttackRangeOk(st, seat, targetSeat)) {
            return "out_of_range";
        }
        hand.splice(handIndex, 1);
        st.discard.push(cid);
        st.shaUsedThisTurn = true;
        st.pending = { kind: "jink", attacker: seat, victim: targetSeat, card_id: cid };
        mkPushEvent(st, mkSeatDisplayName(st, seat) +
            " 使用「杀」→ " +
            mkSeatDisplayName(st, targetSeat));
        return null;
    }
    return "card_not_playable";
}
function mkApplyRespondJink(st, victimSeat, use, handIndex, nk) {
    if (st.pending === null || st.pending.kind !== "jink") {
        return "no_pending_jink";
    }
    if (st.pending.victim !== victimSeat) {
        return "not_jink_responder";
    }
    var attacker = st.pending.attacker;
    var victim = st.pending.victim;
    if (!use) {
        st.pending = null;
        mkPushEvent(st, mkSeatDisplayName(st, victim) + " 未出闪，受到 1 点伤害");
        mkApplyDamage(st, victim, attacker, nk);
        return null;
    }
    var hand = st.hands[victimSeat];
    if (handIndex < 0 || handIndex >= hand.length) {
        return "bad_hand_index";
    }
    var cid = hand[handIndex];
    if (mkRulesCardKey(cid) !== "jink") {
        return "need_jink";
    }
    hand.splice(handIndex, 1);
    st.discard.push(cid);
    st.pending = null;
    mkPushEvent(st, mkSeatDisplayName(st, victimSeat) + " 使用「闪」抵消");
    return null;
}
function mkApplyEndPlay(st, seat, nk) {
    if (st.phase !== "playing" || st.winner) {
        return "bad_phase";
    }
    if (mkPendingIsActive(st)) {
        return "pending_response";
    }
    if (seat !== st.turnSeat || st.subPhase !== "play") {
        return "not_your_turn";
    }
    if (st.hands[seat].length <= st.hp[seat]) {
        mkPushEvent(st, mkSeatDisplayName(st, seat) + " 结束出牌阶段（无需弃牌）");
        mkAdvanceTurn(st, nk);
        return null;
    }
    mkPushEvent(st, mkSeatDisplayName(st, seat) + " 结束出牌阶段 → 弃牌阶段");
    st.subPhase = "discard";
    return null;
}
function mkApplyDiscard(st, seat, indices, nk) {
    if (st.phase !== "playing" || st.winner) {
        return "bad_phase";
    }
    if (seat !== st.turnSeat || st.subPhase !== "discard") {
        return "not_discard_phase";
    }
    var hand = st.hands[seat];
    var sorted = indices.slice().sort(function (a, b) {
        return b - a;
    });
    for (var i = 0; i < sorted.length; i++) {
        var idx = sorted[i];
        if (idx < 0 || idx >= hand.length) {
            return "bad_hand_index";
        }
    }
    var parts = [];
    for (var i = 0; i < sorted.length; i++) {
        var idx = sorted[i];
        parts.push(mkRulesCardLabelZh(hand[idx]));
    }
    for (var i = 0; i < sorted.length; i++) {
        var idx = sorted[i];
        var c = hand[idx];
        hand.splice(idx, 1);
        st.discard.push(c);
    }
    mkPushEvent(st, mkSeatDisplayName(st, seat) + " 弃牌阶段：弃置 " + parts.join("、"));
    if (st.hands[seat].length <= st.hp[seat]) {
        st.subPhase = "play";
        mkAdvanceTurn(st, nk);
        return null;
    }
    return null;
}
function mkApplyPeachDying(st, fromSeat, handIndex) {
    if (st.pending === null || st.pending.kind !== "dying") {
        return "no_pending_dying";
    }
    var p = st.pending;
    if (p.askIdx >= p.askOrder.length) {
        return "dying_done";
    }
    if (p.askOrder[p.askIdx] !== fromSeat) {
        return "not_your_turn_save";
    }
    var victim = p.seat;
    var hand = st.hands[fromSeat];
    if (handIndex < 0 || handIndex >= hand.length) {
        return "bad_hand_index";
    }
    var cid = hand[handIndex];
    if (mkRulesCardKey(cid) !== "peach") {
        return "need_peach";
    }
    hand.splice(handIndex, 1);
    st.discard.push(cid);
    st.hp[victim]++;
    mkPushEvent(st, mkSeatDisplayName(st, fromSeat) + " 使用「桃」救 " + mkSeatDisplayName(st, victim));
    if (st.hp[victim] > 0) {
        st.pending = null;
    }
    return null;
}
function mkApplyPassDying(st, fromSeat, nk) {
    if (st.pending === null || st.pending.kind !== "dying") {
        return "no_pending_dying";
    }
    var p = st.pending;
    if (p.askIdx >= p.askOrder.length) {
        return "dying_done";
    }
    if (p.askOrder[p.askIdx] !== fromSeat) {
        return "not_your_turn_save";
    }
    mkPushEvent(st, mkSeatDisplayName(st, fromSeat) + " 濒死阶段：不出桃");
    p.askIdx++;
    if (p.askIdx >= p.askOrder.length) {
        var v = p.seat;
        st.pending = null;
        mkResolveDeath(st, v, nk);
    }
    return null;
}
function mkAiPlayTurn(st, nk, dispatcher, logger) {
    if (st.phase !== "playing" || st.winner) {
        return;
    }
    if (mkPendingIsActive(st)) {
        return;
    }
    var seat = st.turnSeat;
    if (!mkSeatActsAsAi(st, seat)) {
        return;
    }
    if (st.subPhase === "discard") {
        var hand_1 = st.hands[seat];
        var need = hand_1.length - st.hp[seat];
        if (need <= 0) {
            st.subPhase = "play";
            mkAdvanceTurn(st, nk);
            mkBroadcastState(dispatcher, st, logger, "ai-advance");
            mkBumpPlayPaceDeadline(st);
            return;
        }
        var toss = mkAiPickDiscardIndices(st, seat);
        mkApplyDiscard(st, seat, toss, nk);
        mkBroadcastState(dispatcher, st, logger, "ai-discard");
        mkBumpPlayPaceDeadline(st);
        return;
    }
    if (st.subPhase !== "play") {
        return;
    }
    var hand = st.hands[seat];
    var played = false;
    if (!st.shaUsedThisTurn) {
        var targetSeat = mkAiPickSlashTarget(st, seat);
        if (targetSeat >= 0) {
            var hi = mkAiFindFirstCardIndex(st, seat, "slash");
            if (hi >= 0) {
                var err = mkApplyPlayCard(st, seat, hi, targetSeat, nk);
                if (!err) {
                    played = true;
                }
            }
        }
    }
    if (!played) {
        for (var hi = 0; hi < hand.length; hi++) {
            var ck = mkRulesCardKey(hand[hi]);
            if (ck === "equip_ball" || ck === "equip_weapon") {
                var err = mkApplyPlayCard(st, seat, hi, seat, nk);
                if (!err) {
                    played = true;
                    break;
                }
            }
        }
    }
    if (!played) {
        for (var hi = 0; hi < hand.length; hi++) {
            if (mkRulesCardKey(hand[hi]) === "peach" && st.hp[seat] < st.maxHp[seat]) {
                var err = mkApplyPlayCard(st, seat, hi, seat, nk);
                if (!err) {
                    played = true;
                }
                break;
            }
        }
    }
    if (played) {
        mkBroadcastState(dispatcher, st, logger, "ai-play");
        mkBumpPlayPaceDeadline(st);
        return;
    }
    mkApplyEndPlay(st, seat, nk);
    mkBroadcastState(dispatcher, st, logger, "ai-end-play");
    mkBumpPlayPaceDeadline(st);
}
function mkAiRespondJink(st, nk, dispatcher, logger) {
    if (st.pending === null || st.pending.kind !== "jink") {
        return;
    }
    var v = st.pending.victim;
    if (!mkSeatActsAsAi(st, v)) {
        return;
    }
    if (mkAiShouldUseJink(st, v)) {
        var jidx = mkAiFindFirstCardIndex(st, v, "jink");
        if (jidx >= 0) {
            mkApplyRespondJink(st, v, true, jidx, nk);
        }
        else {
            mkApplyRespondJink(st, v, false, -1, nk);
        }
    }
    else {
        mkApplyRespondJink(st, v, false, -1, nk);
    }
    mkBroadcastState(dispatcher, st, logger, "ai-jink");
    mkBumpPlayPaceDeadline(st);
}
function mkAiRespondDying(st, nk, dispatcher, logger) {
    if (st.pending === null || st.pending.kind !== "dying") {
        return;
    }
    var p = st.pending;
    if (p.askIdx >= p.askOrder.length) {
        return;
    }
    var asker = p.askOrder[p.askIdx];
    if (!mkSeatActsAsAi(st, asker)) {
        return;
    }
    var victimSeat = p.seat;
    if (mkAiShouldPeachVictim(st, asker, victimSeat)) {
        var pidx = mkAiFindFirstCardIndex(st, asker, "peach");
        if (pidx >= 0) {
            mkApplyPeachDying(st, asker, pidx);
        }
        else {
            mkApplyPassDying(st, asker, nk);
        }
    }
    else {
        mkApplyPassDying(st, asker, nk);
    }
    mkBroadcastState(dispatcher, st, logger, "ai-dying");
    mkBumpPlayPaceDeadline(st);
}
function mkRunMeowAi(st, nk, dispatcher, logger) {
    if (st.phase !== "playing" || st.winner) {
        return;
    }
    if (Date.now() < st.aiPlayDelayUntilMs) {
        return;
    }
    if (st.pending && st.pending.kind === "jink") {
        mkAiRespondJink(st, nk, dispatcher, logger);
        return;
    }
    if (st.pending && st.pending.kind === "dying") {
        mkAiRespondDying(st, nk, dispatcher, logger);
        return;
    }
    mkAiPlayTurn(st, nk, dispatcher, logger);
}
function mkResetMatchGame(st) {
    st.pending = null;
    st.winner = null;
    st.aiPlayDelayUntilMs = 0;
    st.eventLog = [];
    st.turnSeat = -1;
    st.deck = [];
    st.discard = [];
    st.lordSeat = -1;
    st.shaUsedThisTurn = false;
    st.subPhase = "play";
    for (var s = 0; s < st.playerCount; s++) {
        st.hands[s] = [];
        st.identities[s] = 0;
        st.identityConfirmed[s] = false;
        st.breedConfirmed[s] = false;
        st.breeds[s] = "";
        st.alive[s] = true;
        st.hp[s] = 4;
        st.maxHp[s] = 4;
        st.equippedWeapon[s] = -1;
        st.aiDelegate[s] = false;
    }
    st.pickStage = "identity";
    st.breedPool = [];
    st.breedPoolIdx = 0;
}
function mkHandleGameMessage(st, seat, op, raw, nk, dispatcher, logger) {
    var payload = {};
    try {
        payload = raw.length > 0 ? JSON.parse(raw) : {};
    }
    catch (e) {
        return "bad_json";
    }
    if (op === MK_REQ_PLAY_CARD) {
        var hi = typeof payload.hand_index === "number" ? payload.hand_index : -1;
        var ts = typeof payload.target_seat === "number" ? payload.target_seat : -1;
        return mkApplyPlayCard(st, seat, hi, ts, nk);
    }
    if (op === MK_REQ_RESPOND_JINK) {
        var use = payload.use === true;
        var hi = typeof payload.hand_index === "number" ? payload.hand_index : -1;
        return mkApplyRespondJink(st, seat, use, hi, nk);
    }
    if (op === MK_REQ_END_PLAY) {
        return mkApplyEndPlay(st, seat, nk);
    }
    if (op === MK_REQ_DISCARD) {
        var arr = payload.hand_indices;
        var indices = Array.isArray(arr) ? arr : [];
        return mkApplyDiscard(st, seat, indices, nk);
    }
    if (op === MK_REQ_PEACH_DYING) {
        var hi = typeof payload.hand_index === "number" ? payload.hand_index : -1;
        return mkApplyPeachDying(st, seat, hi);
    }
    if (op === MK_REQ_PASS_DYING) {
        return mkApplyPassDying(st, seat, nk);
    }
    if (op === MK_REQ_CONFIRM_IDENTITY) {
        return mkApplyConfirmIdentity(st, seat);
    }
    if (op === MK_REQ_CONFIRM_BREED) {
        return mkApplyConfirmBreed(st, seat);
    }
    if (op === MK_REQ_DELEGATE) {
        var on = payload.on === true;
        return mkApplyDelegate(st, seat, on);
    }
    return "unknown_op";
}
/**
 * 猫猫杀 Match Handler：进满 → 直接开局；回合与 AI 在 matchLoop 推进。
 */
function mkMatchInit(ctx, logger, nk, params) {
    logger.info("meow_kill matchInit: params=%s", JSON.stringify(params));
    var st = mkInitialState();
    var pc = 5;
    if (params["player_count"]) {
        var n = parseInt(params["player_count"], 10);
        pc = n === 8 ? 8 : 5;
    }
    mkConfigureTableSize(st, pc);
    if (params["expect_humans"]) {
        st.expectHumans = parseInt(params["expect_humans"], 10);
    }
    if (params["ai"]) {
        st.aiCount = parseInt(params["ai"], 10);
    }
    if (st.expectHumans + st.aiCount !== st.playerCount) {
        logger.warn("meow_kill matchInit: expect_humans+ai!=playerCount, clamping ai");
        st.aiCount = Math.max(0, st.playerCount - st.expectHumans);
    }
    if (st.expectHumans > st.playerCount) {
        st.expectHumans = st.playerCount;
    }
    return {
        state: st,
        tickRate: 5,
        label: "meow_kill",
    };
}
function mkMatchJoinAttempt(ctx, logger, nk, dispatcher, tick, state, presence, metadata) {
    var st = state;
    var n = Object.keys(st.presences).length;
    if (n >= st.expectHumans) {
        logger.warn("meow_kill matchJoinAttempt REJECT full: userId=%s current=%d expectHumans=%d", presence.userId, n, st.expectHumans);
        return { state: state, accept: false, rejectMessage: "full" };
    }
    return { state: state, accept: true };
}
function mkMatchJoin(ctx, logger, nk, dispatcher, tick, state, presences) {
    var st = state;
    mkRepairHandsForRuntime(st);
    mkSanitizePending(st);
    for (var i = 0; i < presences.length; i++) {
        var p = presences[i];
        st.presences[p.userId] = p;
    }
    mkAssignSeats(st);
    var n = Object.keys(st.presences).length;
    logger.info("meow_kill matchJoin: humans=%d/%d phase=%s", n, st.expectHumans, st.phase);
    if (n === st.expectHumans && st.phase === "waiting") {
        st.phase = "lobby";
        mkBeginIdentityPhase(st, nk, dispatcher, logger);
    }
    else {
        mkBroadcastState(dispatcher, st, logger, "join");
    }
    return { state: st };
}
function mkMatchLeave(ctx, logger, nk, dispatcher, tick, state, presences) {
    var st = state;
    mkRepairHandsForRuntime(st);
    mkSanitizePending(st);
    for (var i = 0; i < presences.length; i++) {
        delete st.presences[presences[i].userId];
    }
    mkAssignSeats(st);
    if (Object.keys(st.presences).length < st.expectHumans) {
        st.phase = "waiting";
        mkResetMatchGame(st);
    }
    mkBroadcastState(dispatcher, st, logger, "leave");
    return { state: st };
}
function mkMatchLoop(ctx, logger, nk, dispatcher, tick, state, messages) {
    var st = state;
    mkRepairHandsForRuntime(st);
    mkSanitizePending(st);
    mkRepairMkAuxFields(st);
    for (var m = 0; m < messages.length; m++) {
        var msg = messages[m];
        var seat = mkSeatForUser(st, msg.sender.userId);
        if (seat < 0) {
            logger.warn("meow_kill matchLoop: unknown sender=%s", msg.sender.userId);
            continue;
        }
        if (msg.opCode === MK_REQ_PING) {
            continue;
        }
        var rawStr = mkDecodeMatchData(msg.data);
        if (msg.opCode === MK_REQ_DELEGATE) {
            var payload = {};
            try {
                payload = rawStr.length > 0 ? JSON.parse(rawStr) : {};
            }
            catch (e) {
                mkSendError(dispatcher, logger, st, msg.sender, "bad_json");
                continue;
            }
            var err = mkApplyDelegate(st, seat, payload.on === true);
            if (err) {
                mkSendError(dispatcher, logger, st, msg.sender, err);
            }
            else {
                mkBroadcastState(dispatcher, st, logger, "delegate");
                if (st.phase === "picking_identity") {
                    mkTryAdvanceFromIdentityPhase(st, nk, dispatcher, logger);
                }
            }
            continue;
        }
        if (st.aiDelegate[seat] && !st.isAiSeat[seat]) {
            mkSendError(dispatcher, logger, st, msg.sender, "delegated_no_manual");
            continue;
        }
        if (st.phase === "picking_identity") {
            if (msg.opCode === MK_REQ_CONFIRM_IDENTITY || msg.opCode === MK_REQ_CONFIRM_BREED) {
                var rawId = rawStr;
                var err = mkHandleGameMessage(st, seat, msg.opCode, rawId, nk, dispatcher, logger);
                if (err) {
                    mkSendError(dispatcher, logger, st, msg.sender, err);
                }
                else {
                    mkBroadcastState(dispatcher, st, logger, "pick-confirm");
                    mkTryAdvanceFromIdentityPhase(st, nk, dispatcher, logger);
                }
            }
            continue;
        }
        if (st.phase === "playing" && !st.winner) {
            var rawJson = rawStr;
            var err = mkHandleGameMessage(st, seat, msg.opCode, rawJson, nk, dispatcher, logger);
            if (err) {
                mkSendError(dispatcher, logger, st, msg.sender, err);
            }
            else {
                mkBroadcastState(dispatcher, st, logger, "action");
                mkBumpPlayPaceDeadline(st);
            }
        }
    }
    if (st.phase === "picking_identity") {
        var aiChangedIdentity = mkConfirmAllAiIdentities(st);
        var aiChangedBreed = mkConfirmAllAiBreeds(st);
        mkTryAdvanceFromIdentityPhase(st, nk, dispatcher, logger);
        if (st.phase === "picking_identity" && (aiChangedIdentity || aiChangedBreed)) {
            mkBroadcastState(dispatcher, st, logger, "ai-pick");
        }
        return { state: st };
    }
    if (st.phase === "playing" && !st.winner) {
        mkRunMeowAi(st, nk, dispatcher, logger);
    }
    return { state: st };
}
function mkMatchTerminate(ctx, logger, nk, dispatcher, tick, state, graceSeconds) {
    return { state: state };
}
function mkMatchSignal(ctx, logger, nk, dispatcher, tick, state, data) {
    return { state: state, data: "ok" };
}
var meowKillMatchHandler = {
    matchInit: mkMatchInit,
    matchJoinAttempt: mkMatchJoinAttempt,
    matchJoin: mkMatchJoin,
    matchLeave: mkMatchLeave,
    matchLoop: mkMatchLoop,
    matchTerminate: mkMatchTerminate,
    matchSignal: mkMatchSignal,
};
/**
 * 猫猫杀匹配：5 人 / 8 人两队列；满员即开；未满 10s 后 AI 补位。
 */
var MK_MM_WAIT_MS = 10000;
var MK_MM_COLLECTION = "meow_kill_mm";
var MK_MM_STATE_KEY = "queue_state";
var MK_MM_OWNER = "00000000-0000-0000-0000-000000000000";
function mkMmDefaultState() {
    return { entries5: [], entries8: [], results: {} };
}
function mkMmReviveEntry(raw) {
    if (!raw || typeof raw.userId !== "string" || typeof raw.ticket !== "string") {
        return null;
    }
    var tsRaw = raw.tableSize;
    var ts = tsRaw === 8 || tsRaw === "8" ? 8 : 5;
    return {
        userId: raw.userId,
        username: typeof raw.username === "string" ? raw.username : "",
        joinedAtMs: typeof raw.joinedAtMs === "number" ? raw.joinedAtMs : 0,
        ticket: raw.ticket,
        tableSize: ts,
    };
}
function mkMmRevive(raw) {
    var clone = raw;
    var entries5 = [];
    var entries8 = [];
    var pushArr = function (arr, defaultTable) {
        if (!Array.isArray(arr)) {
            return;
        }
        for (var i = 0; i < arr.length; i++) {
            var e = mkMmReviveEntry(arr[i]);
            if (!e) {
                continue;
            }
            var ts = e.tableSize === 8 ? 8 : defaultTable;
            var ent = {
                userId: e.userId,
                username: e.username,
                joinedAtMs: e.joinedAtMs,
                ticket: e.ticket,
                tableSize: ts,
            };
            if (ts === 8) {
                entries8.push(ent);
            }
            else {
                entries5.push(ent);
            }
        }
    };
    if (Array.isArray(clone.entries5)) {
        pushArr(clone.entries5, 5);
    }
    if (Array.isArray(clone.entries8)) {
        pushArr(clone.entries8, 8);
    }
    if (Array.isArray(clone.entries)) {
        pushArr(clone.entries, 5);
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
    return { entries5: entries5, entries8: entries8, results: results };
}
function mkMmToValue(state) {
    return {
        entries5: state.entries5,
        entries8: state.entries8,
        results: state.results,
    };
}
function mkMmMakeTicket(nk) {
    var u = randomBytesCompat(nk, 8);
    var hex = Array.prototype.map
        .call(u, function (x) {
        return ("0" + x.toString(16)).slice(-2);
    })
        .join("");
    return "mkmm_" + Date.now().toString(36) + "_" + hex;
}
function mkMmMutateState(nk, logger, mutator) {
    mutateGlobalStorage(nk, logger, MK_MM_COLLECTION, MK_MM_STATE_KEY, MK_MM_OWNER, mkMmDefaultState, mkMmRevive, mkMmToValue, mutator, "meow_kill_mm");
}
function mkMmNotifyResults(state, tickets, matchId) {
    for (var i = 0; i < tickets.length; i++) {
        state.results[tickets[i]] = { matchId: matchId };
    }
}
function mkMmCreateMatchInner(nk, logger, humans, ai, tableSize) {
    var id;
    try {
        id = nk.matchCreate("meow_kill", {
            expect_humans: String(humans),
            ai: String(ai),
            player_count: String(tableSize),
        });
    }
    catch (e) {
        logger.error("meow_kill_mm matchCreate: %s", String(e));
        return null;
    }
    if (!id || String(id).length === 0) {
        logger.error("meow_kill_mm matchCreate empty id");
        return null;
    }
    logger.info("meow_kill_mm: created match %s humans=%d ai=%d table=%d", id, humans, ai, tableSize);
    return id;
}
function mkMmProcessOneQueue(q, tableSize, nk, logger, state) {
    var now = Date.now();
    q.sort(function (a, b) {
        return a.joinedAtMs - b.joinedAtMs;
    });
    while (q.length >= tableSize) {
        var id = mkMmCreateMatchInner(nk, logger, tableSize, 0, tableSize);
        if (!id) {
            break;
        }
        var picked = q.splice(0, tableSize);
        var tickets = [];
        for (var i = 0; i < picked.length; i++) {
            tickets.push(picked[i].ticket);
        }
        mkMmNotifyResults(state, tickets, id);
    }
    if (q.length >= 2 && q.length < tableSize) {
        var oldest = q[0].joinedAtMs;
        if (now - oldest >= MK_MM_WAIT_MS) {
            var humans = q.length;
            var ai = tableSize - humans;
            var id = mkMmCreateMatchInner(nk, logger, humans, ai, tableSize);
            if (id) {
                var tickets = [];
                for (var i = 0; i < humans; i++) {
                    tickets.push(q[i].ticket);
                }
                q.splice(0, humans);
                mkMmNotifyResults(state, tickets, id);
            }
        }
    }
    if (q.length === 1) {
        if (now - q[0].joinedAtMs >= MK_MM_WAIT_MS) {
            var id = mkMmCreateMatchInner(nk, logger, 1, tableSize - 1, tableSize);
            if (id) {
                mkMmNotifyResults(state, [q[0].ticket], id);
                q.splice(0, 1);
            }
        }
    }
    return q;
}
function mkMmProcessQueueCore(state, nk, logger) {
    state.entries5 = mkMmProcessOneQueue(state.entries5.slice(), 5, nk, logger, state);
    state.entries8 = mkMmProcessOneQueue(state.entries8.slice(), 8, nk, logger, state);
}
function rpcMeowKillMmJoin(ctx, logger, nk, payload) {
    var uid = ctx.userId;
    if (!uid) {
        return rpcErr("unauthorized");
    }
    var tableSize = 5;
    try {
        var u = JSON.parse(payload || "{}");
        if (Number(u.table) === 8 || u.table === "8") {
            tableSize = 8;
        }
    }
    catch (e) {
        // default 5
    }
    var outTicket = "";
    try {
        mkMmMutateState(nk, logger, function (st) {
            var list5 = [];
            var list8 = [];
            for (var i = 0; i < st.entries5.length; i++) {
                if (st.entries5[i].userId !== uid) {
                    list5.push(st.entries5[i]);
                }
                else {
                    delete st.results[st.entries5[i].ticket];
                }
            }
            for (var i = 0; i < st.entries8.length; i++) {
                if (st.entries8[i].userId !== uid) {
                    list8.push(st.entries8[i]);
                }
                else {
                    delete st.results[st.entries8[i].ticket];
                }
            }
            st.entries5 = list5;
            st.entries8 = list8;
            var ticket = mkMmMakeTicket(nk);
            var username = "";
            try {
                var acc = nk.accountGetId(uid);
                if (acc && acc.user && acc.user.username) {
                    username = acc.user.username;
                }
            }
            catch (e) {
                logger.warn("meow_kill_mm accountGetId: %s", String(e));
            }
            var entry = {
                userId: uid,
                username: username,
                joinedAtMs: Date.now(),
                ticket: ticket,
                tableSize: tableSize,
            };
            if (tableSize === 8) {
                st.entries8.push(entry);
            }
            else {
                st.entries5.push(entry);
            }
            outTicket = ticket;
        });
    }
    catch (e) {
        logger.error("meow_kill_mm join storage: %s", String(e));
        return rpcErr("storage_busy");
    }
    logger.info("meow_kill_mm join user=%s ticket=%s table=%d", uid, outTicket, tableSize);
    return rpcOk({ ticket: outTicket });
}
function rpcMeowKillMmPoll(ctx, logger, nk, payload) {
    var ticket = "";
    try {
        var u = JSON.parse(payload || "{}");
        ticket = String(u.ticket || "");
    }
    catch (e) {
        return rpcErr("bad_payload");
    }
    if (!ticket) {
        return rpcErr("no_ticket");
    }
    var response = rpcOk({ status: "waiting" });
    try {
        mkMmMutateState(nk, logger, function (st) {
            mkMmProcessQueueCore(st, nk, logger);
            var r = st.results[ticket];
            if (r && r.matchId) {
                delete st.results[ticket];
                response = rpcOk({ status: "matched", match_id: r.matchId });
            }
        });
    }
    catch (e) {
        logger.error("meow_kill_mm poll storage: %s", String(e));
        return rpcErr("storage_busy");
    }
    return response;
}
function rpcMeowKillMmCancel(ctx, logger, nk, payload) {
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
        mkMmMutateState(nk, logger, function (st) {
            st.entries5 = st.entries5.filter(function (e) {
                return e.ticket !== ticket;
            });
            st.entries8 = st.entries8.filter(function (e) {
                return e.ticket !== ticket;
            });
            delete st.results[ticket];
        });
    }
    catch (e) {
        logger.error("meow_kill_mm cancel storage: %s", String(e));
        return rpcErr("storage_busy");
    }
    return rpcOk();
}
/**
 * Nakama 运行时代码入口。
 *
 * Nakama 3.1+ JS 运行时要求：registerRpc / registerMatch / registerMatchmakerMatched
 * 必须在 InitModule 内「直接」对 initializer 调用，不能包在另一层函数里，
 * 否则报错：function key could not be extracted（见 heroiclabs/nakama#549）。
 */
var InitModule = function (ctx, logger, nk, initializer) {
    initializer.registerRpc("wallet_sync", rpcWalletSync);
    initializer.registerRpc("wallet_buy", rpcWalletBuy);
    initializer.registerRpc("wallet_apply_delta", rpcWalletApplyDelta);
    initializer.registerMatch("ddz", ddzMatchHandler);
    initializer.registerMatchmakerMatched(ddzMatchmakerMatched);
    initializer.registerRpc("ddz_mm_join", rpcDdzMmJoin);
    initializer.registerRpc("ddz_mm_poll", rpcDdzMmPoll);
    initializer.registerRpc("ddz_mm_cancel", rpcDdzMmCancel);
    /**
     * 掼蛋（guandan）：Match Handler + 自建匹配队列 RPC。
     * 与 ddz 隔离：Match label "guandan"、Storage collection "guandan_mm"、RPC 前缀 guandan_mm_*。
     * 内置 matchmaker 当前仍由 ddzMatchmakerMatched 回调（Nakama 仅允许注册一个）。
     * 若未来客户端改走 add_matchmaker_async 并在 properties 中携带 game="guandan"，
     * 请在 ddzMatchmakerMatched 内分流到 guandanMatchmakerMatchedFallback。
     */
    initializer.registerMatch("guandan", guandanMatchHandler);
    initializer.registerRpc("guandan_mm_join", rpcGuandanMmJoin);
    initializer.registerRpc("guandan_mm_poll", rpcGuandanMmPoll);
    initializer.registerRpc("guandan_mm_cancel", rpcGuandanMmCancel);
    initializer.registerMatch("meow_kill", meowKillMatchHandler);
    initializer.registerRpc("meow_kill_mm_join", rpcMeowKillMmJoin);
    initializer.registerRpc("meow_kill_mm_poll", rpcMeowKillMmPoll);
    initializer.registerRpc("meow_kill_mm_cancel", rpcMeowKillMmCancel);
    logger.info("Nakama runtime initialized (wallet + ddz + guandan + meow_kill).");
};
// @ts-nocheck
/**
 * 服务端斗地主 AI（档位 A：强规则 + 真记牌 + 最少手数分解 + 带牌智能）。
 *
 * 依赖全局：classify / beats / ddzRankValue / DdzHandPattern / DDZ_KIND_*
 * 依赖 state：hands[seat]、lastPattern、turn、passes、landlord、seatCat、seenCount（由 match_logic.applyPlay 维护）
 *
 * 改进点（相对旧版）：
 *   - 真记牌：通过 state.seenCount + 自己手牌得到另外两家每点数剩余张数（remainOutside）。
 *   - "绝对最大"判定：同型牌外是否还有更大；单/对/三均支持；并考虑外部炸弹/火箭威胁。
 *   - 手牌分解启发（minSplits）：将手牌拆成最少手数的近似值，供候选评分。
 *   - 候选枚举：首出枚举单/对/三/三带/顺子/对子串/飞机/飞机带翅/四带二；跟牌按同型枚举所有可压候选。
 *   - 带牌智能：三带 / 飞机翅膀 / 四带二的副牌按"拆完后 minSplits 最小"挑选。
 *   - 炸/火箭闸门：仅在对手即将走完、队友不妨碍、或收益显著时启用。
 *   - 队友让牌：农民在 passes===1 且队友刚出时，按队友手牌张数/外部牌阻判断是否过。
 *   - 叫 / 抢地主：按 17 张强度 + 底牌期望（+4.0）修正，阈值按风格与当前倍数调整。
 *   - AI_PRO_MODE 去除：不再把 NORMAL → AGGRESSIVE 等整体上抬，风格由 seatCat 稳定决定。
 */
var AI_STYLE_NORMAL = 0;
var AI_STYLE_AGGRESSIVE = 1;
var AI_STYLE_PASSIVE = 2;
function aiStyleFromCatId(catId) {
    if (catId === 1) {
        return AI_STYLE_AGGRESSIVE;
    }
    if (catId === 2) {
        return AI_STYLE_PASSIVE;
    }
    return AI_STYLE_NORMAL;
}
// ============================================================================
// 记牌工具
// ============================================================================
function aiRankCounts(hand) {
    var c = [];
    for (var i = 0; i < 15; i++) {
        c.push(0);
    }
    for (var i = 0; i < hand.length; i++) {
        c[ddzRankValue(hand[i])]++;
    }
    return c;
}
function aiMaxPerRank(r) {
    if (r === 13 || r === 14) {
        return 1;
    }
    return 4;
}
/** 另外两家（对手+队友）合计每一点数仍可能持有的张数。 */
function aiRemainOutside(state, mySeat) {
    var seen = state.seenCount;
    var seenOk = seen && seen.length >= 15;
    var my = aiRankCounts(state.hands[mySeat]);
    var out = [];
    for (var r = 0; r < 15; r++) {
        var s = seenOk ? seen[r] : 0;
        var v = aiMaxPerRank(r) - s - my[r];
        if (v < 0) {
            v = 0;
        }
        out.push(v);
    }
    return out;
}
function aiHasHigherSingleOutside(outside, r) {
    for (var x = r + 1; x < 15; x++) {
        if (outside[x] > 0) {
            return true;
        }
    }
    return false;
}
function aiHasHigherPairOutside(outside, r) {
    for (var x = r + 1; x < 13; x++) {
        if (outside[x] >= 2) {
            return true;
        }
    }
    return false;
}
function aiHasHigherTripleOutside(outside, r) {
    for (var x = r + 1; x < 13; x++) {
        if (outside[x] >= 3) {
            return true;
        }
    }
    return false;
}
function aiHasAnyBombOutside(outside) {
    for (var r = 0; r < 13; r++) {
        if (outside[r] >= 4) {
            return true;
        }
    }
    return false;
}
function aiHasHigherBombOutside(outside, r) {
    for (var x = r + 1; x < 13; x++) {
        if (outside[x] >= 4) {
            return true;
        }
    }
    return false;
}
function aiHasRocketOutside(outside) {
    return outside[13] >= 1 && outside[14] >= 1;
}
// ============================================================================
// 最少手数启发式分解（minSplits）
// ============================================================================
function aiCountsClone(c) {
    var o = [];
    for (var i = 0; i < 15; i++) {
        o.push(c[i]);
    }
    return o;
}
/** 在 [0..11] 闭区间里找最长一段连续的 c[r] >= needCount；返回 {st, len}（len 达不到 minLen 时 len=0）。 */
function aiFindLongestRun(c, needCount, minLen) {
    var bestSt = -1;
    var bestLen = 0;
    var r = 0;
    while (r < 12) {
        if (c[r] >= needCount) {
            var t = r;
            while (t < 12 && c[t] >= needCount) {
                t++;
            }
            var len = t - r;
            if (len >= minLen && len > bestLen) {
                bestSt = r;
                bestLen = len;
            }
            r = t + 1;
        }
        else {
            r++;
        }
    }
    return { st: bestSt, len: bestLen };
}
/** 以贪心从长到短抽取结构，估算手牌需要的最少手数；与精确值相比偏保守（≤ 精确值不成立，通常接近）。 */
function aiMinSplitsOfCounts(counts) {
    var c = aiCountsClone(counts);
    var s = 0;
    if (c[13] >= 1 && c[14] >= 1) {
        s++;
        c[13]--;
        c[14]--;
    }
    for (var r = 0; r < 13; r++) {
        if (c[r] === 4) {
            s++;
            c[r] = 0;
        }
    }
    while (true) {
        var p = aiFindLongestRun(c, 3, 2);
        if (p.len < 2) {
            break;
        }
        for (var r = p.st; r < p.st + p.len; r++) {
            c[r] -= 3;
        }
        s++;
    }
    while (true) {
        var p = aiFindLongestRun(c, 2, 3);
        if (p.len < 3) {
            break;
        }
        for (var r = p.st; r < p.st + p.len; r++) {
            c[r] -= 2;
        }
        s++;
    }
    while (true) {
        var p = aiFindLongestRun(c, 1, 5);
        if (p.len < 5) {
            break;
        }
        for (var r = p.st; r < p.st + p.len; r++) {
            c[r] -= 1;
        }
        s++;
    }
    var triples = 0;
    var pairs = 0;
    var singles = 0;
    for (var r = 0; r < 15; r++) {
        if (c[r] === 3) {
            triples++;
        }
        else if (c[r] === 2) {
            pairs++;
        }
        else if (c[r] === 1) {
            singles++;
        }
    }
    /** 三带一 / 三带二：各吸收一个副牌合为一手 */
    var absorbS = triples < singles ? triples : singles;
    triples -= absorbS;
    singles -= absorbS;
    var absorbP = triples < pairs ? triples : pairs;
    triples -= absorbP;
    pairs -= absorbP;
    s += absorbS + absorbP + triples + pairs + singles;
    return s;
}
function aiMinSplits(hand) {
    return aiMinSplitsOfCounts(aiRankCounts(hand));
}
function aiMinSplitsAfter(hand, played) {
    var c = aiRankCounts(hand);
    for (var i = 0; i < played.length; i++) {
        c[ddzRankValue(played[i])]--;
    }
    return aiMinSplitsOfCounts(c);
}
// ============================================================================
// 叫分 / 抢地主强度
// ============================================================================
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
    var c = aiRankCounts(hand);
    var s = 0.0;
    for (var r = 0; r < 15; r++) {
        var n = c[r];
        if (n === 0) {
            continue;
        }
        var w = aiRankWeightLandlord(r);
        s += n * w;
        if (n === 2 || n === 3) {
            s += 0.2 * n * w;
        }
        if (n >= 4) {
            s += 11.0;
        }
    }
    if (c[13] >= 1 && c[14] >= 1) {
        s += 7.0;
    }
    var tmp = aiCountsClone(c);
    var r5 = aiFindLongestRun(tmp, 1, 5);
    if (r5.len >= 5) {
        s += 1.2 * r5.len;
    }
    var r3 = aiFindLongestRun(tmp, 2, 3);
    if (r3.len >= 3) {
        s += 1.8 * r3.len;
    }
    var r2 = aiFindLongestRun(tmp, 3, 2);
    if (r2.len >= 2) {
        s += 2.4 * r2.len;
    }
    return s;
}
/** 地主会合入 3 张底牌 → 强度修正项（叫/抢均按"期望 +4"评估）。 */
var AI_LANDLORD_BOTTOM_BOOST = 4.0;
function aiChooseBid(hand, style) {
    var s = aiHandLandlordStrength(hand) + AI_LANDLORD_BOTTOM_BOOST;
    var t = 19.0;
    if (style === AI_STYLE_AGGRESSIVE) {
        t -= 3.5;
    }
    else if (style === AI_STYLE_PASSIVE) {
        t += 3.5;
    }
    return s >= t ? 1 : 0;
}
function aiChooseRobLandlord(hand, currentMultiplier, style) {
    var s = aiHandLandlordStrength(hand) + AI_LANDLORD_BOTTOM_BOOST;
    var need = 27.0;
    if (currentMultiplier >= 4) {
        need = 42.0;
    }
    else if (currentMultiplier >= 2) {
        need = 34.0;
    }
    if (style === AI_STYLE_AGGRESSIVE) {
        need -= 3.0;
    }
    else if (style === AI_STYLE_PASSIVE) {
        need += 4.0;
    }
    var floorS = style === AI_STYLE_PASSIVE ? 22.0 : 16.0;
    if (s < floorS) {
        return false;
    }
    return s >= need;
}
function aiSortCardsAsc(a) {
    var o = a.slice();
    o.sort(function (x, y) {
        var rx = ddzRankValue(x);
        var ry = ddzRankValue(y);
        if (rx !== ry) {
            return rx - ry;
        }
        return x - y;
    });
    return o;
}
function aiCardsOfRank(hand, r, n) {
    var out = [];
    for (var i = 0; i < hand.length; i++) {
        if (out.length >= n) {
            break;
        }
        if (ddzRankValue(hand[i]) === r) {
            out.push(hand[i]);
        }
    }
    out.sort(function (a, b) {
        return a - b;
    });
    return out;
}
/** 高张保留权重：2/王最大，其次 A/K/Q；出这类牌在"首出"时扣分。 */
function aiHighWeightOfRank(r) {
    if (r >= 13) {
        return 6.0;
    }
    if (r === 12) {
        return 4.0;
    }
    if (r === 11) {
        return 3.0;
    }
    if (r === 10) {
        return 2.0;
    }
    if (r === 9) {
        return 1.0;
    }
    return 0.0;
}
function aiMakeMove(hand, cards, kind, mainRank, extraVal) {
    var after = aiMinSplitsAfter(hand, cards);
    var useHigh = 0;
    for (var i = 0; i < cards.length; i++) {
        useHigh += aiHighWeightOfRank(ddzRankValue(cards[i]));
    }
    return {
        cards: aiSortCardsAsc(cards),
        kind: kind,
        mainRank: mainRank,
        extraVal: extraVal,
        splitsAfter: after,
        useHigh: useHigh,
    };
}
/** 三带一 / 飞机翅膀副牌：选拆后 minSplits 最小的单张（同分优先低点）。 */
function aiBestKickerSingle(hand, excludeRanks) {
    var ex = {};
    for (var i = 0; i < excludeRanks.length; i++) {
        ex[String(excludeRanks[i])] = true;
    }
    var c = aiRankCounts(hand);
    var bestCid = -1;
    var bestScore = 1e9;
    for (var r = 0; r < 15; r++) {
        if (ex[String(r)]) {
            continue;
        }
        if (c[r] < 1) {
            continue;
        }
        var cid = aiCardsOfRank(hand, r, 1)[0];
        var after = aiMinSplitsAfter(hand, [cid]);
        var score = after * 10 + aiHighWeightOfRank(r) + r * 0.01;
        if (score < bestScore) {
            bestScore = score;
            bestCid = cid;
        }
    }
    return bestCid >= 0 ? [bestCid] : [];
}
/** 三带二 / 飞机对翅 副牌：选拆后 minSplits 最小的一对。 */
function aiBestKickerPair(hand, excludeRanks) {
    var ex = {};
    for (var i = 0; i < excludeRanks.length; i++) {
        ex[String(excludeRanks[i])] = true;
    }
    var c = aiRankCounts(hand);
    var bestCards = [];
    var bestScore = 1e9;
    for (var r = 0; r < 13; r++) {
        if (ex[String(r)]) {
            continue;
        }
        if (c[r] < 2) {
            continue;
        }
        var pp = aiCardsOfRank(hand, r, 2);
        var after = aiMinSplitsAfter(hand, pp);
        var score = after * 10 + aiHighWeightOfRank(r) * 2 + r * 0.01;
        if (score < bestScore) {
            bestScore = score;
            bestCards = pp;
        }
    }
    return bestCards;
}
/** 飞机带 n 张单翅 / 四带二两单：按"低权重优先"返回 n 张。 */
function aiBestKickerSingles(hand, excludeRanks, n) {
    var ex = {};
    for (var i = 0; i < excludeRanks.length; i++) {
        ex[String(excludeRanks[i])] = true;
    }
    var c = aiRankCounts(hand);
    var cand = [];
    for (var r = 0; r < 15; r++) {
        if (ex[String(r)]) {
            continue;
        }
        if (c[r] < 1) {
            continue;
        }
        cand.push({ cid: aiCardsOfRank(hand, r, 1)[0], r: r });
    }
    cand.sort(function (a, b) {
        var wa = aiHighWeightOfRank(a.r);
        var wb = aiHighWeightOfRank(b.r);
        if (wa !== wb) {
            return wa - wb;
        }
        return a.r - b.r;
    });
    var taken = [];
    for (var i = 0; i < cand.length; i++) {
        if (taken.length >= n) {
            break;
        }
        taken.push(cand[i].cid);
    }
    return taken.length === n ? taken : [];
}
/** 飞机带 n 对翅 / 四带二两对：按"低权重优先"返回 n*2 张。 */
function aiBestKickerPairs(hand, excludeRanks, n) {
    var ex = {};
    for (var i = 0; i < excludeRanks.length; i++) {
        ex[String(excludeRanks[i])] = true;
    }
    var c = aiRankCounts(hand);
    var cand = [];
    for (var r = 0; r < 13; r++) {
        if (ex[String(r)]) {
            continue;
        }
        if (c[r] < 2) {
            continue;
        }
        cand.push({ cards: aiCardsOfRank(hand, r, 2), r: r });
    }
    cand.sort(function (a, b) {
        var wa = aiHighWeightOfRank(a.r);
        var wb = aiHighWeightOfRank(b.r);
        if (wa !== wb) {
            return wa - wb;
        }
        return a.r - b.r;
    });
    var taken = [];
    for (var i = 0; i < cand.length; i++) {
        if (taken.length >= n * 2) {
            break;
        }
        taken.push(cand[i].cards[0]);
        taken.push(cand[i].cards[1]);
    }
    return taken.length === n * 2 ? taken : [];
}
function aiEnumerateLeadMoves(hand) {
    var moves = [];
    var c = aiRankCounts(hand);
    for (var r = 0; r < 15; r++) {
        if (c[r] >= 1) {
            moves.push(aiMakeMove(hand, aiCardsOfRank(hand, r, 1), DDZ_KIND_SINGLE, r, 1));
        }
    }
    for (var r = 0; r < 13; r++) {
        if (c[r] >= 2) {
            moves.push(aiMakeMove(hand, aiCardsOfRank(hand, r, 2), DDZ_KIND_PAIR, r, 2));
        }
    }
    for (var r = 0; r < 13; r++) {
        if (c[r] < 3) {
            continue;
        }
        var three = aiCardsOfRank(hand, r, 3);
        moves.push(aiMakeMove(hand, three, DDZ_KIND_TRIPLE, r, 3));
        var k1 = aiBestKickerSingle(hand, [r]);
        if (k1.length === 1) {
            moves.push(aiMakeMove(hand, three.concat(k1), DDZ_KIND_TRIPLE_WITH_SINGLE, r, 4));
        }
        var k2 = aiBestKickerPair(hand, [r]);
        if (k2.length === 2) {
            moves.push(aiMakeMove(hand, three.concat(k2), DDZ_KIND_TRIPLE_WITH_PAIR, r, 5));
        }
    }
    for (var len = 5; len <= 12; len++) {
        for (var st = 0; st + len - 1 <= 11; st++) {
            var ok = true;
            for (var r = st; r < st + len; r++) {
                if (c[r] < 1) {
                    ok = false;
                    break;
                }
            }
            if (!ok) {
                continue;
            }
            var cards = [];
            for (var r = st; r < st + len; r++) {
                cards.push(aiCardsOfRank(hand, r, 1)[0]);
            }
            moves.push(aiMakeMove(hand, cards, DDZ_KIND_STRAIGHT, st + len - 1, len));
        }
    }
    for (var nPairs = 3; nPairs <= 10; nPairs++) {
        for (var st = 0; st + nPairs - 1 <= 11; st++) {
            var ok = true;
            for (var r = st; r < st + nPairs; r++) {
                if (c[r] < 2) {
                    ok = false;
                    break;
                }
            }
            if (!ok) {
                continue;
            }
            var cards = [];
            for (var r = st; r < st + nPairs; r++) {
                var pp = aiCardsOfRank(hand, r, 2);
                cards.push(pp[0], pp[1]);
            }
            moves.push(aiMakeMove(hand, cards, DDZ_KIND_PAIR_STRAIGHT, st + nPairs - 1, nPairs * 2));
        }
    }
    for (var k = 2; k <= 6; k++) {
        for (var st = 0; st + k - 1 <= 11; st++) {
            var ok = true;
            for (var r = st; r < st + k; r++) {
                if (c[r] < 3) {
                    ok = false;
                    break;
                }
            }
            if (!ok) {
                continue;
            }
            var base = [];
            var exR = [];
            for (var r = st; r < st + k; r++) {
                var tt = aiCardsOfRank(hand, r, 3);
                base.push(tt[0], tt[1], tt[2]);
                exR.push(r);
            }
            moves.push(aiMakeMove(hand, base, DDZ_KIND_PLANE, st + k - 1, k));
            var w1 = aiBestKickerSingles(hand, exR, k);
            if (w1.length === k) {
                moves.push(aiMakeMove(hand, base.concat(w1), DDZ_KIND_PLANE_WITH_WINGS, st + k - 1, (k << 5) | 0));
            }
            var w2 = aiBestKickerPairs(hand, exR, k);
            if (w2.length === k * 2) {
                moves.push(aiMakeMove(hand, base.concat(w2), DDZ_KIND_PLANE_WITH_WINGS, st + k - 1, (k << 5) | k));
            }
        }
    }
    for (var r = 0; r < 13; r++) {
        if (c[r] < 4) {
            continue;
        }
        var four = aiCardsOfRank(hand, r, 4);
        var ks1 = aiBestKickerSingles(hand, [r], 2);
        if (ks1.length === 2) {
            moves.push(aiMakeMove(hand, four.concat(ks1), DDZ_KIND_FOUR_WITH_TWO, r, 6));
        }
        var ks2 = aiBestKickerPairs(hand, [r], 2);
        if (ks2.length === 4) {
            moves.push(aiMakeMove(hand, four.concat(ks2), DDZ_KIND_FOUR_WITH_TWO, r, 8));
        }
    }
    return moves;
}
function aiEnumerateFollowMoves(hand, last) {
    var all = [];
    var c = aiRankCounts(hand);
    var lk = last.kind;
    var lmain = last.main;
    var lextra = last.extra === null ? 0 : last.extra;
    if (lk === DDZ_KIND_SINGLE) {
        for (var r = lmain + 1; r < 15; r++) {
            if (c[r] < 1) {
                continue;
            }
            all.push(aiMakeMove(hand, aiCardsOfRank(hand, r, 1), DDZ_KIND_SINGLE, r, 1));
        }
    }
    else if (lk === DDZ_KIND_PAIR) {
        for (var r = lmain + 1; r < 13; r++) {
            if (c[r] < 2) {
                continue;
            }
            all.push(aiMakeMove(hand, aiCardsOfRank(hand, r, 2), DDZ_KIND_PAIR, r, 2));
        }
    }
    else if (lk === DDZ_KIND_TRIPLE) {
        for (var r = lmain + 1; r < 13; r++) {
            if (c[r] < 3) {
                continue;
            }
            all.push(aiMakeMove(hand, aiCardsOfRank(hand, r, 3), DDZ_KIND_TRIPLE, r, 3));
        }
    }
    else if (lk === DDZ_KIND_TRIPLE_WITH_SINGLE) {
        for (var r = lmain + 1; r < 13; r++) {
            if (c[r] < 3) {
                continue;
            }
            var base = aiCardsOfRank(hand, r, 3);
            var k = aiBestKickerSingle(hand, [r]);
            if (k.length === 1) {
                all.push(aiMakeMove(hand, base.concat(k), DDZ_KIND_TRIPLE_WITH_SINGLE, r, 4));
            }
        }
    }
    else if (lk === DDZ_KIND_TRIPLE_WITH_PAIR) {
        for (var r = lmain + 1; r < 13; r++) {
            if (c[r] < 3) {
                continue;
            }
            var base = aiCardsOfRank(hand, r, 3);
            var k = aiBestKickerPair(hand, [r]);
            if (k.length === 2) {
                all.push(aiMakeMove(hand, base.concat(k), DDZ_KIND_TRIPLE_WITH_PAIR, r, 5));
            }
        }
    }
    else if (lk === DDZ_KIND_STRAIGHT) {
        var len = lextra;
        for (var st = lmain - len + 2; st + len - 1 <= 11; st++) {
            if (st < 0) {
                continue;
            }
            var ok = true;
            for (var r = st; r < st + len; r++) {
                if (c[r] < 1) {
                    ok = false;
                    break;
                }
            }
            if (!ok) {
                continue;
            }
            var cards = [];
            for (var r = st; r < st + len; r++) {
                cards.push(aiCardsOfRank(hand, r, 1)[0]);
            }
            all.push(aiMakeMove(hand, cards, DDZ_KIND_STRAIGHT, st + len - 1, len));
        }
    }
    else if (lk === DDZ_KIND_PAIR_STRAIGHT) {
        var nPairs = (lextra / 2) | 0;
        for (var st = lmain - nPairs + 2; st + nPairs - 1 <= 11; st++) {
            if (st < 0) {
                continue;
            }
            var ok = true;
            for (var r = st; r < st + nPairs; r++) {
                if (c[r] < 2) {
                    ok = false;
                    break;
                }
            }
            if (!ok) {
                continue;
            }
            var cards = [];
            for (var r = st; r < st + nPairs; r++) {
                var pp = aiCardsOfRank(hand, r, 2);
                cards.push(pp[0], pp[1]);
            }
            all.push(aiMakeMove(hand, cards, DDZ_KIND_PAIR_STRAIGHT, st + nPairs - 1, nPairs * 2));
        }
    }
    else if (lk === DDZ_KIND_PLANE) {
        var k = lextra;
        for (var st = lmain - k + 2; st + k - 1 <= 11; st++) {
            if (st < 0) {
                continue;
            }
            var ok = true;
            for (var r = st; r < st + k; r++) {
                if (c[r] < 3) {
                    ok = false;
                    break;
                }
            }
            if (!ok) {
                continue;
            }
            var base = [];
            for (var r = st; r < st + k; r++) {
                var tt = aiCardsOfRank(hand, r, 3);
                base.push(tt[0], tt[1], tt[2]);
            }
            all.push(aiMakeMove(hand, base, DDZ_KIND_PLANE, st + k - 1, k));
        }
    }
    else if (lk === DDZ_KIND_PLANE_WITH_WINGS) {
        var k = lextra >> 5;
        var numPair = lextra & 31;
        /** rules.ts 允许混合翅膀（只要 singles+pairs==k 且 pairs==numPair），但"跟牌"要求 extra 完全相同，所以 numPair 固定。 */
        for (var st = lmain - k + 2; st + k - 1 <= 11; st++) {
            if (st < 0) {
                continue;
            }
            var ok = true;
            for (var r = st; r < st + k; r++) {
                if (c[r] < 3) {
                    ok = false;
                    break;
                }
            }
            if (!ok) {
                continue;
            }
            var base = [];
            var exR = [];
            for (var r = st; r < st + k; r++) {
                var tt = aiCardsOfRank(hand, r, 3);
                base.push(tt[0], tt[1], tt[2]);
                exR.push(r);
            }
            var wings = [];
            if (numPair === 0) {
                wings = aiBestKickerSingles(hand, exR, k);
            }
            else if (numPair === k) {
                wings = aiBestKickerPairs(hand, exR, k);
            }
            else {
                continue;
            }
            if (wings.length === 0) {
                continue;
            }
            all.push(aiMakeMove(hand, base.concat(wings), DDZ_KIND_PLANE_WITH_WINGS, st + k - 1, (k << 5) | numPair));
        }
    }
    else if (lk === DDZ_KIND_FOUR_WITH_TWO) {
        for (var r = lmain + 1; r < 13; r++) {
            if (c[r] < 4) {
                continue;
            }
            var four = aiCardsOfRank(hand, r, 4);
            if (lextra === 6) {
                var k = aiBestKickerSingles(hand, [r], 2);
                if (k.length === 2) {
                    all.push(aiMakeMove(hand, four.concat(k), DDZ_KIND_FOUR_WITH_TWO, r, 6));
                }
            }
            else if (lextra === 8) {
                var k = aiBestKickerPairs(hand, [r], 2);
                if (k.length === 4) {
                    all.push(aiMakeMove(hand, four.concat(k), DDZ_KIND_FOUR_WITH_TWO, r, 8));
                }
            }
        }
    }
    return all;
}
function aiEnumerateBombs(hand, lastBombMain) {
    var c = aiRankCounts(hand);
    var out = [];
    for (var r = lastBombMain + 1; r < 13; r++) {
        if (c[r] >= 4) {
            out.push(aiMakeMove(hand, aiCardsOfRank(hand, r, 4), DDZ_KIND_BOMB, r, 4));
        }
    }
    return out;
}
function aiEnumerateRocket(hand) {
    var c = aiRankCounts(hand);
    if (c[13] >= 1 && c[14] >= 1) {
        var sm = aiCardsOfRank(hand, 13, 1);
        var bg = aiCardsOfRank(hand, 14, 1);
        return [aiMakeMove(hand, sm.concat(bg), DDZ_KIND_ROCKET, 14, 2)];
    }
    return [];
}
function aiBuildCtx(state, seat) {
    var L = state.landlord;
    var isF = seat !== L;
    var mate = isF ? 3 - seat - L : -1;
    var n0 = state.hands[(seat + 1) % 3].length;
    var n1 = state.hands[(seat + 2) % 3].length;
    var cat = state.seatCat[seat] !== undefined ? state.seatCat[seat] : 0;
    return {
        me: seat,
        landlord: L,
        isFarmer: isF,
        mate: mate,
        lastPlayer: state.lastPlayer,
        passes: state.passes,
        minOpp: n0 < n1 ? n0 : n1,
        maxOpp: n0 > n1 ? n0 : n1,
        mateHand: mate >= 0 ? state.hands[mate].length : -1,
        landlordHand: state.hands[L].length,
        aiStyle: aiStyleFromCatId(cat),
        outside: aiRemainOutside(state, seat),
        ownSplits: aiMinSplits(state.hands[seat]),
    };
}
function aiIsAbsoluteBiggest(move, ctx) {
    if (move.kind === DDZ_KIND_ROCKET) {
        return true;
    }
    if (move.kind === DDZ_KIND_BOMB) {
        return !aiHasHigherBombOutside(ctx.outside, move.mainRank) && !aiHasRocketOutside(ctx.outside);
    }
    if (move.kind === DDZ_KIND_SINGLE) {
        return !aiHasHigherSingleOutside(ctx.outside, move.mainRank);
    }
    if (move.kind === DDZ_KIND_PAIR) {
        return !aiHasHigherPairOutside(ctx.outside, move.mainRank) && !aiHasAnyBombOutside(ctx.outside) && !aiHasRocketOutside(ctx.outside);
    }
    if (move.kind === DDZ_KIND_TRIPLE || move.kind === DDZ_KIND_TRIPLE_WITH_SINGLE || move.kind === DDZ_KIND_TRIPLE_WITH_PAIR) {
        return !aiHasHigherTripleOutside(ctx.outside, move.mainRank) && !aiHasAnyBombOutside(ctx.outside) && !aiHasRocketOutside(ctx.outside);
    }
    /** 顺/对子串/飞机/四带二：对手牌外是否还能压，走近似"外部同型主点不够高"判断 */
    if (move.kind === DDZ_KIND_STRAIGHT || move.kind === DDZ_KIND_PAIR_STRAIGHT
        || move.kind === DDZ_KIND_PLANE || move.kind === DDZ_KIND_PLANE_WITH_WINGS
        || move.kind === DDZ_KIND_FOUR_WITH_TWO) {
        /** 简化：主点越高越难被同型压；若无炸无火箭外阻，主点达 10 以上认为"较大" */
        var noBomb = !aiHasAnyBombOutside(ctx.outside);
        var noRocket = !aiHasRocketOutside(ctx.outside);
        return noBomb && noRocket && move.mainRank >= 10;
    }
    return false;
}
function aiIsAbsoluteBiggestLast(last, ctx) {
    var k = last.kind;
    if (k === DDZ_KIND_SINGLE) {
        return !aiHasHigherSingleOutside(ctx.outside, last.main);
    }
    if (k === DDZ_KIND_PAIR) {
        return !aiHasHigherPairOutside(ctx.outside, last.main);
    }
    if (k === DDZ_KIND_TRIPLE || k === DDZ_KIND_TRIPLE_WITH_SINGLE || k === DDZ_KIND_TRIPLE_WITH_PAIR) {
        return !aiHasHigherTripleOutside(ctx.outside, last.main);
    }
    return false;
}
function aiMateJustPlayed(ctx) {
    return ctx.isFarmer && ctx.mate === ctx.lastPlayer;
}
// ============================================================================
// 跟牌决策
// ============================================================================
function aiFarmerShouldYield(ctx, hand, last) {
    if (!aiMateJustPlayed(ctx)) {
        return false;
    }
    if (ctx.passes !== 1) {
        return false;
    }
    if (last.kind === DDZ_KIND_BOMB || last.kind === DDZ_KIND_ROCKET) {
        return false;
    }
    /** 队友已把这一手压到外部无可压：直接过 */
    if (aiIsAbsoluteBiggestLast(last, ctx)) {
        return true;
    }
    /** 队友马上要走完：放行 */
    if (ctx.mateHand <= 5 && ctx.landlordHand > ctx.mateHand + 1) {
        return true;
    }
    if (ctx.aiStyle === AI_STYLE_PASSIVE) {
        return true;
    }
    return false;
}
function aiShouldUseBomb(hand, ctx, _last) {
    if (!ctx.isFarmer && ctx.minOpp <= 2) {
        return true;
    }
    if (ctx.isFarmer && ctx.landlordHand <= 2) {
        return true;
    }
    if (ctx.isFarmer && ctx.mateHand >= 0 && ctx.mateHand <= 3) {
        return false;
    }
    if (ctx.aiStyle === AI_STYLE_PASSIVE) {
        return false;
    }
    var c = aiRankCounts(hand);
    for (var r = 0; r < 13; r++) {
        if (c[r] >= 4) {
            var cs = aiCardsOfRank(hand, r, 4);
            var after = aiMinSplitsAfter(hand, cs);
            if (ctx.ownSplits - after >= 1) {
                return true;
            }
        }
    }
    return false;
}
function aiShouldUseRocket(ctx) {
    if (!ctx.isFarmer && ctx.minOpp <= 1) {
        return true;
    }
    if (ctx.isFarmer && ctx.landlordHand <= 1) {
        return true;
    }
    return false;
}
function aiShouldForceBombOverSameKind(ctx) {
    if (!ctx.isFarmer && ctx.minOpp <= 1) {
        return true;
    }
    if (ctx.isFarmer && ctx.landlordHand <= 1) {
        return true;
    }
    return false;
}
function aiScoreFollowMove(m, ctx) {
    var splitsSaved = ctx.ownSplits - m.splitsAfter;
    var score = -m.splitsAfter * 20 + splitsSaved * 4 - m.useHigh * 4 - m.mainRank * 0.4;
    if (aiIsAbsoluteBiggest(m, ctx)) {
        score += 60;
    }
    if (m.kind === DDZ_KIND_SINGLE && m.mainRank >= 12 && ctx.ownSplits >= 3) {
        score -= 20;
    }
    if (ctx.isFarmer && ctx.landlordHand <= 3) {
        score += 25;
    }
    if (!ctx.isFarmer && ctx.minOpp <= 2) {
        score += 30;
    }
    return score;
}
function aiPickBestFollow(hand, last, ctx) {
    if (aiFarmerShouldYield(ctx, hand, last)) {
        return [];
    }
    var moves = aiEnumerateFollowMoves(hand, last);
    var bestScore = -1e9;
    var bestMove = null;
    for (var i = 0; i < moves.length; i++) {
        var s = aiScoreFollowMove(moves[i], ctx);
        if (s > bestScore) {
            bestScore = s;
            bestMove = moves[i];
        }
    }
    /** 同型打不出来：看是否该炸 */
    if (bestMove === null) {
        if (aiShouldUseBomb(hand, ctx, last)) {
            var bombs = aiEnumerateBombs(hand, last.kind === DDZ_KIND_BOMB ? last.main : -1);
            if (bombs.length > 0) {
                return bombs[0].cards;
            }
        }
        if (aiShouldUseRocket(ctx)) {
            var rockets = aiEnumerateRocket(hand);
            if (rockets.length > 0) {
                return rockets[0].cards;
            }
        }
        return [];
    }
    /** 同型能压，但锁胜/必炸场景里仍然走炸 */
    if (aiShouldForceBombOverSameKind(ctx)) {
        var bombs = aiEnumerateBombs(hand, -1);
        if (bombs.length > 0) {
            return bombs[0].cards;
        }
    }
    return bestMove.cards;
}
// ============================================================================
// 首出决策
// ============================================================================
function aiScoreLeadMove(m, ctx) {
    var score = -m.splitsAfter * 22 - m.useHigh * 3 - m.mainRank * 0.4;
    if (m.kind === DDZ_KIND_STRAIGHT || m.kind === DDZ_KIND_PAIR_STRAIGHT
        || m.kind === DDZ_KIND_PLANE || m.kind === DDZ_KIND_PLANE_WITH_WINGS) {
        score += 6;
    }
    if (ctx.isFarmer && m.kind === DDZ_KIND_SINGLE && m.mainRank <= 6) {
        score += 2;
    }
    if (aiIsAbsoluteBiggest(m, ctx)) {
        score += 12;
    }
    if (m.kind === DDZ_KIND_SINGLE && m.mainRank >= 12 && ctx.ownSplits >= 3) {
        score -= 25;
    }
    return score;
}
function aiPickBestLead(hand, ctx) {
    var moves = aiEnumerateLeadMoves(hand);
    var bombs = aiEnumerateBombs(hand, -1);
    var rockets = aiEnumerateRocket(hand);
    /** 能一手走完（任何动作使 splitsAfter === 0）：优先走最快的 */
    for (var i = 0; i < moves.length; i++) {
        if (moves[i].splitsAfter === 0) {
            return moves[i].cards;
        }
    }
    if (bombs.length > 0 && bombs[0].splitsAfter === 0) {
        return bombs[0].cards;
    }
    if (rockets.length > 0 && rockets[0].splitsAfter === 0) {
        return rockets[0].cards;
    }
    var bestScore = -1e9;
    var bestMove = null;
    for (var i = 0; i < moves.length; i++) {
        var s = aiScoreLeadMove(moves[i], ctx);
        if (s > bestScore) {
            bestScore = s;
            bestMove = moves[i];
        }
    }
    if (bestMove !== null) {
        return bestMove.cards;
    }
    var sorted = aiSortCardsAsc(hand);
    return [sorted[0]];
}
// ============================================================================
// 入口：baseline（Tier A，规则分策略，用于 rollout 驱动）
// ============================================================================
function aiRunPlayTurnBaseline(state, seat) {
    var hand = state.hands[seat];
    if (hand.length === 0) {
        return;
    }
    var ctx = aiBuildCtx(state, seat);
    var last = state.lastPattern;
    var trickFree = !last || last.kind === DDZ_KIND_PASS || state.passes >= 2;
    var cards = [];
    if (trickFree) {
        cards = aiPickBestLead(hand, ctx);
        if (cards.length === 0) {
            cards = [aiSortCardsAsc(hand)[0]];
        }
    }
    else {
        cards = aiPickBestFollow(hand, last, ctx);
        if (cards.length === 0) {
            applyPass(state, seat);
            return;
        }
    }
    applyPlay(state, seat, cards);
}
/**
 * 数组相等（长度+元素完全一致，忽略顺序通过先排序）。仅用于候选去重。
 */
function aiCandSameCards(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    if (a.length === 0) {
        return true;
    }
    var sa = [];
    var sb = [];
    for (var i = 0; i < a.length; i++) {
        sa.push(a[i]);
        sb.push(b[i]);
    }
    sa.sort(function (x, y) { return x - y; });
    sb.sort(function (x, y) { return x - y; });
    for (var i = 0; i < sa.length; i++) {
        if (sa[i] !== sb[i]) {
            return false;
        }
    }
    return true;
}
function aiCandContains(list, cards) {
    for (var i = 0; i < list.length; i++) {
        if (list[i].isPass) {
            continue;
        }
        if (aiCandSameCards(list[i].cards, cards)) {
            return true;
        }
    }
    return false;
}
/**
 * Top-K 首出候选：评分排序后取前 K 个；同时把"炸弹/火箭"也纳入候选（即便分数不高，
 * rollout 也会自行淘汰它们）。目的是让搜索看见 Tier A 启发式之外的可能动作。
 */
function aiTopKLeadCandidates(hand, ctx, k) {
    var moves = aiEnumerateLeadMoves(hand);
    var bombs = aiEnumerateBombs(hand, -1);
    var rockets = aiEnumerateRocket(hand);
    /** 能一手走完：直接只给这一个候选，无需 rollout。 */
    for (var i = 0; i < moves.length; i++) {
        if (moves[i].splitsAfter === 0) {
            return [{ cards: moves[i].cards, isPass: false, heur: 1e9 }];
        }
    }
    if (bombs.length > 0 && bombs[0].splitsAfter === 0) {
        return [{ cards: bombs[0].cards, isPass: false, heur: 1e9 }];
    }
    if (rockets.length > 0 && rockets[0].splitsAfter === 0) {
        return [{ cards: rockets[0].cards, isPass: false, heur: 1e9 }];
    }
    var scored = [];
    for (var i = 0; i < moves.length; i++) {
        scored.push({ cards: moves[i].cards, isPass: false, heur: aiScoreLeadMove(moves[i], ctx) });
    }
    scored.sort(function (a, b) { return b.heur - a.heur; });
    var out = [];
    var maxK = k > 0 ? k : 1;
    for (var i = 0; i < scored.length && out.length < maxK; i++) {
        if (!aiCandContains(out, scored[i].cards)) {
            out.push(scored[i]);
        }
    }
    /** 炸弹/火箭：首出时一般不炸；但给 rollout 留一个验证通道。 */
    for (var i = 0; i < bombs.length; i++) {
        if (!aiCandContains(out, bombs[i].cards)) {
            out.push({ cards: bombs[i].cards, isPass: false, heur: -1000 });
            break;
        }
    }
    for (var i = 0; i < rockets.length; i++) {
        if (!aiCandContains(out, rockets[i].cards)) {
            out.push({ cards: rockets[i].cards, isPass: false, heur: -1000 });
            break;
        }
    }
    if (out.length === 0) {
        var sorted = aiSortCardsAsc(hand);
        out.push({ cards: [sorted[0]], isPass: false, heur: 0 });
    }
    return out;
}
/**
 * Top-K 跟牌候选：同型跟牌按启发式取前 K；同时把"过""炸弹""火箭"加入候选。
 * rollout 会自行比较不同决策后的最终分差。
 */
function aiTopKFollowCandidates(hand, last, ctx, k) {
    var moves = aiEnumerateFollowMoves(hand, last);
    var scored = [];
    for (var i = 0; i < moves.length; i++) {
        scored.push({ cards: moves[i].cards, isPass: false, heur: aiScoreFollowMove(moves[i], ctx) });
    }
    scored.sort(function (a, b) { return b.heur - a.heur; });
    var out = [];
    var maxK = k > 0 ? k : 1;
    for (var i = 0; i < scored.length && out.length < maxK; i++) {
        if (!aiCandContains(out, scored[i].cards)) {
            out.push(scored[i]);
        }
    }
    /** 过：除"无牌可出"外，也加入候选让 rollout 自行评估要不要送牌。 */
    out.push({ cards: [], isPass: true, heur: -500 });
    /** 炸弹：比上家大的最小炸；rollout 判断值不值得炸。 */
    var bombs = aiEnumerateBombs(hand, last.kind === DDZ_KIND_BOMB ? last.main : -1);
    if (bombs.length > 0 && !aiCandContains(out, bombs[0].cards)) {
        out.push({ cards: bombs[0].cards, isPass: false, heur: -600 });
    }
    /** 火箭：不被炸弹/火箭压过时，可加入。 */
    if (last.kind !== DDZ_KIND_ROCKET) {
        var rockets = aiEnumerateRocket(hand);
        if (rockets.length > 0 && !aiCandContains(out, rockets[0].cards)) {
            out.push({ cards: rockets[0].cards, isPass: false, heur: -700 });
        }
    }
    return out;
}
/**
 * 状态克隆：保留影响游戏推进和得分的全部字段；广播/玩家/发牌轨迹等清空。
 * isAiSeat 全置 true，这样 rollout 内的推进循环会把三家都当 AI 驱动。
 */
function aiCloneStateForRollout(st) {
    var c = {
        presences: {},
        seatByUserId: {},
        expectHumans: 0,
        aiCount: 3,
        isAiSeat: [true, true, true],
        phase: st.phase,
        hands: [st.hands[0].slice(), st.hands[1].slice(), st.hands[2].slice()],
        bottom: st.bottom.slice(),
        bids: st.bids.slice(),
        callCandidate: st.callCandidate,
        robStep: st.robStep,
        landlord: st.landlord,
        turn: st.turn,
        lastPattern: st.lastPattern
            ? { kind: st.lastPattern.kind, main: st.lastPattern.main, extra: st.lastPattern.extra }
            : null,
        lastPlayer: st.lastPlayer,
        passes: st.passes,
        winner: st.winner,
        multBase: st.multBase,
        multRob: st.multRob,
        multPlay: st.multPlay,
        robCount: st.robCount,
        playBombCount: st.playBombCount,
        playRocketCount: st.playRocketCount,
        lastRobber: st.lastRobber,
        lastPlayIds: st.lastPlayIds.slice(),
        dealSeed: st.dealSeed,
        seq: st.seq,
        awaitSeat: st.awaitSeat,
        callRoundStartSeat: st.callRoundStartSeat,
        robActionSeq: st.robActionSeq,
        lastRobActionSeat: st.lastRobActionSeat,
        lastRobActionWasRob: st.lastRobActionWasRob,
        lastRobSkippedNoBid: st.lastRobSkippedNoBid,
        bidPassFlags: st.bidPassFlags.slice(),
        errorLog: [],
        continueReady: st.continueReady.slice(),
        seatCat: st.seatCat.slice(),
        aiPlayDelayUntilMs: 0,
        bottomRevealIds: st.bottomRevealIds.slice(),
        dealTrace: [],
        seenCount: (st.seenCount && st.seenCount.length === 15) ? st.seenCount.slice() : (function () {
            var a = [];
            for (var i = 0; i < 15; i++) {
                a.push(0);
            }
            return a;
        })(),
    };
    return c;
}
/**
 * rollout：用 baseline AI 推演到 play 结束或 finished。
 * 由于 baseline 完全确定，单次推演足够；保护 guard 防死循环。
 */
function aiRolloutPlayToEnd(st) {
    var guard = 0;
    while (guard++ < 240) {
        if (st.phase !== "play") {
            break;
        }
        aiRunPlayTurnBaseline(st, st.turn);
        if (st.winner >= 0 || st.phase === "finished") {
            break;
        }
    }
    return computeScoreDeltas(st);
}
/**
 * Tier B：每步 AI 用 Top-K 候选动作 × 克隆推演，取自身分差最大者。
 * 候选数量 K 固定较小（首出 4、跟牌 4），总计开销可控。
 */
var AI_TIER_B_LEAD_TOPK = 4;
var AI_TIER_B_FOLLOW_TOPK = 4;
function aiRunPlayTurn(state, seat) {
    var hand = state.hands[seat];
    if (hand.length === 0) {
        return;
    }
    var ctx = aiBuildCtx(state, seat);
    var last = state.lastPattern;
    var trickFree = !last || last.kind === DDZ_KIND_PASS || state.passes >= 2;
    var candidates;
    if (trickFree) {
        candidates = aiTopKLeadCandidates(hand, ctx, AI_TIER_B_LEAD_TOPK);
    }
    else {
        candidates = aiTopKFollowCandidates(hand, last, ctx, AI_TIER_B_FOLLOW_TOPK);
    }
    if (candidates.length === 0) {
        /** 理论不应出现：fallback 最小单张 */
        applyPlay(state, seat, [aiSortCardsAsc(hand)[0]]);
        return;
    }
    /** 单候选（如 Top-K 收集器返回"一手走完"）：免去 rollout */
    if (candidates.length === 1) {
        var only = candidates[0];
        if (only.isPass) {
            applyPass(state, seat);
        }
        else {
            applyPlay(state, seat, only.cards);
        }
        return;
    }
    var bestSum = -1e18;
    var bestIdx = 0;
    for (var i = 0; i < candidates.length; i++) {
        var act = candidates[i];
        var clone = aiCloneStateForRollout(state);
        if (act.isPass) {
            /** 过在某些场景下非法（如自己领出），这时跳过该候选 */
            if (!(last && last.kind !== DDZ_KIND_PASS && state.passes < 2)) {
                continue;
            }
            applyPass(clone, seat);
        }
        else {
            applyPlay(clone, seat, act.cards);
        }
        var deltas = aiRolloutPlayToEnd(clone);
        var mine = deltas[seat];
        if (mine > bestSum) {
            bestSum = mine;
            bestIdx = i;
        }
    }
    var chosen = candidates[bestIdx];
    if (chosen.isPass) {
        applyPass(state, seat);
    }
    else {
        applyPlay(state, seat, chosen.cards);
    }
}
function aiRunBidTurn(state, seat, nk) {
    var hand = state.hands[seat];
    var cat = state.seatCat[seat] !== undefined ? state.seatCat[seat] : 0;
    var style = aiStyleFromCatId(cat);
    var bid = aiChooseBid(hand, style);
    applyBid(state, seat, bid, nk);
}
function aiRunRobTurn(state, seat) {
    var hand = state.hands[seat];
    var cat = state.seatCat[seat] !== undefined ? state.seatCat[seat] : 0;
    var style = aiStyleFromCatId(cat);
    var curMult = state.multBase * state.multRob;
    var rob = aiChooseRobLandlord(hand, curMult, style);
    applyRob(state, seat, rob);
}
/** AI 叫/抢/连出的客户端动画对齐延迟（与旧值一致） */
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
// @ts-nocheck
/**
 * 掼蛋服务端 AI（M1 版：覆盖 单 / 对 / 三 / 炸弹 / 天王炸 的拆牌与跟牌）。
 *
 * 策略概要：
 *  - 维持旧的「节奏」骨架：每决策一次设 aiPlayDelayUntilMs，matchLoop 每 tick 推进一步。
 *  - 分析手牌：按 rawRank 聚合（红心级牌单独归为 wilds）；派生 singles/pairs/triples/bombs。
 *  - Free lead（领出）：`gdAiFreeLeadMain` — n≤12 时 2^n 子集 + `gdScoreFreeLeadIds`（含顺子/连对/钢板/三带二型赏分）；n>12 时枚举 C(n,k), k∈[4..8] 选最高「剩牌估值+型赏+动炸罚」；并与 `gdAiLead` 小单基准比选优。
 *  - Follow：单/对/三走结构；顺/连对/钢板/三带二用顶序或 (tripleR,pairR) 枚举；炸弹/同花顺跟牌先合并「点力炸候选 + 同花顺构造」再 L3，避免大 k 的 C(n,k)；仍保留爆搜作百搭等边角兜底。
 *  - 记牌：**ghost**（已打出张数）+ 他家手牌长度 → **动炸犹豫**（对手王/2 仍多时不轻易甩大炸）、**领出情境分**（送游 / 卡下家）。
 *  - 送游：当 **上家(当前赢家)为队友** 时，跟牌**主动 pass**；**自由领出**时队友少张则加成分小牌、罚大炸；`gdAiLead` 在队友 ≤3 张时拆对/三出最小单。
 *  - 卡下家：下家为对手且 ≤5 张时，弱惩罚「过小单」，略奖励对/三控一下。
 *  - L3 牌型价值：多组合法跟法（多枚炸、爆搜多解）时，用 **gdAiEvaluateRemainingHand** 与出炸惩罚选分数最高。
 *  - L4 残局：手牌张数 ≤`GD_AI_L4_LEAD_MAX_CARDS` 时自由领出 **2^n** 子集；手牌较短时跟牌爆搜能压牌型（tries/out 有顶）再 L3；优先 **一手出完**。
 *  - 性能：云主机上单局 match 须轻量；K 组合 / 爆搜 / L3 候选数均有硬顶，避免单 tick 卡死。
 *  - 贡 / 抗贡 / 还贡 / 继续：沿用 v0。
 *
 * 避免死循环：
 *  - Free lead 永远能出牌（手里必有至少 1 张）；
 *  - Follow 若无计可施直接 pass，一圈全 pass 后回到 lead 且会出单张，不会死锁。
 *
 * 注意（与 ddz/ai_server 同）：本文件在 tsconfig files 数组中排在 main.ts 之后，
 * 依赖前向声明的 rules.ts / match_state.ts / match_logic.ts 全局符号。
 */
/** 掼蛋双副：同 rawRank 的牌张数（含双小王/双大王=各 2 张，其余 8 张/点） */
function gdCopyCapForRawRank(rr) {
    if (rr === GD_RAW_RANK_SMALL_JOKER || rr === GD_RAW_RANK_BIG_JOKER) {
        return 2;
    }
    if (rr >= 0 && rr <= 12) {
        return 8;
    }
    return 0;
}
/**
 * 全桌「可见」各 raw 张数：四家手牌 + 当前桌上一手（lastPlayIds）。
 * 不含量牌堆/历史已收走的牌，故用 ghost = cap − visible 得「已出散牌」量。
 */
function gdTallyVisibleRanksInHandsAndTable(state) {
    var cnt = new Array(15).fill(0);
    for (var s = 0; s < 4; s++) {
        var h = state.hands[s];
        for (var i = 0; i < h.length; i++) {
            var rr = gdRawRank(h[i]);
            if (rr >= 0 && rr < cnt.length) {
                cnt[rr]++;
            }
        }
    }
    if (state.lastPlayIds) {
        for (var j = 0; j < state.lastPlayIds.length; j++) {
            var rr = gdRawRank(state.lastPlayIds[j]);
            if (rr >= 0 && rr < cnt.length) {
                cnt[rr]++;
            }
        }
    }
    return cnt;
}
function gdGhostRanksDealtOrPlayed(state) {
    var vis = gdTallyVisibleRanksInHandsAndTable(state);
    var g = new Array(15).fill(0);
    for (var rr = 0; rr <= 14; rr++) {
        g[rr] = Math.max(0, gdCopyCapForRawRank(rr) - vis[rr]);
    }
    return g;
}
/** 某 rawRank 在除我以外三家手里的张数（精确，用于场况） */
function gdAiEstRankElsewhere(state, seat, rr) {
    var n = 0;
    for (var s = 0; s < 4; s++) {
        if (s === seat) {
            continue;
        }
        var h = state.hands[s];
        for (var i = 0; i < h.length; i++) {
            if (gdRawRank(h[i]) === rr) {
                n++;
            }
        }
    }
    return n;
}
/** 对手手中王的压力（越大越可能还有大炸），用于动炸犹豫 */
function gdAiJokersPressure(state, seat) {
    var mate = gdTeammateSeat(seat);
    var sj = 0;
    var bj = 0;
    for (var s = 0; s < 4; s++) {
        if (s === seat || s === mate) {
            continue;
        }
        var h = state.hands[s];
        for (var i = 0; i < h.length; i++) {
            var rr = gdRawRank(h[i]);
            if (rr === GD_RAW_RANK_SMALL_JOKER) {
                sj++;
            }
            else if (rr === GD_RAW_RANK_BIG_JOKER) {
                bj++;
            }
        }
    }
    return sj * 1.15 + bj * 1.55;
}
/**
 * 跟牌 / 多候选 L3：炸弹、天炸、同花顺 — 对手王多则减分；对手快游时大单略加分。
 */
function gdAiPlayThreatAdjustment(state, seat, p, ids) {
    void ids;
    var adj = 0;
    if (p.bombTier > 0 || p.kind === GD_KIND_KING_BOMB || p.kind === GD_KIND_STRAIGHT_FLUSH) {
        var jp = gdAiJokersPressure(state, seat);
        adj -= jp * 0.32;
        if (p.bombTier >= GD_BOMB_TIER_6) {
            adj -= gdAiEstRankElsewhere(state, seat, GD_RAW_RANK_2) * 0.07;
        }
    }
    if (p.kind === GD_KIND_SINGLE && ids.length === 1) {
        var rv = gdRankValue(ids[0], state.levelRankActive);
        if (rv >= 14) {
            var nextS = (seat + 1) % 4;
            if (nextS !== gdTeammateSeat(seat) && state.hands[nextS].length <= 3 && state.hands[nextS].length > 0) {
                adj += 0.45;
            }
        }
    }
    return adj;
}
/**
 * 自由领出额外分：送游（队友少张）、卡下家（下家对手短手）、对手有人快游时略鼓励控场炸。
 */
function gdAiFreeLeadCtx(_hand, ids, _lvl, p, rem, state, seat) {
    void _hand;
    void _lvl;
    var b = 0;
    var mate = gdTeammateSeat(seat);
    var mateLen = state.hands[mate].length;
    var isBombPlay = p.bombTier > 0 || p.kind === GD_KIND_KING_BOMB || p.kind === GD_KIND_STRAIGHT_FLUSH;
    if (mateLen <= 6 && mateLen > 0) {
        var coef = (7 - mateLen) * 0.24;
        if (p.kind === GD_KIND_SINGLE && p.main <= 9) {
            b += coef * 1.05;
        }
        if (isBombPlay) {
            b -= coef * 1.35;
        }
        if (ids.length >= 5 && !isBombPlay) {
            b += coef * 0.12;
        }
    }
    if (mateLen <= 3 && mateLen > 0) {
        if (p.kind === GD_KIND_SINGLE) {
            b += 1.05;
        }
        if (isBombPlay) {
            b -= 2.0;
        }
    }
    var nextS = (seat + 1) % 4;
    if (nextS !== mate && state.hands[nextS].length <= 5 && state.hands[nextS].length > 0) {
        if (p.kind === GD_KIND_SINGLE && p.main <= 6) {
            b -= 0.5;
        }
        if (p.kind === GD_KIND_PAIR || p.kind === GD_KIND_TRIPLE) {
            b += 0.32;
        }
    }
    var minOpp = 99;
    for (var s = 0; s < 4; s++) {
        if (s === seat || s === mate) {
            continue;
        }
        minOpp = Math.min(minOpp, state.hands[s].length);
    }
    if (minOpp <= 4 && minOpp > 0) {
        if (p.bombTier === GD_BOMB_TIER_4 || p.bombTier === GD_BOMB_TIER_5) {
            b += 0.22;
        }
        if (p.kind === GD_KIND_SINGLE && rem.length > 10) {
            b -= 0.12;
        }
    }
    var ghost = gdGhostRanksDealtOrPlayed(state);
    var jokerOut = ghost[GD_RAW_RANK_SMALL_JOKER] + ghost[GD_RAW_RANK_BIG_JOKER];
    if (isBombPlay && jokerOut <= 1 && gdAiJokersPressure(state, seat) >= 2.5) {
        b -= 0.35;
    }
    return b;
}
/** 当前赢家是否为队友；为真时跟牌不压，送游。 */
function gdAiIsPartnerControllingTrick(state, seat) {
    return state.lastPlayer === gdTeammateSeat(seat);
}
/** 抗贡：末游方大王合计 ≥2 时，任一进贡方可点抗贡 */
function gdAiShouldResist(state, seat) {
    return state.tribute.payers.indexOf(seat) >= 0 && gdCanResistTribute(state);
}
/** 贡牌：选「非红心级牌中点力最大的一张」；若全是红心级牌则退而出之 */
function gdAiPickTributeCard(state, seat) {
    var hand = state.hands[seat];
    var lvl = state.levelRankActive;
    var bestId = -1;
    var bestVal = -1;
    for (var i = 0; i < hand.length; i++) {
        var id = hand[i];
        if (gdIsHeartLevelCard(id, lvl)) {
            continue;
        }
        var v = gdRankValue(id, lvl);
        if (v > bestVal) {
            bestVal = v;
            bestId = id;
        }
    }
    if (bestId < 0) {
        for (var i = 0; i < hand.length; i++) {
            if (gdIsHeartLevelCard(hand[i], lvl)) {
                return hand[i];
            }
        }
    }
    return bestId;
}
/** 还贡：rawRank≤7（≤10）合法牌中，优先剩牌结构估值最高；同分则保留「同花色在手中较多」的牌（略符「花色多」文档意向） */
function gdAiPickReturnCard(state, seat) {
    var hand = state.hands[seat];
    var lvl = state.levelRankActive;
    var candidates = [];
    for (var i = 0; i < hand.length; i++) {
        var id = hand[i];
        var rr = gdRawRank(id);
        if (gdIsHeartLevelCard(id, lvl)) {
            continue;
        }
        if (rr <= 7) {
            candidates.push(id);
            continue;
        }
        if (rr === GD_RAW_RANK_2 && lvl !== GD_RAW_RANK_2) {
            candidates.push(id);
        }
    }
    if (candidates.length === 0) {
        return -1;
    }
    var bestId = candidates[0];
    var bestS = -1e15;
    for (var ci = 0; ci < candidates.length; ci++) {
        var id = candidates[ci];
        var rem = gdAiRemovePlayFromHand(hand, [id]);
        var s = gdAiEvaluateRemainingHand(rem, lvl);
        var su = gdSuit(id);
        if (su >= 0) {
            var sameSuitLeft = 0;
            for (var j = 0; j < hand.length; j++) {
                if (hand[j] !== id && gdSuit(hand[j]) === su) {
                    sameSuitLeft++;
                }
            }
            s += sameSuitLeft * 0.05;
        }
        if (s > bestS) {
            bestS = s;
            bestId = id;
        }
    }
    return bestId;
}
function gdAiAnalyze(hand, lvl) {
    var wilds = [];
    var ranks = {};
    for (var i = 0; i < hand.length; i++) {
        var id = hand[i];
        if (gdIsHeartLevelCard(id, lvl)) {
            wilds.push(id);
            continue;
        }
        var rr = gdRawRank(id);
        var k = String(rr);
        if (!ranks[k]) {
            ranks[k] = [];
        }
        ranks[k].push(id);
    }
    var singlesRanks = [];
    var pairsRanks = [];
    var triplesRanks = [];
    var bombRanks = [];
    for (var k in ranks) {
        if (!ranks.hasOwnProperty(k)) {
            continue;
        }
        var rr = parseInt(k, 10);
        var c = ranks[k].length;
        if (c >= 4) {
            bombRanks.push(rr);
        }
        else if (c === 3) {
            triplesRanks.push(rr);
        }
        else if (c === 2) {
            pairsRanks.push(rr);
        }
        else if (c === 1) {
            singlesRanks.push(rr);
        }
    }
    function byVal(a, b) {
        return gdRankValueFromRaw(a, lvl) - gdRankValueFromRaw(b, lvl);
    }
    singlesRanks.sort(byVal);
    pairsRanks.sort(byVal);
    triplesRanks.sort(byVal);
    bombRanks.sort(byVal);
    return {
        hand: hand,
        lvl: lvl,
        wilds: wilds,
        ranks: ranks,
        singlesRanks: singlesRanks,
        pairsRanks: pairsRanks,
        triplesRanks: triplesRanks,
        bombRanks: bombRanks,
    };
}
/** ----------- Free lead -----------
 *  @param mateHandLen 队友剩牌：≤3 时拆对/三走最小单帮送游。
 */
function gdAiLead(a, mateHandLen) {
    var mateRush = mateHandLen > 0 && mateHandLen <= 3;
    if (mateRush) {
        for (var i = 0; i < a.singlesRanks.length; i++) {
            var rr = a.singlesRanks[i];
            if (rr < 13) {
                return { pass: false, ids: [a.ranks[String(rr)][0]] };
            }
        }
        if (a.pairsRanks.length > 0) {
            var rr = a.pairsRanks[0];
            return { pass: false, ids: [a.ranks[String(rr)][0]] };
        }
        if (a.triplesRanks.length > 0) {
            var rr = a.triplesRanks[0];
            return { pass: false, ids: [a.ranks[String(rr)][0]] };
        }
    }
    /** 非送游：先出最小对子（保留结构），再出散单，减少「只打小单、乱拆对」 */
    if (a.pairsRanks.length > 0) {
        var rr = a.pairsRanks[0];
        if (rr < 13) {
            return { pass: false, ids: a.ranks[String(rr)].slice(0, 2) };
        }
    }
    // 1. 最小单张（非王）
    for (var i = 0; i < a.singlesRanks.length; i++) {
        var rr = a.singlesRanks[i];
        if (rr < 13) {
            return { pass: false, ids: [a.ranks[String(rr)][0]] };
        }
    }
    // 2. 最小三张
    if (a.triplesRanks.length > 0) {
        var rr = a.triplesRanks[0];
        return { pass: false, ids: a.ranks[String(rr)].slice(0, 3) };
    }
    // 4. 王（小王优先于大王）作为单张
    for (var i = 0; i < a.singlesRanks.length; i++) {
        var rr = a.singlesRanks[i];
        if (rr >= 13) {
            return { pass: false, ids: [a.ranks[String(rr)][0]] };
        }
    }
    // 5. 只剩炸：出最小炸（原生张数，不加 wild）
    if (a.bombRanks.length > 0) {
        var rr = a.bombRanks[0];
        var cnt = a.ranks[String(rr)].length;
        var use = Math.min(cnt, 8);
        return { pass: false, ids: a.ranks[String(rr)].slice(0, use) };
    }
    // 6. 只剩红心级牌：单张出
    if (a.wilds.length > 0) {
        return { pass: false, ids: [a.wilds[0]] };
    }
    return { pass: true, ids: [] };
}
/** 领出时鼓励顺子/连对/钢板/三带二（非炸），与剩余手 L3 估值一起用，避免只出小单。 */
function gdLeadPatternTypeBonus(pat) {
    var k = pat.kind;
    if (k === GD_KIND_STRAIGHT) {
        return 1.7;
    }
    if (k === GD_KIND_PAIR_STRAIGHT) {
        return 2.55;
    }
    if (k === GD_KIND_TRIPLE_STRAIGHT) {
        return 2.2;
    }
    if (k === GD_KIND_TRIPLE_WITH_PAIR) {
        return 1.65;
    }
    if (k === GD_KIND_STRAIGHT_FLUSH) {
        return 0.25;
    }
    return 0;
}
/**
 * 中局仍较肥时，惩罚「本手带走过多点力」的领出，避免为吃型赏提前甩光 A/级牌/王，剩小点散张（仅扫 ids，O(1)）。
 */
function gdFreeLeadNonTerminalHighBurn(remLen, ids, lvl) {
    if (remLen <= 7) {
        return 0;
    }
    var sum = 0;
    for (var i = 0; i < ids.length; i++) {
        var v = gdRankValue(ids[i], lvl);
        if (v < 0) {
            sum += 1.0;
        }
        else {
            sum += v;
        }
    }
    var scale = remLen * 0.006;
    /** 略加重：领出时少甩 A/王/级牌等大点，避免中后期只剩小散张 */
    return sum * 0.16 * (1.0 + scale);
}
/** 自由领出统一打分：能一手走完给极大分；可选 ctx 注入送游/卡下家/记牌。 */
function gdScoreFreeLeadIds(hand, ids, lvl, ctx) {
    if (ids.length < 1) {
        return -1e20;
    }
    var p = gdClassify(ids, lvl);
    if (p.kind === GD_KIND_INVALID) {
        return -1e20;
    }
    var rem = gdAiRemovePlayFromHand(hand, ids);
    if (rem.length === 0) {
        return 1e12;
    }
    var s = gdAiEvaluateRemainingHand(rem, lvl) +
        gdAiLeadFreeBonus(p, ids.length) +
        gdLeadPatternTypeBonus(p) +
        Math.min(0.25 * ids.length, 1.0) -
        gdFreeLeadNonTerminalHighBurn(rem.length, ids, lvl);
    /** 拆对/拆三出单：强罚，抑制「只出单张」 */
    if (p.kind === GD_KIND_SINGLE && ids.length === 1) {
        var a0 = gdAiAnalyze(hand, lvl);
        var a1 = gdAiAnalyze(rem, lvl);
        if (a0.pairsRanks.length > a1.pairsRanks.length) {
            s -= 2.35;
        }
        if (a0.triplesRanks.length > a1.triplesRanks.length) {
            s -= 3.2;
        }
        s -= 0.18;
    }
    if (ctx) {
        s += gdAiFreeLeadCtx(hand, ids, lvl, p, rem, ctx.state, ctx.seat);
    }
    return s;
}
/** 下标 0..n-1 的 k-组合，Lex 顺序，最多 maxOut 个；访问器返回 true 时提前停。
 *  传入的 idx 在同一次回调返回前有效，下一轮会原地改写，请勿异步持有引用。 */
function gdEachKCombinationIndices(n, k, onEach, maxOut) {
    if (k < 0 || k > n || maxOut < 1) {
        return;
    }
    var idx = new Array(k);
    for (var i = 0; i < k; i++) {
        idx[i] = i;
    }
    var count = 0;
    for (;;) {
        if (onEach(idx) === true) {
            return;
        }
        count++;
        if (count >= maxOut) {
            return;
        }
        var s = k - 1;
        while (s >= 0 && idx[s] === n - k + s) {
            s--;
        }
        if (s < 0) {
            return;
        }
        idx[s] += 1;
        for (var j = s + 1; j < k; j++) {
            idx[j] = idx[j - 1] + 1;
        }
    }
}
/**
 * 枚举 n 选 k 的组合总数（不展开），用于定 cap
 */
function gdBinomialEstimate(n, k) {
    if (k < 0 || k > n) {
        return 0;
    }
    if (k > n - k) {
        k = n - k;
    }
    var c = 1;
    for (var i = 0; i < k; i++) {
        c = (c * (n - i)) / (i + 1) | 0;
    }
    return c;
}
/**
 * 在「手牌过多无法 2^n」时，用 k=4/5/6 子集 + gdClassify 找顺子/连对/三带二/炸等可领出牌型，取分最高者。
 */
function gdAiFreeLeadKComboBest(hand, lvl, ctx) {
    var n = hand.length;
    if (n < 4) {
        return null;
    }
    var sorted = hand
        .slice()
        .sort(function (a, b) {
        return a - b;
    });
    var best = null;
    var bestS = -1e20;
    function consider(ids) {
        var sc = gdScoreFreeLeadIds(hand, ids, lvl, ctx);
        if (sc > 1e9) {
            best = ids;
            bestS = sc;
        }
        else if (sc > bestS) {
            bestS = sc;
            best = ids;
        }
    }
    var kSizes = [4, 5, 6, 7, 8, 10, 12];
    for (var ki = 0; ki < kSizes.length; ki++) {
        var k = kSizes[ki];
        if (n < k) {
            continue;
        }
        var total = gdBinomialEstimate(n, k);
        var cap = Math.min(GD_AI_FREE_LEAD_KCOMBO_MAX, Math.max(1, total));
        if (k >= 7) {
            cap = Math.min(cap, GD_AI_FREE_LEAD_K7_CAP);
        }
        if (k === 8) {
            cap = Math.min(cap, GD_AI_FREE_LEAD_K8_CAP);
        }
        if (k === 10) {
            cap = Math.min(cap, GD_AI_FREE_LEAD_K10_CAP);
        }
        if (k === 12) {
            cap = Math.min(cap, GD_AI_FREE_LEAD_K12_CAP);
        }
        gdEachKCombinationIndices(n, k, function (ix) {
            var ids = [];
            for (var t = 0; t < ix.length; t++) {
                ids.push(sorted[ix[t]]);
            }
            if (ids.length > 0) {
                var p = gdClassify(ids, lvl);
                if (p.kind === GD_KIND_INVALID) {
                    return;
                }
                consider(ids);
            }
            if (bestS > 1e9) {
                return true;
            }
            return;
        }, cap);
        if (bestS > 1e9) {
            break;
        }
    }
    return best;
}
/**
 * 自由领出：n≤L4 时子集 2^n；否则 k=4,5,6 组合 + 与「基础 gdAiLead」三选一最高分。
 */
function gdAiFreeLeadMain(hand, lvl, mateLen, state, seat) {
    var ctx = { state: state, seat: seat };
    var a0 = gdAiAnalyze(hand, lvl);
    var baseline = gdAiLead(a0, mateLen);
    if (baseline.pass || baseline.ids.length < 1) {
        return { pass: true, ids: [] };
    }
    var bestIds = baseline.ids;
    var bestS = gdScoreFreeLeadIds(hand, bestIds, lvl, ctx);
    // 基准若出单张：用 L3 在「全部合法单张」里重选，减少乱拆结构
    if (!baseline.pass && baseline.ids.length === 1) {
        var bs = gdAiLeadBestSingle(hand, lvl, state, seat);
        if (bs && !bs.pass && bs.ids.length > 0) {
            var s2 = gdScoreFreeLeadIds(hand, bs.ids, lvl, ctx);
            if (s2 > bestS) {
                bestS = s2;
                bestIds = bs.ids;
            }
        }
    }
    if (hand.length >= 1 && hand.length <= GD_AI_L4_LEAD_MAX_CARDS) {
        var l4 = gdAiTryFreeLeadL4(hand, lvl, ctx);
        if (l4 && !l4.pass && l4.ids.length > 0) {
            var s = gdScoreFreeLeadIds(hand, l4.ids, lvl, ctx);
            if (s > bestS) {
                bestS = s;
                bestIds = l4.ids;
            }
        }
    }
    else {
        var kcb = gdAiFreeLeadKComboBest(hand, lvl, ctx);
        if (kcb && kcb.length > 0) {
            var s = gdScoreFreeLeadIds(hand, kcb, lvl, ctx);
            if (s > bestS) {
                bestS = s;
                bestIds = kcb;
            }
        }
    }
    return { pass: false, ids: bestIds };
}
/** ----------- Follow ----------- */
/** 自由领出：全部合法单张里 L3 选优 */
function gdAiLeadBestSingle(hand, lvl, state, seat) {
    var candidates = [];
    var seen = {};
    for (var i = 0; i < hand.length; i++) {
        var ids = [hand[i]];
        var p = gdClassify(ids, lvl);
        if (p.kind !== GD_KIND_SINGLE) {
            continue;
        }
        var ky = String(hand[i]);
        if (!seen[ky]) {
            seen[ky] = true;
            candidates.push(ids);
        }
    }
    if (candidates.length === 0) {
        return null;
    }
    var pick = gdAiPickBestPlayL3(hand, lvl, candidates, { state: state, seat: seat });
    return pick ? { pass: false, ids: pick.ids } : null;
}
/** 跟单张：枚举能压过的全部单张，L3 选优（比「按 singlesRanks 顺序取第一张」更省大牌、少拆炸） */
function gdAiFollowSingleBest(hand, last, lvl, state, seat) {
    var candidates = [];
    var seen = {};
    for (var i = 0; i < hand.length; i++) {
        var ids = [hand[i]];
        var p = gdClassify(ids, lvl);
        if (p.kind !== GD_KIND_SINGLE) {
            continue;
        }
        if (!gdBeats(last, p)) {
            continue;
        }
        var ky = String(hand[i]);
        if (!seen[ky]) {
            seen[ky] = true;
            candidates.push(ids);
        }
    }
    if (candidates.length === 0) {
        return null;
    }
    var pick = gdAiPickBestPlayL3(hand, lvl, candidates, { state: state, seat: seat });
    return pick ? pick : null;
}
/** 尝试组出一张「价值 > lastMain」的单张；允许拆对/三，红心级牌等效为级牌价值 */
function gdAiFollowSingle(a, lastMain) {
    for (var i = 0; i < a.singlesRanks.length; i++) {
        var rr = a.singlesRanks[i];
        if (gdRankValueFromRaw(rr, a.lvl) > lastMain) {
            return { ids: [a.ranks[String(rr)][0]] };
        }
    }
    for (var i = 0; i < a.pairsRanks.length; i++) {
        var rr = a.pairsRanks[i];
        if (gdRankValueFromRaw(rr, a.lvl) > lastMain) {
            return { ids: [a.ranks[String(rr)][0]] };
        }
    }
    for (var i = 0; i < a.triplesRanks.length; i++) {
        var rr = a.triplesRanks[i];
        if (gdRankValueFromRaw(rr, a.lvl) > lastMain) {
            return { ids: [a.ranks[String(rr)][0]] };
        }
    }
    // 拆炸（很浪费，放最后）
    for (var i = 0; i < a.bombRanks.length; i++) {
        var rr = a.bombRanks[i];
        if (gdRankValueFromRaw(rr, a.lvl) > lastMain) {
            return { ids: [a.ranks[String(rr)][0]] };
        }
    }
    // 红心级牌当单张：点力即级牌 14（gdRankValueFromRaw(levelRank, lvl) === 14）
    if (a.wilds.length > 0 && 14 > lastMain) {
        return { ids: [a.wilds[0]] };
    }
    return null;
}
function gdAiFollowPair(a, lastMain) {
    for (var i = 0; i < a.pairsRanks.length; i++) {
        var rr = a.pairsRanks[i];
        if (gdRankValueFromRaw(rr, a.lvl) > lastMain) {
            return { ids: a.ranks[String(rr)].slice(0, 2) };
        }
    }
    for (var i = 0; i < a.triplesRanks.length; i++) {
        var rr = a.triplesRanks[i];
        if (gdRankValueFromRaw(rr, a.lvl) > lastMain) {
            return { ids: a.ranks[String(rr)].slice(0, 2) };
        }
    }
    // 单 + wild 凑对
    if (a.wilds.length > 0) {
        for (var i = 0; i < a.singlesRanks.length; i++) {
            var rr = a.singlesRanks[i];
            if (rr >= 13) {
                continue;
            }
            if (gdRankValueFromRaw(rr, a.lvl) > lastMain) {
                return { ids: [a.ranks[String(rr)][0], a.wilds[0]] };
            }
        }
    }
    return null;
}
function gdAiFollowTriple(a, lastMain) {
    for (var i = 0; i < a.triplesRanks.length; i++) {
        var rr = a.triplesRanks[i];
        if (gdRankValueFromRaw(rr, a.lvl) > lastMain) {
            return { ids: a.ranks[String(rr)].slice(0, 3) };
        }
    }
    // 对 + wild 凑三
    if (a.wilds.length > 0) {
        for (var i = 0; i < a.pairsRanks.length; i++) {
            var rr = a.pairsRanks[i];
            if (rr >= 13) {
                continue;
            }
            if (gdRankValueFromRaw(rr, a.lvl) > lastMain) {
                return { ids: a.ranks[String(rr)].slice(0, 2).concat([a.wilds[0]]) };
            }
        }
    }
    // 单 + 2 wild 凑三
    if (a.wilds.length >= 2) {
        for (var i = 0; i < a.singlesRanks.length; i++) {
            var rr = a.singlesRanks[i];
            if (rr >= 13) {
                continue;
            }
            if (gdRankValueFromRaw(rr, a.lvl) > lastMain) {
                return { ids: [a.ranks[String(rr)][0], a.wilds[0], a.wilds[1]] };
            }
        }
    }
    return null;
}
/** 深拷贝 rank → cardId[]（用于线牌构造时扣牌） */
function gdAiCloneRankBuckets(src) {
    var o = {};
    for (var k in src) {
        if (src.hasOwnProperty(k)) {
            o[k] = src[k].slice();
        }
    }
    return o;
}
/** 非红心级牌按 rawRank 分桶；红心级牌进 wilds（与 gdSplitWilds 一致） */
function gdAiNormalsBucketsByRank(hand, lvl) {
    var sp = gdSplitWilds(hand, lvl);
    var buckets = {};
    for (var i = 0; i < sp.normals.length; i++) {
        var id = sp.normals[i];
        var k = String(gdRawRank(id));
        if (!buckets[k]) {
            buckets[k] = [];
        }
        buckets[k].push(id);
    }
    for (var k in buckets) {
        if (buckets.hasOwnProperty(k)) {
            buckets[k].sort(function (a, b) {
                return a - b;
            });
        }
    }
    var wilds = sp.wilds.slice().sort(function (a, b) {
        return a - b;
    });
    return { buckets: buckets, wilds: wilds };
}
function gdAiDedupPushPlay(out, seen, ids) {
    var t = ids.slice().sort(function (a, b) {
        return a - b;
    });
    var ky = t.join(",");
    if (!seen[ky]) {
        seen[ky] = true;
        out.push(ids);
    }
}
/**
 * 跟牌：连对（6/8/10…张，与 last.len 相同）。顶序枚举，避免 C(n,k) 全组合。
 */
function gdAiEnumerateBeatingPairStraights(hand, last, lvl) {
    if (last.kind !== GD_KIND_PAIR_STRAIGHT) {
        return [];
    }
    var wantLen = last.len;
    if (wantLen < 6 || wantLen % 2 !== 0) {
        return [];
    }
    var numPairs = (wantLen / 2) | 0;
    if (numPairs < 3) {
        return [];
    }
    var base = gdAiNormalsBucketsByRank(hand, lvl);
    var out = [];
    var seen = {};
    gdForEachPairStraightSeqTemplate(lvl, numPairs, function (seq) {
        var bk = gdAiCloneRankBuckets(base.buckets);
        var wildsLeft = base.wilds.slice();
        var ids = [];
        var ok = true;
        for (var si = 0; si < seq.length; si++) {
            var need = 2;
            var arr = bk[String(seq[si])] || [];
            while (need > 0 && arr.length > 0) {
                ids.push(arr.shift());
                need--;
            }
            while (need > 0 && wildsLeft.length > 0) {
                ids.push(wildsLeft.pop());
                need--;
            }
            if (need > 0) {
                ok = false;
                break;
            }
        }
        if (!ok || ids.length !== wantLen) {
            return;
        }
        var p = gdClassify(ids, lvl);
        if (p.kind !== GD_KIND_PAIR_STRAIGHT || !gdBeats(last, p)) {
            return;
        }
        gdAiDedupPushPlay(out, seen, ids);
    });
    return out;
}
/** 跟牌：钢板（2 连三，6 张） */
function gdAiEnumerateBeatingTripleStraights(hand, last, lvl) {
    if (last.kind !== GD_KIND_TRIPLE_STRAIGHT || last.len !== 6) {
        return [];
    }
    var base = gdAiNormalsBucketsByRank(hand, lvl);
    var out = [];
    var seen = {};
    for (var top_5 = 1; top_5 <= 11; top_5++) {
        var seq = [top_5 - 1, top_5];
        if (!gdSeqAllowedForStraight(seq, lvl)) {
            continue;
        }
        var bk = gdAiCloneRankBuckets(base.buckets);
        var wildsLeft = base.wilds.slice();
        var ids = [];
        var ok = true;
        for (var si = 0; si < seq.length; si++) {
            var need = 3;
            var arr = bk[String(seq[si])] || [];
            while (need > 0 && arr.length > 0) {
                ids.push(arr.shift());
                need--;
            }
            while (need > 0 && wildsLeft.length > 0) {
                ids.push(wildsLeft.pop());
                need--;
            }
            if (need > 0) {
                ok = false;
                break;
            }
        }
        if (!ok || ids.length !== 6) {
            continue;
        }
        var p = gdClassify(ids, lvl);
        if (p.kind !== GD_KIND_TRIPLE_STRAIGHT || !gdBeats(last, p)) {
            continue;
        }
        gdAiDedupPushPlay(out, seen, ids);
    }
    return out;
}
/** 跟牌：顺子（5 张），含 A2345 顶顺 */
function gdAiEnumerateBeatingStraights(hand, last, lvl) {
    if (last.kind !== GD_KIND_STRAIGHT || last.len !== 5) {
        return [];
    }
    var base = gdAiNormalsBucketsByRank(hand, lvl);
    var out = [];
    var seen = {};
    function trySeq(seq) {
        if (!gdSeqAllowedForStraight(seq, lvl)) {
            return;
        }
        var bk = gdAiCloneRankBuckets(base.buckets);
        var wildsLeft = base.wilds.slice();
        var ids = [];
        var ok = true;
        for (var si = 0; si < seq.length; si++) {
            var need = 1;
            var arr = bk[String(seq[si])] || [];
            while (need > 0 && arr.length > 0) {
                ids.push(arr.shift());
                need--;
            }
            while (need > 0 && wildsLeft.length > 0) {
                ids.push(wildsLeft.pop());
                need--;
            }
            if (need > 0) {
                ok = false;
                break;
            }
        }
        if (!ok || ids.length !== 5) {
            return;
        }
        var p = gdClassify(ids, lvl);
        if (p.kind !== GD_KIND_STRAIGHT || !gdBeats(last, p)) {
            return;
        }
        gdAiDedupPushPlay(out, seen, ids);
    }
    for (var top_6 = 4; top_6 <= 11; top_6++) {
        trySeq([top_6 - 4, top_6 - 3, top_6 - 2, top_6 - 1, top_6]);
    }
    trySeq([11, 12, 0, 1, 2]);
    return out;
}
/** 线牌候选（已能压）→ L3；若无则尝试炸弹压非炸 */
function gdAiFollowLineThenBombs(hand, a, last, lvl, lineCands, state, seat) {
    var tctx = { state: state, seat: seat };
    if (lineCands.length > 0) {
        var pick = lineCands.length === 1
            ? { ids: lineCands[0] }
            : gdAiPickBestPlayL3(hand, lvl, lineCands, tctx);
        return { pass: false, ids: pick ? pick.ids : lineCands[0] };
    }
    var bombs = gdAiFollowBombCandidates(a, last);
    if (bombs.length > 1) {
        var pick = gdAiPickBestPlayL3(hand, lvl, bombs, tctx);
        return { pass: false, ids: pick ? pick.ids : bombs[0] };
    }
    if (bombs.length === 1) {
        return { pass: false, ids: bombs[0] };
    }
    return { pass: true, ids: [] };
}
/**
 * 跟牌：三带二（5 张）。枚举 (tripleR, pairR) + 百搭，替代 C(n,5) 爆搜。
 */
function gdAiEnumerateBeatingTripleWithPair(hand, last, lvl) {
    if (last.kind !== GD_KIND_TRIPLE_WITH_PAIR || last.len !== 5) {
        return [];
    }
    var base = gdAiNormalsBucketsByRank(hand, lvl);
    var out = [];
    var seen = {};
    for (var tripleR = 0; tripleR <= 12; tripleR++) {
        for (var pairR = 0; pairR <= 12; pairR++) {
            if (pairR === tripleR) {
                continue;
            }
            var bk = gdAiCloneRankBuckets(base.buckets);
            var wildsLeft = base.wilds.slice();
            var ids = [];
            var ok = true;
            for (var need = 3; need > 0;) {
                var arr = bk[String(tripleR)] || [];
                if (arr.length > 0) {
                    ids.push(arr.shift());
                    need--;
                }
                else if (wildsLeft.length > 0) {
                    ids.push(wildsLeft.pop());
                    need--;
                }
                else {
                    ok = false;
                    break;
                }
            }
            if (!ok) {
                continue;
            }
            for (var need = 2; need > 0;) {
                var arr = bk[String(pairR)] || [];
                if (arr.length > 0) {
                    ids.push(arr.shift());
                    need--;
                }
                else if (wildsLeft.length > 0) {
                    ids.push(wildsLeft.pop());
                    need--;
                }
                else {
                    ok = false;
                    break;
                }
            }
            if (!ok || ids.length !== 5) {
                continue;
            }
            var p = gdClassify(ids, lvl);
            if (p.kind !== GD_KIND_TRIPLE_WITH_PAIR || !gdBeats(last, p)) {
                continue;
            }
            gdAiDedupPushPlay(out, seen, ids);
        }
    }
    return out;
}
/**
 * 跟牌：同花顺（5 张）。按花色 + 顶序构造，用于压炸弹/更大同花顺；避免仅依赖 C(n,5)。
 */
function gdAiEnumerateBeatingStraightFlushes(hand, last, lvl) {
    var sp = gdSplitWilds(hand, lvl);
    var bySuit = {};
    for (var su = 0; su < 4; su++) {
        bySuit[String(su)] = {};
    }
    for (var i = 0; i < sp.normals.length; i++) {
        var id = sp.normals[i];
        var r = gdRawRank(id);
        if (r >= 13) {
            continue;
        }
        var su = gdSuit(id);
        var buck = bySuit[String(su)];
        var k = String(r);
        if (!buck[k]) {
            buck[k] = [];
        }
        buck[k].push(id);
    }
    for (var su = 0; su < 4; su++) {
        var buck = bySuit[String(su)];
        for (var k in buck) {
            if (buck.hasOwnProperty(k)) {
                buck[k].sort(function (a, b) {
                    return a - b;
                });
            }
        }
    }
    var wildsBase = sp.wilds.slice().sort(function (a, b) {
        return a - b;
    });
    var out = [];
    var seen = {};
    var _loop_1 = function (suit) {
        var buck = bySuit[String(suit)];
        function trySeq(seq) {
            if (!gdSeqAllowedForStraight(seq, lvl)) {
                return;
            }
            var bk = gdAiCloneRankBuckets(buck);
            var wildsLeft = wildsBase.slice();
            var ids = [];
            var ok = true;
            for (var si = 0; si < seq.length; si++) {
                var need = 1;
                var arr = bk[String(seq[si])] || [];
                while (need > 0 && arr.length > 0) {
                    ids.push(arr.shift());
                    need--;
                }
                while (need > 0 && wildsLeft.length > 0) {
                    ids.push(wildsLeft.pop());
                    need--;
                }
                if (need > 0) {
                    ok = false;
                    break;
                }
            }
            if (!ok || ids.length !== 5) {
                return;
            }
            var p = gdClassify(ids, lvl);
            if (p.kind !== GD_KIND_STRAIGHT_FLUSH || !gdBeats(last, p)) {
                return;
            }
            gdAiDedupPushPlay(out, seen, ids);
        }
        function tryWheel() {
            var seq = [11, 12, 0, 1, 2];
            var bk = gdAiCloneRankBuckets(buck);
            var wildsLeft = wildsBase.slice();
            var ids = [];
            var ok = true;
            for (var si = 0; si < seq.length; si++) {
                var r = seq[si];
                if (r === lvl) {
                    if (wildsLeft.length < 1) {
                        ok = false;
                        break;
                    }
                    ids.push(wildsLeft.pop());
                    continue;
                }
                var need = 1;
                var arr = bk[String(r)] || [];
                while (need > 0 && arr.length > 0) {
                    ids.push(arr.shift());
                    need--;
                }
                while (need > 0 && wildsLeft.length > 0) {
                    ids.push(wildsLeft.pop());
                    need--;
                }
                if (need > 0) {
                    ok = false;
                    break;
                }
            }
            if (!ok || ids.length !== 5) {
                return;
            }
            var p = gdClassify(ids, lvl);
            if (p.kind !== GD_KIND_STRAIGHT_FLUSH || !gdBeats(last, p)) {
                return;
            }
            gdAiDedupPushPlay(out, seen, ids);
        }
        for (var top_7 = 4; top_7 <= 11; top_7++) {
            trySeq([top_7 - 4, top_7 - 3, top_7 - 2, top_7 - 1, top_7]);
        }
        tryWheel();
    };
    for (var suit = 0; suit < 4; suit++) {
        _loop_1(suit);
    }
    return out;
}
/** 炸弹链跟牌：结构化候选（点力炸弹 + 同花顺）经 classify/beats 过滤，再 L3；替代先跑满额 C(n,k)。 */
function gdAiMergeBeatingBombTierPlays(hand, a, last, lvl) {
    var out = [];
    var seen = {};
    var bombs = gdAiFollowBombCandidates(a, last);
    for (var i = 0; i < bombs.length; i++) {
        var ids = bombs[i];
        var p = gdClassify(ids, lvl);
        if (p.kind === GD_KIND_INVALID) {
            continue;
        }
        if (!gdBeats(last, p)) {
            continue;
        }
        gdAiDedupPushPlay(out, seen, ids);
    }
    var sfs = gdAiEnumerateBeatingStraightFlushes(hand, last, lvl);
    for (var i = 0; i < sfs.length; i++) {
        gdAiDedupPushPlay(out, seen, sfs[i]);
    }
    return out;
}
/** 按 rank 的原生张数返回对应 bombTier */
function gdAiBombTierOfCount(cnt) {
    if (cnt === 4) {
        return GD_BOMB_TIER_4;
    }
    if (cnt === 5) {
        return GD_BOMB_TIER_5;
    }
    if (cnt === 6) {
        return GD_BOMB_TIER_6;
    }
    if (cnt === 7) {
        return GD_BOMB_TIER_7;
    }
    return GD_BOMB_TIER_8;
}
function gdAiTryKingBomb(a) {
    var smalls = [];
    var bigs = [];
    for (var i = 0; i < a.hand.length; i++) {
        var id = a.hand[i];
        var rr = gdRawRank(id);
        if (rr === 13) {
            smalls.push(id);
        }
        else if (rr === 14) {
            bigs.push(id);
        }
    }
    if (smalls.length >= 2 && bigs.length >= 2) {
        return smalls.slice(0, 2).concat(bigs.slice(0, 2));
    }
    return null;
}
/**
 * 枚举子集：找能压过 last 的牌（同型 / 炸链），用于顺子、三带二、连对、钢板等跟牌。
 */
function gdBruteFindBeatingPlay(hand, last, lvl) {
    var k = last.len;
    if (k < 1 || k > hand.length) {
        return null;
    }
    var n = hand.length;
    var tries = 0;
    var maxT = GD_AI_BRUTE_FIND_ONE_MAX_TRIES;
    var buf = new Array(k);
    function dfs(st, d) {
        if (d === k) {
            tries++;
            if (tries > maxT) {
                return null;
            }
            var p = gdClassify(buf, lvl);
            if (p.kind === GD_KIND_INVALID) {
                return null;
            }
            if (gdBeats(last, p)) {
                return buf.slice();
            }
            return null;
        }
        for (var i = st; i < n; i++) {
            buf[d] = hand[i];
            var r = dfs(i + 1, d + 1);
            if (r) {
                return r;
            }
        }
        return null;
    }
    return dfs(0, 0);
}
/** L3：残局/跟牌 手牌张数上界；超过则只做单次爆搜找一解，避免 C(n,k) 全枚举 */
var GD_AI_L3_FOLLOW_MAX_HAND = 12;
/** L4：自由领出，子集 2^n 上界；≤11 → 2048 次 classify+估值 */
var GD_AI_L4_LEAD_MAX_CARDS = 11;
/** 手牌 > L4 时，按 C(n,k) 枚举合法领出，硬顶防单 tick CPU 过长 */
var GD_AI_FREE_LEAD_KCOMBO_MAX = 2200;
var GD_AI_FREE_LEAD_K7_CAP = 900;
var GD_AI_FREE_LEAD_K8_CAP = 600;
var GD_AI_FREE_LEAD_K10_CAP = 380;
var GD_AI_FREE_LEAD_K12_CAP = 220;
/** 跟牌爆搜：枚举合法组合的次数 / 收集的不同出牌上限 */
var GD_AI_BRUTE_ALL_MAX_TRIES = 42000;
var GD_AI_BRUTE_ALL_MAX_OUT = 64;
/** 单次 DFS 找「任一能压」的步数上限（手牌长时尽快放弃） */
var GD_AI_BRUTE_FIND_ONE_MAX_TRIES = 28000;
/** 多候选 L3：最多完整估值的候选数（其余已在前面按点力截断） */
var GD_AI_L3_MAX_CANDIDATES = 18;
function gdAiRemovePlayFromHand(hand, play) {
    var cpy = hand.slice();
    for (var p = 0; p < play.length; p++) {
        var want = play[p];
        var ix = cpy.indexOf(want);
        if (ix >= 0) {
            cpy.splice(ix, 1);
        }
    }
    return cpy;
}
/** L3 核心：剩余手牌可玩性 + 少剩牌奖励（不替代规则合法性） */
function gdAiEvaluateRemainingHand(hand, lvl) {
    if (hand.length === 0) {
        return 10000;
    }
    var a = gdAiAnalyze(hand, lvl);
    var s = 0;
    s += a.pairsRanks.length * 5.0;
    s += a.triplesRanks.length * 4.0;
    s += a.bombRanks.length * 2.5;
    /** 散张：旧版把面点低(raw<8)的单张当「加分」会诱导早期甩光大牌、剩一手小点难出；改按点力罚散张。 */
    for (var i = 0; i < a.singlesRanks.length; i++) {
        var rr = a.singlesRanks[i];
        var v = gdRankValueFromRaw(rr, lvl);
        if (v < 0) {
            s -= 1.15;
        }
        else if (v <= 5) {
            s -= 1.5;
        }
        else if (v <= 8) {
            s -= 0.95;
        }
        else if (v <= 11) {
            s -= 0.45;
        }
        else {
            s -= 0.5;
        }
    }
    s -= a.wilds.length * 0.3;
    s -= hand.length * 0.25;
    return s;
}
function gdAiLeadFreeBonus(pat, playLen) {
    if (playLen < 1) {
        return 0;
    }
    if (pat.bombTier > 0 || pat.kind === GD_KIND_BOMB || pat.kind === GD_KIND_KING_BOMB) {
        return -5.5;
    }
    if (pat.kind === GD_KIND_STRAIGHT_FLUSH) {
        return -1.0;
    }
    return 0;
}
function gdAiFollowPlayPenalty(pat) {
    if (pat.bombTier > 0 || pat.kind === GD_KIND_BOMB || pat.kind === GD_KIND_KING_BOMB) {
        return -4.0;
    }
    if (pat.kind === GD_KIND_STRAIGHT_FLUSH) {
        return -0.8;
    }
    return 0;
}
/** 跟牌 L3：同型顺子/连对等略倾向保留牌型结构 */
function gdFollowLinePatternBonus(pat) {
    if (pat.bombTier > 0) {
        return 0;
    }
    var k = pat.kind;
    if (k === GD_KIND_STRAIGHT || k === GD_KIND_PAIR_STRAIGHT || k === GD_KIND_TRIPLE_STRAIGHT) {
        return 0.35;
    }
    if (k === GD_KIND_TRIPLE_WITH_PAIR) {
        return 0.25;
    }
    return 0;
}
/** 候选过多时保留「点力总和较小」的出牌再跑 L3，减少 analyze 次数且偏保守出牌 */
function gdAiL3TrimSortKey(ids, lvl) {
    var s = 0;
    for (var i = 0; i < ids.length; i++) {
        s += gdRankValue(ids[i], lvl);
    }
    return s;
}
/** L3：从多组可出牌中选「打完剩牌」估值 + 出本手惩罚最优 */
function gdAiPickBestPlayL3(hand, lvl, candidates, threatCtx) {
    if (candidates.length === 0) {
        return null;
    }
    if (candidates.length === 1) {
        return { ids: candidates[0] };
    }
    var cands = candidates;
    if (cands.length > GD_AI_L3_MAX_CANDIDATES) {
        var scored = [];
        for (var i = 0; i < cands.length; i++) {
            var ids = cands[i];
            scored.push({ ids: ids, k: gdAiL3TrimSortKey(ids, lvl) });
        }
        scored.sort(function (a, b) {
            return a.k - b.k;
        });
        cands = [];
        var lim = GD_AI_L3_MAX_CANDIDATES;
        for (var j = 0; j < lim && j < scored.length; j++) {
            cands.push(scored[j].ids);
        }
    }
    var best = cands[0];
    var bestS = -1e15;
    for (var c = 0; c < cands.length; c++) {
        var ids = cands[c];
        var rem = gdAiRemovePlayFromHand(hand, ids);
        var p = gdClassify(ids, lvl);
        if (p.kind === GD_KIND_INVALID) {
            continue;
        }
        var s = gdAiEvaluateRemainingHand(rem, lvl) + gdAiFollowPlayPenalty(p) + gdFollowLinePatternBonus(p);
        if (threatCtx) {
            s += gdAiPlayThreatAdjustment(threatCtx.state, threatCtx.seat, p, ids);
        }
        if (s > bestS) {
            bestS = s;
            best = ids;
        }
    }
    return { ids: best };
}
/**
 * 枚举能压过 last 的全部牌组（有上限；用于 L3）
 */
function gdBruteFindAllBeatingPlays(hand, last, lvl, maxTries, maxOut) {
    var k = last.len;
    if (k < 1 || k > hand.length) {
        return [];
    }
    var n = hand.length;
    var out = [];
    var seen = {};
    var tries = 0;
    var buf = new Array(k);
    function keyOf(ids) {
        var t = ids.slice();
        t.sort(function (a, b) {
            return a - b;
        });
        return t.join(",");
    }
    function dfs(st, d) {
        if (d === k) {
            tries++;
            if (tries > maxTries) {
                return;
            }
            var p = gdClassify(buf, lvl);
            if (p.kind === GD_KIND_INVALID) {
                return;
            }
            if (gdBeats(last, p)) {
                var copy = buf.slice();
                var ky = keyOf(copy);
                if (!seen[ky]) {
                    seen[ky] = true;
                    out.push(copy);
                }
            }
            return;
        }
        for (var i = st; i < n; i++) {
            buf[d] = hand[i];
            dfs(i + 1, d + 1);
            if (tries > maxTries || out.length >= maxOut) {
                return;
            }
        }
    }
    dfs(0, 0);
    return out;
}
/**
 * 跟炸：能压的炸/天王炸可能有多套，L3 选剩余牌型最合理的一套（非上家为炸时，所有原生炸可压，不再只出「顺排第一种炸」）。
 */
function gdAiFollowBombCandidates(a, last) {
    var out = [];
    if (last.kind === GD_KIND_KING_BOMB) {
        return out;
    }
    if (last.bombTier > 0) {
        for (var i = 0; i < a.bombRanks.length; i++) {
            var rr = a.bombRanks[i];
            var cnt = a.ranks[String(rr)].length;
            var tier = gdAiBombTierOfCount(cnt);
            var main = gdRankValueFromRaw(rr, a.lvl);
            if (tier > last.bombTier) {
                out.push(a.ranks[String(rr)].slice(0, Math.min(cnt, 8)));
            }
            else if (tier === last.bombTier && main > last.main) {
                out.push(a.ranks[String(rr)].slice(0, Math.min(cnt, 8)));
            }
        }
    }
    else {
        for (var i = 0; i < a.bombRanks.length; i++) {
            var rr = a.bombRanks[i];
            var cnt = a.ranks[String(rr)].length;
            out.push(a.ranks[String(rr)].slice(0, Math.min(cnt, 8)));
        }
    }
    var kb = gdAiTryKingBomb(a);
    if (kb) {
        out.push(kb);
    }
    return out;
}
/**
 * L4：自由领出 2^n 子集，优先一手清；否则估值最大。
 */
function gdAiTryFreeLeadL4(hand, lvl, ctx) {
    if (hand.length > GD_AI_L4_LEAD_MAX_CARDS || hand.length < 1) {
        return null;
    }
    var n = hand.length;
    var sorted = hand
        .slice()
        .sort(function (a, b) {
        return a - b;
    });
    var best = null;
    var bestScore = -1e15;
    for (var mask = 1; mask < 1 << n; mask++) {
        var ids = [];
        for (var i = 0; i < n; i++) {
            if (mask & 1 << i) {
                ids.push(sorted[i]);
            }
        }
        var s = gdScoreFreeLeadIds(hand, ids, lvl, ctx);
        if (s > 1e9) {
            return { pass: false, ids: ids };
        }
        if (s > bestScore) {
            bestScore = s;
            best = ids;
        }
    }
    if (best && best.length > 0) {
        return { pass: false, ids: best };
    }
    return null;
}
function gdAiBruteBestBeatingL3(hand, last, lvl, state, seat) {
    if (hand.length > GD_AI_L3_FOLLOW_MAX_HAND) {
        return gdBruteFindBeatingPlay(hand, last, lvl);
    }
    var all = gdBruteFindAllBeatingPlays(hand, last, lvl, GD_AI_BRUTE_ALL_MAX_TRIES, GD_AI_BRUTE_ALL_MAX_OUT);
    if (all.length === 0) {
        return null;
    }
    if (all.length === 1) {
        return all[0];
    }
    var tctx = state !== undefined && seat !== undefined ? { state: state, seat: seat } : null;
    var pick = gdAiPickBestPlayL3(hand, lvl, all, tctx);
    return pick ? pick.ids : all[0];
}
/** 主决策 */
function gdAiPickPlay(state, seat) {
    var hand = state.hands[seat];
    if (hand.length === 0) {
        return { pass: true, ids: [] };
    }
    var lvl = state.levelRankActive;
    var a = gdAiAnalyze(hand, lvl);
    var last = state.lastPattern;
    var mateLen = state.hands[gdTeammateSeat(seat)].length;
    if (!last || last.kind === GD_KIND_PASS) {
        return gdAiFreeLeadMain(hand, lvl, mateLen, state, seat);
    }
    if (gdAiIsPartnerControllingTrick(state, seat)) {
        return { pass: true, ids: [] };
    }
    var follow = null;
    if (last.kind === GD_KIND_SINGLE) {
        follow = gdAiFollowSingleBest(hand, last, lvl, state, seat);
        if (!follow) {
            follow = gdAiFollowSingle(a, last.main);
        }
    }
    else if (last.kind === GD_KIND_PAIR) {
        follow = gdAiFollowPair(a, last.main);
    }
    else if (last.kind === GD_KIND_TRIPLE) {
        follow = gdAiFollowTriple(a, last.main);
    }
    else if (last.kind === GD_KIND_BOMB || last.kind === GD_KIND_KING_BOMB || last.kind === GD_KIND_STRAIGHT_FLUSH) {
        var merged = gdAiMergeBeatingBombTierPlays(hand, a, last, lvl);
        if (merged.length > 0) {
            var pick = merged.length === 1
                ? { ids: merged[0] }
                : gdAiPickBestPlayL3(hand, lvl, merged, { state: state, seat: seat });
            return { pass: false, ids: pick ? pick.ids : merged[0] };
        }
        var brTier = gdAiBruteBestBeatingL3(hand, last, lvl, state, seat);
        if (brTier) {
            return { pass: false, ids: brTier };
        }
        follow = null;
    }
    else if (last.kind === GD_KIND_PAIR_STRAIGHT) {
        var line = gdAiEnumerateBeatingPairStraights(hand, last, lvl);
        var r = gdAiFollowLineThenBombs(hand, a, last, lvl, line, state, seat);
        if (!r.pass) {
            return r;
        }
        return { pass: true, ids: [] };
    }
    else if (last.kind === GD_KIND_TRIPLE_STRAIGHT) {
        var line = gdAiEnumerateBeatingTripleStraights(hand, last, lvl);
        var r = gdAiFollowLineThenBombs(hand, a, last, lvl, line, state, seat);
        if (!r.pass) {
            return r;
        }
        return { pass: true, ids: [] };
    }
    else if (last.kind === GD_KIND_STRAIGHT) {
        var line = gdAiEnumerateBeatingStraights(hand, last, lvl);
        var r = gdAiFollowLineThenBombs(hand, a, last, lvl, line, state, seat);
        if (!r.pass) {
            return r;
        }
        return { pass: true, ids: [] };
    }
    else if (last.kind === GD_KIND_TRIPLE_WITH_PAIR) {
        var line = gdAiEnumerateBeatingTripleWithPair(hand, last, lvl);
        var r = gdAiFollowLineThenBombs(hand, a, last, lvl, line, state, seat);
        if (!r.pass) {
            return r;
        }
        return { pass: true, ids: [] };
    }
    else {
        var br3 = gdAiBruteBestBeatingL3(hand, last, lvl, state, seat);
        if (br3) {
            return { pass: false, ids: br3 };
        }
        if (hand.length <= 12) {
            var c2 = gdAiFollowBombCandidates(a, last);
            if (c2.length > 1) {
                var pick2 = gdAiPickBestPlayL3(hand, lvl, c2, { state: state, seat: seat });
                follow = pick2 ? pick2 : { ids: c2[0] };
            }
            else if (c2.length === 1) {
                follow = { ids: c2[0] };
            }
            else {
                follow = null;
            }
        }
    }
    if (follow) {
        return { pass: false, ids: follow.ids };
    }
    return { pass: true, ids: [] };
}
/** 结算广播，仅在 phase=finished 且本 tick 刚进入时调用 */
function gdMaybeBroadcastSettlement(dispatcher, logger, st) {
    var deltas = gdComputeScoreDeltas(st);
    var settlement = JSON.stringify({
        v: 1,
        finished_order: st.finishedOrder.slice(),
        winner_team: st.winnerTeam,
        levels: [st.teams[0].level, st.teams[1].level],
        score_delta: deltas,
    });
    try {
        dispatcher.broadcastMessage(GD_OP_SETTLEMENT, settlement, null, null);
    }
    catch (e) {
        logger.warn("guandan ai settlement broadcast: %s", String(e));
    }
}
/**
 * 每 tick 调用一次；若当前等待 AI 动作，推进**一步**并广播快照。
 * 若已进入 finished 且 winnerTeam < 0，让 AI 自动点「继续」开新局；
 * 若 winnerTeam >= 0（整场毕业），停驻。
 */
function gdRunAiUntilHumanOrDone(state, dispatcher, logger, nk) {
    var now = Date.now();
    if (now < state.aiPlayDelayUntilMs) {
        return;
    }
    if (state.phase === "finished") {
        if (state.winnerTeam >= 0) {
            return;
        }
        for (var s = 0; s < 4; s++) {
            if (state.isAiSeat[s] && !state.continueReady[s]) {
                gdApplyContinue(state, s, nk);
                state.aiPlayDelayUntilMs = now + GD_AI_PLAY_PACE_MS;
                gdBroadcastState(dispatcher, state, logger, "ai-continue");
                return;
            }
        }
        return;
    }
    if (state.phase === "tribute_wait") {
        var payer = state.tribute.pendingPayer;
        if (payer >= 0 && state.isAiSeat[payer]) {
            if (gdAiShouldResist(state, payer)) {
                gdApplyTributeResist(state, payer);
            }
            else {
                var cid = gdAiPickTributeCard(state, payer);
                if (cid >= 0) {
                    gdApplyTribute(state, payer, cid);
                }
            }
            state.aiPlayDelayUntilMs = now + GD_AI_PLAY_PACE_MS;
            gdBroadcastState(dispatcher, state, logger, "ai-tribute");
        }
        return;
    }
    if (state.phase === "return_wait") {
        var r = state.tribute.pendingReceiver;
        if (r >= 0 && state.isAiSeat[r]) {
            var cid = gdAiPickReturnCard(state, r);
            if (cid >= 0) {
                gdApplyReturn(state, r, cid);
            }
            state.aiPlayDelayUntilMs = now + GD_AI_PLAY_PACE_MS;
            gdBroadcastState(dispatcher, state, logger, "ai-return");
        }
        return;
    }
    if (state.phase === "play") {
        var t = state.turn;
        var del = state.aiDelegate && state.aiDelegate[t];
        if (t >= 0 && state.hands[t].length > 0 && (state.isAiSeat[t] || del)) {
            var prevPhase = state.phase;
            var decision = gdAiPickPlay(state, t);
            if (decision.pass) {
                gdApplyPass(state, t);
            }
            else {
                gdApplyPlay(state, t, decision.ids);
            }
            state.aiPlayDelayUntilMs = now + GD_AI_PLAY_PACE_MS;
            gdBroadcastState(dispatcher, state, logger, "ai-play");
            if (state.phase === "finished" && prevPhase !== "finished") {
                gdMaybeBroadcastSettlement(dispatcher, logger, state);
            }
        }
        return;
    }
}
/**
 * 兼容：多游戏 matchmakerMatched 分流占位。当前客户端仅走自建 RPC 队列；
 * 若将来通过 Nakama 内置 matchmaker 匹配并在 properties.game="guandan"，
 * 可由 main.ts 的统一回调路由到此函数。
 */
function guandanMatchmakerMatchedFallback(ctx, logger, nk, matches) {
    try {
        var humans = matches.length;
        var ai = Math.max(0, 4 - humans);
        var id = nk.matchCreate("guandan", {
            expect_humans: String(humans),
            ai: String(ai),
        });
        return id;
    }
    catch (e) {
        logger.error("guandan matchmakerMatched fallback: %s", String(e));
        return;
    }
}
