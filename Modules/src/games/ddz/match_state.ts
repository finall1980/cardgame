/** 牌型，与 ddz_rules.gd Kind 枚举顺序一致 */
const DDZ_KIND_INVALID = 0;
const DDZ_KIND_PASS = 1;
const DDZ_KIND_SINGLE = 2;
const DDZ_KIND_PAIR = 3;
const DDZ_KIND_TRIPLE = 4;
const DDZ_KIND_STRAIGHT = 5;
const DDZ_KIND_BOMB = 6;
const DDZ_KIND_ROCKET = 7;
const DDZ_KIND_TRIPLE_WITH_SINGLE = 8;
const DDZ_KIND_TRIPLE_WITH_PAIR = 9;
const DDZ_KIND_PAIR_STRAIGHT = 10;
const DDZ_KIND_FOUR_WITH_TWO = 11;
const DDZ_KIND_PLANE = 12;
const DDZ_KIND_PLANE_WITH_WINGS = 13;

/**
 * 与 Godot 客户端 `MATCH_OP_*`（1/2/3）错开，避免与旧 relay 快照混淆。
 * 权威斗地主专用：101 公共快照、102 错误、120 结算。
 */
const DDZ_OP_SNAPSHOT = 101;
const DDZ_OP_ERROR = 102;
const DDZ_OP_SETTLEMENT = 120;

/** 叫牌/抢地主：AI 连动、matchLoop 自动推进「跳过抢」与真人操作后的节奏（与出牌 AI 链式延迟同量级） */
const AI_BID_ROB_PACE_MS = 1350;
/** 新一局发牌后：给客户端播轨迹+停顿留出时间，再允许 AI 叫牌（约 51×40ms + 1s ≈ 3s） */
const AI_NEW_ROUND_BID_DELAY_MS = 3000;

/** 客户端请求（将来）：叫分 10、抢地主 11、出牌 12、过 13 */
const DDZ_REQ_BID = 10;
const DDZ_REQ_ROB = 11;
const DDZ_REQ_PLAY = 12;
const DDZ_REQ_PASS = 13;
const DDZ_REQ_CONTINUE = 14;
/** 客户端发送聊天文字；服务端原样广播给 Match 内全员 */

const DDZ_CARD_COUNT = 54;

interface DdzHandPattern {
    kind: number;
    main: number;
    extra: number | null;
}

type Phase =
    | "waiting"
    | "deal"
    | "bidding_call"
    | "bidding_rob"
    | "play"
    | "finished";

interface DdzMatchState {
    presences: { [userId: string]: nkruntime.Presence };
    /** 加入顺序映射到 0..2 座位 */
    seatByUserId: { [userId: string]: number };
    /** 本局真人席位数（1–3）；其余为服务端 AI） */
    expectHumans: number;
    aiCount: number;
    /** 座位 0..2 是否为 AI（无 Nakama presence） */
    isAiSeat: boolean[];
    phase: Phase;
    hands: number[][];
    bottom: number[];
    bids: number[];
    /** 叫分阶段最高叫分者（用于抢地主起点） */
    callCandidate: number;
    /** 抢地主从 callCandidate 下家开始第 step 步（0..2） */
    robStep: number;
    landlord: number;
    turn: number;
    lastPattern: DdzHandPattern | null;
    lastPlayer: number;
    passes: number;
    winner: number;
    multBase: number;
    multRob: number;
    multPlay: number;
    robCount: number;
    playBombCount: number;
    playRocketCount: number;
    lastRobber: number;
    lastPlayIds: number[];
    dealSeed: string;
    seq: number;
    /** 叫分轮当前应答应座位 */
    awaitSeat: number;
    /** 本局叫地主首轮从该座位开始（随机 0～2），与 awaitSeat 开局一致 */
    callRoundStartSeat: number;
    /** 抢地主：每次抢/不抢动作单调递增，供客户端播气泡 */
    robActionSeq: number;
    lastRobActionSeat: number;
    lastRobActionWasRob: boolean;
    /** 抢地主轮次因「叫牌阶段未叫」被自动跳过（与主动选「不抢」区分，供气泡） */
    lastRobSkippedNoBid: boolean;
    /** 是否有人叫过分（用于抢地主「不叫不可抢」） */
    bidPassFlags: boolean[];
    errorLog: string[];
    /** 结算后三人是否已点「继续」；人满后 resetRound 开新一局 */
    continueReady: boolean[];
    /** 逻辑座位 0..2 → 猫咪角色 id 0..2（全桌一致，勿各端本地 shuffle） */
    seatCat: number[];
    /** 出牌节奏：真人出过牌后 AI 须等；AI 连出时亦须间隔，避免客户端动画重叠 */
    aiPlayDelayUntilMs: number;
    /** 合并进地主手牌前的三张底牌 id，出牌阶段供全桌翻开展示 */
    bottomRevealIds: number[];
    /** 与客户端 Deck.deal_doudizhu_with_trace 一致：第 i 张发到座位 i%3，便于播发牌动画 */
    dealTrace: { seat: number; card: number }[];
    /** 服务端权威记牌：本局累计已打出的各点数（索引 0..14，含双王）张数，AI 决策用。 */
    seenCount: number[];
}
