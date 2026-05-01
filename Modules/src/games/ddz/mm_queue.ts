const DDZ_MM_WAIT_MS = 10000;

interface DdzMmQueueEntry {
    userId: string;
    username: string;
    joinedAtMs: number;
    ticket: string;
}

interface DdzMmPersistedState {
    entries: DdzMmQueueEntry[];
    results: { [ticket: string]: { matchId: string } };
}

const DDZ_MM_COLLECTION = "ddz_mm";
const DDZ_MM_STATE_KEY = "queue_state";
const DDZ_MM_OWNER = "00000000-0000-0000-0000-000000000000";

function ddzMmDefaultState(): DdzMmPersistedState {
    return { entries: [], results: {} };
}

function ddzMmRevive(raw: unknown): DdzMmPersistedState {
    const clone = raw as { entries?: unknown; results?: unknown };
    const entries: DdzMmQueueEntry[] = [];
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

function ddzMmToValue(state: DdzMmPersistedState): { [key: string]: any } {
    return {
        entries: state.entries,
        results: state.results,
    };
}

function ddzMmMakeTicket(nk: nkruntime.Nakama): string {
    const u = randomBytesCompat(nk, 8);
    const hex = Array.prototype.map
        .call(u, function (x: number) {
            return ("0" + x.toString(16)).slice(-2);
        })
        .join("");
    return "ddzmm_" + Date.now().toString(36) + "_" + hex;
}

function ddzMmMutateState(
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    mutator: (state: DdzMmPersistedState) => void
): void {
    mutateGlobalStorage(
        nk,
        logger,
        DDZ_MM_COLLECTION,
        DDZ_MM_STATE_KEY,
        DDZ_MM_OWNER,
        ddzMmDefaultState,
        ddzMmRevive,
        ddzMmToValue,
        mutator,
        "ddz_mm"
    );
}

function ddzMmNotifyResults(state: DdzMmPersistedState, tickets: string[], matchId: string): void {
    for (let i = 0; i < tickets.length; i++) {
        state.results[tickets[i]] = { matchId: matchId };
    }
}

function ddzMmCreateMatchInner(
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    entries: DdzMmQueueEntry[],
    humans: number,
    ai: number
): string | null {
    let id: string;
    try {
        id = nk.matchCreate("ddz", {
            expect_humans: String(humans),
            ai: String(ai),
        });
    } catch (e) {
        logger.error("ddz_mm matchCreate: %s", String(e));
        return null;
    }
    if (!id || String(id).length === 0) {
        logger.error("ddz_mm matchCreate empty id");
        return null;
    }
    logger.info("ddz_mm: created match %s humans=%d ai=%d", id, humans, ai);
    return id;
}

function ddzMmProcessQueueCore(state: DdzMmPersistedState, nk: nkruntime.Nakama, logger: nkruntime.Logger): void {
    const now = Date.now();
    const q = state.entries.slice();
    q.sort(function (a, b) {
        return a.joinedAtMs - b.joinedAtMs;
    });
    while (q.length >= 3) {
        const a = q[0];
        const b = q[1];
        const c = q[2];
        const id = ddzMmCreateMatchInner(nk, logger, [a, b, c], 3, 0);
        if (!id) {
            break;
        }
        q.splice(0, 3);
        ddzMmNotifyResults(state, [a.ticket, b.ticket, c.ticket], id);
    }
    if (q.length >= 2) {
        const a = q[0];
        const b = q[1];
        const oldest = Math.min(a.joinedAtMs, b.joinedAtMs);
        if (now - oldest >= DDZ_MM_WAIT_MS) {
            const id = ddzMmCreateMatchInner(nk, logger, [a, b], 2, 1);
            if (id) {
                q.splice(0, 2);
                ddzMmNotifyResults(state, [a.ticket, b.ticket], id);
            }
        }
    }
    if (q.length >= 1) {
        const a = q[0];
        if (now - a.joinedAtMs >= DDZ_MM_WAIT_MS) {
            const id = ddzMmCreateMatchInner(nk, logger, [a], 1, 2);
            if (id) {
                q.splice(0, 1);
                ddzMmNotifyResults(state, [a.ticket], id);
            }
        }
    }
    state.entries = q;
}

function rpcDdzMmJoin(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    const uid = ctx.userId;
    if (!uid) {
        return rpcErr("unauthorized");
    }
    let outTicket = "";
    try {
        ddzMmMutateState(nk, logger, function (st: DdzMmPersistedState) {
            const nextEntries: DdzMmQueueEntry[] = [];
            for (let i = 0; i < st.entries.length; i++) {
                if (st.entries[i].userId !== uid) {
                    nextEntries.push(st.entries[i]);
                } else {
                    delete st.results[st.entries[i].ticket];
                }
            }
            const ticket = ddzMmMakeTicket(nk);
            let username = "";
            try {
                const acc = nk.accountGetId(uid);
                if (acc && acc.user && acc.user.username) {
                    username = acc.user.username;
                }
            } catch (e) {
                logger.warn("ddz_mm accountGetId: %s", String(e));
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
        logger.error("ddz_mm join storage: %s", String(e));
        return rpcErr("storage_busy");
    }
    logger.info("ddz_mm join user=%s ticket=%s", uid, outTicket);
    return rpcOk({ ticket: outTicket });
}

function rpcDdzMmPoll(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
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
        ddzMmMutateState(nk, logger, function (st: DdzMmPersistedState) {
            ddzMmProcessQueueCore(st, nk, logger);
            const r = st.results[ticket];
            if (r && r.matchId) {
                delete st.results[ticket];
                response = rpcOk({ status: "matched", match_id: r.matchId });
            }
        });
    } catch (e) {
        logger.error("ddz_mm poll storage: %s", String(e));
        return rpcErr("storage_busy");
    }
    return response;
}

function rpcDdzMmCancel(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
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
        ddzMmMutateState(nk, logger, function (st: DdzMmPersistedState) {
            const next: DdzMmQueueEntry[] = [];
            for (let i = 0; i < st.entries.length; i++) {
                if (st.entries[i].ticket !== ticket) {
                    next.push(st.entries[i]);
                }
            }
            st.entries = next;
            delete st.results[ticket];
        });
    } catch (e) {
        logger.error("ddz_mm cancel storage: %s", String(e));
        return rpcErr("storage_busy");
    }
    return rpcOk();
}
