function ddzMatchInit(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    params: { [key: string]: string }
): { state: nkruntime.MatchState; tickRate: number; label: string } {
    logger.info("ddz matchInit: params=%s", JSON.stringify(params));
    const st: DdzMatchState = initialState();
    if (params["expect_humans"]) {
        st.expectHumans = parseInt(params["expect_humans"], 10);
    }
    if (params["ai"]) {
        st.aiCount = parseInt(params["ai"], 10);
    }
    if (st.expectHumans + st.aiCount !== 3) {
        logger.warn("ddz matchInit: expect_humans+ai!=3, clamping ai");
        st.aiCount = 3 - st.expectHumans;
    }
    return {
        state: st as unknown as nkruntime.MatchState,
        tickRate: 10,
        label: "ddz",
    };
}

function ddzMatchJoinAttempt(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    presence: nkruntime.Presence,
    metadata: { [key: string]: any }
): { state: nkruntime.MatchState; accept: boolean; rejectMessage?: string } | null {
    const st = state as unknown as DdzMatchState;
    const n = Object.keys(st.presences).length;
    if (n >= st.expectHumans) {
        logger.warn(
            "ddz matchJoinAttempt REJECT full: userId=%s username=%s currentCount=%d expectHumans=%d",
            presence.userId,
            presence.username,
            n,
            st.expectHumans
        );
        return { state: state, accept: false, rejectMessage: "full" };
    }
    logger.info(
        "ddz matchJoinAttempt accept: userId=%s username=%s sessionId=%s currentCount=%d->%d",
        presence.userId,
        presence.username,
        presence.sessionId,
        n,
        n + 1
    );
    return { state: state, accept: true };
}

function ddzMatchJoin(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    presences: nkruntime.Presence[]
): { state: nkruntime.MatchState } | null {
    const st = state as unknown as DdzMatchState;
    const joinedIds: string[] = [];
    for (let i = 0; i < presences.length; i++) {
        const p = presences[i];
        st.presences[p.userId] = p;
        joinedIds.push(p.userId);
    }
    assignSeats(st);
    const n = Object.keys(st.presences).length;
    logger.info(
        "ddz matchJoin: tick=%d joinedThisBatch=%s totalPlayers=%d phaseBefore=%s seatByUserId=%s",
        tick,
        JSON.stringify(joinedIds),
        n,
        st.phase,
        JSON.stringify(st.seatByUserId)
    );
    if (n === st.expectHumans && st.phase === "waiting") {
        assignSeatCats(st, nk);
        resetRound(st, nk);
        logger.info("ddz matchJoin: resetRound done -> phase=%s dealSeed len=%d", st.phase, st.dealSeed.length);
        broadcastState(dispatcher, st, logger, "join-after-resetRound");
    } else {
        broadcastState(dispatcher, st, logger, "join");
    }
    return { state: st as unknown as nkruntime.MatchState };
}

/**
 * Nakama `MatchMessage.data` 类型为 ArrayBuffer（见 nakama-runtime index.d.ts）。
 * 使用 String(msg.data) 会得到 "[object ArrayBuffer]"，JSON.parse 失败且被 catch 吃掉 → 叫牌/出牌等全部不生效。
 */
function decodeMatchData(data: ArrayBuffer | string | null | undefined): string {
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
    /** Nakama/goja 等运行时未必有 globalThis / Buffer，避免 ReferenceError */
    let s = "";
    for (let i = 0; i < u8.length; i++) {
        s += String.fromCharCode(u8[i]);
    }
    return s;
}

function ddzMatchLeave(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    presences: nkruntime.Presence[]
): { state: nkruntime.MatchState } | null {
    const st = state as unknown as DdzMatchState;
    for (let i = 0; i < presences.length; i++) {
        delete st.presences[presences[i].userId];
    }
    assignSeats(st);
    return { state: st as unknown as nkruntime.MatchState };
}

function ddzMatchLoop(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    messages: nkruntime.MatchMessage[]
): { state: nkruntime.MatchState } | null {
    const st = state as unknown as DdzMatchState;
    /** 与 games/ddz/ai_server 中 AI 连动共用 aiPlayDelayUntilMs，避免 matchLoop 每 100ms 连推抢地主跳过 */
    if (st.phase === "bidding_rob") {
        if (Date.now() >= st.aiPlayDelayUntilMs && autoAdvanceRob(st)) {
            broadcastState(dispatcher, st, logger, "autoAdvanceRob");
            st.aiPlayDelayUntilMs = Date.now() + AI_BID_ROB_PACE_MS;
        }
    }
    for (let m = 0; m < messages.length; m++) {
        const msg = messages[m];
        const senderId = msg.sender.userId;
        const seat = seatForUser(st, senderId);
        if (seat < 0) {
            logger.warn(
                "ddz matchLoop: unknown sender userId=%s keys=%s",
                senderId,
                JSON.stringify(Object.keys(st.seatByUserId))
            );
            continue;
        }
        let payload: { t?: string; bid?: number; rob?: boolean; cards?: number[]; text?: string };
        const rawJson = decodeMatchData(msg.data as ArrayBuffer | string);
        try {
            payload = JSON.parse(rawJson) as {
                t?: string;
                bid?: number;
                rob?: boolean;
                cards?: number[];
                text?: string;
            };
        } catch (e) {
            logger.warn(
                "ddz matchLoop: JSON.parse failed op=%d seat=%d err=%s raw=%s",
                msg.opCode,
                seat,
                String(e),
                rawJson.length > 120 ? rawJson.substring(0, 120) + "…" : rawJson
            );
            continue;
        }
        let err: string | null = null;
        if (msg.opCode === DDZ_REQ_BID) {
            const rawBid = payload.bid;
            let bidNum = -1;
            if (rawBid !== undefined && rawBid !== null) {
                if (typeof rawBid === "string") {
                    bidNum = parseInt(String(rawBid), 10);
                } else {
                    bidNum = Number(rawBid);
                }
            }
            if (!Number.isFinite(bidNum)) {
                bidNum = -1;
            }
            err = applyBid(st, seat, bidNum, nk);
            if (!err && !st.isAiSeat[seat]) {
                st.aiPlayDelayUntilMs = Date.now() + AI_BID_ROB_PACE_MS;
            }
        } else if (msg.opCode === DDZ_REQ_ROB) {
            err = applyRob(st, seat, Boolean(payload.rob));
            if (!err && !st.isAiSeat[seat]) {
                st.aiPlayDelayUntilMs = Date.now() + AI_BID_ROB_PACE_MS;
            }
        } else if (msg.opCode === DDZ_REQ_PLAY) {
            const cards = payload.cards || [];
            err = applyPlay(st, seat, cards);
            if (!err && !st.isAiSeat[seat]) {
                st.aiPlayDelayUntilMs = Date.now() + AI_BID_ROB_PACE_MS;
            }
        } else if (msg.opCode === DDZ_REQ_PASS) {
            err = applyPass(st, seat);
            if (!err && !st.isAiSeat[seat]) {
                st.aiPlayDelayUntilMs = Date.now() + AI_BID_ROB_PACE_MS;
            }
        } else if (msg.opCode === DDZ_REQ_CONTINUE) {
            err = applyContinue(st, seat, nk);
        }
        if (err) {
            try {
                dispatcher.broadcastMessage(
                    DDZ_OP_ERROR,
                    JSON.stringify({ seq: st.seq, seat: seat, error: err }),
                    [msg.sender],
                    null
                );
            } catch (e2) {
                logger.error("send err: %v", String(e2));
            }
        } else {
            broadcastState(dispatcher, st, logger, "matchLoop");
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
                dispatcher.broadcastMessage(DDZ_OP_SETTLEMENT, settlement, null, null);
            }
        }
    }
    maybeAutoContinueWithAi(st, dispatcher, logger, nk);
    runAiUntilHumanOrDone(st, dispatcher, logger, nk);
    return { state: st as unknown as nkruntime.MatchState };
}

function ddzMatchTerminate(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    graceSeconds: number
): { state: nkruntime.MatchState } | null {
    return { state: state };
}

function ddzMatchSignal(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    data: string
): { state: nkruntime.MatchState; data?: string } | null {
    return { state: state, data: "ok" };
}

const ddzMatchHandler: nkruntime.MatchHandler<nkruntime.MatchState> = {
    matchInit: ddzMatchInit,
    matchJoinAttempt: ddzMatchJoinAttempt,
    matchJoin: ddzMatchJoin,
    matchLeave: ddzMatchLeave,
    matchLoop: ddzMatchLoop,
    matchTerminate: ddzMatchTerminate,
    matchSignal: ddzMatchSignal,
};

function ddzMatchmakerMatched(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    matches: nkruntime.MatchmakerResult[]
): string | void {
    logger.info("ddz matchmakerMatched: callback invoked, resultCount=%d", matches.length);
    for (let i = 0; i < matches.length; i++) {
        const row = matches[i];
        logger.info(
            "  ddz matchmakerMatched[%d]: userId=%s username=%s sessionId=%s partyId=%s props=%s",
            i,
            row.presence.userId,
            row.presence.username,
            row.presence.sessionId,
            row.partyId !== undefined ? row.partyId : "",
            JSON.stringify(row.properties)
        );
    }
    if (matches.length === 0) {
        logger.error("ddz matchmakerMatched: empty matches array — will not call matchCreate (clients get no match id)");
        return;
    }
    if (matches.length !== 3) {
        logger.warn(
            "ddz matchmakerMatched: expected 3 players for ddz, got %d — matchCreate may still run",
            matches.length
        );
    }
    try {
        logger.info("ddz matchmakerMatched: calling nk.matchCreate(\"ddz\", {expect_humans:3}) ...");
        const id = nk.matchCreate("ddz", { expect_humans: "3", ai: "0" });
        if (!id || String(id).length === 0) {
            logger.error("ddz matchmakerMatched: nk.matchCreate returned empty id");
            return;
        }
        logger.info("ddz matchmakerMatched: success match_id=%s for %d players", id, matches.length);
        return id;
    } catch (e) {
        logger.error("ddz matchmakerMatched: nk.matchCreate threw: %s", String(e));
        return;
    }
}
