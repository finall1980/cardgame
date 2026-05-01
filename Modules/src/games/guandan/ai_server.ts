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
function gdCopyCapForRawRank(rr: number): number {
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
function gdTallyVisibleRanksInHandsAndTable(state: GdMatchState): number[] {
    const cnt: number[] = new Array(15).fill(0);
    for (let s = 0; s < 4; s++) {
        const h = state.hands[s];
        for (let i = 0; i < h.length; i++) {
            const rr = gdRawRank(h[i]);
            if (rr >= 0 && rr < cnt.length) {
                cnt[rr]++;
            }
        }
    }
    if (state.lastPlayIds) {
        for (let j = 0; j < state.lastPlayIds.length; j++) {
            const rr = gdRawRank(state.lastPlayIds[j]);
            if (rr >= 0 && rr < cnt.length) {
                cnt[rr]++;
            }
        }
    }
    return cnt;
}

function gdGhostRanksDealtOrPlayed(state: GdMatchState): number[] {
    const vis = gdTallyVisibleRanksInHandsAndTable(state);
    const g: number[] = new Array(15).fill(0);
    for (let rr = 0; rr <= 14; rr++) {
        g[rr] = Math.max(0, gdCopyCapForRawRank(rr) - vis[rr]);
    }
    return g;
}

/** 某 rawRank 在除我以外三家手里的张数（精确，用于场况） */
function gdAiEstRankElsewhere(state: GdMatchState, seat: number, rr: number): number {
    let n = 0;
    for (let s = 0; s < 4; s++) {
        if (s === seat) {
            continue;
        }
        const h = state.hands[s];
        for (let i = 0; i < h.length; i++) {
            if (gdRawRank(h[i]) === rr) {
                n++;
            }
        }
    }
    return n;
}

/** 对手手中王的压力（越大越可能还有大炸），用于动炸犹豫 */
function gdAiJokersPressure(state: GdMatchState, seat: number): number {
    const mate = gdTeammateSeat(seat);
    let sj = 0;
    let bj = 0;
    for (let s = 0; s < 4; s++) {
        if (s === seat || s === mate) {
            continue;
        }
        const h = state.hands[s];
        for (let i = 0; i < h.length; i++) {
            const rr = gdRawRank(h[i]);
            if (rr === GD_RAW_RANK_SMALL_JOKER) {
                sj++;
            } else if (rr === GD_RAW_RANK_BIG_JOKER) {
                bj++;
            }
        }
    }
    return sj * 1.15 + bj * 1.55;
}

/**
 * 跟牌 / 多候选 L3：炸弹、天炸、同花顺 — 对手王多则减分；对手快游时大单略加分。
 */
function gdAiPlayThreatAdjustment(state: GdMatchState, seat: number, p: GdHandPattern, ids: number[]): number {
    void ids;
    let adj = 0;
    if (p.bombTier > 0 || p.kind === GD_KIND_KING_BOMB || p.kind === GD_KIND_STRAIGHT_FLUSH) {
        const jp = gdAiJokersPressure(state, seat);
        adj -= jp * 0.32;
        if (p.bombTier >= GD_BOMB_TIER_6) {
            adj -= gdAiEstRankElsewhere(state, seat, GD_RAW_RANK_2) * 0.07;
        }
    }
    if (p.kind === GD_KIND_SINGLE && ids.length === 1) {
        const rv = gdRankValue(ids[0], state.levelRankActive);
        if (rv >= 14) {
            const nextS = (seat + 1) % 4;
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
function gdAiFreeLeadCtx(
    _hand: number[],
    ids: number[],
    _lvl: number,
    p: GdHandPattern,
    rem: number[],
    state: GdMatchState,
    seat: number
): number {
    void _hand;
    void _lvl;
    let b = 0;
    const mate = gdTeammateSeat(seat);
    const mateLen = state.hands[mate].length;
    const isBombPlay =
        p.bombTier > 0 || p.kind === GD_KIND_KING_BOMB || p.kind === GD_KIND_STRAIGHT_FLUSH;
    if (mateLen <= 6 && mateLen > 0) {
        const coef = (7 - mateLen) * 0.24;
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
    const nextS = (seat + 1) % 4;
    if (nextS !== mate && state.hands[nextS].length <= 5 && state.hands[nextS].length > 0) {
        if (p.kind === GD_KIND_SINGLE && p.main <= 6) {
            b -= 0.5;
        }
        if (p.kind === GD_KIND_PAIR || p.kind === GD_KIND_TRIPLE) {
            b += 0.32;
        }
    }
    let minOpp = 99;
    for (let s = 0; s < 4; s++) {
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
    const ghost = gdGhostRanksDealtOrPlayed(state);
    const jokerOut = ghost[GD_RAW_RANK_SMALL_JOKER] + ghost[GD_RAW_RANK_BIG_JOKER];
    if (isBombPlay && jokerOut <= 1 && gdAiJokersPressure(state, seat) >= 2.5) {
        b -= 0.35;
    }
    return b;
}

/** 当前赢家是否为队友；为真时跟牌不压，送游。 */
function gdAiIsPartnerControllingTrick(state: GdMatchState, seat: number): boolean {
    return state.lastPlayer === gdTeammateSeat(seat);
}

/** 抗贡：末游方大王合计 ≥2 时，任一进贡方可点抗贡 */
function gdAiShouldResist(state: GdMatchState, seat: number): boolean {
    return state.tribute.payers.indexOf(seat) >= 0 && gdCanResistTribute(state);
}

/** 贡牌：选「非红心级牌中点力最大的一张」；若全是红心级牌则退而出之 */
function gdAiPickTributeCard(state: GdMatchState, seat: number): number {
    const hand = state.hands[seat];
    const lvl = state.levelRankActive;
    let bestId = -1;
    let bestVal = -1;
    for (let i = 0; i < hand.length; i++) {
        const id = hand[i];
        if (gdIsHeartLevelCard(id, lvl)) {
            continue;
        }
        const v = gdRankValue(id, lvl);
        if (v > bestVal) {
            bestVal = v;
            bestId = id;
        }
    }
    if (bestId < 0) {
        for (let i = 0; i < hand.length; i++) {
            if (gdIsHeartLevelCard(hand[i], lvl)) {
                return hand[i];
            }
        }
    }
    return bestId;
}

/** 还贡：rawRank≤7（≤10）合法牌中，优先剩牌结构估值最高；同分则保留「同花色在手中较多」的牌（略符「花色多」文档意向） */
function gdAiPickReturnCard(state: GdMatchState, seat: number): number {
    const hand = state.hands[seat];
    const lvl = state.levelRankActive;
    const candidates: number[] = [];
    for (let i = 0; i < hand.length; i++) {
        const id = hand[i];
        const rr = gdRawRank(id);
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
    let bestId = candidates[0];
    let bestS = -1e15;
    for (let ci = 0; ci < candidates.length; ci++) {
        const id = candidates[ci];
        const rem = gdAiRemovePlayFromHand(hand, [id]);
        let s = gdAiEvaluateRemainingHand(rem, lvl);
        const su = gdSuit(id);
        if (su >= 0) {
            let sameSuitLeft = 0;
            for (let j = 0; j < hand.length; j++) {
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

/** ----------- 牌型拆解辅助 ----------- */

interface GdAiHand {
    hand: number[];
    lvl: number;
    wilds: number[];
    /** rawRank → ids（不含 wild） */
    ranks: { [rr: string]: number[] };
    /** 以下 ranks 列表按 rankValue 升序；王（rr ∈ {13,14}）都归入 singlesRanks */
    singlesRanks: number[];
    pairsRanks: number[];
    triplesRanks: number[];
    bombRanks: number[];
}

function gdAiAnalyze(hand: number[], lvl: number): GdAiHand {
    const wilds: number[] = [];
    const ranks: { [rr: string]: number[] } = {};
    for (let i = 0; i < hand.length; i++) {
        const id = hand[i];
        if (gdIsHeartLevelCard(id, lvl)) {
            wilds.push(id);
            continue;
        }
        const rr = gdRawRank(id);
        const k = String(rr);
        if (!ranks[k]) {
            ranks[k] = [];
        }
        ranks[k].push(id);
    }
    const singlesRanks: number[] = [];
    const pairsRanks: number[] = [];
    const triplesRanks: number[] = [];
    const bombRanks: number[] = [];
    for (const k in ranks) {
        if (!ranks.hasOwnProperty(k)) {
            continue;
        }
        const rr = parseInt(k, 10);
        const c = ranks[k].length;
        if (c >= 4) {
            bombRanks.push(rr);
        } else if (c === 3) {
            triplesRanks.push(rr);
        } else if (c === 2) {
            pairsRanks.push(rr);
        } else if (c === 1) {
            singlesRanks.push(rr);
        }
    }
    function byVal(a: number, b: number): number {
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
function gdAiLead(a: GdAiHand, mateHandLen: number): { pass: boolean; ids: number[] } {
    const mateRush = mateHandLen > 0 && mateHandLen <= 3;
    if (mateRush) {
        for (let i = 0; i < a.singlesRanks.length; i++) {
            const rr = a.singlesRanks[i];
            if (rr < 13) {
                return { pass: false, ids: [a.ranks[String(rr)][0]] };
            }
        }
        if (a.pairsRanks.length > 0) {
            const rr = a.pairsRanks[0];
            return { pass: false, ids: [a.ranks[String(rr)][0]] };
        }
        if (a.triplesRanks.length > 0) {
            const rr = a.triplesRanks[0];
            return { pass: false, ids: [a.ranks[String(rr)][0]] };
        }
    }
    /** 非送游：先出最小对子（保留结构），再出散单，减少「只打小单、乱拆对」 */
    if (a.pairsRanks.length > 0) {
        const rr = a.pairsRanks[0];
        if (rr < 13) {
            return { pass: false, ids: a.ranks[String(rr)].slice(0, 2) };
        }
    }
    // 1. 最小单张（非王）
    for (let i = 0; i < a.singlesRanks.length; i++) {
        const rr = a.singlesRanks[i];
        if (rr < 13) {
            return { pass: false, ids: [a.ranks[String(rr)][0]] };
        }
    }
    // 2. 最小三张
    if (a.triplesRanks.length > 0) {
        const rr = a.triplesRanks[0];
        return { pass: false, ids: a.ranks[String(rr)].slice(0, 3) };
    }
    // 4. 王（小王优先于大王）作为单张
    for (let i = 0; i < a.singlesRanks.length; i++) {
        const rr = a.singlesRanks[i];
        if (rr >= 13) {
            return { pass: false, ids: [a.ranks[String(rr)][0]] };
        }
    }
    // 5. 只剩炸：出最小炸（原生张数，不加 wild）
    if (a.bombRanks.length > 0) {
        const rr = a.bombRanks[0];
        const cnt = a.ranks[String(rr)].length;
        const use = Math.min(cnt, 8);
        return { pass: false, ids: a.ranks[String(rr)].slice(0, use) };
    }
    // 6. 只剩红心级牌：单张出
    if (a.wilds.length > 0) {
        return { pass: false, ids: [a.wilds[0]] };
    }
    return { pass: true, ids: [] };
}

/** 领出时鼓励顺子/连对/钢板/三带二（非炸），与剩余手 L3 估值一起用，避免只出小单。 */
function gdLeadPatternTypeBonus(pat: GdHandPattern): number {
    const k = pat.kind;
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
function gdFreeLeadNonTerminalHighBurn(
    remLen: number, ids: number[], lvl: number
): number {
    if (remLen <= 7) {
        return 0;
    }
    let sum = 0;
    for (let i = 0; i < ids.length; i++) {
        const v = gdRankValue(ids[i], lvl);
        if (v < 0) {
            sum += 1.0;
        } else {
            sum += v;
        }
    }
    const scale = remLen * 0.006;
    /** 略加重：领出时少甩 A/王/级牌等大点，避免中后期只剩小散张 */
    return sum * 0.16 * (1.0 + scale);
}

/** 自由领出统一打分：能一手走完给极大分；可选 ctx 注入送游/卡下家/记牌。 */
function gdScoreFreeLeadIds(
    hand: number[],
    ids: number[],
    lvl: number,
    ctx?: { state: GdMatchState; seat: number } | null
): number {
    if (ids.length < 1) {
        return -1e20;
    }
    const p = gdClassify(ids, lvl);
    if (p.kind === GD_KIND_INVALID) {
        return -1e20;
    }
    const rem = gdAiRemovePlayFromHand(hand, ids);
    if (rem.length === 0) {
        return 1e12;
    }
    let s =
        gdAiEvaluateRemainingHand(rem, lvl) +
        gdAiLeadFreeBonus(p, ids.length) +
        gdLeadPatternTypeBonus(p) +
        Math.min(0.25 * ids.length, 1.0) -
        gdFreeLeadNonTerminalHighBurn(rem.length, ids, lvl);
    /** 拆对/拆三出单：强罚，抑制「只出单张」 */
    if (p.kind === GD_KIND_SINGLE && ids.length === 1) {
        const a0 = gdAiAnalyze(hand, lvl);
        const a1 = gdAiAnalyze(rem, lvl);
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
function gdEachKCombinationIndices(
    n: number,
    k: number,
    onEach: (idx: number[]) => boolean | void,
    maxOut: number
): void {
    if (k < 0 || k > n || maxOut < 1) {
        return;
    }
    const idx: number[] = new Array(k);
    for (let i = 0; i < k; i++) {
        idx[i] = i;
    }
    let count = 0;
    for (;;) {
        if (onEach(idx) === true) {
            return;
        }
        count++;
        if (count >= maxOut) {
            return;
        }
        let s = k - 1;
        while (s >= 0 && idx[s] === n - k + s) {
            s--;
        }
        if (s < 0) {
            return;
        }
        idx[s] += 1;
        for (let j = s + 1; j < k; j++) {
            idx[j] = idx[j - 1] + 1;
        }
    }
}

/**
 * 枚举 n 选 k 的组合总数（不展开），用于定 cap
 */
function gdBinomialEstimate(n: number, k: number): number {
    if (k < 0 || k > n) {
        return 0;
    }
    if (k > n - k) {
        k = n - k;
    }
    let c = 1;
    for (let i = 0; i < k; i++) {
        c = (c * (n - i)) / (i + 1) | 0;
    }
    return c;
}

/**
 * 在「手牌过多无法 2^n」时，用 k=4/5/6 子集 + gdClassify 找顺子/连对/三带二/炸等可领出牌型，取分最高者。
 */
function gdAiFreeLeadKComboBest(
    hand: number[],
    lvl: number,
    ctx?: { state: GdMatchState; seat: number } | null
): number[] | null {
    const n = hand.length;
    if (n < 4) {
        return null;
    }
    const sorted = hand
        .slice()
        .sort(function (a, b) {
            return a - b;
        });
    let best: number[] | null = null;
    let bestS = -1e20;
    function consider(ids: number[]) {
        const sc = gdScoreFreeLeadIds(hand, ids, lvl, ctx);
        if (sc > 1e9) {
            best = ids;
            bestS = sc;
        } else if (sc > bestS) {
            bestS = sc;
            best = ids;
        }
    }
    const kSizes = [4, 5, 6, 7, 8, 10, 12];
    for (let ki = 0; ki < kSizes.length; ki++) {
        const k = kSizes[ki];
        if (n < k) {
            continue;
        }
        const total = gdBinomialEstimate(n, k);
        let cap = Math.min(GD_AI_FREE_LEAD_KCOMBO_MAX, Math.max(1, total));
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
        gdEachKCombinationIndices(
            n,
            k,
            function (ix) {
                const ids: number[] = [];
                for (let t = 0; t < ix.length; t++) {
                    ids.push(sorted[ix[t]]);
                }
                if (ids.length > 0) {
                    const p = gdClassify(ids, lvl);
                    if (p.kind === GD_KIND_INVALID) {
                        return;
                    }
                    consider(ids);
                }
                if (bestS > 1e9) {
                    return true;
                }
                return;
            },
            cap
        );
        if (bestS > 1e9) {
            break;
        }
    }
    return best;
}

/**
 * 自由领出：n≤L4 时子集 2^n；否则 k=4,5,6 组合 + 与「基础 gdAiLead」三选一最高分。
 */
function gdAiFreeLeadMain(
    hand: number[],
    lvl: number,
    mateLen: number,
    state: GdMatchState,
    seat: number
): { pass: boolean; ids: number[] } {
    const ctx = { state: state, seat: seat };
    const a0 = gdAiAnalyze(hand, lvl);
    const baseline = gdAiLead(a0, mateLen);
    if (baseline.pass || baseline.ids.length < 1) {
        return { pass: true, ids: [] };
    }
    let bestIds: number[] = baseline.ids;
    let bestS = gdScoreFreeLeadIds(hand, bestIds, lvl, ctx);
    // 基准若出单张：用 L3 在「全部合法单张」里重选，减少乱拆结构
    if (!baseline.pass && baseline.ids.length === 1) {
        const bs = gdAiLeadBestSingle(hand, lvl, state, seat);
        if (bs && !bs.pass && bs.ids.length > 0) {
            const s2 = gdScoreFreeLeadIds(hand, bs.ids, lvl, ctx);
            if (s2 > bestS) {
                bestS = s2;
                bestIds = bs.ids;
            }
        }
    }
    if (hand.length >= 1 && hand.length <= GD_AI_L4_LEAD_MAX_CARDS) {
        const l4 = gdAiTryFreeLeadL4(hand, lvl, ctx);
        if (l4 && !l4.pass && l4.ids.length > 0) {
            const s = gdScoreFreeLeadIds(hand, l4.ids, lvl, ctx);
            if (s > bestS) {
                bestS = s;
                bestIds = l4.ids;
            }
        }
    } else {
        const kcb = gdAiFreeLeadKComboBest(hand, lvl, ctx);
        if (kcb && kcb.length > 0) {
            const s = gdScoreFreeLeadIds(hand, kcb, lvl, ctx);
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
function gdAiLeadBestSingle(
    hand: number[],
    lvl: number,
    state: GdMatchState,
    seat: number
): { pass: boolean; ids: number[] } | null {
    const candidates: number[][] = [];
    const seen: { [k: string]: boolean } = {};
    for (let i = 0; i < hand.length; i++) {
        const ids = [hand[i]];
        const p = gdClassify(ids, lvl);
        if (p.kind !== GD_KIND_SINGLE) {
            continue;
        }
        const ky = String(hand[i]);
        if (!seen[ky]) {
            seen[ky] = true;
            candidates.push(ids);
        }
    }
    if (candidates.length === 0) {
        return null;
    }
    const pick = gdAiPickBestPlayL3(hand, lvl, candidates, { state: state, seat: seat });
    return pick ? { pass: false, ids: pick.ids } : null;
}

/** 跟单张：枚举能压过的全部单张，L3 选优（比「按 singlesRanks 顺序取第一张」更省大牌、少拆炸） */
function gdAiFollowSingleBest(
    hand: number[],
    last: GdHandPattern,
    lvl: number,
    state: GdMatchState,
    seat: number
): { ids: number[] } | null {
    const candidates: number[][] = [];
    const seen: { [k: string]: boolean } = {};
    for (let i = 0; i < hand.length; i++) {
        const ids = [hand[i]];
        const p = gdClassify(ids, lvl);
        if (p.kind !== GD_KIND_SINGLE) {
            continue;
        }
        if (!gdBeats(last, p)) {
            continue;
        }
        const ky = String(hand[i]);
        if (!seen[ky]) {
            seen[ky] = true;
            candidates.push(ids);
        }
    }
    if (candidates.length === 0) {
        return null;
    }
    const pick = gdAiPickBestPlayL3(hand, lvl, candidates, { state: state, seat: seat });
    return pick ? pick : null;
}

/** 尝试组出一张「价值 > lastMain」的单张；允许拆对/三，红心级牌等效为级牌价值 */
function gdAiFollowSingle(a: GdAiHand, lastMain: number): { ids: number[] } | null {
    for (let i = 0; i < a.singlesRanks.length; i++) {
        const rr = a.singlesRanks[i];
        if (gdRankValueFromRaw(rr, a.lvl) > lastMain) {
            return { ids: [a.ranks[String(rr)][0]] };
        }
    }
    for (let i = 0; i < a.pairsRanks.length; i++) {
        const rr = a.pairsRanks[i];
        if (gdRankValueFromRaw(rr, a.lvl) > lastMain) {
            return { ids: [a.ranks[String(rr)][0]] };
        }
    }
    for (let i = 0; i < a.triplesRanks.length; i++) {
        const rr = a.triplesRanks[i];
        if (gdRankValueFromRaw(rr, a.lvl) > lastMain) {
            return { ids: [a.ranks[String(rr)][0]] };
        }
    }
    // 拆炸（很浪费，放最后）
    for (let i = 0; i < a.bombRanks.length; i++) {
        const rr = a.bombRanks[i];
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

function gdAiFollowPair(a: GdAiHand, lastMain: number): { ids: number[] } | null {
    for (let i = 0; i < a.pairsRanks.length; i++) {
        const rr = a.pairsRanks[i];
        if (gdRankValueFromRaw(rr, a.lvl) > lastMain) {
            return { ids: a.ranks[String(rr)].slice(0, 2) };
        }
    }
    for (let i = 0; i < a.triplesRanks.length; i++) {
        const rr = a.triplesRanks[i];
        if (gdRankValueFromRaw(rr, a.lvl) > lastMain) {
            return { ids: a.ranks[String(rr)].slice(0, 2) };
        }
    }
    // 单 + wild 凑对
    if (a.wilds.length > 0) {
        for (let i = 0; i < a.singlesRanks.length; i++) {
            const rr = a.singlesRanks[i];
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

function gdAiFollowTriple(a: GdAiHand, lastMain: number): { ids: number[] } | null {
    for (let i = 0; i < a.triplesRanks.length; i++) {
        const rr = a.triplesRanks[i];
        if (gdRankValueFromRaw(rr, a.lvl) > lastMain) {
            return { ids: a.ranks[String(rr)].slice(0, 3) };
        }
    }
    // 对 + wild 凑三
    if (a.wilds.length > 0) {
        for (let i = 0; i < a.pairsRanks.length; i++) {
            const rr = a.pairsRanks[i];
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
        for (let i = 0; i < a.singlesRanks.length; i++) {
            const rr = a.singlesRanks[i];
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
function gdAiCloneRankBuckets(src: { [k: string]: number[] }): { [k: string]: number[] } {
    const o: { [k: string]: number[] } = {};
    for (const k in src) {
        if (src.hasOwnProperty(k)) {
            o[k] = src[k].slice();
        }
    }
    return o;
}

/** 非红心级牌按 rawRank 分桶；红心级牌进 wilds（与 gdSplitWilds 一致） */
function gdAiNormalsBucketsByRank(
    hand: number[],
    lvl: number
): { buckets: { [k: string]: number[] }; wilds: number[] } {
    const sp = gdSplitWilds(hand, lvl);
    const buckets: { [k: string]: number[] } = {};
    for (let i = 0; i < sp.normals.length; i++) {
        const id = sp.normals[i];
        const k = String(gdRawRank(id));
        if (!buckets[k]) {
            buckets[k] = [];
        }
        buckets[k].push(id);
    }
    for (const k in buckets) {
        if (buckets.hasOwnProperty(k)) {
            buckets[k].sort(function (a, b) {
                return a - b;
            });
        }
    }
    const wilds = sp.wilds.slice().sort(function (a, b) {
        return a - b;
    });
    return { buckets: buckets, wilds: wilds };
}

function gdAiDedupPushPlay(out: number[][], seen: { [k: string]: boolean }, ids: number[]): void {
    const t = ids.slice().sort(function (a, b) {
        return a - b;
    });
    const ky = t.join(",");
    if (!seen[ky]) {
        seen[ky] = true;
        out.push(ids);
    }
}

/**
 * 跟牌：连对（6/8/10…张，与 last.len 相同）。顶序枚举，避免 C(n,k) 全组合。
 */
function gdAiEnumerateBeatingPairStraights(hand: number[], last: GdHandPattern, lvl: number): number[][] {
    if (last.kind !== GD_KIND_PAIR_STRAIGHT) {
        return [];
    }
    const wantLen = last.len;
    if (wantLen < 6 || wantLen % 2 !== 0) {
        return [];
    }
    const numPairs = (wantLen / 2) | 0;
    if (numPairs < 3) {
        return [];
    }
    const base = gdAiNormalsBucketsByRank(hand, lvl);
    const out: number[][] = [];
    const seen: { [k: string]: boolean } = {};
    gdForEachPairStraightSeqTemplate(lvl, numPairs, function (seq: number[]) {
        const bk = gdAiCloneRankBuckets(base.buckets);
        const wildsLeft = base.wilds.slice();
        const ids: number[] = [];
        let ok = true;
        for (let si = 0; si < seq.length; si++) {
            let need = 2;
            const arr = bk[String(seq[si])] || [];
            while (need > 0 && arr.length > 0) {
                ids.push(arr.shift()!);
                need--;
            }
            while (need > 0 && wildsLeft.length > 0) {
                ids.push(wildsLeft.pop()!);
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
        const p = gdClassify(ids, lvl);
        if (p.kind !== GD_KIND_PAIR_STRAIGHT || !gdBeats(last, p)) {
            return;
        }
        gdAiDedupPushPlay(out, seen, ids);
    });
    return out;
}

/** 跟牌：钢板（2 连三，6 张） */
function gdAiEnumerateBeatingTripleStraights(hand: number[], last: GdHandPattern, lvl: number): number[][] {
    if (last.kind !== GD_KIND_TRIPLE_STRAIGHT || last.len !== 6) {
        return [];
    }
    const base = gdAiNormalsBucketsByRank(hand, lvl);
    const out: number[][] = [];
    const seen: { [k: string]: boolean } = {};
    for (let top = 1; top <= 11; top++) {
        const seq = [top - 1, top];
        if (!gdSeqAllowedForStraight(seq, lvl)) {
            continue;
        }
        const bk = gdAiCloneRankBuckets(base.buckets);
        const wildsLeft = base.wilds.slice();
        const ids: number[] = [];
        let ok = true;
        for (let si = 0; si < seq.length; si++) {
            let need = 3;
            const arr = bk[String(seq[si])] || [];
            while (need > 0 && arr.length > 0) {
                ids.push(arr.shift()!);
                need--;
            }
            while (need > 0 && wildsLeft.length > 0) {
                ids.push(wildsLeft.pop()!);
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
        const p = gdClassify(ids, lvl);
        if (p.kind !== GD_KIND_TRIPLE_STRAIGHT || !gdBeats(last, p)) {
            continue;
        }
        gdAiDedupPushPlay(out, seen, ids);
    }
    return out;
}

/** 跟牌：顺子（5 张），含 A2345 顶顺 */
function gdAiEnumerateBeatingStraights(hand: number[], last: GdHandPattern, lvl: number): number[][] {
    if (last.kind !== GD_KIND_STRAIGHT || last.len !== 5) {
        return [];
    }
    const base = gdAiNormalsBucketsByRank(hand, lvl);
    const out: number[][] = [];
    const seen: { [k: string]: boolean } = {};
    function trySeq(seq: number[]): void {
        if (!gdSeqAllowedForStraight(seq, lvl)) {
            return;
        }
        const bk = gdAiCloneRankBuckets(base.buckets);
        const wildsLeft = base.wilds.slice();
        const ids: number[] = [];
        let ok = true;
        for (let si = 0; si < seq.length; si++) {
            let need = 1;
            const arr = bk[String(seq[si])] || [];
            while (need > 0 && arr.length > 0) {
                ids.push(arr.shift()!);
                need--;
            }
            while (need > 0 && wildsLeft.length > 0) {
                ids.push(wildsLeft.pop()!);
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
        const p = gdClassify(ids, lvl);
        if (p.kind !== GD_KIND_STRAIGHT || !gdBeats(last, p)) {
            return;
        }
        gdAiDedupPushPlay(out, seen, ids);
    }
    for (let top = 4; top <= 11; top++) {
        trySeq([top - 4, top - 3, top - 2, top - 1, top]);
    }
    trySeq([11, 12, 0, 1, 2]);
    return out;
}

/** 线牌候选（已能压）→ L3；若无则尝试炸弹压非炸 */
function gdAiFollowLineThenBombs(
    hand: number[],
    a: GdAiHand,
    last: GdHandPattern,
    lvl: number,
    lineCands: number[][],
    state: GdMatchState,
    seat: number
): { pass: boolean; ids: number[] } {
    const tctx = { state: state, seat: seat };
    if (lineCands.length > 0) {
        const pick =
            lineCands.length === 1
                ? { ids: lineCands[0] }
                : gdAiPickBestPlayL3(hand, lvl, lineCands, tctx);
        return { pass: false, ids: pick ? pick.ids : lineCands[0] };
    }
    const bombs = gdAiFollowBombCandidates(a, last);
    if (bombs.length > 1) {
        const pick = gdAiPickBestPlayL3(hand, lvl, bombs, tctx);
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
function gdAiEnumerateBeatingTripleWithPair(hand: number[], last: GdHandPattern, lvl: number): number[][] {
    if (last.kind !== GD_KIND_TRIPLE_WITH_PAIR || last.len !== 5) {
        return [];
    }
    const base = gdAiNormalsBucketsByRank(hand, lvl);
    const out: number[][] = [];
    const seen: { [k: string]: boolean } = {};
    for (let tripleR = 0; tripleR <= 12; tripleR++) {
        for (let pairR = 0; pairR <= 12; pairR++) {
            if (pairR === tripleR) {
                continue;
            }
            const bk = gdAiCloneRankBuckets(base.buckets);
            const wildsLeft = base.wilds.slice();
            const ids: number[] = [];
            let ok = true;
            for (let need = 3; need > 0; ) {
                const arr = bk[String(tripleR)] || [];
                if (arr.length > 0) {
                    ids.push(arr.shift()!);
                    need--;
                } else if (wildsLeft.length > 0) {
                    ids.push(wildsLeft.pop()!);
                    need--;
                } else {
                    ok = false;
                    break;
                }
            }
            if (!ok) {
                continue;
            }
            for (let need = 2; need > 0; ) {
                const arr = bk[String(pairR)] || [];
                if (arr.length > 0) {
                    ids.push(arr.shift()!);
                    need--;
                } else if (wildsLeft.length > 0) {
                    ids.push(wildsLeft.pop()!);
                    need--;
                } else {
                    ok = false;
                    break;
                }
            }
            if (!ok || ids.length !== 5) {
                continue;
            }
            const p = gdClassify(ids, lvl);
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
function gdAiEnumerateBeatingStraightFlushes(hand: number[], last: GdHandPattern, lvl: number): number[][] {
    const sp = gdSplitWilds(hand, lvl);
    const bySuit: { [k: string]: { [r: string]: number[] } } = {};
    for (let su = 0; su < 4; su++) {
        bySuit[String(su)] = {};
    }
    for (let i = 0; i < sp.normals.length; i++) {
        const id = sp.normals[i];
        const r = gdRawRank(id);
        if (r >= 13) {
            continue;
        }
        const su = gdSuit(id);
        const buck = bySuit[String(su)];
        const k = String(r);
        if (!buck[k]) {
            buck[k] = [];
        }
        buck[k].push(id);
    }
    for (let su = 0; su < 4; su++) {
        const buck = bySuit[String(su)];
        for (const k in buck) {
            if (buck.hasOwnProperty(k)) {
                buck[k].sort(function (a, b) {
                    return a - b;
                });
            }
        }
    }
    const wildsBase = sp.wilds.slice().sort(function (a, b) {
        return a - b;
    });
    const out: number[][] = [];
    const seen: { [k: string]: boolean } = {};
    for (let suit = 0; suit < 4; suit++) {
        const buck = bySuit[String(suit)];
        function trySeq(seq: number[]): void {
            if (!gdSeqAllowedForStraight(seq, lvl)) {
                return;
            }
            const bk = gdAiCloneRankBuckets(buck);
            const wildsLeft = wildsBase.slice();
            const ids: number[] = [];
            let ok = true;
            for (let si = 0; si < seq.length; si++) {
                let need = 1;
                const arr = bk[String(seq[si])] || [];
                while (need > 0 && arr.length > 0) {
                    ids.push(arr.shift()!);
                    need--;
                }
                while (need > 0 && wildsLeft.length > 0) {
                    ids.push(wildsLeft.pop()!);
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
            const p = gdClassify(ids, lvl);
            if (p.kind !== GD_KIND_STRAIGHT_FLUSH || !gdBeats(last, p)) {
                return;
            }
            gdAiDedupPushPlay(out, seen, ids);
        }
        function tryWheel(): void {
            const seq = [11, 12, 0, 1, 2];
            const bk = gdAiCloneRankBuckets(buck);
            const wildsLeft = wildsBase.slice();
            const ids: number[] = [];
            let ok = true;
            for (let si = 0; si < seq.length; si++) {
                const r = seq[si];
                if (r === lvl) {
                    if (wildsLeft.length < 1) {
                        ok = false;
                        break;
                    }
                    ids.push(wildsLeft.pop()!);
                    continue;
                }
                let need = 1;
                const arr = bk[String(r)] || [];
                while (need > 0 && arr.length > 0) {
                    ids.push(arr.shift()!);
                    need--;
                }
                while (need > 0 && wildsLeft.length > 0) {
                    ids.push(wildsLeft.pop()!);
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
            const p = gdClassify(ids, lvl);
            if (p.kind !== GD_KIND_STRAIGHT_FLUSH || !gdBeats(last, p)) {
                return;
            }
            gdAiDedupPushPlay(out, seen, ids);
        }
        for (let top = 4; top <= 11; top++) {
            trySeq([top - 4, top - 3, top - 2, top - 1, top]);
        }
        tryWheel();
    }
    return out;
}

/** 炸弹链跟牌：结构化候选（点力炸弹 + 同花顺）经 classify/beats 过滤，再 L3；替代先跑满额 C(n,k)。 */
function gdAiMergeBeatingBombTierPlays(hand: number[], a: GdAiHand, last: GdHandPattern, lvl: number): number[][] {
    const out: number[][] = [];
    const seen: { [k: string]: boolean } = {};
    const bombs = gdAiFollowBombCandidates(a, last);
    for (let i = 0; i < bombs.length; i++) {
        const ids = bombs[i];
        const p = gdClassify(ids, lvl);
        if (p.kind === GD_KIND_INVALID) {
            continue;
        }
        if (!gdBeats(last, p)) {
            continue;
        }
        gdAiDedupPushPlay(out, seen, ids);
    }
    const sfs = gdAiEnumerateBeatingStraightFlushes(hand, last, lvl);
    for (let i = 0; i < sfs.length; i++) {
        gdAiDedupPushPlay(out, seen, sfs[i]);
    }
    return out;
}

/** 按 rank 的原生张数返回对应 bombTier */
function gdAiBombTierOfCount(cnt: number): number {
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

function gdAiTryKingBomb(a: GdAiHand): number[] | null {
    const smalls: number[] = [];
    const bigs: number[] = [];
    for (let i = 0; i < a.hand.length; i++) {
        const id = a.hand[i];
        const rr = gdRawRank(id);
        if (rr === 13) {
            smalls.push(id);
        } else if (rr === 14) {
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
function gdBruteFindBeatingPlay(hand: number[], last: GdHandPattern, lvl: number): number[] | null {
    const k = last.len;
    if (k < 1 || k > hand.length) {
        return null;
    }
    const n = hand.length;
    let tries = 0;
    const maxT = GD_AI_BRUTE_FIND_ONE_MAX_TRIES;
    const buf: number[] = new Array(k);
    function dfs(st: number, d: number): number[] | null {
        if (d === k) {
            tries++;
            if (tries > maxT) {
                return null;
            }
            const p = gdClassify(buf, lvl);
            if (p.kind === GD_KIND_INVALID) {
                return null;
            }
            if (gdBeats(last, p)) {
                return buf.slice();
            }
            return null;
        }
        for (let i = st; i < n; i++) {
            buf[d] = hand[i];
            const r = dfs(i + 1, d + 1);
            if (r) {
                return r;
            }
        }
        return null;
    }
    return dfs(0, 0);
}

/** L3：残局/跟牌 手牌张数上界；超过则只做单次爆搜找一解，避免 C(n,k) 全枚举 */
const GD_AI_L3_FOLLOW_MAX_HAND = 12;
/** L4：自由领出，子集 2^n 上界；≤11 → 2048 次 classify+估值 */
const GD_AI_L4_LEAD_MAX_CARDS = 11;
/** 手牌 > L4 时，按 C(n,k) 枚举合法领出，硬顶防单 tick CPU 过长 */
const GD_AI_FREE_LEAD_KCOMBO_MAX = 2200;
const GD_AI_FREE_LEAD_K7_CAP = 900;
const GD_AI_FREE_LEAD_K8_CAP = 600;
const GD_AI_FREE_LEAD_K10_CAP = 380;
const GD_AI_FREE_LEAD_K12_CAP = 220;
/** 跟牌爆搜：枚举合法组合的次数 / 收集的不同出牌上限 */
const GD_AI_BRUTE_ALL_MAX_TRIES = 42000;
const GD_AI_BRUTE_ALL_MAX_OUT = 64;
/** 单次 DFS 找「任一能压」的步数上限（手牌长时尽快放弃） */
const GD_AI_BRUTE_FIND_ONE_MAX_TRIES = 28000;
/** 多候选 L3：最多完整估值的候选数（其余已在前面按点力截断） */
const GD_AI_L3_MAX_CANDIDATES = 18;

function gdAiRemovePlayFromHand(hand: number[], play: number[]): number[] {
    const cpy = hand.slice();
    for (let p = 0; p < play.length; p++) {
        const want = play[p];
        const ix = cpy.indexOf(want);
        if (ix >= 0) {
            cpy.splice(ix, 1);
        }
    }
    return cpy;
}

/** L3 核心：剩余手牌可玩性 + 少剩牌奖励（不替代规则合法性） */
function gdAiEvaluateRemainingHand(hand: number[], lvl: number): number {
    if (hand.length === 0) {
        return 10000;
    }
    const a = gdAiAnalyze(hand, lvl);
    let s = 0;
    s += a.pairsRanks.length * 5.0;
    s += a.triplesRanks.length * 4.0;
    s += a.bombRanks.length * 2.5;
    /** 散张：旧版把面点低(raw<8)的单张当「加分」会诱导早期甩光大牌、剩一手小点难出；改按点力罚散张。 */
    for (let i = 0; i < a.singlesRanks.length; i++) {
        const rr = a.singlesRanks[i];
        const v = gdRankValueFromRaw(rr, lvl);
        if (v < 0) {
            s -= 1.15;
        } else if (v <= 5) {
            s -= 1.5;
        } else if (v <= 8) {
            s -= 0.95;
        } else if (v <= 11) {
            s -= 0.45;
        } else {
            s -= 0.5;
        }
    }
    s -= a.wilds.length * 0.3;
    s -= hand.length * 0.25;
    return s;
}

function gdAiLeadFreeBonus(pat: GdHandPattern, playLen: number): number {
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

function gdAiFollowPlayPenalty(pat: GdHandPattern): number {
    if (pat.bombTier > 0 || pat.kind === GD_KIND_BOMB || pat.kind === GD_KIND_KING_BOMB) {
        return -4.0;
    }
    if (pat.kind === GD_KIND_STRAIGHT_FLUSH) {
        return -0.8;
    }
    return 0;
}

/** 跟牌 L3：同型顺子/连对等略倾向保留牌型结构 */
function gdFollowLinePatternBonus(pat: GdHandPattern): number {
    if (pat.bombTier > 0) {
        return 0;
    }
    const k = pat.kind;
    if (k === GD_KIND_STRAIGHT || k === GD_KIND_PAIR_STRAIGHT || k === GD_KIND_TRIPLE_STRAIGHT) {
        return 0.35;
    }
    if (k === GD_KIND_TRIPLE_WITH_PAIR) {
        return 0.25;
    }
    return 0;
}

/** 候选过多时保留「点力总和较小」的出牌再跑 L3，减少 analyze 次数且偏保守出牌 */
function gdAiL3TrimSortKey(ids: number[], lvl: number): number {
    let s = 0;
    for (let i = 0; i < ids.length; i++) {
        s += gdRankValue(ids[i], lvl);
    }
    return s;
}

/** L3：从多组可出牌中选「打完剩牌」估值 + 出本手惩罚最优 */
function gdAiPickBestPlayL3(
    hand: number[],
    lvl: number,
    candidates: number[][],
    threatCtx?: { state: GdMatchState; seat: number } | null
): { ids: number[] } | null {
    if (candidates.length === 0) {
        return null;
    }
    if (candidates.length === 1) {
        return { ids: candidates[0] };
    }
    let cands = candidates;
    if (cands.length > GD_AI_L3_MAX_CANDIDATES) {
        const scored: { ids: number[]; k: number }[] = [];
        for (let i = 0; i < cands.length; i++) {
            const ids = cands[i];
            scored.push({ ids: ids, k: gdAiL3TrimSortKey(ids, lvl) });
        }
        scored.sort(function (a, b) {
            return a.k - b.k;
        });
        cands = [];
        const lim = GD_AI_L3_MAX_CANDIDATES;
        for (let j = 0; j < lim && j < scored.length; j++) {
            cands.push(scored[j].ids);
        }
    }
    let best: number[] = cands[0];
    let bestS = -1e15;
    for (let c = 0; c < cands.length; c++) {
        const ids = cands[c];
        const rem = gdAiRemovePlayFromHand(hand, ids);
        const p = gdClassify(ids, lvl);
        if (p.kind === GD_KIND_INVALID) {
            continue;
        }
        let s = gdAiEvaluateRemainingHand(rem, lvl) + gdAiFollowPlayPenalty(p) + gdFollowLinePatternBonus(p);
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
function gdBruteFindAllBeatingPlays(
    hand: number[],
    last: GdHandPattern,
    lvl: number,
    maxTries: number,
    maxOut: number
): number[][] {
    const k = last.len;
    if (k < 1 || k > hand.length) {
        return [];
    }
    const n = hand.length;
    const out: number[][] = [];
    const seen: { [k: string]: boolean } = {};
    let tries = 0;
    const buf: number[] = new Array(k);
    function keyOf(ids: number[]): string {
        const t = ids.slice();
        t.sort(function (a, b) {
            return a - b;
        });
        return t.join(",");
    }
    function dfs(st: number, d: number): void {
        if (d === k) {
            tries++;
            if (tries > maxTries) {
                return;
            }
            const p = gdClassify(buf, lvl);
            if (p.kind === GD_KIND_INVALID) {
                return;
            }
            if (gdBeats(last, p)) {
                const copy = buf.slice();
                const ky = keyOf(copy);
                if (!seen[ky]) {
                    seen[ky] = true;
                    out.push(copy);
                }
            }
            return;
        }
        for (let i = st; i < n; i++) {
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
function gdAiFollowBombCandidates(a: GdAiHand, last: GdHandPattern): number[][] {
    const out: number[][] = [];
    if (last.kind === GD_KIND_KING_BOMB) {
        return out;
    }
    if (last.bombTier > 0) {
        for (let i = 0; i < a.bombRanks.length; i++) {
            const rr = a.bombRanks[i];
            const cnt = a.ranks[String(rr)].length;
            const tier = gdAiBombTierOfCount(cnt);
            const main = gdRankValueFromRaw(rr, a.lvl);
            if (tier > last.bombTier) {
                out.push(a.ranks[String(rr)].slice(0, Math.min(cnt, 8)));
            } else if (tier === last.bombTier && main > last.main) {
                out.push(a.ranks[String(rr)].slice(0, Math.min(cnt, 8)));
            }
        }
    } else {
        for (let i = 0; i < a.bombRanks.length; i++) {
            const rr = a.bombRanks[i];
            const cnt = a.ranks[String(rr)].length;
            out.push(a.ranks[String(rr)].slice(0, Math.min(cnt, 8)));
        }
    }
    const kb = gdAiTryKingBomb(a);
    if (kb) {
        out.push(kb);
    }
    return out;
}

/**
 * L4：自由领出 2^n 子集，优先一手清；否则估值最大。
 */
function gdAiTryFreeLeadL4(
    hand: number[],
    lvl: number,
    ctx?: { state: GdMatchState; seat: number } | null
): { pass: boolean; ids: number[] } | null {
    if (hand.length > GD_AI_L4_LEAD_MAX_CARDS || hand.length < 1) {
        return null;
    }
    const n = hand.length;
    const sorted = hand
        .slice()
        .sort(function (a, b) {
            return a - b;
        });
    let best: number[] | null = null;
    let bestScore = -1e15;
    for (let mask = 1; mask < 1 << n; mask++) {
        const ids: number[] = [];
        for (let i = 0; i < n; i++) {
            if (mask & 1 << i) {
                ids.push(sorted[i]);
            }
        }
        const s = gdScoreFreeLeadIds(hand, ids, lvl, ctx);
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

function gdAiBruteBestBeatingL3(
    hand: number[],
    last: GdHandPattern,
    lvl: number,
    state?: GdMatchState,
    seat?: number
): number[] | null {
    if (hand.length > GD_AI_L3_FOLLOW_MAX_HAND) {
        return gdBruteFindBeatingPlay(hand, last, lvl);
    }
    const all = gdBruteFindAllBeatingPlays(hand, last, lvl, GD_AI_BRUTE_ALL_MAX_TRIES, GD_AI_BRUTE_ALL_MAX_OUT);
    if (all.length === 0) {
        return null;
    }
    if (all.length === 1) {
        return all[0];
    }
    const tctx = state !== undefined && seat !== undefined ? { state: state, seat: seat } : null;
    const pick = gdAiPickBestPlayL3(hand, lvl, all, tctx);
    return pick ? pick.ids : all[0];
}

/** 主决策 */
function gdAiPickPlay(state: GdMatchState, seat: number): { pass: boolean; ids: number[] } {
    const hand = state.hands[seat];
    if (hand.length === 0) {
        return { pass: true, ids: [] };
    }
    const lvl = state.levelRankActive;
    const a = gdAiAnalyze(hand, lvl);
    const last = state.lastPattern;
    const mateLen = state.hands[gdTeammateSeat(seat)].length;
    if (!last || last.kind === GD_KIND_PASS) {
        return gdAiFreeLeadMain(hand, lvl, mateLen, state, seat);
    }
    if (gdAiIsPartnerControllingTrick(state, seat)) {
        return { pass: true, ids: [] };
    }
    let follow: { ids: number[] } | null = null;
    if (last.kind === GD_KIND_SINGLE) {
        follow = gdAiFollowSingleBest(hand, last, lvl, state, seat);
        if (!follow) {
            follow = gdAiFollowSingle(a, last.main);
        }
    } else if (last.kind === GD_KIND_PAIR) {
        follow = gdAiFollowPair(a, last.main);
    } else if (last.kind === GD_KIND_TRIPLE) {
        follow = gdAiFollowTriple(a, last.main);
    } else if (last.kind === GD_KIND_BOMB || last.kind === GD_KIND_KING_BOMB || last.kind === GD_KIND_STRAIGHT_FLUSH) {
        const merged = gdAiMergeBeatingBombTierPlays(hand, a, last, lvl);
        if (merged.length > 0) {
            const pick =
                merged.length === 1
                    ? { ids: merged[0] }
                    : gdAiPickBestPlayL3(hand, lvl, merged, { state: state, seat: seat });
            return { pass: false, ids: pick ? pick.ids : merged[0] };
        }
        const brTier = gdAiBruteBestBeatingL3(hand, last, lvl, state, seat);
        if (brTier) {
            return { pass: false, ids: brTier };
        }
        follow = null;
    } else if (last.kind === GD_KIND_PAIR_STRAIGHT) {
        const line = gdAiEnumerateBeatingPairStraights(hand, last, lvl);
        const r = gdAiFollowLineThenBombs(hand, a, last, lvl, line, state, seat);
        if (!r.pass) {
            return r;
        }
        return { pass: true, ids: [] };
    } else if (last.kind === GD_KIND_TRIPLE_STRAIGHT) {
        const line = gdAiEnumerateBeatingTripleStraights(hand, last, lvl);
        const r = gdAiFollowLineThenBombs(hand, a, last, lvl, line, state, seat);
        if (!r.pass) {
            return r;
        }
        return { pass: true, ids: [] };
    } else if (last.kind === GD_KIND_STRAIGHT) {
        const line = gdAiEnumerateBeatingStraights(hand, last, lvl);
        const r = gdAiFollowLineThenBombs(hand, a, last, lvl, line, state, seat);
        if (!r.pass) {
            return r;
        }
        return { pass: true, ids: [] };
    } else if (last.kind === GD_KIND_TRIPLE_WITH_PAIR) {
        const line = gdAiEnumerateBeatingTripleWithPair(hand, last, lvl);
        const r = gdAiFollowLineThenBombs(hand, a, last, lvl, line, state, seat);
        if (!r.pass) {
            return r;
        }
        return { pass: true, ids: [] };
    } else {
        const br3 = gdAiBruteBestBeatingL3(hand, last, lvl, state, seat);
        if (br3) {
            return { pass: false, ids: br3 };
        }
        if (hand.length <= 12) {
            const c2 = gdAiFollowBombCandidates(a, last);
            if (c2.length > 1) {
                const pick2 = gdAiPickBestPlayL3(hand, lvl, c2, { state: state, seat: seat });
                follow = pick2 ? pick2 : { ids: c2[0] };
            } else if (c2.length === 1) {
                follow = { ids: c2[0] };
            } else {
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
function gdMaybeBroadcastSettlement(
    dispatcher: nkruntime.MatchDispatcher,
    logger: nkruntime.Logger,
    st: GdMatchState
): void {
    const deltas = gdComputeScoreDeltas(st);
    const settlement = JSON.stringify({
        v: 1,
        finished_order: st.finishedOrder.slice(),
        winner_team: st.winnerTeam,
        levels: [st.teams[0].level, st.teams[1].level],
        score_delta: deltas,
    });
    try {
        dispatcher.broadcastMessage(GD_OP_SETTLEMENT, settlement, null, null);
    } catch (e) {
        logger.warn("guandan ai settlement broadcast: %s", String(e));
    }
}

/**
 * 每 tick 调用一次；若当前等待 AI 动作，推进**一步**并广播快照。
 * 若已进入 finished 且 winnerTeam < 0，让 AI 自动点「继续」开新局；
 * 若 winnerTeam >= 0（整场毕业），停驻。
 */
function gdRunAiUntilHumanOrDone(
    state: GdMatchState,
    dispatcher: nkruntime.MatchDispatcher,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama
): void {
    const now = Date.now();
    if (now < state.aiPlayDelayUntilMs) {
        return;
    }
    if (state.phase === "finished") {
        if (state.winnerTeam >= 0) {
            return;
        }
        for (let s = 0; s < 4; s++) {
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
        const payer = state.tribute.pendingPayer;
        if (payer >= 0 && state.isAiSeat[payer]) {
            if (gdAiShouldResist(state, payer)) {
                gdApplyTributeResist(state, payer);
            } else {
                const cid = gdAiPickTributeCard(state, payer);
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
        const r = state.tribute.pendingReceiver;
        if (r >= 0 && state.isAiSeat[r]) {
            const cid = gdAiPickReturnCard(state, r);
            if (cid >= 0) {
                gdApplyReturn(state, r, cid);
            }
            state.aiPlayDelayUntilMs = now + GD_AI_PLAY_PACE_MS;
            gdBroadcastState(dispatcher, state, logger, "ai-return");
        }
        return;
    }
    if (state.phase === "play") {
        const t = state.turn;
        const del = state.aiDelegate && state.aiDelegate[t];
        if (t >= 0 && state.hands[t].length > 0 && (state.isAiSeat[t] || del)) {
            const prevPhase = state.phase;
            const decision = gdAiPickPlay(state, t);
            if (decision.pass) {
                gdApplyPass(state, t);
            } else {
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
function guandanMatchmakerMatchedFallback(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    matches: nkruntime.MatchmakerResult[]
): string | void {
    try {
        const humans = matches.length;
        const ai = Math.max(0, 4 - humans);
        const id = nk.matchCreate("guandan", {
            expect_humans: String(humans),
            ai: String(ai),
        });
        return id;
    } catch (e) {
        logger.error("guandan matchmakerMatched fallback: %s", String(e));
        return;
    }
}
