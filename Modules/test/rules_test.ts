// @ts-nocheck
/**
 * 掼蛋规则单元测试（不依赖 Nakama 运行时；由 tsconfig.test.json 编译为单文件后 node 执行）。
 *
 * id 空间：0..107，`baseId = id % 54`
 *   - 0..12  : ♠3..♠A..♠2   (rawRank 0..12)
 *   - 13..25 : ♥3..♥2
 *   - 26..38 : ♣3..♣2
 *   - 39..51 : ♦3..♦2
 *   - 52     : 小王   (rawRank 13)
 *   - 53     : 大王   (rawRank 14)
 *   - 54..107: 第二副牌，rawRank 同上，baseId 等效。
 *
 * 为了测试清晰：提供一些 id helper，然后对关键规则做断言。
 */

declare const console: { log: (...args: any[]) => void; error: (...args: any[]) => void };
declare const process: { exit: (code: number) => void };

let _pass = 0;
let _fail = 0;

function assertEq<T>(label: string, actual: T, expected: T): void {
    if (actual === expected) {
        _pass++;
    } else {
        _fail++;
        console.error("[FAIL] " + label + " expected=" + JSON.stringify(expected) + " actual=" + JSON.stringify(actual));
    }
}

function assertTrue(label: string, cond: boolean): void {
    assertEq(label, cond, true);
}

function assertFalse(label: string, cond: boolean): void {
    assertEq(label, cond, false);
}

/** 便捷：构造 花色*13 + rank 的 id。rawRank 0=3, 1=4, ..., 7=T, 8=J, 9=Q, 10=K, 11=A, 12=2 */
function CARD(suit: number, rawRank: number, deckOffset: number = 0): number {
    // suit: 0♠ / 1♥ / 2♣ / 3♦
    return deckOffset * 54 + suit * 13 + rawRank;
}
const SMALL_JOKER_A = 52;
const SMALL_JOKER_B = 52 + 54;
const BIG_JOKER_A = 53;
const BIG_JOKER_B = 53 + 54;

const LVL_2 = 12; // rawRank of "2"（首轮级牌）
const LVL_5 = 2;  // rawRank of "5"
const LVL_9 = 6;  // rawRank of "9"

/* ===================== baseId / rawRank / suit ===================== */
(function testIdHelpers() {
    assertEq("rawRank ♠3", gdRawRank(CARD(0, 0)), 0);
    assertEq("rawRank ♠T", gdRawRank(CARD(0, 7)), 7);
    assertEq("rawRank ♠A", gdRawRank(CARD(0, 11)), 11);
    assertEq("rawRank ♠2", gdRawRank(CARD(0, 12)), 12);
    assertEq("rawRank small joker 1st deck", gdRawRank(SMALL_JOKER_A), 13);
    assertEq("rawRank big joker 2nd deck", gdRawRank(BIG_JOKER_B), 14);
    assertEq("suit ♥", gdSuit(CARD(1, 5)), 1);
    assertEq("suit joker = -1", gdSuit(BIG_JOKER_A), -1);
    assertTrue("baseId second deck", gdBaseId(CARD(2, 8, 1)) === CARD(2, 8));
})();

/* ===================== rankValue ===================== */
(function testRankValue() {
    // rawRank 3 (index 0) 打 2 时为 rankValue 0（最小）
    assertEq("rv 3 when level=2", gdRankValueFromRaw(0, LVL_2), 0);
    // 打 2 时，T=7；J=12（提升）；因为 J 的实际 rawRank=8；看表：11→12, 12→13, level→14, 13→15, 14→16
    // 但 level=12 时，rawRank 11 映射到 12
    assertEq("rv J when level=2", gdRankValueFromRaw(8, LVL_2), 8);
    assertEq("rv A when level=2", gdRankValueFromRaw(11, LVL_2), 12);
    assertEq("rv 2 when level=2 (level card)", gdRankValueFromRaw(12, LVL_2), 14);
    assertEq("rv small joker", gdRankValueFromRaw(13, LVL_2), 15);
    assertEq("rv big joker", gdRankValueFromRaw(14, LVL_2), 16);
    // 打 5 时：level rawRank=2；2 的 rawRank=12 为非级牌 2，全场最小
    assertEq("rv 5 when level=5 (level card)", gdRankValueFromRaw(2, LVL_5), 14);
    assertEq("rv 2 when level=5 (not level) smallest", gdRankValueFromRaw(12, LVL_5), -1);
})();

/* ===================== Single / Pair / Triple / 三带二 ===================== */
(function testBasicPatterns() {
    {
        const p = gdClassify([CARD(0, 5)], LVL_2);
        assertEq("single.kind", p.kind, GD_KIND_SINGLE);
        assertEq("single.main", p.main, gdRankValueFromRaw(5, LVL_2));
    }
    {
        const p = gdClassify([CARD(0, 5), CARD(2, 5)], LVL_2);
        assertEq("pair.kind", p.kind, GD_KIND_PAIR);
        assertEq("pair wildUsed=0", p.wildUsed, 0);
    }
    {
        // ♥级牌（2）+ ♠5 = 一对 5（wild 凑对）
        const p = gdClassify([CARD(1, LVL_2), CARD(0, 5)], LVL_2);
        assertEq("pair with wild kind", p.kind, GD_KIND_PAIR);
        assertEq("pair with wild wildUsed=1", p.wildUsed, 1);
        assertEq("pair main=5", p.main, gdRankValueFromRaw(5, LVL_2));
    }
    {
        const p = gdClassify([CARD(0, 6), CARD(1, 6), CARD(2, 6)], LVL_2);
        assertEq("triple.kind", p.kind, GD_KIND_TRIPLE);
    }
    {
        // 三带二：5 5 5 8 8
        const p = gdClassify(
            [CARD(0, 2), CARD(1, 2), CARD(2, 2), CARD(0, 5), CARD(3, 5)],
            LVL_2
        );
        assertEq("triple+pair.kind", p.kind, GD_KIND_TRIPLE_WITH_PAIR);
    }
})();

/* ===================== 顺子 / 连对 / 钢板 ===================== */
(function testStraightLike() {
    {
        // 顺子 3-4-5-6-7
        const p = gdClassify(
            [CARD(0, 0), CARD(1, 1), CARD(2, 2), CARD(3, 3), CARD(0, 4)],
            LVL_2
        );
        assertEq("straight 3-7 kind", p.kind, GD_KIND_STRAIGHT);
        assertEq("straight main=top 7", p.main, gdRankValueFromRaw(4, LVL_2));
    }
    {
        // 顺子 TJQKA（top A）
        const p = gdClassify(
            [CARD(0, 7), CARD(1, 8), CARD(2, 9), CARD(3, 10), CARD(0, 11)],
            LVL_2
        );
        assertEq("straight TJQKA kind", p.kind, GD_KIND_STRAIGHT);
    }
    {
        // 最小顺 A2345：打 2 时 2 为级牌，用 ♥2 作逢人配补 2 点张
        const p = gdClassify(
            [CARD(0, 11), CARD(0, 0), CARD(1, 1), CARD(2, 2), CARD(1, 12)],
            LVL_2
        );
        assertTrue("wheel A2345 straight", p.kind === GD_KIND_STRAIGHT);
        assertEq("wheel A2345 main", p.main, -100);
    }
    {
        // 打 5：非红心 5 为普通点；3♠4♥5♣6♦7♠ 成顺（♥5 才是逢人配，不在此手）
        const p = gdClassify(
            [CARD(0, 0), CARD(1, 1), CARD(2, 2), CARD(3, 3), CARD(0, 4)],
            LVL_5
        );
        assertTrue("straight may include non-heart level rank", p.kind === GD_KIND_STRAIGHT);
    }
    {
        // 连对 334455
        const p = gdClassify(
            [CARD(0, 0), CARD(2, 0), CARD(1, 1), CARD(3, 1), CARD(0, 2), CARD(2, 2)],
            LVL_2
        );
        assertEq("pair straight 334455 kind", p.kind, GD_KIND_PAIR_STRAIGHT);
        assertEq("pair straight 334455 len", p.len, 6);
        assertEq("pair straight 334455 straightLen", p.straightLen, 3);
    }
    {
        // 连对 22334455（四对 2—5）；打 9 时 2 非级牌，可走 …A,2,3… 环序
        const p8 = gdClassify(
            [
                CARD(0, 12), CARD(1, 12),
                CARD(0, 0), CARD(2, 0),
                CARD(1, 1), CARD(3, 1),
                CARD(0, 2), CARD(1, 2),
            ],
            LVL_9
        );
        assertEq("pair straight 22334455 kind", p8.kind, GD_KIND_PAIR_STRAIGHT);
        assertEq("pair straight 22334455 len", p8.len, 8);
        assertEq("pair straight 22334455 straightLen", p8.straightLen, 4);
    }
    {
        // 连对 223344（三对 2—4，6 张），非打二
        const p6 = gdClassify(
            [CARD(0, 12), CARD(1, 12), CARD(0, 0), CARD(2, 0), CARD(1, 1), CARD(3, 1)],
            LVL_9
        );
        assertEq("pair straight 223344 six kind", p6.kind, GD_KIND_PAIR_STRAIGHT);
        assertEq("pair straight 223344 six len", p6.len, 6);
    }
    {
        // 钢板 333444
        const p = gdClassify(
            [CARD(0, 0), CARD(1, 0), CARD(2, 0), CARD(0, 1), CARD(1, 1), CARD(2, 1)],
            LVL_2
        );
        assertEq("triple straight 333444 kind", p.kind, GD_KIND_TRIPLE_STRAIGHT);
    }
})();

/* ===================== 炸弹（4~8 张） / 同花顺 / 天王炸 ===================== */
(function testBombs() {
    {
        // 4 张炸：四个 7
        const p = gdClassify([CARD(0, 4), CARD(1, 4), CARD(2, 4), CARD(3, 4)], LVL_2);
        assertEq("bomb4.kind", p.kind, GD_KIND_BOMB);
        assertEq("bomb4.tier", p.bombTier, GD_BOMB_TIER_4);
    }
    {
        // 5 张炸（含 wild）：3 个 7 + 1 张 7(2nd deck) + ♥级牌
        const p = gdClassify(
            [CARD(0, 4), CARD(1, 4), CARD(2, 4), CARD(3, 4, 1), CARD(1, LVL_2)],
            LVL_2
        );
        assertEq("bomb5 with wild kind", p.kind, GD_KIND_BOMB);
        assertEq("bomb5 tier", p.bombTier, GD_BOMB_TIER_5);
        assertEq("bomb5 wildUsed", p.wildUsed, 1);
    }
    {
        // 同花顺 3-7 ♠
        const p = gdClassify(
            [CARD(0, 0), CARD(0, 1), CARD(0, 2), CARD(0, 3), CARD(0, 4)],
            LVL_2
        );
        assertEq("sf.kind", p.kind, GD_KIND_STRAIGHT_FLUSH);
        assertEq("sf.tier", p.bombTier, GD_BOMB_TIER_SF);
        assertEq("sf.suit", p.suit, 0);
    }
    {
        // 同花顺带 ♥级牌：♠3 ♠4 ♠5 ♠6 + ♥2 (级牌=2) → ♥2 作为 ♠7 的 wild
        const p = gdClassify(
            [CARD(0, 0), CARD(0, 1), CARD(0, 2), CARD(0, 3), CARD(1, LVL_2)],
            LVL_2
        );
        assertEq("sf with wild kind", p.kind, GD_KIND_STRAIGHT_FLUSH);
        assertEq("sf with wild wildUsed", p.wildUsed, 1);
    }
    {
        // 打 9：♠8910JQ 同花顺（非红心 9 仍算点数 9）
        const p = gdClassify(
            [CARD(0, 5), CARD(0, 6), CARD(0, 7), CARD(0, 8), CARD(0, 9)],
            LVL_9
        );
        assertEq("sf when level is 9 natural nine in seq", p.kind, GD_KIND_STRAIGHT_FLUSH);
    }
    {
        // 打 9：♠8♠10♠J♠Q + ♥9 逢人配补 9 位
        const p = gdClassify(
            [CARD(0, 5), CARD(0, 7), CARD(0, 8), CARD(0, 9), CARD(1, LVL_9)],
            LVL_9
        );
        assertEq("sf when level is 9 heart9 wild", p.kind, GD_KIND_STRAIGHT_FLUSH);
        assertEq("sf when level is 9 heart9 wildUsed", p.wildUsed, 1);
    }
    {
        // 天王炸：2 小王 + 2 大王（不允许 wild）
        const p = gdClassify(
            [SMALL_JOKER_A, SMALL_JOKER_B, BIG_JOKER_A, BIG_JOKER_B],
            LVL_2
        );
        assertEq("king bomb kind", p.kind, GD_KIND_KING_BOMB);
        assertEq("king bomb tier", p.bombTier, GD_BOMB_TIER_KING);
    }
    {
        // 4 张王（2 小 + 2 大）+ wild ≠ 天王炸（天王炸不允许 wild）
        const p = gdClassify(
            [SMALL_JOKER_A, SMALL_JOKER_B, BIG_JOKER_A, BIG_JOKER_B, CARD(1, LVL_2)],
            LVL_2
        );
        assertFalse("king bomb rejects wild", p.kind === GD_KIND_KING_BOMB);
    }
    {
        // 4 张 2（级牌）应被普通炸识别（级牌仍可组成 n 炸）
        const p = gdClassify(
            [CARD(0, LVL_2), CARD(2, LVL_2), CARD(0, LVL_2, 1), CARD(2, LVL_2, 1)],
            LVL_2
        );
        assertEq("level card 4-bomb", p.kind, GD_KIND_BOMB);
    }
})();

/* ===================== beats ===================== */
(function testBeats() {
    const last = gdClassify([CARD(0, 5)], LVL_2); // single 7
    const cur = gdClassify([CARD(1, 6)], LVL_2);  // single 8
    assertTrue("single beats larger single", gdBeats(last, cur));
    const curLess = gdClassify([CARD(1, 4)], LVL_2);
    assertFalse("single does not beat smaller", gdBeats(last, curLess));

    const pair = gdClassify([CARD(0, 5), CARD(1, 5)], LVL_2);
    assertFalse("pair does not beat single (diff kind)", gdBeats(last, pair));

    const bomb = gdClassify([CARD(0, 0), CARD(1, 0), CARD(2, 0), CARD(3, 0)], LVL_2);
    assertTrue("bomb beats single", gdBeats(last, bomb));
    const bomb5 = gdClassify(
        [CARD(0, 1), CARD(1, 1), CARD(2, 1), CARD(3, 1), CARD(0, 1, 1)],
        LVL_2
    );
    assertTrue("bomb5 beats bomb4", gdBeats(bomb, bomb5));

    // 同花顺 vs 5 炸：SF tier > bomb5
    const sf = gdClassify([CARD(2, 0), CARD(2, 1), CARD(2, 2), CARD(2, 3), CARD(2, 4)], LVL_2);
    assertTrue("sf beats bomb5", gdBeats(bomb5, sf));
    // 6 炸 tier > SF
    const bomb6 = gdClassify(
        [CARD(0, 1), CARD(1, 1), CARD(2, 1), CARD(3, 1), CARD(0, 1, 1), CARD(1, 1, 1)],
        LVL_2
    );
    assertTrue("bomb6 beats sf", gdBeats(sf, bomb6));

    // king bomb 最大
    const kb = gdClassify([SMALL_JOKER_A, SMALL_JOKER_B, BIG_JOKER_A, BIG_JOKER_B], LVL_2);
    assertTrue("king bomb beats bomb6", gdBeats(bomb6, kb));
    assertFalse("nothing beats king bomb", gdBeats(kb, bomb6));
})();

/* ===================== gdNextLevel ===================== */
(function testLevel() {
    assertEq("2 +1 -> 3", gdNextLevel(12, 1), 0);
    assertEq("2 +2 -> 4", gdNextLevel(12, 2), 1);
    assertEq("2 +3 -> 5", gdNextLevel(12, 3), 2);
    assertEq("K +1 -> A (cap)", gdNextLevel(10, 1), 11);
    assertEq("K +3 -> A (cap)", gdNextLevel(10, 3), 11);
    assertEq("A stays A", gdNextLevel(11, 1), 11);
})();

console.log("[rules_test] pass=" + _pass + " fail=" + _fail);
if (_fail > 0) {
    process.exit(1);
}
