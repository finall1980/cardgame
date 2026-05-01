/**
 * 掼蛋匹配队列（自建 RPC 版）。与 ddz/mm_queue 同策略：
 *   - 独立 Storage collection "guandan_mm"；
 *   - 4 人成局立即 matchCreate；
 *   - 2–3 人累计等待超过 GD_MM_WAIT_MS 用 AI 补位；
 *   - 1 人同样等待超时后开「1 真 + 3 AI」桌。
 */

const GD_MM_WAIT_MS = 10000;
const GD_MM_COLLECTION = "guandan_mm";
const GD_MM_STATE_KEY = "queue_state";
const GD_MM_OWNER = "00000000-0000-0000-0000-000000000000";

interface GdMmQueueEntry {
    userId: string;
    username: string;
    joinedAtMs: number;
    ticket: string;
}

interface GdMmPersistedState {
    entries: GdMmQueueEntry[];
    results: { [ticket: string]: { matchId: string } };
}

function gdMmDefaultState(): GdMmPersistedState {
    return { entries: [], results: {} };
}

function gdMmRevive(raw: unknown): GdMmPersistedState {
    const clone = raw as { entries?: unknown; results?: unknown };
    const entries: GdMmQueueEntry[] = [];
    if (Array.isArray(clone.entries)) {
        for (let i = 0; i < clone.entries.length; i++) {
            const e = clone.entries[i] as { [k: string]: unknown };
            if (e && typeof e.userId === "string" && typeof e.ticket === "string") {
                entries.push({
                    userId: e.userId,
                    username: typeof e.username === "string" ? e.username : "",
                    joinedAtMs: typeof e.joinedAtMs === "number" ? e.joinedAtMs : 0,
                    ticket: e.ticket,
                });
            }
        }
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
    return { entries: entries, results: results };
}

function gdMmToValue(state: GdMmPersistedState): { [key: string]: any } {
    return {
        entries: state.entries,
        results: state.results,
    };
}

function gdMmMakeTicket(nk: nkruntime.Nakama): string {
    const u = randomBytesCompat(nk, 8);
    const hex = Array.prototype.map
        .call(u, function (x: number) {
            return ("0" + x.toString(16)).slice(-2);
        })
        .join("");
    return "gdmm_" + Date.now().toString(36) + "_" + hex;
}

function gdMmMutateState(
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    mutator: (state: GdMmPersistedState) => void
): void {
    mutateGlobalStorage(
        nk,
        logger,
        GD_MM_COLLECTION,
        GD_MM_STATE_KEY,
        GD_MM_OWNER,
        gdMmDefaultState,
        gdMmRevive,
        gdMmToValue,
        mutator,
        "guandan_mm"
    );
}

function gdMmNotifyResults(state: GdMmPersistedState, tickets: string[], matchId: string): void {
    for (let i = 0; i < tickets.length; i++) {
        state.results[tickets[i]] = { matchId: matchId };
    }
}

function gdMmCreateMatchInner(
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    humans: number,
    ai: number
): string | null {
    let id: string;
    try {
        id = nk.matchCreate("guandan", {
            expect_humans: String(humans),
            ai: String(ai),
        });
    } catch (e) {
        logger.error("guandan_mm matchCreate: %s", String(e));
        return null;
    }
    if (!id || String(id).length === 0) {
        logger.error("guandan_mm matchCreate empty id");
        return null;
    }
    logger.info("guandan_mm: created match %s humans=%d ai=%d", id, humans, ai);
    return id;
}

function gdMmProcessQueueCore(state: GdMmPersistedState, nk: nkruntime.Nakama, logger: nkruntime.Logger): void {
    const now = Date.now();
    const q = state.entries.slice();
    q.sort(function (a, b) {
        return a.joinedAtMs - b.joinedAtMs;
    });
    while (q.length >= 4) {
        const a = q[0];
        const b = q[1];
        const c = q[2];
        const d = q[3];
        const id = gdMmCreateMatchInner(nk, logger, 4, 0);
        if (!id) {
            break;
        }
        q.splice(0, 4);
        gdMmNotifyResults(state, [a.ticket, b.ticket, c.ticket, d.ticket], id);
    }
    // 2–3 人等待超过窗口 → AI 补位
    if (q.length >= 2 && q.length < 4) {
        const oldest = q[0].joinedAtMs;
        if (now - oldest >= GD_MM_WAIT_MS) {
            const humans = q.length;
            const ai = 4 - humans;
            const id = gdMmCreateMatchInner(nk, logger, humans, ai);
            if (id) {
                const tickets: string[] = [];
                for (let i = 0; i < humans; i++) {
                    tickets.push(q[i].ticket);
                }
                q.splice(0, humans);
                gdMmNotifyResults(state, tickets, id);
            }
        }
    }
    if (q.length === 1) {
        if (now - q[0].joinedAtMs >= GD_MM_WAIT_MS) {
            const id = gdMmCreateMatchInner(nk, logger, 1, 3);
            if (id) {
                gdMmNotifyResults(state, [q[0].ticket], id);
                q.splice(0, 1);
            }
        }
    }
    state.entries = q;
}

function rpcGuandanMmJoin(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
    const uid = ctx.userId;
    if (!uid) {
        return rpcErr("unauthorized");
    }
    let outTicket = "";
    try {
        gdMmMutateState(nk, logger, function (st: GdMmPersistedState) {
            const nextEntries: GdMmQueueEntry[] = [];
            for (let i = 0; i < st.entries.length; i++) {
                if (st.entries[i].userId !== uid) {
                    nextEntries.push(st.entries[i]);
                } else {
                    delete st.results[st.entries[i].ticket];
                }
            }
            const ticket = gdMmMakeTicket(nk);
            let username = "";
            try {
                const acc = nk.accountGetId(uid);
                if (acc && acc.user && acc.user.username) {
                    username = acc.user.username;
                }
            } catch (e) {
                logger.warn("guandan_mm accountGetId: %s", String(e));
            }
            nextEntries.push({
                userId: uid,
                username: username,
                joinedAtMs: Date.now(),
                ticket: ticket,
            });
            st.entries = nextEntries;
            outTicket = ticket;
        });
    } catch (e) {
        logger.error("guandan_mm join storage: %s", String(e));
        return rpcErr("storage_busy");
    }
    logger.info("guandan_mm join user=%s ticket=%s", uid, outTicket);
    return rpcOk({ ticket: outTicket });
}

function rpcGuandanMmPoll(
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
        gdMmMutateState(nk, logger, function (st: GdMmPersistedState) {
            gdMmProcessQueueCore(st, nk, logger);
            const r = st.results[ticket];
            if (r && r.matchId) {
                delete st.results[ticket];
                response = rpcOk({ status: "matched", match_id: r.matchId });
            }
        });
    } catch (e) {
        logger.error("guandan_mm poll storage: %s", String(e));
        return rpcErr("storage_busy");
    }
    return response;
}

function rpcGuandanMmCancel(
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
        gdMmMutateState(nk, logger, function (st: GdMmPersistedState) {
            const next: GdMmQueueEntry[] = [];
            for (let i = 0; i < st.entries.length; i++) {
                if (st.entries[i].ticket !== ticket) {
                    next.push(st.entries[i]);
                }
            }
            st.entries = next;
            delete st.results[ticket];
        });
    } catch (e) {
        logger.error("guandan_mm cancel storage: %s", String(e));
        return rpcErr("storage_busy");
    }
    return rpcOk();
}
