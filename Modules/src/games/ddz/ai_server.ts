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

const AI_STYLE_NORMAL = 0;
const AI_STYLE_AGGRESSIVE = 1;
const AI_STYLE_PASSIVE = 2;

function aiStyleFromCatId(catId: number): number {
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

function aiRankCounts(hand: number[]): number[] {
    const c: number[] = [];
    for (let i = 0; i < 15; i++) {
        c.push(0);
    }
    for (let i = 0; i < hand.length; i++) {
        c[ddzRankValue(hand[i])]++;
    }
    return c;
}

function aiMaxPerRank(r: number): number {
    if (r === 13 || r === 14) {
        return 1;
    }
    return 4;
}

/** 另外两家（对手+队友）合计每一点数仍可能持有的张数。 */
function aiRemainOutside(state: DdzMatchState, mySeat: number): number[] {
    const seen = state.seenCount;
    const seenOk = seen && seen.length >= 15;
    const my = aiRankCounts(state.hands[mySeat]);
    const out: number[] = [];
    for (let r = 0; r < 15; r++) {
        const s = seenOk ? seen[r] : 0;
        let v = aiMaxPerRank(r) - s - my[r];
        if (v < 0) {
            v = 0;
        }
        out.push(v);
    }
    return out;
}

function aiHasHigherSingleOutside(outside: number[], r: number): boolean {
    for (let x = r + 1; x < 15; x++) {
        if (outside[x] > 0) {
            return true;
        }
    }
    return false;
}

function aiHasHigherPairOutside(outside: number[], r: number): boolean {
    for (let x = r + 1; x < 13; x++) {
        if (outside[x] >= 2) {
            return true;
        }
    }
    return false;
}

function aiHasHigherTripleOutside(outside: number[], r: number): boolean {
    for (let x = r + 1; x < 13; x++) {
        if (outside[x] >= 3) {
            return true;
        }
    }
    return false;
}

function aiHasAnyBombOutside(outside: number[]): boolean {
    for (let r = 0; r < 13; r++) {
        if (outside[r] >= 4) {
            return true;
        }
    }
    return false;
}

function aiHasHigherBombOutside(outside: number[], r: number): boolean {
    for (let x = r + 1; x < 13; x++) {
        if (outside[x] >= 4) {
            return true;
        }
    }
    return false;
}

function aiHasRocketOutside(outside: number[]): boolean {
    return outside[13] >= 1 && outside[14] >= 1;
}

// ============================================================================
// 最少手数启发式分解（minSplits）
// ============================================================================

function aiCountsClone(c: number[]): number[] {
    const o: number[] = [];
    for (let i = 0; i < 15; i++) {
        o.push(c[i]);
    }
    return o;
}

/** 在 [0..11] 闭区间里找最长一段连续的 c[r] >= needCount；返回 {st, len}（len 达不到 minLen 时 len=0）。 */
function aiFindLongestRun(c: number[], needCount: number, minLen: number): { st: number; len: number } {
    let bestSt = -1;
    let bestLen = 0;
    let r = 0;
    while (r < 12) {
        if (c[r] >= needCount) {
            let t = r;
            while (t < 12 && c[t] >= needCount) {
                t++;
            }
            const len = t - r;
            if (len >= minLen && len > bestLen) {
                bestSt = r;
                bestLen = len;
            }
            r = t + 1;
        } else {
            r++;
        }
    }
    return { st: bestSt, len: bestLen };
}

/** 以贪心从长到短抽取结构，估算手牌需要的最少手数；与精确值相比偏保守（≤ 精确值不成立，通常接近）。 */
function aiMinSplitsOfCounts(counts: number[]): number {
    const c = aiCountsClone(counts);
    let s = 0;
    if (c[13] >= 1 && c[14] >= 1) {
        s++;
        c[13]--;
        c[14]--;
    }
    for (let r = 0; r < 13; r++) {
        if (c[r] === 4) {
            s++;
            c[r] = 0;
        }
    }
    while (true) {
        const p = aiFindLongestRun(c, 3, 2);
        if (p.len < 2) {
            break;
        }
        for (let r = p.st; r < p.st + p.len; r++) {
            c[r] -= 3;
        }
        s++;
    }
    while (true) {
        const p = aiFindLongestRun(c, 2, 3);
        if (p.len < 3) {
            break;
        }
        for (let r = p.st; r < p.st + p.len; r++) {
            c[r] -= 2;
        }
        s++;
    }
    while (true) {
        const p = aiFindLongestRun(c, 1, 5);
        if (p.len < 5) {
            break;
        }
        for (let r = p.st; r < p.st + p.len; r++) {
            c[r] -= 1;
        }
        s++;
    }
    let triples = 0;
    let pairs = 0;
    let singles = 0;
    for (let r = 0; r < 15; r++) {
        if (c[r] === 3) {
            triples++;
        } else if (c[r] === 2) {
            pairs++;
        } else if (c[r] === 1) {
            singles++;
        }
    }
    /** 三带一 / 三带二：各吸收一个副牌合为一手 */
    const absorbS = triples < singles ? triples : singles;
    triples -= absorbS;
    singles -= absorbS;
    const absorbP = triples < pairs ? triples : pairs;
    triples -= absorbP;
    pairs -= absorbP;
    s += absorbS + absorbP + triples + pairs + singles;
    return s;
}

function aiMinSplits(hand: number[]): number {
    return aiMinSplitsOfCounts(aiRankCounts(hand));
}

function aiMinSplitsAfter(hand: number[], played: number[]): number {
    const c = aiRankCounts(hand);
    for (let i = 0; i < played.length; i++) {
        c[ddzRankValue(played[i])]--;
    }
    return aiMinSplitsOfCounts(c);
}

// ============================================================================
// 叫分 / 抢地主强度
// ============================================================================

function aiRankWeightLandlord(r: number): number {
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

function aiHandLandlordStrength(hand: number[]): number {
    const c = aiRankCounts(hand);
    let s = 0.0;
    for (let r = 0; r < 15; r++) {
        const n = c[r];
        if (n === 0) {
            continue;
        }
        const w = aiRankWeightLandlord(r);
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
    const tmp = aiCountsClone(c);
    const r5 = aiFindLongestRun(tmp, 1, 5);
    if (r5.len >= 5) {
        s += 1.2 * r5.len;
    }
    const r3 = aiFindLongestRun(tmp, 2, 3);
    if (r3.len >= 3) {
        s += 1.8 * r3.len;
    }
    const r2 = aiFindLongestRun(tmp, 3, 2);
    if (r2.len >= 2) {
        s += 2.4 * r2.len;
    }
    return s;
}

/** 地主会合入 3 张底牌 → 强度修正项（叫/抢均按"期望 +4"评估）。 */
const AI_LANDLORD_BOTTOM_BOOST = 4.0;

function aiChooseBid(hand: number[], style: number): number {
    const s = aiHandLandlordStrength(hand) + AI_LANDLORD_BOTTOM_BOOST;
    let t = 19.0;
    if (style === AI_STYLE_AGGRESSIVE) {
        t -= 3.5;
    } else if (style === AI_STYLE_PASSIVE) {
        t += 3.5;
    }
    return s >= t ? 1 : 0;
}

function aiChooseRobLandlord(hand: number[], currentMultiplier: number, style: number): boolean {
    const s = aiHandLandlordStrength(hand) + AI_LANDLORD_BOTTOM_BOOST;
    let need = 27.0;
    if (currentMultiplier >= 4) {
        need = 42.0;
    } else if (currentMultiplier >= 2) {
        need = 34.0;
    }
    if (style === AI_STYLE_AGGRESSIVE) {
        need -= 3.0;
    } else if (style === AI_STYLE_PASSIVE) {
        need += 4.0;
    }
    const floorS = style === AI_STYLE_PASSIVE ? 22.0 : 16.0;
    if (s < floorS) {
        return false;
    }
    return s >= need;
}

// ============================================================================
// 候选枚举
// ============================================================================

interface AiMove {
    cards: number[];
    kind: number;
    mainRank: number;
    extraVal: number;
    splitsAfter: number;
    useHigh: number;
}

function aiSortCardsAsc(a: number[]): number[] {
    const o = a.slice();
    o.sort(function (x, y) {
        const rx = ddzRankValue(x);
        const ry = ddzRankValue(y);
        if (rx !== ry) {
            return rx - ry;
        }
        return x - y;
    });
    return o;
}

function aiCardsOfRank(hand: number[], r: number, n: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < hand.length; i++) {
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
function aiHighWeightOfRank(r: number): number {
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

function aiMakeMove(hand: number[], cards: number[], kind: number, mainRank: number, extraVal: number): AiMove {
    const after = aiMinSplitsAfter(hand, cards);
    let useHigh = 0;
    for (let i = 0; i < cards.length; i++) {
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
function aiBestKickerSingle(hand: number[], excludeRanks: number[]): number[] {
    const ex: { [k: string]: boolean } = {};
    for (let i = 0; i < excludeRanks.length; i++) {
        ex[String(excludeRanks[i])] = true;
    }
    const c = aiRankCounts(hand);
    let bestCid = -1;
    let bestScore = 1e9;
    for (let r = 0; r < 15; r++) {
        if (ex[String(r)]) {
            continue;
        }
        if (c[r] < 1) {
            continue;
        }
        const cid = aiCardsOfRank(hand, r, 1)[0];
        const after = aiMinSplitsAfter(hand, [cid]);
        const score = after * 10 + aiHighWeightOfRank(r) + r * 0.01;
        if (score < bestScore) {
            bestScore = score;
            bestCid = cid;
        }
    }
    return bestCid >= 0 ? [bestCid] : [];
}

/** 三带二 / 飞机对翅 副牌：选拆后 minSplits 最小的一对。 */
function aiBestKickerPair(hand: number[], excludeRanks: number[]): number[] {
    const ex: { [k: string]: boolean } = {};
    for (let i = 0; i < excludeRanks.length; i++) {
        ex[String(excludeRanks[i])] = true;
    }
    const c = aiRankCounts(hand);
    let bestCards: number[] = [];
    let bestScore = 1e9;
    for (let r = 0; r < 13; r++) {
        if (ex[String(r)]) {
            continue;
        }
        if (c[r] < 2) {
            continue;
        }
        const pp = aiCardsOfRank(hand, r, 2);
        const after = aiMinSplitsAfter(hand, pp);
        const score = after * 10 + aiHighWeightOfRank(r) * 2 + r * 0.01;
        if (score < bestScore) {
            bestScore = score;
            bestCards = pp;
        }
    }
    return bestCards;
}

/** 飞机带 n 张单翅 / 四带二两单：按"低权重优先"返回 n 张。 */
function aiBestKickerSingles(hand: number[], excludeRanks: number[], n: number): number[] {
    const ex: { [k: string]: boolean } = {};
    for (let i = 0; i < excludeRanks.length; i++) {
        ex[String(excludeRanks[i])] = true;
    }
    const c = aiRankCounts(hand);
    const cand: { cid: number; r: number }[] = [];
    for (let r = 0; r < 15; r++) {
        if (ex[String(r)]) {
            continue;
        }
        if (c[r] < 1) {
            continue;
        }
        cand.push({ cid: aiCardsOfRank(hand, r, 1)[0], r: r });
    }
    cand.sort(function (a, b) {
        const wa = aiHighWeightOfRank(a.r);
        const wb = aiHighWeightOfRank(b.r);
        if (wa !== wb) {
            return wa - wb;
        }
        return a.r - b.r;
    });
    const taken: number[] = [];
    for (let i = 0; i < cand.length; i++) {
        if (taken.length >= n) {
            break;
        }
        taken.push(cand[i].cid);
    }
    return taken.length === n ? taken : [];
}

/** 飞机带 n 对翅 / 四带二两对：按"低权重优先"返回 n*2 张。 */
function aiBestKickerPairs(hand: number[], excludeRanks: number[], n: number): number[] {
    const ex: { [k: string]: boolean } = {};
    for (let i = 0; i < excludeRanks.length; i++) {
        ex[String(excludeRanks[i])] = true;
    }
    const c = aiRankCounts(hand);
    const cand: { cards: number[]; r: number }[] = [];
    for (let r = 0; r < 13; r++) {
        if (ex[String(r)]) {
            continue;
        }
        if (c[r] < 2) {
            continue;
        }
        cand.push({ cards: aiCardsOfRank(hand, r, 2), r: r });
    }
    cand.sort(function (a, b) {
        const wa = aiHighWeightOfRank(a.r);
        const wb = aiHighWeightOfRank(b.r);
        if (wa !== wb) {
            return wa - wb;
        }
        return a.r - b.r;
    });
    const taken: number[] = [];
    for (let i = 0; i < cand.length; i++) {
        if (taken.length >= n * 2) {
            break;
        }
        taken.push(cand[i].cards[0]);
        taken.push(cand[i].cards[1]);
    }
    return taken.length === n * 2 ? taken : [];
}

function aiEnumerateLeadMoves(hand: number[]): AiMove[] {
    const moves: AiMove[] = [];
    const c = aiRankCounts(hand);
    for (let r = 0; r < 15; r++) {
        if (c[r] >= 1) {
            moves.push(aiMakeMove(hand, aiCardsOfRank(hand, r, 1), DDZ_KIND_SINGLE, r, 1));
        }
    }
    for (let r = 0; r < 13; r++) {
        if (c[r] >= 2) {
            moves.push(aiMakeMove(hand, aiCardsOfRank(hand, r, 2), DDZ_KIND_PAIR, r, 2));
        }
    }
    for (let r = 0; r < 13; r++) {
        if (c[r] < 3) {
            continue;
        }
        const three = aiCardsOfRank(hand, r, 3);
        moves.push(aiMakeMove(hand, three, DDZ_KIND_TRIPLE, r, 3));
        const k1 = aiBestKickerSingle(hand, [r]);
        if (k1.length === 1) {
            moves.push(aiMakeMove(hand, three.concat(k1), DDZ_KIND_TRIPLE_WITH_SINGLE, r, 4));
        }
        const k2 = aiBestKickerPair(hand, [r]);
        if (k2.length === 2) {
            moves.push(aiMakeMove(hand, three.concat(k2), DDZ_KIND_TRIPLE_WITH_PAIR, r, 5));
        }
    }
    for (let len = 5; len <= 12; len++) {
        for (let st = 0; st + len - 1 <= 11; st++) {
            let ok = true;
            for (let r = st; r < st + len; r++) {
                if (c[r] < 1) {
                    ok = false;
                    break;
                }
            }
            if (!ok) {
                continue;
            }
            const cards: number[] = [];
            for (let r = st; r < st + len; r++) {
                cards.push(aiCardsOfRank(hand, r, 1)[0]);
            }
            moves.push(aiMakeMove(hand, cards, DDZ_KIND_STRAIGHT, st + len - 1, len));
        }
    }
    for (let nPairs = 3; nPairs <= 10; nPairs++) {
        for (let st = 0; st + nPairs - 1 <= 11; st++) {
            let ok = true;
            for (let r = st; r < st + nPairs; r++) {
                if (c[r] < 2) {
                    ok = false;
                    break;
                }
            }
            if (!ok) {
                continue;
            }
            const cards: number[] = [];
            for (let r = st; r < st + nPairs; r++) {
                const pp = aiCardsOfRank(hand, r, 2);
                cards.push(pp[0], pp[1]);
            }
            moves.push(aiMakeMove(hand, cards, DDZ_KIND_PAIR_STRAIGHT, st + nPairs - 1, nPairs * 2));
        }
    }
    for (let k = 2; k <= 6; k++) {
        for (let st = 0; st + k - 1 <= 11; st++) {
            let ok = true;
            for (let r = st; r < st + k; r++) {
                if (c[r] < 3) {
                    ok = false;
                    break;
                }
            }
            if (!ok) {
                continue;
            }
            const base: number[] = [];
            const exR: number[] = [];
            for (let r = st; r < st + k; r++) {
                const tt = aiCardsOfRank(hand, r, 3);
                base.push(tt[0], tt[1], tt[2]);
                exR.push(r);
            }
            moves.push(aiMakeMove(hand, base, DDZ_KIND_PLANE, st + k - 1, k));
            const w1 = aiBestKickerSingles(hand, exR, k);
            if (w1.length === k) {
                moves.push(aiMakeMove(hand, base.concat(w1), DDZ_KIND_PLANE_WITH_WINGS, st + k - 1, (k << 5) | 0));
            }
            const w2 = aiBestKickerPairs(hand, exR, k);
            if (w2.length === k * 2) {
                moves.push(aiMakeMove(hand, base.concat(w2), DDZ_KIND_PLANE_WITH_WINGS, st + k - 1, (k << 5) | k));
            }
        }
    }
    for (let r = 0; r < 13; r++) {
        if (c[r] < 4) {
            continue;
        }
        const four = aiCardsOfRank(hand, r, 4);
        const ks1 = aiBestKickerSingles(hand, [r], 2);
        if (ks1.length === 2) {
            moves.push(aiMakeMove(hand, four.concat(ks1), DDZ_KIND_FOUR_WITH_TWO, r, 6));
        }
        const ks2 = aiBestKickerPairs(hand, [r], 2);
        if (ks2.length === 4) {
            moves.push(aiMakeMove(hand, four.concat(ks2), DDZ_KIND_FOUR_WITH_TWO, r, 8));
        }
    }
    return moves;
}

function aiEnumerateFollowMoves(hand: number[], last: DdzHandPattern): AiMove[] {
    const all: AiMove[] = [];
    const c = aiRankCounts(hand);
    const lk = last.kind;
    const lmain = last.main;
    const lextra = last.extra === null ? 0 : (last.extra as number);
    if (lk === DDZ_KIND_SINGLE) {
        for (let r = lmain + 1; r < 15; r++) {
            if (c[r] < 1) {
                continue;
            }
            all.push(aiMakeMove(hand, aiCardsOfRank(hand, r, 1), DDZ_KIND_SINGLE, r, 1));
        }
    } else if (lk === DDZ_KIND_PAIR) {
        for (let r = lmain + 1; r < 13; r++) {
            if (c[r] < 2) {
                continue;
            }
            all.push(aiMakeMove(hand, aiCardsOfRank(hand, r, 2), DDZ_KIND_PAIR, r, 2));
        }
    } else if (lk === DDZ_KIND_TRIPLE) {
        for (let r = lmain + 1; r < 13; r++) {
            if (c[r] < 3) {
                continue;
            }
            all.push(aiMakeMove(hand, aiCardsOfRank(hand, r, 3), DDZ_KIND_TRIPLE, r, 3));
        }
    } else if (lk === DDZ_KIND_TRIPLE_WITH_SINGLE) {
        for (let r = lmain + 1; r < 13; r++) {
            if (c[r] < 3) {
                continue;
            }
            const base = aiCardsOfRank(hand, r, 3);
            const k = aiBestKickerSingle(hand, [r]);
            if (k.length === 1) {
                all.push(aiMakeMove(hand, base.concat(k), DDZ_KIND_TRIPLE_WITH_SINGLE, r, 4));
            }
        }
    } else if (lk === DDZ_KIND_TRIPLE_WITH_PAIR) {
        for (let r = lmain + 1; r < 13; r++) {
            if (c[r] < 3) {
                continue;
            }
            const base = aiCardsOfRank(hand, r, 3);
            const k = aiBestKickerPair(hand, [r]);
            if (k.length === 2) {
                all.push(aiMakeMove(hand, base.concat(k), DDZ_KIND_TRIPLE_WITH_PAIR, r, 5));
            }
        }
    } else if (lk === DDZ_KIND_STRAIGHT) {
        const len = lextra;
        for (let st = lmain - len + 2; st + len - 1 <= 11; st++) {
            if (st < 0) {
                continue;
            }
            let ok = true;
            for (let r = st; r < st + len; r++) {
                if (c[r] < 1) {
                    ok = false;
                    break;
                }
            }
            if (!ok) {
                continue;
            }
            const cards: number[] = [];
            for (let r = st; r < st + len; r++) {
                cards.push(aiCardsOfRank(hand, r, 1)[0]);
            }
            all.push(aiMakeMove(hand, cards, DDZ_KIND_STRAIGHT, st + len - 1, len));
        }
    } else if (lk === DDZ_KIND_PAIR_STRAIGHT) {
        const nPairs = (lextra / 2) | 0;
        for (let st = lmain - nPairs + 2; st + nPairs - 1 <= 11; st++) {
            if (st < 0) {
                continue;
            }
            let ok = true;
            for (let r = st; r < st + nPairs; r++) {
                if (c[r] < 2) {
                    ok = false;
                    break;
                }
            }
            if (!ok) {
                continue;
            }
            const cards: number[] = [];
            for (let r = st; r < st + nPairs; r++) {
                const pp = aiCardsOfRank(hand, r, 2);
                cards.push(pp[0], pp[1]);
            }
            all.push(aiMakeMove(hand, cards, DDZ_KIND_PAIR_STRAIGHT, st + nPairs - 1, nPairs * 2));
        }
    } else if (lk === DDZ_KIND_PLANE) {
        const k = lextra;
        for (let st = lmain - k + 2; st + k - 1 <= 11; st++) {
            if (st < 0) {
                continue;
            }
            let ok = true;
            for (let r = st; r < st + k; r++) {
                if (c[r] < 3) {
                    ok = false;
                    break;
                }
            }
            if (!ok) {
                continue;
            }
            const base: number[] = [];
            for (let r = st; r < st + k; r++) {
                const tt = aiCardsOfRank(hand, r, 3);
                base.push(tt[0], tt[1], tt[2]);
            }
            all.push(aiMakeMove(hand, base, DDZ_KIND_PLANE, st + k - 1, k));
        }
    } else if (lk === DDZ_KIND_PLANE_WITH_WINGS) {
        const k = lextra >> 5;
        const numPair = lextra & 31;
        /** rules.ts 允许混合翅膀（只要 singles+pairs==k 且 pairs==numPair），但"跟牌"要求 extra 完全相同，所以 numPair 固定。 */
        for (let st = lmain - k + 2; st + k - 1 <= 11; st++) {
            if (st < 0) {
                continue;
            }
            let ok = true;
            for (let r = st; r < st + k; r++) {
                if (c[r] < 3) {
                    ok = false;
                    break;
                }
            }
            if (!ok) {
                continue;
            }
            const base: number[] = [];
            const exR: number[] = [];
            for (let r = st; r < st + k; r++) {
                const tt = aiCardsOfRank(hand, r, 3);
                base.push(tt[0], tt[1], tt[2]);
                exR.push(r);
            }
            let wings: number[] = [];
            if (numPair === 0) {
                wings = aiBestKickerSingles(hand, exR, k);
            } else if (numPair === k) {
                wings = aiBestKickerPairs(hand, exR, k);
            } else {
                continue;
            }
            if (wings.length === 0) {
                continue;
            }
            all.push(aiMakeMove(hand, base.concat(wings), DDZ_KIND_PLANE_WITH_WINGS, st + k - 1, (k << 5) | numPair));
        }
    } else if (lk === DDZ_KIND_FOUR_WITH_TWO) {
        for (let r = lmain + 1; r < 13; r++) {
            if (c[r] < 4) {
                continue;
            }
            const four = aiCardsOfRank(hand, r, 4);
            if (lextra === 6) {
                const k = aiBestKickerSingles(hand, [r], 2);
                if (k.length === 2) {
                    all.push(aiMakeMove(hand, four.concat(k), DDZ_KIND_FOUR_WITH_TWO, r, 6));
                }
            } else if (lextra === 8) {
                const k = aiBestKickerPairs(hand, [r], 2);
                if (k.length === 4) {
                    all.push(aiMakeMove(hand, four.concat(k), DDZ_KIND_FOUR_WITH_TWO, r, 8));
                }
            }
        }
    }
    return all;
}

function aiEnumerateBombs(hand: number[], lastBombMain: number): AiMove[] {
    const c = aiRankCounts(hand);
    const out: AiMove[] = [];
    for (let r = lastBombMain + 1; r < 13; r++) {
        if (c[r] >= 4) {
            out.push(aiMakeMove(hand, aiCardsOfRank(hand, r, 4), DDZ_KIND_BOMB, r, 4));
        }
    }
    return out;
}

function aiEnumerateRocket(hand: number[]): AiMove[] {
    const c = aiRankCounts(hand);
    if (c[13] >= 1 && c[14] >= 1) {
        const sm = aiCardsOfRank(hand, 13, 1);
        const bg = aiCardsOfRank(hand, 14, 1);
        return [aiMakeMove(hand, sm.concat(bg), DDZ_KIND_ROCKET, 14, 2)];
    }
    return [];
}

// ============================================================================
// 上下文 / 合作判定
// ============================================================================

interface AiCtx {
    me: number;
    landlord: number;
    isFarmer: boolean;
    mate: number;
    lastPlayer: number;
    passes: number;
    minOpp: number;
    maxOpp: number;
    mateHand: number;
    landlordHand: number;
    aiStyle: number;
    outside: number[];
    ownSplits: number;
}

function aiBuildCtx(state: DdzMatchState, seat: number): AiCtx {
    const L = state.landlord;
    const isF = seat !== L;
    const mate = isF ? 3 - seat - L : -1;
    const n0 = state.hands[(seat + 1) % 3].length;
    const n1 = state.hands[(seat + 2) % 3].length;
    const cat = state.seatCat[seat] !== undefined ? state.seatCat[seat] : 0;
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

function aiIsAbsoluteBiggest(move: AiMove, ctx: AiCtx): boolean {
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
        const noBomb = !aiHasAnyBombOutside(ctx.outside);
        const noRocket = !aiHasRocketOutside(ctx.outside);
        return noBomb && noRocket && move.mainRank >= 10;
    }
    return false;
}

function aiIsAbsoluteBiggestLast(last: DdzHandPattern, ctx: AiCtx): boolean {
    const k = last.kind;
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

function aiMateJustPlayed(ctx: AiCtx): boolean {
    return ctx.isFarmer && ctx.mate === ctx.lastPlayer;
}

// ============================================================================
// 跟牌决策
// ============================================================================

function aiFarmerShouldYield(ctx: AiCtx, hand: number[], last: DdzHandPattern): boolean {
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

function aiShouldUseBomb(hand: number[], ctx: AiCtx, _last: DdzHandPattern): boolean {
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
    const c = aiRankCounts(hand);
    for (let r = 0; r < 13; r++) {
        if (c[r] >= 4) {
            const cs = aiCardsOfRank(hand, r, 4);
            const after = aiMinSplitsAfter(hand, cs);
            if (ctx.ownSplits - after >= 1) {
                return true;
            }
        }
    }
    return false;
}

function aiShouldUseRocket(ctx: AiCtx): boolean {
    if (!ctx.isFarmer && ctx.minOpp <= 1) {
        return true;
    }
    if (ctx.isFarmer && ctx.landlordHand <= 1) {
        return true;
    }
    return false;
}

function aiShouldForceBombOverSameKind(ctx: AiCtx): boolean {
    if (!ctx.isFarmer && ctx.minOpp <= 1) {
        return true;
    }
    if (ctx.isFarmer && ctx.landlordHand <= 1) {
        return true;
    }
    return false;
}

function aiScoreFollowMove(m: AiMove, ctx: AiCtx): number {
    const splitsSaved = ctx.ownSplits - m.splitsAfter;
    let score = -m.splitsAfter * 20 + splitsSaved * 4 - m.useHigh * 4 - m.mainRank * 0.4;
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

function aiPickBestFollow(hand: number[], last: DdzHandPattern, ctx: AiCtx): number[] {
    if (aiFarmerShouldYield(ctx, hand, last)) {
        return [];
    }
    const moves = aiEnumerateFollowMoves(hand, last);
    let bestScore = -1e9;
    let bestMove: AiMove | null = null;
    for (let i = 0; i < moves.length; i++) {
        const s = aiScoreFollowMove(moves[i], ctx);
        if (s > bestScore) {
            bestScore = s;
            bestMove = moves[i];
        }
    }
    /** 同型打不出来：看是否该炸 */
    if (bestMove === null) {
        if (aiShouldUseBomb(hand, ctx, last)) {
            const bombs = aiEnumerateBombs(hand, last.kind === DDZ_KIND_BOMB ? last.main : -1);
            if (bombs.length > 0) {
                return bombs[0].cards;
            }
        }
        if (aiShouldUseRocket(ctx)) {
            const rockets = aiEnumerateRocket(hand);
            if (rockets.length > 0) {
                return rockets[0].cards;
            }
        }
        return [];
    }
    /** 同型能压，但锁胜/必炸场景里仍然走炸 */
    if (aiShouldForceBombOverSameKind(ctx)) {
        const bombs = aiEnumerateBombs(hand, -1);
        if (bombs.length > 0) {
            return bombs[0].cards;
        }
    }
    return bestMove.cards;
}

// ============================================================================
// 首出决策
// ============================================================================

function aiScoreLeadMove(m: AiMove, ctx: AiCtx): number {
    let score = -m.splitsAfter * 22 - m.useHigh * 3 - m.mainRank * 0.4;
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

function aiPickBestLead(hand: number[], ctx: AiCtx): number[] {
    const moves = aiEnumerateLeadMoves(hand);
    const bombs = aiEnumerateBombs(hand, -1);
    const rockets = aiEnumerateRocket(hand);
    /** 能一手走完（任何动作使 splitsAfter === 0）：优先走最快的 */
    for (let i = 0; i < moves.length; i++) {
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
    let bestScore = -1e9;
    let bestMove: AiMove | null = null;
    for (let i = 0; i < moves.length; i++) {
        const s = aiScoreLeadMove(moves[i], ctx);
        if (s > bestScore) {
            bestScore = s;
            bestMove = moves[i];
        }
    }
    if (bestMove !== null) {
        return bestMove.cards;
    }
    const sorted = aiSortCardsAsc(hand);
    return [sorted[0]];
}

// ============================================================================
// 入口：baseline（Tier A，规则分策略，用于 rollout 驱动）
// ============================================================================

function aiRunPlayTurnBaseline(state: DdzMatchState, seat: number): void {
    const hand = state.hands[seat];
    if (hand.length === 0) {
        return;
    }
    const ctx = aiBuildCtx(state, seat);
    const last = state.lastPattern;
    const trickFree = !last || last.kind === DDZ_KIND_PASS || state.passes >= 2;
    let cards: number[] = [];
    if (trickFree) {
        cards = aiPickBestLead(hand, ctx);
        if (cards.length === 0) {
            cards = [aiSortCardsAsc(hand)[0]];
        }
    } else {
        cards = aiPickBestFollow(hand, last as DdzHandPattern, ctx);
        if (cards.length === 0) {
            applyPass(state, seat);
            return;
        }
    }
    applyPlay(state, seat, cards);
}

// ============================================================================
// Tier B: 轻量 rollout 搜索 —— Top-K 候选 × 规则策略推演 × 取分差最大
// ============================================================================

/**
 * 候选动作：cards 为空表示"过"。
 */
interface AiCandAction {
    cards: number[];
    isPass: boolean;
    heur: number;
}

/**
 * 数组相等（长度+元素完全一致，忽略顺序通过先排序）。仅用于候选去重。
 */
function aiCandSameCards(a: number[], b: number[]): boolean {
    if (a.length !== b.length) {
        return false;
    }
    if (a.length === 0) {
        return true;
    }
    const sa: number[] = [];
    const sb: number[] = [];
    for (let i = 0; i < a.length; i++) {
        sa.push(a[i]);
        sb.push(b[i]);
    }
    sa.sort(function (x, y) { return x - y; });
    sb.sort(function (x, y) { return x - y; });
    for (let i = 0; i < sa.length; i++) {
        if (sa[i] !== sb[i]) {
            return false;
        }
    }
    return true;
}

function aiCandContains(list: AiCandAction[], cards: number[]): boolean {
    for (let i = 0; i < list.length; i++) {
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
function aiTopKLeadCandidates(hand: number[], ctx: AiCtx, k: number): AiCandAction[] {
    const moves = aiEnumerateLeadMoves(hand);
    const bombs = aiEnumerateBombs(hand, -1);
    const rockets = aiEnumerateRocket(hand);
    /** 能一手走完：直接只给这一个候选，无需 rollout。 */
    for (let i = 0; i < moves.length; i++) {
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
    const scored: AiCandAction[] = [];
    for (let i = 0; i < moves.length; i++) {
        scored.push({ cards: moves[i].cards, isPass: false, heur: aiScoreLeadMove(moves[i], ctx) });
    }
    scored.sort(function (a, b) { return b.heur - a.heur; });
    const out: AiCandAction[] = [];
    const maxK = k > 0 ? k : 1;
    for (let i = 0; i < scored.length && out.length < maxK; i++) {
        if (!aiCandContains(out, scored[i].cards)) {
            out.push(scored[i]);
        }
    }
    /** 炸弹/火箭：首出时一般不炸；但给 rollout 留一个验证通道。 */
    for (let i = 0; i < bombs.length; i++) {
        if (!aiCandContains(out, bombs[i].cards)) {
            out.push({ cards: bombs[i].cards, isPass: false, heur: -1000 });
            break;
        }
    }
    for (let i = 0; i < rockets.length; i++) {
        if (!aiCandContains(out, rockets[i].cards)) {
            out.push({ cards: rockets[i].cards, isPass: false, heur: -1000 });
            break;
        }
    }
    if (out.length === 0) {
        const sorted = aiSortCardsAsc(hand);
        out.push({ cards: [sorted[0]], isPass: false, heur: 0 });
    }
    return out;
}

/**
 * Top-K 跟牌候选：同型跟牌按启发式取前 K；同时把"过""炸弹""火箭"加入候选。
 * rollout 会自行比较不同决策后的最终分差。
 */
function aiTopKFollowCandidates(hand: number[], last: DdzHandPattern, ctx: AiCtx, k: number): AiCandAction[] {
    const moves = aiEnumerateFollowMoves(hand, last);
    const scored: AiCandAction[] = [];
    for (let i = 0; i < moves.length; i++) {
        scored.push({ cards: moves[i].cards, isPass: false, heur: aiScoreFollowMove(moves[i], ctx) });
    }
    scored.sort(function (a, b) { return b.heur - a.heur; });
    const out: AiCandAction[] = [];
    const maxK = k > 0 ? k : 1;
    for (let i = 0; i < scored.length && out.length < maxK; i++) {
        if (!aiCandContains(out, scored[i].cards)) {
            out.push(scored[i]);
        }
    }
    /** 过：除"无牌可出"外，也加入候选让 rollout 自行评估要不要送牌。 */
    out.push({ cards: [], isPass: true, heur: -500 });
    /** 炸弹：比上家大的最小炸；rollout 判断值不值得炸。 */
    const bombs = aiEnumerateBombs(hand, last.kind === DDZ_KIND_BOMB ? last.main : -1);
    if (bombs.length > 0 && !aiCandContains(out, bombs[0].cards)) {
        out.push({ cards: bombs[0].cards, isPass: false, heur: -600 });
    }
    /** 火箭：不被炸弹/火箭压过时，可加入。 */
    if (last.kind !== DDZ_KIND_ROCKET) {
        const rockets = aiEnumerateRocket(hand);
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
function aiCloneStateForRollout(st: DdzMatchState): DdzMatchState {
    const c: DdzMatchState = {
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
            const a: number[] = [];
            for (let i = 0; i < 15; i++) {
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
function aiRolloutPlayToEnd(st: DdzMatchState): number[] {
    let guard = 0;
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
const AI_TIER_B_LEAD_TOPK = 4;
const AI_TIER_B_FOLLOW_TOPK = 4;

function aiRunPlayTurn(state: DdzMatchState, seat: number): void {
    const hand = state.hands[seat];
    if (hand.length === 0) {
        return;
    }
    const ctx = aiBuildCtx(state, seat);
    const last = state.lastPattern;
    const trickFree = !last || last.kind === DDZ_KIND_PASS || state.passes >= 2;

    let candidates: AiCandAction[];
    if (trickFree) {
        candidates = aiTopKLeadCandidates(hand, ctx, AI_TIER_B_LEAD_TOPK);
    } else {
        candidates = aiTopKFollowCandidates(hand, last as DdzHandPattern, ctx, AI_TIER_B_FOLLOW_TOPK);
    }

    if (candidates.length === 0) {
        /** 理论不应出现：fallback 最小单张 */
        applyPlay(state, seat, [aiSortCardsAsc(hand)[0]]);
        return;
    }
    /** 单候选（如 Top-K 收集器返回"一手走完"）：免去 rollout */
    if (candidates.length === 1) {
        const only = candidates[0];
        if (only.isPass) {
            applyPass(state, seat);
        } else {
            applyPlay(state, seat, only.cards);
        }
        return;
    }

    let bestSum = -1e18;
    let bestIdx = 0;
    for (let i = 0; i < candidates.length; i++) {
        const act = candidates[i];
        const clone = aiCloneStateForRollout(state);
        if (act.isPass) {
            /** 过在某些场景下非法（如自己领出），这时跳过该候选 */
            if (!(last && last.kind !== DDZ_KIND_PASS && state.passes < 2)) {
                continue;
            }
            applyPass(clone, seat);
        } else {
            applyPlay(clone, seat, act.cards);
        }
        const deltas = aiRolloutPlayToEnd(clone);
        const mine = deltas[seat];
        if (mine > bestSum) {
            bestSum = mine;
            bestIdx = i;
        }
    }

    const chosen = candidates[bestIdx];
    if (chosen.isPass) {
        applyPass(state, seat);
    } else {
        applyPlay(state, seat, chosen.cards);
    }
}

function aiRunBidTurn(state: DdzMatchState, seat: number, nk: nkruntime.Nakama): void {
    const hand = state.hands[seat];
    const cat = state.seatCat[seat] !== undefined ? state.seatCat[seat] : 0;
    const style = aiStyleFromCatId(cat);
    const bid = aiChooseBid(hand, style);
    applyBid(state, seat, bid, nk);
}

function aiRunRobTurn(state: DdzMatchState, seat: number): void {
    const hand = state.hands[seat];
    const cat = state.seatCat[seat] !== undefined ? state.seatCat[seat] : 0;
    const style = aiStyleFromCatId(cat);
    const curMult = state.multBase * state.multRob;
    const rob = aiChooseRobLandlord(hand, curMult, style);
    applyRob(state, seat, rob);
}

/** AI 叫/抢/连出的客户端动画对齐延迟（与旧值一致） */
const AI_BID_ROB_CHAIN_DELAY_MS = 1350;

function runAiUntilHumanOrDone(
    st: DdzMatchState,
    dispatcher: nkruntime.MatchDispatcher,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama
): void {
    let guard = 0;
    while (guard++ < 96) {
        if (st.phase === "waiting" || st.phase === "deal") {
            break;
        }
        if (st.phase === "finished") {
            break;
        }
        if (st.phase === "bidding_call") {
            const awaitS = st.awaitSeat;
            if (!st.isAiSeat[awaitS]) {
                break;
            }
            if (Date.now() < st.aiPlayDelayUntilMs) {
                break;
            }
            aiRunBidTurn(st, awaitS, nk);
            broadcastState(dispatcher, st, logger, "ai_bid");
            st.aiPlayDelayUntilMs = Date.now() + AI_BID_ROB_CHAIN_DELAY_MS;
        } else if (st.phase === "bidding_rob") {
            const cand = st.callCandidate;
            const i = (cand + 1 + st.robStep) % 3;
            if (!st.isAiSeat[i]) {
                break;
            }
            if (Date.now() < st.aiPlayDelayUntilMs) {
                break;
            }
            aiRunRobTurn(st, i);
            broadcastState(dispatcher, st, logger, "ai_rob");
            st.aiPlayDelayUntilMs = Date.now() + AI_BID_ROB_CHAIN_DELAY_MS;
        } else if (st.phase === "play") {
            const t = st.turn;
            if (!st.isAiSeat[t]) {
                break;
            }
            if (Date.now() < st.aiPlayDelayUntilMs) {
                break;
            }
            aiRunPlayTurn(st, t);
            const AI_PLAY_CHAIN_DELAY_MS = 1350;
            const nextTurn = st.turn;
            if (st.phase === "play" && st.isAiSeat[nextTurn]) {
                st.aiPlayDelayUntilMs = Date.now() + AI_PLAY_CHAIN_DELAY_MS;
            } else {
                st.aiPlayDelayUntilMs = 0;
            }
            broadcastState(dispatcher, st, logger, "ai_play");
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
                try {
                    dispatcher.broadcastMessage(DDZ_OP_SETTLEMENT, settlement, null, null);
                } catch (e) {
                    logger.error("ai settlement: %s", String(e));
                }
            }
        } else {
            break;
        }
    }
}

function maybeAutoContinueWithAi(
    st: DdzMatchState,
    dispatcher: nkruntime.MatchDispatcher,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama
): void {
    if (st.phase !== "finished") {
        return;
    }
    for (let s = 0; s < 3; s++) {
        if (st.isAiSeat[s]) {
            st.continueReady[s] = true;
        }
    }
    let all = true;
    for (let i = 0; i < 3; i++) {
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
