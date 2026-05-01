/**
 * 安全随机：优先 nk.secureRandomBytes，缺失时回退 Math.random（与洗牌/展示 seed 等非密钥场景一致）。
 */

function randomBytesCompat(nk: nkruntime.Nakama, count: number): Uint8Array {
    const nkAny = nk as unknown as { secureRandomBytes?: (n: number) => ArrayBuffer };
    if (typeof nkAny.secureRandomBytes === "function") {
        return new Uint8Array(nkAny.secureRandomBytes(count));
    }
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
        out[i] = Math.floor(Math.random() * 256);
    }
    return out;
}

function randomIntBelow(nk: nkruntime.Nakama, maxExclusive: number): number {
    const u = randomBytesCompat(nk, 4);
    const x = u[0] | (u[1] << 8) | (u[2] << 16) | (u[3] << 24);
    return (x >>> 0) % maxExclusive;
}

/** Fisher–Yates */
function shuffleInPlace(nk: nkruntime.Nakama, deck: number[]): void {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = randomIntBelow(nk, i + 1);
        const t = deck[i];
        deck[i] = deck[j];
        deck[j] = t;
    }
}
