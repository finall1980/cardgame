/**
 * Nakama 运行时代码入口。
 *
 * Nakama 3.1+ JS 运行时要求：registerRpc / registerMatch / registerMatchmakerMatched
 * 必须在 InitModule 内「直接」对 initializer 调用，不能包在另一层函数里，
 * 否则报错：function key could not be extracted（见 heroiclabs/nakama#549）。
 */

let InitModule: nkruntime.InitModule = function (
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    initializer: nkruntime.Initializer
) {
    initializer.registerRpc("wallet_sync", rpcWalletSync);
    initializer.registerRpc("wallet_buy", rpcWalletBuy);
    initializer.registerRpc("wallet_apply_delta", rpcWalletApplyDelta);

    initializer.registerMatch("ddz", ddzMatchHandler);
    initializer.registerMatchmakerMatched(ddzMatchmakerMatched);
    initializer.registerRpc("ddz_mm_join", rpcDdzMmJoin);
    initializer.registerRpc("ddz_mm_poll", rpcDdzMmPoll);
    initializer.registerRpc("ddz_mm_cancel", rpcDdzMmCancel);

    /**
     * 掼蛋（guandan）：Match Handler + 自建匹配队列 RPC。
     * 与 ddz 隔离：Match label "guandan"、Storage collection "guandan_mm"、RPC 前缀 guandan_mm_*。
     * 内置 matchmaker 当前仍由 ddzMatchmakerMatched 回调（Nakama 仅允许注册一个）。
     * 若未来客户端改走 add_matchmaker_async 并在 properties 中携带 game="guandan"，
     * 请在 ddzMatchmakerMatched 内分流到 guandanMatchmakerMatchedFallback。
     */
    initializer.registerMatch("guandan", guandanMatchHandler);
    initializer.registerRpc("guandan_mm_join", rpcGuandanMmJoin);
    initializer.registerRpc("guandan_mm_poll", rpcGuandanMmPoll);
    initializer.registerRpc("guandan_mm_cancel", rpcGuandanMmCancel);

    initializer.registerMatch("meow_kill", meowKillMatchHandler);
    initializer.registerRpc("meow_kill_mm_join", rpcMeowKillMmJoin);
    initializer.registerRpc("meow_kill_mm_poll", rpcMeowKillMmPoll);
    initializer.registerRpc("meow_kill_mm_cancel", rpcMeowKillMmCancel);

    logger.info("Nakama runtime initialized (wallet + ddz + guandan + meow_kill).");
};
