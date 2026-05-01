/**
 * 猫猫杀牌手 AI（全信息）：家猫/同伴 vs 野猫 vs 独行猫目标不同。
 */

function mkAiAliveCount(st: MkMatchState): number {
    let c = 0;
    for (let s = 0; s < st.playerCount; s++) {
        if (st.alive[s]) {
            c++;
        }
    }
    return c;
}

/** 存活野猫人数 */
function mkAiAliveWildCount(st: MkMatchState): number {
    let c = 0;
    for (let s = 0; s < st.playerCount; s++) {
        if (st.alive[s] && st.identities[s] === MK_ROLE_WILD) {
            c++;
        }
    }
    return c;
}

function mkAiIsHouseFaction(role: number): boolean {
    return role === MK_ROLE_HOUSE || role === MK_ROLE_COMPANION;
}

/** 独行猫「伪装」阶段：场上仍有野猫时假装同伴压制野猫 */
function mkAiLoneHideAgainstWild(st: MkMatchState): boolean {
    return mkAiAliveWildCount(st) > 0;
}

function mkAiIsEnemy(st: MkMatchState, selfSeat: number, otherSeat: number): boolean {
    const rs = st.identities[selfSeat];
    const ro = st.identities[otherSeat];
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
function mkAiEnemyScore(st: MkMatchState, attackerSeat: number, targetSeat: number): number {
    const me = st.identities[attackerSeat];
    const them = st.identities[targetSeat];
    const thp = st.hp[targetSeat];

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

function mkAiPickSlashTarget(st: MkMatchState, seat: number): number {
    const n = st.playerCount;
    let bestT = -1;
    let bestScore = -1;
    let bestHp = 99;
    for (let t = 0; t < n; t++) {
        if (t === seat || !st.alive[t]) {
            continue;
        }
        if (!mkMkAttackRangeOk(st, seat, t)) {
            continue;
        }
        const sc = mkAiEnemyScore(st, seat, t);
        if (sc <= 0) {
            continue;
        }
        const thp = st.hp[t];
        if (sc > bestScore || (sc === bestScore && thp < bestHp)) {
            bestScore = sc;
            bestHp = thp;
            bestT = t;
        }
    }
    return bestT;
}

function mkAiFindFirstCardIndex(st: MkMatchState, seat: number, key: string): number {
    const hand = st.hands[seat];
    for (let i = 0; i < hand.length; i++) {
        if (mkRulesCardKey(hand[i]) === key) {
            return i;
        }
    }
    return -1;
}

function mkAiShouldUseJink(st: MkMatchState, victimSeat: number): boolean {
    if (st.pending === null || st.pending.kind !== "jink") {
        return false;
    }
    const hand = st.hands[victimSeat];
    let hasJink = false;
    for (let i = 0; i < hand.length; i++) {
        if (mkRulesCardKey(hand[i]) === "jink") {
            hasJink = true;
            break;
        }
    }
    if (!hasJink) {
        return false;
    }
    const attacker = st.pending.attacker;
    if (st.hp[victimSeat] <= 1) {
        return true;
    }
    return mkAiIsEnemy(st, victimSeat, attacker);
}

function mkAiShouldPeachVictim(st: MkMatchState, saverSeat: number, victimSeat: number): boolean {
    if (saverSeat === victimSeat) {
        return true;
    }
    const rs = st.identities[saverSeat];
    const rv = st.identities[victimSeat];
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

function mkAiDiscardCardRank(st: MkMatchState, seat: number, instanceId: number): number {
    const k = mkRulesCardKey(instanceId);
    const me = st.identities[seat];
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
function mkAiPickDiscardIndices(st: MkMatchState, seat: number): number[] {
    const hand = st.hands[seat];
    const need = hand.length - st.hp[seat];
    if (need <= 0) {
        return [];
    }
    const scored: { idx: number; rank: number }[] = [];
    for (let i = 0; i < hand.length; i++) {
        scored.push({ idx: i, rank: mkAiDiscardCardRank(st, seat, hand[i]) });
    }
    scored.sort(function (a, b) {
        if (a.rank !== b.rank) {
            return a.rank - b.rank;
        }
        return b.idx - a.idx;
    });
    const out: number[] = [];
    for (let j = 0; j < need && j < scored.length; j++) {
        out.push(scored[j].idx);
    }
    out.sort(function (a, b) {
        return b - a;
    });
    return out;
}
