/**
 * 猫猫杀匹配：5 人 / 8 人两队列；满员即开；未满 10s 后 AI 补位。
 */

const MK_MM_WAIT_MS = 10000;
const MK_MM_COLLECTION = "meow_kill_mm";
const MK_MM_STATE_KEY = "queue_state";
const MK_MM_OWNER = "00000000-0000-0000-0000-000000000000";

interface MkMmQueueEntry {
    userId: string;
    username: string;
    joinedAtMs: number;
    ticket: string;
    /** 5 或 8 */
    tableSize: number;
}

interface MkMmPersistedState {
    entries5: MkMmQueueEntry[];
    entries8: MkMmQueueEntry[];
    results: { [ticket: string]: { matchId: string } };
}

function mkMmDefaultState(): MkMmPersistedState {
    return { entries5: [], entries8: [], results: {} };
}

function mkMmReviveEntry(raw: { [k: string]: unknown }): MkMmQueueEntry | null {
    if (!raw || typeof raw.userId !== "string" || typeof raw.ticket !== "string") {
        return null;
    }
    const tsRaw = raw.tableSize;
    const ts = tsRaw === 8 || tsRaw === "8" ? 8 : 5;
    return {
        userId: raw.userId,
        username: typeof raw.username === "string" ? raw.username : "",
        joinedAtMs: typeof raw.joinedAtMs === "number" ? raw.joinedAtMs : 0,
        ticket: raw.ticket,
        tableSize: ts,
    };
}

function mkMmRevive(raw: unknown): MkMmPersistedState {
    const clone = raw as {
        entries?: unknown;
        entries5?: unknown;
        entries8?: unknown;
        results?: unknown;
    };
    const entries5: MkMmQueueEntry[] = [];
    const entries8: MkMmQueueEntry[] = [];
    const pushArr = function (arr: unknown, defaultTable: number): void {
        if (!Array.isArray(arr)) {
            return;
        }
        for (let i = 0; i < arr.length; i++) {
            const e = mkMmReviveEntry(arr[i] as { [k: string]: unknown });
            if (!e) {
                continue;
            }
            const ts = e.tableSize === 8 ? 8 : defaultTable;
            const ent: MkMmQueueEntry = {
                userId: e.userId,
                username: e.username,
                joinedAtMs: e.joinedAtMs,
                ticket: e.ticket,
                tableSize: ts,
            };
            if (ts === 8) {
                entries8.push(ent);
            } else {
                entries5.push(ent);
            }
        }
    };
    if (Array.isArray(clone.entries5)) {
        pushArr(clone.entries5, 5);
    }
    if (Array.isArray(clone.entries8)) {
        pushArr(clone.entries8, 8);
    }
    if (Array.isArray(clone.entries)) {
        pushArr(clone.entries, 5);
    }
    const results: { [k: string]: { matchId: string } } = {};
    if (clone.results && typeof clone.results === "object" && clone.results !== null) {
        const rawR = clone.results as { [k: string]: unknown };
        for (const k in rawR) {
            if (rawR.hasOwnProperty(k)) {
                const r = rawR[k] as { matchId?: unknown };
                if (r && typeof r.matchId === "string") {
                    results[k] = { matchId: r.matchId };
                }
            }
        }
    }
    return { entries5: entries5, entries8: entries8, results: results };
}

function mkMmToValue(state: MkMmPersistedState): { [key: string]: any } {
    return {
        entries5: state.entries5,
        entries8: state.entries8,
        results: state.results,
    };
}

function mkMmMakeTicket(nk: nkruntime.Nakama): string {
    const u = randomBytesCompat(nk, 8);
    const hex = Array.prototype.map
        .call(u, function (x: number) {
            return ("0" + x.toString(16)).slice(-2);
        })
        .join("");
    return "mkmm_" + Date.now().toString(36) + "_" + hex;
}

function mkMmMutateState(
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    mutator: (state: MkMmPersistedState) => void
): void {
    mutateGlobalStorage(
        nk,
        logger,
        MK_MM_COLLECTION,
        MK_MM_STATE_KEY,
        MK_MM_OWNER,
        mkMmDefaultState,
        mkMmRevive,
        mkMmToValue,
        mutator,
        "meow_kill_mm"
    );
}

function mkMmNotifyResults(state: MkMmPersistedState, tickets: string[], matchId: string): void {
    for (let i = 0; i < tickets.length; i++) {
        state.results[tickets[i]] = { matchId: matchId };
    }
}

function mkMmCreateMatchInner(
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    humans: number,
    ai: number,
    tableSize: number
): string | null {
    let id: string;
    try {
        id = nk.matchCreate("meow_kill", {
            expect_humans: String(humans),
            ai: String(ai),
            player_count: String(tableSize),
        });
    } catch (e) {
        logger.error("meow_kill_mm matchCreate: %s", String(e));
        return null;
    }
    if (!id || String(id).length === 0) {
        logger.error("meow_kill_mm matchCreate empty id");
        return null;
    }
    logger.info("meow_kill_mm: created match %s humans=%d ai=%d table=%d", id, humans, ai, tableSize);
    return id;
}

function mkMmProcessOneQueue(
    q: MkMmQueueEntry[],
    tableSize: number,
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    state: MkMmPersistedState
): MkMmQueueEntry[] {
    const now = Date.now();
    q.sort(function (a, b) {
        return a.joinedAtMs - b.joinedAtMs;
    });
    while (q.length >= tableSize) {
        const id = mkMmCreateMatchInner(nk, logger, tableSize, 0, tableSize);
        if (!id) {
            break;
        }
        const picked: MkMmQueueEntry[] = q.splice(0, tableSize);
        const tickets: string[] = [];
        for (let i = 0; i < picked.length; i++) {
            tickets.push(picked[i].ticket);
        }
        mkMmNotifyResults(state, tickets, id);
    }
    if (q.length >= 2 && q.length < tableSize) {
        const oldest = q[0].joinedAtMs;
        if (now - oldest >= MK_MM_WAIT_MS) {
            const humans = q.length;
            const ai = tableSize - humans;
            const id = mkMmCreateMatchInner(nk, logger, humans, ai, tableSize);
            if (id) {
                const tickets: string[] = [];
                for (let i = 0; i < humans; i++) {
                    tickets.push(q[i].ticket);
                }
                q.splice(0, humans);
                mkMmNotifyResults(state, tickets, id);
            }
        }
    }
    if (q.length === 1) {
        if (now - q[0].joinedAtMs >= MK_MM_WAIT_MS) {
            const id = mkMmCreateMatchInner(nk, logger, 1, tableSize - 1, tableSize);
            if (id) {
                mkMmNotifyResults(state, [q[0].ticket], id);
                q.splice(0, 1);
            }
        }
    }
    return q;
}

function mkMmProcessQueueCore(state: MkMmPersistedState, nk: nkruntime.Nakama, logger: nkruntime.Logger): void {
    state.entries5 = mkMmProcessOneQueue(state.entries5.slice(), 5, nk, logger, state);
    state.entries8 = mkMmProcessOneQueue(state.entries8.slice(), 8, nk, logger, state);
}

function rpcMeowKillMmJoin(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
    const uid = ctx.userId;
    if (!uid) {
        return rpcErr("unauthorized");
    }
    let tableSize = 5;
    try {
        const u = JSON.parse(payload || "{}");
        if (Number(u.table) === 8 || u.table === "8") {
            tableSize = 8;
        }
    } catch (e) {
        // default 5
    }
    let outTicket = "";
    try {
        mkMmMutateState(nk, logger, function (st: MkMmPersistedState) {
            const list5: MkMmQueueEntry[] = [];
            const list8: MkMmQueueEntry[] = [];
            for (let i = 0; i < st.entries5.length; i++) {
                if (st.entries5[i].userId !== uid) {
                    list5.push(st.entries5[i]);
                } else {
                    delete st.results[st.entries5[i].ticket];
                }
            }
            for (let i = 0; i < st.entries8.length; i++) {
                if (st.entries8[i].userId !== uid) {
                    list8.push(st.entries8[i]);
                } else {
                    delete st.results[st.entries8[i].ticket];
                }
            }
            st.entries5 = list5;
            st.entries8 = list8;
            const ticket = mkMmMakeTicket(nk);
            let username = "";
            try {
                const acc = nk.accountGetId(uid);
                if (acc && acc.user && acc.user.username) {
                    username = acc.user.username;
                }
            } catch (e) {
                logger.warn("meow_kill_mm accountGetId: %s", String(e));
            }
            const entry: MkMmQueueEntry = {
                userId: uid,
                username: username,
                joinedAtMs: Date.now(),
                ticket: ticket,
                tableSize: tableSize,
            };
            if (tableSize === 8) {
                st.entries8.push(entry);
            } else {
                st.entries5.push(entry);
            }
            outTicket = ticket;
        });
    } catch (e) {
        logger.error("meow_kill_mm join storage: %s", String(e));
        return rpcErr("storage_busy");
    }
    logger.info("meow_kill_mm join user=%s ticket=%s table=%d", uid, outTicket, tableSize);
    return rpcOk({ ticket: outTicket });
}

function rpcMeowKillMmPoll(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
    let ticket = "";
    try {
        const u = JSON.parse(payload || "{}");
        ticket = String(u.ticket || "");
    } catch (e) {
        return rpcErr("bad_payload");
    }
    if (!ticket) {
        return rpcErr("no_ticket");
    }
    let response = rpcOk({ status: "waiting" });
    try {
        mkMmMutateState(nk, logger, function (st: MkMmPersistedState) {
            mkMmProcessQueueCore(st, nk, logger);
            const r = st.results[ticket];
            if (r && r.matchId) {
                delete st.results[ticket];
                response = rpcOk({ status: "matched", match_id: r.matchId });
            }
        });
    } catch (e) {
        logger.error("meow_kill_mm poll storage: %s", String(e));
        return rpcErr("storage_busy");
    }
    return response;
}

function rpcMeowKillMmCancel(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
    let ticket = "";
    try {
        const u = JSON.parse(payload || "{}");
        ticket = String(u.ticket || "");
    } catch (e) {
        return JSON.stringify({ ok: false });
    }
    if (!ticket) {
        return JSON.stringify({ ok: false });
    }
    try {
        mkMmMutateState(nk, logger, function (st: MkMmPersistedState) {
            st.entries5 = st.entries5.filter(function (e) {
                return e.ticket !== ticket;
            });
            st.entries8 = st.entries8.filter(function (e) {
                return e.ticket !== ticket;
            });
            delete st.results[ticket];
        });
    } catch (e) {
        logger.error("meow_kill_mm cancel storage: %s", String(e));
        return rpcErr("storage_busy");
    }
    return rpcOk();
}
