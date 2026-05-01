function roundMultiplier(s: DdzMatchState): number {
    return s.multBase * s.multRob * s.multPlay;
}

function removeCardsFromHand(hand: number[], play: number[]): boolean {
    const rem = play.slice();
    for (let i = 0; i < rem.length; i++) {
        let found = -1;
        const want = rem[i];
        for (let j = 0; j < hand.length; j++) {
            if (hand[j] === want) {
                found = j;
                break;
            }
        }
        if (found < 0) {
            return false;
        }
        hand.splice(found, 1);
    }
    return true;
}

/** 与客户端 `_net_norm_uid` 一致；否则 RT 消息里 userId 大小写与 presences 键不一致时 seatForUser=-1，叫牌消息被静默丢弃。 */
function normUserId(uid: string): string {
    return uid.toLowerCase();
}

function assignSeats(state: DdzMatchState): void {
    const ids = Object.keys(state.presences);
    ids.sort();
    state.seatByUserId = {};
    const eh = state.expectHumans;
    state.isAiSeat = [false, false, false];
    for (let i = 0; i < ids.length; i++) {
        state.seatByUserId[normUserId(ids[i])] = i;
    }
    for (let s = eh; s < 3; s++) {
        state.isAiSeat[s] = true;
    }
}

function seatForUser(state: DdzMatchState, userId: string): number {
    const s = state.seatByUserId[normUserId(userId)];
    return s === undefined ? -1 : s;
}

function assignSeatCats(state: DdzMatchState, nk: nkruntime.Nakama): void {
    const arr = [0, 1, 2];
    shuffleInPlace(nk, arr);
    state.seatCat = arr;
}

function resetRound(state: DdzMatchState, nk: nkruntime.Nakama): void {
    state.phase = "deal";
    state.hands = [[], [], []];
    state.bottom = [];
    state.bids = [-1, -1, -1];
    state.callCandidate = 0;
    state.robStep = 0;
    state.landlord = 0;
    state.turn = 0;
    state.lastPattern = null;
    state.lastPlayer = -1;
    state.passes = 0;
    state.winner = -1;
    state.multBase = 1;
    state.multRob = 1;
    state.multPlay = 1;
    state.robCount = 0;
    state.playBombCount = 0;
    state.playRocketCount = 0;
    state.lastRobber = -1;
    state.bidPassFlags = [false, false, false];
    state.continueReady = [false, false, false];
    state.lastRobSkippedNoBid = false;
    state.seenCount = [];
    for (let i = 0; i < 15; i++) {
        state.seenCount.push(0);
    }
    const deck = makeFullDeck();
    shuffleInPlace(nk, deck);
    const sb = randomBytesCompat(nk, 8);
    state.dealSeed = Array.prototype.map
        .call(sb, function (x: number) {
            return ("0" + x.toString(16)).slice(-2);
        })
        .join("");
    const trace: { seat: number; card: number }[] = [];
    for (let i = 0; i < 51; i++) {
        trace.push({ seat: i % 3, card: deck[i] });
    }
    state.dealTrace = trace;
    for (let i = 0; i < 17; i++) {
        state.hands[0].push(deck[i]);
        state.hands[1].push(deck[i + 17]);
        state.hands[2].push(deck[i + 34]);
    }
    state.bottom = [deck[51], deck[52], deck[53]];
    sortHand(state.hands[0]);
    sortHand(state.hands[1]);
    sortHand(state.hands[2]);
    state.phase = "bidding_call";
    const first = randomIntBelow(nk, 3);
    state.awaitSeat = first;
    state.callRoundStartSeat = first;
    state.bottomRevealIds = [];
    /** 与客户端发牌动画+停顿对齐，避免「继续下一局」后 AI 瞬间叫完 */
    state.aiPlayDelayUntilMs = Date.now() + AI_NEW_ROUND_BID_DELAY_MS;
}

function finalizeLandlordFromRob(state: DdzMatchState): void {
    if (state.lastRobber >= 0) {
        state.landlord = state.lastRobber;
    } else {
        state.landlord = state.callCandidate;
    }
    state.phase = "play";
    mergeLandlordBottom(state);
    state.turn = state.landlord;
    clearTrick(state);
}

/** 「不叫」者不可抢：该座位自动跳过抢地主轮次。每 tick 至多推进一步，以便客户端逐条播「没叫牌不能抢」气泡。 */
function autoAdvanceRob(state: DdzMatchState): boolean {
    if (state.phase !== "bidding_rob") {
        return false;
    }
    const cand = state.callCandidate;
    const i = (cand + 1 + state.robStep) % 3;
    if (state.bids[i] !== 0) {
        /** 已在等该座位抢/不抢时勿再返回 true，否则 matchLoop 每 tick 广播并重置 aiPlayDelayUntilMs，AI 永远轮不到 */
        if (state.awaitSeat === i) {
            return false;
        }
        state.awaitSeat = i;
        state.lastRobSkippedNoBid = false;
        return true;
    }
    state.robActionSeq++;
    state.lastRobActionSeat = i;
    state.lastRobActionWasRob = false;
    state.lastRobSkippedNoBid = true;
    if (state.robStep < 2) {
        state.robStep++;
        return true;
    }
    finalizeLandlordFromRob(state);
    return true;
}

function applyBid(state: DdzMatchState, seat: number, bid: number, nk: nkruntime.Nakama): string | null {
    if (state.phase !== "bidding_call") {
        return "not_in_bidding_call";
    }
    if (seat !== state.awaitSeat) {
        return "not_your_turn";
    }
    if (bid !== 0 && bid !== 1) {
        return "invalid_bid";
    }
    if (bid === 1) {
        state.bids[seat] = 1;
        state.bidPassFlags[seat] = false;
        state.callCandidate = seat;
        state.multBase = 1;
        state.phase = "bidding_rob";
        state.robStep = 0;
        state.multRob = 1;
        state.robCount = 0;
        state.lastRobber = -1;
        state.lastRobActionSeat = -1;
        state.lastRobActionWasRob = false;
        state.lastRobSkippedNoBid = false;
        autoAdvanceRob(state);
        return null;
    }
    state.bids[seat] = 0;
    state.bidPassFlags[seat] = true;
    let passCount = 0;
    for (let j = 0; j < 3; j++) {
        if (state.bids[j] === 0) {
            passCount++;
        }
    }
    if (passCount >= 3) {
        resetRound(state, nk);
        return null;
    }
    state.awaitSeat = (seat + 1) % 3;
    return null;
}

function mergeLandlordBottom(state: DdzMatchState): void {
    const L = state.landlord;
    state.bottomRevealIds = state.bottom.slice();
    for (let i = 0; i < state.bottom.length; i++) {
        state.hands[L].push(state.bottom[i]);
    }
    sortHand(state.hands[L]);
    state.bottom = [];
}

function clearTrick(state: DdzMatchState): void {
    state.lastPattern = null;
    state.lastPlayer = -1;
    state.passes = 0;
    state.lastPlayIds = [];
}

function applyRob(state: DdzMatchState, seat: number, doRob: boolean): string | null {
    if (state.phase !== "bidding_rob") {
        return "not_in_rob";
    }
    const cand = state.callCandidate;
    const i = (cand + 1 + state.robStep) % 3;
    if (seat !== i) {
        return "not_your_turn";
    }
    if (doRob) {
        state.multRob *= 2;
        state.robCount++;
        state.lastRobber = seat;
    }
    state.robActionSeq++;
    state.lastRobActionSeat = seat;
    state.lastRobActionWasRob = doRob;
    state.lastRobSkippedNoBid = false;
    if (state.robStep < 2) {
        state.robStep++;
        autoAdvanceRob(state);
    } else {
        finalizeLandlordFromRob(state);
    }
    return null;
}

function applyPlay(state: DdzMatchState, seat: number, cardIds: number[]): string | null {
    if (state.phase !== "play") {
        return "not_in_play";
    }
    if (seat !== state.turn) {
        return "not_your_turn";
    }
    const pat = classify(cardIds);
    if (pat.kind === DDZ_KIND_PASS || pat.kind === DDZ_KIND_INVALID) {
        return "invalid_play";
    }
    const last = state.lastPattern;
    const effectiveLast: DdzHandPattern = last
        ? last
        : ({
              kind: DDZ_KIND_PASS,
              main: -1,
              extra: null,
          } as DdzHandPattern);
    const trickFree = !last || last.kind === DDZ_KIND_PASS || state.passes >= 2;
    if (!trickFree && !beats(effectiveLast, pat)) {
        return "cannot_beat";
    }
    const hand = state.hands[seat];
    const copy = hand.slice();
    if (!removeCardsFromHand(copy, cardIds)) {
        return "cards_not_in_hand";
    }
    state.hands[seat] = copy;
    if (pat.kind === DDZ_KIND_BOMB) {
        state.multPlay *= 2;
        state.playBombCount++;
    } else if (pat.kind === DDZ_KIND_ROCKET) {
        state.multPlay *= 4;
        state.playRocketCount++;
    }
    state.lastPattern = pat;
    state.lastPlayer = seat;
    state.lastPlayIds = cardIds.slice();
    state.passes = 0;
    if (!state.seenCount || state.seenCount.length < 15) {
        state.seenCount = [];
        for (let i = 0; i < 15; i++) {
            state.seenCount.push(0);
        }
    }
    for (let i = 0; i < cardIds.length; i++) {
        const r = ddzRankValue(cardIds[i]);
        if (r >= 0 && r < 15) {
            state.seenCount[r]++;
        }
    }
    if (state.hands[seat].length === 0) {
        state.winner = seat;
        state.phase = "finished";
        state.continueReady = [false, false, false];
        return null;
    }
    state.turn = (seat + 1) % 3;
    return null;
}

function applyContinue(state: DdzMatchState, seat: number, nk: nkruntime.Nakama): string | null {
    if (state.phase !== "finished") {
        return "not_in_finished";
    }
    state.continueReady[seat] = true;
    let all = true;
    for (let i = 0; i < 3; i++) {
        if (!state.continueReady[i]) {
            all = false;
            break;
        }
    }
    if (all) {
        resetRound(state, nk);
    }
    return null;
}

function applyPass(state: DdzMatchState, seat: number): string | null {
    if (state.phase !== "play") {
        return "not_in_play";
    }
    if (seat !== state.turn) {
        return "not_your_turn";
    }
    const last = state.lastPattern;
    if (!last || last.kind === DDZ_KIND_PASS) {
        return "cannot_pass";
    }
    state.passes++;
    state.turn = (seat + 1) % 3;
    if (state.passes >= 2) {
        state.lastPattern = null;
        state.lastPlayIds = [];
        state.passes = 0;
        state.turn = state.lastPlayer;
    }
    return null;
}

function settlementFarmersWin(state: DdzMatchState): boolean {
    return state.winner >= 0 && state.winner !== state.landlord;
}

/** 春天：对手全程未出牌；地主 20 张、农民各 17 张未动 */
function springBonus(state: DdzMatchState): boolean {
    if (state.winner < 0) {
        return false;
    }
    if (settlementFarmersWin(state)) {
        return state.hands[state.landlord].length === 20;
    }
    return state.hands[(state.landlord + 1) % 3].length === 17 && state.hands[(state.landlord + 2) % 3].length === 17;
}

/** 每人游戏币 delta：基础筹码 100 × 最终倍率；地主赢 +100×m×2 / 农民各 -100×m；农民赢则相反（与客户端 main.gd 一致，不含春天加倍） */
function computeScoreDeltas(state: DdzMatchState): number[] {
    const m = roundMultiplier(state);
    const base = 100;
    const out = [0, 0, 0];
    if (state.winner < 0) {
        return out;
    }
    const L = state.landlord;
    const isFarmWin = settlementFarmersWin(state);
    if (isFarmWin) {
        out[L] = -base * m * 2;
        const f1 = (L + 1) % 3;
        const f2 = (L + 2) % 3;
        out[f1] = base * m;
        out[f2] = base * m;
    } else {
        out[L] = base * m * 2;
        const f1 = (L + 1) % 3;
        const f2 = (L + 2) % 3;
        out[f1] = -base * m;
        out[f2] = -base * m;
    }
    return out;
}

function buildPublicSnapshot(state: DdzMatchState): string {
    const handsPublic: number[][] = [[], [], []];
    for (let s = 0; s < 3; s++) {
        handsPublic[s] = state.hands[s].map(function () {
            return -1;
        });
    }
    const payload = {
        v: 1,
        seq: state.seq,
        phase: state.phase,
        seatByUserId: state.seatByUserId,
        bids: state.bids,
        landlord: state.landlord,
        turn: state.turn,
        awaitSeat: state.awaitSeat,
        mult: roundMultiplier(state),
        multBase: state.multBase,
        multRob: state.multRob,
        multPlay: state.multPlay,
        lastPattern: state.lastPattern,
        lastPlayer: state.lastPlayer,
        passes: state.passes,
        winner: state.winner,
        bottomCount: state.bottom.length,
        handsCount: [state.hands[0].length, state.hands[1].length, state.hands[2].length],
        handsPublic: handsPublic,
        dealSeed: state.dealSeed,
        dealTrace: state.dealTrace,
        robStep: state.robStep,
        callCandidate: state.callCandidate,
        lastPlayIds: state.lastPlayIds,
        robCount: state.robCount,
        lastRobber: state.lastRobber,
        playBombCount: state.playBombCount,
        playRocketCount: state.playRocketCount,
        continueReady: state.continueReady,
        seatCat: state.seatCat,
        bottomRevealIds: state.bottomRevealIds,
        callRoundStartSeat: state.callRoundStartSeat,
        robActionSeq: state.robActionSeq,
        lastRobActionSeat: state.lastRobActionSeat,
        lastRobActionWasRob: state.lastRobActionWasRob,
        lastRobSkippedNoBid: state.lastRobSkippedNoBid,
    };
    return JSON.stringify(payload);
}

function broadcastState(
    dispatcher: nkruntime.MatchDispatcher,
    state: DdzMatchState,
    logger: nkruntime.Logger,
    reason: string
): void {
    state.seq++;
    try {
        const snap = buildPublicSnapshot(state);
        dispatcher.broadcastMessage(DDZ_OP_SNAPSHOT, snap, null, null);
        const userIds = Object.keys(state.presences);
        for (let u = 0; u < userIds.length; u++) {
            const uid = userIds[u];
            const seat = seatForUser(state, uid);
            if (seat < 0) {
                logger.warn("broadcastState(%s): seat missing for userId=%s", reason, uid);
                continue;
            }
            const handMsg = JSON.stringify({
                v: 1,
                seq: state.seq,
                yourSeat: seat,
                yourHand: state.hands[seat],
            });
            const pres = state.presences[uid];
            dispatcher.broadcastMessage(DDZ_OP_SNAPSHOT, handMsg, [pres], null);
        }
        if (reason.indexOf("join") >= 0) {
            logger.info(
                "ddz broadcastState ok [%s]: seq=%d phase=%s players=%d",
                reason,
                state.seq,
                state.phase,
                userIds.length
            );
        }
    } catch (e) {
        logger.error(
            "ddz broadcastState FAILED [%s]: %s | phase=%s seq=%d",
            reason,
            String(e),
            state.phase,
            state.seq
        );
    }
}

function initialState(): DdzMatchState {
    return {
        presences: {},
        seatByUserId: {},
        expectHumans: 3,
        aiCount: 0,
        isAiSeat: [false, false, false],
        phase: "waiting",
        hands: [[], [], []],
        bottom: [],
        bids: [-1, -1, -1],
        callCandidate: 0,
        robStep: 0,
        landlord: 0,
        turn: 0,
        lastPattern: null,
        lastPlayer: -1,
        passes: 0,
        winner: -1,
        multBase: 1,
        multRob: 1,
        multPlay: 1,
        robCount: 0,
        playBombCount: 0,
        playRocketCount: 0,
        lastRobber: -1,
        dealSeed: "",
        seq: 0,
        awaitSeat: 0,
        callRoundStartSeat: 0,
        robActionSeq: 0,
        lastRobActionSeat: -1,
        lastRobActionWasRob: false,
        lastRobSkippedNoBid: false,
        bidPassFlags: [false, false, false],
        errorLog: [],
        lastPlayIds: [],
        continueReady: [false, false, false],
        seatCat: [0, 1, 2],
        aiPlayDelayUntilMs: 0,
        bottomRevealIds: [],
        dealTrace: [],
        seenCount: (function () {
            const a: number[] = [];
            for (let i = 0; i < 15; i++) {
                a.push(0);
            }
            return a;
        })(),
    };
}
