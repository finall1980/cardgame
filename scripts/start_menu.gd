extends Control

const _ErrTxt := preload("res://scripts/nakama_error_text.gd")
const _GRPC_NOT_FOUND := 5
const _GRPC_UNAUTHENTICATED := 16
const _MIN_PASSWORD_LEN := 8
const _MIN_EMAIL_LEN := 10
const _MAX_DISPLAY_NAME_LEN := 128
const _AUTH_LABEL_NEUTRAL := Color(0.82, 0.94, 0.88, 1)

@onready var _hub: Node = get_node("/root/OnlineSession")
@onready var _bgm: AudioStreamPlayer = %BgmPlayer
@onready var _btn_single: Button = %BtnSinglePlayer
@onready var _btn_online: Button = %BtnOnline
@onready var _btn_settings: Button = %BtnSettings
@onready var _btn_exit: Button = %BtnExit
@onready var _bgm_volume_slider: HSlider = %BgmVolumeSlider
@onready var _auth_overlay: CanvasLayer = %AuthOverlay
@onready var _auth_title: Label = %AuthPopupTitle
@onready var _pop_email: LineEdit = %PopEmail
@onready var _pop_password: LineEdit = %PopPassword
@onready var _pop_nickname: LineEdit = %PopNickname
@onready var _register_extra: VBoxContainer = %RegisterExtra
@onready var _login_btn_row: HBoxContainer = %LoginBtnRow
@onready var _register_btn_row: HBoxContainer = %RegisterBtnRow
@onready var _pop_login: Button = %PopLogin
@onready var _pop_to_register: Button = %PopToRegister
@onready var _pop_register_submit: Button = %PopRegisterSubmit
@onready var _pop_back_login: Button = %PopBackToLogin
@onready var _pop_close: Button = %BtnPopClose
@onready var _auth_status: Label = %AuthPopupStatus
@onready var _cb_remember: CheckBox = %AuthRememberMe

var _register_mode: bool = false
const _REMEMBER_CFG_PATH := "user://login_remember.cfg"
var _dlg_soon: AcceptDialog
## 四枚透明热区平铺在背景图底部按钮上（与 start.png 中横条大致对齐，可按分辨率改 anchor）
const _HOME_MENU_HIT_MIN_H := 44.0
const _HOME_MENU_HIT_MAX_H := 96.0
const _HOME_MENU_HIT_H_FRAC := 0.09
## 最窄一列宽度下限，HBox 会均分整行剩余宽度
const _HOME_MENU_HIT_MIN_W := 40.0


func _ready() -> void:
	_apply_home_menu_button_sizing()
	call_deferred("_apply_home_menu_button_sizing")
	get_viewport().size_changed.connect(_apply_home_menu_button_sizing)
	if _bgm.stream is AudioStreamMP3:
		(_bgm.stream as AudioStreamMP3).loop = true
	_apply_bgm_volume_percent(float(_bgm_volume_slider.value))
	_bgm_volume_slider.value_changed.connect(_on_bgm_volume_slider_changed)
	_bgm.play()
	_btn_single.pressed.connect(_on_single_player_pressed)
	_btn_online.pressed.connect(_on_online_pressed)
	_btn_settings.pressed.connect(func() -> void: _show_soon_dialog("设置"))
	_btn_exit.pressed.connect(_on_exit_game_pressed)
	_pop_login.pressed.connect(_on_popup_login_pressed)
	_pop_to_register.pressed.connect(_show_register_panel)
	_pop_register_submit.pressed.connect(_on_popup_register_submit_pressed)
	_pop_back_login.pressed.connect(_show_login_panel)
	_pop_close.pressed.connect(_close_auth_overlay)
	_pop_email.text_submitted.connect(_on_auth_login_submitted)
	_pop_password.text_submitted.connect(_on_auth_login_submitted)
	_dlg_soon = AcceptDialog.new()
	_dlg_soon.title = "提示"
	_dlg_soon.ok_button_text = "好的"
	add_child(_dlg_soon)


func _apply_bgm_volume_percent(pct: float) -> void:
	var t: float = clampf(pct / 100.0, 0.0, 1.0)
	if t <= 0.0001:
		_bgm.volume_db = -80.0
	else:
		_bgm.volume_db = linear_to_db(t)


func _on_bgm_volume_slider_changed(value: float) -> void:
	_apply_bgm_volume_percent(value)


func _apply_home_menu_button_sizing() -> void:
	var vh: float = get_viewport().get_visible_rect().size.y
	if vh < 32.0:
		vh = maxf(vh, float(DisplayServer.screen_get_size().y))
	var hit_h: float = clampf(vh * _HOME_MENU_HIT_H_FRAC, _HOME_MENU_HIT_MIN_H, _HOME_MENU_HIT_MAX_H)
	var btns: Array[Button] = [_btn_single, _btn_online, _btn_settings, _btn_exit]
	for b in btns:
		b.custom_minimum_size = Vector2(_HOME_MENU_HIT_MIN_W, hit_h)


func _show_soon_dialog(feature_name: String) -> void:
	_dlg_soon.dialog_text = "%s功能开发中，敬请期待。" % feature_name
	_dlg_soon.popup_centered()


func _on_single_player_pressed() -> void:
	_hub.begin_offline_play()
	get_tree().change_scene_to_file("res://scenes/main.tscn")


func _on_exit_game_pressed() -> void:
	get_tree().quit()


func _on_online_pressed() -> void:
	_register_mode = false
	_load_remembered_credentials()
	_pop_nickname.text = ""
	_set_popup_status("", false)
	_sync_auth_panel_mode()
	_auth_overlay.visible = true
	call_deferred("_focus_login_first_empty")


func _close_auth_overlay() -> void:
	_auth_overlay.visible = false
	_register_mode = false
	_set_auth_overlay_busy(false)
	_sync_auth_panel_mode()


func _show_register_panel() -> void:
	_register_mode = true
	_set_popup_status("", false)
	_sync_auth_panel_mode()


func _show_login_panel() -> void:
	_register_mode = false
	_set_popup_status("", false)
	_sync_auth_panel_mode()


func _sync_auth_panel_mode() -> void:
	_auth_title.text = "注册账号" if _register_mode else "联网登录"
	_register_extra.visible = _register_mode
	_login_btn_row.visible = not _register_mode
	_register_btn_row.visible = _register_mode
	if _cb_remember:
		_cb_remember.visible = not _register_mode


func _focus_login_first_empty() -> void:
	if _register_mode:
		return
	if _pop_email.text.strip_edges().is_empty():
		_pop_email.grab_focus()
	else:
		_pop_password.grab_focus()


func _on_auth_login_submitted(_text: String) -> void:
	if _register_mode or not _auth_overlay.visible:
		return
	_on_popup_login_pressed()


func _load_remembered_credentials() -> void:
	if _cb_remember == null:
		return
	var cfg := ConfigFile.new()
	if cfg.load(_REMEMBER_CFG_PATH) != OK:
		_pop_email.text = ""
		_pop_password.text = ""
		_cb_remember.button_pressed = false
		return
	if cfg.get_value("auth", "remember", false) != true:
		_pop_email.text = ""
		_pop_password.text = ""
		_cb_remember.button_pressed = false
		return
	_pop_email.text = str(cfg.get_value("auth", "email", ""))
	_pop_password.text = str(cfg.get_value("auth", "password", ""))
	_cb_remember.button_pressed = true


func _save_remember_credentials() -> void:
	if _cb_remember == null:
		return
	var cfg := ConfigFile.new()
	cfg.load(_REMEMBER_CFG_PATH)
	if _cb_remember.button_pressed:
		cfg.set_value("auth", "remember", true)
		cfg.set_value("auth", "email", _pop_email.text.strip_edges())
		cfg.set_value("auth", "password", _pop_password.text)
	else:
		cfg.erase_section("auth")
	cfg.save(_REMEMBER_CFG_PATH)


func _validate_login_fields() -> String:
	var email: String = _pop_email.text.strip_edges()
	var password: String = _pop_password.text
	if email.is_empty() or password.is_empty():
		return "请填写邮箱和密码。"
	if not _looks_like_email(email):
		return "请输入有效的邮箱格式。"
	if email.length() < _MIN_EMAIL_LEN:
		return "邮箱长度至少 %d 个字符（服务器要求）。" % _MIN_EMAIL_LEN
	if password.length() < _MIN_PASSWORD_LEN:
		return "密码至少需要 %d 个字符。" % _MIN_PASSWORD_LEN
	return ""


func _validate_register_fields() -> String:
	var base: String = _validate_login_fields()
	if base != "":
		return base
	var nick: String = _pop_nickname.text.strip_edges()
	if nick.is_empty():
		return "请填写昵称。"
	if nick.length() > _MAX_DISPLAY_NAME_LEN:
		return "昵称请勿超过 %d 个字符。" % _MAX_DISPLAY_NAME_LEN
	return ""


func _on_popup_login_pressed() -> void:
	var err: String = _validate_login_fields()
	if err != "":
		_set_popup_status(err, true)
		return
	var email: String = _pop_email.text.strip_edges()
	var password: String = _pop_password.text
	_set_auth_overlay_busy(true)
	_set_popup_status("正在登录…", false)
	var client: NakamaClient = _hub.get_client()
	var session: NakamaSession = await client.authenticate_email_async(email, password, null, false)
	if session.is_exception():
		var ex: NakamaException = session.get_exception()
		var hint: String
		if _is_user_not_found(ex):
			hint = "该邮箱尚未注册，请点击「注册」。"
		else:
			hint = _ErrTxt.humanize(ex)
		_set_popup_status("登录失败：%s" % hint, true)
		_hub.reset_client()
		_set_auth_overlay_busy(false)
		return
	await _finish_online_success(session)


func _on_popup_register_submit_pressed() -> void:
	var err: String = _validate_register_fields()
	if err != "":
		_set_popup_status(err, true)
		return
	var email: String = _pop_email.text.strip_edges()
	var password: String = _pop_password.text
	var display_name: String = _pop_nickname.text.strip_edges()
	var username: String = email
	_set_auth_overlay_busy(true)
	_set_popup_status("正在检查邮箱是否已注册…", false)
	var client: NakamaClient = _hub.get_client()
	var probe: NakamaSession = await client.authenticate_email_async(email, password, username, false)
	if not probe.is_exception():
		_set_popup_status("该邮箱已注册，请返回「登录」。", true)
		_set_auth_overlay_busy(false)
		return
	var ex_probe: NakamaException = probe.get_exception()
	if _is_invalid_credentials(ex_probe):
		_set_popup_status("该邮箱已被注册。请返回「登录」；忘记密码请联系管理员。", true)
		_hub.reset_client()
		_set_auth_overlay_busy(false)
		return
	if not _is_user_not_found(ex_probe):
		_set_popup_status("注册前检查失败：%s" % _ErrTxt.humanize(ex_probe), true)
		_hub.reset_client()
		_set_auth_overlay_busy(false)
		return
	_set_popup_status("正在注册…", false)
	var session: NakamaSession = await client.authenticate_email_async(email, password, username, true)
	if session.is_exception():
		var ex: NakamaException = session.get_exception()
		_set_popup_status("注册失败：%s" % _ErrTxt.humanize(ex), true)
		_hub.reset_client()
		_set_auth_overlay_busy(false)
		return
	var upd = await client.update_account_async(session, null, display_name)
	if upd.is_exception():
		_set_popup_status("账号已创建，但昵称未保存：%s。" % _ErrTxt.humanize(upd.get_exception()), false)
	await _finish_online_success(session)


func _is_invalid_credentials(ex: NakamaException) -> bool:
	if ex == null:
		return false
	if ex.grpc_status_code == _GRPC_UNAUTHENTICATED:
		return true
	var m: String = ex.message.to_lower()
	return m.find("invalid credentials") >= 0


func _is_user_not_found(ex: NakamaException) -> bool:
	if ex == null:
		return false
	if ex.grpc_status_code == _GRPC_NOT_FOUND:
		return true
	var m: String = ex.message.to_lower()
	return m.find("user not found") >= 0 or m.find("user account not found") >= 0 or m.find("account not found") >= 0


func _looks_like_email(s: String) -> bool:
	return s.contains("@") and s.find("@") > 0 and s.find("@") < s.length() - 1


func _set_popup_status(text: String, is_error: bool) -> void:
	_auth_status.text = text
	if is_error:
		_auth_status.add_theme_color_override("font_color", Color(1.0, 0.72, 0.68, 1))
	else:
		_auth_status.add_theme_color_override("font_color", _AUTH_LABEL_NEUTRAL)


func _set_auth_overlay_busy(busy: bool) -> void:
	_pop_login.disabled = busy
	_pop_to_register.disabled = busy
	_pop_register_submit.disabled = busy
	_pop_back_login.disabled = busy
	_pop_close.disabled = busy
	_pop_email.editable = not busy
	_pop_password.editable = not busy
	_pop_nickname.editable = not busy
	_btn_single.disabled = busy
	_btn_online.disabled = busy
	_btn_settings.disabled = busy
	_btn_exit.disabled = busy
	if _cb_remember:
		_cb_remember.disabled = busy


func _finish_online_success(sess: NakamaSession) -> void:
	_save_remember_credentials()
	_hub.set_session(sess)
	_set_popup_status("成功，正在进入…", false)
	_set_auth_overlay_busy(false)
	await _hub.refresh_profile_async()
	await _hub.sync_wallet_async()
	await get_tree().create_timer(0.22).timeout
	_auth_overlay.visible = false
	get_tree().change_scene_to_file("res://scenes/multiplayer_lobby.tscn")
