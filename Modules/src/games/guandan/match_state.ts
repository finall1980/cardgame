/**
 * 掼蛋（Guan Dan）服务端状态与常量。
 * 与 docs/guandan_DESIGN.md 一致：
 *   - 4 人 2 队，108 张牌（2 副 × 54），每人 27 张。
 *   - 级牌 rawRank 编码：3→0, 4→1, ..., T→7, J→8, Q→9, K→10, A→11, 2→12, 小王→13, 大王→14。
 *   - 起始「打 2」，rawRank=12；升到「打 A」=11（11 为 A 顶顺子用点也是 A）。
 *   - 升级轨迹：2(12) → 3(0) → 4(1) → ... → A(11) → 毕业。
 */

/** 牌型 kind（全局唯一 id 段，不与 DDZ_KIND_* 冲突） */
const GD_KIND_INVALID = 0;
const GD_KIND_PASS = 1;
const GD_KIND_SINGLE = 2;
const GD_KIND_PAIR = 3;
const GD_KIND_TRIPLE = 4;
const GD_KIND_TRIPLE_WITH_PAIR = 5; // 三带二（五张）
const GD_KIND_STRAIGHT = 6;         // 5 张顺子，顶 A（TJQKA），不过 2
const GD_KIND_PAIR_STRAIGHT = 7;    // 连对：≥3 对连续点，len=张数（6/8/10…），straightLen=对数
const GD_KIND_TRIPLE_STRAIGHT = 8;  // 钢板 2 连三 = 6 张
const GD_KIND_STRAIGHT_FLUSH = 9;   // 同花顺（5 张）
const GD_KIND_BOMB = 10;            // 普通 n 炸，n ∈ [4,8]
const GD_KIND_KING_BOMB = 11;       // 天王炸（2 小王 + 2 大王）

/** 炸弹链的档位（同 kind 下再比点）；用于 beats 判定 */
const GD_BOMB_TIER_NONE = 0;
const GD_BOMB_TIER_4 = 1;
const GD_BOMB_TIER_5 = 2;
const GD_BOMB_TIER_SF = 3; // 同花顺
const GD_BOMB_TIER_6 = 4;
const GD_BOMB_TIER_7 = 5;
const GD_BOMB_TIER_8 = 6;
const GD_BOMB_TIER_KING = 7;

/** 服务端 → 客户端 opcode（与 DDZ_OP_* 错开） */
const GD_OP_SNAPSHOT = 201;
const GD_OP_ERROR = 202;
const GD_OP_SETTLEMENT = 220;
const GD_OP_HINT = 203; // 仅发给请求者：{ v, pass, ids }

/** 客户端 → 服务端 REQ（与 DDZ_REQ_* 错开） */
const GD_REQ_PLAY = 30;
const GD_REQ_PASS = 31;
const GD_REQ_TRIBUTE = 32;
const GD_REQ_TRIBUTE_RESIST = 33;
const GD_REQ_RETURN = 34;
const GD_REQ_CONTINUE = 35;
const GD_REQ_DECLARE_WILD = 36; // 预留：客户端主动声明百搭替代（M2 接入）
const GD_REQ_DELEGATE = 38; // AI 托管：为 true 时本 tick 起该座按 AI 出牌
const GD_REQ_HINT = 39; // 智能提示：仅返回建议，不代出（与 gdAiPickPlay 同源）

/** 总牌数与单人手牌数 */
const GD_DECK_COUNT = 108;
const GD_HAND_SIZE = 27;

/** rawRank 常量 */
const GD_RAW_RANK_A = 11;
const GD_RAW_RANK_2 = 12;
const GD_RAW_RANK_SMALL_JOKER = 13;
const GD_RAW_RANK_BIG_JOKER = 14;

/** 升级级牌推进表（index 0 起：打 2 → 打 A） */
const GD_LEVEL_ORDER: number[] = [12, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/** 节奏：AI 出牌最小间隔（避免客户端动画重叠；略长于单手出牌动画） */
const GD_AI_PLAY_PACE_MS = 700;
/** 新一局发牌后让客户端播动画的等待 */
const GD_AI_NEW_ROUND_DELAY_MS = 1400;
/** deal 阶段最短时长（ms），供客户端播发牌动画；结束后进入 play 或贡牌 */
const GD_DEAL_PHASE_MS = 4500;
/** 发牌结束后再隔多久允许 AI 出牌（略短于整局 NEW_ROUND，因 deal 内已等待） */
const GD_AI_POST_DEAL_DELAY_MS = 520;

/** 阶段 */
type GdPhase =
    | "waiting"       // 等玩家 / AI 补位
    | "deal"          // 发牌
    | "tribute_wait"  // 末游/三游待贡
    | "return_wait"   // 头游/二游待还
    | "play"          // 出牌
    | "finished";     // 一方毕业（整场结束）

/** 单手牌型（参与 beats） */
interface GdHandPattern {
    kind: number;
    /** 主点数（按 levelRank 抬高后的 rankValue） */
    main: number;
    /** 本手总张数 */
    len: number;
    /** 炸弹链档位（非炸为 0） */
    bombTier: number;
    /** 本手使用了几张红心级牌做百搭（0..2） */
    wildUsed: number;
    /** 顺子/连对/钢板的连续段长度；三带二等可不使用，置 0 */
    straightLen: number;
    /** 同花顺的花色 0♠ 1♥ 2♣ 3♦；非同花顺置 -1 */
    suit: number;
}

/** 队伍（0 队：座 0&2；1 队：座 1&3） */
interface GdTeam {
    seats: [number, number];
    /** 当前级牌 rawRank；起始 12（打 2），升到 11（打 A）后待「过 A」 */
    level: number;
    /** 已升到 A，等待过 A 毕业 */
    overALocked: boolean;
}

/** 贡/还阶段上下文 */
interface GdTributeCtx {
    /** "none" | "single" | "double" | "resist" */
    mode: string;
    /** 需要进贡的座位（按贡给谁的顺序；single 长度 1；double 长度 2） */
    payers: number[];
    /** 对应接受进贡的座位（double 时同长度） */
    receivers: number[];
    /** 已进贡完成：payerSeat → cardId */
    given: { [seat: string]: number };
    /** 已还贡完成：receiverSeat → cardId */
    returned: { [seat: string]: number };
    /** 当前等待进贡的 payer 座位；-1 表示该阶段已完 */
    pendingPayer: number;
    /** 当前等待还贡的 receiver 座位；-1 表示未到该步或已完 */
    pendingReceiver: number;
}

/** 对局状态 */
interface GdMatchState {
    presences: { [userId: string]: nkruntime.Presence };
    /** 加入顺序映射到 0..3 座位 */
    seatByUserId: { [userId: string]: number };
    /** 本局真人席位数（1..4）；其余为 AI */
    expectHumans: number;
    aiCount: number;
    /** 座位 0..3 是否为 AI（无 Nakama presence） */
    isAiSeat: boolean[];

    phase: GdPhase;

    /** 两队常驻整场 */
    teams: [GdTeam, GdTeam];
    /** 本局庄家队（0/1）；其级牌抬高为全场级 */
    dealerTeam: number;
    /** 本局生效级牌 rawRank（= teams[dealerTeam].level） */
    levelRankActive: number;
    /** 是否为整场第一局（无贡牌） */
    isFirstRound: boolean;
    /** 上局头游座位；决定下局首出与贡牌 receiver */
    lastRoundWinnerSeat: number;
    /** 上局末游座位；决定贡牌 payer */
    lastRoundLoserSeat: number;
    /** 上局是否「双下」（头游+二游同队） */
    lastRoundDoubleDown: boolean;

    /** 手牌、发牌轨迹 */
    hands: number[][];
    dealTrace: { seat: number; card: number }[];
    /** 发牌随机种子（便于复现） */
    dealSeed: string;
    /** deal 阶段结束时刻（Unix ms）；非 deal 为 0 */
    dealEndAtMs: number;
    /** 首局：随机出的首打座位，仅在 phase=deal 且 isFirstRound 时有效 */
    pendingFirstPlaySeat: number;

    /** 贡/还 */
    tribute: GdTributeCtx;

    /** 出牌 */
    turn: number;
    /** 本局出完手牌的座位顺序（名次 1..N） */
    finishedOrder: number[];
    lastPattern: GdHandPattern | null;
    lastPlayer: number;
    lastPlayIds: number[];
    passes: number;

    /** 节奏 */
    seq: number;
    aiPlayDelayUntilMs: number;

    /** 整场结算：-1 未定；0/1 已毕业 */
    winnerTeam: number;

    /** 结算后四人是否已点「继续」；齐后开新局 */
    continueReady: boolean[];
    /** 座位是否开启「AI 托管」（真人席有效；与 isAiSeat 为真等效，由同一路 AI 决策） */
    aiDelegate: boolean[];

    /** 逻辑座位 0..3 → 头像 id（全桌一致） */
    seatCat: number[];

    errorLog: string[];

    /** 单次广播用：贡/还牌后供客户端飞牌动画；在 gdBroadcastState 打包后清空 */
    tributeEvent: { kind: "give" | "return"; from: number; to: number; card: number } | null;
}
