/**
 * 猫猫杀：牌堆、身份包与装备（简化规则包）。
 * 身份：家猫、同伴猫、野猫、独行猫（数值 0–3）。
 */

/** 家猫（公开身份） */
const MK_ROLE_HOUSE = 0;
/** 同伴猫 */
const MK_ROLE_COMPANION = 1;
/** 野猫 */
const MK_ROLE_WILD = 2;
/** 独行猫 */
const MK_ROLE_LONE = 3;

/** 杀实例 id：0..19 */
const MK_SLASH_MAX = 20;
/** 闪：20..34 */
const MK_JINK_MAX = 35;
/** 桃：35..42 */
const MK_PEACH_MAX = 43;
/** 毛线球（无视距离）；43 */
const MK_EQUIP_YARN_ID = 43;
/** 猫爬架（攻击距离 +1）；44 */
const MK_EQUIP_WEAPON_ID = 44;

function mkRulesCardLabelZh(instanceId: number): string {
    const k = mkRulesCardKey(instanceId);
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

function mkRulesCardKey(instanceId: number): string {
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
function mkRulesBuildDeck(): number[] {
    const d: number[] = [];
    let i: number;
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
function mkRulesRingDistance(a: number, b: number, n: number): number {
    if (n <= 1) {
        return 0;
    }
    const f = (b - a + n) % n;
    const g = (a - b + n) % n;
    return f < g ? f : g;
}

function mkRulesDefaultAttackRange(): number {
    return 1;
}

function mkRulesEquipIgnoresDistance(instanceId: number): boolean {
    return mkRulesCardKey(instanceId) === "equip_ball";
}

function mkRulesEquipBonusRange(instanceId: number): number {
    return mkRulesCardKey(instanceId) === "equip_weapon" ? 1 : 0;
}

/** 5人：1家1伴2野1独行；8人：1家2伴4野1独行 */
function mkRulesIdentityPack(playerCount: number): number[] {
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
    const out: number[] = [];
    for (let i = 0; i < playerCount; i++) {
        out.push(MK_ROLE_WILD);
    }
    out[0] = MK_ROLE_HOUSE;
    return out;
}

function mkRulesRoleNameZh(role: number): string {
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
function mkRulesWinnerLabelZh(winner: string | null): string {
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
