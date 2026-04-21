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
## 服务端权威斗地主（Modules/main.ts），与上方 1/2/3 错开。
const DDZ_OP_SNAPSHOT := 101
const DDZ_OP_ERROR := 102
const DDZ_OP_SETTLEMENT := 120
const DDZ_REQ_BID := 10
const DDZ_REQ_ROB := 11
const DDZ_REQ_PLAY := 12
const DDZ_REQ_PASS := 13
const DDZ_REQ_CONTINUE := 14
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
var _enet_peer: ENetMultiplayerPeer
var _ddz_rt_buffer: Array[Dictionary] = []
## Join 成功至 `replay_rt_ddz_buffer()` 之前为 true，重放后关断，避免 matchLoop 每 tick 把缓冲撑爆。
var _ddz_rt_buffering: bool = false


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


## 三人匹配：RPC 排队（`ddz_mm_*`），满 3 人即开；否则等待 20s 后由服务端 AI 补位。
func start_matchmaking_authoritative_async() -> String:
	if not _matchmaker_ticket.is_empty():
		return "已在匹配中"
	if not await ensure_realtime_ready_async():
		return "无法连接实时服务"
	var client: NakamaClient = get_client()
	var rpc_res = await client.rpc_async(session, "ddz_mm_join", "")
	if rpc_res.is_exception():
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
		var pr = await client.rpc_async(session, "ddz_mm_poll", JSON.stringify({"ticket": t}))
		if pr.is_exception():
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
			await _join_authoritative_match_by_id(mid)
			_matchmaker_ticket = ""
			return ""
		var tree := get_tree()
		if tree == null:
			_matchmaker_ticket = ""
			return "场景已释放"
		await tree.create_timer(1.0).timeout
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


func cancel_matchmaking_async() -> void:
	if _matchmaker_ticket.is_empty():
		return
	var t := _matchmaker_ticket
	_matchmaker_ticket = ""
	if t.begins_with("ddzmm_"):
		if is_logged_in():
			var client: NakamaClient = get_client()
			await client.rpc_async(session, "ddz_mm_cancel", JSON.stringify({"ticket": t}))
		return
	if _rt_socket != null:
		await _rt_socket.remove_matchmaker_async(t)


func _join_authoritative_match_by_id(mid: String) -> void:
	if _rt_socket == null:
		online_match_join_failed.emit()
		return
	var m: NakamaRTAPI.Match = await _rt_socket.join_match_async(mid)
	if m.is_exception():
		push_warning("join_match: %s" % m.get_exception().message)
		online_match_join_failed.emit()
		return
	var ok: NakamaRTAPI.Match = m as NakamaRTAPI.Match
	print("[OnlineSession] join_match ok match_id=%s authoritative=%s" % [ok.match_id, ok.authoritative])
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
	## 三人凑齐后由服务端 registerMatchmakerMatched -> matchCreate("ddz") 填入 match_id；若 Active Matches 仍为 0，优先查服务端 runtime 与 Nakama 日志。
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
	print("[OnlineSession] join_matched ok match_id=%s authoritative=%s" % [ok.match_id, ok.authoritative])
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


## 拉取或初始化游戏币（无存档或≤0 时服务端给 3000）。
func sync_wallet_async() -> bool:
	if not is_logged_in():
		return false
	var client: NakamaClient = get_client()
	var res = await client.rpc_async(session, "wallet_sync", "")
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


## 购买 +100 游戏币（测试用）；失败返回错误文案，成功返回空串。
func buy_coins_async() -> String:
	if not is_logged_in():
		return "未登录"
	var client: NakamaClient = get_client()
	var res = await client.rpc_async(session, "wallet_buy", "")
	if res.is_exception():
		return res.get_exception().message
	var jp := JSON.new()
	if jp.parse(res.payload) != OK:
		return "数据无效"
	var root: Variant = jp.data
	if typeof(root) != TYPE_DICTIONARY:
		return "数据无效"
	var d: Dictionary = root as Dictionary
	if not bool(d.get("ok", false)):
		return str(d.get("error", "购买失败"))
	wallet_coins = int(d.get("coins", wallet_coins))
	return ""


## 对局结算：按 delta 更新服务器余额（与 RPC `wallet_apply_delta` 一致）。
func apply_wallet_delta_async(delta: int) -> bool:
	if not is_logged_in():
		return false
	var client: NakamaClient = get_client()
	var res = await client.rpc_async(session, "wallet_apply_delta", JSON.stringify({"delta": delta}))
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


const _MATCH_CHAT_PREFIX := "ddz_match_"
const _MATCH_CHAT_MAX_NAME := 64


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
