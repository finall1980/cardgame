/**
 * 猫猫杀 Match Handler：进满 → 直接开局；回合与 AI 在 matchLoop 推进。
 */

function mkMatchInit(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    params: { [key: string]: string }
): { state: nkruntime.MatchState; tickRate: number; label: string } {
    logger.info("meow_kill matchInit: params=%s", JSON.stringify(params));
    const st = mkInitialState();
    let pc = 5;
    if (params["player_count"]) {
        const n = parseInt(params["player_count"], 10);
        pc = n === 8 ? 8 : 5;
    }
    mkConfigureTableSize(st, pc);
    if (params["expect_humans"]) {
        st.expectHumans = parseInt(params["expect_humans"], 10);
    }
    if (params["ai"]) {
        st.aiCount = parseInt(params["ai"], 10);
    }
    if (st.expectHumans + st.aiCount !== st.playerCount) {
        logger.warn("meow_kill matchInit: expect_humans+ai!=playerCount, clamping ai");
        st.aiCount = Math.max(0, st.playerCount - st.expectHumans);
    }
    if (st.expectHumans > st.playerCount) {
        st.expectHumans = st.playerCount;
    }
    return {
        state: st as unknown as nkruntime.MatchState,
        tickRate: 5,
        label: "meow_kill",
    };
}

function mkMatchJoinAttempt(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    presence: nkruntime.Presence,
    metadata: { [key: string]: any }
): { state: nkruntime.MatchState; accept: boolean; rejectMessage?: string } | null {
    const st = state as unknown as MkMatchState;
    const n = Object.keys(st.presences).length;
    if (n >= st.expectHumans) {
        logger.warn(
            "meow_kill matchJoinAttempt REJECT full: userId=%s current=%d expectHumans=%d",
            presence.userId,
            n,
            st.expectHumans
        );
        return { state: state, accept: false, rejectMessage: "full" };
    }
    return { state: state, accept: true };
}

function mkMatchJoin(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    presences: nkruntime.Presence[]
): { state: nkruntime.MatchState } | null {
    const st = state as unknown as MkMatchState;
    mkRepairHandsForRuntime(st);
    mkSanitizePending(st);
    for (let i = 0; i < presences.length; i++) {
        const p = presences[i];
        st.presences[p.userId] = p;
    }
    mkAssignSeats(st);
    const n = Object.keys(st.presences).length;
    logger.info("meow_kill matchJoin: humans=%d/%d phase=%s", n, st.expectHumans, st.phase);
    if (n === st.expectHumans && st.phase === "waiting") {
        st.phase = "lobby";
        mkBeginIdentityPhase(st, nk, dispatcher, logger);
    } else {
        mkBroadcastState(dispatcher, st, logger, "join");
    }
    return { state: st as unknown as nkruntime.MatchState };
}

function mkMatchLeave(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    presences: nkruntime.Presence[]
): { state: nkruntime.MatchState } | null {
    const st = state as unknown as MkMatchState;
    mkRepairHandsForRuntime(st);
    mkSanitizePending(st);
    for (let i = 0; i < presences.length; i++) {
        delete st.presences[presences[i].userId];
    }
    mkAssignSeats(st);
    if (Object.keys(st.presences).length < st.expectHumans) {
        st.phase = "waiting";
        mkResetMatchGame(st);
    }
    mkBroadcastState(dispatcher, st, logger, "leave");
    return { state: st as unknown as nkruntime.MatchState };
}

function mkMatchLoop(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: nkruntime.MatchState,
    messages: nkruntime.MatchMessage[]
): { state: nkruntime.MatchState } | null {
    const st = state as unknown as MkMatchState;
    mkRepairHandsForRuntime(st);
    mkSanitizePending(st);
    mkRepairMkAuxFields(st);
    for (let m = 0; m < messages.length; m++) {
        const msg = messages[m];
        const seat = mkSeatForUser(st, msg.sender.userId);
        if (seat < 0) {
            logger.warn("meow_kill matchLoop: unknown sender=%s", msg.sender.userId);
            continue;
        }
        if (msg.opCode === MK_REQ_PING) {
            continue;
        }

        const rawStr = mkDecodeMatchData(msg.data as ArrayBuffer | string);

        if (msg.opCode === MK_REQ_DELEGATE) {
            let payload: { [k: string]: any } = {};
            try {
                payload = rawStr.length > 0 ? (JSON.parse(rawStr) as { [k: string]: any }) : {};
            } catch (e) {
                mkSendError(dispatcher, logger, st, msg.sender, "bad_json");
                continue;
            }
            const err = mkApplyDelegate(st, seat, payload.on === true);
            if (err) {
                mkSendError(dispatcher, logger, st, msg.sender, err);
            } else {
                mkBroadcastState(dispatcher, st, logger, "delegate");
                if (st.phase === "picking_identity") {
                    mkTryAdvanceFromIdentityPhase(st, nk, dispatcher, logger);
                }
            }
            continue;
        }

        if (st.aiDelegate[seat] && !st.isAiSeat[seat]) {
            mkSendError(dispatcher, logger, st, msg.sender, "delegated_no_manual");
            continue;
        }

        if (st.phase === "picking_identity") {
            if (msg.opCode === MK_REQ_CONFIRM_IDENTITY || msg.opCode === MK_REQ_CONFIRM_BREED) {
                const rawId = rawStr;
                const err = mkHandleGameMessage(st, seat, msg.opCode, rawId, nk, dispatcher, logger);
                if (err) {
                    mkSendError(dispatcher, logger, st, msg.sender, err);
                } else {
                    mkBroadcastState(dispatcher, st, logger, "pick-confirm");
                    mkTryAdvanceFromIdentityPhase(st, nk, dispatcher, logger);
                }
            }
            continue;
        }
        if (st.phase === "playing" && !st.winner) {
            const rawJson = rawStr;
            const err = mkHandleGameMessage(st, seat, msg.opCode, rawJson, nk, dispatcher, logger);
            if (err) {
                mkSendError(dispatcher, logger, st, msg.sender, err);
            } else {
                mkBroadcastState(dispatcher, st, logger, "action");
                mkBumpPlayPaceDeadline(st);
            }
        }
    }
    if (st.phase === "picking_identity") {
        const aiChangedIdentity = mkConfirmAllAiIdentities(st);
        const aiChangedBreed = mkConfirmAllAiBreeds(st);
        mkTryAdvanceFromIdentityPhase(st, nk, dispatcher, logger);
        if (st.phase === "picking_identity" && (aiChangedIdentity || aiChangedBreed)) {
            mkBroadcastState(dispatcher, st, logger, "ai-pick");
        }
        return { state: st as unknown as nkruntime.MatchState };
    }
    if (st.phase === "playing" && !st.winner) {
        mkRunMeowAi(st, nk, dispatcher, logger);
    }
    return { state: st as unknown as nkruntime.MatchState };
}

function mkMatchTerminate(
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

function mkMatchSignal(
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

const meowKillMatchHandler: nkruntime.MatchHandler<nkruntime.MatchState> = {
    matchInit: mkMatchInit,
    matchJoinAttempt: mkMatchJoinAttempt,
    matchJoin: mkMatchJoin,
    matchLeave: mkMatchLeave,
    matchLoop: mkMatchLoop,
    matchTerminate: mkMatchTerminate,
    matchSignal: mkMatchSignal,
};
