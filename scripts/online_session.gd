extends Node
## 联机阶段：持有 Nakama 客户端与登录会话，供开始菜单与对局场景使用。

const SERVER_KEY := "defaultkey"
## Nakama HTTP API（默认 7350；控制台网页常为 80，二者不同）
const SERVER_HOST := "8.160.177.86"
const SERVER_PORT := 7350
const SERVER_SCHEME := "http"
## 单次 HTTP 超时（秒）；过短易误判，过长则界面等待久
const CLIENT_TIMEOUT_SEC := 10
## Match 内仅同步「回合 + 出牌剩余时间」的 opcode（JSON 负载，已由快照替代时可不用）。
const MATCH_OP_TURN_SYNC := 1
## 房主权威：完整对局状态快照。
const MATCH_OP_STATE_SNAPSHOT := 2
## 客人 → 房主：叫分 / 抢地主 / 出牌 / 过。
const MATCH_OP_CLIENT_ACTION := 3
## 服务端权威斗地主（`Modules` → `games/ddz/match_handler` 等），与上方 1/2/3 错开。
const DDZ_OP_SNAPSHOT := 101
const DDZ_OP_ERROR := 102
const DDZ_OP_SETTLEMENT := 120
const DDZ_REQ_BID := 10
const DDZ_REQ_ROB := 11
const DDZ_REQ_PLAY := 12
const DDZ_REQ_PASS := 13
const DDZ_REQ_CONTINUE := 14
## 须与服务端 `registerMatch("<label>", …)` 一致；换玩法时同步改服务端并改 `RPC_MM_*` 前缀。
const AUTHORITY_GAME_MATCH_LABEL := "ddz"
## 自建匹配 ticket 前缀（须与 `Modules` 内 `games/ddz/mm_queue` 生成规则一致）。
const MM_TICKET_PREFIX := "ddzmm_"
## 掼蛋 RPC 队列车票前缀（与 `mm_queue.ts` 内 `gdmm_` 一致）。
const GUANDAN_RPC_TICKET_PREFIX := "gdmm_"
## 用户返回大厅等导致 `_start_mm_rpc_async` 主动结束时返回（非业务错误）。
const MATCHMAKING_INTERRUPTED := "matching_interrupted"
const RPC_MM_JOIN := "ddz_mm_join"
const RPC_MM_POLL := "ddz_mm_poll"
const RPC_MM_CANCEL := "ddz_mm_cancel"
## 掼蛋（guandan）：label / ticket 前缀 / RPC；与 ddz 独立，不得串行。
const GUANDAN_MATCH_LABEL := "guandan"
const GUANDAN_MM_TICKET_PREFIX := "guandanmm_"
const RPC_GUANDAN_MM_JOIN := "guandan_mm_join"
const RPC_GUANDAN_MM_POLL := "guandan_mm_poll"
const RPC_GUANDAN_MM_CANCEL := "guandan_mm_cancel"
## 服务端权威掼蛋 opcode（与 DDZ_OP_* / GD_REQ_* 错开；须与 Modules/src/games/guandan/match_state 保持一致）。
const GD_OP_SNAPSHOT := 201
const GD_OP_ERROR := 202
const GD_OP_HINT := 203
const GD_OP_SETTLEMENT := 220
const GD_REQ_PLAY := 30
const GD_REQ_PASS := 31
const GD_REQ_TRIBUTE := 32
const GD_REQ_TRIBUTE_RESIST := 33
const GD_REQ_RETURN := 34
const GD_REQ_CONTINUE := 35
const GD_REQ_DELEGATE := 38
const GD_REQ_HINT := 39
## 猫猫杀 meow_kill（须与 Modules/src/games/meow_kill/match_state.ts 一致）。
const MEOW_KILL_MATCH_LABEL := "meow_kill"
const MEOW_KILL_MM_TICKET_PREFIX := "mkmm_"
const RPC_MEOW_KILL_MM_JOIN := "meow_kill_mm_join"
const RPC_MEOW_KILL_MM_POLL := "meow_kill_mm_poll"
const RPC_MEOW_KILL_MM_CANCEL := "meow_kill_mm_cancel"
const MK_OP_SNAPSHOT := 301
const MK_OP_ERROR := 302
const MK_REQ_PING := 50
const MK_REQ_PLAY_CARD := 52
const MK_REQ_RESPOND_JINK := 53
const MK_REQ_END_PLAY := 54
const MK_REQ_DISCARD := 55
const MK_REQ_PEACH_DYING := 56
const MK_REQ_PASS_DYING := 57
const MK_REQ_CONFIRM_IDENTITY := 58
const MK_REQ_DELEGATE := 59
const MK_REQ_CONFIRM_BREED := 60
## 全游戏通用钱包（服务端 `core/wallet`）。
const RPC_WALLET_SYNC := "wallet_sync"
const RPC_WALLET_BUY := "wallet_buy"
const RPC_WALLET_APPLY_DELTA := "wallet_apply_delta"
## 联机对局中主动退回大厅时扣除的游戏币（与 `main.gd` 设置菜单确认一致）。
const ABANDON_MATCH_COIN_PENALTY := 1000
const _MATCH_CHAT_PREFIX := AUTHORITY_GAME_MATCH_LABEL + "_match_"
const _MATCH_CHAT_MAX_NAME := 64
## 本机 Godot ENet 对局同步端口（与 Nakama 匹配独立；局域网可后续改为可配置 host）。
const MATCH_ENET_PORT := 7645
## 服务端权威 DDZ：在「已 Join Match、主场景尚未连接 `match_ddz_server`」时缓存快照，进入对局后 `replay_rt_ddz_buffer()` 重放（避免大厅等待 2s 期间丢失首包）。
const _DDZ_RT_BUFFER_MAX := 96

signal matchmaker_succeeded()
signal online_match_join_failed()
## payload: { "turn": int, "bidding": bool, "t_left_ms": int }；sender_user_id 为发送方 Nakama user_id。
signal match_turn_sync(payload: Dictionary, sender_user_id: String)
## 完整状态 JSON（见 main._net_build_snapshot）。
signal match_state_snapshot(payload: Dictionary, sender_user_id: String)
signal match_client_action(payload: Dictionary, sender_user_id: String)
## Match 内某用户离开（presence leaves）；不含本机主动离开。
signal match_peer_left(user_id: String)
## 实时连接断开且当时仍在 Match 内（用于对局中断提示）。
signal match_rt_disconnected()
## 服务端权威 Match `ddz`：快照 / 错误 / 结算（payload 已 JSON 解析为 Dictionary）。
signal match_ddz_server(op_code: int, data: Dictionary)
## 服务端权威 Match `guandan`：同形式（见 GD_OP_*）。
signal match_gd_server(op_code: int, data: Dictionary)
signal match_meow_kill_server(op_code: int, data: Dictionary)

var _client: NakamaClient
## 已通过 matchmaker 加入的 Nakama Match（用于联网对局信令；离开场景时应 leave）。
var active_rt_match = null
var session: NakamaSession
## 当前是否从「单机游玩」进入主场景（无 Nakama 会话）
var offline_mode: bool = false
## 最近一次从服务器拉取的资料（进入主场景前会 refresh）
var profile_username: String = ""
var profile_display_name: String = ""
var profile_email: String = ""
var profile_location: String = ""
var profile_create_time: String = ""
## 服务器同步的游戏币（`wallet_sync` / 购买 / 对局结算）
var wallet_coins: int = 0
## 大厅聊天房间「大厅」加入后的 channel id（leave / 发消息用）
var lobby_channel_id: String = ""
## 对局临时聊天：房间名为 `ddz_match_<match_id>`，**不持久化**（不落库，无单独删除机制）。
var match_chat_channel_id: String = ""

signal lobby_chat_received(p_username: String, p_text: String, p_sender_id: String)
signal match_chat_received(p_username: String, p_text: String, p_sender_id: String)

var _rt_socket: NakamaSocket
var _matchmaker_ticket: String = ""
## 为 true 时尽快结束 `_start_mm_rpc_async`（避免 session 已清空仍调 `rpc_async`）。
var _mm_abort_requested: bool = false
var _enet_peer: ENetMultiplayerPeer
var _ddz_rt_buffer: Array[Dictionary] = []
## Join 成功至 `replay_rt_ddz_buffer()` 之前为 true，重放后关断，避免 matchLoop 每 tick 把缓冲撑爆。
var _ddz_rt_buffering: bool = false
var _gd_rt_buffer: Array[Dictionary] = []
var _gd_rt_buffering: bool = false
var _mk_rt_buffer: Array[Dictionary] = []
var _mk_rt_buffering: bool = false
## 当前正在匹配/进行的玩法 id（"ddz" | "guandan" | "meow_kill" | ""），决定匹配完成后切到哪个主场景。
var current_game_id: String = ""


func get_client() -> NakamaClient:
	if _client == null:
		var nakama_plugin: Node = get_node("/root/Nakama")
		_client = nakama_plugin.create_client(SERVER_KEY, SERVER_HOST, SERVER_PORT, SERVER_SCHEME, CLIENT_TIMEOUT_SEC)
	return _client


## 通信异常后丢弃客户端，下次重新建连（避免卡在坏连接上）。
func reset_client() -> void:
	_client = null


func set_session(s: NakamaSession) -> void:
	session = s
	offline_mode = false


func clear_session() -> void:
	_mm_abort_requested = true
	active_rt_match = null
	lobby_channel_id = ""
	match_chat_channel_id = ""
	close_realtime()
	session = null
	profile_username = ""
	profile_display_name = ""
	profile_email = ""
	profile_location = ""
	profile_create_time = ""
	wallet_coins = 0


## 关闭实时连接（离开联机大厅等时调用；会丢弃当前匹配队列票据）。
func close_realtime() -> void:
	_ddz_rt_buffer.clear()
	_ddz_rt_buffering = false
	_gd_rt_buffer.clear()
	_gd_rt_buffering = false
	_mk_rt_buffer.clear()
	_mk_rt_buffering = false
	cleanup_match_enet_if_any()
	active_rt_match = null
	_matchmaker_ticket = ""
	lobby_channel_id = ""
	match_chat_channel_id = ""
	if _rt_socket != null:
		if _rt_socket.received_matchmaker_matched.is_connected(_on_rt_matchmaker_matched):
			_rt_socket.received_matchmaker_matched.disconnect(_on_rt_matchmaker_matched)
		if _rt_socket.received_match_state.is_connected(_on_rt_match_state):
			_rt_socket.received_match_state.disconnect(_on_rt_match_state)
		if _rt_socket.received_match_presence.is_connected(_on_rt_match_presence):
			_rt_socket.received_match_presence.disconnect(_on_rt_match_presence)
		if _rt_socket.received_channel_message.is_connected(_on_rt_channel_message):
			_rt_socket.received_channel_message.disconnect(_on_rt_channel_message)
		if _rt_socket.closed.is_connected(_on_rt_socket_closed):
			_rt_socket.closed.disconnect(_on_rt_socket_closed)
		_rt_socket.close()
		_rt_socket = null


## 进入单机对局：清空联机会话并标记离线（主界面不显示联机用户信息栏）。
func begin_offline_play() -> void:
	clear_session()
	offline_mode = true
	current_game_id = ""


func is_logged_in() -> bool:
	return session != null and session.is_valid() and not session.is_exception()


## 已在匹配池等待、尚未收到 matched（此时 `is_in_online_match()` 仍为 false）。
func is_matchmaking() -> bool:
	return not _matchmaker_ticket.is_empty()


## 建立 Nakama Socket；已连接则直接返回 true。
func ensure_realtime_ready_async() -> bool:
	if not is_logged_in():
		return false
	if _rt_socket != null and _rt_socket.is_connected_to_host():
		return true
	close_realtime()
	var nakama_plugin: Node = get_node("/root/Nakama")
	_rt_socket = nakama_plugin.create_socket_from(get_client())
	_rt_socket.received_matchmaker_matched.connect(_on_rt_matchmaker_matched)
	_rt_socket.received_match_state.connect(_on_rt_match_state)
	_rt_socket.received_match_presence.connect(_on_rt_match_presence)
	_rt_socket.closed.connect(_on_rt_socket_closed)
	var conn_result: NakamaAsyncResult = await _rt_socket.connect_async(session)
	if conn_result.is_exception():
		push_warning("Nakama Socket 连接失败: %s" % conn_result.get_exception().message)
		close_realtime()
		return false
	return true


## 进入匹配池（两名真人，与设计文档一致；第三人由 AI 补齐）。
func start_matchmaking_async() -> String:
	return await start_matchmaking_with_count_async(2, 2)


## 三人匹配：RPC 排队（`ddz_mm_*`），满 3 人即开；否则等待 10s 后由服务端 AI 补位。
func start_matchmaking_authoritative_async() -> String:
	current_game_id = "ddz"
	return await _start_mm_rpc_async(RPC_MM_JOIN, RPC_MM_POLL)


## 掼蛋匹配：RPC 排队（`guandan_mm_*`），满 4 人即开；否则等待 30s 后由服务端 AI 补位。
func start_guandan_matchmaking_async() -> String:
	current_game_id = "guandan"
	return await _start_mm_rpc_async(RPC_GUANDAN_MM_JOIN, RPC_GUANDAN_MM_POLL)


## 猫猫杀：`table_size` 为 5 或 8（对应服务端 `meow_kill_mm_join` 的 JSON `table`）。
func start_meow_kill_matchmaking_async(table_size: int = 5) -> String:
	current_game_id = "meow_kill"
	var join_payload: String = ""
	if table_size == 8:
		join_payload = JSON.stringify({"table": 8})
	return await _start_mm_rpc_async(RPC_MEOW_KILL_MM_JOIN, RPC_MEOW_KILL_MM_POLL, join_payload)


## 通用自建匹配 RPC 流程：入队 → 轮询（1s/次）→ matched 后 join_match。
func _start_mm_rpc_async(rpc_join: String, rpc_poll: String, join_payload: String = "") -> String:
	_mm_abort_requested = false
	if not _matchmaker_ticket.is_empty():
		return "已在匹配中"
	if not await ensure_realtime_ready_async():
		return "无法连接实时服务"
	if _mm_abort_requested or not is_logged_in():
		return MATCHMAKING_INTERRUPTED
	var client: NakamaClient = get_client()
	var rpc_res = await client.rpc_async(session, rpc_join, join_payload)
	if _mm_abort_requested or not is_logged_in():
		return MATCHMAKING_INTERRUPTED
	if rpc_res == null:
		return "网络异常"
	if rpc_res.has_method("is_exception") and rpc_res.is_exception():
		return rpc_res.get_exception().message
	var jp := JSON.new()
	if jp.parse(rpc_res.payload) != OK:
		return "服务器返回无效"
	var d: Dictionary = jp.data as Dictionary
	if not d.get("ok", false):
		return str(d.get("error", "匹配入队失败"))
	var t: String = str(d.get("ticket", ""))
	if t.is_empty():
		return "无 ticket"
	_matchmaker_ticket = t
	while true:
		if _mm_abort_requested or not is_logged_in():
			_matchmaker_ticket = ""
			return MATCHMAKING_INTERRUPTED
		var pr = await client.rpc_async(session, rpc_poll, JSON.stringify({"ticket": t}))
		if _mm_abort_requested or not is_logged_in():
			_matchmaker_ticket = ""
			return MATCHMAKING_INTERRUPTED
		if pr == null:
			_matchmaker_ticket = ""
			return "网络异常"
		if pr.has_method("is_exception") and pr.is_exception():
			_matchmaker_ticket = ""
			return pr.get_exception().message
		var jp2 := JSON.new()
		if jp2.parse(pr.payload) != OK:
			_matchmaker_ticket = ""
			return "轮询失败"
		var d2: Variant = jp2.data
		if typeof(d2) != TYPE_DICTIONARY:
			_matchmaker_ticket = ""
			return "数据无效"
		var dd: Dictionary = d2
		if not dd.get("ok", false):
			_matchmaker_ticket = ""
			return str(dd.get("error", "未知错误"))
		if str(dd.get("status", "")) == "matched":
			var mid: String = str(dd.get("match_id", ""))
			if mid.is_empty():
				_matchmaker_ticket = ""
				return "缺少 match_id"
			if _mm_abort_requested or not is_logged_in():
				_matchmaker_ticket = ""
				return MATCHMAKING_INTERRUPTED
			await _join_authoritative_match_by_id(mid)
			_matchmaker_ticket = ""
			return ""
		var tree := get_tree()
		if tree == null:
			_matchmaker_ticket = ""
			return "场景已释放"
		await tree.create_timer(1.0).timeout
		if _mm_abort_requested or not is_logged_in():
			_matchmaker_ticket = ""
			return MATCHMAKING_INTERRUPTED
	return ""


func start_matchmaking_with_count_async(min_count: int, max_count: int) -> String:
	if not _matchmaker_ticket.is_empty():
		return "已在匹配中"
	if not await ensure_realtime_ready_async():
		return "无法连接实时服务"
	var ticket: NakamaRTAPI.MatchmakerTicket = await _rt_socket.add_matchmaker_async("*", min_count, max_count)
	if ticket.is_exception():
		return ticket.get_exception().message
	_matchmaker_ticket = ticket.ticket
	return ""


func send_ddz_authoritative_async(op_code: int, payload: Dictionary) -> void:
	if not is_in_online_match() or _rt_socket == null:
		return
	var mid: String = get_online_match_id()
	if mid.is_empty():
		return
	var js: String = JSON.stringify(payload)
	## 统一用 UTF-8 字节再 raw_to_base64。send_match_state_async 走 Marshalls.utf8_to_base64，
	## 在部分导出（如 Web）可能对多字节 UTF-8 有误，表现为「哈哈」→「åå」；与 DDZ_REQ_* 其它 opcode 同路径可避免。
	_rt_socket.send_match_state_raw_async(mid, op_code, js.to_utf8_buffer())


## 掼蛋：发送客户端动作（GD_REQ_*）到服务端 Match。
func send_guandan_action_async(op_code: int, payload: Dictionary) -> void:
	if not is_in_online_match() or _rt_socket == null:
		return
	var mid: String = get_online_match_id()
	if mid.is_empty():
		return
	var js: String = JSON.stringify(payload)
	_rt_socket.send_match_state_raw_async(mid, op_code, js.to_utf8_buffer())


func send_meow_kill_action_async(op_code: int, payload: Dictionary) -> void:
	if not is_in_online_match() or _rt_socket == null:
		return
	var mid: String = get_online_match_id()
	if mid.is_empty():
		return
	var js: String = JSON.stringify(payload)
	_rt_socket.send_match_state_raw_async(mid, op_code, js.to_utf8_buffer())


func cancel_matchmaking_async() -> void:
	_mm_abort_requested = true
	var t := _matchmaker_ticket
	_matchmaker_ticket = ""
	if t.is_empty():
		return
	if t.begins_with(MEOW_KILL_MM_TICKET_PREFIX):
		if is_logged_in():
			var client_mk: NakamaClient = get_client()
			var res_mk = await client_mk.rpc_async(session, RPC_MEOW_KILL_MM_CANCEL, JSON.stringify({"ticket": t}))
			if res_mk != null and res_mk.has_method("is_exception") and res_mk.is_exception():
				push_warning("猫猫杀匹配取消: %s" % res_mk.get_exception().message)
		return
	if t.begins_with(GUANDAN_RPC_TICKET_PREFIX):
		if is_logged_in():
			var client_g: NakamaClient = get_client()
			var res_g = await client_g.rpc_async(session, RPC_GUANDAN_MM_CANCEL, JSON.stringify({"ticket": t}))
			if res_g != null and res_g.has_method("is_exception") and res_g.is_exception():
				push_warning("掼蛋匹配取消: %s" % res_g.get_exception().message)
		return
	if t.begins_with(MM_TICKET_PREFIX):
		if is_logged_in():
			var client: NakamaClient = get_client()
			var res_d = await client.rpc_async(session, RPC_MM_CANCEL, JSON.stringify({"ticket": t}))
			if res_d != null and res_d.has_method("is_exception") and res_d.is_exception():
				push_warning("匹配取消: %s" % res_d.get_exception().message)
		return
	if _rt_socket != null:
		await _rt_socket.remove_matchmaker_async(t)


func _join_authoritative_match_by_id(mid: String) -> void:
	if _rt_socket == null:
		online_match_join_failed.emit()
		return
	if _mm_abort_requested or not is_logged_in():
		return
	var m: NakamaRTAPI.Match = await _rt_socket.join_match_async(mid)
	if _mm_abort_requested or not is_logged_in():
		return
	if m.is_exception():
		push_warning("join_match: %s" % m.get_exception().message)
		online_match_join_failed.emit()
		return
	var ok: NakamaRTAPI.Match = m as NakamaRTAPI.Match
	print("[OnlineSession] join_match ok match_id=%s authoritative=%s game=%s" % [ok.match_id, ok.authoritative, current_game_id])
	if current_game_id == "guandan":
		_gd_rt_buffering = true
		_gd_rt_buffer.clear()
	elif current_game_id == "meow_kill":
		_mk_rt_buffering = true
		_mk_rt_buffer.clear()
	else:
		_ddz_rt_buffering = true
		_ddz_rt_buffer.clear()
	active_rt_match = ok
	matchmaker_succeeded.emit()


func is_in_online_match() -> bool:
	return active_rt_match is NakamaRTAPI.Match and not (active_rt_match as NakamaRTAPI.Match).is_exception()


func get_online_match_id() -> String:
	if not is_in_online_match():
		return ""
	return (active_rt_match as NakamaRTAPI.Match).match_id


func _rt_match_user_ids_sorted() -> Array[String]:
	var out: Array[String] = []
	if not is_in_online_match():
		return out
	var m: NakamaRTAPI.Match = active_rt_match as NakamaRTAPI.Match
	if m.self_user != null and not m.self_user.user_id.is_empty():
		out.append(m.self_user.user_id)
	for p in m.presences:
		if p is NakamaRTAPI.UserPresence:
			var up: NakamaRTAPI.UserPresence = p as NakamaRTAPI.UserPresence
			if not up.user_id.is_empty() and not out.has(up.user_id):
				out.append(up.user_id)
	out.sort()
	return out


## 字典序最小的 user_id 为房主（与对局内「权威时钟」发送方一致）。
func get_rt_match_host_user_id() -> String:
	var ids := _rt_match_user_ids_sorted()
	if ids.is_empty():
		return ""
	return ids[0]


func is_rt_match_host() -> bool:
	if session == null:
		return false
	var hid := get_rt_match_host_user_id()
	if hid.is_empty():
		return true
	return session.user_id == hid


func send_match_turn_sync_async(payload: Dictionary) -> void:
	if not is_in_online_match() or _rt_socket == null:
		return
	var mid: String = get_online_match_id()
	if mid.is_empty():
		return
	var js: String = JSON.stringify(payload)
	_rt_socket.send_match_state_async(mid, MATCH_OP_TURN_SYNC, js)


func send_match_snapshot_async(_payload: Dictionary) -> void:
	## 对局状态改由 Godot MultiplayerSynchronizer + ENet 同步，此处不再经 Nakama 发整包快照。
	if not is_in_online_match():
		return


func send_client_action_async(payload: Dictionary) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	if tree != null:
		for n in tree.get_nodes_in_group("ddz_game_main"):
			if n is Node and (n as Node).has_method("client_forward_action_to_host"):
				(n as Node).call("client_forward_action_to_host", payload)
				return
	if not is_in_online_match() or _rt_socket == null:
		return
	var mid: String = get_online_match_id()
	if mid.is_empty():
		return
	_rt_socket.send_match_state_async(mid, MATCH_OP_CLIENT_ACTION, JSON.stringify(payload))


func cleanup_match_enet_if_any() -> void:
	var tree := Engine.get_main_loop() as SceneTree
	if tree == null:
		return
	var mp := tree.get_multiplayer()
	if mp.multiplayer_peer != null:
		mp.multiplayer_peer.close()
		mp.multiplayer_peer = null
	_enet_peer = null


## 在 Nakama 进房成功后建立本机为权威端的 ENet + MultiplayerAPI（127.0.0.1 供本机双开调试）。
func ensure_match_enet_multiplayer_async() -> bool:
	if not is_in_online_match():
		return false
	var tree := Engine.get_main_loop() as SceneTree
	if tree == null:
		return false
	var mp := tree.get_multiplayer()
	if mp.multiplayer_peer is ENetMultiplayerPeer:
		var ep := mp.multiplayer_peer as ENetMultiplayerPeer
		if ep.get_connection_status() == MultiplayerPeer.CONNECTION_CONNECTED:
			return true
	cleanup_match_enet_if_any()
	_enet_peer = ENetMultiplayerPeer.new()
	if is_rt_match_host():
		var err: Error = _enet_peer.create_server(MATCH_ENET_PORT, 2)
		if err != OK:
			push_error("ENet create_server 失败: %s" % str(err))
			cleanup_match_enet_if_any()
			return false
		mp.multiplayer_peer = _enet_peer
		await tree.process_frame
		return true
	var tries: int = 0
	while tries < 200:
		cleanup_match_enet_if_any()
		_enet_peer = ENetMultiplayerPeer.new()
		var err2: Error = _enet_peer.create_client("127.0.0.1", MATCH_ENET_PORT)
		if err2 != OK:
			await tree.create_timer(0.05).timeout
			tries += 1
			continue
		mp.multiplayer_peer = _enet_peer
		var t0: int = Time.get_ticks_msec()
		while _enet_peer.get_connection_status() == MultiplayerPeer.CONNECTION_CONNECTING:
			await tree.process_frame
			if Time.get_ticks_msec() - t0 > 15000:
				break
		if _enet_peer.get_connection_status() == MultiplayerPeer.CONNECTION_CONNECTED:
			return true
		await tree.create_timer(0.08).timeout
		tries += 1
	push_error("ENet 作为客人连接房主失败（请确认房主已先进主场景并监听端口 %d）" % MATCH_ENET_PORT)
	cleanup_match_enet_if_any()
	return false


func get_rt_match_guest_user_id() -> String:
	var ids := _rt_match_user_ids_sorted()
	if ids.size() < 2:
		return ""
	return ids[1]


## Match 内真人 user_id 升序（与房主判定一致）；2 人时为两位真人，3 人时三席均为真人。
func get_rt_match_sorted_user_ids() -> Array[String]:
	return _rt_match_user_ids_sorted()


func _emit_ddz_server(op: int, d: Dictionary) -> void:
	if _ddz_rt_buffering:
		_ddz_rt_buffer.append({"op": op, "d": d.duplicate(true)})
		while _ddz_rt_buffer.size() > _DDZ_RT_BUFFER_MAX:
			_ddz_rt_buffer.pop_front()
	match_ddz_server.emit(op, d)


## 由 `main.gd` 在连接 `match_ddz_server` 之后调用，补应用 Join 后已发出的快照。
func _rt_match_payload_utf8(md: NakamaRTAPI.MatchData) -> String:
	## 勿用 MatchData.data（Marshalls.base64_to_utf8）：在 Web 等环境下会把 UTF-8 多字节按「每字节一字」误解析，
	## 表现为「哈哈」→「åå」（仅取每个汉字 UTF-8 首字节 E5→å）。
	## 始终：base64 → 原始字节 → PackedByteArray.get_string_from_utf8()。
	if md.base64_data.is_empty():
		return ""
	var raw: PackedByteArray = Marshalls.base64_to_raw(md.base64_data)
	if raw.is_empty():
		return ""
	var s: String = raw.get_string_from_utf8()
	if s.is_empty() and not raw.is_empty():
		push_warning("MatchData UTF-8 解码异常 op=%d raw_len=%d" % [int(md.op_code), raw.size()])
	return s


func replay_rt_ddz_buffer() -> void:
	for item in _ddz_rt_buffer:
		match_ddz_server.emit(int(item["op"]), item["d"] as Dictionary)
	_ddz_rt_buffer.clear()
	_ddz_rt_buffering = false


func _emit_gd_server(op: int, d: Dictionary) -> void:
	if _gd_rt_buffering:
		_gd_rt_buffer.append({"op": op, "d": d.duplicate(true)})
		while _gd_rt_buffer.size() > _DDZ_RT_BUFFER_MAX:
			_gd_rt_buffer.pop_front()
	match_gd_server.emit(op, d)


func replay_rt_gd_buffer() -> void:
	for item in _gd_rt_buffer:
		match_gd_server.emit(int(item["op"]), item["d"] as Dictionary)
	_gd_rt_buffer.clear()
	_gd_rt_buffering = false


func _emit_mk_server(op: int, d: Dictionary) -> void:
	if _mk_rt_buffering:
		_mk_rt_buffer.append({"op": op, "d": d.duplicate(true)})
		while _mk_rt_buffer.size() > _DDZ_RT_BUFFER_MAX:
			_mk_rt_buffer.pop_front()
	match_meow_kill_server.emit(op, d)


func replay_rt_mk_buffer() -> void:
	for item in _mk_rt_buffer:
		match_meow_kill_server.emit(int(item["op"]), item["d"] as Dictionary)
	_mk_rt_buffer.clear()
	_mk_rt_buffering = false


func _on_rt_match_state(p_state) -> void:
	if not (p_state is NakamaRTAPI.MatchData):
		return
	var md: NakamaRTAPI.MatchData = p_state as NakamaRTAPI.MatchData
	var txt: String = _rt_match_payload_utf8(md)
	var sender_id: String = ""
	if md.presence != null:
		sender_id = md.presence.user_id
	if txt.is_empty():
		return
	var jp := JSON.new()
	if jp.parse(txt) != OK:
		push_warning("RT match_state JSON 解析失败 op_code=%d len=%d 预览=%s" % [
			int(md.op_code),
			txt.length(),
			txt.substr(0, min(80, txt.length())),
		])
		return
	var root = jp.data
	if typeof(root) != TYPE_DICTIONARY:
		return
	var dict: Dictionary = root as Dictionary
	var opc: int = int(md.op_code)
	if opc == DDZ_OP_SNAPSHOT or opc == DDZ_OP_ERROR or opc == DDZ_OP_SETTLEMENT:
		_emit_ddz_server(opc, dict)
		return
	if opc == GD_OP_SNAPSHOT or opc == GD_OP_ERROR or opc == GD_OP_SETTLEMENT or opc == GD_OP_HINT:
		_emit_gd_server(opc, dict)
		return
	if opc == MK_OP_SNAPSHOT or opc == MK_OP_ERROR:
		_emit_mk_server(opc, dict)
		return
	match md.op_code:
		MATCH_OP_TURN_SYNC:
			match_turn_sync.emit(dict, sender_id)
		MATCH_OP_STATE_SNAPSHOT:
			match_state_snapshot.emit(dict, sender_id)
		MATCH_OP_CLIENT_ACTION:
			match_client_action.emit(dict, sender_id)
		_:
			pass


func _on_rt_match_presence(p_ev: Variant) -> void:
	if not (p_ev is NakamaRTAPI.MatchPresenceEvent):
		return
	var ev: NakamaRTAPI.MatchPresenceEvent = p_ev as NakamaRTAPI.MatchPresenceEvent
	if ev.is_exception():
		return
	if not is_in_online_match():
		return
	if ev.match_id != get_online_match_id():
		return
	for p in ev.leaves:
		if p is NakamaRTAPI.UserPresence:
			var up: NakamaRTAPI.UserPresence = p as NakamaRTAPI.UserPresence
			if not up.user_id.is_empty():
				match_peer_left.emit(up.user_id)


func _on_rt_socket_closed() -> void:
	if not is_in_online_match():
		return
	match_rt_disconnected.emit()


## 离开 Nakama Match 并清除引用（返回菜单等）。
func leave_online_match_cleanup_async() -> void:
	_ddz_rt_buffer.clear()
	_ddz_rt_buffering = false
	_gd_rt_buffer.clear()
	_gd_rt_buffering = false
	_mk_rt_buffer.clear()
	_mk_rt_buffering = false
	await leave_match_chat_async()
	if not is_in_online_match():
		cleanup_match_enet_if_any()
		active_rt_match = null
		return
	var mid: String = (active_rt_match as NakamaRTAPI.Match).match_id
	active_rt_match = null
	cleanup_match_enet_if_any()
	if _rt_socket != null and _rt_socket.is_connected_to_host():
		await _rt_socket.leave_match_async(mid)


func _on_rt_matchmaker_matched(matched) -> void:
	## 内置 Matchmaker 路径：服务端 `registerMatchmakerMatched` → `matchCreate(AUTHORITY_GAME_MATCH_LABEL, …)`；自建队列路径见 `RPC_MM_*`。若 match_id 为空，查 runtime 与 Nakama 日志。
	if matched == null:
		push_error("matchmaker_matched: 收到空对象")
		online_match_join_failed.emit()
		return
	var mm: NakamaRTAPI.MatchmakerMatched = matched as NakamaRTAPI.MatchmakerMatched
	var n_users: int = 0
	if mm.users != null:
		n_users = mm.users.size()
	print("[OnlineSession] matchmaker_matched ticket=%s match_id=%s token=%s users=%d" % [
		mm.ticket, mm.match_id, mm.token, n_users
	])
	if str(mm.match_id).is_empty() and str(mm.token).is_empty():
		push_error("matchmaker_matched: match_id 与 token 皆空 → 服务端未返回可加入的对局（检查是否已部署 build/index.js、InitModule 是否执行 registerMatchmakerMatched、Nakama 是否已重启）")
		online_match_join_failed.emit()
		return
	_matchmaker_ticket = ""
	if _rt_socket == null:
		push_error("matchmaker_matched: Socket 已断开，无法 join_matched")
		online_match_join_failed.emit()
		return
	var m: NakamaRTAPI.Match = await _rt_socket.join_matched_async(matched)
	if m.is_exception():
		push_warning("加入对局失败: %s" % m.get_exception().message)
		online_match_join_failed.emit()
		return
	var ok: NakamaRTAPI.Match = m as NakamaRTAPI.Match
	print("[OnlineSession] join_matched ok match_id=%s authoritative=%s game=%s" % [ok.match_id, ok.authoritative, current_game_id])
	if current_game_id == "guandan":
		_gd_rt_buffering = true
		_gd_rt_buffer.clear()
	elif current_game_id == "meow_kill":
		_mk_rt_buffering = true
		_mk_rt_buffer.clear()
	else:
		_ddz_rt_buffering = true
		_ddz_rt_buffer.clear()
	active_rt_match = m
	matchmaker_succeeded.emit()


## 拉取当前账号资料，失败时保留旧值。
func refresh_profile_async() -> void:
	if not is_logged_in():
		return
	var client: NakamaClient = get_client()
	var acc: NakamaAPI.ApiAccount = await client.get_account_async(session)
	if acc.is_exception():
		return
	profile_email = acc.email
	var u = acc.user
	if u != null:
		profile_username = u.username
		profile_display_name = u.display_name
		profile_location = u.location
		profile_create_time = u.create_time
	if profile_username.is_empty() and not acc.email.is_empty():
		profile_username = acc.email
	if profile_username.is_empty() and session != null:
		profile_username = session.username


## 更新 Nakama 账号展示昵称与地区（用户名/邮箱不在此修改）。
func update_profile_fields_async(display_name: String, location: String) -> String:
	if not is_logged_in():
		return "未登录"
	var dn: String = display_name.strip_edges()
	var loc: String = location.strip_edges()
	var client: NakamaClient = get_client()
	var res: NakamaAsyncResult = await client.update_account_async(session, null, dn if not dn.is_empty() else null, null, null, loc if not loc.is_empty() else null, null)
	if res.is_exception():
		return res.get_exception().message
	await refresh_profile_async()
	return ""


## 拉取或初始化游戏币（无存档或≤0 时服务端给 3000）。
func sync_wallet_async() -> bool:
	if not is_logged_in():
		return false
	var client: NakamaClient = get_client()
	var res = await client.rpc_async(session, RPC_WALLET_SYNC, "")
	if res.is_exception():
		push_warning("wallet_sync: %s" % res.get_exception().message)
		return false
	var jp := JSON.new()
	if jp.parse(res.payload) != OK:
		return false
	var root: Variant = jp.data
	if typeof(root) != TYPE_DICTIONARY:
		return false
	var d: Dictionary = root as Dictionary
	if not bool(d.get("ok", false)):
		return false
	wallet_coins = int(d.get("coins", 0))
	return true


## 游戏币≤0 时调用 `wallet_sync`，服务端将余额恢复为初始 3000（须先在大厅 `sync_wallet` 后确认本地 `wallet_coins`）。
func reset_wallet_if_empty_async() -> String:
	if not is_logged_in():
		return "未登录"
	if wallet_coins > 0:
		return "当前积分大于 0，无需重置"
	if await sync_wallet_async():
		return ""
	return "重置失败，请稍后再试"


## 对局结算：按 delta 更新服务器余额（与 RPC `wallet_apply_delta` 一致）。
func apply_wallet_delta_async(delta: int) -> bool:
	if not is_logged_in():
		return false
	var client: NakamaClient = get_client()
	var res = await client.rpc_async(session, RPC_WALLET_APPLY_DELTA, JSON.stringify({"delta": delta}))
	if res.is_exception():
		push_warning("wallet_apply_delta: %s" % res.get_exception().message)
		return false
	var jp := JSON.new()
	if jp.parse(res.payload) != OK:
		return false
	var root: Variant = jp.data
	if typeof(root) != TYPE_DICTIONARY:
		return false
	var d: Dictionary = root as Dictionary
	if not bool(d.get("ok", false)):
		return false
	wallet_coins = int(d.get("coins", wallet_coins))
	return true


func _channel_message_parse_text(msg: NakamaAPI.ApiChannelMessage) -> String:
	var txt: String = ""
	var jp := JSON.new()
	if jp.parse(msg.content) == OK:
		var root = jp.data
		if typeof(root) == TYPE_DICTIONARY:
			txt = str((root as Dictionary).get("text", ""))
	if txt.is_empty() and not msg.content.is_empty():
		txt = msg.content
	return txt


func _on_rt_channel_message(p_msg: Variant) -> void:
	if not (p_msg is NakamaAPI.ApiChannelMessage):
		return
	var msg: NakamaAPI.ApiChannelMessage = p_msg as NakamaAPI.ApiChannelMessage
	if msg.is_exception():
		return
	var cid: String = msg.channel_id
	var txt: String = _channel_message_parse_text(msg)
	var uname: String = msg.username
	if uname.is_empty():
		uname = "玩家"
	if not lobby_channel_id.is_empty() and cid == lobby_channel_id:
		lobby_chat_received.emit(uname, txt, msg.sender_id)
		return
	if not match_chat_channel_id.is_empty() and cid == match_chat_channel_id:
		match_chat_received.emit(uname, txt, msg.sender_id)


## 加入房间名「大厅」的持久化聊天（需已登录）。
func join_lobby_chat_async() -> bool:
	if not await ensure_realtime_ready_async():
		return false
	if _rt_socket != null and not _rt_socket.received_channel_message.is_connected(_on_rt_channel_message):
		_rt_socket.received_channel_message.connect(_on_rt_channel_message)
	var ch: NakamaRTAPI.Channel = await _rt_socket.join_chat_async("大厅", 1, true, false)
	if ch.is_exception():
		push_warning("join 大厅 chat: %s" % ch.get_exception().message)
		return false
	lobby_channel_id = ch.id
	return true


func leave_lobby_chat_async() -> void:
	var cid: String = lobby_channel_id
	if cid.is_empty() or _rt_socket == null or not _rt_socket.is_connected_to_host():
		lobby_channel_id = ""
		return
	var res: NakamaAsyncResult = await _rt_socket.leave_chat_async(cid)
	if res.is_exception():
		push_warning("leave chat: %s" % res.get_exception().message)
	lobby_channel_id = ""


func send_lobby_chat_async(text: String) -> void:
	if lobby_channel_id.is_empty() or _rt_socket == null or not _rt_socket.is_connected_to_host():
		return
	var t: String = text.strip_edges()
	if t.is_empty():
		return
	await _rt_socket.write_chat_message_async(lobby_channel_id, {"text": t})


func fetch_lobby_chat_history_async(p_limit: int = 40) -> Array:
	var out: Array = []
	if not is_logged_in() or lobby_channel_id.is_empty():
		return out
	var client: NakamaClient = get_client()
	var lst: NakamaAPI.ApiChannelMessageList = await client.list_channel_messages_async(session, lobby_channel_id, p_limit, true, "")
	if lst.is_exception():
		return out
	for m in lst.messages:
		if m is NakamaAPI.ApiChannelMessage:
			out.append(m)
	return out


func match_chat_room_name_from_match_id(match_id: String) -> String:
	var s: String = match_id.strip_edges()
	if s.is_empty():
		return ""
	var room: String = _MATCH_CHAT_PREFIX + s
	if room.length() > _MATCH_CHAT_MAX_NAME:
		room = room.substr(0, _MATCH_CHAT_MAX_NAME)
	return room


## 对局内聊天：与 Match 并行加入 **同一 match_id** 命名的房间频道；**persistence=false** 不落库（Nakama 无聊天 TTL API，临时频道用不持久化即可）。
func join_match_chat_async(p_match_id: String) -> bool:
	var mid: String = p_match_id.strip_edges()
	if mid.is_empty():
		return false
	if not await ensure_realtime_ready_async():
		return false
	if _rt_socket != null and not _rt_socket.received_channel_message.is_connected(_on_rt_channel_message):
		_rt_socket.received_channel_message.connect(_on_rt_channel_message)
	var room_name: String = match_chat_room_name_from_match_id(mid)
	var ch: NakamaRTAPI.Channel = await _rt_socket.join_chat_async(room_name, 1, false, false)
	if ch.is_exception():
		push_warning("join 对局聊天: %s" % ch.get_exception().message)
		return false
	match_chat_channel_id = ch.id
	return true


func leave_match_chat_async() -> void:
	var cid: String = match_chat_channel_id
	if cid.is_empty() or _rt_socket == null or not _rt_socket.is_connected_to_host():
		match_chat_channel_id = ""
		return
	var res: NakamaAsyncResult = await _rt_socket.leave_chat_async(cid)
	if res.is_exception():
		push_warning("leave 对局聊天: %s" % res.get_exception().message)
	match_chat_channel_id = ""


func send_match_chat_async(text: String) -> void:
	if match_chat_channel_id.is_empty() or _rt_socket == null or not _rt_socket.is_connected_to_host():
		return
	var t: String = text.strip_edges()
	if t.is_empty():
		return
	if t.length() > 200:
		t = t.substr(0, 200)
	await _rt_socket.write_chat_message_async(match_chat_channel_id, {"text": t})
