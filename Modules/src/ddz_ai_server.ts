// @ts-nocheck
/**
 * 服务端斗地主 AI：与客户端 scripts/ddz_ai.gd / ddz_ai_play.gd 策略对齐。
 * 依赖 main.ts 中的 classify、beats、ddzRankValue、DdzHandPattern、DDZ_KIND_*。
 */

const AI_STYLE_NORMAL = 0;
const AI_STYLE_AGGRESSIVE = 1;
const AI_STYLE_PASSIVE = 2;

/** 专业级：略抬叫分/抢地主积极性，记牌式跟牌更果断，少无谓让牌 */
const AI_PRO_MODE = true;

function aiProStyle(style: number): number {
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

function aiStyleFromCatId(catId: number): number {
    if (catId === 1) {
        return AI_STYLE_AGGRESSIVE;
    }
    if (catId === 2) {
        return AI_STYLE_PASSIVE;
    }
    return AI_STYLE_NORMAL;
}

function aiBuckets(hand: number[]): { [k: string]: number[] } {
    const b: { [k: string]: number[] } = {};
    for (let i = 0; i < hand.length; i++) {
        const cid = hand[i];
        const r = ddzRankValue(cid);
        const k = String(r);
        if (!b[k]) {
            b[k] = [];
        }
        b[k].push(cid);
    }
    for (const k in b) {
        if (b.hasOwnProperty(k)) {
            b[k].sort(function (a, c) {
                return a - c;
            });
        }
    }
    return b;
}

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
    const b = aiBuckets(hand);
    let s = 0.0;
    for (const rk in b) {
        if (!b.hasOwnProperty(rk)) {
            continue;
        }
        const r = parseInt(rk, 10);
        const arr = b[rk];
        const n = arr.length;
        const w = aiRankWeightLandlord(r);
        s += n * w;
        if (n === 2 || n === 3) {
            s += 0.2 * n * w;
        }
        if (n >= 4) {
            s += 11.0;
        }
    }
    const a13 = b["13"] || [];
    const a14 = b["14"] || [];
    if (a13.length >= 1 && a14.length >= 1) {
        s += 7.0;
    }
    return s;
}

/** 仅「不叫」0 或「叫地主」1（与 main.applyBid 一致） */
function aiChooseBid(hand: number[], style: number): number {
    const s = aiHandLandlordStrength(hand);
    let t = 20.0;
    if (AI_PRO_MODE) {
        t -= 2.0;
    }
    if (style === AI_STYLE_AGGRESSIVE) {
        t -= 3.5;
    } else if (style === AI_STYLE_PASSIVE) {
        t += 3.0;
    }
    return s >= t ? 1 : 0;
}

function aiChooseRobLandlord(hand: number[], currentMultiplier: number, style: number): boolean {
    const s = aiHandLandlordStrength(hand);
    let floorS = 18.0;
    let need = 30.0;
    if (AI_PRO_MODE) {
        floorS -= 2.5;
        need -= 3.0;
    }
    if (currentMultiplier >= 4) {
        need = 44.0;
    } else if (currentMultiplier >= 2) {
        need = 36.0;
    }
    if (style === AI_STYLE_AGGRESSIVE) {
        floorS = 14.0;
        if (currentMultiplier >= 4) {
            need = 39.0;
        } else if (currentMultiplier >= 2) {
            need = 31.0;
        } else {
            need = 25.0;
        }
    } else if (style === AI_STYLE_PASSIVE) {
        floorS = 22.0;
        if (currentMultiplier >= 4) {
            need = 50.0;
        } else if (currentMultiplier >= 2) {
            need = 42.0;
        } else {
            need = 36.0;
        }
    }
    if (s < floorS) {
        return false;
    }
    return s >= need;
}

function aiIsFarmer(me: number, landlord: number): boolean {
    return me !== landlord;
}

function aiTeammateFarmer(me: number, landlord: number): number {
    if (me === landlord) {
        return -1;
    }
    for (let i = 0; i < 3; i++) {
        if (i !== landlord && i !== me) {
            return i;
        }
    }
    return -1;
}

function aiIsFarmerYieldPass(ctx: { [k: string]: any }, last: DdzHandPattern): boolean {
    if (!last || last.kind === DDZ_KIND_PASS || last.kind === DDZ_KIND_ROCKET) {
        return false;
    }
    const me = ctx.me as number;
    const ld = ctx.landlord as number;
    const lastPl = ctx.last_player as number;
    const passes = ctx.passes as number;
    const ast = ctx.ai_style as number;
    if (aiIsFarmer(me, ld) && passes === 1) {
        const mate = aiTeammateFarmer(me, ld);
        if (mate === lastPl) {
            if (AI_PRO_MODE) {
                return ast === AI_STYLE_PASSIVE;
            }
            return ast !== AI_STYLE_AGGRESSIVE;
        }
    }
    return false;
}

function aiShouldAvoidBomb(ctx: { [k: string]: any }, hand: number[], last: DdzHandPattern): boolean {
    const lastIsBomb = last.kind === DDZ_KIND_BOMB;
    if (lastIsBomb) {
        return false;
    }
    const minO = ctx.min_opp_cards as number;
    const ast = ctx.ai_style as number;
    const longH = hand.length >= 10;
    const oppHeavy = minO >= 9;
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

function aiTrySamePattern(b: { [k: string]: number[] }, last: DdzHandPattern): number[] {
    const lk = last.kind;
    const main = last.main;
    const extra = last.extra;
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

function aiFollowSingle(b: { [k: string]: number[] }, needGt: number): number[] {
    for (let r = needGt + 1; r < 15; r++) {
        const arr = b[String(r)] || [];
        if (arr.length >= 1) {
            return [arr[0]];
        }
    }
    return [];
}

function aiFollowPair(b: { [k: string]: number[] }, needGt: number): number[] {
    for (let r = needGt + 1; r < 15; r++) {
        const arr = b[String(r)] || [];
        if (arr.length >= 2) {
            return [arr[0], arr[1]];
        }
    }
    return [];
}

function aiFollowTriple(b: { [k: string]: number[] }, needGt: number): number[] {
    for (let r = needGt + 1; r < 15; r++) {
        const arr = b[String(r)] || [];
        if (arr.length >= 3) {
            return [arr[0], arr[1], arr[2]];
        }
    }
    return [];
}

function aiFollowStraight(b: { [k: string]: number[] }, needTopGt: number, length: number): number[] {
    if (length < 5) {
        return [];
    }
    for (let top = needTopGt + 1; top < 12; top++) {
        const bot = top - (length - 1);
        if (bot < 0) {
            continue;
        }
        let ok = true;
        const out: number[] = [];
        for (let r = bot; r <= top; r++) {
            if (r === 12 || r >= 13) {
                ok = false;
                break;
            }
            const arr = b[String(r)] || [];
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

function aiFollowTripleSingle(b: { [k: string]: number[] }, needMainGt: number): number[] {
    for (let tr = needMainGt + 1; tr < 13; tr++) {
        const ta = b[String(tr)] || [];
        if (ta.length < 3) {
            continue;
        }
        for (let kri = 0; kri < 15; kri++) {
            if (kri === tr) {
                continue;
            }
            const ka = b[String(kri)] || [];
            if (ka.length < 1) {
                continue;
            }
            return [ta[0], ta[1], ta[2], ka[0]];
        }
    }
    return [];
}

function aiFollowTriplePair(b: { [k: string]: number[] }, needMainGt: number): number[] {
    for (let tr = needMainGt + 1; tr < 13; tr++) {
        const ta = b[String(tr)] || [];
        if (ta.length < 3) {
            continue;
        }
        for (let pri = 0; pri < 15; pri++) {
            if (pri === tr) {
                continue;
            }
            const pa = b[String(pri)] || [];
            if (pa.length < 2) {
                continue;
            }
            return [ta[0], ta[1], ta[2], pa[0], pa[1]];
        }
    }
    return [];
}

function aiFollowPairStraight(b: { [k: string]: number[] }, needTopGt: number, nCards: number): number[] {
    const nPairs = nCards / 2;
    if (nPairs < 3) {
        return [];
    }
    for (let top = needTopGt + 1; top < 12; top++) {
        const bot = top - (nPairs - 1);
        if (bot < 0) {
            continue;
        }
        let ok = true;
        const out: number[] = [];
        for (let r = bot; r <= top; r++) {
            if (r === 12 || r >= 13) {
                ok = false;
                break;
            }
            const pa = b[String(r)] || [];
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

function aiBucketsMinusFour(b: { [k: string]: number[] }, fourRank: number): { [k: string]: number[] } {
    const out: { [k: string]: number[] } = {};
    for (const k in b) {
        if (!b.hasOwnProperty(k)) {
            continue;
        }
        const ki = parseInt(k, 10);
        let arr = b[k].slice();
        if (ki === fourRank) {
            for (let t = 0; t < 4 && arr.length > 0; t++) {
                arr.shift();
            }
        }
        if (arr.length > 0) {
            out[k] = arr;
        }
    }
    return out;
}

function aiPickTwoSinglesExcept(b2: { [k: string]: number[] }, fr: number): number[] {
    const out: number[] = [];
    for (let r = 0; r < 15; r++) {
        if (r === fr || r >= 13) {
            continue;
        }
        const a = b2[String(r)] || [];
        if (a.length >= 1) {
            out.push(a[0]);
            if (out.length === 2) {
                return out;
            }
        }
    }
    return [];
}

function aiPickTwoPairsExcept(b2: { [k: string]: number[] }, fr: number): number[] {
    const out: number[] = [];
    for (let r = 0; r < 13; r++) {
        if (r === fr) {
            continue;
        }
        const a = b2[String(r)] || [];
        if (a.length >= 2) {
            out.push(a[0], a[1]);
            if (out.length === 4) {
                return out;
            }
        }
    }
    return [];
}

function aiFollowFourWithTwo(b: { [k: string]: number[] }, needFourGt: number, extra: number): number[] {
    for (let fr = needFourGt + 1; fr < 13; fr++) {
        const fa = b[String(fr)] || [];
        if (fa.length < 4) {
            continue;
        }
        const b2 = aiBucketsMinusFour(b, fr);
        if (extra === 6) {
            const kick = aiPickTwoSinglesExcept(b2, fr);
            if (kick.length === 2) {
                return [fa[0], fa[1], fa[2], fa[3], kick[0], kick[1]];
            }
        } else if (extra === 8) {
            const kickp = aiPickTwoPairsExcept(b2, fr);
            if (kickp.length === 4) {
                return [fa[0], fa[1], fa[2], fa[3], kickp[0], kickp[1], kickp[2], kickp[3]];
            }
        }
    }
    return [];
}

function aiFollowPlanePure(b: { [k: string]: number[] }, needTopGt: number, k: number): number[] {
    if (k < 2) {
        return [];
    }
    for (let top = needTopGt + 1; top < 12; top++) {
        const st = top - k + 1;
        if (st < 0) {
            continue;
        }
        let ok = true;
        const out: number[] = [];
        for (let r = st; r <= top; r++) {
            if (r > 11) {
                ok = false;
                break;
            }
            const arr = b[String(r)] || [];
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

function aiBucketsDup(b: { [k: string]: number[] }): { [k: string]: number[] } {
    const o: { [k: string]: number[] } = {};
    for (const kk in b) {
        if (b.hasOwnProperty(kk)) {
            o[kk] = b[kk].slice();
        }
    }
    return o;
}

function aiPickPlaneWingCards(
    rest: { [k: string]: number[] },
    st: number,
    k: number,
    needSingles: number,
    numPairWings: number
): number[] {
    let pairsLeft = numPairWings;
    let singlesLeft = needSingles;
    const taken: number[] = [];
    for (let r = 0; r < 13; r++) {
        if (r >= st && r <= st + k - 1) {
            continue;
        }
        let arr = rest[String(r)] || [];
        while (pairsLeft > 0 && arr.length >= 2) {
            taken.push(arr[0], arr[1]);
            arr = arr.slice(2);
            pairsLeft--;
            if (arr.length === 0) {
                delete rest[String(r)];
            } else {
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
    for (let r = 0; r < 13; r++) {
        if (r >= st && r <= st + k - 1) {
            continue;
        }
        let arr2 = rest[String(r)] || [];
        while (singlesLeft > 0 && arr2.length >= 1) {
            taken.push(arr2[0]);
            arr2 = arr2.slice(1);
            singlesLeft--;
            if (arr2.length === 0) {
                delete rest[String(r)];
            } else {
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

function aiTryPlaneWingsCombo(b: { [k: string]: number[] }, st: number, k: number, ex: number): number[] {
    const numPairWings = ex & 31;
    const needSingles = k - numPairWings;
    const rest = aiBucketsDup(b);
    const out: number[] = [];
    for (let r = st; r < st + k; r++) {
        const arr = rest[String(r)] || [];
        if (arr.length < 3) {
            return [];
        }
    }
    for (let r = st; r < st + k; r++) {
        let arr = rest[String(r)] || [];
        for (let i = 0; i < 3; i++) {
            out.push(arr.shift()!);
        }
        if (arr.length === 0) {
            delete rest[String(r)];
        } else {
            rest[String(r)] = arr;
        }
    }
    const wings = aiPickPlaneWingCards(rest, st, k, needSingles, numPairWings);
    if (wings.length === 0) {
        return [];
    }
    for (let i = 0; i < wings.length; i++) {
        out.push(wings[i]);
    }
    return out;
}

function aiFollowPlaneWithWings(b: { [k: string]: number[] }, needMainGt: number, ex: number): number[] {
    const k = ex >> 5;
    if (k < 2) {
        return [];
    }
    for (let top = needMainGt + 1; top < 12; top++) {
        const st = top - k + 1;
        if (st < 0) {
            continue;
        }
        if (st + k - 1 > 11) {
            continue;
        }
        const combo = aiTryPlaneWingsCombo(b, st, k, ex);
        if (combo.length > 0) {
            return combo;
        }
    }
    return [];
}

function aiTryBomb(b: { [k: string]: number[] }, last: DdzHandPattern): number[] {
    const lastIsBomb = last.kind === DDZ_KIND_BOMB;
    const needMain = last.main;
    for (let r = 0; r < 13; r++) {
        const arr = b[String(r)] || [];
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

function aiTryRocket(b: { [k: string]: number[] }): number[] {
    const a13 = b["13"] || [];
    const a14 = b["14"] || [];
    if (a13.length >= 1 && a14.length >= 1) {
        return [a13[0], a14[0]];
    }
    return [];
}

function aiFindFollow(hand: number[], last: DdzHandPattern, ctx: { [k: string]: any }): number[] {
    if (!last || last.kind === DDZ_KIND_PASS) {
        return [];
    }
    if (last.kind === DDZ_KIND_ROCKET) {
        return [];
    }
    if (ctx && aiIsFarmerYieldPass(ctx, last)) {
        return [];
    }
    const b = aiBuckets(hand);
    const same = aiTrySamePattern(b, last);
    if (same.length > 0) {
        return same;
    }
    const bomb = aiTryBomb(b, last);
    if (bomb.length > 0) {
        if (!ctx || !aiShouldAvoidBomb(ctx, hand, last)) {
            return bomb;
        }
    }
    return aiTryRocket(b);
}

function aiWeakestStraightFive(b: { [k: string]: number[] }): number[] {
    for (let top = 4; top < 12; top++) {
        const bot = top - 4;
        if (bot < 0) {
            continue;
        }
        const out: number[] = [];
        let ok = true;
        for (let r = bot; r <= top; r++) {
            if (r === 12 || r >= 13) {
                ok = false;
                break;
            }
            const arr = b[String(r)] || [];
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

function aiWeakestPair(b: { [k: string]: number[] }): number[] {
    for (let r = 0; r < 15; r++) {
        const arr = b[String(r)] || [];
        if (arr.length >= 2) {
            return [arr[0], arr[1]];
        }
    }
    return [];
}

function aiWeakestTriple(b: { [k: string]: number[] }): number[] {
    for (let r = 0; r < 15; r++) {
        const arr = b[String(r)] || [];
        if (arr.length >= 3) {
            return [arr[0], arr[1], arr[2]];
        }
    }
    return [];
}

function aiWeakestSingleFromHand(hand: number[], _b: { [k: string]: number[] }): number[] {
    let best = hand[0];
    let bestV = ddzRankValue(best);
    for (let i = 1; i < hand.length; i++) {
        const cid = hand[i];
        const v = ddzRankValue(cid);
        if (v < bestV || (v === bestV && cid < best)) {
            best = cid;
            bestV = v;
        }
    }
    return [best];
}

function aiWeakestOrphanSingle(b: { [k: string]: number[] }): number[] {
    for (let r = 0; r < 15; r++) {
        const arr = b[String(r)] || [];
        if (arr.length === 1) {
            return [arr[0]];
        }
    }
    return [];
}

function aiSeenRankMustPlay(b: { [k: string]: number[] }, ctx: { [k: string]: any }): number[] {
    const seen = (ctx.seen_rank as number[]) || [];
    if (seen.length < 15) {
        return [];
    }
    for (let r = 0; r < 13; r++) {
        const played = r < seen.length ? seen[r] : 0;
        if (played === 3) {
            const arr2 = b[String(r)] || [];
            if (arr2.length >= 1) {
                return [arr2[0]];
            }
        }
    }
    return [];
}

function aiChooseFreeLead(hand: number[], ctx: { [k: string]: any }): number[] {
    if (hand.length === 0) {
        return [];
    }
    const b = aiBuckets(hand);
    const st = aiWeakestStraightFive(b);
    let straightOk = false;
    if (st.length > 0) {
        const pat = classify(st);
        straightOk = pat.kind === DDZ_KIND_STRAIGHT;
    }
    const style = (ctx.ai_style as number) || 0;
    if (style === 1) {
        if (straightOk) {
            return st;
        }
        const prA = aiWeakestPair(b);
        if (prA.length > 0) {
            return prA;
        }
        const trA = aiWeakestTriple(b);
        if (trA.length > 0) {
            return trA;
        }
        const osA = aiWeakestOrphanSingle(b);
        if (osA.length > 0) {
            return osA;
        }
        const snA = aiSeenRankMustPlay(b, ctx);
        if (snA.length > 0) {
            return snA;
        }
        return aiWeakestSingleFromHand(hand, b);
    }
    if (straightOk) {
        return st;
    }
    const os = aiWeakestOrphanSingle(b);
    if (os.length > 0) {
        return os;
    }
    const pr = aiWeakestPair(b);
    if (pr.length > 0) {
        return pr;
    }
    const triplePl = aiWeakestTriple(b);
    if (triplePl.length > 0) {
        return triplePl;
    }
    const sn = aiSeenRankMustPlay(b, ctx);
    if (sn.length > 0) {
        return sn;
    }
    return aiWeakestSingleFromHand(hand, b);
}

function buildAiCtxFromState(state: DdzMatchState, seat: number): { [k: string]: any } {
    const oa = state.hands[(seat + 1) % 3].length;
    const ob = state.hands[(seat + 2) % 3].length;
    const minOpp = oa < ob ? oa : ob;
    const cat = state.seatCat[seat] !== undefined ? state.seatCat[seat] : 0;
    const style = aiProStyle(aiStyleFromCatId(cat));
    const seen: number[] = [];
    for (let i = 0; i < 15; i++) {
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

function aiRunPlayTurn(state: DdzMatchState, seat: number): void {
    const hand = state.hands[seat];
    if (hand.length === 0) {
        return;
    }
    const ctx = buildAiCtxFromState(state, seat);
    const last = state.lastPattern;
    const trickFree = !last || last.kind === DDZ_KIND_PASS || state.passes >= 2;
    let cards: number[] = [];
    if (trickFree) {
        cards = aiChooseFreeLead(hand, ctx);
        if (cards.length === 0) {
            cards = [hand[0]];
        }
    } else {
        cards = aiFindFollow(hand, last as DdzHandPattern, ctx);
        if (cards.length === 0) {
            applyPass(state, seat);
            return;
        }
    }
    applyPlay(state, seat, cards);
}

function aiRunBidTurn(state: DdzMatchState, seat: number, nk: nkruntime.Nakama): void {
    const hand = state.hands[seat];
    const cat = state.seatCat[seat] !== undefined ? state.seatCat[seat] : 0;
    const style = aiProStyle(aiStyleFromCatId(cat));
    const bid = aiChooseBid(hand, style);
    applyBid(state, seat, bid, nk);
}

function aiRunRobTurn(state: DdzMatchState, seat: number): void {
    const hand = state.hands[seat];
    const cat = state.seatCat[seat] !== undefined ? state.seatCat[seat] : 0;
    const style = aiProStyle(aiStyleFromCatId(cat));
    const curMult = state.multBase * state.multRob;
    const rob = aiChooseRobLandlord(hand, curMult, style);
    applyRob(state, seat, rob);
}

/** 叫牌/抢地主：AI 连动间隔（与 main.ts AI_BID_ROB_PACE_MS、出牌链式延迟同量级） */
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
            /** 人类已出过牌时用 aiPlayDelayUntilMs；AI 连出时须额外等待，否则客户端上一手动画未完下一快照已到 */
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

function maybeAutoContinueWithAi(st: DdzMatchState, dispatcher: nkruntime.MatchDispatcher, logger: nkruntime.Logger, nk: nkruntime.Nakama): void {
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
