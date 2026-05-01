/**
 * 全游戏通用游戏币（与匹配分离：各游戏自建 mm 队列，余额共用本 Storage）。
 * 新数据：collection player / key wallet。
 * 兼容旧版：曾写在 doudizhu/wallet，读取时若无新键则回退；之后写入只进 player。
 */

const WALLET_COLLECTION = "player";
const WALLET_KEY = "wallet";
const WALLET_COLLECTION_LEGACY = "doudizhu";
const WALLET_INITIAL = 3000;

function walletParseCoins(value: unknown): number {
    const v = value as { coins?: number };
    return typeof v.coins === "number" && Number.isFinite(v.coins) ? Math.floor(v.coins) : 0;
}

interface WalletLoad {
    coins: number;
    /** 仅用于写入 player 桶的乐观锁；从 legacy 读到时为空串（表示创建或覆盖新对象） */
    playerWriteVersion: string;
    hadPlayerRow: boolean;
}

function walletLoad(nk: nkruntime.Nakama, userId: string): WalletLoad {
    const pr = nk.storageRead([{ collection: WALLET_COLLECTION, key: WALLET_KEY, userId: userId }]);
    if (pr && pr.length > 0) {
        return {
            coins: walletParseCoins(pr[0].value),
            playerWriteVersion: pr[0].version || "",
            hadPlayerRow: true,
        };
    }
    const lr = nk.storageRead([{ collection: WALLET_COLLECTION_LEGACY, key: WALLET_KEY, userId: userId }]);
    if (lr && lr.length > 0) {
        return {
            coins: walletParseCoins(lr[0].value),
            playerWriteVersion: "",
            hadPlayerRow: false,
        };
    }
    return { coins: 0, playerWriteVersion: "", hadPlayerRow: false };
}

function walletWritePlayer(nk: nkruntime.Nakama, userId: string, coins: number, playerWriteVersion: string): void {
    const req: nkruntime.StorageWriteRequest = {
        collection: WALLET_COLLECTION,
        key: WALLET_KEY,
        userId: userId,
        value: { coins: coins },
        permissionRead: 1,
        permissionWrite: 1,
    };
    if (playerWriteVersion && playerWriteVersion.length > 0) {
        req.version = playerWriteVersion;
    }
    nk.storageWrite([req]);
}

function rpcWalletSync(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    const uid = ctx.userId;
    if (!uid) {
        return rpcErr("unauthorized");
    }
    let r = walletLoad(nk, uid);
    if (!r.hadPlayerRow && r.coins > 0) {
        try {
            walletWritePlayer(nk, uid, r.coins, "");
            r = walletLoad(nk, uid);
        } catch (e) {
            logger.error("wallet_sync migrate legacy: %s", String(e));
            return rpcErr("storage_write");
        }
    }
    let coins = r.coins;
    if (coins <= 0) {
        coins = WALLET_INITIAL;
        try {
            walletWritePlayer(nk, uid, coins, r.hadPlayerRow ? r.playerWriteVersion : "");
        } catch (e) {
            logger.error("wallet_sync write: %s", String(e));
            return rpcErr("storage_write");
        }
    }
    return rpcOk({ coins: coins });
}

function rpcWalletBuy(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    return rpcWalletApplyDelta(ctx, logger, nk, JSON.stringify({ delta: 100 }));
}

function rpcWalletApplyDelta(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    const uid = ctx.userId;
    if (!uid) {
        return rpcErr("unauthorized");
    }
    let delta = 0;
    try {
        const p = JSON.parse(payload || "{}");
        delta = Math.floor(Number((p as { delta?: unknown }).delta));
    } catch (e) {
        return rpcErr("bad_payload");
    }
    if (!Number.isFinite(delta)) {
        return rpcErr("bad_delta");
    }
    if (delta > 5000000 || delta < -5000000) {
        return rpcErr("delta_out_of_range");
    }
    const r = walletLoad(nk, uid);
    let newCoins = r.coins + delta;
    if (newCoins < 0) {
        newCoins = 0;
    }
    try {
        walletWritePlayer(nk, uid, newCoins, r.hadPlayerRow ? r.playerWriteVersion : "");
    } catch (e) {
        logger.error("wallet_apply_delta: %s", String(e));
        return rpcErr("storage_write");
    }
    return rpcOk({ coins: newCoins });
}
