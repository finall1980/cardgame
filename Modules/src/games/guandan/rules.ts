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
const GD_STRAIGHT_MAIN_WHEEL_LOW = -100;

/** baseId：把两副牌映射到同义面 0..53 */
function gdBaseId(id: number): number {
    return id < 54 ? id : id - 54;
}

/** rawRank：3→0, 4→1, ..., T→7, J→8, Q→9, K→10, A→11, 2→12, 小王→13, 大王→14 */
function gdRawRank(id: number): number {
    const b = gdBaseId(id);
    if (b < 52) {
        return b % 13;
    }
    return 13 + (b - 52);
}

/** suit：0 ♠ / 1 ♥ / 2 ♣ / 3 ♦；王为 -1 */
function gdSuit(id: number): number {
    const b = gdBaseId(id);
    if (b >= 52) {
        return -1;
    }
    return Math.floor(b / 13);
}

function gdIsHeartLevelCard(id: number, levelRank: number): boolean {
    return gdSuit(id) === 1 && gdRawRank(id) === levelRank;
}

/** 把 rawRank 映射为本局生效的点力（见 §3.1 表） */
function gdRankValueFromRaw(rr: number, levelRank: number): number {
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

function gdRankValue(id: number, levelRank: number): number {
    return gdRankValueFromRaw(gdRawRank(id), levelRank);
}

/** 拆出红心级牌（百搭）与普通牌 */
function gdSplitWilds(ids: number[], levelRank: number): { wilds: number[]; normals: number[] } {
    const w: number[] = [];
    const n: number[] = [];
    for (let i = 0; i < ids.length; i++) {
        if (gdIsHeartLevelCard(ids[i], levelRank)) {
            w.push(ids[i]);
        } else {
            n.push(ids[i]);
        }
    }
    return { wilds: w, normals: n };
}

function gdRankCountsOfNormals(normals: number[]): { [k: string]: number } {
    const m: { [k: string]: number } = {};
    for (let i = 0; i < normals.length; i++) {
        const r = gdRawRank(normals[i]);
        const k = String(r);
        m[k] = (m[k] || 0) + 1;
    }
    return m;
}

function gdMakePattern(
    kind: number,
    main: number,
    len: number,
    bombTier: number,
    wildUsed: number,
    straightLen: number,
    suit: number
): GdHandPattern {
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
function gdTryKingBomb(normals: number[], wilds: number[]): GdHandPattern | null {
    if (wilds.length !== 0) {
        return null;
    }
    if (normals.length !== 4) {
        return null;
    }
    let small = 0;
    let big = 0;
    for (let i = 0; i < normals.length; i++) {
        const r = gdRawRank(normals[i]);
        if (r === 13) {
            small++;
        } else if (r === 14) {
            big++;
        } else {
            return null;
        }
    }
    if (small !== 2 || big !== 2) {
        return null;
    }
    return gdMakePattern(GD_KIND_KING_BOMB, 100, 4, GD_BOMB_TIER_KING, 0, 0, -1);
}

/** 普通 n 炸：同 rawRank，n ∈ [4,8]，允许 0..2 wild；禁止王组普通炸 */
function gdTryBomb(normals: number[], wilds: number[], levelRank: number): GdHandPattern | null {
    const n = normals.length + wilds.length;
    if (n < 4 || n > 8) {
        return null;
    }
    if (normals.length === 0) {
        return null;
    }
    const r0 = gdRawRank(normals[0]);
    if (r0 >= 13) {
        return null;
    }
    for (let i = 1; i < normals.length; i++) {
        if (gdRawRank(normals[i]) !== r0) {
            return null;
        }
    }
    let tier = GD_BOMB_TIER_4;
    if (n === 5) {
        tier = GD_BOMB_TIER_5;
    } else if (n === 6) {
        tier = GD_BOMB_TIER_6;
    } else if (n === 7) {
        tier = GD_BOMB_TIER_7;
    } else if (n === 8) {
        tier = GD_BOMB_TIER_8;
    }
    return gdMakePattern(
        GD_KIND_BOMB,
        gdRankValueFromRaw(r0, levelRank),
        n,
        tier,
        wilds.length,
        0,
        -1
    );
}

function gdTrySingle(ids: number[], levelRank: number): GdHandPattern | null {
    if (ids.length !== 1) {
        return null;
    }
    return gdMakePattern(GD_KIND_SINGLE, gdRankValue(ids[0], levelRank), 1, 0, 0, 0, -1);
}

function gdTryPair(normals: number[], wilds: number[], levelRank: number): GdHandPattern | null {
    const n = normals.length + wilds.length;
    if (n !== 2) {
        return null;
    }
    if (normals.length === 2) {
        const r0 = gdRawRank(normals[0]);
        const r1 = gdRawRank(normals[1]);
        if (r0 !== r1) {
            return null;
        }
        return gdMakePattern(GD_KIND_PAIR, gdRankValueFromRaw(r0, levelRank), 2, 0, 0, 0, -1);
    }
    if (normals.length === 1 && wilds.length === 1) {
        const r0 = gdRawRank(normals[0]);
        if (r0 >= 13) {
            return null;
        }
        return gdMakePattern(GD_KIND_PAIR, gdRankValueFromRaw(r0, levelRank), 2, 0, 1, 0, -1);
    }
    return null;
}

function gdTryTriple(normals: number[], wilds: number[], levelRank: number): GdHandPattern | null {
    const n = normals.length + wilds.length;
    if (n !== 3) {
        return null;
    }
    if (normals.length === 0) {
        return null;
    }
    const r0 = gdRawRank(normals[0]);
    if (r0 >= 13) {
        return null;
    }
    for (let i = 1; i < normals.length; i++) {
        if (gdRawRank(normals[i]) !== r0) {
            return null;
        }
    }
    return gdMakePattern(
        GD_KIND_TRIPLE,
        gdRankValueFromRaw(r0, levelRank),
        3,
        0,
        wilds.length,
        0,
        -1
    );
}

function gdTryTriplePair(normals: number[], wilds: number[], levelRank: number): GdHandPattern | null {
    const n = normals.length + wilds.length;
    if (n !== 5) {
        return null;
    }
    const wc = wilds.length;
    const cnt = gdRankCountsOfNormals(normals);
    const ranks: number[] = [];
    for (const k in cnt) {
        if (cnt.hasOwnProperty(k)) {
            const r = parseInt(k, 10);
            if (r >= 13) {
                return null;
            }
            ranks.push(r);
        }
    }
    if (ranks.length < 1 || ranks.length > 2) {
        return null;
    }
    function tryAs(tripleR: number, pairR: number): GdHandPattern | null {
        const tCnt = cnt[String(tripleR)] || 0;
        const pCnt = pairR === tripleR ? 0 : (cnt[String(pairR)] || 0);
        const tNeed = 3 - tCnt;
        const pNeed = 2 - pCnt;
        if (tNeed < 0 || pNeed < 0) {
            return null;
        }
        if (tNeed + pNeed !== wc) {
            return null;
        }
        return gdMakePattern(
            GD_KIND_TRIPLE_WITH_PAIR,
            gdRankValueFromRaw(tripleR, levelRank),
            5,
            0,
            wc,
            0,
            -1
        );
    }
    if (ranks.length === 2) {
        const a = ranks[0];
        const b = ranks[1];
        const r = tryAs(a, b);
        if (r) {
            return r;
        }
        return tryAs(b, a);
    }
    return null;
}

function gdSeqForbidden23456(seq: number[]): boolean {
    return (
        seq.length === 5 &&
        seq[0] === 12 &&
        seq[1] === 0 &&
        seq[2] === 1 &&
        seq[3] === 2 &&
        seq[4] === 3
    );
}

function gdSeqAllowedForStraight(seq: number[], levelRank: number): boolean {
    if (gdSeqForbidden23456(seq)) {
        return false;
    }
    for (let i = 0; i < seq.length; i++) {
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
function gdBuildPairStraightSeqWheel(start: number, numPairs: number): number[] | null {
    if (numPairs < 1 || start < 0 || start > 12) {
        return null;
    }
    const seq: number[] = [start];
    let cur = start;
    for (let j = 1; j < numPairs; j++) {
        let nx: number;
        if (cur === 12) {
            nx = 0;
        } else if (cur === 11) {
            nx = 12;
        } else if (cur >= 0 && cur <= 10) {
            nx = cur + 1;
        } else {
            return null;
        }
        seq.push(nx);
        cur = nx;
    }
    return seq;
}

/** 连对序列合法性（打二走 3—A；非打二可走含 2 的环序） */
function gdSeqAllowedForPairStraight(seq: number[], levelRank: number): boolean {
    if (gdSeqForbidden23456(seq)) {
        return false;
    }
    if (levelRank === 12) {
        return gdSeqAllowedForStraight(seq, levelRank);
    }
    for (let i = 0; i < seq.length; i++) {
        if (seq[i] < 0 || seq[i] > 12) {
            return false;
        }
    }
    return true;
}

/** 枚举连对「点数模板」（不含百搭分配）；供识别与 AI 共用 */
function gdForEachPairStraightSeqTemplate(
    levelRank: number,
    numPairs: number,
    cb: (seq: number[]) => void
): void {
    if (numPairs < 3) {
        return;
    }
    if (levelRank === 12) {
        for (let top = numPairs - 1; top <= 11; top++) {
            const low = top - numPairs + 1;
            if (low < 0) {
                continue;
            }
            const seq: number[] = [];
            for (let r = low; r <= top; r++) {
                seq.push(r);
            }
            if (!gdSeqAllowedForStraight(seq, levelRank)) {
                continue;
            }
            cb(seq);
        }
    } else {
        for (let start = 0; start <= 12; start++) {
            const seq = gdBuildPairStraightSeqWheel(start, numPairs);
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

function gdHasExtraRankOutside(cnt: { [k: string]: number }, seq: number[]): boolean {
    for (const k in cnt) {
        if (!cnt.hasOwnProperty(k)) {
            continue;
        }
        const r = parseInt(k, 10);
        let inSeq = false;
        for (let i = 0; i < seq.length; i++) {
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

function gdTryStraight(normals: number[], wilds: number[], levelRank: number): GdHandPattern | null {
    const n = normals.length + wilds.length;
    if (n !== 5) {
        return null;
    }
    const wc = wilds.length;
    const cnt = gdRankCountsOfNormals(normals);
    for (const k in cnt) {
        if (!cnt.hasOwnProperty(k)) {
            continue;
        }
        const r = parseInt(k, 10);
        if (r >= 13) {
            return null;
        }
        if (cnt[k] > 1) {
            return null;
        }
    }
    for (let top = 4; top <= 11; top++) {
        const seq: number[] = [top - 4, top - 3, top - 2, top - 1, top];
        if (!gdSeqAllowedForStraight(seq, levelRank)) {
            continue;
        }
        let need = 0;
        for (let i = 0; i < seq.length; i++) {
            const have = cnt[String(seq[i])] || 0;
            need += 1 - have;
        }
        if (need !== wc) {
            continue;
        }
        if (gdHasExtraRankOutside(cnt, seq)) {
            continue;
        }
        return gdMakePattern(
            GD_KIND_STRAIGHT,
            gdRankValueFromRaw(top, levelRank),
            5,
            0,
            wc,
            5,
            -1
        );
    }
    const wheel = gdTryStraightWheelA2345(cnt, wc, levelRank);
    if (wheel) {
        return wheel;
    }
    return null;
}

/** 最小顺 A2345（可含 ♥ 级牌作百搭补位） */
function gdTryStraightWheelA2345(
    cnt: { [k: string]: number },
    wc: number,
    levelRank: number
): GdHandPattern | null {
    const seq: number[] = [11, 12, 0, 1, 2];
    let need = 0;
    for (let i = 0; i < seq.length; i++) {
        const r = seq[i];
        if (r === levelRank) {
            need += 1;
            continue;
        }
        const have = cnt[String(r)] || 0;
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

function gdTryPairStraight(
    normals: number[],
    wilds: number[],
    levelRank: number
): GdHandPattern | null {
    const n = normals.length + wilds.length;
    /** 掼蛋连对：至少三对连续点，可 6/8/10…张（至多到 A 共 12 对 = 24 张） */
    if (n < 6 || n % 2 !== 0) {
        return null;
    }
    const numPairs = (n / 2) | 0;
    if (numPairs < 3 || numPairs > 12) {
        return null;
    }
    const wc = wilds.length;
    const cnt = gdRankCountsOfNormals(normals);
    for (const k in cnt) {
        if (!cnt.hasOwnProperty(k)) {
            continue;
        }
        const r = parseInt(k, 10);
        if (r >= 13) {
            return null;
        }
        if (cnt[k] > 2) {
            return null;
        }
    }
    function mainOfPairStraightSeq(seq: number[]): number {
        let mb = gdRankValueFromRaw(seq[0], levelRank);
        for (let u = 1; u < seq.length; u++) {
            const v = gdRankValueFromRaw(seq[u], levelRank);
            if (v > mb) {
                mb = v;
            }
        }
        return mb;
    }
    let found: GdHandPattern | null = null;
    gdForEachPairStraightSeqTemplate(levelRank, numPairs, function (seq: number[]) {
        if (found !== null) {
            return;
        }
        let need = 0;
        for (let i = 0; i < seq.length; i++) {
            const have = cnt[String(seq[i])] || 0;
            need += 2 - have;
        }
        if (need !== wc) {
            return;
        }
        if (gdHasExtraRankOutside(cnt, seq)) {
            return;
        }
        found = gdMakePattern(
            GD_KIND_PAIR_STRAIGHT,
            mainOfPairStraightSeq(seq),
            n,
            0,
            wc,
            numPairs,
            -1
        );
    });
    return found;
}

function gdTryTripleStraight(
    normals: number[],
    wilds: number[],
    levelRank: number
): GdHandPattern | null {
    const n = normals.length + wilds.length;
    if (n !== 6) {
        return null;
    }
    const wc = wilds.length;
    const cnt = gdRankCountsOfNormals(normals);
    for (const k in cnt) {
        if (!cnt.hasOwnProperty(k)) {
            continue;
        }
        const r = parseInt(k, 10);
        if (r >= 13) {
            return null;
        }
        if (cnt[k] > 3) {
            return null;
        }
    }
    for (let top = 1; top <= 11; top++) {
        const seq: number[] = [top - 1, top];
        if (!gdSeqAllowedForStraight(seq, levelRank)) {
            continue;
        }
        let need = 0;
        for (let i = 0; i < seq.length; i++) {
            const have = cnt[String(seq[i])] || 0;
            need += 3 - have;
        }
        if (need !== wc) {
            continue;
        }
        if (gdHasExtraRankOutside(cnt, seq)) {
            continue;
        }
        return gdMakePattern(
            GD_KIND_TRIPLE_STRAIGHT,
            gdRankValueFromRaw(top, levelRank),
            6,
            0,
            wc,
            2,
            -1
        );
    }
    return null;
}

function gdTryStraightFlush(
    normals: number[],
    wilds: number[],
    levelRank: number
): GdHandPattern | null {
    const n = normals.length + wilds.length;
    if (n !== 5) {
        return null;
    }
    const wc = wilds.length;
    for (let suit = 0; suit < 4; suit++) {
        const suitCnt: { [k: string]: number } = {};
        let bad = false;
        for (let i = 0; i < normals.length; i++) {
            const id = normals[i];
            const r = gdRawRank(id);
            if (r >= 13) {
                bad = true;
                break;
            }
            if (gdSuit(id) !== suit) {
                bad = true;
                break;
            }
            const key = String(r);
            suitCnt[key] = (suitCnt[key] || 0) + 1;
            if (suitCnt[key] > 1) {
                bad = true;
                break;
            }
        }
        if (bad) {
            continue;
        }
        for (let top = 4; top <= 11; top++) {
            const seq: number[] = [top - 4, top - 3, top - 2, top - 1, top];
            if (!gdSeqAllowedForStraight(seq, levelRank)) {
                continue;
            }
            let need = 0;
            for (let i = 0; i < seq.length; i++) {
                const have = suitCnt[String(seq[i])] || 0;
                need += 1 - have;
            }
            if (need !== wc) {
                continue;
            }
            if (gdHasExtraRankOutside(suitCnt, seq)) {
                continue;
            }
            return gdMakePattern(
                GD_KIND_STRAIGHT_FLUSH,
                gdRankValueFromRaw(top, levelRank),
                5,
                GD_BOMB_TIER_SF,
                wc,
                5,
                suit
            );
        }
        {
            const seq: number[] = [11, 12, 0, 1, 2];
            let need = 0;
            for (let i = 0; i < seq.length; i++) {
                const r = seq[i];
                if (r === levelRank) {
                    need += 1;
                    continue;
                }
                const have = suitCnt[String(r)] || 0;
                need += 1 - have;
            }
            if (need === wc && !gdHasExtraRankOutside(suitCnt, seq)) {
                return gdMakePattern(
                    GD_KIND_STRAIGHT_FLUSH,
                    GD_STRAIGHT_MAIN_WHEEL_LOW,
                    5,
                    GD_BOMB_TIER_SF,
                    wc,
                    5,
                    suit
                );
            }
        }
    }
    return null;
}

/** 主入口：对一手牌进行分类 */
function gdClassify(ids: number[], levelRank: number): GdHandPattern {
    if (ids.length === 0) {
        return gdMakePattern(GD_KIND_PASS, -1, 0, 0, 0, 0, -1);
    }
    const sp = gdSplitWilds(ids, levelRank);
    const nm = sp.normals;
    const wd = sp.wilds;
    const n = ids.length;

    const kb = gdTryKingBomb(nm, wd);
    if (kb) {
        return kb;
    }
    if (n >= 4 && n <= 8) {
        const b = gdTryBomb(nm, wd, levelRank);
        if (b) {
            return b;
        }
    }
    if (n === 1) {
        const s = gdTrySingle(ids, levelRank);
        if (s) {
            return s;
        }
    }
    if (n === 2) {
        const p = gdTryPair(nm, wd, levelRank);
        if (p) {
            return p;
        }
    }
    if (n === 3) {
        const t = gdTryTriple(nm, wd, levelRank);
        if (t) {
            return t;
        }
    }
    if (n === 5) {
        const sf = gdTryStraightFlush(nm, wd, levelRank);
        if (sf) {
            return sf;
        }
        const st = gdTryStraight(nm, wd, levelRank);
        if (st) {
            return st;
        }
        const tp = gdTryTriplePair(nm, wd, levelRank);
        if (tp) {
            return tp;
        }
    }
    /** 连对：6/8/10…24 张（偶数）；须先于同张数的其它尝试（此处仅连对 + 6 张钢板） */
    if (n >= 6 && n % 2 === 0 && n <= 24) {
        const ps = gdTryPairStraight(nm, wd, levelRank);
        if (ps) {
            return ps;
        }
    }
    if (n === 6) {
        const ts = gdTryTripleStraight(nm, wd, levelRank);
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
function gdBeats(last: GdHandPattern, cur: GdHandPattern): boolean {
    if (cur.kind === GD_KIND_INVALID) {
        return false;
    }
    if (last.kind === GD_KIND_PASS) {
        return cur.kind !== GD_KIND_PASS && cur.kind !== GD_KIND_INVALID;
    }
    const lastIsBomb = last.bombTier > 0;
    const curIsBomb = cur.bombTier > 0;
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
function gdNextLevel(currentRawRank: number, step: number): number {
    let idx = -1;
    for (let i = 0; i < GD_LEVEL_ORDER.length; i++) {
        if (GD_LEVEL_ORDER[i] === currentRawRank) {
            idx = i;
            break;
        }
    }
    if (idx < 0) {
        return currentRawRank;
    }
    let next = idx + step;
    if (next >= GD_LEVEL_ORDER.length) {
        next = GD_LEVEL_ORDER.length - 1;
    }
    return GD_LEVEL_ORDER[next];
}
