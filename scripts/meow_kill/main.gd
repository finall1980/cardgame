extends Control
## 猫猫杀：经典桌游布局（中心公共区域 + 底部本家 + 环形对手 + 窄右侧栏）；手牌点选与杀目标确认。

const MK_OP_SNAPSHOT := 301
const MK_OP_ERROR := 302
const MK_REQ_PLAY_CARD := 52
const MK_REQ_RESPOND_JINK := 53
const MK_REQ_END_PLAY := 54
const MK_REQ_DISCARD := 55
const MK_REQ_PEACH_DYING := 56
const MK_REQ_PASS_DYING := 57
const MK_REQ_CONFIRM_IDENTITY := 58
const MK_REQ_DELEGATE := 59
const MK_REQ_CONFIRM_BREED := 60

const TableLayout := preload("res://scripts/meow_kill/table_layout.gd")
const CardRules := preload("res://scripts/meow_kill/card_rules.gd")
const CardAssets := preload("res://scripts/meow_kill/card_assets.gd")
const GeneralAssets := preload("res://scripts/meow_kill/general_assets.gd")

## 与 `MK_ROLE_*` 顺序一致：0 家猫 1 同伴 2 野猫 3 独行。
var _identity_art_stems: PackedStringArray = PackedStringArray([
	"identity_house_cat",
	"identity_companion_cat",
	"identity_wild_cat",
	"identity_lone_cat",
])

const HAND_CARD_SIZE := Vector2(82, 118)
const PLAY_CARD_SIZE := Vector2(54, 76)
const HAND_LIFT_PX := 22.0
const HAND_SEL_SCALE := 1.07
const HAND_SELECTED := Color(1.15, 1.2, 1.05, 1.0)
const HAND_NORMAL := Color(1, 1, 1, 1)
const PLACEHOLDER_GENERAL_ID := "anjiang"
const PHASE_TEX_DIR := "res://meowkill/system/phase"
const SEAT_PHOTO_DIR := "res://meowkill/system/seat-num/photo"
const MAGATAMA_FULL_TEX := "res://meowkill/system/magatamas/1.png"
const MAGATAMA_EMPTY_TEX := "res://meowkill/system/magatamas/0.png"
const IDENTITY_CARD_BACK_TEX := "res://meowkill/system/card-back.png"

@onready var _hub: Node = get_node("/root/OnlineSession")
@onready var _log: RichTextLabel = %SnapshotLog
@onready var _phase_strip: TextureRect = %PhaseStrip
@onready var _chat_log: RichTextLabel = %ChatLog
@onready var _chat_line: LineEdit = %ChatLineEdit
@onready var _chat_send: Button = %ChatSend
@onready var _btn_back: Button = %BtnBackLobby
@onready var _top_hud: Label = %TopHudLabel
@onready var _deck_lbl: Label = %DeckCountLbl
@onready var _discard_lbl: Label = %DiscardCountLbl
@onready var _center_lbl: Label = get_node_or_null("TableShell/CenterPlay/CenterPlayLbl")
@onready var _hand_strip: HBoxContainer = %HandStrip
@onready var _play_area: HBoxContainer = %PlayAreaHBox
@onready var _action_hint: Label = %ActionHint
@onready var _confirm_hint: Label = %ConfirmHint
@onready var _btn_hand_confirm: Button = %BtnHandConfirm
@onready var _btn_hand_clear: Button = %BtnHandClear
@onready var _btn_slash_cancel_target: Button = %BtnSlashCancelTarget
@onready var _self_portrait: TextureRect = %SelfPortrait
@onready var _self_identity_badge: Label = %SelfIdentityBadge
@onready var _self_phase_ribbon: Label = %SelfPhaseRibbon
@onready var _self_name_lbl: Label = %SelfNameLbl
@onready var _self_hp_row: HBoxContainer = %SelfHpRow
@onready var _game_actions: VBoxContainer = %GameActions
@onready var _btn_confirm_identity: Button = %BtnConfirmIdentity
@onready var _btn_ai_delegate: Button = %BtnAiDelegate
@onready var _row_jink: HBoxContainer = get_node_or_null("SidePanel/SideVBox/GameActions/RowJink")
@onready var _row_dying: HBoxContainer = get_node_or_null("SidePanel/SideVBox/GameActions/RowDying")
@onready var _row_discard: HBoxContainer = get_node_or_null("SidePanel/SideVBox/GameActions/RowDiscard")
@onready var _btn_end_play: Button = %BtnEndPlay
@onready var _ed_jink: LineEdit = %EdJinkIdx
@onready var _btn_jink_yes: Button = %BtnJinkYes
@onready var _btn_jink_no: Button = %BtnJinkNo
@onready var _ed_peach: LineEdit = %EdPeachIdx
@onready var _btn_peach: Button = %BtnPeachDying
@onready var _btn_pass_dying: Button = %BtnPassDying

var _plaque_lbls: Array[Label] = []
var _plaque_panels: Array[PanelContainer] = []
var _last_snap: Dictionary = {}
var _self_seat: int = -1
var _last_hand: Array = []
var _selected_hand_idx: int = -1
var _hand_buttons: Array[TextureButton] = []
var _awaiting_slash_target: bool = false
var _slash_target_seat: int = -1
## 弃牌阶段多选手牌索引
var _discard_sel: Dictionary = {}
## 身份阶段：已在出牌区中央完成抽取动画后才可点「确认身份」
var _identity_center_drawn: bool = false
var _breed_center_drawn: bool = false
var _identity_draw_requested: bool = false
var _breed_draw_requested: bool = false
var _prev_snap_phase: String = ""
var _prev_pick_stage: String = ""
var _settlement_layer
## 身份阶段：牌堆与出牌区之间的可点击牌背
var _identity_draw_row: HBoxContainer


func _ready() -> void:
	_plaque_panels = [
		get_node("TableShell/PlaqueD0") as PanelContainer,
		get_node("TableShell/PlaqueD1") as PanelContainer,
		get_node("TableShell/PlaqueD2") as PanelContainer,
		get_node("TableShell/PlaqueD3") as PanelContainer,
		get_node("TableShell/PlaqueD4") as PanelContainer,
	]
	_init_plaque_chrome()
	_refresh_plaque_label_references()
	_ensure_self_general_card()
	_connect_plaque_input()
	if _hub.has_signal("match_meow_kill_server"):
		_hub.match_meow_kill_server.connect(_on_match_meow_kill_server)
	if _hub.has_signal("match_chat_received"):
		_hub.match_chat_received.connect(_on_match_chat_received)
	if _btn_back:
		_btn_back.pressed.connect(_on_back_pressed)
	if _btn_end_play:
		_btn_end_play.pressed.connect(_on_btn_end_play)
	if _btn_jink_no:
		_btn_jink_no.pressed.connect(_on_btn_jink_no)
	if _btn_pass_dying:
		_btn_pass_dying.pressed.connect(_on_btn_pass_dying)
	if _row_discard:
		_row_discard.visible = false
	if _ed_jink:
		_ed_jink.visible = false
	if _btn_jink_yes:
		_btn_jink_yes.visible = false
	if _ed_peach:
		_ed_peach.visible = false
	if _btn_peach:
		_btn_peach.visible = false
	if _btn_confirm_identity:
		_btn_confirm_identity.pressed.connect(_on_btn_confirm_identity)
	if _btn_ai_delegate:
		_btn_ai_delegate.pressed.connect(_on_btn_ai_delegate_pressed)
	if _btn_hand_confirm:
		_btn_hand_confirm.pressed.connect(_on_btn_hand_confirm)
	if _btn_hand_clear:
		_btn_hand_clear.pressed.connect(_on_btn_hand_clear)
	if _btn_slash_cancel_target:
		_btn_slash_cancel_target.pressed.connect(_on_slash_cancel_target)
	if _chat_send:
		_chat_send.pressed.connect(_on_chat_send)
	if _chat_line:
		_chat_line.text_submitted.connect(_on_chat_submitted)
	_style_round_badge_label(_self_identity_badge)
	_style_phase_ribbon_label(_self_phase_ribbon)
	call_deferred("_ensure_identity_draw_row")
	await get_tree().process_frame
	if _hub.has_method("replay_rt_mk_buffer"):
		_hub.replay_rt_mk_buffer()
	var mid: String = _hub.get_online_match_id() if _hub.has_method("get_online_match_id") else ""
	if not mid.is_empty() and _hub.has_method("join_match_chat_async"):
		var _ok: bool = await _hub.join_match_chat_async(mid)
	_refresh_action_ui()
	_update_confirm_bar()


func _exit_tree() -> void:
	if _hub != null and _hub.has_signal("match_meow_kill_server") and _hub.match_meow_kill_server.is_connected(_on_match_meow_kill_server):
		_hub.match_meow_kill_server.disconnect(_on_match_meow_kill_server)
	if _hub != null and _hub.has_signal("match_chat_received") and _hub.match_chat_received.is_connected(_on_match_chat_received):
		_hub.match_chat_received.disconnect(_on_match_chat_received)


func _send_mk_action(op: int, payload: Dictionary) -> void:
	if op != MK_REQ_DELEGATE and _self_delegate_on(_last_snap):
		return
	if _hub != null and _hub.has_method("send_meow_kill_action_async"):
		_hub.send_meow_kill_action_async(op, payload)


func _connect_plaque_input() -> void:
	for i in _plaque_panels.size():
		var p: PanelContainer = _plaque_panels[i]
		if p == null:
			continue
		p.mouse_filter = Control.MOUSE_FILTER_STOP
		p.gui_input.connect(_on_plaque_gui_input.bind(i))


func _on_plaque_gui_input(event: InputEvent, rel_idx: int) -> void:
	if not event is InputEventMouseButton:
		return
	var mb: InputEventMouseButton = event as InputEventMouseButton
	if not mb.pressed or mb.button_index != MOUSE_BUTTON_LEFT:
		return
	var data: Dictionary = _last_snap
	var phase: String = str(data.get("phase", ""))
	if phase != "playing":
		return
	if _self_delegate_on(data):
		return
	var self_s: int = int(data.get("self_seat", _self_seat))
	var pc: int = int(data.get("player_count", 5))
	if self_s < 0 or pc < 2:
		return
	if rel_idx < 0 or rel_idx >= pc:
		return
	var abs_seat: int = (self_s + rel_idx) % pc
	if not _awaiting_slash_target:
		return
	if abs_seat == self_s:
		_append_chat_system("不能以自己为「杀」的目标。")
		return
	var uname: String = _seat_display_name(data, abs_seat)
	_show_slash_confirm_dialog(abs_seat, uname)


func _seat_display_name(data: Dictionary, seat: int) -> String:
	var players: Array = data.get("players", []) as Array
	for item in players:
		if item is Dictionary:
			var p: Dictionary = item as Dictionary
			if int(p.get("seat", -99)) == seat:
				var u: String = str(p.get("username", ""))
				if u.is_empty():
					u = "座%d" % seat
				if bool(p.get("is_ai", false)):
					u += "·牌手"
				return u
	return "座%d" % seat


func _show_slash_confirm_dialog(target_seat: int, username: String) -> void:
	var dlg := ConfirmationDialog.new()
	dlg.title = "出杀确认"
	dlg.dialog_text = "是否要对 %s（座 %d）出杀？" % [username, target_seat]
	dlg.ok_button_text = "确认"
	dlg.cancel_button_text = "取消"
	add_child(dlg)
	dlg.popup_centered(Vector2(360, 140))
	dlg.confirmed.connect(func() -> void:
		_slash_target_seat = target_seat
		_awaiting_slash_target = false
		_send_play_selected(target_seat)
		_clear_hand_play_state()
		dlg.queue_free()
	)
	dlg.canceled.connect(func() -> void:
		dlg.queue_free()
	)


func _style_round_badge_label(lbl: Label) -> void:
	if lbl == null:
		return
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.72, 0.1, 0.08, 0.95)
	sb.border_color = Color(0.95, 0.88, 0.75, 1)
	sb.set_border_width_all(2)
	sb.set_corner_radius_all(10)
	lbl.add_theme_stylebox_override("normal", sb)
	lbl.add_theme_color_override("font_color", Color(1, 0.98, 0.94, 1))
	lbl.add_theme_font_size_override("font_size", 10)


func _style_phase_ribbon_label(lbl: Label) -> void:
	if lbl == null:
		return
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.55, 0.06, 0.06, 0.88)
	sb.set_corner_radius_all(3)
	lbl.add_theme_stylebox_override("normal", sb)


func _style_identity_badge_yellow(lbl: Label) -> void:
	if lbl == null:
		return
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.92, 0.76, 0.08, 0.92)
	sb.border_color = Color(0.2, 0.15, 0.05, 0.9)
	sb.set_border_width_all(1)
	sb.set_corner_radius_all(10)
	lbl.add_theme_stylebox_override("normal", sb)
	lbl.add_theme_color_override("font_color", Color(0.12, 0.1, 0.06, 1))
	lbl.add_theme_font_size_override("font_size", 9)


func _find_first_label_in_node(root: Node) -> Label:
	if root == null:
		return null
	if root is Label:
		return root as Label
	for ch in root.get_children():
		var f: Label = _find_first_label_in_node(ch)
		if f:
			return f
	return null


func _refresh_plaque_label_references() -> void:
	var keys: PackedStringArray = PackedStringArray(["PlaqueD0", "PlaqueD1", "PlaqueD2", "PlaqueD3", "PlaqueD4"])
	_plaque_lbls.clear()
	for nm in keys:
		var panel: PanelContainer = get_node_or_null("TableShell/%s" % nm) as PanelContainer
		var lbl: Label = null
		if panel:
			lbl = panel.find_child("%sLbl" % nm, true, false) as Label
		_plaque_lbls.append(lbl)


func _make_general_card_face_control() -> Control:
	var card := Control.new()
	card.name = "GeneralCard"
	card.custom_minimum_size = Vector2(108, 136)
	card.clip_contents = false
	var bg := TextureRect.new()
	bg.name = "FullSkinBg"
	bg.set_anchors_preset(Control.PRESET_FULL_RECT)
	bg.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	bg.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_COVERED
	card.add_child(bg)
	var equip := VBoxContainer.new()
	equip.name = "EquipStrip"
	equip.visible = false
	equip.set_anchors_preset(Control.PRESET_BOTTOM_WIDE)
	equip.offset_left = 10
	equip.offset_right = -10
	equip.offset_top = -52
	equip.offset_bottom = -4
	equip.add_theme_constant_override("separation", 2)
	equip.mouse_filter = Control.MOUSE_FILTER_IGNORE
	for _i in 4:
		var row := ColorRect.new()
		row.custom_minimum_size = Vector2(10, 10)
		row.color = Color(0.75, 0.18, 0.12, 0.35)
		equip.add_child(row)
	card.add_child(equip)
	var hp_strip := VBoxContainer.new()
	hp_strip.name = "HpStrip"
	hp_strip.set_anchors_preset(Control.PRESET_RIGHT_WIDE)
	hp_strip.offset_left = -12
	hp_strip.offset_right = -2
	hp_strip.offset_top = 26
	hp_strip.offset_bottom = -22
	hp_strip.add_theme_constant_override("separation", 2)
	hp_strip.alignment = BoxContainer.ALIGNMENT_CENTER
	hp_strip.mouse_filter = Control.MOUSE_FILTER_IGNORE
	card.add_child(hp_strip)
	var kico := TextureRect.new()
	kico.name = "KingdomIcon"
	kico.custom_minimum_size = Vector2(26, 26)
	kico.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	kico.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	kico.set_anchors_preset(Control.PRESET_TOP_LEFT)
	kico.offset_left = 3
	kico.offset_top = 3
	kico.offset_right = 29
	kico.offset_bottom = 29
	card.add_child(kico)
	var id_badge := Label.new()
	id_badge.name = "IdentityBadge"
	id_badge.visible = false
	id_badge.set_anchors_preset(Control.PRESET_TOP_RIGHT)
	id_badge.offset_left = -44
	id_badge.offset_top = 3
	id_badge.offset_right = -4
	id_badge.offset_bottom = 25
	id_badge.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	id_badge.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	_style_identity_badge_yellow(id_badge)
	card.add_child(id_badge)
	var seat_num := TextureRect.new()
	seat_num.name = "SeatNumPhoto"
	seat_num.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	seat_num.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	seat_num.set_anchors_preset(Control.PRESET_BOTTOM_RIGHT)
	seat_num.offset_left = -32
	seat_num.offset_top = -30
	seat_num.offset_right = -3
	seat_num.offset_bottom = -3
	card.add_child(seat_num)
	var gname := Label.new()
	gname.name = "GeneralNameLbl"
	gname.set_anchors_preset(Control.PRESET_BOTTOM_WIDE)
	gname.offset_left = 4
	gname.offset_right = -4
	gname.offset_top = -40
	gname.offset_bottom = -22
	gname.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	gname.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	gname.add_theme_font_size_override("font_size", 10)
	gname.add_theme_color_override("font_color", Color(0.78, 0.78, 0.82, 1))
	card.add_child(gname)
	var hc := Label.new()
	hc.name = "HandCountLbl"
	hc.set_anchors_preset(Control.PRESET_BOTTOM_LEFT)
	hc.offset_left = 4
	hc.offset_top = -22
	hc.offset_right = 44
	hc.offset_bottom = -3
	hc.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	hc.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	hc.add_theme_font_size_override("font_size", 12)
	hc.add_theme_color_override("font_color", Color(0.55, 0.78, 1.0, 1))
	var hc_sb := StyleBoxFlat.new()
	hc_sb.bg_color = Color(0.05, 0.12, 0.2, 0.72)
	hc_sb.set_corner_radius_all(4)
	hc.add_theme_stylebox_override("normal", hc_sb)
	card.add_child(hc)
	return card


func _build_plaque_chrome_v2(panel: PanelContainer, caption: Label, plaque_nm: String) -> void:
	if caption.get_parent():
		caption.get_parent().remove_child(caption)
	caption.name = "%sLbl" % plaque_nm
	caption.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	caption.vertical_alignment = VERTICAL_ALIGNMENT_TOP
	var outer := VBoxContainer.new()
	outer.name = "ChromeVBox"
	outer.add_theme_constant_override("separation", 2)
	var card: Control = _make_general_card_face_control()
	var pan_sb := StyleBoxFlat.new()
	pan_sb.bg_color = Color(0.04, 0.04, 0.06, 0.88)
	pan_sb.border_color = Color(0.55, 0.45, 0.22, 0.75)
	pan_sb.set_border_width_all(2)
	pan_sb.set_corner_radius_all(5)
	panel.add_theme_stylebox_override("panel", pan_sb)
	outer.add_child(card)
	caption.add_theme_color_override("font_color", Color(0.86, 0.84, 0.76, 0.92))
	caption.add_theme_font_size_override("font_size", 9)
	outer.add_child(caption)
	panel.add_child(outer)


func _init_plaque_chrome() -> void:
	var plaque_names: PackedStringArray = PackedStringArray(["PlaqueD0", "PlaqueD1", "PlaqueD2", "PlaqueD3", "PlaqueD4"])
	for nm in plaque_names:
		var panel: PanelContainer = get_node_or_null("TableShell/%s" % nm) as PanelContainer
		if panel == null:
			continue
		var cv_old: Node = panel.get_node_or_null("ChromeVBox")
		if cv_old != null:
			if cv_old.get_node_or_null("GeneralCard") != null:
				continue
			var cap_nm: String = "%sLbl" % nm
			var caption: Label = panel.get_node_or_null(cap_nm) as Label
			if caption == null:
				caption = cv_old.find_child(cap_nm, true, false) as Label
			if caption == null:
				caption = _find_first_label_in_node(cv_old)
			if caption and caption.get_parent():
				caption.get_parent().remove_child(caption)
			panel.remove_child(cv_old)
			cv_old.free()
			if caption == null:
				caption = Label.new()
				caption.name = cap_nm
				caption.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
			_build_plaque_chrome_v2(panel, caption, nm)
			continue
		var cap2: Label = panel.get_node_or_null("%sLbl" % nm) as Label
		if cap2 == null:
			continue
		panel.remove_child(cap2)
		_build_plaque_chrome_v2(panel, cap2, nm)


func _ensure_self_general_card() -> void:
	var frame: Control = get_node_or_null(
		"HandLayer/HandAnchor/LocalPlayerRoot/LocalPlayerHBox/SelfRightColumn/SelfPortraitFrame"
	) as Control
	if frame == null:
		return
	if frame.get_node_or_null("GeneralCard") != null:
		return
	if _self_portrait:
		_self_portrait.visible = false
	if _self_identity_badge:
		_self_identity_badge.visible = false
	var card: Control = _make_general_card_face_control()
	card.set_anchors_preset(Control.PRESET_FULL_RECT)
	card.offset_left = 0
	card.offset_top = 0
	card.offset_right = 0
	card.offset_bottom = 0
	frame.add_child(card)
	frame.move_child(card, 0)


func _rebuild_vertical_hp_strip(col: VBoxContainer, hp: int, max_hp: int) -> void:
	if col == null:
		return
	_clear_container_children(col)
	var n: int = clampi(max_hp, 1, 8)
	var h: int = clampi(hp, 0, n)
	var seg_h: float = 72.0 / float(n) if n > 0 else 8.0
	var tex_f: Texture2D = _load_tex_safe(MAGATAMA_FULL_TEX)
	var tex_e: Texture2D = _load_tex_safe(MAGATAMA_EMPTY_TEX)
	for i in n:
		var seg := TextureRect.new()
		seg.custom_minimum_size = Vector2(12, seg_h)
		seg.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		seg.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		seg.texture = tex_f if i < h else tex_e
		col.add_child(seg)


func _migrate_identity_to_text_badge_if_needed(card: Control) -> void:
	if card == null or card.get_node_or_null("IdentityBadge") != null:
		return
	var old_icon: Node = card.get_node_or_null("IdentityIcon")
	if old_icon:
		card.remove_child(old_icon)
		old_icon.free()
	var id_badge := Label.new()
	id_badge.name = "IdentityBadge"
	id_badge.visible = false
	id_badge.set_anchors_preset(Control.PRESET_TOP_RIGHT)
	id_badge.offset_left = -44
	id_badge.offset_top = 3
	id_badge.offset_right = -4
	id_badge.offset_bottom = 25
	id_badge.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	id_badge.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	_style_identity_badge_yellow(id_badge)
	card.add_child(id_badge)


func _general_id_for_seat(pl: Dictionary) -> String:
	var g: String = str(pl.get("general_id", ""))
	if not g.is_empty():
		return g
	return PLACEHOLDER_GENERAL_ID


func _general_name_zh_for_seat(pl: Dictionary) -> String:
	var gn: String = str(pl.get("general_name", ""))
	if not gn.is_empty():
		return gn
	if _general_id_for_seat(pl) == PLACEHOLDER_GENERAL_ID:
		return "暗将"
	return _general_id_for_seat(pl)


func _kingdom_key_for_seat(_data: Dictionary, _seat: int, pl: Dictionary) -> String:
	var from_srv: String = str(pl.get("kingdom", "")).to_lower()
	if not from_srv.is_empty():
		return from_srv
	if _general_id_for_seat(pl) == PLACEHOLDER_GENERAL_ID:
		return "god"
	return "qun"


func _apply_general_card_face(card: Control, data: Dictionary, seat: int, pl: Dictionary) -> void:
	if card == null:
		return
	_migrate_identity_to_text_badge_if_needed(card)
	var gid: String = _general_id_for_seat(pl)
	var fs: String = _fullskin_texture_path(gid)
	var bg: TextureRect = card.get_node_or_null("FullSkinBg") as TextureRect
	var kico: TextureRect = card.get_node_or_null("KingdomIcon") as TextureRect
	var id_badge: Label = card.get_node_or_null("IdentityBadge") as Label
	var seat_photo: TextureRect = card.get_node_or_null("SeatNumPhoto") as TextureRect
	var gname: Label = card.get_node_or_null("GeneralNameLbl") as Label
	var hand_lbl: Label = card.get_node_or_null("HandCountLbl") as Label
	var hp_strip: VBoxContainer = card.get_node_or_null("HpStrip") as VBoxContainer
	if bg:
		bg.texture = _load_tex_safe(fs)
	if kico:
		kico.texture = null
		kico.visible = false
	var hp: int = int(pl.get("hp", 0))
	var mhp: int = int(pl.get("max_hp", 4))
	if hp_strip:
		_rebuild_vertical_hp_strip(hp_strip, hp, mhp)
	var id_r: int = _identity_role_for_seat(data, seat, pl)
	if id_badge:
		if id_r >= 0:
			id_badge.text = _role_zh(id_r)
			id_badge.visible = true
		else:
			id_badge.visible = false
	if seat_photo:
		var sp: String = SEAT_PHOTO_DIR.path_join("%d.png" % (seat + 1))
		seat_photo.texture = _load_tex_safe(sp)
		seat_photo.visible = ResourceLoader.exists(sp)
	if gname:
		gname.text = _general_name_zh_for_seat(pl)
	var hc: int = int(pl.get("hand_count", 0))
	if hand_lbl:
		hand_lbl.text = str(hc)
	var eq_id: int = int(pl.get("equipped_weapon", -1))
	_update_equip_strip(card, eq_id)


func _update_equip_strip(card: Control, equipped_id: int) -> void:
	var strip: VBoxContainer = card.get_node_or_null("EquipStrip") as VBoxContainer
	if strip == null:
		return
	strip.visible = equipped_id >= 0
	_clear_container_children(strip)
	if equipped_id < 0:
		return
	var tex := TextureRect.new()
	tex.custom_minimum_size = Vector2(88, 36)
	tex.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	tex.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	var pth: String = MeowKillCardDefs.hand_texture_path_or_legacy_fallback(equipped_id)
	if ResourceLoader.exists(pth):
		tex.texture = load(pth) as Texture2D
	strip.add_child(tex)


func _identity_art_path(role_id: int) -> String:
	if role_id < 0 or role_id >= _identity_art_stems.size():
		return ""
	return MeowKillCardDefs.art_path_from_stem(str(_identity_art_stems[role_id]))


func _ensure_identity_draw_row() -> void:
	if _identity_draw_row != null and is_instance_valid(_identity_draw_row):
		return
	if _play_area == null:
		return
	var cv := _play_area.get_parent() as VBoxContainer
	if cv == null:
		return
	var row := HBoxContainer.new()
	row.name = "IdentityDrawRow"
	row.alignment = BoxContainer.ALIGNMENT_CENTER
	row.visible = false
	row.mouse_filter = Control.MOUSE_FILTER_STOP
	var btn := Button.new()
	btn.name = "IdentityDrawBtn"
	btn.focus_mode = Control.FOCUS_NONE
	btn.mouse_filter = Control.MOUSE_FILTER_STOP
	btn.custom_minimum_size = Vector2(150, 42)
	btn.text = "抽取身份牌"
	btn.pressed.connect(_on_identity_card_back_pressed)
	row.add_child(btn)
	var pa_idx: int = _play_area.get_index()
	cv.add_child(row)
	cv.move_child(row, pa_idx)
	_identity_draw_row = row


func _refresh_identity_draw_ui(data: Dictionary) -> void:
	_ensure_identity_draw_row()
	var phase: String = str(data.get("phase", ""))
	var judge: Label = get_node_or_null("TableShell/CenterPlay/CenterVBox/JudgeLbl") as Label
	if judge:
		judge.visible = phase != "picking_identity"
	if _identity_draw_row == null:
		return
	var draw_visible: bool = false
	var draw_text: String = "抽取身份牌"
	var stage: String = str(data.get("pick_stage", "identity"))
	if phase == "picking_identity":
		var self_s: int = int(data.get("self_seat", -1))
		if self_s >= 0:
			if stage == "identity":
				var arr: Array = data.get("identity_confirmed", []) as Array
				var confirmed: bool = self_s < arr.size() and bool(arr[self_s])
				draw_visible = not confirmed and not _identity_center_drawn
				draw_text = "抽取身份牌"
			else:
				var players: Array = data.get("players", []) as Array
				var bconfirmed: bool = false
				for item in players:
					if item is Dictionary and int((item as Dictionary).get("seat", -99)) == self_s:
						bconfirmed = bool((item as Dictionary).get("breed_confirmed", false))
						break
				draw_visible = not bconfirmed and not _breed_center_drawn
				draw_text = "抽取猫咪种类"
	_identity_draw_row.visible = draw_visible
	var btn: Button = _identity_draw_row.get_node_or_null("IdentityDrawBtn") as Button
	if btn:
		btn.text = draw_text


func _on_identity_card_back_pressed() -> void:
	var data: Dictionary = _last_snap
	if str(data.get("pick_stage", "identity")) == "breed":
		_try_perform_breed_draw()
		return
	_try_perform_identity_draw()


func _try_perform_identity_draw() -> void:
	var data: Dictionary = _last_snap
	if str(data.get("phase", "")) != "picking_identity":
		return
	if str(data.get("pick_stage", "identity")) != "identity":
		return
	var self_s: int = int(data.get("self_seat", -1))
	if self_s < 0:
		return
	if _self_delegate_on(data):
		return
	if _identity_center_drawn:
		return
	var arr: Array = data.get("identity_confirmed", []) as Array
	var already_confirmed: bool = self_s < arr.size() and bool(arr[self_s])
	var sr: int = int(data.get("self_role", -1))
	if sr < 0:
		_identity_draw_requested = true
		if not already_confirmed:
			_send_mk_action(MK_REQ_CONFIRM_IDENTITY, {})
		return
	_identity_center_drawn = true
	_refresh_identity_draw_ui(data)
	_play_identity_reveal_fx(sr)
	if not already_confirmed:
		_send_mk_action(MK_REQ_CONFIRM_IDENTITY, {})


func _try_perform_breed_draw() -> void:
	var data: Dictionary = _last_snap
	if str(data.get("phase", "")) != "picking_identity":
		return
	if str(data.get("pick_stage", "identity")) != "breed":
		return
	var self_s: int = int(data.get("self_seat", -1))
	if self_s < 0:
		return
	if _self_delegate_on(data):
		return
	var arr: Array = data.get("players", []) as Array
	var self_pl: Dictionary = {}
	for item in arr:
		if item is Dictionary and int((item as Dictionary).get("seat", -99)) == self_s:
			self_pl = item as Dictionary
			break
	var bc: bool = bool(self_pl.get("breed_confirmed", false))
	if bc or _breed_center_drawn:
		return
	var gid: String = str(self_pl.get("general_id", ""))
	if gid.is_empty():
		_breed_draw_requested = true
		_send_mk_action(MK_REQ_CONFIRM_BREED, {})
		return
	_breed_center_drawn = true
	_refresh_identity_draw_ui(data)
	_play_general_reveal_fx(gid)
	_send_mk_action(MK_REQ_CONFIRM_BREED, {})


func _play_identity_reveal_fx(role_id: int) -> void:
	var ap: String = _identity_art_path(role_id)
	if ap.is_empty() or not ResourceLoader.exists(ap):
		_refresh_action_ui()
		_update_plaque_chrome_from_snapshot(_last_snap)
		_update_self_bottom_bar(_last_snap)
		return
	_play_center_reveal_fx(ap)


func _play_general_reveal_fx(general_id: String) -> void:
	var ap: String = MeowKillCardDefs.art_path_from_stem(general_id)
	if ap.is_empty() or not ResourceLoader.exists(ap):
		_refresh_action_ui()
		_update_plaque_chrome_from_snapshot(_last_snap)
		_update_self_bottom_bar(_last_snap)
		return
	_play_center_reveal_fx(ap)


func _play_center_reveal_fx(ap: String) -> void:
	var host: Control = get_node_or_null("TableShell/CenterPlay/CenterVBox") as Control
	if host == null:
		host = get_node_or_null("TableShell/CenterPlay") as Control
	if host == null:
		return
	var ov := TextureRect.new()
	ov.custom_minimum_size = Vector2(120, 168)
	ov.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	ov.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	ov.texture = load(ap) as Texture2D
	ov.modulate.a = 0.0
	host.add_child(ov)
	var tw := create_tween()
	tw.tween_property(ov, "modulate:a", 1.0, 0.35)
	tw.tween_callback(func():
		_refresh_action_ui()
		_update_plaque_chrome_from_snapshot(_last_snap)
		_update_self_bottom_bar(_last_snap)
	)
	tw.tween_interval(1.35)
	tw.tween_property(ov, "modulate:a", 0.0, 0.4)
	tw.tween_callback(func():
		if is_instance_valid(ov):
			ov.queue_free()
	)

func _ensure_settlement_layer() -> CanvasLayer:
	if _settlement_layer != null and is_instance_valid(_settlement_layer):
		return _settlement_layer
	var ly := CanvasLayer.new()
	ly.layer = 110
	ly.name = "SettlementOverlay"
	add_child(ly)
	var panel := ColorRect.new()
	panel.color = Color(0.04, 0.05, 0.08, 0.82)
	panel.set_anchors_preset(Control.PRESET_FULL_RECT)
	panel.mouse_filter = Control.MOUSE_FILTER_STOP
	ly.add_child(panel)
	var box := VBoxContainer.new()
	box.set_anchors_preset(Control.PRESET_CENTER)
	box.offset_left = -180
	box.offset_top = -80
	box.offset_right = 180
	box.offset_bottom = 120
	box.add_theme_constant_override("separation", 14)
	box.grow_horizontal = Control.GROW_DIRECTION_BOTH
	box.grow_vertical = Control.GROW_DIRECTION_BOTH
	panel.add_child(box)
	var title := Label.new()
	title.name = "SettleTitle"
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	title.add_theme_font_size_override("font_size", 22)
	title.add_theme_color_override("font_color", Color(0.95, 0.88, 0.62, 1))
	title.text = "对局结束"
	box.add_child(title)
	var sub := Label.new()
	sub.name = "SettleSub"
	sub.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	sub.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	sub.custom_minimum_size = Vector2(280, 0)
	sub.add_theme_font_size_override("font_size", 15)
	sub.add_theme_color_override("font_color", Color(0.88, 0.9, 0.86, 1))
	box.add_child(sub)
	var btn := Button.new()
	btn.text = "返回大厅"
	btn.custom_minimum_size = Vector2(200, 40)
	btn.pressed.connect(_on_settlement_back_pressed)
	box.add_child(btn)
	_settlement_layer = ly
	ly.visible = false
	return ly


func _update_settlement_visibility(data: Dictionary) -> void:
	var ly := _ensure_settlement_layer()
	var phase: String = str(data.get("phase", ""))
	var win: Variant = data.get("winner", null)
	var done: bool = phase == "finished" or (win != null and str(win) != "")
	ly.visible = done
	if not done:
		return
	var sub: Label = ly.find_child("SettleSub", true, false) as Label
	if sub:
		var wzh: String = str(data.get("winner_label_zh", ""))
		if wzh.is_empty():
			wzh = str(data.get("winner", ""))
		sub.text = wzh if not wzh.is_empty() else "胜负已分"


func _on_settlement_back_pressed() -> void:
	if _hub.has_method("leave_online_match_cleanup_async"):
		await _hub.leave_online_match_cleanup_async()
	get_tree().change_scene_to_file("res://scenes/multiplayer_lobby.tscn")


func _load_tex_safe(path: String) -> Texture2D:
	if path.is_empty() or not ResourceLoader.exists(path):
		return null
	return load(path) as Texture2D


func _fullskin_texture_path(general_id: String) -> String:
	var p: String = "res://meowkill/fullskin/generals/full/%s.png" % general_id
	if ResourceLoader.exists(p):
		return p
	var p_cards: String = MeowKillCardDefs.art_path_from_stem(general_id)
	return p_cards if ResourceLoader.exists(p_cards) else ""


func _identity_role_for_seat(data: Dictionary, seat: int, _pl: Dictionary) -> int:
	var phase: String = str(data.get("phase", ""))
	var self_s: int = int(data.get("self_seat", -1))
	if phase == "picking_identity":
		if seat != self_s:
			return -1
		var arr: Array = data.get("identity_confirmed", []) as Array
		var confirmed: bool = self_s >= 0 and self_s < arr.size() and bool(arr[self_s])
		if not _identity_center_drawn and not confirmed:
			return -1
		return int(data.get("self_role", -1))
	if seat == self_s:
		return int(data.get("self_role", -1))
	var rp: Variant = _pl.get("role_public", null)
	if rp == null:
		return -1
	return int(rp)


func _update_phase_ribbon_label(ribbon: Label, _data: Dictionary, _seat: int) -> void:
	if ribbon == null:
		return
	ribbon.visible = false


func _refresh_phase_strip_texture(data: Dictionary) -> void:
	if _phase_strip == null:
		return
	var phase: String = str(data.get("phase", ""))
	var fname: String = "round_start.png"
	if phase == "picking_identity":
		fname = "start.png"
	elif phase == "finished":
		fname = "finish.png"
	elif phase == "playing":
		var sub: String = str(data.get("sub_phase", "play"))
		if sub == "discard":
			fname = "discard.png"
		else:
			var pend: Variant = data.get("pending", null)
			if pend is Dictionary:
				var pk: String = str((pend as Dictionary).get("kind", ""))
				if pk == "jink" or pk == "dying":
					fname = "judge.png"
				else:
					fname = "play.png"
			else:
				fname = "play.png"
	_phase_strip.texture = _load_tex_safe(PHASE_TEX_DIR.path_join(fname))


func _refresh_event_log_view(data: Dictionary, seq: int, phase: String) -> void:
	if _log == null:
		return
	_log.clear()
	_log.append_text("[b]seq[/b] %d · %s\n" % [seq, phase])
	var ev: Variant = data.get("event_log", [])
	if ev is Array and (ev as Array).size() > 0:
		for ln in ev as Array:
			var s: String = str(ln).strip_edges()
			if not s.is_empty():
				_log.append_text(s + "\n")
	else:
		_log.append_text("（暂无战报）\n")


func _update_plaque_chrome_from_snapshot(data: Dictionary) -> void:
	var players: Array = data.get("players", []) as Array
	var pc: int = int(data.get("player_count", 5))
	var self_seat: int = int(data.get("self_seat", _self_seat))
	if self_seat < 0:
		return
	var by_seat: Dictionary = {}
	for item in players:
		if item is Dictionary:
			var p: Dictionary = item as Dictionary
			by_seat[int(p.get("seat", -1))] = p
	var plaque_names: PackedStringArray = PackedStringArray(["PlaqueD0", "PlaqueD1", "PlaqueD2", "PlaqueD3", "PlaqueD4"])
	for d in range(mini(5, plaque_names.size())):
		var panel: PanelContainer = get_node_or_null("TableShell/%s" % plaque_names[d]) as PanelContainer
		if panel == null or not panel.visible:
			continue
		var chrome: VBoxContainer = panel.get_node_or_null("ChromeVBox") as VBoxContainer
		if chrome == null:
			continue
		var card: Control = chrome.get_node_or_null("GeneralCard") as Control
		if card == null:
			continue
		var seat: int = (self_seat + d) % pc if pc > 0 else -1
		if seat < 0 or not by_seat.has(seat):
			var bg0: TextureRect = card.get_node_or_null("FullSkinBg") as TextureRect
			if bg0:
				bg0.texture = null
			var hp0: VBoxContainer = card.get_node_or_null("HpStrip") as VBoxContainer
			if hp0:
				_clear_container_children(hp0)
			var id_leg0: TextureRect = card.get_node_or_null("IdentityIcon") as TextureRect
			if id_leg0:
				id_leg0.texture = null
				id_leg0.visible = false
			var id0: Label = card.get_node_or_null("IdentityBadge") as Label
			if id0:
				id0.visible = false
			var sn0: TextureRect = card.get_node_or_null("SeatNumPhoto") as TextureRect
			if sn0:
				sn0.texture = null
				sn0.visible = false
			var hn0: Label = card.get_node_or_null("GeneralNameLbl") as Label
			if hn0:
				hn0.text = ""
			var hc0: Label = card.get_node_or_null("HandCountLbl") as Label
			if hc0:
				hc0.text = ""
			var k0: TextureRect = card.get_node_or_null("KingdomIcon") as TextureRect
			if k0:
				k0.texture = null
			continue
		var pl: Dictionary = by_seat[seat] as Dictionary
		_apply_general_card_face(card, data, seat, pl)


func _update_self_bottom_bar(data: Dictionary) -> void:
	var self_s: int = int(data.get("self_seat", _self_seat))
	var players: Array = data.get("players", []) as Array
	var by_seat: Dictionary = {}
	for item in players:
		if item is Dictionary:
			var p: Dictionary = item as Dictionary
			by_seat[int(p.get("seat", -1))] = p
	if self_s < 0 or not by_seat.has(self_s):
		return
	var pl: Dictionary = by_seat[self_s] as Dictionary
	_ensure_self_general_card()
	var frame: Control = get_node_or_null(
		"HandLayer/HandAnchor/LocalPlayerRoot/LocalPlayerHBox/SelfRightColumn/SelfPortraitFrame"
	) as Control
	var card: Control = frame.get_node_or_null("GeneralCard") as Control if frame else null
	if card:
		_apply_general_card_face(card, data, self_s, pl)
	if _self_name_lbl:
		_self_name_lbl.visible = false
	if _self_hp_row:
		_self_hp_row.visible = false
	if _self_phase_ribbon:
		_update_phase_ribbon_label(_self_phase_ribbon, data, self_s)


func _snapshot_hand_array(data: Dictionary) -> Array:
	var raw: Variant = data.get("self_hand", [])
	var out: Array = []
	if raw == null:
		raw = []
	if raw is Array:
		for x in raw as Array:
			out.append(int(x))
		return out
	return out


func _role_zh(role: int) -> String:
	match role:
		0:
			return "家猫"
		1:
			return "同伴猫"
		2:
			return "野猫"
		3:
			return "独行猫"
		_:
			return "?"


func _append_log_line(bb: String) -> void:
	if _log == null:
		return
	_log.append_text(bb + "\n")


func _on_match_chat_received(p_username: String, p_text: String, _p_sender_id: String) -> void:
	if _chat_log == null:
		return
	var who: String = p_username if not p_username.is_empty() else "?"
	_chat_log.append_text("[color=#aaccff]%s[/color]: %s\n" % [who, p_text])


func _append_chat_system(msg: String) -> void:
	if _chat_log:
		_chat_log.append_text("[color=#888888]%s[/color]\n" % msg)


func _on_chat_send() -> void:
	_submit_chat()


func _on_chat_submitted(_t: String) -> void:
	_submit_chat()


func _submit_chat() -> void:
	if _chat_line == null or _hub == null:
		return
	var t: String = _chat_line.text.strip_edges()
	if t.is_empty():
		return
	_chat_line.text = ""
	if _hub.has_method("send_match_chat_async"):
		await _hub.send_match_chat_async(t)


func _self_seat_from_snapshot(seats: Array) -> int:
	var uid: String = ""
	if _hub.session != null:
		uid = str(_hub.session.user_id)
	if uid.is_empty():
		return -1
	for item in seats:
		if item is Dictionary:
			var d: Dictionary = item as Dictionary
			if str(d.get("user_id", "")) == uid:
				return int(d.get("seat", -1))
	return -1


func _clear_container_children(c: Node) -> void:
	if c == null:
		return
	for ch in c.get_children():
		ch.queue_free()


func _make_hand_card_slot(path: String, index: int) -> Control:
	var slot := Control.new()
	slot.custom_minimum_size = Vector2(HAND_CARD_SIZE.x + 6, HAND_CARD_SIZE.y + HAND_LIFT_PX + 10.0)
	var btn := TextureButton.new()
	btn.name = "CardBtn"
	btn.custom_minimum_size = HAND_CARD_SIZE
	btn.ignore_texture_size = true
	btn.stretch_mode = TextureButton.STRETCH_KEEP_ASPECT_CENTERED
	if ResourceLoader.exists(path):
		btn.texture_normal = load(path) as Texture2D
	btn.toggle_mode = false
	btn.focus_mode = Control.FOCUS_NONE
	btn.pressed.connect(_on_hand_button_pressed.bind(index))
	btn.set_anchor(SIDE_LEFT, 0.5)
	btn.set_anchor(SIDE_RIGHT, 0.5)
	btn.set_anchor(SIDE_TOP, 1.0)
	btn.set_anchor(SIDE_BOTTOM, 1.0)
	btn.offset_left = -HAND_CARD_SIZE.x * 0.5
	btn.offset_right = HAND_CARD_SIZE.x * 0.5
	btn.offset_top = -HAND_CARD_SIZE.y
	btn.offset_bottom = 0.0
	btn.pivot_offset = Vector2(HAND_CARD_SIZE.x * 0.5, HAND_CARD_SIZE.y)
	slot.add_child(btn)
	return slot


func _tween_hand_lift(btn: TextureButton, lifted: bool) -> void:
	if btn == null or not is_instance_valid(btn):
		return
	if btn.has_meta("lift_tween"):
		var old: Tween = btn.get_meta("lift_tween") as Tween
		if old != null and is_instance_valid(old):
			old.kill()
	var target_y := -HAND_CARD_SIZE.y - (HAND_LIFT_PX if lifted else 0.0)
	var sc := HAND_SEL_SCALE if lifted else 1.0
	var tw := create_tween()
	tw.set_parallel(true)
	tw.set_trans(Tween.TRANS_CUBIC)
	tw.set_ease(Tween.EASE_OUT)
	tw.tween_property(btn, "offset_top", target_y, 0.14)
	tw.tween_property(btn, "scale", Vector2(sc, sc), 0.14)
	btn.set_meta("lift_tween", tw)
	btn.z_index = 1 if lifted else 0
	btn.modulate = HAND_SELECTED if lifted else HAND_NORMAL


func _apply_all_hand_lifts() -> void:
	var data: Dictionary = _last_snap
	var sub: String = str(data.get("sub_phase", "play"))
	var turn_s: int = int(data.get("turn_seat", -1))
	var self_s: int = int(data.get("self_seat", _self_seat))
	var pending: Variant = data.get("pending", null)
	var discard_mode: bool = (
		sub == "discard"
		and self_s == turn_s
		and (pending == null or not pending is Dictionary)
	)
	for i in _hand_buttons.size():
		var hb: TextureButton = _hand_buttons[i]
		if hb and is_instance_valid(hb):
			var sel: bool = _discard_sel.has(i) if discard_mode else i == _selected_hand_idx
			_tween_hand_lift(hb, sel)


func _on_hand_button_pressed(idx: int) -> void:
	var data: Dictionary = _last_snap
	var phase: String = str(data.get("phase", ""))
	var playing: bool = phase == "playing" and data.get("winner", null) == null
	if not playing:
		return
	var self_s: int = int(data.get("self_seat", _self_seat))
	var turn_s: int = int(data.get("turn_seat", -1))
	var sub: String = str(data.get("sub_phase", "play"))
	var pending: Variant = data.get("pending", null)
	if pending is Dictionary:
		var pk: String = str((pending as Dictionary).get("kind", ""))
		if pk == "jink" and _pending_jink_victim(pending) == self_s:
			if _selected_hand_idx == idx:
				_selected_hand_idx = -1
			else:
				_selected_hand_idx = idx
			_apply_all_hand_lifts()
			_update_confirm_bar()
			return
		if pk == "dying" and _pending_dying_ask_seat(pending) == self_s:
			if _selected_hand_idx == idx:
				_selected_hand_idx = -1
			else:
				_selected_hand_idx = idx
			_apply_all_hand_lifts()
			_update_confirm_bar()
			return
	if sub == "discard" and self_s == turn_s and (pending == null or not pending is Dictionary):
		if _discard_sel.has(idx):
			_discard_sel.erase(idx)
		else:
			_discard_sel[idx] = true
		_apply_all_hand_lifts()
		_update_confirm_bar()
		return
	if pending != null or self_s != turn_s or sub != "play":
		return
	if _selected_hand_idx == idx:
		_clear_hand_play_state()
		if _action_hint:
			_action_hint.text = "已取消选择。"
		return
	_selected_hand_idx = idx
	_apply_all_hand_lifts()
	_awaiting_slash_target = false
	_clear_slash_target_only()
	_update_confirm_bar()
	var cid: int = int(_last_hand[idx]) if idx >= 0 and idx < _last_hand.size() else -1
	if _action_hint:
		var ck: String = CardRules.card_key(cid)
		if ck == "slash":
			_action_hint.text = "已选：杀（%d）。点「确认出牌」后，再点一名其他玩家，并确认。" % idx
		else:
			_action_hint.text = "已选：%s（%d），点「确认出牌」直接打出。" % [CardRules.card_label_zh(cid), idx]


func _clear_hand_play_state() -> void:
	_selected_hand_idx = -1
	_discard_sel.clear()
	_awaiting_slash_target = false
	_slash_target_seat = -1
	_apply_all_hand_lifts()
	for hb in _hand_buttons:
		if hb and is_instance_valid(hb):
			hb.z_index = 0
	_update_confirm_bar()


func _clear_slash_target_only() -> void:
	_slash_target_seat = -1


func _on_btn_hand_clear() -> void:
	_clear_hand_play_state()
	_update_confirm_bar()
	if _action_hint:
		_action_hint.text = "已取消选择。"


func _on_slash_cancel_target() -> void:
	_awaiting_slash_target = false
	_slash_target_seat = -1
	_update_confirm_bar()
	if _action_hint:
		_action_hint.text = "请再次点击一名其他玩家作为杀的目标。"


func _update_confirm_bar() -> void:
	if _btn_hand_confirm == null or _confirm_hint == null:
		return
	var data: Dictionary = _last_snap
	var phase: String = str(data.get("phase", ""))
	var playing: bool = phase == "playing" and data.get("winner", null) == null
	var self_s: int = int(data.get("self_seat", _self_seat))
	var turn_s: int = int(data.get("turn_seat", -1))
	var sub: String = str(data.get("sub_phase", "play"))
	var pending: Variant = data.get("pending", null)
	if not playing:
		_btn_hand_confirm.text = "确认"
		_btn_hand_confirm.disabled = true
		_confirm_hint.text = "等待中"
		if _btn_slash_cancel_target:
			_btn_slash_cancel_target.visible = false
		return
	if _self_delegate_on(data):
		_btn_hand_confirm.disabled = true
		_btn_hand_confirm.text = "确认出牌"
		_confirm_hint.text = "托管中，AI 代为操作（右侧可取消托管）"
		if _btn_slash_cancel_target:
			_btn_slash_cancel_target.visible = false
		return
	if pending is Dictionary:
		var pk: String = str((pending as Dictionary).get("kind", ""))
		if pk == "jink" and _pending_jink_victim(pending) == self_s:
			_btn_hand_confirm.text = "打出闪"
			if _selected_hand_idx < 0:
				_btn_hand_confirm.disabled = true
				_confirm_hint.text = "点选一张「闪」，再确认（或点右侧「否」不出闪）"
			else:
				var cj: int = int(_last_hand[_selected_hand_idx]) if _selected_hand_idx < _last_hand.size() else -1
				if CardRules.card_key(cj) != "jink":
					_btn_hand_confirm.disabled = true
					_confirm_hint.text = "请选择手牌中的「闪」"
				else:
					_btn_hand_confirm.disabled = false
					_confirm_hint.text = "确认打出这张闪"
			if _btn_slash_cancel_target:
				_btn_slash_cancel_target.visible = false
			return
		if pk == "dying" and _pending_dying_ask_seat(pending) == self_s:
			_btn_hand_confirm.text = "使用桃"
			if _selected_hand_idx < 0:
				_btn_hand_confirm.disabled = true
				_confirm_hint.text = "点选「桃」救人，或点右侧「不救」"
			else:
				var cp: int = int(_last_hand[_selected_hand_idx]) if _selected_hand_idx < _last_hand.size() else -1
				if CardRules.card_key(cp) != "peach":
					_btn_hand_confirm.disabled = true
					_confirm_hint.text = "请选择手牌中的「桃」"
				else:
					_btn_hand_confirm.disabled = false
					_confirm_hint.text = "确认使用桃救人"
			if _btn_slash_cancel_target:
				_btn_slash_cancel_target.visible = false
			return
	if sub == "discard" and self_s == turn_s and (pending == null or not pending is Dictionary):
		_btn_hand_confirm.text = "确认弃牌"
		var need: int = maxi(0, _last_hand.size() - _hp_of_seat(data, self_s))
		if _discard_sel.is_empty():
			_btn_hand_confirm.disabled = true
			_confirm_hint.text = "弃牌阶段：点选要弃的牌（至少还需弃 %d 张），可多选后一次确认" % need
		else:
			_btn_hand_confirm.disabled = false
			_confirm_hint.text = "已选 %d 张牌，确认弃置（仍需手牌≤体力，可多次确认）" % _discard_sel.size()
		if _btn_slash_cancel_target:
			_btn_slash_cancel_target.visible = false
		return
	_btn_hand_confirm.text = "确认出牌"
	if pending != null:
		_btn_hand_confirm.disabled = true
		_confirm_hint.text = "等待其他玩家操作…"
		if _btn_slash_cancel_target:
			_btn_slash_cancel_target.visible = false
		return
	if self_s != turn_s or sub != "play":
		_btn_hand_confirm.disabled = true
		_confirm_hint.text = "非你的出牌阶段"
		if _btn_slash_cancel_target:
			_btn_slash_cancel_target.visible = false
		return
	if _selected_hand_idx < 0:
		_btn_hand_confirm.disabled = true
		_confirm_hint.text = "点选下方手牌，再按「确认出牌」"
		if _btn_slash_cancel_target:
			_btn_slash_cancel_target.visible = false
		return
	var cid: int = int(_last_hand[_selected_hand_idx]) if _selected_hand_idx < _last_hand.size() else -1
	var ck: String = CardRules.card_key(cid)
	if ck == "slash":
		if _awaiting_slash_target:
			_btn_hand_confirm.disabled = true
			_confirm_hint.text = "请点击桌面上的一名其他玩家（头像区域）"
			if _btn_slash_cancel_target:
				_btn_slash_cancel_target.visible = true
		else:
			_btn_hand_confirm.disabled = false
			_confirm_hint.text = "杀：点「确认出牌」后选择目标玩家"
			if _btn_slash_cancel_target:
				_btn_slash_cancel_target.visible = false
	else:
		_btn_hand_confirm.disabled = false
		_confirm_hint.text = "将打出：%s" % CardRules.card_label_zh(cid)
		if _btn_slash_cancel_target:
			_btn_slash_cancel_target.visible = false


func _on_btn_hand_confirm() -> void:
	var data: Dictionary = _last_snap
	var self_s: int = int(data.get("self_seat", _self_seat))
	var turn_s: int = int(data.get("turn_seat", -1))
	var sub: String = str(data.get("sub_phase", "play"))
	var pending: Variant = data.get("pending", null)
	if pending is Dictionary:
		var pk: String = str((pending as Dictionary).get("kind", ""))
		if pk == "jink" and _pending_jink_victim(pending) == self_s:
			if _selected_hand_idx < 0 or _hub == null:
				return
			var cj: int = int(_last_hand[_selected_hand_idx]) if _selected_hand_idx < _last_hand.size() else -1
			if CardRules.card_key(cj) != "jink":
				return
			_send_mk_action(MK_REQ_RESPOND_JINK, {"use": true, "hand_index": _selected_hand_idx})
			_clear_hand_play_state()
			return
		if pk == "dying" and _pending_dying_ask_seat(pending) == self_s:
			if _selected_hand_idx < 0 or _hub == null:
				return
			var cp: int = int(_last_hand[_selected_hand_idx]) if _selected_hand_idx < _last_hand.size() else -1
			if CardRules.card_key(cp) != "peach":
				return
			_send_mk_action(MK_REQ_PEACH_DYING, {"hand_index": _selected_hand_idx})
			_clear_hand_play_state()
			return
	if sub == "discard" and self_s == turn_s and (pending == null or not pending is Dictionary):
		if _hub == null or _discard_sel.is_empty():
			return
		var idxs: Array = []
		for k in _discard_sel.keys():
			idxs.append(int(k))
		idxs.sort()
		_send_mk_action(MK_REQ_DISCARD, {"hand_indices": idxs})
		_discard_sel.clear()
		_apply_all_hand_lifts()
		_update_confirm_bar()
		return
	if _selected_hand_idx < 0:
		return
	var cid: int = int(_last_hand[_selected_hand_idx]) if _selected_hand_idx < _last_hand.size() else -1
	var ck: String = CardRules.card_key(cid)
	if ck == "slash":
		if not _awaiting_slash_target:
			_awaiting_slash_target = true
			_update_confirm_bar()
			if _action_hint:
				_action_hint.text = "请点击一名其他玩家作为「杀」的目标（头像或面板）。"
		return
	_send_play_selected(0)


func _send_play_selected(target_seat: int) -> void:
	if _hub == null or _selected_hand_idx < 0:
		return
	_send_mk_action(MK_REQ_PLAY_CARD, {"hand_index": _selected_hand_idx, "target_seat": target_seat})


func _card_key_for_instance(cid: int) -> String:
	var key: String = CardRules.card_key(cid)
	if key == "?":
		return "slash"
	return key


func _self_identity_confirmed(data: Dictionary) -> bool:
	var self_s: int = int(data.get("self_seat", -1))
	if self_s < 0:
		return false
	var arr: Array = data.get("identity_confirmed", []) as Array
	if self_s >= arr.size():
		return false
	return bool(arr[self_s])


func _self_delegate_on(data: Dictionary) -> bool:
	var self_s: int = int(data.get("self_seat", -1))
	if self_s < 0:
		return false
	var arr: Array = data.get("ai_delegate", []) as Array
	if self_s >= arr.size():
		return false
	return bool(arr[self_s])


func _self_is_human_player(data: Dictionary) -> bool:
	var self_s: int = int(data.get("self_seat", -1))
	if self_s < 0:
		return false
	var players: Array = data.get("players", []) as Array
	for item in players:
		if item is Dictionary:
			var p: Dictionary = item as Dictionary
			if int(p.get("seat", -99)) == self_s:
				return not bool(p.get("is_ai", false))
	return false


func _on_btn_ai_delegate_pressed() -> void:
	var on: bool = not _self_delegate_on(_last_snap)
	_send_mk_action(MK_REQ_DELEGATE, {"on": on})


func _rebuild_hand_strip(hand: Array) -> void:
	_clear_container_children(_hand_strip)
	_hand_buttons.clear()
	if _hand_strip == null:
		return
	var idx: int = 0
	for cid_v in hand:
		var path: String = MeowKillCardDefs.hand_texture_path_or_legacy_fallback(int(cid_v))
		var slot: Control = _make_hand_card_slot(path, idx)
		_hand_strip.add_child(slot)
		var b: TextureButton = slot.get_node("CardBtn") as TextureButton
		_hand_buttons.append(b)
		idx += 1
	_clear_hand_play_state()


func _rebuild_play_area(data: Dictionary) -> void:
	_clear_container_children(_play_area)
	if _play_area == null:
		return
	var phase: String = str(data.get("phase", ""))
	if phase == "finished":
		return
	var pending: Variant = data.get("pending", null)
	if pending is Dictionary:
		var d: Dictionary = pending as Dictionary
		if str(d.get("kind", "")) == "jink":
			var cid: int = int(d.get("card_id", -1))
			var path: String = MeowKillCardDefs.play_texture_path_or_legacy_fallback(cid)
			_play_area.add_child(_texture_rect_for_card(path, PLAY_CARD_SIZE))


func _texture_rect_for_card(path: String, pixel_size: Vector2) -> TextureRect:
	var tex_rect := TextureRect.new()
	tex_rect.custom_minimum_size = pixel_size
	tex_rect.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	tex_rect.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	if ResourceLoader.exists(path):
		tex_rect.texture = load(path) as Texture2D
	return tex_rect


func _format_hand(arr: Array) -> String:
	if arr.is_empty():
		return "（空）"
	var parts: PackedStringArray = PackedStringArray()
	var i: int = 0
	for v in arr:
		var cid: int = int(v)
		parts.append("%d:%s" % [i, CardRules.card_label_zh(cid)])
		i += 1
	return ", ".join(parts)


func _pending_jink_victim(pending: Variant) -> int:
	if pending is Dictionary:
		var d: Dictionary = pending as Dictionary
		if str(d.get("kind", "")) != "jink":
			return -1
		return int(d.get("victim", -1))
	return -1


func _pending_dying_ask_seat(pending: Variant) -> int:
	if pending is Dictionary:
		var d: Dictionary = pending as Dictionary
		if str(d.get("kind", "")) != "dying":
			return -1
		var ask_order: Array = d.get("askOrder", d.get("ask_order", [])) as Array
		var ai: int = int(d.get("askIdx", d.get("ask_idx", 0)))
		if ai < 0 or ai >= ask_order.size():
			return -1
		return int(ask_order[ai])
	return -1


func _update_plaques(seats: Array, player_count: int) -> void:
	for lbl in _plaque_lbls:
		if lbl:
			lbl.text = ""
	var self_seat: int = _self_seat_from_snapshot(seats)
	_self_seat = self_seat
	if self_seat < 0:
		if _top_hud:
			_top_hud.text = "等待座位分配…"
		return
	var n: int = clampi(player_count, 1, 8)
	if n < 1:
		return
	for item in seats:
		if not item is Dictionary:
			continue
		var entry: Dictionary = item as Dictionary
		var s: int = int(entry.get("seat", -1))
		if s < 0 or s >= n:
			continue
		var d: int = TableLayout.relative_seat(self_seat, s, n)
		if d < 0 or d >= _plaque_lbls.size():
			continue
		var un: String = str(entry.get("username", ""))
		var ai: bool = bool(entry.get("is_ai", false))
		var tag: String = "·牌手" if ai else ""
		var line: String = "座%d %s%s" % [s, un, tag]
		var lbl: Label = _plaque_lbls[d]
		if lbl:
			lbl.text = line
	_update_top_hud_from_snap(_last_snap)


func _update_top_hud_from_snap(data: Dictionary) -> void:
	if _top_hud == null:
		return
	var phase: String = str(data.get("phase", ""))
	var pc: int = int(data.get("player_count", 5))
	var turn_s: int = int(data.get("turn_seat", -1))
	var sub: String = str(data.get("sub_phase", ""))
	var lord_s: int = int(data.get("lord_seat", -1))
	var self_s: int = int(data.get("self_seat", _self_seat))
	var sub_zh: String = "出牌" if sub == "play" else ("弃牌" if sub == "discard" else sub)
	var turn_name: String = _seat_display_name(data, turn_s) if turn_s >= 0 else "—"
	var you: String = "（你的回合）" if self_s == turn_s and phase == "playing" else ""
	if phase == "picking_identity":
		_top_hud.text = "阶段：确认身份 · 全员确认后发起始手牌"
	elif phase == "finished":
		var wl: String = str(data.get("winner_label_zh", ""))
		_top_hud.text = "对局结束 · %s" % wl
	elif phase == "playing":
		_top_hud.text = "家猫座 %d · 当前 %s 的回合 %s · %s人局" % [lord_s, turn_name, sub_zh, pc]
		if not you.is_empty():
			_top_hud.text += " %s" % you
	else:
		_top_hud.text = "等待中…"


func _update_center_piles(data: Dictionary) -> void:
	if _deck_lbl:
		_deck_lbl.text = "牌堆 %d" % int(data.get("deck_count", 0))
	if _discard_lbl:
		_discard_lbl.text = "弃牌 %d" % int(data.get("discard_count", 0))


func _build_game_state_text(data: Dictionary) -> String:
	var ver: int = int(data.get("v", 0))
	var phase: String = str(data.get("phase", ""))
	var pc: int = int(data.get("player_count", 5))
	var turn_s: int = int(data.get("turn_seat", -1))
	var sub: String = str(data.get("sub_phase", ""))
	var deck_c: int = int(data.get("deck_count", 0))
	var disc_c: int = int(data.get("discard_count", 0))
	var lord_s: int = int(data.get("lord_seat", -1))
	var winner: Variant = data.get("winner", null)
	var wzh: String = str(data.get("winner_label_zh", ""))
	var wstr: String = ""
	if not wzh.is_empty():
		wstr = " %s" % wzh
	elif winner != null and str(winner) != "":
		wstr = " 胜负：%s" % str(winner)
	var sr: int = int(data.get("self_role", -1))
	var lines: PackedStringArray = PackedStringArray()
	lines.append("v%d · %s · %d人 · 回%d·%s" % [ver, phase, pc, turn_s, sub])
	if sr >= 0:
		lines.append("身份：%s" % _role_zh(sr))
	elif phase == "picking_identity":
		lines.append("身份：确认前保密")
	lines.append("家猫%d 牌堆%d 弃牌%d%s" % [lord_s, deck_c, disc_c, wstr])
	var players: Array = data.get("players", []) as Array
	for item in players:
		if not item is Dictionary:
			continue
		var p: Dictionary = item as Dictionary
		var s: int = int(p.get("seat", -1))
		var alive: bool = bool(p.get("alive", true))
		var hp: int = int(p.get("hp", 0))
		var mhp: int = int(p.get("max_hp", 0))
		var hc: int = int(p.get("hand_count", 0))
		var rp: Variant = p.get("role_public", null)
		var rtag: String = ""
		if rp != null:
			rtag = " %s" % _role_zh(int(rp))
		var st: String = "活" if alive else "死"
		lines.append("座%d %s HP%d/%d 手%d%s" % [s, st, hp, mhp, hc, rtag])
	return "\n".join(lines)


func _update_center_play(data: Dictionary) -> void:
	if _center_lbl == null:
		return
	var phase: String = str(data.get("phase", ""))
	if phase == "picking_identity":
		var nconf: int = 0
		var arr: Array = data.get("identity_confirmed", []) as Array
		for v in arr:
			if bool(v):
				nconf += 1
		_center_lbl.text = "%d/%d 已就绪" % [nconf, arr.size()]
	_refresh_identity_draw_ui(data)
	if phase == "picking_identity":
		return
	if phase == "finished":
		var wl: String = str(data.get("winner_label_zh", ""))
		if wl.is_empty():
			wl = str(data.get("winner", ""))
		_center_lbl.text = "对局结束 · %s" % wl
		return
	var pending: Variant = data.get("pending", null)
	if pending == null:
		var sub0: String = str(data.get("sub_phase", "play"))
		var turn0: int = int(data.get("turn_seat", -1))
		var self0: int = int(data.get("self_seat", _self_seat))
		if sub0 == "discard" and self0 == turn0:
			_center_lbl.text = "弃牌阶段：请弃至手牌 ≤ 体力"
		elif sub0 == "discard":
			_center_lbl.text = "弃牌阶段：座 %d 正在弃牌" % turn0
		else:
			_center_lbl.text = "出牌区（出牌阶段）"
		return
	if pending is Dictionary:
		var d: Dictionary = pending as Dictionary
		var k: String = str(d.get("kind", ""))
		if k == "jink":
			_center_lbl.text = "询问闪：座%d 杀 → 座%d" % [
				int(d.get("attacker", -1)), int(d.get("victim", -1))
			]
		elif k == "dying":
			var ask_order2: Array = d.get("askOrder", d.get("ask_order", [])) as Array
			var ai: int = int(d.get("askIdx", d.get("ask_idx", 0)))
			var asker: int = -1
			if ai >= 0 and ai < ask_order2.size():
				asker = int(ask_order2[ai])
			_center_lbl.text = "濒死：座%d 求桃（询问 座%d）" % [
				int(d.get("seat", -1)), asker
			]
		else:
			_center_lbl.text = "询问（%s）" % k


func _refresh_action_ui() -> void:
	var data: Dictionary = _last_snap
	var phase: String = str(data.get("phase", ""))
	var winner: Variant = data.get("winner", null)
	var finished: bool = phase == "finished" or (winner != null and str(winner) != "")
	_update_settlement_visibility(data)
	var picking: bool = phase == "picking_identity"
	var playing: bool = phase == "playing" and not finished
	var self_s: int = int(data.get("self_seat", _self_seat))
	var turn_s: int = int(data.get("turn_seat", -1))
	var sub: String = str(data.get("sub_phase", "play"))
	var pending: Variant = data.get("pending", null)
	if finished:
		if _game_actions:
			_game_actions.visible = false
		if _btn_confirm_identity:
			_btn_confirm_identity.visible = false
		if _btn_ai_delegate:
			_btn_ai_delegate.visible = false
		return
	if _game_actions:
		_game_actions.visible = picking or playing
	if _btn_ai_delegate:
		var hum: bool = _self_is_human_player(data)
		_btn_ai_delegate.visible = (picking or playing) and self_s >= 0 and hum
		if _btn_ai_delegate.visible:
			_btn_ai_delegate.text = "取消托管" if _self_delegate_on(data) else "AI托管"
	if not picking and not playing:
		if _btn_confirm_identity:
			_btn_confirm_identity.visible = false
		if _btn_ai_delegate:
			_btn_ai_delegate.visible = false
		return
	if picking:
		if _btn_confirm_identity:
			_btn_confirm_identity.visible = false
		if _btn_end_play:
			_btn_end_play.visible = false
		if _row_jink:
			_row_jink.visible = false
		if _row_dying:
			_row_dying.visible = false
		if _row_discard:
			_row_discard.visible = false
		return
	if _btn_confirm_identity:
		_btn_confirm_identity.visible = false
	var show_play: bool = false
	var show_jink: bool = false
	var show_dying: bool = false
	if pending != null and pending is Dictionary:
		var pk: String = str((pending as Dictionary).get("kind", ""))
		if pk == "jink":
			show_jink = _pending_jink_victim(pending) == self_s
		elif pk == "dying":
			show_dying = _pending_dying_ask_seat(pending) == self_s
	if pending == null and self_s == turn_s:
		if sub == "play":
			show_play = true
	if _btn_end_play:
		_btn_end_play.visible = show_play
	if _row_discard:
		_row_discard.visible = false
	if _row_jink:
		_row_jink.visible = show_jink
		if _ed_jink:
			_ed_jink.visible = false
		if _btn_jink_yes:
			_btn_jink_yes.visible = false
		if _btn_jink_no:
			_btn_jink_no.visible = show_jink
	if _row_dying:
		_row_dying.visible = show_dying
		if _ed_peach:
			_ed_peach.visible = false
		if _btn_peach:
			_btn_peach.visible = false
		if _btn_pass_dying:
			_btn_pass_dying.visible = show_dying
	_update_confirm_bar()


func _on_btn_end_play() -> void:
	_send_mk_action(MK_REQ_END_PLAY, {})


func _on_btn_jink_no() -> void:
	_send_mk_action(MK_REQ_RESPOND_JINK, {"use": false, "hand_index": 0})
	_clear_hand_play_state()


func _on_btn_pass_dying() -> void:
	_send_mk_action(MK_REQ_PASS_DYING, {})
	_clear_hand_play_state()


func _on_btn_confirm_identity() -> void:
	_send_mk_action(MK_REQ_CONFIRM_IDENTITY, {})


func _hp_of_seat(snap: Dictionary, seat: int) -> int:
	var players: Array = snap.get("players", []) as Array
	for item in players:
		if item is Dictionary:
			var p: Dictionary = item as Dictionary
			if int(p.get("seat", -99)) == seat:
				return int(p.get("hp", 0))
	return -1


func _detect_slash_hit_victim(old_snap: Dictionary, new_snap: Dictionary) -> int:
	if old_snap.is_empty():
		return -1
	var op: Variant = old_snap.get("pending", null)
	if op == null or not op is Dictionary:
		return -1
	if str(op.get("kind", "")) != "jink":
		return -1
	var victim: int = int(op.get("victim", -1))
	if victim < 0:
		return -1
	var np: Variant = new_snap.get("pending", null)
	if np is Dictionary:
		var nk: String = str(np.get("kind", ""))
		if nk == "jink" and int(np.get("victim", -99)) == victim:
			return -1
	var old_hp: int = _hp_of_seat(old_snap, victim)
	var new_hp: int = _hp_of_seat(new_snap, victim)
	if new_hp < old_hp:
		return victim
	return -1


func _run_slash_hit_fx_on_seat_after_layout(seat: int) -> void:
	await get_tree().process_frame
	var data: Dictionary = _last_snap
	var self_s: int = int(data.get("self_seat", _self_seat))
	var pc: int = int(data.get("player_count", 5))
	if self_s < 0 or seat < 0:
		return
	var rel: int = TableLayout.relative_seat(self_s, seat, pc)
	var target: Control = null
	if rel == 0:
		target = _self_portrait.get_parent() as Control if _self_portrait else null
	else:
		if rel >= 0 and rel < _plaque_panels.size():
			target = _plaque_panels[rel] as Control
	if target == null or not is_instance_valid(target):
		return
	target.pivot_offset = target.size * 0.5
	if target.pivot_offset.length() < 1.0:
		target.pivot_offset = target.custom_minimum_size * 0.5
	var slash := ColorRect.new()
	slash.set_anchors_preset(Control.PRESET_FULL_RECT)
	slash.color = Color(0.92, 0.12, 0.06, 0.0)
	slash.mouse_filter = Control.MOUSE_FILTER_IGNORE
	slash.z_index = 80
	target.add_child(slash)
	var tw := create_tween()
	tw.tween_property(slash, "color", Color(0.95, 0.18, 0.08, 0.52), 0.07)
	tw.tween_property(slash, "color", Color(0.95, 0.18, 0.08, 0.0), 0.28)
	tw.tween_callback(func(): slash.queue_free())
	var tw2 := create_tween()
	var r0: float = target.rotation
	tw2.tween_property(target, "rotation", r0 + 0.11, 0.06)
	tw2.tween_property(target, "rotation", r0 - 0.07, 0.07)
	tw2.tween_property(target, "rotation", r0, 0.11)


func _on_match_meow_kill_server(op_code: int, data: Dictionary) -> void:
	if op_code == MK_OP_ERROR:
		var err: String = str(data.get("error", "?"))
		_append_log_line("[color=#ff8888]错误: %s[/color]" % err)
		return
	if op_code != MK_OP_SNAPSHOT:
		return
	var old_snap: Dictionary = _last_snap.duplicate(true)
	var hit_seat: int = _detect_slash_hit_victim(old_snap, data)
	_last_snap = data
	var phase: String = str(data.get("phase", ""))
	var pick_stage: String = str(data.get("pick_stage", "identity"))
	if phase == "picking_identity" and _prev_snap_phase != "picking_identity":
		_identity_center_drawn = false
		_breed_center_drawn = false
		_identity_draw_requested = false
		_breed_draw_requested = false
		_prev_pick_stage = pick_stage
	if phase == "picking_identity" and _prev_pick_stage != pick_stage:
		if pick_stage == "breed":
			_breed_center_drawn = false
			_breed_draw_requested = false
		_prev_pick_stage = pick_stage
	if phase != "picking_identity":
		_prev_pick_stage = ""
		_identity_draw_requested = false
		_breed_draw_requested = false
	_prev_snap_phase = phase
	var seq: int = int(data.get("seq", 0))
	var seats: Array = data.get("seats", []) as Array
	var pc: int = int(data.get("player_count", seats.size()))
	_update_plaques(seats, pc)
	_update_plaque_chrome_from_snapshot(data)
	_update_self_bottom_bar(data)
	_self_seat = int(data.get("self_seat", _self_seat))
	_last_hand = _snapshot_hand_array(data)
	var hand_cnt_srv: int = int(data.get("self_hand_count", _last_hand.size()))
	var ph: String = str(data.get("phase", ""))
	if ph == "playing" and _last_hand.is_empty() and hand_cnt_srv > 0:
		push_warning("猫猫杀: self_hand 为空但服务端 self_hand_count=%d" % hand_cnt_srv)
	if ph == "picking_identity":
		_rebuild_hand_strip([])
	else:
		_rebuild_hand_strip(_last_hand)
	_rebuild_play_area(data)
	_update_center_play(data)
	_update_center_piles(data)
	_update_top_hud_from_snap(data)
	_refresh_action_ui()
	_refresh_phase_strip_texture(data)
	_refresh_event_log_view(data, seq, phase)
	if phase == "picking_identity":
		var self_s_pick: int = int(data.get("self_seat", -1))
		if _identity_draw_requested and not _identity_center_drawn:
			var sr_pick: int = int(data.get("self_role", -1))
			if sr_pick >= 0:
				_identity_draw_requested = false
				_identity_center_drawn = true
				_play_identity_reveal_fx(sr_pick)
		elif pick_stage == "breed" and _breed_draw_requested and not _breed_center_drawn and self_s_pick >= 0:
			var players_pick: Array = data.get("players", []) as Array
			for item in players_pick:
				if item is Dictionary and int((item as Dictionary).get("seat", -99)) == self_s_pick:
					var gid_pick: String = str((item as Dictionary).get("general_id", ""))
					var bc_pick: bool = bool((item as Dictionary).get("breed_confirmed", false))
					if bc_pick and not gid_pick.is_empty():
						_breed_draw_requested = false
						_breed_center_drawn = true
						_play_general_reveal_fx(gid_pick)
					break
	if _action_hint and ph == "picking_identity":
		if pick_stage == "breed":
			_action_hint.text = "点击中央按钮「抽取猫咪种类」，完成后进入发牌阶段。"
		else:
			_action_hint.text = "点击中央按钮「抽取身份牌」，完成后进入猫种抽取。"
	elif _action_hint and ph == "playing" and _selected_hand_idx < 0:
		var subp: String = str(data.get("sub_phase", "play"))
		var turn_s2: int = int(data.get("turn_seat", -1))
		var self_s2: int = int(data.get("self_seat", _self_seat))
		if subp == "discard" and self_s2 == turn_s2:
			_action_hint.text = "弃牌阶段：点选手牌多选要弃的牌，按「确认弃牌」（可多次确认直到手牌≤体力）。"
		else:
			_action_hint.text = "点选手牌，在牌上方确认栏「确认出牌」；结束出牌后进入弃牌阶段。"
	if hit_seat >= 0:
		call_deferred("_run_slash_hit_fx_on_seat_after_layout", hit_seat)


func _on_back_pressed() -> void:
	if _hub.has_method("leave_online_match_cleanup_async"):
		await _hub.leave_online_match_cleanup_async()
	get_tree().change_scene_to_file("res://scenes/multiplayer_lobby.tscn")
