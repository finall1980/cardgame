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
