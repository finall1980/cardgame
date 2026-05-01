/**
 * 全局 Storage 乐观锁写入 + 重试（多实例 / 并发 RPC 下避免覆盖丢失）。
 */

function mutateGlobalStorage<T>(
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    collection: string,
    stateKey: string,
    ownerUserId: string,
    defaultState: () => T,
    revive: (raw: unknown) => T,
    toStorageValue: (state: T) => { [key: string]: any },
    mutator: (state: T) => void,
    logPrefix: string
): void {
    const maxTries = 24;
    for (let attempt = 0; attempt < maxTries; attempt++) {
        const rows = nk.storageRead([{ collection: collection, key: stateKey, userId: ownerUserId }]);
        let state: T;
        let version = "";
        if (!rows || rows.length === 0) {
            state = defaultState();
        } else {
            const obj = rows[0];
            version = obj.version || "";
            const clone = JSON.parse(JSON.stringify(obj.value));
            state = revive(clone);
        }
        mutator(state);
        try {
            const req: nkruntime.StorageWriteRequest = {
                collection: collection,
                key: stateKey,
                userId: ownerUserId,
                value: toStorageValue(state),
            };
            if (version && version.length > 0) {
                req.version = version;
            }
            nk.storageWrite([req]);
            return;
        } catch (e) {
            logger.warn("%s storage write retry %d: %s", logPrefix, attempt, String(e));
        }
    }
    throw new Error(logPrefix + "_storage_failed");
}
