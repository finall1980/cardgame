/**
 * 掼蛋 Match Handler（Nakama MatchHandler 契约）。
 * 与 ddz 同样走「全员加满 → resetRound → 广播快照」的流程；AI 由 ai_server 推动。
 */

function gdMatchInit(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    params: { [key: string]: string }
): { state: nkruntime.MatchState; tickRate: number; label: string } {
    logger.info("guandan matchInit: params=%s", JSON.stringify(params));
    const st = gdInitialState();
    if (params["expect_humans"]) {
        st.expectHumans = parseInt(params["expect_humans"], 10);
    }
    if (params["ai"]) {
        st.aiCount = parseInt(params["ai"], 10);
    }
    if (st.expectHumans + st.aiCount !== 4) {
        logger.warn("guandan matchInit: expect_humans+ai!=4, clamping ai");
        st.aiCount = 4 - st.expectHumans;
    }
    return {
        state: st as unknown as nkruntime.MatchState,
        tickRate: 5,
        label: "guandan",
    };
}

function gdMatchJoinAttempt(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    presence: nkruntime.Presence,
    metadata: { [key: string]: any }
): { state: nkruntime.MatchState; accept: boolean; rejectMessage?: string } | null {
    const st = state as unknown as GdMatchState;
    const n = Object.keys(st.presences).length;
    if (n >= st.expectHumans) {
        logger.warn(
            "guandan matchJoinAttempt REJECT full: userId=%s current=%d expectHumans=%d",
            presence.userId,
            n,
            st.expectHumans
        );
        return { state: state, accept: false, rejectMessage: "full" };
    }
    return { state: state, accept: true };
}

function gdMatchJoin(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    presences: nkruntime.Presence[]
): { state: nkruntime.MatchState } | null {
    const st = state as unknown as GdMatchState;
    for (let i = 0; i < presences.length; i++) {
        const p = presences[i];
        st.presences[p.userId] = p;
    }
    gdAssignSeats(st);
    const n = Object.keys(st.presences).length;
    logger.info("guandan matchJoin: total=%d phase=%s", n, st.phase);
    if (n === st.expectHumans && st.phase === "waiting") {
        gdAssignSeatCats(st, nk);
        // 随机庄家队
        st.dealerTeam = randomIntBelow(nk, 2);
        gdResetRound(st, nk);
        gdBroadcastState(dispatcher, st, logger, "join-after-resetRound");
    } else {
        gdBroadcastState(dispatcher, st, logger, "join");
    }
    return { state: st as unknown as nkruntime.MatchState };
}

function gdMatchLeave(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    presences: nkruntime.Presence[]
): { state: nkruntime.MatchState } | null {
    const st = state as unknown as GdMatchState;
    for (let i = 0; i < presences.length; i++) {
        delete st.presences[presences[i].userId];
    }
    gdAssignSeats(st);
    return { state: st as unknown as nkruntime.MatchState };
}

/** 解码 Match 消息（同 ddz 的实现，避免 String(ArrayBuffer) 得到 "[object ArrayBuffer]"） */
function gdDecodeMatchData(data: ArrayBuffer | string | null | undefined): string {
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

function gdSendError(
    dispatcher: nkruntime.MatchDispatcher,
    logger: nkruntime.Logger,
    st: GdMatchState,
    presence: nkruntime.Presence,
    seat: number,
    code: string
): void {
    try {
        dispatcher.broadcastMessage(
            GD_OP_ERROR,
            JSON.stringify({ seq: st.seq, seat: seat, error: code }),
            [presence],
            null
        );
    } catch (e) {
        logger.error("guandan send err: %s", String(e));
    }
}

function gdMatchLoop(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    messages: nkruntime.MatchMessage[]
): { state: nkruntime.MatchState } | null {
    const st = state as unknown as GdMatchState;

    for (let m = 0; m < messages.length; m++) {
        const msg = messages[m];
        const senderId = msg.sender.userId;
        const seat = gdSeatForUser(st, senderId);
        if (seat < 0) {
            logger.warn("guandan matchLoop: unknown sender=%s", senderId);
            continue;
        }
        let payload: { ids?: number[]; id?: number; on?: boolean };
        const rawJson = gdDecodeMatchData(msg.data as ArrayBuffer | string);
        try {
            payload = rawJson.length > 0 ? (JSON.parse(rawJson) as { ids?: number[]; id?: number; on?: boolean }) : {};
        } catch (e) {
            logger.warn("guandan matchLoop: bad json op=%d seat=%d", msg.opCode, seat);
            continue;
        }
        let err: string | null = null;
        if (msg.opCode === GD_REQ_PLAY) {
            const cards = payload.ids || [];
            err = gdApplyPlay(st, seat, cards);
            if (!err) {
                st.aiPlayDelayUntilMs = Date.now() + GD_AI_PLAY_PACE_MS;
            }
        } else if (msg.opCode === GD_REQ_PASS) {
            err = gdApplyPass(st, seat);
            if (!err) {
                st.aiPlayDelayUntilMs = Date.now() + GD_AI_PLAY_PACE_MS;
            }
        } else if (msg.opCode === GD_REQ_TRIBUTE) {
            const cid = typeof payload.id === "number" ? payload.id : -1;
            err = gdApplyTribute(st, seat, cid);
        } else if (msg.opCode === GD_REQ_TRIBUTE_RESIST) {
            err = gdApplyTributeResist(st, seat);
        } else if (msg.opCode === GD_REQ_RETURN) {
            const cid = typeof payload.id === "number" ? payload.id : -1;
            err = gdApplyReturn(st, seat, cid);
        } else if (msg.opCode === GD_REQ_CONTINUE) {
            err = gdApplyContinue(st, seat, nk);
        } else if (msg.opCode === GD_REQ_DELEGATE) {
            const on = payload.on === true;
            err = gdApplyDelegate(st, seat, on);
        } else if (msg.opCode === GD_REQ_HINT) {
            if (st.phase !== "play" || st.turn !== seat) {
                gdSendError(dispatcher, logger, st, msg.sender, seat, "hint_bad_phase");
                continue;
            }
            const pick = gdAiPickPlay(st, seat);
            try {
                dispatcher.broadcastMessage(
                    GD_OP_HINT,
                    JSON.stringify({ v: 1, pass: pick.pass, ids: pick.ids || [] }),
                    [msg.sender],
                    null
                );
            } catch (e) {
                logger.warn("guandan hint: %s", String(e));
            }
            continue;
        } else {
            // 未知 op：忽略
            continue;
        }
        if (err) {
            gdSendError(dispatcher, logger, st, msg.sender, seat, err);
        } else {
            gdBroadcastState(dispatcher, st, logger, "matchLoop");
            if (st.phase === "finished") {
                const deltas = gdComputeScoreDeltas(st);
                const settlement = JSON.stringify({
                    v: 1,
                    finished_order: st.finishedOrder.slice(),
                    winner_team: st.winnerTeam,
                    levels: [st.teams[0].level, st.teams[1].level],
                    score_delta: deltas,
                });
                try {
                    dispatcher.broadcastMessage(GD_OP_SETTLEMENT, settlement, null, null);
                } catch (e) {
                    logger.warn("guandan settlement broadcast: %s", String(e));
                }
            }
        }
    }

    if (gdTryAdvanceDealPhase(st, nk)) {
        gdBroadcastState(dispatcher, st, logger, "dealElapsed");
    }

    gdRunAiUntilHumanOrDone(st, dispatcher, logger, nk);

    return { state: st as unknown as nkruntime.MatchState };
}

function gdMatchTerminate(
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

function gdMatchSignal(
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

const guandanMatchHandler: nkruntime.MatchHandler<nkruntime.MatchState> = {
    matchInit: gdMatchInit,
    matchJoinAttempt: gdMatchJoinAttempt,
    matchJoin: gdMatchJoin,
    matchLeave: gdMatchLeave,
    matchLoop: gdMatchLoop,
    matchTerminate: gdMatchTerminate,
    matchSignal: gdMatchSignal,
};
