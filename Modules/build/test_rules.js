"use strict";
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
var _pass = 0;
var _fail = 0;
function assertEq(label, actual, expected) {
    if (actual === expected) {
        _pass++;
    }
    else {
        _fail++;
        console.error("[FAIL] " + label + " expected=" + JSON.stringify(expected) + " actual=" + JSON.stringify(actual));
    }
}
function assertTrue(label, cond) {
    assertEq(label, cond, true);
}
function assertFalse(label, cond) {
    assertEq(label, cond, false);
}
/** 便捷：构造 花色*13 + rank 的 id。rawRank 0=3, 1=4, ..., 7=T, 8=J, 9=Q, 10=K, 11=A, 12=2 */
function CARD(suit, rawRank, deckOffset) {
    if (deckOffset === void 0) { deckOffset = 0; }
    // suit: 0♠ / 1♥ / 2♣ / 3♦
    return deckOffset * 54 + suit * 13 + rawRank;
}
var SMALL_JOKER_A = 52;
var SMALL_JOKER_B = 52 + 54;
var BIG_JOKER_A = 53;
var BIG_JOKER_B = 53 + 54;
var LVL_2 = 12; // rawRank of "2"（首轮级牌）
var LVL_5 = 2; // rawRank of "5"
var LVL_9 = 6; // rawRank of "9"
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
        var p = gdClassify([CARD(0, 5)], LVL_2);
        assertEq("single.kind", p.kind, GD_KIND_SINGLE);
        assertEq("single.main", p.main, gdRankValueFromRaw(5, LVL_2));
    }
    {
        var p = gdClassify([CARD(0, 5), CARD(2, 5)], LVL_2);
        assertEq("pair.kind", p.kind, GD_KIND_PAIR);
        assertEq("pair wildUsed=0", p.wildUsed, 0);
    }
    {
        // ♥级牌（2）+ ♠5 = 一对 5（wild 凑对）
        var p = gdClassify([CARD(1, LVL_2), CARD(0, 5)], LVL_2);
        assertEq("pair with wild kind", p.kind, GD_KIND_PAIR);
        assertEq("pair with wild wildUsed=1", p.wildUsed, 1);
        assertEq("pair main=5", p.main, gdRankValueFromRaw(5, LVL_2));
    }
    {
        var p = gdClassify([CARD(0, 6), CARD(1, 6), CARD(2, 6)], LVL_2);
        assertEq("triple.kind", p.kind, GD_KIND_TRIPLE);
    }
    {
        // 三带二：5 5 5 8 8
        var p = gdClassify([CARD(0, 2), CARD(1, 2), CARD(2, 2), CARD(0, 5), CARD(3, 5)], LVL_2);
        assertEq("triple+pair.kind", p.kind, GD_KIND_TRIPLE_WITH_PAIR);
    }
})();
/* ===================== 顺子 / 连对 / 钢板 ===================== */
(function testStraightLike() {
    {
        // 顺子 3-4-5-6-7
        var p = gdClassify([CARD(0, 0), CARD(1, 1), CARD(2, 2), CARD(3, 3), CARD(0, 4)], LVL_2);
        assertEq("straight 3-7 kind", p.kind, GD_KIND_STRAIGHT);
        assertEq("straight main=top 7", p.main, gdRankValueFromRaw(4, LVL_2));
    }
    {
        // 顺子 TJQKA（top A）
        var p = gdClassify([CARD(0, 7), CARD(1, 8), CARD(2, 9), CARD(3, 10), CARD(0, 11)], LVL_2);
        assertEq("straight TJQKA kind", p.kind, GD_KIND_STRAIGHT);
    }
    {
        // 最小顺 A2345：打 2 时 2 为级牌，用 ♥2 作逢人配补 2 点张
        var p = gdClassify([CARD(0, 11), CARD(0, 0), CARD(1, 1), CARD(2, 2), CARD(1, 12)], LVL_2);
        assertTrue("wheel A2345 straight", p.kind === GD_KIND_STRAIGHT);
        assertEq("wheel A2345 main", p.main, -100);
    }
    {
        // 打 5：非红心 5 为普通点；3♠4♥5♣6♦7♠ 成顺（♥5 才是逢人配，不在此手）
        var p = gdClassify([CARD(0, 0), CARD(1, 1), CARD(2, 2), CARD(3, 3), CARD(0, 4)], LVL_5);
        assertTrue("straight may include non-heart level rank", p.kind === GD_KIND_STRAIGHT);
    }
    {
        // 连对 334455
        var p = gdClassify([CARD(0, 0), CARD(2, 0), CARD(1, 1), CARD(3, 1), CARD(0, 2), CARD(2, 2)], LVL_2);
        assertEq("pair straight 334455 kind", p.kind, GD_KIND_PAIR_STRAIGHT);
        assertEq("pair straight 334455 len", p.len, 6);
        assertEq("pair straight 334455 straightLen", p.straightLen, 3);
    }
    {
        // 连对 22334455（四对 2—5）；打 9 时 2 非级牌，可走 …A,2,3… 环序
        var p8 = gdClassify([
            CARD(0, 12), CARD(1, 12),
            CARD(0, 0), CARD(2, 0),
            CARD(1, 1), CARD(3, 1),
            CARD(0, 2), CARD(1, 2),
        ], LVL_9);
        assertEq("pair straight 22334455 kind", p8.kind, GD_KIND_PAIR_STRAIGHT);
        assertEq("pair straight 22334455 len", p8.len, 8);
        assertEq("pair straight 22334455 straightLen", p8.straightLen, 4);
    }
    {
        // 连对 223344（三对 2—4，6 张），非打二
        var p6 = gdClassify([CARD(0, 12), CARD(1, 12), CARD(0, 0), CARD(2, 0), CARD(1, 1), CARD(3, 1)], LVL_9);
        assertEq("pair straight 223344 six kind", p6.kind, GD_KIND_PAIR_STRAIGHT);
        assertEq("pair straight 223344 six len", p6.len, 6);
    }
    {
        // 钢板 333444
        var p = gdClassify([CARD(0, 0), CARD(1, 0), CARD(2, 0), CARD(0, 1), CARD(1, 1), CARD(2, 1)], LVL_2);
        assertEq("triple straight 333444 kind", p.kind, GD_KIND_TRIPLE_STRAIGHT);
    }
})();
/* ===================== 炸弹（4~8 张） / 同花顺 / 天王炸 ===================== */
(function testBombs() {
    {
        // 4 张炸：四个 7
        var p = gdClassify([CARD(0, 4), CARD(1, 4), CARD(2, 4), CARD(3, 4)], LVL_2);
        assertEq("bomb4.kind", p.kind, GD_KIND_BOMB);
        assertEq("bomb4.tier", p.bombTier, GD_BOMB_TIER_4);
    }
    {
        // 5 张炸（含 wild）：3 个 7 + 1 张 7(2nd deck) + ♥级牌
        var p = gdClassify([CARD(0, 4), CARD(1, 4), CARD(2, 4), CARD(3, 4, 1), CARD(1, LVL_2)], LVL_2);
        assertEq("bomb5 with wild kind", p.kind, GD_KIND_BOMB);
        assertEq("bomb5 tier", p.bombTier, GD_BOMB_TIER_5);
        assertEq("bomb5 wildUsed", p.wildUsed, 1);
    }
    {
        // 同花顺 3-7 ♠
        var p = gdClassify([CARD(0, 0), CARD(0, 1), CARD(0, 2), CARD(0, 3), CARD(0, 4)], LVL_2);
        assertEq("sf.kind", p.kind, GD_KIND_STRAIGHT_FLUSH);
        assertEq("sf.tier", p.bombTier, GD_BOMB_TIER_SF);
        assertEq("sf.suit", p.suit, 0);
    }
    {
        // 同花顺带 ♥级牌：♠3 ♠4 ♠5 ♠6 + ♥2 (级牌=2) → ♥2 作为 ♠7 的 wild
        var p = gdClassify([CARD(0, 0), CARD(0, 1), CARD(0, 2), CARD(0, 3), CARD(1, LVL_2)], LVL_2);
        assertEq("sf with wild kind", p.kind, GD_KIND_STRAIGHT_FLUSH);
        assertEq("sf with wild wildUsed", p.wildUsed, 1);
    }
    {
        // 打 9：♠8910JQ 同花顺（非红心 9 仍算点数 9）
        var p = gdClassify([CARD(0, 5), CARD(0, 6), CARD(0, 7), CARD(0, 8), CARD(0, 9)], LVL_9);
        assertEq("sf when level is 9 natural nine in seq", p.kind, GD_KIND_STRAIGHT_FLUSH);
    }
    {
        // 打 9：♠8♠10♠J♠Q + ♥9 逢人配补 9 位
        var p = gdClassify([CARD(0, 5), CARD(0, 7), CARD(0, 8), CARD(0, 9), CARD(1, LVL_9)], LVL_9);
        assertEq("sf when level is 9 heart9 wild", p.kind, GD_KIND_STRAIGHT_FLUSH);
        assertEq("sf when level is 9 heart9 wildUsed", p.wildUsed, 1);
    }
    {
        // 天王炸：2 小王 + 2 大王（不允许 wild）
        var p = gdClassify([SMALL_JOKER_A, SMALL_JOKER_B, BIG_JOKER_A, BIG_JOKER_B], LVL_2);
        assertEq("king bomb kind", p.kind, GD_KIND_KING_BOMB);
        assertEq("king bomb tier", p.bombTier, GD_BOMB_TIER_KING);
    }
    {
        // 4 张王（2 小 + 2 大）+ wild ≠ 天王炸（天王炸不允许 wild）
        var p = gdClassify([SMALL_JOKER_A, SMALL_JOKER_B, BIG_JOKER_A, BIG_JOKER_B, CARD(1, LVL_2)], LVL_2);
        assertFalse("king bomb rejects wild", p.kind === GD_KIND_KING_BOMB);
    }
    {
        // 4 张 2（级牌）应被普通炸识别（级牌仍可组成 n 炸）
        var p = gdClassify([CARD(0, LVL_2), CARD(2, LVL_2), CARD(0, LVL_2, 1), CARD(2, LVL_2, 1)], LVL_2);
        assertEq("level card 4-bomb", p.kind, GD_KIND_BOMB);
    }
})();
/* ===================== beats ===================== */
(function testBeats() {
    var last = gdClassify([CARD(0, 5)], LVL_2); // single 7
    var cur = gdClassify([CARD(1, 6)], LVL_2); // single 8
    assertTrue("single beats larger single", gdBeats(last, cur));
    var curLess = gdClassify([CARD(1, 4)], LVL_2);
    assertFalse("single does not beat smaller", gdBeats(last, curLess));
    var pair = gdClassify([CARD(0, 5), CARD(1, 5)], LVL_2);
    assertFalse("pair does not beat single (diff kind)", gdBeats(last, pair));
    var bomb = gdClassify([CARD(0, 0), CARD(1, 0), CARD(2, 0), CARD(3, 0)], LVL_2);
    assertTrue("bomb beats single", gdBeats(last, bomb));
    var bomb5 = gdClassify([CARD(0, 1), CARD(1, 1), CARD(2, 1), CARD(3, 1), CARD(0, 1, 1)], LVL_2);
    assertTrue("bomb5 beats bomb4", gdBeats(bomb, bomb5));
    // 同花顺 vs 5 炸：SF tier > bomb5
    var sf = gdClassify([CARD(2, 0), CARD(2, 1), CARD(2, 2), CARD(2, 3), CARD(2, 4)], LVL_2);
    assertTrue("sf beats bomb5", gdBeats(bomb5, sf));
    // 6 炸 tier > SF
    var bomb6 = gdClassify([CARD(0, 1), CARD(1, 1), CARD(2, 1), CARD(3, 1), CARD(0, 1, 1), CARD(1, 1, 1)], LVL_2);
    assertTrue("bomb6 beats sf", gdBeats(sf, bomb6));
    // king bomb 最大
    var kb = gdClassify([SMALL_JOKER_A, SMALL_JOKER_B, BIG_JOKER_A, BIG_JOKER_B], LVL_2);
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
