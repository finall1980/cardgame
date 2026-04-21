/**
 * 斗地主 · Nakama 权威 Match（TypeScript）
 * 与客户端 scripts/card_defs.gd、scripts/ddz_rules.gd 的点力与牌型判定对齐。
 *
 * 消息协议（OpCode / JSON）：供日后客户端对接；当前未改 Godot 客户端。
 * 详见下方 DDZ_OP_* 与 broadcastState 中的字段说明。
 */

/** 牌型，与 ddz_rules.gd Kind 枚举顺序一致 */
const DDZ_KIND_INVALID = 0;
const DDZ_KIND_PASS = 1;
const DDZ_KIND_SINGLE = 2;
const DDZ_KIND_PAIR = 3;
const DDZ_KIND_TRIPLE = 4;
const DDZ_KIND_STRAIGHT = 5;
const DDZ_KIND_BOMB = 6;
const DDZ_KIND_ROCKET = 7;
const DDZ_KIND_TRIPLE_WITH_SINGLE = 8;
const DDZ_KIND_TRIPLE_WITH_PAIR = 9;
const DDZ_KIND_PAIR_STRAIGHT = 10;
const DDZ_KIND_FOUR_WITH_TWO = 11;
const DDZ_KIND_PLANE = 12;
const DDZ_KIND_PLANE_WITH_WINGS = 13;

/**
 * 与 Godot 客户端 `MATCH_OP_*`（1/2/3）错开，避免与旧 relay 快照混淆。
 * 权威斗地主专用：101 公共快照、102 错误、120 结算。
 */
const DDZ_OP_SNAPSHOT = 101;
const DDZ_OP_ERROR = 102;
const DDZ_OP_SETTLEMENT = 120;

/** 叫牌/抢地主：AI 连动、matchLoop 自动推进「跳过抢」与真人操作后的节奏（与出牌 AI 链式延迟同量级） */
const AI_BID_ROB_PACE_MS = 1350;
/** 新一局发牌后：给客户端播轨迹+停顿留出时间，再允许 AI 叫牌（约 51×40ms + 1s ≈ 3s） */
const AI_NEW_ROUND_BID_DELAY_MS = 3000;

/** 客户端请求（将来）：叫分 10、抢地主 11、出牌 12、过 13 */
const DDZ_REQ_BID = 10;
const DDZ_REQ_ROB = 11;
const DDZ_REQ_PLAY = 12;
const DDZ_REQ_PASS = 13;
const DDZ_REQ_CONTINUE = 14;
/** 客户端发送聊天文字；服务端原样广播给 Match 内全员 */

const DDZ_CARD_COUNT = 54;

interface DdzHandPattern {
    kind: number;
    main: number;
    extra: number | null;
}

type Phase =
    | "waiting"
    | "deal"
    | "bidding_call"
    | "bidding_rob"
    | "play"
    | "finished";

interface DdzMatchState {
    presences: { [userId: string]: nkruntime.Presence };
    /** 加入顺序映射到 0..2 座位 */
    seatByUserId: { [userId: string]: number };
    /** 本局真人席位数（1–3）；其余为服务端 AI） */
    expectHumans: number;
    aiCount: number;
    /** 座位 0..2 是否为 AI（无 Nakama presence） */
    isAiSeat: boolean[];
    phase: Phase;
    hands: number[][];
    bottom: number[];
    bids: number[];
    /** 叫分阶段最高叫分者（用于抢地主起点） */
    callCandidate: number;
    /** 抢地主从 callCandidate 下家开始第 step 步（0..2） */
    robStep: number;
    landlord: number;
    turn: number;
    lastPattern: DdzHandPattern | null;
    lastPlayer: number;
    passes: number;
    winner: number;
    multBase: number;
    multRob: number;
    multPlay: number;
    robCount: number;
    playBombCount: number;
    playRocketCount: number;
    lastRobber: number;
    lastPlayIds: number[];
    dealSeed: string;
    seq: number;
    /** 叫分轮当前应答应座位 */
    awaitSeat: number;
    /** 本局叫地主首轮从该座位开始（随机 0～2），与 awaitSeat 开局一致 */
    callRoundStartSeat: number;
    /** 抢地主：每次抢/不抢动作单调递增，供客户端播气泡 */
    robActionSeq: number;
    lastRobActionSeat: number;
    lastRobActionWasRob: boolean;
    /** 抢地主轮次因「叫牌阶段未叫」被自动跳过（与主动选「不抢」区分，供气泡） */
    lastRobSkippedNoBid: boolean;
    /** 是否有人叫过分（用于抢地主「不叫不可抢」） */
    bidPassFlags: boolean[];
    errorLog: string[];
    /** 结算后三人是否已点「继续」；人满后 resetRound 开新一局 */
    continueReady: boolean[];
    /** 逻辑座位 0..2 → 猫咪角色 id 0..2（全桌一致，勿各端本地 shuffle） */
    seatCat: number[];
    /** 出牌节奏：真人出过牌后 AI 须等；AI 连出时亦须间隔，避免客户端动画重叠 */
    aiPlayDelayUntilMs: number;
    /** 合并进地主手牌前的三张底牌 id，出牌阶段供全桌翻开展示 */
    bottomRevealIds: number[];
    /** 与客户端 Deck.deal_doudizhu_with_trace 一致：第 i 张发到座位 i%3，便于播发牌动画 */
    dealTrace: { seat: number; card: number }[];
}

function ddzRankValue(cardId: number): number {
    if (cardId >= 52) {
        return 13 + (cardId - 52);
    }
    return cardId % 13;
}

function makeFullDeck(): number[] {
    const d: number[] = [];
    for (let i = 0; i < DDZ_CARD_COUNT; i++) {
        d.push(i);
    }
    return d;
}

/**
 * 部分 Nakama 版本（如 3.26）的 JS 运行时未实现 nk.secureRandomBytes，match_join 会抛错。
 * 优先用安全随机；不可用时退回 Math.random（仅影响洗牌/展示用 seed，非生产级安全场景可接受）。
 */
function randomBytesCompat(nk: nkruntime.Nakama, count: number): Uint8Array {
    const nkAny = nk as unknown as { secureRandomBytes?: (n: number) => ArrayBuffer };
    if (typeof nkAny.secureRandomBytes === "function") {
        return new Uint8Array(nkAny.secureRandomBytes(count));
    }
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
        out[i] = Math.floor(Math.random() * 256);
    }
    return out;
}

function randomIntBelow(nk: nkruntime.Nakama, maxExclusive: number): number {
    const u = randomBytesCompat(nk, 4);
    const x = u[0] | (u[1] << 8) | (u[2] << 16) | (u[3] << 24);
    return (x >>> 0) % maxExclusive;
}

/** Fisher–Yates */
function shuffleInPlace(nk: nkruntime.Nakama, deck: number[]): void {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = randomIntBelow(nk, i + 1);
        const t = deck[i];
        deck[i] = deck[j];
        deck[j] = t;
    }
}

function sortHand(h: number[]): void {
    h.sort(function (a, b) {
        const ra = ddzRankValue(a);
        const rb = ddzRankValue(b);
        if (ra !== rb) {
            return ra - rb;
        }
        return a - b;
    });
}

function rankCounts(cards: number[]): { [k: string]: number } {
    const m: { [k: string]: number } = {};
    for (let i = 0; i < cards.length; i++) {
        const v = ddzRankValue(cards[i]);
        const k = String(v);
        m[k] = (m[k] || 0) + 1;
    }
    return m;
}

function sortedRanks(cards: number[]): number[] {
    const r: number[] = [];
    for (let i = 0; i < cards.length; i++) {
        r.push(ddzRankValue(cards[i]));
    }
    r.sort(function (a, b) {
        return a - b;
    });
    return r;
}

function totalN(counts: { [k: string]: number }): number {
    let s = 0;
    for (const k in counts) {
        if (counts.hasOwnProperty(k)) {
            s += counts[k];
        }
    }
    return s;
}

function isTripleSingle(counts: { [k: string]: number }): boolean {
    if (Object.keys(counts).length !== 2) {
        return false;
    }
    let got3 = false;
    let got1 = false;
    for (const k in counts) {
        if (counts.hasOwnProperty(k)) {
            const c = counts[k];
            if (c === 3) {
                got3 = true;
            } else if (c === 1) {
                got1 = true;
            }
        }
    }
    return got3 && got1;
}

function tripleRankIn(counts: { [k: string]: number }): number {
    for (const k in counts) {
        if (counts.hasOwnProperty(k) && counts[k] === 3) {
            return parseInt(k, 10);
        }
    }
    return -1;
}

function isTriplePair(counts: { [k: string]: number }): boolean {
    if (Object.keys(counts).length !== 2) {
        return false;
    }
    let got3 = false;
    let got2 = false;
    for (const k in counts) {
        if (counts.hasOwnProperty(k)) {
            const c = counts[k];
            if (c === 3) {
                got3 = true;
            } else if (c === 2) {
                got2 = true;
            }
        }
    }
    return got3 && got2;
}

function isStraight(counts: { [k: string]: number }, n: number): boolean {
    const keys = Object.keys(counts);
    if (keys.length !== n) {
        return false;
    }
    for (let i = 0; i < keys.length; i++) {
        if (counts[keys[i]] !== 1) {
            return false;
        }
    }
    const ranks: number[] = [];
    for (let i = 0; i < keys.length; i++) {
        ranks.push(parseInt(keys[i], 10));
    }
    ranks.sort(function (a, b) {
        return a - b;
    });
    for (let i = 0; i < ranks.length; i++) {
        if (ranks[i] === 12 || ranks[i] >= 13) {
            return false;
        }
    }
    for (let i = 1; i < ranks.length; i++) {
        if (ranks[i] !== ranks[i - 1] + 1) {
            return false;
        }
    }
    return true;
}

function isPairStraight(counts: { [k: string]: number }): boolean {
    let npr = 0;
    for (const k in counts) {
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
    const ranks: number[] = [];
    for (const k in counts) {
        if (counts.hasOwnProperty(k)) {
            ranks.push(parseInt(k, 10));
        }
    }
    ranks.sort(function (a, b) {
        return a - b;
    });
    for (let i = 0; i < ranks.length; i++) {
        if (ranks[i] === 12 || ranks[i] >= 13) {
            return false;
        }
    }
    for (let i = 1; i < ranks.length; i++) {
        if (ranks[i] !== ranks[i - 1] + 1) {
            return false;
        }
    }
    return true;
}

function pairStraightRanks(counts: { [k: string]: number }): number[] {
    const ranks: number[] = [];
    for (const k in counts) {
        if (counts.hasOwnProperty(k)) {
            ranks.push(parseInt(k, 10));
        }
    }
    ranks.sort(function (a, b) {
        return a - b;
    });
    return ranks;
}

function isFourTwoSingles(counts: { [k: string]: number }): boolean {
    if (Object.keys(counts).length !== 3) {
        return false;
    }
    let got4 = false;
    let n1 = 0;
    for (const k in counts) {
        if (counts.hasOwnProperty(k)) {
            const c = counts[k];
            if (c === 4) {
                got4 = true;
            } else if (c === 1) {
                n1++;
            }
        }
    }
    return got4 && n1 === 2;
}

function isFourTwoPairs(counts: { [k: string]: number }): boolean {
    if (Object.keys(counts).length !== 3) {
        return false;
    }
    let got4 = false;
    let n2 = 0;
    for (const k in counts) {
        if (counts.hasOwnProperty(k)) {
            const c = counts[k];
            if (c === 4) {
                got4 = true;
            } else if (c === 2) {
                n2++;
            }
        }
    }
    return got4 && n2 === 2;
}

function fourRankIn(counts: { [k: string]: number }): number {
    for (const k in counts) {
        if (counts.hasOwnProperty(k) && counts[k] === 4) {
            return parseInt(k, 10);
        }
    }
    return -1;
}

function fourKickersNoJokerBomb(counts: { [k: string]: number }): boolean {
    const fr = fourRankIn(counts);
    for (const k in counts) {
        if (!counts.hasOwnProperty(k)) {
            continue;
        }
        const rk = parseInt(k, 10);
        const c = counts[k];
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

function tryPurePlane(counts: { [k: string]: number }): DdzHandPattern | null {
    const n = totalN(counts);
    if (n % 3 !== 0 || n < 6) {
        return null;
    }
    const k = n / 3;
    if (Object.keys(counts).length !== k) {
        return null;
    }
    for (let st = 0; st < 12; st++) {
        if (st + k - 1 > 11) {
            break;
        }
        let ok = true;
        for (let r = st; r < st + k; r++) {
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

function matchPlaneWingsAt(
    full: { [k: string]: number },
    st: number,
    k: number,
    numPairWings: number
): DdzHandPattern | null {
    const c: { [k: string]: number } = {};
    for (const kk in full) {
        if (full.hasOwnProperty(kk)) {
            c[kk] = full[kk];
        }
    }
    for (let r = st; r < st + k; r++) {
        const rs = String(r);
        if ((c[rs] || 0) < 3) {
            return null;
        }
        c[rs] = c[rs] - 3;
        if (c[rs] === 0) {
            delete c[rs];
        }
    }
    for (let r = st; r < st + k; r++) {
        if ((c[String(r)] || 0) !== 0) {
            return null;
        }
    }
    let singles = 0;
    let pairs = 0;
    for (const rk in c) {
        if (!c.hasOwnProperty(rk)) {
            continue;
        }
        const cnt = c[rk];
        const irk = parseInt(rk, 10);
        if (irk >= 13) {
            return null;
        }
        if (cnt !== 1 && cnt !== 2) {
            return null;
        }
        if (cnt === 1) {
            singles++;
        } else {
            pairs++;
        }
    }
    if (singles + pairs !== k) {
        return null;
    }
    if (pairs !== numPairWings) {
        return null;
    }
    const ex = (k << 5) | numPairWings;
    return { kind: DDZ_KIND_PLANE_WITH_WINGS, main: st + k - 1, extra: ex };
}

function tryPlaneWithWings(counts: { [k: string]: number }): DdzHandPattern | null {
    const n = totalN(counts);
    for (let k = 2; k < 13; k++) {
        const minC = 4 * k;
        const maxC = 5 * k;
        if (n < minC || n > maxC) {
            continue;
        }
        const numPairWings = n - 4 * k;
        if (numPairWings < 0 || numPairWings > k) {
            continue;
        }
        for (let st = 0; st < 12; st++) {
            if (st + k - 1 > 11) {
                break;
            }
            const pat = matchPlaneWingsAt(counts, st, k, numPairWings);
            if (pat) {
                return pat;
            }
        }
    }
    return null;
}

function classify(cards: number[]): DdzHandPattern {
    if (cards.length === 0) {
        return { kind: DDZ_KIND_PASS, main: -1, extra: null };
    }
    const n = cards.length;
    if (n === 2) {
        const a = cards[0];
        const b = cards[1];
        if ((a === 52 && b === 53) || (a === 53 && b === 52)) {
            return { kind: DDZ_KIND_ROCKET, main: 14, extra: null };
        }
    }
    const counts = rankCounts(cards);
    const vals: number[] = [];
    const keys: string[] = [];
    for (const k in counts) {
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
            const sr = sortedRanks(cards);
            return { kind: DDZ_KIND_STRAIGHT, main: sr[sr.length - 1], extra: n };
        }
        if (isTriplePair(counts)) {
            return { kind: DDZ_KIND_TRIPLE_WITH_PAIR, main: tripleRankIn(counts), extra: 5 };
        }
        return { kind: DDZ_KIND_INVALID, main: -1, extra: null };
    }
    if (n >= 5) {
        if (isStraight(counts, n)) {
            const sr2 = sortedRanks(cards);
            return { kind: DDZ_KIND_STRAIGHT, main: sr2[sr2.length - 1], extra: n };
        }
    }
    if (n >= 6 && n % 2 === 0 && isPairStraight(counts)) {
        const pr = pairStraightRanks(counts);
        return { kind: DDZ_KIND_PAIR_STRAIGHT, main: pr[pr.length - 1], extra: n };
    }
    if (n === 6 && isFourTwoSingles(counts) && fourKickersNoJokerBomb(counts)) {
        return { kind: DDZ_KIND_FOUR_WITH_TWO, main: fourRankIn(counts), extra: 6 };
    }
    if (n === 8 && isFourTwoPairs(counts) && fourKickersNoJokerBomb(counts)) {
        return { kind: DDZ_KIND_FOUR_WITH_TWO, main: fourRankIn(counts), extra: 8 };
    }
    const pure = tryPurePlane(counts);
    if (pure) {
        return pure;
    }
    const pww = tryPlaneWithWings(counts);
    if (pww) {
        return pww;
    }
    return { kind: DDZ_KIND_INVALID, main: -1, extra: null };
}

function samePatternKind(a: DdzHandPattern, b: DdzHandPattern): boolean {
    if (a.kind !== b.kind) {
        return false;
    }
    return a.extra === b.extra;
}

function beats(last: DdzHandPattern, cur: DdzHandPattern): boolean {
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

function roundMultiplier(s: DdzMatchState): number {
    return s.multBase * s.multRob * s.multPlay;
}

function removeCardsFromHand(hand: number[], play: number[]): boolean {
    const rem = play.slice();
    for (let i = 0; i < rem.length; i++) {
        let found = -1;
        const want = rem[i];
        for (let j = 0; j < hand.length; j++) {
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
function normUserId(uid: string): string {
    return uid.toLowerCase();
}

function assignSeats(state: DdzMatchState): void {
    const ids = Object.keys(state.presences);
    ids.sort();
    state.seatByUserId = {};
    const eh = state.expectHumans;
    state.isAiSeat = [false, false, false];
    for (let i = 0; i < ids.length; i++) {
        state.seatByUserId[normUserId(ids[i])] = i;
    }
    for (let s = eh; s < 3; s++) {
        state.isAiSeat[s] = true;
    }
}

function seatForUser(state: DdzMatchState, userId: string): number {
    const s = state.seatByUserId[normUserId(userId)];
    return s === undefined ? -1 : s;
}

function assignSeatCats(state: DdzMatchState, nk: nkruntime.Nakama): void {
    const arr = [0, 1, 2];
    shuffleInPlace(nk, arr);
    state.seatCat = arr;
}

function resetRound(state: DdzMatchState, nk: nkruntime.Nakama): void {
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
    const deck = makeFullDeck();
    shuffleInPlace(nk, deck);
    const sb = randomBytesCompat(nk, 8);
    state.dealSeed = Array.prototype.map
        .call(sb, function (x: number) {
            return ("0" + x.toString(16)).slice(-2);
        })
        .join("");
    const trace: { seat: number; card: number }[] = [];
    for (let i = 0; i < 51; i++) {
        trace.push({ seat: i % 3, card: deck[i] });
    }
    state.dealTrace = trace;
    for (let i = 0; i < 17; i++) {
        state.hands[0].push(deck[i]);
        state.hands[1].push(deck[i + 17]);
        state.hands[2].push(deck[i + 34]);
    }
    state.bottom = [deck[51], deck[52], deck[53]];
    sortHand(state.hands[0]);
    sortHand(state.hands[1]);
    sortHand(state.hands[2]);
    state.phase = "bidding_call";
    const first = randomIntBelow(nk, 3);
    state.awaitSeat = first;
    state.callRoundStartSeat = first;
    state.bottomRevealIds = [];
    /** 与客户端发牌动画+停顿对齐，避免「继续下一局」后 AI 瞬间叫完 */
    state.aiPlayDelayUntilMs = Date.now() + AI_NEW_ROUND_BID_DELAY_MS;
}

function finalizeLandlordFromRob(state: DdzMatchState): void {
    if (state.lastRobber >= 0) {
        state.landlord = state.lastRobber;
    } else {
        state.landlord = state.callCandidate;
    }
    state.phase = "play";
    mergeLandlordBottom(state);
    state.turn = state.landlord;
    clearTrick(state);
}

/** 「不叫」者不可抢：该座位自动跳过抢地主轮次。每 tick 至多推进一步，以便客户端逐条播「没叫牌不能抢」气泡。 */
function autoAdvanceRob(state: DdzMatchState): boolean {
    if (state.phase !== "bidding_rob") {
        return false;
    }
    const cand = state.callCandidate;
    const i = (cand + 1 + state.robStep) % 3;
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

function applyBid(state: DdzMatchState, seat: number, bid: number, nk: nkruntime.Nakama): string | null {
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
    let passCount = 0;
    for (let j = 0; j < 3; j++) {
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

function mergeLandlordBottom(state: DdzMatchState): void {
    const L = state.landlord;
    state.bottomRevealIds = state.bottom.slice();
    for (let i = 0; i < state.bottom.length; i++) {
        state.hands[L].push(state.bottom[i]);
    }
    sortHand(state.hands[L]);
    state.bottom = [];
}

function clearTrick(state: DdzMatchState): void {
    state.lastPattern = null;
    state.lastPlayer = -1;
    state.passes = 0;
    state.lastPlayIds = [];
}

function applyRob(state: DdzMatchState, seat: number, doRob: boolean): string | null {
    if (state.phase !== "bidding_rob") {
        return "not_in_rob";
    }
    const cand = state.callCandidate;
    const i = (cand + 1 + state.robStep) % 3;
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
    } else {
        finalizeLandlordFromRob(state);
    }
    return null;
}

function applyPlay(state: DdzMatchState, seat: number, cardIds: number[]): string | null {
    if (state.phase !== "play") {
        return "not_in_play";
    }
    if (seat !== state.turn) {
        return "not_your_turn";
    }
    const pat = classify(cardIds);
    if (pat.kind === DDZ_KIND_PASS || pat.kind === DDZ_KIND_INVALID) {
        return "invalid_play";
    }
    const last = state.lastPattern;
    const effectiveLast: DdzHandPattern = last
        ? last
        : ({
              kind: DDZ_KIND_PASS,
              main: -1,
              extra: null,
          } as DdzHandPattern);
    const trickFree = !last || last.kind === DDZ_KIND_PASS || state.passes >= 2;
    if (!trickFree && !beats(effectiveLast, pat)) {
        return "cannot_beat";
    }
    const hand = state.hands[seat];
    const copy = hand.slice();
    if (!removeCardsFromHand(copy, cardIds)) {
        return "cards_not_in_hand";
    }
    state.hands[seat] = copy;
    if (pat.kind === DDZ_KIND_BOMB) {
        state.multPlay *= 2;
        state.playBombCount++;
    } else if (pat.kind === DDZ_KIND_ROCKET) {
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

function applyContinue(state: DdzMatchState, seat: number, nk: nkruntime.Nakama): string | null {
    if (state.phase !== "finished") {
        return "not_in_finished";
    }
    state.continueReady[seat] = true;
    let all = true;
    for (let i = 0; i < 3; i++) {
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

function applyPass(state: DdzMatchState, seat: number): string | null {
    if (state.phase !== "play") {
        return "not_in_play";
    }
    if (seat !== state.turn) {
        return "not_your_turn";
    }
    const last = state.lastPattern;
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

function settlementFarmersWin(state: DdzMatchState): boolean {
    return state.winner >= 0 && state.winner !== state.landlord;
}

/** 春天：对手全程未出牌；地主 20 张、农民各 17 张未动 */
function springBonus(state: DdzMatchState): boolean {
    if (state.winner < 0) {
        return false;
    }
    if (settlementFarmersWin(state)) {
        return state.hands[state.landlord].length === 20;
    }
    return state.hands[(state.landlord + 1) % 3].length === 17 && state.hands[(state.landlord + 2) % 3].length === 17;
}

/** 每人游戏币 delta：基础筹码 100 × 最终倍率；地主赢 +100×m×2 / 农民各 -100×m；农民赢则相反（与客户端 main.gd 一致，不含春天加倍） */
function computeScoreDeltas(state: DdzMatchState): number[] {
    const m = roundMultiplier(state);
    const base = 100;
    const out = [0, 0, 0];
    if (state.winner < 0) {
        return out;
    }
    const L = state.landlord;
    const isFarmWin = settlementFarmersWin(state);
    if (isFarmWin) {
        out[L] = -base * m * 2;
        const f1 = (L + 1) % 3;
        const f2 = (L + 2) % 3;
        out[f1] = base * m;
        out[f2] = base * m;
    } else {
        out[L] = base * m * 2;
        const f1 = (L + 1) % 3;
        const f2 = (L + 2) % 3;
        out[f1] = -base * m;
        out[f2] = -base * m;
    }
    return out;
}

function buildPublicSnapshot(state: DdzMatchState): string {
    const handsPublic: number[][] = [[], [], []];
    for (let s = 0; s < 3; s++) {
        handsPublic[s] = state.hands[s].map(function () {
            return -1;
        });
    }
    const payload = {
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

function broadcastState(
    dispatcher: nkruntime.MatchDispatcher,
    state: DdzMatchState,
    logger: nkruntime.Logger,
    reason: string
): void {
    state.seq++;
    try {
        const snap = buildPublicSnapshot(state);
        dispatcher.broadcastMessage(DDZ_OP_SNAPSHOT, snap, null, null);
        const userIds = Object.keys(state.presences);
        for (let u = 0; u < userIds.length; u++) {
            const uid = userIds[u];
            const seat = seatForUser(state, uid);
            if (seat < 0) {
                logger.warn("broadcastState(%s): seat missing for userId=%s", reason, uid);
                continue;
            }
            const handMsg = JSON.stringify({
                v: 1,
                seq: state.seq,
                yourSeat: seat,
                yourHand: state.hands[seat],
            });
            const pres = state.presences[uid];
            dispatcher.broadcastMessage(DDZ_OP_SNAPSHOT, handMsg, [pres], null);
        }
        if (reason.indexOf("join") >= 0) {
            logger.info(
                "ddz broadcastState ok [%s]: seq=%d phase=%s players=%d",
                reason,
                state.seq,
                state.phase,
                userIds.length
            );
        }
    } catch (e) {
        logger.error(
            "ddz broadcastState FAILED [%s]: %s | phase=%s seq=%d",
            reason,
            String(e),
            state.phase,
            state.seq
        );
    }
}

function initialState(): DdzMatchState {
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

function ddzMatchInit(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    params: { [key: string]: string }
): { state: nkruntime.MatchState; tickRate: number; label: string } {
    logger.info("ddz matchInit: params=%s", JSON.stringify(params));
    const st: DdzMatchState = initialState();
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
        state: st as unknown as nkruntime.MatchState,
        tickRate: 10,
        label: "ddz",
    };
}

function ddzMatchJoinAttempt(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    presence: nkruntime.Presence,
    metadata: { [key: string]: any }
): { state: nkruntime.MatchState; accept: boolean; rejectMessage?: string } | null {
    const st = state as unknown as DdzMatchState;
    const n = Object.keys(st.presences).length;
    if (n >= st.expectHumans) {
        logger.warn(
            "ddz matchJoinAttempt REJECT full: userId=%s username=%s currentCount=%d expectHumans=%d",
            presence.userId,
            presence.username,
            n,
            st.expectHumans
        );
        return { state: state, accept: false, rejectMessage: "full" };
    }
    logger.info(
        "ddz matchJoinAttempt accept: userId=%s username=%s sessionId=%s currentCount=%d->%d",
        presence.userId,
        presence.username,
        presence.sessionId,
        n,
        n + 1
    );
    return { state: state, accept: true };
}

function ddzMatchJoin(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    presences: nkruntime.Presence[]
): { state: nkruntime.MatchState } | null {
    const st = state as unknown as DdzMatchState;
    const joinedIds: string[] = [];
    for (let i = 0; i < presences.length; i++) {
        const p = presences[i];
        st.presences[p.userId] = p;
        joinedIds.push(p.userId);
    }
    assignSeats(st);
    const n = Object.keys(st.presences).length;
    logger.info(
        "ddz matchJoin: tick=%d joinedThisBatch=%s totalPlayers=%d phaseBefore=%s seatByUserId=%s",
        tick,
        JSON.stringify(joinedIds),
        n,
        st.phase,
        JSON.stringify(st.seatByUserId)
    );
    if (n === st.expectHumans && st.phase === "waiting") {
        assignSeatCats(st, nk);
        resetRound(st, nk);
        logger.info("ddz matchJoin: resetRound done -> phase=%s dealSeed len=%d", st.phase, st.dealSeed.length);
        broadcastState(dispatcher, st, logger, "join-after-resetRound");
    } else {
        broadcastState(dispatcher, st, logger, "join");
    }
    return { state: st as unknown as nkruntime.MatchState };
}

/**
 * Nakama `MatchMessage.data` 类型为 ArrayBuffer（见 nakama-runtime index.d.ts）。
 * 使用 String(msg.data) 会得到 "[object ArrayBuffer]"，JSON.parse 失败且被 catch 吃掉 → 叫牌/出牌等全部不生效。
 */
function decodeMatchData(data: ArrayBuffer | string | null | undefined): string {
    if (data === null || data === undefined) {
        return "";
    }
    if (typeof data === "string") {
        return data;
    }
    const ab = data as ArrayBuffer;
    if (typeof TextDecoder !== "undefined") {
        try {
            return new TextDecoder("utf-8").decode(ab);
        } catch (e) {
            // fall through
        }
    }
    const u8 = new Uint8Array(ab);
    const bufAny = (globalThis as unknown as { Buffer?: { from: (a: Uint8Array) => { toString: (enc: string) => string } } })
        .Buffer;
    if (typeof bufAny !== "undefined") {
        return bufAny.from(u8).toString("utf8");
    }
    let s = "";
    for (let i = 0; i < u8.length; i++) {
        s += String.fromCharCode(u8[i]);
    }
    return s;
}

function ddzMatchLeave(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    presences: nkruntime.Presence[]
): { state: nkruntime.MatchState } | null {
    const st = state as unknown as DdzMatchState;
    for (let i = 0; i < presences.length; i++) {
        delete st.presences[presences[i].userId];
    }
    assignSeats(st);
    return { state: st as unknown as nkruntime.MatchState };
}

function ddzMatchLoop(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    messages: nkruntime.MatchMessage[]
): { state: nkruntime.MatchState } | null {
    const st = state as unknown as DdzMatchState;
    /** 与 ddz_ai_server 中 AI 连动共用 aiPlayDelayUntilMs，避免 matchLoop 每 100ms 连推抢地主跳过 */
    if (st.phase === "bidding_rob") {
        if (Date.now() >= st.aiPlayDelayUntilMs && autoAdvanceRob(st)) {
            broadcastState(dispatcher, st, logger, "autoAdvanceRob");
            st.aiPlayDelayUntilMs = Date.now() + AI_BID_ROB_PACE_MS;
        }
    }
    for (let m = 0; m < messages.length; m++) {
        const msg = messages[m];
        const senderId = msg.sender.userId;
        const seat = seatForUser(st, senderId);
        if (seat < 0) {
            logger.warn(
                "ddz matchLoop: unknown sender userId=%s keys=%s",
                senderId,
                JSON.stringify(Object.keys(st.seatByUserId))
            );
            continue;
        }
        let payload: { t?: string; bid?: number; rob?: boolean; cards?: number[]; text?: string };
        const rawJson = decodeMatchData(msg.data as ArrayBuffer | string);
        try {
            payload = JSON.parse(rawJson) as {
                t?: string;
                bid?: number;
                rob?: boolean;
                cards?: number[];
                text?: string;
            };
        } catch (e) {
            logger.warn(
                "ddz matchLoop: JSON.parse failed op=%d seat=%d err=%s raw=%s",
                msg.opCode,
                seat,
                String(e),
                rawJson.length > 120 ? rawJson.substring(0, 120) + "…" : rawJson
            );
            continue;
        }
        let err: string | null = null;
        if (msg.opCode === DDZ_REQ_BID) {
            const rawBid = payload.bid;
            let bidNum = -1;
            if (rawBid !== undefined && rawBid !== null) {
                if (typeof rawBid === "string") {
                    bidNum = parseInt(String(rawBid), 10);
                } else {
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
        } else if (msg.opCode === DDZ_REQ_ROB) {
            err = applyRob(st, seat, Boolean(payload.rob));
            if (!err && !st.isAiSeat[seat]) {
                st.aiPlayDelayUntilMs = Date.now() + AI_BID_ROB_PACE_MS;
            }
        } else if (msg.opCode === DDZ_REQ_PLAY) {
            const cards = payload.cards || [];
            err = applyPlay(st, seat, cards);
            if (!err && !st.isAiSeat[seat]) {
                st.aiPlayDelayUntilMs = Date.now() + AI_BID_ROB_PACE_MS;
            }
        } else if (msg.opCode === DDZ_REQ_PASS) {
            err = applyPass(st, seat);
            if (!err && !st.isAiSeat[seat]) {
                st.aiPlayDelayUntilMs = Date.now() + AI_BID_ROB_PACE_MS;
            }
        } else if (msg.opCode === DDZ_REQ_CONTINUE) {
            err = applyContinue(st, seat, nk);
        }
        if (err) {
            try {
                dispatcher.broadcastMessage(
                    DDZ_OP_ERROR,
                    JSON.stringify({ seq: st.seq, seat: seat, error: err }),
                    [msg.sender],
                    null
                );
            } catch (e2) {
                logger.error("send err: %v", String(e2));
            }
        } else {
            broadcastState(dispatcher, st, logger, "matchLoop");
            if (st.phase === "finished") {
                const deltas = computeScoreDeltas(st);
                const settlement = JSON.stringify({
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
    return { state: st as unknown as nkruntime.MatchState };
}

function ddzMatchTerminate(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    graceSeconds: number
): { state: nkruntime.MatchState } | null {
    return { state: state };
}

function ddzMatchSignal(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    data: string
): { state: nkruntime.MatchState; data?: string } | null {
    return { state: state, data: "ok" };
}

const ddzMatchHandler: nkruntime.MatchHandler<nkruntime.MatchState> = {
    matchInit: ddzMatchInit,
    matchJoinAttempt: ddzMatchJoinAttempt,
    matchJoin: ddzMatchJoin,
    matchLeave: ddzMatchLeave,
    matchLoop: ddzMatchLoop,
    matchTerminate: ddzMatchTerminate,
    matchSignal: ddzMatchSignal,
};

function ddzMatchmakerMatched(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    matches: nkruntime.MatchmakerResult[]
): string | void {
    logger.info("ddz matchmakerMatched: callback invoked, resultCount=%d", matches.length);
    for (let i = 0; i < matches.length; i++) {
        const row = matches[i];
        logger.info(
            "  ddz matchmakerMatched[%d]: userId=%s username=%s sessionId=%s partyId=%s props=%s",
            i,
            row.presence.userId,
            row.presence.username,
            row.presence.sessionId,
            row.partyId !== undefined ? row.partyId : "",
            JSON.stringify(row.properties)
        );
    }
    if (matches.length === 0) {
        logger.error("ddz matchmakerMatched: empty matches array — will not call matchCreate (clients get no match id)");
        return;
    }
    if (matches.length !== 3) {
        logger.warn(
            "ddz matchmakerMatched: expected 3 players for ddz, got %d — matchCreate may still run",
            matches.length
        );
    }
    try {
        logger.info("ddz matchmakerMatched: calling nk.matchCreate(\"ddz\", {expect_humans:3}) ...");
        const id = nk.matchCreate("ddz", { expect_humans: "3", ai: "0" });
        if (!id || String(id).length === 0) {
            logger.error("ddz matchmakerMatched: nk.matchCreate returned empty id");
            return;
        }
        logger.info("ddz matchmakerMatched: success match_id=%s for %d players", id, matches.length);
        return id;
    } catch (e) {
        logger.error("ddz matchmakerMatched: nk.matchCreate threw: %s", String(e));
        return;
    }
}

const DDZ_MM_WAIT_MS = 20000;

interface DdzMmQueueEntry {
    userId: string;
    username: string;
    joinedAtMs: number;
    ticket: string;
}

/** 队列 + 各 ticket 的 match_id 结果；存 Storage，避免 Nakama JS 冻结模块级数组导致无法 push。 */
interface DdzMmPersistedState {
    entries: DdzMmQueueEntry[];
    results: { [ticket: string]: { matchId: string } };
}

const DDZ_MM_COLLECTION = "ddz_mm";
const DDZ_MM_STATE_KEY = "queue_state";
/** 与 nkruntime.SystemUserId 一致：服务端全局存储归属 */
const DDZ_MM_OWNER = "00000000-0000-0000-0000-000000000000";

/** 时间戳 + 随机字节生成 ticket（无模块可变状态）。 */
function ddzMmMakeTicket(nk: nkruntime.Nakama): string {
    const u = randomBytesCompat(nk, 8);
    const hex = Array.prototype.map
        .call(u, function (x: number) {
            return ("0" + x.toString(16)).slice(-2);
        })
        .join("");
    return "ddzmm_" + Date.now().toString(36) + "_" + hex;
}

function ddzMmLoadState(nk: nkruntime.Nakama): { state: DdzMmPersistedState; version: string } {
    const rows = nk.storageRead([
        { collection: DDZ_MM_COLLECTION, key: DDZ_MM_STATE_KEY, userId: DDZ_MM_OWNER },
    ]);
    if (!rows || rows.length === 0) {
        return { state: { entries: [], results: {} }, version: "" };
    }
    const obj = rows[0];
    const clone = JSON.parse(JSON.stringify(obj.value)) as { entries?: unknown; results?: unknown };
    const entries: DdzMmQueueEntry[] = [];
    if (Array.isArray(clone.entries)) {
        for (let i = 0; i < clone.entries.length; i++) {
            const e = clone.entries[i] as { [k: string]: unknown };
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
    const results: { [k: string]: { matchId: string } } = {};
    if (clone.results && typeof clone.results === "object" && clone.results !== null) {
        const rawR = clone.results as { [k: string]: unknown };
        for (const k in rawR) {
            if (rawR.hasOwnProperty(k)) {
                const r = rawR[k] as { matchId?: unknown };
                if (r && typeof r.matchId === "string") {
                    results[k] = { matchId: r.matchId };
                }
            }
        }
    }
    return { state: { entries: entries, results: results }, version: obj.version };
}

function ddzMmSaveState(nk: nkruntime.Nakama, state: DdzMmPersistedState, version: string): void {
    const req: nkruntime.StorageWriteRequest = {
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

function ddzMmMutateState(
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    mutator: (state: DdzMmPersistedState) => void
): void {
    const maxTries = 24;
    for (let attempt = 0; attempt < maxTries; attempt++) {
        const loaded = ddzMmLoadState(nk);
        mutator(loaded.state);
        try {
            ddzMmSaveState(nk, loaded.state, loaded.version);
            return;
        } catch (e) {
            logger.warn("ddz_mm storage write retry %d: %s", attempt, String(e));
        }
    }
    throw new Error("ddz_mm_storage_failed");
}

function ddzMmNotifyResults(state: DdzMmPersistedState, tickets: string[], matchId: string): void {
    for (let i = 0; i < tickets.length; i++) {
        state.results[tickets[i]] = { matchId: matchId };
    }
}

function ddzMmCreateMatchInner(
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    entries: DdzMmQueueEntry[],
    humans: number,
    ai: number
): string | null {
    let id: string;
    try {
        id = nk.matchCreate("ddz", {
            expect_humans: String(humans),
            ai: String(ai),
        });
    } catch (e) {
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

function ddzMmProcessQueueCore(state: DdzMmPersistedState, nk: nkruntime.Nakama, logger: nkruntime.Logger): void {
    const now = Date.now();
    const q = state.entries.slice();
    q.sort(function (a, b) {
        return a.joinedAtMs - b.joinedAtMs;
    });
    while (q.length >= 3) {
        const a = q[0];
        const b = q[1];
        const c = q[2];
        const id = ddzMmCreateMatchInner(nk, logger, [a, b, c], 3, 0);
        if (!id) {
            break;
        }
        q.splice(0, 3);
        ddzMmNotifyResults(state, [a.ticket, b.ticket, c.ticket], id);
    }
    if (q.length >= 2) {
        const a = q[0];
        const b = q[1];
        const oldest = Math.min(a.joinedAtMs, b.joinedAtMs);
        if (now - oldest >= DDZ_MM_WAIT_MS) {
            const id = ddzMmCreateMatchInner(nk, logger, [a, b], 2, 1);
            if (id) {
                q.splice(0, 2);
                ddzMmNotifyResults(state, [a.ticket, b.ticket], id);
            }
        }
    }
    if (q.length >= 1) {
        const a = q[0];
        if (now - a.joinedAtMs >= DDZ_MM_WAIT_MS) {
            const id = ddzMmCreateMatchInner(nk, logger, [a], 1, 2);
            if (id) {
                q.splice(0, 1);
                ddzMmNotifyResults(state, [a.ticket], id);
            }
        }
    }
    state.entries = q;
}

function rpcDdzMmJoin(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    const uid = ctx.userId;
    if (!uid) {
        return JSON.stringify({ ok: false, error: "unauthorized" });
    }
    let outTicket = "";
    try {
        ddzMmMutateState(nk, logger, function (st: DdzMmPersistedState) {
            const nextEntries: DdzMmQueueEntry[] = [];
            for (let i = 0; i < st.entries.length; i++) {
                if (st.entries[i].userId !== uid) {
                    nextEntries.push(st.entries[i]);
                } else {
                    delete st.results[st.entries[i].ticket];
                }
            }
            const ticket = ddzMmMakeTicket(nk);
            let username = "";
            try {
                const acc = nk.accountGetId(uid);
                if (acc && acc.user && acc.user.username) {
                    username = acc.user.username;
                }
            } catch (e) {
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
    } catch (e) {
        logger.error("ddz_mm join storage: %s", String(e));
        return JSON.stringify({ ok: false, error: "storage_busy" });
    }
    logger.info("ddz_mm join user=%s ticket=%s", uid, outTicket);
    return JSON.stringify({ ok: true, ticket: outTicket });
}

function rpcDdzMmPoll(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    let ticket = "";
    try {
        const u = JSON.parse(payload || "{}");
        ticket = String(u.ticket || "");
    } catch (e) {
        return JSON.stringify({ ok: false, error: "bad_payload" });
    }
    if (!ticket) {
        return JSON.stringify({ ok: false, error: "no_ticket" });
    }
    let response = JSON.stringify({ ok: true, status: "waiting" });
    try {
        ddzMmMutateState(nk, logger, function (st: DdzMmPersistedState) {
            ddzMmProcessQueueCore(st, nk, logger);
            const r = st.results[ticket];
            if (r && r.matchId) {
                delete st.results[ticket];
                response = JSON.stringify({ ok: true, status: "matched", match_id: r.matchId });
            }
        });
    } catch (e) {
        logger.error("ddz_mm poll storage: %s", String(e));
        return JSON.stringify({ ok: false, error: "storage_busy" });
    }
    return response;
}

function rpcDdzMmCancel(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    let ticket = "";
    try {
        const u = JSON.parse(payload || "{}");
        ticket = String(u.ticket || "");
    } catch (e) {
        return JSON.stringify({ ok: false });
    }
    if (!ticket) {
        return JSON.stringify({ ok: false });
    }
    try {
        ddzMmMutateState(nk, logger, function (st: DdzMmPersistedState) {
            const next: DdzMmQueueEntry[] = [];
            for (let i = 0; i < st.entries.length; i++) {
                if (st.entries[i].ticket !== ticket) {
                    next.push(st.entries[i]);
                }
            }
            st.entries = next;
            delete st.results[ticket];
        });
    } catch (e) {
        logger.error("ddz_mm cancel storage: %s", String(e));
        return JSON.stringify({ ok: false, error: "storage_busy" });
    }
    return JSON.stringify({ ok: true });
}

const WALLET_COLLECTION = "doudizhu";
const WALLET_KEY = "wallet";
const WALLET_INITIAL = 3000;

function walletRead(nk: nkruntime.Nakama, userId: string): { coins: number; version: string } {
    const rows = nk.storageRead([{ collection: WALLET_COLLECTION, key: WALLET_KEY, userId: userId }]);
    if (!rows || rows.length === 0) {
        return { coins: 0, version: "" };
    }
    const v = rows[0].value as { coins?: number };
    const c = typeof v.coins === "number" && Number.isFinite(v.coins) ? Math.floor(v.coins) : 0;
    return { coins: c, version: rows[0].version || "" };
}

function walletWrite(nk: nkruntime.Nakama, userId: string, coins: number, version: string): void {
    const req: nkruntime.StorageWriteRequest = {
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

function rpcWalletSync(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    const uid = ctx.userId;
    if (!uid) {
        return JSON.stringify({ ok: false, error: "unauthorized" });
    }
    const r = walletRead(nk, uid);
    let coins = r.coins;
    if (coins <= 0) {
        coins = WALLET_INITIAL;
        try {
            walletWrite(nk, uid, coins, r.version);
        } catch (e) {
            logger.error("wallet_sync write: %s", String(e));
            return JSON.stringify({ ok: false, error: "storage_write" });
        }
    }
    return JSON.stringify({ ok: true, coins: coins });
}

function rpcWalletBuy(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    return rpcWalletApplyDelta(ctx, logger, nk, JSON.stringify({ delta: 100 }));
}

function rpcWalletApplyDelta(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    const uid = ctx.userId;
    if (!uid) {
        return JSON.stringify({ ok: false, error: "unauthorized" });
    }
    let delta = 0;
    try {
        const p = JSON.parse(payload || "{}");
        delta = Math.floor(Number((p as { delta?: unknown }).delta));
    } catch (e) {
        return JSON.stringify({ ok: false, error: "bad_payload" });
    }
    if (!Number.isFinite(delta)) {
        return JSON.stringify({ ok: false, error: "bad_delta" });
    }
    if (delta > 5000000 || delta < -5000000) {
        return JSON.stringify({ ok: false, error: "delta_out_of_range" });
    }
    const r = walletRead(nk, uid);
    let newCoins = r.coins + delta;
    if (newCoins < 0) {
        newCoins = 0;
    }
    try {
        walletWrite(nk, uid, newCoins, r.version);
    } catch (e) {
        logger.error("wallet_apply_delta: %s", String(e));
        return JSON.stringify({ ok: false, error: "storage_write" });
    }
    return JSON.stringify({ ok: true, coins: newCoins });
}

let InitModule: nkruntime.InitModule = function (
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    initializer: nkruntime.Initializer
) {
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
