/** RPC 统一 JSON 字符串形态，便于多游戏复用 */

function rpcOk(fields: Record<string, unknown> = {}): string {
    const o: Record<string, unknown> = { ok: true };
    for (const k in fields) {
        if (fields.hasOwnProperty(k)) {
            o[k] = fields[k];
        }
    }
    return JSON.stringify(o);
}

function rpcErr(error: string, fields: Record<string, unknown> = {}): string {
    const o: Record<string, unknown> = { ok: false, error: error };
    for (const k in fields) {
        if (fields.hasOwnProperty(k)) {
            o[k] = fields[k];
        }
    }
    return JSON.stringify(o);
}
