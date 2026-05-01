/**
 * 掼蛋 Match 的纯逻辑层：发牌、出牌/过/贡/还、升级、快照、结算。
 *
 * 注意：Nakama 3.1+ JS 运行时禁止在 matchLoop / matchJoin 之外保持可变闭包状态；
 * 所有持久字段都挂在 GdMatchState 上，函数无副作用（除传入 state/dispatcher/nk/logger）。
 */

function gdNormUserId(uid: string): string {
    return uid.toLowerCase();
}

function gdSeatForUser(state: GdMatchState, userId: string): number {
    const s = state.seatByUserId[gdNormUserId(userId)];
    return s === undefined ? -1 : s;
}

function gdMakeFullDeck(): number[] {
    const d: number[] = [];
    for (let i = 0; i < GD_DECK_COUNT; i++) {
        d.push(i);
    }
    return d;
}

function gdSortHand(h: number[], levelRank: number): void {
    h.sort(function (a, b) {
        const va = gdRankValue(a, levelRank);
        const vb = gdRankValue(b, levelRank);
        if (va !== vb) {
            return va - vb;
        }
        return a - b;
    });
}

function gdInitialState(): GdMatchState {
    return {
        presences: {},
        seatByUserId: {},
        expectHumans: 4,
        aiCount: 0,
        isAiSeat: [false, false, false, false],
        phase: "waiting",
        teams: [
            { seats: [0, 2], level: GD_RAW_RANK_2, overALocked: false },
            { seats: [1, 3], level: GD_RAW_RANK_2, overALocked: false },
        ],
        dealerTeam: 0,
        levelRankActive: GD_RAW_RANK_2,
        isFirstRound: true,
        lastRoundWinnerSeat: -1,
        lastRoundLoserSeat: -1,
        lastRoundDoubleDown: false,
        hands: [[], [], [], []],
        dealTrace: [],
        dealSeed: "",
        dealEndAtMs: 0,
        pendingFirstPlaySeat: -1,
        tribute: {
            mode: "none",
            payers: [],
            receivers: [],
            given: {},
            returned: {},
            pendingPayer: -1,
            pendingReceiver: -1,
        },
        turn: 0,
        finishedOrder: [],
        lastPattern: null,
        lastPlayer: -1,
        lastPlayIds: [],
        passes: 0,
        seq: 0,
        aiPlayDelayUntilMs: 0,
        winnerTeam: -1,
        continueReady: [false, false, false, false],
        aiDelegate: [false, false, false, false],
        seatCat: [0, 1, 2, 0],
        errorLog: [],
        tributeEvent: null,
    };
}

function gdAssignSeats(state: GdMatchState): void {
    const ids = Object.keys(state.presences);
    ids.sort();
    state.seatByUserId = {};
    state.isAiSeat = [false, false, false, false];
    for (let i = 0; i < ids.length; i++) {
        state.seatByUserId[gdNormUserId(ids[i])] = i;
    }
    const eh = state.expectHumans;
    for (let s = eh; s < 4; s++) {
        state.isAiSeat[s] = true;
    }
}

function gdAssignSeatCats(state: GdMatchState, nk: nkruntime.Nakama): void {
    const arr = [0, 1, 2, 3];
    shuffleInPlace(nk, arr);
    state.seatCat = arr;
}

/** 同队：座 (0,2) 一队；(1,3) 一队 */
function gdTeamOfSeat(seat: number): number {
    return seat % 2 === 0 ? 0 : 1;
}

function gdTeammateSeat(seat: number): number {
    return (seat + 2) % 4;
}

function gdRemoveCardsFromHand(hand: number[], play: number[]): boolean {
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

/**
 * 重置为「新一局」：洗牌 / 发牌 / 准备贡牌阶段。
 * 入口职责：
 *   - 本局 dealerTeam 已由上一局 finalize 设置（或整场初局为 0）；
 *   - 本局生效级牌 = teams[dealerTeam].level；
 *   - 先进入 deal（供客户端播发牌动画）；首局结束后进入 play（首出随机），非首局进入 tribute_wait。
 */
function gdResetRound(state: GdMatchState, nk: nkruntime.Nakama): void {
    state.phase = "deal";
    state.hands = [[], [], [], []];
    state.turn = -1;
    state.lastPattern = null;
    state.lastPlayer = -1;
    state.lastPlayIds = [];
    state.passes = 0;
    state.finishedOrder = [];
    state.continueReady = [false, false, false, false];
    state.aiDelegate = [false, false, false, false];
    state.winnerTeam = -1; // 只在整场 finalize 时才置 0/1
    state.tribute = {
        mode: "none",
        payers: [],
        receivers: [],
        given: {},
        returned: {},
        pendingPayer: -1,
        pendingReceiver: -1,
    };

    state.levelRankActive = state.teams[state.dealerTeam].level;

    const deck = gdMakeFullDeck();
    shuffleInPlace(nk, deck);
    const sb = randomBytesCompat(nk, 8);
    state.dealSeed = Array.prototype.map
        .call(sb, function (x: number) {
            return ("0" + x.toString(16)).slice(-2);
        })
        .join("");

    const trace: { seat: number; card: number }[] = [];
    for (let i = 0; i < GD_DECK_COUNT; i++) {
        trace.push({ seat: i % 4, card: deck[i] });
    }
    state.dealTrace = trace;
    for (let i = 0; i < GD_HAND_SIZE; i++) {
        state.hands[0].push(deck[i * 4 + 0]);
        state.hands[1].push(deck[i * 4 + 1]);
        state.hands[2].push(deck[i * 4 + 2]);
        state.hands[3].push(deck[i * 4 + 3]);
    }
    for (let s = 0; s < 4; s++) {
        gdSortHand(state.hands[s], state.levelRankActive);
    }

    state.pendingFirstPlaySeat = -1;
    if (state.isFirstRound) {
        state.pendingFirstPlaySeat = randomIntBelow(nk, 4);
    }
    const dealUntil = Date.now() + GD_DEAL_PHASE_MS;
    state.dealEndAtMs = dealUntil;
    state.aiPlayDelayUntilMs = dealUntil + GD_AI_POST_DEAL_DELAY_MS;
}

/** deal 计时结束 → play（首局）或贡牌；由 matchLoop 每 tick 调用 */
function gdTryAdvanceDealPhase(state: GdMatchState, nk: nkruntime.Nakama): boolean {
    if (state.phase !== "deal") {
        return false;
    }
    if (Date.now() < state.dealEndAtMs) {
        return false;
    }
    state.dealEndAtMs = 0;
    if (state.isFirstRound) {
        state.turn = state.pendingFirstPlaySeat;
        state.pendingFirstPlaySeat = -1;
        state.phase = "play";
    } else {
        gdBeginTributePhase(state);
    }
    state.aiPlayDelayUntilMs = Date.now() + GD_AI_POST_DEAL_DELAY_MS;
    return true;
}

function gdBeginTributePhase(state: GdMatchState): void {
    state.phase = "tribute_wait";
    const winner = state.lastRoundWinnerSeat;
    const loser = state.lastRoundLoserSeat;
    if (winner < 0 || loser < 0) {
        state.phase = "play";
        state.turn = 0;
        return;
    }
    if (state.lastRoundDoubleDown) {
        const winnerTeammate = gdTeammateSeat(winner);
        const loserTeammate = gdTeammateSeat(loser);
        state.tribute.mode = "double";
        state.tribute.payers = [loser, loserTeammate];
        state.tribute.receivers = [winner, winnerTeammate];
    } else {
        state.tribute.mode = "single";
        state.tribute.payers = [loser];
        state.tribute.receivers = [winner];
    }
    state.tribute.pendingPayer = state.tribute.payers[0];
    state.tribute.pendingReceiver = -1;
}

/** 手里大王数（不计红心级牌） */
function gdCountBigJokers(hand: number[]): number {
    let c = 0;
    for (let i = 0; i < hand.length; i++) {
        if (gdRawRank(hand[i]) === GD_RAW_RANK_BIG_JOKER) {
            c++;
        }
    }
    return c;
}

/** 能否抗贡：末游方几家的大王合计 ≥2（含一家两张或两家各一张） */
function gdCanResistTribute(state: GdMatchState): boolean {
    let sum = 0;
    for (let i = 0; i < state.tribute.payers.length; i++) {
        sum += gdCountBigJokers(state.hands[state.tribute.payers[i]]);
    }
    return sum >= 2;
}

function gdApplyTribute(state: GdMatchState, seat: number, cardId: number): string | null {
    if (state.phase !== "tribute_wait") {
        return "bad_phase";
    }
    if (state.tribute.pendingPayer !== seat) {
        return "not_your_turn";
    }
    if (gdIsHeartLevelCard(cardId, state.levelRankActive)) {
        return "tribute_heart_level_forbidden";
    }
    const idx = state.hands[seat].indexOf(cardId);
    if (idx < 0) {
        return "card_not_in_hand";
    }
    state.tribute.given[String(seat)] = cardId;
    state.hands[seat].splice(idx, 1);
    const pos = state.tribute.payers.indexOf(seat);
    const recv0 = pos >= 0 ? state.tribute.receivers[pos] : -1;
    state.tributeEvent = { kind: "give", from: seat, to: recv0, card: cardId };
    // 推进下一个 payer / 进入 return_wait
    if (pos + 1 < state.tribute.payers.length) {
        state.tribute.pendingPayer = state.tribute.payers[pos + 1];
    } else {
        state.tribute.pendingPayer = -1;
        gdEnterReturnPhase(state);
    }
    return null;
}

function gdApplyTributeResist(state: GdMatchState, seat: number): string | null {
    if (state.phase !== "tribute_wait") {
        return "bad_phase";
    }
    if (state.tribute.payers.indexOf(seat) < 0) {
        return "not_payer";
    }
    if (!gdCanResistTribute(state)) {
        return "no_resist_right";
    }
    state.tribute.mode = "resist";
    state.tribute.pendingPayer = -1;
    state.tribute.pendingReceiver = -1;
    // 抗贡：由上局头游先出
    state.phase = "play";
    state.turn = state.lastRoundWinnerSeat;
    return null;
}

function gdEnterReturnPhase(state: GdMatchState): void {
    state.phase = "return_wait";
    if (state.tribute.receivers.length === 0) {
        gdFinalizeTributeExchange(state);
        return;
    }
    state.tribute.pendingReceiver = state.tribute.receivers[0];
}

function gdApplyReturn(state: GdMatchState, seat: number, cardId: number): string | null {
    if (state.phase !== "return_wait") {
        return "bad_phase";
    }
    if (state.tribute.pendingReceiver !== seat) {
        return "not_your_turn";
    }
    const rr = gdRawRank(cardId);
    if (rr >= GD_RAW_RANK_SMALL_JOKER) {
        return "return_too_big";
    }
    if (gdIsHeartLevelCard(cardId, state.levelRankActive)) {
        return "return_too_big";
    }
    // 3..10（raw 0..7）；非打 2 时普通 2 可作还贡（2 非当前级牌）
    const okSmall = rr <= 7;
    const okPlainTwo = rr === GD_RAW_RANK_2 && state.levelRankActive !== GD_RAW_RANK_2;
    if (!okSmall && !okPlainTwo) {
        return "return_too_big";
    }
    const idx = state.hands[seat].indexOf(cardId);
    if (idx < 0) {
        return "card_not_in_hand";
    }
    state.tribute.returned[String(seat)] = cardId;
    state.hands[seat].splice(idx, 1);
    const pos = state.tribute.receivers.indexOf(seat);
    const payerBack = pos >= 0 ? state.tribute.payers[pos] : -1;
    state.tributeEvent = { kind: "return", from: seat, to: payerBack, card: cardId };
    if (pos + 1 < state.tribute.receivers.length) {
        state.tribute.pendingReceiver = state.tribute.receivers[pos + 1];
    } else {
        state.tribute.pendingReceiver = -1;
        gdFinalizeTributeExchange(state);
    }
    return null;
}

/**
 * 贡完+还完：合并手牌、排序、进入 play。
 * - 单下：末游先出。
 * - 双下：贡牌大的一家先出；贡牌同大则头游的下家先出；头游收较大贡牌、二游收较小贡牌；
 *   头游的还牌给进贡大的一方，二游的还牌给另一方。
 */
function gdFinalizeTributeExchange(state: GdMatchState): void {
    const lvl = state.levelRankActive;
    const mode = state.tribute.mode;
    if (mode === "resist") {
        return;
    }
    if (mode === "single") {
        const p = state.tribute.payers[0];
        const r = state.tribute.receivers[0];
        const gift = state.tribute.given[String(p)];
        const back = state.tribute.returned[String(r)];
        if (gift !== undefined) {
            state.hands[r].push(gift);
        }
        if (back !== undefined) {
            state.hands[p].push(back);
        }
        for (let s = 0; s < 4; s++) {
            gdSortHand(state.hands[s], lvl);
        }
        state.phase = "play";
        state.turn = state.lastRoundLoserSeat;
        return;
    }
    if (mode === "double") {
        const p0 = state.tribute.payers[0];
        const p1 = state.tribute.payers[1];
        const w = state.tribute.receivers[0];
        const w2 = state.tribute.receivers[1];
        const g0 = state.tribute.given[String(p0)];
        const g1 = state.tribute.given[String(p1)];
        const rv0 = g0 !== undefined ? gdRankValue(g0, lvl) : -999999;
        const rv1 = g1 !== undefined ? gdRankValue(g1, lvl) : -999999;
        let bigP = p0;
        let smallP = p1;
        if (rv1 > rv0) {
            bigP = p1;
            smallP = p0;
        }
        const bg = state.tribute.given[String(bigP)];
        const sg = state.tribute.given[String(smallP)];
        if (bg === undefined || sg === undefined) {
            return;
        }
        state.hands[w].push(bg);
        state.hands[w2].push(sg);
        const backW = state.tribute.returned[String(w)];
        const backW2 = state.tribute.returned[String(w2)];
        if (backW !== undefined) {
            state.hands[bigP].push(backW);
        }
        if (backW2 !== undefined) {
            state.hands[smallP].push(backW2);
        }
        for (let s = 0; s < 4; s++) {
            gdSortHand(state.hands[s], lvl);
        }
        state.phase = "play";
        if (rv0 === rv1) {
            state.turn = (w + 1) % 4;
        } else {
            state.turn = bigP;
        }
        return;
    }
    for (let i = 0; i < state.tribute.payers.length; i++) {
        const p = state.tribute.payers[i];
        const r = state.tribute.receivers[i];
        const gift = state.tribute.given[String(p)];
        const back = state.tribute.returned[String(r)];
        if (gift !== undefined) {
            state.hands[r].push(gift);
        }
        if (back !== undefined) {
            state.hands[p].push(back);
        }
    }
    for (let s = 0; s < 4; s++) {
        gdSortHand(state.hands[s], lvl);
    }
    state.phase = "play";
    state.turn = state.lastRoundWinnerSeat;
}

/** 推进到下一个仍有手牌的座位（跳过已完成） */
function gdAdvanceTurn(state: GdMatchState, from: number): number {
    let t = (from + 1) % 4;
    for (let i = 0; i < 4; i++) {
        if (state.hands[t].length > 0) {
            return t;
        }
        t = (t + 1) % 4;
    }
    return from;
}

/**
 * 接风：某人刚出完最后一手，其余仍有牌者均 pass 后，由**其对家**领出（对家也已出完时退化为顺时针下一家仍有牌者）。
 */
function gdPartnerLeadAfterFinishedFree(state: GdMatchState, finishedSeat: number): number {
    const mate = gdTeammateSeat(finishedSeat);
    if (state.hands[mate].length > 0) {
        return mate;
    }
    return gdAdvanceTurn(state, finishedSeat);
}

/** 出牌 */
function gdApplyPlay(state: GdMatchState, seat: number, ids: number[]): string | null {
    if (state.phase !== "play") {
        return "bad_phase";
    }
    if (state.turn !== seat) {
        return "not_your_turn";
    }
    if (!ids || ids.length === 0) {
        return "empty_play";
    }
    // 校验手里都有
    const hand = state.hands[seat].slice();
    if (!gdRemoveCardsFromHand(hand, ids)) {
        return "card_not_in_hand";
    }
    const pat = gdClassify(ids, state.levelRankActive);
    if (pat.kind === GD_KIND_INVALID) {
        return "invalid_pattern";
    }
    const last: GdHandPattern =
        state.lastPattern !== null
            ? state.lastPattern
            : { kind: GD_KIND_PASS, main: -1, len: 0, bombTier: 0, wildUsed: 0, straightLen: 0, suit: -1 };
    if (!gdBeats(last, pat)) {
        return "cannot_beat";
    }
    // 落地
    gdRemoveCardsFromHand(state.hands[seat], ids);
    state.lastPattern = pat;
    state.lastPlayer = seat;
    state.lastPlayIds = ids.slice();
    state.passes = 0;
    // 检测出完
    if (state.hands[seat].length === 0 && state.finishedOrder.indexOf(seat) < 0) {
        state.finishedOrder.push(seat);
    }
    // 本局结束？某队两人都出完
    if (gdIsRoundOver(state)) {
        gdFinalizeRound(state);
        return null;
    }
    // 推进 turn：若自己出完了，从自己往后找下一个有牌的座位；否则正常推进
    state.turn = gdAdvanceTurn(state, seat);
    return null;
}

function gdApplyPass(state: GdMatchState, seat: number): string | null {
    if (state.phase !== "play") {
        return "bad_phase";
    }
    if (state.turn !== seat) {
        return "not_your_turn";
    }
    if (state.lastPattern === null || state.lastPattern.kind === GD_KIND_PASS) {
        return "cannot_pass_on_free_lead";
    }
    state.passes++;
    state.turn = gdAdvanceTurn(state, seat);
    // 本局结束？（极端情况：pass 后所有人都出完）
    if (gdIsRoundOver(state)) {
        gdFinalizeRound(state);
        return null;
    }
    // 一圈过完？两种场景：
    //   (a) lastPlayer 仍有牌：advance 后 turn 回到 lastPlayer → free lead；
    //   (b) lastPlayer 已出完：gdAdvanceTurn 会跳过他，永远走不回去。
    //       此时应以「所有仍有牌且非 lastPlayer 的座位都 pass 过一轮」作为一圈结束判据。
    const lpAlive = state.hands[state.lastPlayer].length > 0;
    let roundEnded = false;
    if (lpAlive && state.turn === state.lastPlayer) {
        roundEnded = true;
    } else if (!lpAlive) {
        let aliveOpp = 0;
        for (let s = 0; s < 4; s++) {
            if (s !== state.lastPlayer && state.hands[s].length > 0) {
                aliveOpp++;
            }
        }
        if (state.passes >= aliveOpp) {
            roundEnded = true;
        }
    }
    if (roundEnded) {
        state.lastPattern = null;
        state.lastPlayIds = [];
        state.passes = 0;
        if (!lpAlive) {
            state.turn = gdPartnerLeadAfterFinishedFree(state, state.lastPlayer);
        }
    }
    return null;
}

/** 某队两人都出完即为本局结束（剩 2 人 / 3 人的具体名次由 finishedOrder 补齐） */
function gdIsRoundOver(state: GdMatchState): boolean {
    let teamDone = [0, 0];
    for (let i = 0; i < state.finishedOrder.length; i++) {
        teamDone[gdTeamOfSeat(state.finishedOrder[i])]++;
    }
    return teamDone[0] === 2 || teamDone[1] === 2;
}

/** 结算本局：补齐 finishedOrder 至全 4 人 → 升级 → 判定整场毕业 */
function gdFinalizeRound(state: GdMatchState): void {
    // 补齐剩余玩家名次：按手牌数量升序（更少的排更前）
    const remaining: number[] = [];
    for (let s = 0; s < 4; s++) {
        if (state.finishedOrder.indexOf(s) < 0) {
            remaining.push(s);
        }
    }
    remaining.sort(function (a, b) {
        return state.hands[a].length - state.hands[b].length;
    });
    for (let i = 0; i < remaining.length; i++) {
        state.finishedOrder.push(remaining[i]);
    }
    // 头游 / 二游 / 三游 / 末游
    const winner = state.finishedOrder[0];
    const second = state.finishedOrder[1];
    const loser = state.finishedOrder[3];
    const winnerTeam = gdTeamOfSeat(winner);
    const doubleDown = gdTeamOfSeat(second) === winnerTeam;
    const thirdIsWinnerTeam = gdTeamOfSeat(state.finishedOrder[2]) === winnerTeam;

    // 升级：按头游的队友名次
    let upStep = 1;
    if (doubleDown) {
        upStep = 3;
    } else if (thirdIsWinnerTeam) {
        upStep = 2;
    }
    const team = state.teams[winnerTeam];
    const prevLevel = team.level;
    // 过 A 检查：若本局 dealerTeam==winnerTeam 且 teams[winnerTeam].overALocked 为真（即已在 A 上打），则毕业
    const isOverARound =
        state.dealerTeam === winnerTeam && team.overALocked;
    if (isOverARound) {
        state.winnerTeam = winnerTeam;
        state.phase = "finished";
    } else {
        // 推进 level；若升到 A，设置 overALocked
        const nl = gdNextLevel(prevLevel, upStep);
        team.level = nl;
        if (nl === GD_RAW_RANK_A) {
            team.overALocked = true;
        }
        state.dealerTeam = winnerTeam;
        state.levelRankActive = team.level;
        // 记录本局信息供下一局贡牌
        state.lastRoundWinnerSeat = winner;
        state.lastRoundLoserSeat = loser;
        state.lastRoundDoubleDown = doubleDown;
        state.isFirstRound = false;
        state.phase = "finished"; // finished 阶段等待四人点继续
    }
}

/** 切换本座「AI 托管」；仅真人可设。 */
function gdApplyDelegate(state: GdMatchState, seat: number, on: boolean): string | null {
    if (state.isAiSeat[seat]) {
        return "ai_seat_no_delegate";
    }
    state.aiDelegate[seat] = on;
    return null;
}

/** 全员（含 AI）点「继续」后开新局。AI 在 matchLoop 里自动 READY。 */
function gdApplyContinue(state: GdMatchState, seat: number, nk: nkruntime.Nakama): string | null {
    if (state.phase !== "finished") {
        return "bad_phase";
    }
    if (state.winnerTeam >= 0) {
        return "match_finished";
    }
    state.continueReady[seat] = true;
    let all = true;
    for (let s = 0; s < 4; s++) {
        if (!state.continueReady[s]) {
            all = false;
            break;
        }
    }
    if (all) {
        gdResetRound(state, nk);
    }
    return null;
}

/** 钱包 delta：名次 1/2/3/4 依次 + / + / - / -；具体数字见 docs/guandan_DESIGN.md §9.1 */
function gdComputeScoreDeltas(state: GdMatchState): number[] {
    const deltas = [0, 0, 0, 0];
    if (state.finishedOrder.length < 4) {
        return deltas;
    }
    const winner = state.finishedOrder[0];
    const second = state.finishedOrder[1];
    const third = state.finishedOrder[2];
    const loser = state.finishedOrder[3];
    const winnerTeam = gdTeamOfSeat(winner);
    const doubleDown = gdTeamOfSeat(second) === winnerTeam;
    const thirdSameTeam = gdTeamOfSeat(third) === winnerTeam;
    let payout: [number, number, number, number] = [0, 0, 0, 0];
    if (doubleDown) {
        payout = [1000, 1000, -500, -500];
    } else if (thirdSameTeam) {
        payout = [600, 200, -200, -600];
    } else {
        payout = [400, 100, 100, -600];
    }
    deltas[winner] += payout[0];
    deltas[second] += payout[1];
    deltas[third] += payout[2];
    deltas[loser] += payout[3];
    if (state.winnerTeam >= 0) {
        // 整场毕业额外奖励
        deltas[winner] += 2000;
        deltas[gdTeammateSeat(winner)] += 2000;
    }
    return deltas;
}

function gdBuildRoster(state: GdMatchState): { seat: number; user_id: string; username: string; is_ai: boolean }[] {
    const uidForSeat: (string | null)[] = [null, null, null, null];
    for (const uid in state.seatByUserId) {
        if (!Object.prototype.hasOwnProperty.call(state.seatByUserId, uid)) {
            continue;
        }
        const s = state.seatByUserId[uid];
        if (s >= 0 && s < 4) {
            uidForSeat[s] = uid;
        }
    }
    const roster: { seat: number; user_id: string; username: string; is_ai: boolean }[] = [];
    for (let s = 0; s < 4; s++) {
        const uid = uidForSeat[s];
        let username = "";
        if (uid !== null) {
            const pr = state.presences[uid];
            if (pr) {
                username = pr.username || "";
            }
        }
        if (username === "" && state.isAiSeat[s]) {
            username = "AI";
        }
        roster.push({
            seat: s,
            user_id: uid !== null ? uid : "",
            username: username,
            is_ai: state.isAiSeat[s],
        });
    }
    return roster;
}

function gdBuildSnapshot(state: GdMatchState): { [k: string]: any } {
    const handLens = [0, 0, 0, 0];
    for (let s = 0; s < 4; s++) {
        handLens[s] = state.hands[s].length;
    }
    const levels = [state.teams[0].level, state.teams[1].level];
    const tribute = state.phase === "tribute_wait" || state.phase === "return_wait"
        ? {
            mode: state.tribute.mode,
            payers: state.tribute.payers.slice(),
            receivers: state.tribute.receivers.slice(),
            pending_payer: state.tribute.pendingPayer,
            pending_receiver: state.tribute.pendingReceiver,
        }
        : null;
    const last = state.lastPattern
        ? {
            player: state.lastPlayer,
            kind: state.lastPattern.kind,
            main: state.lastPattern.main,
            len: state.lastPattern.len,
            bomb_tier: state.lastPattern.bombTier,
            wild_used: state.lastPattern.wildUsed,
            ids: state.lastPlayIds.slice(),
        }
        : null;
    return {
        v: 1,
        phase: state.phase,
        dealer_team: state.dealerTeam,
        level_active: state.levelRankActive,
        levels: levels,
        turn: state.turn,
        last: last,
        hand_lens: handLens,
        finished: state.finishedOrder.slice(),
        seat_cats: state.seatCat.slice(),
        seq: state.seq,
        tribute: tribute,
        winner_team: state.winnerTeam,
        is_first_round: state.isFirstRound,
        roster: gdBuildRoster(state),
        tribute_event: state.tributeEvent,
        ai_delegate: state.aiDelegate.slice(),
        deal_end_ms: state.phase === "deal" ? state.dealEndAtMs : 0,
        first_draw_seat: 0,
        first_play_seat:
            state.phase === "deal" && state.isFirstRound && state.pendingFirstPlaySeat >= 0
                ? state.pendingFirstPlaySeat
                : -1,
    };
}

/** 广播状态：每个真人看到自己的手牌（self_hand） */
function gdBroadcastState(
    dispatcher: nkruntime.MatchDispatcher,
    state: GdMatchState,
    logger: nkruntime.Logger,
    reason: string
): void {
    state.seq++;
    const base = gdBuildSnapshot(state);
    state.tributeEvent = null;
    // 真人用户：按 presence 单独发送含 self_hand 的快照
    const presList: nkruntime.Presence[] = [];
    for (const uid in state.presences) {
        if (state.presences.hasOwnProperty(uid)) {
            presList.push(state.presences[uid]);
        }
    }
    for (let i = 0; i < presList.length; i++) {
        const p = presList[i];
        const seat = gdSeatForUser(state, p.userId);
        const packet: { [k: string]: any } = {};
        for (const k in base) {
            if (base.hasOwnProperty(k)) {
                packet[k] = base[k];
            }
        }
        packet["self_seat"] = seat;
        packet["self_hand"] = seat >= 0 ? state.hands[seat].slice() : [];
        // 若本人已出完（上游），在 play/finished 阶段把队友明牌公开给他看（托管/陪同观战体验）
        if (seat >= 0 && state.finishedOrder.indexOf(seat) >= 0) {
            const mate = gdTeammateSeat(seat);
            packet["teammate_hand"] = state.hands[mate].slice();
            packet["teammate_seat"] = mate;
        }
        try {
            dispatcher.broadcastMessage(GD_OP_SNAPSHOT, JSON.stringify(packet), [p], null);
        } catch (e) {
            logger.warn("gd broadcast to %s failed: %s", p.userId, String(e));
        }
    }
    if (presList.length === 0) {
        // 全 AI 桌：仍广播一份用于观察（无 self_hand）
        const packet: { [k: string]: any } = {};
        for (const k in base) {
            if (base.hasOwnProperty(k)) {
                packet[k] = base[k];
            }
        }
        packet["self_seat"] = -1;
        packet["self_hand"] = [];
        try {
            dispatcher.broadcastMessage(GD_OP_SNAPSHOT, JSON.stringify(packet), null, null);
        } catch (e) {
            logger.warn("gd broadcast (no presence) failed: %s", String(e));
        }
    }
}
