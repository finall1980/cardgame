/**
 * 猫猫杀：发牌、回合、杀闪桃、濒死、胜负、广播（白板 4 血、无装备无武将技能）。
 */

const MK_AI_PLAY_PACE_MS = 750;
const MK_EVENT_LOG_MAX = 48;

function mkPushEvent(st: MkMatchState, line: string): void {
    if (!st.eventLog || !Array.isArray(st.eventLog)) {
        st.eventLog = [];
    }
    st.eventLog.push(line);
    while (st.eventLog.length > MK_EVENT_LOG_MAX) {
        st.eventLog.shift();
    }
}

function mkSeatDisplayName(st: MkMatchState, seat: number): string {
    if (seat < 0 || seat >= st.playerCount) {
        return "?";
    }
    if (st.isAiSeat[seat] === true) {
        return "座" + seat + "·牌手";
    }
    const uid = st.seatUserIds[seat] || "";
    if (uid && st.presences[uid]) {
        const u = st.presences[uid].username || "";
        if (u && u.length > 0) {
            return "座" + seat + "·" + u;
        }
    }
    return "座" + seat;
}

/** AI 逻辑座位：原生 AI 或真人托管 */
function mkSeatActsAsAi(st: MkMatchState, seat: number): boolean {
    if (seat < 0 || seat >= st.playerCount) {
        return false;
    }
    return st.isAiSeat[seat] === true || st.aiDelegate[seat] === true;
}

const MK_BREED_POOL_8: string[] = [
    "breed_white",
    "breed_ragdoll",
    "breed_orange",
    "breed_british_shorthair",
    "breed_black",
    "breed_siamese",
    "breed_tabby",
    "breed_sphynx",
];

function mkBreedNameZh(stem: string): string {
    if (stem === "breed_white") return "白猫";
    if (stem === "breed_ragdoll") return "布偶猫";
    if (stem === "breed_orange") return "橘猫";
    if (stem === "breed_british_shorthair") return "英短";
    if (stem === "breed_black") return "黑猫";
    if (stem === "breed_siamese") return "暹罗猫";
    if (stem === "breed_tabby") return "狸花猫";
    if (stem === "breed_sphynx") return "无毛猫";
    return "猫咪";
}

function mkPrepareBreedPool(st: MkMatchState, nk: nkruntime.Nakama): void {
    const pool = MK_BREED_POOL_8.slice();
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = pool[i];
        pool[i] = pool[j];
        pool[j] = t;
    }
    st.breedPool = pool;
    st.breedPoolIdx = 0;
}

function mkAssignBreedIfNeeded(st: MkMatchState, seat: number): string {
    if (st.breeds[seat] && st.breeds[seat].length > 0) {
        return st.breeds[seat];
    }
    if (st.breedPoolIdx < 0) {
        st.breedPoolIdx = 0;
    }
    if (st.breedPoolIdx >= st.breedPool.length) {
        return "";
    }
    const g = st.breedPool[st.breedPoolIdx] || "";
    st.breedPoolIdx++;
    st.breeds[seat] = g;
    return g;
}

function mkConfirmAllAiBreeds(st: MkMatchState): boolean {
    if (st.pickStage !== "breed") {
        return false;
    }
    let anyHumanPicked = false;
    let humanSeats = 0;
    for (let s = 0; s < st.playerCount; s++) {
        if (!mkSeatActsAsAi(st, s)) {
            humanSeats++;
            if (st.breedConfirmed[s]) {
                anyHumanPicked = true;
            }
        }
    }
    if (humanSeats > 0 && !anyHumanPicked) {
        return false;
    }
    let changed = false;
    for (let s = 0; s < st.playerCount; s++) {
        if (mkSeatActsAsAi(st, s) && !st.breedConfirmed[s]) {
            const g = mkAssignBreedIfNeeded(st, s);
            st.breedConfirmed[s] = true;
            mkPushEvent(st, mkSeatDisplayName(st, s) + " 已抽取猫种：" + mkBreedNameZh(g));
            changed = true;
        }
    }
    return changed;
}

/** 杀可达（毛线球无视距离；猫爬架 +1） */
function mkMkAttackRangeOk(st: MkMatchState, attacker: number, target: number): boolean {
    const dist = mkRulesRingDistance(attacker, target, st.playerCount);
    const ew = st.equippedWeapon[attacker];
    if (ew >= 0 && mkRulesEquipIgnoresDistance(ew)) {
        return true;
    }
    let rng = mkRulesDefaultAttackRange();
    if (ew >= 0) {
        rng += mkRulesEquipBonusRange(ew);
    }
    return dist <= rng;
}

/** 人类出牌 / AI 出牌后统一节拍，避免 AI 同一帧连动 */
function mkBumpPlayPaceDeadline(st: MkMatchState): void {
    st.aiPlayDelayUntilMs = Date.now() + MK_AI_PLAY_PACE_MS;
}

function mkBroadcastState(
    dispatcher: nkruntime.MatchDispatcher,
    st: MkMatchState,
    logger: nkruntime.Logger,
    reason: string
): void {
    st.seq++;
    const base = mkBuildSnapshotBase(st);
    const presList: nkruntime.Presence[] = [];
    for (const uid in st.presences) {
        if (st.presences.hasOwnProperty(uid)) {
            presList.push(st.presences[uid]);
        }
    }
    for (let i = 0; i < presList.length; i++) {
        const p = presList[i];
        const seat = mkSeatForUser(st, p.userId);
        const packet: { [k: string]: any } = {};
        for (const k in base) {
            if (base.hasOwnProperty(k)) {
                packet[k] = base[k];
            }
        }
        packet["self_seat"] = seat;
        const handSlice =
            seat >= 0 && seat < st.playerCount ? st.hands[seat].slice() : [];
        packet["self_hand"] = handSlice.map(function (cid: number) {
            return Math.floor(cid);
        });
        packet["self_hand_count"] = handSlice.length;
        if (st.phase === "picking_identity" && seat >= 0 && seat < st.playerCount) {
            packet["self_role"] = st.identities[seat];
        } else {
            packet["self_role"] =
                seat >= 0 && seat < st.playerCount && st.identityConfirmed[seat] === true
                    ? st.identities[seat]
                    : -1;
        }
        packet["self_general_id"] =
            seat >= 0 && seat < st.playerCount && st.breedConfirmed[seat] === true ? st.breeds[seat] : "";
        if (seat < 0) {
            logger.warn("meow_kill broadcast: no seat for userId=%s reason=%s", p.userId, reason);
        }
        try {
            dispatcher.broadcastMessage(MK_OP_SNAPSHOT, JSON.stringify(packet), [p], null);
        } catch (e) {
            logger.warn("meow_kill broadcast to %s failed: %s", p.userId, String(e));
        }
    }
    if (presList.length === 0) {
        const packet: { [k: string]: any } = {};
        for (const k in base) {
            if (base.hasOwnProperty(k)) {
                packet[k] = base[k];
            }
        }
        packet["self_seat"] = -1;
        packet["self_hand"] = [];
        packet["self_hand_count"] = 0;
        packet["self_role"] = -1;
        packet["self_general_id"] = "";
        try {
            dispatcher.broadcastMessage(MK_OP_SNAPSHOT, JSON.stringify(packet), null, null);
        } catch (e) {
            logger.warn("meow_kill broadcast (no presence) failed: %s", String(e));
        }
    }
    logger.debug("meow_kill snapshot seq=%d reason=%s", st.seq, reason);
}

function mkPublicRoleForSeat(st: MkMatchState, seat: number): number | null {
    if (seat < 0 || seat >= st.playerCount) {
        return null;
    }
    if (st.phase === "picking_identity") {
        return null;
    }
    if (st.phase === "finished") {
        return st.identities[seat];
    }
    if (!st.alive[seat]) {
        return st.identities[seat];
    }
    if (seat === st.lordSeat) {
        return MK_ROLE_HOUSE;
    }
    return null;
}

function mkBuildSnapshotBase(st: MkMatchState): { [k: string]: any } {
    const seatsLobby: { seat: number; user_id: string; username: string; is_ai: boolean }[] = [];
    for (let s = 0; s < st.playerCount; s++) {
        const uid = st.seatUserIds[s] || "";
        let username = "";
        if (uid && st.presences[uid]) {
            username = st.presences[uid].username || "";
        }
        const isAi = st.isAiSeat[s] === true;
        if (isAi && username === "") {
            username = "牌手";
        }
        seatsLobby.push({ seat: s, user_id: uid, username: username, is_ai: isAi });
    }
    const idConf: boolean[] = [];
    for (let s = 0; s < st.playerCount; s++) {
        idConf.push(st.identityConfirmed[s] === true);
    }
    const players: { [k: string]: any }[] = [];
    for (let s = 0; s < st.playerCount; s++) {
        const rp = mkPublicRoleForSeat(st, s);
        players.push({
            seat: s,
            hp: st.hp[s],
            max_hp: st.maxHp[s],
            alive: st.alive[s],
            hand_count: st.hands[s].length,
            equipped_weapon: st.equippedWeapon[s],
            role_public: rp,
            identity_confirmed: st.identityConfirmed[s] === true,
            breed_confirmed: st.breedConfirmed[s] === true,
            general_id: st.breedConfirmed[s] === true ? st.breeds[s] : "",
            general_name:
                st.breedConfirmed[s] === true && st.breeds[s] ? mkBreedNameZh(st.breeds[s]) : "",
            is_ai: st.isAiSeat[s],
            user_id: st.seatUserIds[s] || "",
            username: seatsLobby[s].username,
        });
    }
    return {
        v: 2,
        seq: st.seq,
        phase: st.phase,
        player_count: st.playerCount,
        expect_humans: st.expectHumans,
        ai_count: st.aiCount,
        seats: seatsLobby,
        players: players,
        identity_confirmed: idConf,
        pick_stage: st.pickStage,
        lord_seat: st.phase === "picking_identity" ? -1 : st.lordSeat,
        turn_seat: st.turnSeat,
        sub_phase: st.subPhase,
        sha_used: st.shaUsedThisTurn,
        pending: st.pending,
        winner: st.winner,
        winner_label_zh: mkRulesWinnerLabelZh(st.winner),
        roles_fully_revealed: st.phase === "finished",
        deck_count: st.deck.length,
        discard_count: st.discard.length,
        event_log: st.eventLog.slice(),
        ai_delegate: (function (): boolean[] {
            const ad: boolean[] = [];
            for (let s = 0; s < st.playerCount; s++) {
                ad.push(st.aiDelegate[s] === true);
            }
            return ad;
        })(),
    };
}

function mkReshuffleDeckFromDiscard(st: MkMatchState, nk: nkruntime.Nakama): void {
    if (st.discard.length === 0) {
        return;
    }
    st.deck = st.discard.slice();
    st.discard = [];
    shuffleInPlace(nk, st.deck);
}

function mkDrawForSeat(st: MkMatchState, nk: nkruntime.Nakama, seat: number, count: number): void {
    const row = st.hands[seat];
    const next: number[] = [];
    for (let i = 0; i < row.length; i++) {
        next.push(Math.floor(Number(row[i])));
    }
    for (let i = 0; i < count; i++) {
        if (st.deck.length === 0) {
            mkReshuffleDeckFromDiscard(st, nk);
        }
        if (st.deck.length === 0) {
            break;
        }
        const c = st.deck.pop();
        if (c !== undefined) {
            next.push(Math.floor(Number(c)));
        }
    }
    st.hands[seat] = next;
}

function mkBeginTurn(st: MkMatchState, nk: nkruntime.Nakama): void {
    st.subPhase = "play";
    st.shaUsedThisTurn = false;
    mkDrawForSeat(st, nk, st.turnSeat, 2);
    mkPushEvent(st, mkSeatDisplayName(st, st.turnSeat) + " 摸牌阶段：摸 2 张");
}

/** 三国杀流程：洗牌发身份 → 全员「抽取/确认」身份 → 再发游戏牌并主公先动（起始 4 张 + 主公摸牌阶段 2 张）。 */
function mkBeginIdentityPhase(
    st: MkMatchState,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    logger: nkruntime.Logger
): void {
    if (st.phase !== "lobby") {
        return;
    }
    const n = st.playerCount;
    const pack = mkRulesIdentityPack(n);
    const perm: number[] = [];
    for (let i = 0; i < n; i++) {
        perm.push(i);
    }
    shuffleInPlace(nk, perm);
    for (let s = 0; s < n; s++) {
        st.identities[s] = pack[perm[s]];
        st.identityConfirmed[s] = false;
        st.alive[s] = true;
        st.hp[s] = 4;
        st.maxHp[s] = 4;
        st.equippedWeapon[s] = -1;
        st.hands[s] = [];
    }
    st.lordSeat = -1;
    for (let s = 0; s < n; s++) {
        if (st.identities[s] === MK_ROLE_HOUSE) {
            st.lordSeat = s;
            break;
        }
    }
    if (st.lordSeat >= 0 && st.lordSeat < n) {
        st.maxHp[st.lordSeat] = 5;
        st.hp[st.lordSeat] = 5;
    }
    st.deck = [];
    st.discard = [];
    st.pending = null;
    st.winner = null;
    st.turnSeat = -1;
    st.shaUsedThisTurn = false;
    st.subPhase = "play";
    st.phase = "picking_identity";
    st.pickStage = "identity";
    mkPrepareBreedPool(st, nk);
    st.breedPoolIdx = 0;
    st.eventLog = [];
    st.aiPlayDelayUntilMs = 0;
    for (let s = 0; s < n; s++) {
        st.breedConfirmed[s] = false;
        st.breeds[s] = "";
    }
    mkPushEvent(st, "请在桌面中央先抽取身份牌并确认。");
    mkBroadcastState(dispatcher, st, logger, "identity-phase");
}

function mkBeginDealAndFirstTurn(
    st: MkMatchState,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    logger: nkruntime.Logger
): void {
    const n = st.playerCount;
    st.deck = mkRulesBuildDeck();
    shuffleInPlace(nk, st.deck);
    st.discard = [];
    for (let s = 0; s < n; s++) {
        mkDrawForSeat(st, nk, s, 4);
    }
    mkPushEvent(st, "发起始手牌：每名角色摸 4 张");
    st.phase = "playing";
    st.pending = null;
    st.winner = null;
    st.turnSeat = st.lordSeat >= 0 ? st.lordSeat : 0;
    mkBeginTurn(st, nk);
    let handTotal = 0;
    for (let s = 0; s < n; s++) {
        handTotal += st.hands[s].length;
    }
    logger.info(
        "meow_kill deal-start: n=%d deck_left=%d hand_total=%d lord=%d turn=%d",
        n,
        st.deck.length,
        handTotal,
        st.lordSeat,
        st.turnSeat
    );
    mkBroadcastState(dispatcher, st, logger, "deal-start");
    if (st.turnSeat >= 0 && st.turnSeat < st.playerCount && mkSeatActsAsAi(st, st.turnSeat)) {
        mkBumpPlayPaceDeadline(st);
    }
}

function mkTryAdvanceFromIdentityPhase(
    st: MkMatchState,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    logger: nkruntime.Logger
): void {
    if (st.phase !== "picking_identity") {
        return;
    }
    if (st.pickStage === "identity") {
        for (let s = 0; s < st.playerCount; s++) {
            if (!st.identityConfirmed[s]) {
                return;
            }
        }
        st.pickStage = "breed";
        mkPushEvent(st, "身份确认完成，请抽取猫咪种类。");
        mkBroadcastState(dispatcher, st, logger, "pick-breed-stage");
        return;
    }
    for (let s = 0; s < st.playerCount; s++) {
        if (!st.breedConfirmed[s]) {
            return;
        }
    }
    mkBeginDealAndFirstTurn(st, nk, dispatcher, logger);
}

function mkConfirmAllAiIdentities(st: MkMatchState): boolean {
    if (st.pickStage !== "identity") {
        return false;
    }
    let changed = false;
    for (let s = 0; s < st.playerCount; s++) {
        if ((st.isAiSeat[s] || st.aiDelegate[s]) && !st.identityConfirmed[s]) {
            st.identityConfirmed[s] = true;
            mkPushEvent(st, mkSeatDisplayName(st, s) + " 已确认身份");
            changed = true;
        }
    }
    return changed;
}

function mkApplyConfirmIdentity(st: MkMatchState, seat: number): string | null {
    if (st.phase !== "picking_identity") {
        return "bad_phase";
    }
    if (st.pickStage !== "identity") {
        return "bad_pick_stage";
    }
    if (seat < 0 || seat >= st.playerCount) {
        return "bad_seat";
    }
    if (st.identityConfirmed[seat]) {
        return "already_confirmed";
    }
    st.identityConfirmed[seat] = true;
    mkPushEvent(st, mkSeatDisplayName(st, seat) + " 已确认身份");
    return null;
}

function mkApplyConfirmBreed(st: MkMatchState, seat: number): string | null {
    if (st.phase !== "picking_identity") {
        return "bad_phase";
    }
    if (st.pickStage !== "breed") {
        return "bad_pick_stage";
    }
    if (seat < 0 || seat >= st.playerCount) {
        return "bad_seat";
    }
    if (st.breedConfirmed[seat]) {
        return "already_confirmed";
    }
    const g = mkAssignBreedIfNeeded(st, seat);
    if (!g) {
        return "no_breed_left";
    }
    st.breedConfirmed[seat] = true;
    mkPushEvent(st, mkSeatDisplayName(st, seat) + " 已抽取猫种：" + mkBreedNameZh(g));
    return null;
}

function mkApplyDelegate(st: MkMatchState, seat: number, on: boolean): string | null {
    if (seat < 0 || seat >= st.playerCount) {
        return "bad_seat";
    }
    if (st.isAiSeat[seat]) {
        return "ai_seat_no_delegate";
    }
    st.aiDelegate[seat] = on;
    mkPushEvent(st, mkSeatDisplayName(st, seat) + (on ? " 开启 AI 托管" : " 取消 AI 托管"));
    return null;
}

function mkAdvanceTurn(st: MkMatchState, nk: nkruntime.Nakama): void {
    const n = st.playerCount;
    let s = st.turnSeat;
    for (let k = 0; k < n + 2; k++) {
        s = (s + 1) % n;
        if (st.alive[s]) {
            st.turnSeat = s;
            mkBeginTurn(st, nk);
            return;
        }
    }
}

function mkCheckWin(st: MkMatchState, lastVictim: number, killerSeat: number): void {
    if (st.phase === "finished") {
        return;
    }
    const n = st.playerCount;

    if (st.lordSeat >= 0 && !st.alive[st.lordSeat]) {
        let wildAlive = false;
        for (let s = 0; s < n; s++) {
            if (st.alive[s] && st.identities[s] === MK_ROLE_WILD) {
                wildAlive = true;
                break;
            }
        }
        if (wildAlive) {
            st.winner = "wild";
        } else if (
            killerSeat >= 0 &&
            killerSeat < n &&
            st.identities[killerSeat] === MK_ROLE_LONE &&
            lastVictim === st.lordSeat
        ) {
            st.winner = "lone";
        } else {
            st.winner = "wild";
        }
        st.phase = "finished";
        st.pending = null;
        mkPushEvent(st, "游戏结束：" + mkRulesWinnerLabelZh(st.winner));
        return;
    }

    let foeAlive = false;
    for (let s = 0; s < n; s++) {
        if (!st.alive[s]) {
            continue;
        }
        const r = st.identities[s];
        if (r === MK_ROLE_WILD || r === MK_ROLE_LONE) {
            foeAlive = true;
            break;
        }
    }
    if (!foeAlive) {
        st.winner = "house";
        st.phase = "finished";
        st.pending = null;
        mkPushEvent(st, "游戏结束：" + mkRulesWinnerLabelZh(st.winner));
    }
}

function mkResolveDeath(st: MkMatchState, seat: number, nk: nkruntime.Nakama): void {
    const killerSeat = st.lastDamageSourceSeat;
    st.pending = null;
    mkPushEvent(
        st,
        mkSeatDisplayName(st, seat) + " 阵亡，身份：" + mkRulesRoleNameZh(st.identities[seat])
    );
    for (let i = 0; i < st.hands[seat].length; i++) {
        st.discard.push(st.hands[seat][i]);
    }
    st.hands[seat] = [];
    if (st.equippedWeapon[seat] >= 0) {
        st.discard.push(st.equippedWeapon[seat]);
        st.equippedWeapon[seat] = -1;
    }
    st.alive[seat] = false;
    st.hp[seat] = 0;
    mkCheckWin(st, seat, killerSeat);
    if (st.phase === "playing" && st.winner === null) {
        const ts = st.turnSeat;
        if (ts < 0 || ts >= st.playerCount || !st.alive[ts]) {
            mkAdvanceTurn(st, nk);
        }
    }
}

/** 濒死求桃：从当前回合角色起按行动顺序询问（含濒死者本人在轮到其顺序时可自救）。 */
function mkDyingAskOrder(st: MkMatchState, _victim: number): number[] {
    const n = st.playerCount;
    const out: number[] = [];
    const start = st.turnSeat >= 0 && st.turnSeat < n ? st.turnSeat : 0;
    for (let k = 0; k < n; k++) {
        const s = (start + k) % n;
        if (st.alive[s]) {
            out.push(s);
        }
    }
    return out;
}

function mkStartDying(st: MkMatchState, victim: number, nk: nkruntime.Nakama): void {
    if (st.hp[victim] > 0) {
        return;
    }
    const order = mkDyingAskOrder(st, victim);
    if (order.length === 0) {
        mkResolveDeath(st, victim, nk);
        return;
    }
    st.pending = { kind: "dying", seat: victim, askIdx: 0, askOrder: order };
    mkPushEvent(st, mkSeatDisplayName(st, victim) + " 濒死（依次询问是否出桃）");
}

function mkApplyDamage(st: MkMatchState, victim: number, source: number, nk: nkruntime.Nakama): void {
    st.lastDamageSourceSeat = source;
    st.hp[victim]--;
    if (st.hp[victim] < 0) {
        st.hp[victim] = 0;
    }
    if (st.hp[victim] <= 0) {
        mkStartDying(st, victim, nk);
    }
}

function mkApplyPlayCard(
    st: MkMatchState,
    seat: number,
    handIndex: number,
    targetSeat: number,
    nk: nkruntime.Nakama
): string | null {
    if (st.phase !== "playing" || st.winner) {
        return "bad_phase";
    }
    if (mkPendingIsActive(st)) {
        return "pending_response";
    }
    if (seat !== st.turnSeat || st.subPhase !== "play") {
        return "not_your_turn";
    }
    const hand = st.hands[seat];
    if (handIndex < 0 || handIndex >= hand.length) {
        return "bad_hand_index";
    }
    const cid = hand[handIndex];
    const key = mkRulesCardKey(cid);
    if (key === "peach") {
        if (st.hp[seat] >= st.maxHp[seat]) {
            return "peach_full_hp";
        }
        hand.splice(handIndex, 1);
        st.discard.push(cid);
        st.hp[seat]++;
        mkPushEvent(
            st,
            mkSeatDisplayName(st, seat) + " 使用「" + mkRulesCardLabelZh(cid) + "」，回复 1 体力"
        );
        return null;
    }
    if (key === "equip_ball" || key === "equip_weapon") {
        hand.splice(handIndex, 1);
        const prev = st.equippedWeapon[seat];
        if (prev >= 0) {
            st.discard.push(prev);
        }
        st.equippedWeapon[seat] = cid;
        mkPushEvent(
            st,
            mkSeatDisplayName(st, seat) + " 装备了「" + mkRulesCardLabelZh(cid) + "」"
        );
        return null;
    }
    if (key === "slash") {
        if (st.shaUsedThisTurn) {
            return "sha_already_used";
        }
        if (targetSeat < 0 || targetSeat >= st.playerCount || !st.alive[targetSeat]) {
            return "bad_target";
        }
        if (targetSeat === seat) {
            return "cannot_target_self";
        }
        if (!mkMkAttackRangeOk(st, seat, targetSeat)) {
            return "out_of_range";
        }
        hand.splice(handIndex, 1);
        st.discard.push(cid);
        st.shaUsedThisTurn = true;
        st.pending = { kind: "jink", attacker: seat, victim: targetSeat, card_id: cid };
        mkPushEvent(
            st,
            mkSeatDisplayName(st, seat) +
                " 使用「杀」→ " +
                mkSeatDisplayName(st, targetSeat)
        );
        return null;
    }
    return "card_not_playable";
}

function mkApplyRespondJink(
    st: MkMatchState,
    victimSeat: number,
    use: boolean,
    handIndex: number,
    nk: nkruntime.Nakama
): string | null {
    if (st.pending === null || st.pending.kind !== "jink") {
        return "no_pending_jink";
    }
    if (st.pending.victim !== victimSeat) {
        return "not_jink_responder";
    }
    const attacker = st.pending.attacker;
    const victim = st.pending.victim;
    if (!use) {
        st.pending = null;
        mkPushEvent(st, mkSeatDisplayName(st, victim) + " 未出闪，受到 1 点伤害");
        mkApplyDamage(st, victim, attacker, nk);
        return null;
    }
    const hand = st.hands[victimSeat];
    if (handIndex < 0 || handIndex >= hand.length) {
        return "bad_hand_index";
    }
    const cid = hand[handIndex];
    if (mkRulesCardKey(cid) !== "jink") {
        return "need_jink";
    }
    hand.splice(handIndex, 1);
    st.discard.push(cid);
    st.pending = null;
    mkPushEvent(st, mkSeatDisplayName(st, victimSeat) + " 使用「闪」抵消");
    return null;
}

function mkApplyEndPlay(st: MkMatchState, seat: number, nk: nkruntime.Nakama): string | null {
    if (st.phase !== "playing" || st.winner) {
        return "bad_phase";
    }
    if (mkPendingIsActive(st)) {
        return "pending_response";
    }
    if (seat !== st.turnSeat || st.subPhase !== "play") {
        return "not_your_turn";
    }
    if (st.hands[seat].length <= st.hp[seat]) {
        mkPushEvent(st, mkSeatDisplayName(st, seat) + " 结束出牌阶段（无需弃牌）");
        mkAdvanceTurn(st, nk);
        return null;
    }
    mkPushEvent(st, mkSeatDisplayName(st, seat) + " 结束出牌阶段 → 弃牌阶段");
    st.subPhase = "discard";
    return null;
}

function mkApplyDiscard(st: MkMatchState, seat: number, indices: number[], nk: nkruntime.Nakama): string | null {
    if (st.phase !== "playing" || st.winner) {
        return "bad_phase";
    }
    if (seat !== st.turnSeat || st.subPhase !== "discard") {
        return "not_discard_phase";
    }
    const hand = st.hands[seat];
    const sorted = indices.slice().sort(function (a, b) {
        return b - a;
    });
    for (let i = 0; i < sorted.length; i++) {
        const idx = sorted[i];
        if (idx < 0 || idx >= hand.length) {
            return "bad_hand_index";
        }
    }
    const parts: string[] = [];
    for (let i = 0; i < sorted.length; i++) {
        const idx = sorted[i];
        parts.push(mkRulesCardLabelZh(hand[idx]));
    }
    for (let i = 0; i < sorted.length; i++) {
        const idx = sorted[i];
        const c = hand[idx];
        hand.splice(idx, 1);
        st.discard.push(c);
    }
    mkPushEvent(
        st,
        mkSeatDisplayName(st, seat) + " 弃牌阶段：弃置 " + parts.join("、")
    );
    if (st.hands[seat].length <= st.hp[seat]) {
        st.subPhase = "play";
        mkAdvanceTurn(st, nk);
        return null;
    }
    return null;
}

function mkApplyPeachDying(st: MkMatchState, fromSeat: number, handIndex: number): string | null {
    if (st.pending === null || st.pending.kind !== "dying") {
        return "no_pending_dying";
    }
    const p = st.pending;
    if (p.askIdx >= p.askOrder.length) {
        return "dying_done";
    }
    if (p.askOrder[p.askIdx] !== fromSeat) {
        return "not_your_turn_save";
    }
    const victim = p.seat;
    const hand = st.hands[fromSeat];
    if (handIndex < 0 || handIndex >= hand.length) {
        return "bad_hand_index";
    }
    const cid = hand[handIndex];
    if (mkRulesCardKey(cid) !== "peach") {
        return "need_peach";
    }
    hand.splice(handIndex, 1);
    st.discard.push(cid);
    st.hp[victim]++;
    mkPushEvent(
        st,
        mkSeatDisplayName(st, fromSeat) + " 使用「桃」救 " + mkSeatDisplayName(st, victim)
    );
    if (st.hp[victim] > 0) {
        st.pending = null;
    }
    return null;
}

function mkApplyPassDying(st: MkMatchState, fromSeat: number, nk: nkruntime.Nakama): string | null {
    if (st.pending === null || st.pending.kind !== "dying") {
        return "no_pending_dying";
    }
    const p = st.pending;
    if (p.askIdx >= p.askOrder.length) {
        return "dying_done";
    }
    if (p.askOrder[p.askIdx] !== fromSeat) {
        return "not_your_turn_save";
    }
    mkPushEvent(st, mkSeatDisplayName(st, fromSeat) + " 濒死阶段：不出桃");
    p.askIdx++;
    if (p.askIdx >= p.askOrder.length) {
        const v = p.seat;
        st.pending = null;
        mkResolveDeath(st, v, nk);
    }
    return null;
}

function mkAiPlayTurn(
    st: MkMatchState,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    logger: nkruntime.Logger
): void {
    if (st.phase !== "playing" || st.winner) {
        return;
    }
    if (mkPendingIsActive(st)) {
        return;
    }
    const seat = st.turnSeat;
    if (!mkSeatActsAsAi(st, seat)) {
        return;
    }
    if (st.subPhase === "discard") {
        const hand = st.hands[seat];
        const need = hand.length - st.hp[seat];
        if (need <= 0) {
            st.subPhase = "play";
            mkAdvanceTurn(st, nk);
            mkBroadcastState(dispatcher, st, logger, "ai-advance");
            mkBumpPlayPaceDeadline(st);
            return;
        }
        const toss = mkAiPickDiscardIndices(st, seat);
        mkApplyDiscard(st, seat, toss, nk);
        mkBroadcastState(dispatcher, st, logger, "ai-discard");
        mkBumpPlayPaceDeadline(st);
        return;
    }
    if (st.subPhase !== "play") {
        return;
    }
    const hand = st.hands[seat];
    let played = false;
    if (!st.shaUsedThisTurn) {
        const targetSeat = mkAiPickSlashTarget(st, seat);
        if (targetSeat >= 0) {
            const hi = mkAiFindFirstCardIndex(st, seat, "slash");
            if (hi >= 0) {
                const err = mkApplyPlayCard(st, seat, hi, targetSeat, nk);
                if (!err) {
                    played = true;
                }
            }
        }
    }
    if (!played) {
        for (let hi = 0; hi < hand.length; hi++) {
            const ck = mkRulesCardKey(hand[hi]);
            if (ck === "equip_ball" || ck === "equip_weapon") {
                const err = mkApplyPlayCard(st, seat, hi, seat, nk);
                if (!err) {
                    played = true;
                    break;
                }
            }
        }
    }
    if (!played) {
        for (let hi = 0; hi < hand.length; hi++) {
            if (mkRulesCardKey(hand[hi]) === "peach" && st.hp[seat] < st.maxHp[seat]) {
                const err = mkApplyPlayCard(st, seat, hi, seat, nk);
                if (!err) {
                    played = true;
                }
                break;
            }
        }
    }
    if (played) {
        mkBroadcastState(dispatcher, st, logger, "ai-play");
        mkBumpPlayPaceDeadline(st);
        return;
    }
    mkApplyEndPlay(st, seat, nk);
    mkBroadcastState(dispatcher, st, logger, "ai-end-play");
    mkBumpPlayPaceDeadline(st);
}

function mkAiRespondJink(
    st: MkMatchState,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    logger: nkruntime.Logger
): void {
    if (st.pending === null || st.pending.kind !== "jink") {
        return;
    }
    const v = st.pending.victim;
    if (!mkSeatActsAsAi(st, v)) {
        return;
    }
    if (mkAiShouldUseJink(st, v)) {
        const jidx = mkAiFindFirstCardIndex(st, v, "jink");
        if (jidx >= 0) {
            mkApplyRespondJink(st, v, true, jidx, nk);
        } else {
            mkApplyRespondJink(st, v, false, -1, nk);
        }
    } else {
        mkApplyRespondJink(st, v, false, -1, nk);
    }
    mkBroadcastState(dispatcher, st, logger, "ai-jink");
    mkBumpPlayPaceDeadline(st);
}

function mkAiRespondDying(
    st: MkMatchState,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    logger: nkruntime.Logger
): void {
    if (st.pending === null || st.pending.kind !== "dying") {
        return;
    }
    const p = st.pending;
    if (p.askIdx >= p.askOrder.length) {
        return;
    }
    const asker = p.askOrder[p.askIdx];
    if (!mkSeatActsAsAi(st, asker)) {
        return;
    }
    const victimSeat = p.seat;
    if (mkAiShouldPeachVictim(st, asker, victimSeat)) {
        const pidx = mkAiFindFirstCardIndex(st, asker, "peach");
        if (pidx >= 0) {
            mkApplyPeachDying(st, asker, pidx);
        } else {
            mkApplyPassDying(st, asker, nk);
        }
    } else {
        mkApplyPassDying(st, asker, nk);
    }
    mkBroadcastState(dispatcher, st, logger, "ai-dying");
    mkBumpPlayPaceDeadline(st);
}

function mkRunMeowAi(
    st: MkMatchState,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    logger: nkruntime.Logger
): void {
    if (st.phase !== "playing" || st.winner) {
        return;
    }
    if (Date.now() < st.aiPlayDelayUntilMs) {
        return;
    }
    if (st.pending && st.pending.kind === "jink") {
        mkAiRespondJink(st, nk, dispatcher, logger);
        return;
    }
    if (st.pending && st.pending.kind === "dying") {
        mkAiRespondDying(st, nk, dispatcher, logger);
        return;
    }
    mkAiPlayTurn(st, nk, dispatcher, logger);
}

function mkResetMatchGame(st: MkMatchState): void {
    st.pending = null;
    st.winner = null;
    st.aiPlayDelayUntilMs = 0;
    st.eventLog = [];
    st.turnSeat = -1;
    st.deck = [];
    st.discard = [];
    st.lordSeat = -1;
    st.shaUsedThisTurn = false;
    st.subPhase = "play";
    for (let s = 0; s < st.playerCount; s++) {
        st.hands[s] = [];
        st.identities[s] = 0;
        st.identityConfirmed[s] = false;
        st.breedConfirmed[s] = false;
        st.breeds[s] = "";
        st.alive[s] = true;
        st.hp[s] = 4;
        st.maxHp[s] = 4;
        st.equippedWeapon[s] = -1;
        st.aiDelegate[s] = false;
    }
    st.pickStage = "identity";
    st.breedPool = [];
    st.breedPoolIdx = 0;
}

function mkHandleGameMessage(
    st: MkMatchState,
    seat: number,
    op: number,
    raw: string,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    logger: nkruntime.Logger
): string | null {
    let payload: { [k: string]: any } = {};
    try {
        payload = raw.length > 0 ? (JSON.parse(raw) as { [k: string]: any }) : {};
    } catch (e) {
        return "bad_json";
    }
    if (op === MK_REQ_PLAY_CARD) {
        const hi = typeof payload.hand_index === "number" ? payload.hand_index : -1;
        const ts = typeof payload.target_seat === "number" ? payload.target_seat : -1;
        return mkApplyPlayCard(st, seat, hi, ts, nk);
    }
    if (op === MK_REQ_RESPOND_JINK) {
        const use = payload.use === true;
        const hi = typeof payload.hand_index === "number" ? payload.hand_index : -1;
        return mkApplyRespondJink(st, seat, use, hi, nk);
    }
    if (op === MK_REQ_END_PLAY) {
        return mkApplyEndPlay(st, seat, nk);
    }
    if (op === MK_REQ_DISCARD) {
        const arr = payload.hand_indices;
        const indices: number[] = Array.isArray(arr) ? (arr as number[]) : [];
        return mkApplyDiscard(st, seat, indices, nk);
    }
    if (op === MK_REQ_PEACH_DYING) {
        const hi = typeof payload.hand_index === "number" ? payload.hand_index : -1;
        return mkApplyPeachDying(st, seat, hi);
    }
    if (op === MK_REQ_PASS_DYING) {
        return mkApplyPassDying(st, seat, nk);
    }
    if (op === MK_REQ_CONFIRM_IDENTITY) {
        return mkApplyConfirmIdentity(st, seat);
    }
    if (op === MK_REQ_CONFIRM_BREED) {
        return mkApplyConfirmBreed(st, seat);
    }
    if (op === MK_REQ_DELEGATE) {
        const on = payload.on === true;
        return mkApplyDelegate(st, seat, on);
    }
    return "unknown_op";
}
