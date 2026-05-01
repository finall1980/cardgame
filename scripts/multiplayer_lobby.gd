extends Control

@onready var _hub: Node = get_node("/root/OnlineSession")
@onready var _btn_match: Button = %BtnMatchNow
@onready var _btn_guandan_match: Button = get_node_or_null("%BtnGuandanMatch")
@onready var _btn_meow_kill_match: Button = get_node_or_null("%BtnMeowKillMatch")
@onready var _match_status: Label = %MatchStatusLabel
@onready var _match_timer_lbl: Label = %MatchTimerLabel
@onready var _lbl_username: Label = %LblProfileUsername
@onready var _lbl_email: Label = %LblProfileEmail
@onready var _lbl_nickname: Label = %LblProfileNickname
@onready var _lbl_location: Label = %LblProfileLocation
@onready var _lbl_created: Label = %LblProfileCreated
@onready var _lbl_wallet: Label = %LblWalletCoins
@onready var _btn_wallet: Button = %BtnBuyCoins
@onready var _edit_display_name: LineEdit = %EditProfileDisplayName
@onready var _edit_location: LineEdit = %EditProfileLocation
@onready var _btn_save_profile: Button = %BtnSaveProfile
@onready var _chat_log: RichTextLabel = %LobbyChatLog
@onready var _chat_input: LineEdit = %LobbyChatInput
@onready var _btn_send: Button = %BtnLobbyChatSend

var _match_elapsed_sec: int = 0
var _match_sec_timer: Timer
var _chat_setup_done: bool = false
var _chat_line_count: int = 0


func _ready() -> void:
	_match_status.text = ""
	_match_timer_lbl.text = "0 秒"
	_match_timer_lbl.visible = false
	if _btn_wallet:
		_btn_wallet.pressed.connect(_on_wallet_button_pressed)
	if _btn_save_profile:
		_btn_save_profile.pressed.connect(_on_save_profile_pressed)
	_hub.matchmaker_succeeded.connect(_on_matchmaker_succeeded)
	_hub.online_match_join_failed.connect(_on_online_match_join_failed)
	if _hub.has_signal("lobby_chat_received"):
		_hub.lobby_chat_received.connect(_on_lobby_chat_received)
	call_deferred("_refresh_profile_labels")
	call_deferred("_setup_lobby_chat")


func _on_lobby_chat_received(username: String, text: String, _sender_id: String) -> void:
	_append_chat_line(username, text)


func _lobby_escape_bb(s: String) -> String:
	return s.replace("[", "(").replace("]", ")")


func _append_chat_line(username: String, text: String) -> void:
	if _chat_log == null:
		return
	var line: String = text.replace("\n", " ").replace("\r", "")
	var un: String = _lobby_escape_bb(username)
	_chat_log.append_text("[color=#e8c478][b]%s[/b][/color]  %s\n" % [un, _lobby_escape_bb(line)])
	_chat_line_count += 1
	if _chat_line_count > 200:
		_chat_log.clear()
		_chat_line_count = 0


func _sync_edit_fields_from_hub() -> void:
	if _edit_display_name:
		_edit_display_name.text = _hub.profile_display_name
	if _edit_location:
		_edit_location.text = _hub.profile_location


func _refresh_profile_labels() -> void:
	await _hub.refresh_profile_async()
	if _lbl_username:
		_lbl_username.text = "用户名：%s" % (_hub.profile_username if not _hub.profile_username.is_empty() else "—")
	if _lbl_email:
		_lbl_email.text = "邮箱：%s" % (_hub.profile_email if not _hub.profile_email.is_empty() else "—")
	if _lbl_nickname:
		_lbl_nickname.text = "昵称：%s" % (_hub.profile_display_name if not _hub.profile_display_name.is_empty() else "—")
	if _lbl_location:
		_lbl_location.text = "位置：%s" % (_hub.profile_location if not _hub.profile_location.is_empty() else "—")
	var ct: String = _hub.profile_create_time
	if ct.is_empty():
		ct = "—"
	else:
		ct = _format_iso_time(ct)
	if _lbl_created:
		_lbl_created.text = "注册时间：%s" % ct
	_sync_edit_fields_from_hub()
	if _lbl_wallet:
		await _hub.sync_wallet_async()
		_lbl_wallet.text = "游戏币：%d" % int(_hub.wallet_coins)
	_update_wallet_button_visibility()


func _update_wallet_button_visibility() -> void:
	if _btn_wallet == null:
		return
	var c: int = int(_hub.wallet_coins)
	if c <= 0:
		_btn_wallet.visible = true
		_btn_wallet.disabled = false
		_btn_wallet.text = "重置积分"
	else:
		_btn_wallet.visible = false


func _on_wallet_button_pressed() -> void:
	if _btn_wallet:
		_btn_wallet.disabled = true
	var err: String = await _hub.reset_wallet_if_empty_async()
	if _lbl_wallet:
		_lbl_wallet.text = "游戏币：%d" % int(_hub.wallet_coins)
	_update_wallet_button_visibility()
	if _btn_wallet and int(_hub.wallet_coins) <= 0:
		_btn_wallet.disabled = false
	if not err.is_empty():
		push_warning("积分重置: %s" % err)


func _on_save_profile_pressed() -> void:
	if _btn_save_profile:
		_btn_save_profile.disabled = true
	var dn: String = _edit_display_name.text if _edit_display_name else ""
	var loc: String = _edit_location.text if _edit_location else ""
	var err: String = await _hub.update_profile_fields_async(dn, loc)
	if not err.is_empty():
		push_warning("保存资料: %s" % err)
	await _refresh_profile_labels()
	if _btn_save_profile:
		_btn_save_profile.disabled = false


func _format_iso_time(s: String) -> String:
	if s.length() >= 19 and s.substr(10, 1) == "T":
		return s.substr(0, 19).replace("T", " ")
	return s


func _setup_lobby_chat() -> void:
	if _chat_setup_done:
		return
	if not await _hub.join_lobby_chat_async():
		if _chat_log:
			_chat_log.append_text("[color=#98b8a8][系统][/color]  大厅聊天暂时无法连接，请稍后再试。\n")
		return
	_chat_setup_done = true
	var hist: Array = await _hub.fetch_lobby_chat_history_async(50)
	for m in hist:
		if m is NakamaAPI.ApiChannelMessage:
			var mm: NakamaAPI.ApiChannelMessage = m as NakamaAPI.ApiChannelMessage
			var jp := JSON.new()
			var txt: String = ""
			if jp.parse(mm.content) == OK and typeof(jp.data) == TYPE_DICTIONARY:
				txt = str((jp.data as Dictionary).get("text", ""))
			if txt.is_empty():
				txt = mm.content
			var un: String = mm.username if not mm.username.is_empty() else "玩家"
			_append_chat_line(un, txt)
	_chat_input.text_submitted.connect(_on_chat_input_submitted)
	_btn_send.pressed.connect(_on_send_pressed)


func _on_chat_input_submitted(t: String) -> void:
	var s: String = t.strip_edges()
	_chat_input.text = ""
	if s.is_empty():
		return
	await _hub.send_lobby_chat_async(s)


func _on_send_pressed() -> void:
	var s: String = _chat_input.text.strip_edges()
	_chat_input.text = ""
	if s.is_empty():
		return
	await _hub.send_lobby_chat_async(s)


func _exit_tree() -> void:
	if _hub.matchmaker_succeeded.is_connected(_on_matchmaker_succeeded):
		_hub.matchmaker_succeeded.disconnect(_on_matchmaker_succeeded)
	if _hub.online_match_join_failed.is_connected(_on_online_match_join_failed):
		_hub.online_match_join_failed.disconnect(_on_online_match_join_failed)
	if _hub.has_signal("lobby_chat_received") and _hub.lobby_chat_received.is_connected(_on_lobby_chat_received):
		_hub.lobby_chat_received.disconnect(_on_lobby_chat_received)
	if not _hub.is_in_online_match() and _hub.has_method("is_matchmaking") and not _hub.is_matchmaking():
		call_deferred("_leave_lobby_and_close_socket")


func _leave_lobby_and_close_socket() -> void:
	if not is_instance_valid(_hub):
		return
	if _hub.is_in_online_match() or _hub.is_matchmaking():
		return
	await _hub.leave_lobby_chat_async()
	if is_instance_valid(_hub):
		_hub.close_realtime()


func _on_matchmaker_succeeded() -> void:
	_stop_match_wait_timer()
	_match_status.text = "已匹配成功！即将进入游戏..."
	await get_tree().create_timer(2.0).timeout
	await _hub.leave_lobby_chat_async()
	var game_id: String = _hub.current_game_id if "current_game_id" in _hub else "ddz"
	if game_id == "guandan":
		get_tree().change_scene_to_file("res://scenes/guandan/main.tscn")
	elif game_id == "meow_kill":
		get_tree().change_scene_to_file("res://scenes/meow_kill/main.tscn")
	else:
		get_tree().change_scene_to_file("res://scenes/online_match.tscn")


func _on_online_match_join_failed() -> void:
	_stop_match_wait_timer()
	_match_status.text = "加入对局失败，请稍后再试。"
	_set_match_busy(false)


func _set_match_busy(busy: bool) -> void:
	_btn_match.disabled = busy
	if _btn_guandan_match != null:
		_btn_guandan_match.disabled = busy
	if _btn_meow_kill_match != null:
		_btn_meow_kill_match.disabled = busy


func _ensure_sec_timer() -> void:
	if _match_sec_timer != null:
		return
	_match_sec_timer = Timer.new()
	_match_sec_timer.wait_time = 1.0
	_match_sec_timer.one_shot = false
	_match_sec_timer.timeout.connect(_on_match_sec_timer_tick)
	add_child(_match_sec_timer)


func _start_match_wait_timer() -> void:
	_ensure_sec_timer()
	_match_elapsed_sec = 0
	_match_timer_lbl.text = "0 秒"
	_match_timer_lbl.visible = true
	_match_sec_timer.start()


func _stop_match_wait_timer() -> void:
	if _match_sec_timer != null:
		_match_sec_timer.stop()
	_match_timer_lbl.visible = false


func _on_match_sec_timer_tick() -> void:
	_match_elapsed_sec += 1
	_match_timer_lbl.text = "%d 秒" % _match_elapsed_sec


func _on_btn_match_now_pressed() -> void:
	_match_status.text = "正在准备匹配…"
	_set_match_busy(true)
	_start_match_wait_timer()
	await get_tree().create_timer(0.5).timeout
	_match_status.text = "正在匹配中，请稍候…"
	var err: String = await _hub.start_matchmaking_authoritative_async()
	if err == "matching_interrupted":
		_stop_match_wait_timer()
		_set_match_busy(false)
		return
	if not err.is_empty():
		_stop_match_wait_timer()
		push_warning("匹配: %s" % err)
		var short_err: String = err
		if short_err.length() > 72:
			short_err = short_err.substr(0, 69) + "…"
		_match_status.text = "匹配失败：%s" % short_err
		_set_match_busy(false)
		return
	if _hub.is_in_online_match():
		_stop_match_wait_timer()


func _on_btn_guandan_match_pressed() -> void:
	_match_status.text = "正在准备掼蛋匹配…"
	_set_match_busy(true)
	_start_match_wait_timer()
	await get_tree().create_timer(0.5).timeout
	_match_status.text = "正在匹配 4 人掼蛋，请稍候…"
	var err: String = await _hub.start_guandan_matchmaking_async()
	if err == "matching_interrupted":
		_stop_match_wait_timer()
		_set_match_busy(false)
		return
	if not err.is_empty():
		_stop_match_wait_timer()
		push_warning("掼蛋匹配: %s" % err)
		var short_err: String = err
		if short_err.length() > 72:
			short_err = short_err.substr(0, 69) + "…"
		_match_status.text = "匹配失败：%s" % short_err
		_set_match_busy(false)
		return
	if _hub.is_in_online_match():
		_stop_match_wait_timer()


func _on_btn_meow_kill_match_pressed() -> void:
	_match_status.text = "正在准备猫猫杀匹配…"
	_set_match_busy(true)
	_start_match_wait_timer()
	await get_tree().create_timer(0.5).timeout
	_match_status.text = "正在匹配 5 人猫猫杀（约 10 秒未满则由牌手补位）…"
	var err: String = await _hub.start_meow_kill_matchmaking_async(5)
	if err == "matching_interrupted":
		_stop_match_wait_timer()
		_set_match_busy(false)
		return
	if not err.is_empty():
		_stop_match_wait_timer()
		push_warning("猫猫杀匹配: %s" % err)
		var short_err: String = err
		if short_err.length() > 72:
			short_err = short_err.substr(0, 69) + "…"
		_match_status.text = "匹配失败：%s" % short_err
		_set_match_busy(false)
		return
	if _hub.is_in_online_match():
		_stop_match_wait_timer()


func _on_btn_create_room_pressed() -> void:
	print("创建房间（占位）")


func _on_btn_join_room_pressed() -> void:
	print("加入房间（占位）")


func _on_btn_back_to_login_pressed() -> void:
	await _hub.cancel_matchmaking_async()
	await _hub.leave_lobby_chat_async()
	_hub.clear_session()
	get_tree().change_scene_to_file("res://scenes/start_menu.tscn")
