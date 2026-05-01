/**
 * 猫猫杀：状态结构、opcode、座位与错误发送。
 */

/** 服务端 → 客户端 */
const MK_OP_SNAPSHOT = 301;
const MK_OP_ERROR = 302;

const MK_REQ_PING = 50;
/** 出牌：{ hand_index, target_seat? } 杀需指定目标 */
const MK_REQ_PLAY_CARD = 52;
/** 对杀出闪：{ use: boolean, hand_index?: number } */
const MK_REQ_RESPOND_JINK = 53;
/** 结束出牌阶段 → 进入弃牌 */
const MK_REQ_END_PLAY = 54;
/** 弃牌：{ hand_indices: number[] } */
const MK_REQ_DISCARD = 55;
/** 濒死使用桃：{ hand_index } */
const MK_REQ_PEACH_DYING = 56;
/** 濒死跳过（不救） */
const MK_REQ_PASS_DYING = 57;
/** 抽取/确认身份（全员确认后发游戏牌） */
const MK_REQ_CONFIRM_IDENTITY = 58;
/** AI 托管：{ on: boolean } */
const MK_REQ_DELEGATE = 59;
/** 抽取/确认猫种（全员确认后发游戏牌） */
const MK_REQ_CONFIRM_BREED = 60;

type MkLobbyPhase = "waiting" | "lobby";
type MkPlayPhase = "picking_identity" | "playing" | "finished";
type MkPhase = MkLobbyPhase | MkPlayPhase;

type MkSubPhase = "play" | "discard";

type MkPending =
    | { kind: "jink"; attacker: number; victim: number; card_id: number }
    | { kind: "dying"; seat: number; askIdx: number; askOrder: number[] };

interface MkMatchState {
    label: string;
    seq: number;
    phase: MkPhase;
    /** 本局人数 5 或 8 */
    playerCount: number;
    expectHumans: number;
    aiCount: number;
    presences: { [userId: string]: nkruntime.Presence };
    seatUserIds: string[];
    isAiSeat: boolean[];
    identities: number[];
    /** 是否已「抽取」并确认身份（确认前不向该座位透露 self_role） */
    identityConfirmed: boolean[];
    /** 是否已「抽取」并确认猫种 */
    breedConfirmed: boolean[];
    /** 每座位猫种 stem（例如 breed_white / breed_ragdoll） */
    breeds: string[];
    /** 身份阶段中的步骤：先抽身份，再抽猫种 */
    pickStage: "identity" | "breed";
    /** 本局猫种抽取池（唯一，不重复） */
    breedPool: string[];
    breedPoolIdx: number;
    lordSeat: number;
    /** 装备区武器位（单人一件）；-1 表示空 */
    equippedWeapon: number[];
    /** 最近一次造成伤害的来源座位（用于独行猫斩杀判定） */
    lastDamageSourceSeat: number;
    alive: boolean[];
    hp: number[];
    maxHp: number[];
    hands: number[][];
    deck: number[];
    discard: number[];
    turnSeat: number;
    subPhase: MkSubPhase;
    shaUsedThisTurn: boolean;
    pending: MkPending | null;
    /** house | wild | lone | null */
    winner: string | null;
    /** AI 下次可行动时间（ms，与掼蛋 aiPlayDelayUntilMs 同思路） */
    aiPlayDelayUntilMs: number;
    /** 牌局战报（中文短句，快照带给客户端展示） */
    eventLog: string[];
    /** AI 托管（真人席）；与 isAiSeat 同为走 AI 决策 */
    aiDelegate: boolean[];
}

function mkInitialState(): MkMatchState {
    const hands: number[][] = [[], [], [], [], [], [], [], []];
    return {
        label: "meow_kill",
        seq: 0,
        phase: "waiting",
        playerCount: 5,
        expectHumans: 5,
        aiCount: 0,
        presences: {},
        seatUserIds: ["", "", "", "", "", "", "", ""],
        isAiSeat: [false, false, false, false, false, false, false, false],
        identities: [0, 0, 0, 0, 0, 0, 0, 0],
        identityConfirmed: [false, false, false, false, false, false, false, false],
        breedConfirmed: [false, false, false, false, false, false, false, false],
        breeds: ["", "", "", "", "", "", "", ""],
        pickStage: "identity",
        breedPool: [],
        breedPoolIdx: 0,
        lordSeat: -1,
        equippedWeapon: [-1, -1, -1, -1, -1, -1, -1, -1],
        lastDamageSourceSeat: -1,
        alive: [true, true, true, true, true, false, false, false],
        hp: [4, 4, 4, 4, 4, 0, 0, 0],
        maxHp: [4, 4, 4, 4, 4, 0, 0, 0],
        hands: hands,
        deck: [],
        discard: [],
        turnSeat: -1,
        subPhase: "play",
        shaUsedThisTurn: false,
        pending: null,
        winner: null,
        aiPlayDelayUntilMs: 0,
        eventLog: [],
        aiDelegate: [false, false, false, false, false, false, false, false],
    };
}

/**
 * Nakama 每 tick 将 match state 经 JSON 再注入 goja 时，嵌套的 hands 行有时不是可原地变长的 Array，
 * 对 st.hands[s].push 可能不写入最终持久化对象（表现为 deck 已 pop 但 hand_total 仍为 0）。
 * 在 matchLoop 开头把八行手牌拷贝为普通 number[]。
 */
function mkRepairHandsForRuntime(st: MkMatchState): void {
    const fresh: number[][] = [[], [], [], [], [], [], [], []];
    for (let s = 0; s < 8; s++) {
        const h = st.hands[s] as unknown;
        if (h == null) {
            continue;
        }
        const row = h as { length?: number; [i: number]: unknown };
        const len = typeof row.length === "number" ? row.length : 0;
        for (let i = 0; i < len; i++) {
            fresh[s].push(Math.floor(Number(row[i])));
        }
    }
    st.hands = fresh;
}

/** 是否存在阻塞出牌/结束阶段的询问（闪、濒死）。空对象 {} 在 JSON 回灌后可能被当成 truthy，不得视为有效 pending。 */
function mkPendingIsActive(st: MkMatchState): boolean {
    const p = st.pending as unknown;
    if (p === null || p === undefined) {
        return false;
    }
    if (typeof p !== "object") {
        return false;
    }
    const o = p as { kind?: unknown };
    if (o.kind === "jink" || o.kind === "dying") {
        return true;
    }
    return false;
}

/** 每 tick 清理无效的 pending，避免 AI/人类被卡死。 */
function mkSanitizePending(st: MkMatchState): void {
    const p = st.pending as unknown;
    if (p === null || p === undefined) {
        st.pending = null;
        return;
    }
    if (typeof p !== "object") {
        st.pending = null;
        return;
    }
    const o = p as { kind?: unknown };
    if (o.kind !== "jink" && o.kind !== "dying") {
        st.pending = null;
        return;
    }
    if (o.kind === "jink") {
        const j = p as { attacker?: unknown; victim?: unknown };
        if (typeof j.attacker !== "number" || typeof j.victim !== "number") {
            st.pending = null;
        }
        return;
    }
    const d = p as { seat?: unknown; askIdx?: unknown; askOrder?: unknown };
    if (typeof d.seat !== "number" || typeof d.askIdx !== "number" || !Array.isArray(d.askOrder)) {
        st.pending = null;
    }
}

function mkRepairMkAuxFields(st: MkMatchState): void {
    if (typeof st.aiPlayDelayUntilMs !== "number" || isNaN(st.aiPlayDelayUntilMs)) {
        st.aiPlayDelayUntilMs = 0;
    }
    if (!st.eventLog || !Array.isArray(st.eventLog)) {
        st.eventLog = [];
    }
    if (!st.equippedWeapon || !Array.isArray(st.equippedWeapon)) {
        st.equippedWeapon = [-1, -1, -1, -1, -1, -1, -1, -1];
    } else {
        while (st.equippedWeapon.length < 8) {
            st.equippedWeapon.push(-1);
        }
    }
    if (typeof st.lastDamageSourceSeat !== "number" || isNaN(st.lastDamageSourceSeat)) {
        st.lastDamageSourceSeat = -1;
    }
    if (!st.aiDelegate || !Array.isArray(st.aiDelegate)) {
        st.aiDelegate = [false, false, false, false, false, false, false, false];
    } else {
        while (st.aiDelegate.length < 8) {
            st.aiDelegate.push(false);
        }
    }
    if (!st.breedConfirmed || !Array.isArray(st.breedConfirmed)) {
        st.breedConfirmed = [false, false, false, false, false, false, false, false];
    } else {
        while (st.breedConfirmed.length < 8) {
            st.breedConfirmed.push(false);
        }
    }
    if (!st.breeds || !Array.isArray(st.breeds)) {
        st.breeds = ["", "", "", "", "", "", "", ""];
    } else {
        while (st.breeds.length < 8) {
            st.breeds.push("");
        }
    }
    if (st.pickStage !== "identity" && st.pickStage !== "breed") {
        st.pickStage = "identity";
    }
    if (!st.breedPool || !Array.isArray(st.breedPool)) {
        st.breedPool = [];
    }
    if (typeof st.breedPoolIdx !== "number" || isNaN(st.breedPoolIdx)) {
        st.breedPoolIdx = 0;
    }
}

function mkConfigureTableSize(st: MkMatchState, n: number): void {
    st.playerCount = n === 8 ? 8 : 5;
    for (let s = 0; s < 8; s++) {
        if (s < st.playerCount) {
            st.alive[s] = true;
            st.hp[s] = 4;
            st.maxHp[s] = 4;
            st.hands[s] = [];
            st.equippedWeapon[s] = -1;
            st.identityConfirmed[s] = false;
            st.breedConfirmed[s] = false;
            st.breeds[s] = "";
            st.aiDelegate[s] = false;
        } else {
            st.alive[s] = false;
            st.hp[s] = 0;
            st.maxHp[s] = 0;
            st.hands[s] = [];
            st.seatUserIds[s] = "";
            st.isAiSeat[s] = false;
            st.identityConfirmed[s] = false;
            st.breedConfirmed[s] = false;
            st.breeds[s] = "";
            st.aiDelegate[s] = false;
        }
    }
}

/** 真人占 0..expectHumans-1；expectHumans..playerCount-1 为 AI */
function mkAssignSeats(st: MkMatchState): void {
    const ids: string[] = [];
    for (const k in st.presences) {
        if (st.presences.hasOwnProperty(k)) {
            ids.push(k);
        }
    }
    ids.sort();
    const eh = Math.max(0, Math.min(st.playerCount, st.expectHumans));
    for (let s = 0; s < 8; s++) {
        st.seatUserIds[s] = "";
        st.isAiSeat[s] = false;
    }
    for (let i = 0; i < ids.length && i < eh; i++) {
        st.seatUserIds[i] = ids[i];
    }
    for (let s = eh; s < st.playerCount; s++) {
        st.isAiSeat[s] = true;
    }
}

function mkSendError(
    dispatcher: nkruntime.MatchDispatcher,
    logger: nkruntime.Logger,
    st: MkMatchState,
    presence: nkruntime.Presence,
    code: string
): void {
    try {
        dispatcher.broadcastMessage(
            MK_OP_ERROR,
            JSON.stringify({ seq: st.seq, error: code }),
            [presence],
            null
        );
    } catch (e) {
        logger.error("meow_kill send err: %s", String(e));
    }
}

function mkSeatForUser(st: MkMatchState, userId: string): number {
    for (let s = 0; s < st.playerCount; s++) {
        if (st.seatUserIds[s] === userId) {
            return s;
        }
    }
    return -1;
}

function mkDecodeMatchData(data: ArrayBuffer | string | null | undefined): string {
    if (data === null || data === undefined) {
        return "";
    }
    if (typeof data === "string") {
        return data;
    }
    const ab = data as ArrayBuffer;
    if (typeof TextDecoder !== "undefined") {
        try {
            return new TextDecoder("utf-8").decode(ab);
        } catch (e) {
            // fall through
        }
    }
    const u8 = new Uint8Array(ab);
    let s = "";
    for (let i = 0; i < u8.length; i++) {
        s += String.fromCharCode(u8[i]);
    }
    return s;
}
