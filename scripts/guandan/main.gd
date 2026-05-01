extends Control
## 掼蛋客户端主场景：服务端权威快照 → 渲染 4 人桌面 → 发送 GD_REQ_*。
##
## 布局原则（按 user 设计）：
##   - 4 家分别占据画面 上 / 下 / 左 / 右 四个方位；逻辑座位 → UI 方位映射：
##     bottom = self_seat        (屏幕下方)
##     right  = (self_seat+1) %4 (屏幕右侧)
##     top    = (self_seat+2) %4 (队友, 屏幕上方)
##     left   = (self_seat+3) %4 (屏幕左侧)
##   - 每家三段：头像/名字 (灰)  +  手牌或牌背 (红)  +  最近一手出牌 (绿)；
##     自家底部多一行 操作按钮 (黄)。
##   - 各区域无背景无边框，借桌布大图本身的木框为整桌"画框"。
##   - 顶栏左侧为牌局信息（含红心级牌示意），右侧为出牌记录。
##
## 卡牌贴图沿用斗地主 `res://assets/Cards/...`，掼蛋花色序 (0♠ 1♥ 2♣ 3♦) 通过 card_defs.texture_path_for 映射。

const GuandanDefs := preload("res://scripts/guandan/card_defs.gd")
const GdPlayLine := preload("res://scripts/guandan/play_line_builder.gd")
const GuandanHintSelectScr := preload("res://scripts/guandan/hint_select.gd")
const SEAT_SPEECH_BUBBLE_SCENE: PackedScene = preload("res://scenes/seat_speech_bubble.tscn")
const _SeatSpeechBubbleScr = preload("res://scripts/seat_speech_bubble.gd")

## 自家手牌尺寸（最多 27 张，需要 overlap 才能容纳）
const HAND_CARD_W: float = 64.0
const HAND_CARD_H: float = 90.0
const HAND_OVERLAP: float = -39.0       # 间距再缩半（相对 -14 步长约减半）
const HAND_DRAG_THRESHOLD_PX: float = 14.0
## 桌面（出牌区）卡牌尺寸
const PLAY_CARD_W: float = 46.0
const PLAY_CARD_H: float = 66.0
const PLAY_OVERLAP_H: float = -4.0
const PLAY_OVERLAP_V: float = -16.0
## 对家牌背 mini
const TOP_BACK_W: float = 24.0
const TOP_BACK_H: float = 34.0
const TOP_BACK_STEP: float = 6.0
## 左右两家：牌背贴图顺时针旋转 90°，横躺后竖直堆叠。
## visual_w / visual_h 是旋转后视觉外框尺寸；内部 TextureRect 使用 raw = (visual_h, visual_w) 配合 rotation_degrees=90。
const SIDE_BACK_VISUAL_W: float = 38.0
const SIDE_BACK_VISUAL_H: float = 26.0
const SIDE_BACK_STEP: float = 8.0
const SIDE_BACK_MIN_STEP: float = 2.0
const TOP_BACK_MIN_STEP: float = 2.0
## 左右家出牌区也旋转 90°（与手牌方向一致）
const SIDE_PLAY_STEP: float = 16.0
## 顶部队友明牌（玩家上游后翻开对家）尺寸同 PLAY（可单独调），排版参照 TOP 行
const TEAMMATE_CARD_W: float = 44.0
const TEAMMATE_CARD_H: float = 62.0
const TEAMMATE_STEP_MIN: float = 3.0
## 顶栏出牌记录宽度（旧版约 360px 的 1/3）
const GUANDAN_PLAY_LOG_PANEL_W: int = 240

const AVATAR_SIZE: float = 72.0
const SIDE_AVATAR_SIZE: float = 64.0
const COLOR_SEAT_HUMAN: Color = Color(1.0, 1.0, 1.0, 1.0)
const COLOR_SEAT_AI: Color = Color(1.0, 0.86, 0.38, 1.0)
## 各家信息行「剩 N 张」字号（曾为大字，现约为原先一半以省纵向空间）
const SEAT_META_REMAIN_FONT: int = 13
## 出牌气泡针脚与头像边沿间距（像素）
const _SPEECH_TAIL_GAP_PX: float = 8.0

## 掼蛋四只猫与 seat_cats[座] 值 0–3 一一对应：丑丑妹、咪宝宝、毛睿睿、叮叮
const GUANDAN_CAT_TEXTURES: Array[String] = [
	"res://CardsAssets/guandan_cat_choumeimei.png",
	"res://CardsAssets/guandan_cat_mibaobao.png",
	"res://CardsAssets/guandan_cat_maoruirui.png",
	"res://CardsAssets/guandan_cat_dingding.png",
]
const GUANDAN_CAT_NAMES: Array[String] = ["丑丑妹", "咪宝宝", "毛睿睿", "叮叮"]

## 与斗地主 `scripts/main.gd` 同资源，掼蛋出牌/过/炸音效
const SFX_PLAY_PATH: String = "res://MusicAssets/carddrop.mp3"
const SFX_BOMB_PATH: String = "res://MusicAssets/medium-explosion.mp3"
const SFX_ROCKET_PATH: String = "res://MusicAssets/launch.mp3"
const SFX_PASS: AudioStream = preload("res://audio/sfx_pass.wav")
const BGM_GUANDAN_PATH: String = "res://MusicAssets/BalatroMainTheme.mp3"
const SFX_SETTLE_PATH: String = "res://MusicAssets/level.mp3"

@onready var _hub: Node = get_node("/root/OnlineSession")
@onready var _sfx: AudioStreamPlayer = $SfxPlayer
@onready var _sfx_bomb_pl: AudioStreamPlayer = $SfxBombPlayer

var _self_seat: int = -1
var _self_hand: Array[int] = []
var _snapshot: Dictionary = {}
var _selected_ids: Dictionary = {}
var _seat_last_action: Dictionary = {}    # seat:int → { "kind": "play"|"pass", "ids": Array[int], "seq": int }
var _last_seen_seq: int = -1

# UI 节点引用
var _bg: TextureRect
var _info_stage_label: Label            # 左上角：阶段名（如「出牌阶段」）
var _level_team_label: Label              # 红心级牌短说明
var _lvl_our_value: Label                 # 我方级数大字
var _lvl_them_value: Label              # 对方级数大字
var _level_card_rect: TextureRect       # 本局级牌：红桃示意的贴图
var _deal_fx_seq: int = -1
## deal 手牌明牌入位：同一手牌内容只建一次+播一次，避免快照刷屏打断
var _deal_hand_anim_sig: String = ""
const DEAL_HAND_STAGGER_SEC: float = 0.09
const DEAL_HAND_IN_DURATION: float = 0.32
const DEAL_HAND_SLIDE_PX: float = 32.0
var _turn_status_label: Label           # 当前轮到哪只猫（进贡/还贡/出牌）
var _play_log: RichTextLabel            # 出牌记录（右侧、可滚动）
var _seat_nodes: Array = []               # index = ui_pos (0=bottom 1=right 2=top 3=left)
var _hand_area: Control                   # 自家手牌区
var _btn_play: Button
var _btn_pass: Button
var _btn_tribute: Button
var _btn_resist: Button
var _btn_return: Button
var _btn_hint: Button
var _btn_delegate: Button
var _btn_continue: Button
var _btn_settle_lobby: Button
var _btn_leave: Button
var _msg_label: Label
var _hint_label: Label
var _settle_overlay: Control
var _settle_label_left: Label
var _settle_label_right: Label
var _settle_wait_hint: Label
## 手牌区透明底板：框选起点落在牌缝时接收事件
var _hand_gap_catcher: Control
## 拖拽多选
var _hand_press_down: bool = false
var _hand_press_start: Vector2 = Vector2.ZERO
var _hand_press_id: int = -1
## 本段按住是否曾拉过框选（超过 HAND_DRAG_THRESHOLD_PX）
var _rubber_ever: bool = false
var _rubber_band: ColorRect
var _settle_panel: PanelContainer
var _settle_dim: ColorRect
var _bgm_player: AudioStreamPlayer
var _settle_sfx: AudioStreamPlayer
var _bgm_slider: HSlider
var _btn_bgm_mute: Button
var _bgm_linear: float = 0.3
var _bgm_linear_before_mute: float = 0.3
## 出牌气泡（斗地主同款 SeatSpeechBubble ×4）
var _speech_layer: CanvasLayer
var _speech_bubbles: Array = []
## 已播过出牌动画的签名 seat → "seq:kind:id,id,…"（避免他人「过」后整桌重绘重复播）
var _play_anim_done_key: Dictionary = {}
var _sfx_card_stream: AudioStream
var _sfx_bomb_stream: AudioStream
var _sfx_rocket_stream: AudioStream


func _ready() -> void:
	_build_ui()
	_init_guandan_sfx()
	var vp := get_viewport()
	if vp != null and not vp.size_changed.is_connected(_on_viewport_resized):
		vp.size_changed.connect(_on_viewport_resized)
	if _hub == null:
		_set_info("未连接 OnlineSession")
		return
	if _hub.has_signal("match_gd_server"):
		_hub.match_gd_server.connect(_on_match_gd_server)
	if _hub.has_signal("match_rt_disconnected"):
		_hub.match_rt_disconnected.connect(_on_match_rt_disconnected)
	if _hub.has_method("replay_rt_gd_buffer"):
		_hub.replay_rt_gd_buffer()
	set_process(false)


func _process(_dt: float) -> void:
	if not _hand_press_down:
		set_process(false)
		return
	if Input.is_mouse_button_pressed(MOUSE_BUTTON_LEFT):
		var cur: Vector2 = get_viewport().get_mouse_position()
		if _hand_press_start.distance_to(cur) > HAND_DRAG_THRESHOLD_PX:
			_rubber_ever = true
			var rr: Rect2 = Rect2(_hand_press_start, Vector2.ZERO).expand(cur)
			_rubber_band.visible = true
			_rubber_band.global_position = rr.position
			_rubber_band.size = rr.size
			_rubber_band.color = Color(0.3, 0.65, 1.0, 0.22)
		return
	var endg: Vector2 = get_viewport().get_mouse_position()
	if _rubber_ever:
		_rect_select_union(endg)
	else:
		if _hand_press_id >= 0:
			_toggle_select_id(_hand_press_id)
		else:
			_selected_ids.clear()
			_render_hand()
			_update_controls()
	_hand_press_down = false
	_rubber_ever = false
	_rubber_band.visible = false
	_rubber_band.color = Color(0.28, 0.62, 1.0, 0.2)
	set_process(false)


func _on_viewport_resized() -> void:
	# 发牌动画依赖宽度假定步长；视口变化时允许重排（会重播一次入位）
	if str(_snapshot.get("phase", "")) == "deal":
		_deal_hand_anim_sig = ""
	if _self_hand.size() > 0 and _hand_area != null:
		_render_hand()


func _exit_tree() -> void:
	if _hub != null and _hub.has_signal("match_gd_server") and _hub.match_gd_server.is_connected(_on_match_gd_server):
		_hub.match_gd_server.disconnect(_on_match_gd_server)
	if _hub != null and _hub.has_signal("match_rt_disconnected") and _hub.match_rt_disconnected.is_connected(_on_match_rt_disconnected):
		_hub.match_rt_disconnected.disconnect(_on_match_rt_disconnected)
	if _bgm_player != null and _bgm_player.playing:
		_bgm_player.stop()
# ============================================================
# UI 构造（无背景无边框）
# ============================================================

func _build_ui() -> void:
	_build_bg()
	_seat_nodes.clear()
	_seat_nodes.resize(4)
	_build_seat_top()      # ui_pos=2
	_build_seat_left()     # ui_pos=3
	_build_seat_right()    # ui_pos=1
	_build_seat_bottom()   # ui_pos=0 + 我的手牌 + 按钮
	_build_info_corner()
	_build_msg_label()
	_build_settle_overlay()
	_build_rubber_band()
	_setup_guandan_bgm_and_settle_sfx()
	_setup_seat_speech_bubbles()
	if not get_viewport().size_changed.is_connected(_on_viewport_speech_layout):
		get_viewport().size_changed.connect(_on_viewport_speech_layout)


## 首个快照到达后隐藏 tscn 中的「正在进入对局…」提示。
func _hide_loading_label() -> void:
	var lbl: Label = get_node_or_null("LoadingLabel") as Label
	if lbl != null:
		lbl.visible = false


func _build_bg() -> void:
	# 背景与 Dim 在 scenes/guandan/main.tscn 中已作为固定节点提供（Bg/Dim）。
	# 若 tscn 被简化掉这两个节点，此处兜底动态创建以保证不会出现纯白空场景。
	_bg = get_node_or_null("Bg") as TextureRect
	if _bg == null:
		_bg = TextureRect.new()
		_bg.name = "Bg"
		_bg.anchor_right = 1.0
		_bg.anchor_bottom = 1.0
		_bg.mouse_filter = Control.MOUSE_FILTER_IGNORE
		_bg.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		_bg.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_COVERED
		var tex_path := "res://CardsAssets/gdbg.png"
		if ResourceLoader.exists(tex_path):
			_bg.texture = load(tex_path)
		add_child(_bg)
		move_child(_bg, 0)
	if get_node_or_null("Dim") == null:
		var dim := ColorRect.new()
		dim.name = "Dim"
		dim.anchor_right = 1.0
		dim.anchor_bottom = 1.0
		dim.color = Color(0.02, 0.06, 0.04, 0.30)
		dim.mouse_filter = Control.MOUSE_FILTER_IGNORE
		add_child(dim)
		move_child(dim, 1)


## 头像 + 金色回合方框（直角、与头像贴齐）；返回 stack / avatar / turn_glow / rank_badge（名次改在信息行显示，角标保留占位）
func _make_avatar_stack(tex_size: Vector2) -> Dictionary:
	var stack := Control.new()
	stack.custom_minimum_size = tex_size
	var avatar := TextureRect.new()
	avatar.custom_minimum_size = tex_size
	avatar.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	avatar.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	avatar.anchor_left = 0.5
	avatar.anchor_right = 0.5
	avatar.anchor_top = 0.5
	avatar.anchor_bottom = 0.5
	avatar.offset_left = -tex_size.x * 0.5
	avatar.offset_right = tex_size.x * 0.5
	avatar.offset_top = -tex_size.y * 0.5
	avatar.offset_bottom = tex_size.y * 0.5
	stack.add_child(avatar)
	var idle := Panel.new()
	idle.mouse_filter = Control.MOUSE_FILTER_IGNORE
	idle.anchor_left = 0.5
	idle.anchor_right = 0.5
	idle.anchor_top = 0.5
	idle.anchor_bottom = 0.5
	idle.offset_left = -tex_size.x * 0.5
	idle.offset_right = tex_size.x * 0.5
	idle.offset_top = -tex_size.y * 0.5
	idle.offset_bottom = tex_size.y * 0.5
	var ibs := StyleBoxFlat.new()
	ibs.bg_color = Color(0, 0, 0, 0)
	ibs.set_border_width_all(2)
	ibs.border_color = Color(0.93, 0.84, 0.58, 0.62)
	ibs.corner_radius_top_left = 0
	ibs.corner_radius_top_right = 0
	ibs.corner_radius_bottom_left = 0
	ibs.corner_radius_bottom_right = 0
	idle.add_theme_stylebox_override("panel", ibs)
	stack.add_child(idle)
	var glow := Panel.new()
	glow.mouse_filter = Control.MOUSE_FILTER_IGNORE
	glow.anchor_left = 0.5
	glow.anchor_right = 0.5
	glow.anchor_top = 0.5
	glow.anchor_bottom = 0.5
	glow.offset_left = -tex_size.x * 0.5
	glow.offset_right = tex_size.x * 0.5
	glow.offset_top = -tex_size.y * 0.5
	glow.offset_bottom = tex_size.y * 0.5
	var gbs := StyleBoxFlat.new()
	gbs.bg_color = Color(0, 0, 0, 0)
	gbs.set_border_width_all(3)
	gbs.border_color = Color(1.0, 0.82, 0.2, 0.98)
	gbs.corner_radius_top_left = 0
	gbs.corner_radius_top_right = 0
	gbs.corner_radius_bottom_left = 0
	gbs.corner_radius_bottom_right = 0
	glow.add_theme_stylebox_override("panel", gbs)
	glow.visible = false
	stack.add_child(glow)
	var rank_badge := Label.new()
	rank_badge.visible = false
	rank_badge.mouse_filter = Control.MOUSE_FILTER_IGNORE
	stack.add_child(rank_badge)
	return {"stack": stack, "avatar": avatar, "idle_frame": idle, "turn_glow": glow, "rank_badge": rank_badge}


func _run_turn_glow_pulse(glow: Panel) -> void:
	if glow == null:
		return
	_stop_turn_glow_pulse(glow)
	glow.visible = true
	glow.modulate = Color(1, 1, 1, 1)
	var tw: Tween = create_tween().set_loops()
	tw.tween_property(glow, "modulate:a", 0.42, 0.48)
	tw.tween_property(glow, "modulate:a", 1.0, 0.48)
	glow.set_meta("pulse_tween", tw)


func _stop_turn_glow_pulse(glow: Panel) -> void:
	if glow == null:
		return
	if glow.has_meta("pulse_tween"):
		var t: Variant = glow.get_meta("pulse_tween")
		if t is Tween and (t as Tween).is_valid():
			(t as Tween).kill()
		glow.remove_meta("pulse_tween")
	glow.visible = false
	glow.modulate = Color.WHITE


# ------------------------------------------------------------
# 顶部对家（ui_pos=2）：从上到下 = 头像/名字 → 牌背堆 → 最近一手
# ------------------------------------------------------------

func _build_seat_top() -> void:
	var root := Control.new()
	root.name = "SeatTop"
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.anchor_left = 0.5
	root.anchor_right = 0.5
	root.anchor_top = 0.0
	root.anchor_bottom = 0.0
	root.offset_left = -300
	root.offset_right = 300
	root.offset_top = 8
	root.offset_bottom = 220
	add_child(root)
	var col := VBoxContainer.new()
	col.anchor_right = 1.0
	col.anchor_bottom = 1.0
	col.alignment = BoxContainer.ALIGNMENT_CENTER
	col.add_theme_constant_override("separation", 4)
	root.add_child(col)
	# 头像 + 名字 / 元信息
	var header := HBoxContainer.new()
	header.add_theme_constant_override("separation", 4)
	header.alignment = BoxContainer.ALIGNMENT_CENTER
	col.add_child(header)
	var stk: Dictionary = _make_avatar_stack(Vector2(AVATAR_SIZE, AVATAR_SIZE))
	header.add_child(stk["stack"] as Control)
	var avatar: TextureRect = stk["avatar"] as TextureRect
	var info := VBoxContainer.new()
	info.add_theme_constant_override("separation", 0)
	header.add_child(info)
	var name_lbl := _mk_text_label("", 12, Color(1, 0.96, 0.86, 1))
	info.add_child(name_lbl)
	var meta_lbl := _mk_seat_meta_richtext()
	info.add_child(meta_lbl)
	# 牌背（红区）
	var back_holder := CenterContainer.new()
	back_holder.custom_minimum_size = Vector2(0, TOP_BACK_H + 4)
	col.add_child(back_holder)
	var back_row := Control.new()
	back_row.custom_minimum_size = Vector2(TOP_BACK_W, TOP_BACK_H)
	back_holder.add_child(back_row)
	# 出牌区（绿区）
	var play_holder := CenterContainer.new()
	play_holder.custom_minimum_size = Vector2(0, PLAY_CARD_H + 4)
	play_holder.clip_contents = false
	col.add_child(play_holder)
	var play_row := Control.new()
	play_row.custom_minimum_size = Vector2(PLAY_CARD_W * 6, PLAY_CARD_H)
	play_holder.add_child(play_row)
	# 行动文字（"过" 等）
	var act_lbl := _mk_text_label("", 13, Color(1, 0.88, 0.62, 0.95))
	act_lbl.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	col.add_child(act_lbl)
	_seat_nodes[2] = {
		"avatar": avatar,
		"idle_frame": stk["idle_frame"],
		"turn_glow": stk["turn_glow"],
		"rank_badge": stk["rank_badge"],
		"name": name_lbl,
		"meta": meta_lbl,
		"back_row": back_row,
		"back_dir": "h",
		"play_row": play_row,
		"play_dir": "h",
		"act_label": act_lbl,
	}


# ------------------------------------------------------------
# 左侧家（ui_pos=3）：从左到右 = 头像/名字 → 牌背堆（竖向） → 最近一手（竖向）
# ------------------------------------------------------------

func _build_seat_left() -> void:
	var root := Control.new()
	root.name = "SeatLeft"
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.anchor_left = 0.0
	root.anchor_right = 0.0
	root.anchor_top = 0.5
	root.anchor_bottom = 0.5
	root.offset_left = 6
	root.offset_right = 276
	root.offset_top = -190
	root.offset_bottom = 190
	add_child(root)
	var row := HBoxContainer.new()
	row.anchor_right = 1.0
	row.anchor_bottom = 1.0
	row.alignment = BoxContainer.ALIGNMENT_CENTER
	row.add_theme_constant_override("separation", 6)
	root.add_child(row)
	# 头像 + 名字（竖向 col）
	var head_col := VBoxContainer.new()
	head_col.alignment = BoxContainer.ALIGNMENT_CENTER
	head_col.add_theme_constant_override("separation", 4)
	row.add_child(head_col)
	var stk_l: Dictionary = _make_avatar_stack(Vector2(SIDE_AVATAR_SIZE, SIDE_AVATAR_SIZE))
	head_col.add_child(stk_l["stack"] as Control)
	var avatar: TextureRect = stk_l["avatar"] as TextureRect
	var name_lbl := _mk_text_label("", 11, Color(1, 0.96, 0.86, 1))
	name_lbl.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	head_col.add_child(name_lbl)
	var meta_lbl := _mk_seat_meta_richtext()
	head_col.add_child(meta_lbl)
	# 牌背堆（竖向，旋转 90°）
	var back_center := CenterContainer.new()
	back_center.size_flags_vertical = Control.SIZE_EXPAND_FILL
	back_center.custom_minimum_size = Vector2(SIDE_BACK_VISUAL_W + 6, 0)
	row.add_child(back_center)
	var back_col := Control.new()
	back_col.custom_minimum_size = Vector2(SIDE_BACK_VISUAL_W, SIDE_BACK_VISUAL_H)
	back_center.add_child(back_col)
	# 最近出牌（竖向，旋转 90°）
	var play_center := CenterContainer.new()
	play_center.size_flags_vertical = Control.SIZE_EXPAND_FILL
	play_center.custom_minimum_size = Vector2(PLAY_CARD_H + 16, 0)
	play_center.clip_contents = false
	row.add_child(play_center)
	var play_col := Control.new()
	play_col.custom_minimum_size = Vector2(PLAY_CARD_H, PLAY_CARD_W * 5)
	play_col.clip_contents = false
	play_center.add_child(play_col)
	var act_lbl := _mk_text_label("", 12, Color(1, 0.88, 0.62, 0.95))
	act_lbl.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	head_col.add_child(act_lbl)
	_seat_nodes[3] = {
		"avatar": avatar,
		"idle_frame": stk_l["idle_frame"],
		"turn_glow": stk_l["turn_glow"],
		"rank_badge": stk_l["rank_badge"],
		"name": name_lbl,
		"meta": meta_lbl,
		"back_row": back_col,
		"back_dir": "v",
		"play_row": play_col,
		"play_dir": "v",
		"act_label": act_lbl,
	}


# ------------------------------------------------------------
# 右侧家（ui_pos=1）：镜像左侧，从内到外 = 出牌 → 牌背 → 头像
# ------------------------------------------------------------

func _build_seat_right() -> void:
	var root := Control.new()
	root.name = "SeatRight"
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.anchor_left = 1.0
	root.anchor_right = 1.0
	root.anchor_top = 0.5
	root.anchor_bottom = 0.5
	root.offset_left = -276
	root.offset_right = -6
	root.offset_top = -190
	root.offset_bottom = 190
	add_child(root)
	var row := HBoxContainer.new()
	row.anchor_right = 1.0
	row.anchor_bottom = 1.0
	row.alignment = BoxContainer.ALIGNMENT_CENTER
	row.add_theme_constant_override("separation", 6)
	root.add_child(row)
	# 出牌（竖向，旋转 90°）
	var play_center := CenterContainer.new()
	play_center.size_flags_vertical = Control.SIZE_EXPAND_FILL
	play_center.custom_minimum_size = Vector2(PLAY_CARD_H + 16, 0)
	play_center.clip_contents = false
	row.add_child(play_center)
	var play_col := Control.new()
	play_col.custom_minimum_size = Vector2(PLAY_CARD_H, PLAY_CARD_W * 5)
	play_col.clip_contents = false
	play_center.add_child(play_col)
	# 牌背（竖向，旋转 90°）
	var back_center := CenterContainer.new()
	back_center.size_flags_vertical = Control.SIZE_EXPAND_FILL
	back_center.custom_minimum_size = Vector2(SIDE_BACK_VISUAL_W + 6, 0)
	row.add_child(back_center)
	var back_col := Control.new()
	back_col.custom_minimum_size = Vector2(SIDE_BACK_VISUAL_W, SIDE_BACK_VISUAL_H)
	back_center.add_child(back_col)
	# 头像 + 名字
	var head_col := VBoxContainer.new()
	head_col.alignment = BoxContainer.ALIGNMENT_CENTER
	head_col.add_theme_constant_override("separation", 4)
	row.add_child(head_col)
	var stk_r: Dictionary = _make_avatar_stack(Vector2(SIDE_AVATAR_SIZE, SIDE_AVATAR_SIZE))
	head_col.add_child(stk_r["stack"] as Control)
	var avatar: TextureRect = stk_r["avatar"] as TextureRect
	var name_lbl := _mk_text_label("", 11, Color(1, 0.96, 0.86, 1))
	name_lbl.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	head_col.add_child(name_lbl)
	var meta_lbl := _mk_seat_meta_richtext()
	head_col.add_child(meta_lbl)
	var act_lbl := _mk_text_label("", 12, Color(1, 0.88, 0.62, 0.95))
	act_lbl.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	head_col.add_child(act_lbl)
	_seat_nodes[1] = {
		"avatar": avatar,
		"idle_frame": stk_r["idle_frame"],
		"turn_glow": stk_r["turn_glow"],
		"rank_badge": stk_r["rank_badge"],
		"name": name_lbl,
		"meta": meta_lbl,
		"back_row": back_col,
		"back_dir": "v",
		"play_row": play_col,
		"play_dir": "v",
		"act_label": act_lbl,
	}


# ------------------------------------------------------------
# 底部自家（ui_pos=0）：出牌区 → 头像+信息（水平居中）→ 手牌 → 提示 → 按钮
# ------------------------------------------------------------

func _build_seat_bottom() -> void:
	var root := Control.new()
	root.name = "SeatBottom"
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.anchor_left = 0.0
	root.anchor_right = 1.0
	root.anchor_top = 1.0
	root.anchor_bottom = 1.0
	root.offset_left = 16
	root.offset_right = -16
	root.offset_top = -352
	root.offset_bottom = -10
	add_child(root)
	var col := VBoxContainer.new()
	col.anchor_right = 1.0
	col.anchor_bottom = 1.0
	col.alignment = BoxContainer.ALIGNMENT_CENTER
	col.add_theme_constant_override("separation", 5)
	root.add_child(col)
	# 出牌区（最上）
	var play_holder := CenterContainer.new()
	play_holder.custom_minimum_size = Vector2(0, PLAY_CARD_H + 6)
	play_holder.clip_contents = false
	col.add_child(play_holder)
	var play_row := Control.new()
	play_row.custom_minimum_size = Vector2(PLAY_CARD_W * 6, PLAY_CARD_H)
	play_row.clip_contents = false
	play_holder.add_child(play_row)
	# 占位：与其它座统一的 act_label 引用（出牌/过 用语义气泡展示，此处不显示）
	var act_lbl := Label.new()
	act_lbl.visible = false
	# 头像在左、名字与剩张在右（与对家 header 一致），压缩纵向空间
	var head_center := CenterContainer.new()
	head_center.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	col.add_child(head_center)
	var header := HBoxContainer.new()
	header.add_theme_constant_override("separation", 6)
	header.alignment = BoxContainer.ALIGNMENT_CENTER
	head_center.add_child(header)
	var stk_b: Dictionary = _make_avatar_stack(Vector2(AVATAR_SIZE, AVATAR_SIZE))
	header.add_child(stk_b["stack"] as Control)
	var avatar: TextureRect = stk_b["avatar"] as TextureRect
	var info := VBoxContainer.new()
	info.add_theme_constant_override("separation", 2)
	info.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	header.add_child(info)
	var name_lbl := _mk_text_label("", 12, Color(1, 0.96, 0.86, 1))
	name_lbl.horizontal_alignment = HORIZONTAL_ALIGNMENT_LEFT
	info.add_child(name_lbl)
	var meta_lbl := _mk_seat_meta_richtext(HORIZONTAL_ALIGNMENT_LEFT)
	info.add_child(meta_lbl)
	# 手牌区
	var hand_holder := CenterContainer.new()
	hand_holder.custom_minimum_size = Vector2(0, HAND_CARD_H + 18)
	col.add_child(hand_holder)
	_hand_area = Control.new()
	_hand_area.custom_minimum_size = Vector2(HAND_CARD_W, HAND_CARD_H + 18)
	_hand_area.clip_contents = false
	hand_holder.add_child(_hand_area)
	_ensure_hand_gap_catcher()
	# 持久性操作提示（带轻量「气泡」底）
	var hint_panel := PanelContainer.new()
	hint_panel.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	var hsb := StyleBoxFlat.new()
	hsb.bg_color = Color(0.03, 0.07, 0.05, 0.78)
	hsb.border_color = Color(0.72, 0.55, 0.22, 0.65)
	hsb.set_border_width_all(1)
	hsb.corner_radius_top_left = 12
	hsb.corner_radius_top_right = 12
	hsb.corner_radius_bottom_left = 12
	hsb.corner_radius_bottom_right = 12
	hsb.content_margin_left = 14
	hsb.content_margin_top = 10
	hsb.content_margin_right = 14
	hsb.content_margin_bottom = 10
	hsb.shadow_color = Color(0, 0, 0, 0.4)
	hsb.shadow_size = 5
	hsb.shadow_offset = Vector2(0, 2)
	hint_panel.add_theme_stylebox_override("panel", hsb)
	col.add_child(hint_panel)
	_hint_label = _mk_text_label("", 13, Color(1, 0.94, 0.78, 1))
	_hint_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_hint_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	hint_panel.add_child(_hint_label)
	# 按钮区
	var btn_row := HBoxContainer.new()
	btn_row.alignment = BoxContainer.ALIGNMENT_CENTER
	btn_row.add_theme_constant_override("separation", 10)
	col.add_child(btn_row)
	_btn_play = _make_btn(btn_row, "出牌", _on_play_pressed, "primary")
	_btn_pass = _make_btn(btn_row, "过", _on_pass_pressed, "default")
	_btn_hint = _make_btn(btn_row, "智能提示", _on_hint_pressed, "accent")
	_btn_delegate = _make_btn(btn_row, "AI托管", _on_delegate_pressed, "accent")
	_btn_tribute = _make_btn(btn_row, "进贡", _on_tribute_pressed, "default")
	_btn_resist = _make_btn(btn_row, "抗贡", _on_resist_pressed, "default")
	_btn_return = _make_btn(btn_row, "还贡", _on_return_pressed, "default")
	_btn_leave = _make_btn(btn_row, "离开", _on_leave_pressed, "muted")

	_seat_nodes[0] = {
		"avatar": avatar,
		"idle_frame": stk_b["idle_frame"],
		"turn_glow": stk_b["turn_glow"],
		"rank_badge": stk_b["rank_badge"],
		"name": name_lbl,
		"meta": meta_lbl,
		"back_row": null,
		"back_dir": "h",
		"play_row": play_row,
		"play_dir": "h",
		"act_label": act_lbl,
	}


func _ensure_hand_gap_catcher() -> void:
	if _hand_area == null:
		return
	if _hand_gap_catcher != null and is_instance_valid(_hand_gap_catcher) and _hand_gap_catcher.get_parent() == _hand_area:
		return
	_hand_gap_catcher = ColorRect.new()
	_hand_gap_catcher.name = "HandGapCatcher"
	_hand_gap_catcher.color = Color(1, 1, 1, 0)
	_hand_gap_catcher.mouse_filter = Control.MOUSE_FILTER_STOP
	_hand_gap_catcher.set_anchors_preset(Control.PRESET_FULL_RECT)
	_hand_gap_catcher.gui_input.connect(_on_hand_gap_gui_input)
	_hand_area.add_child(_hand_gap_catcher)
	_hand_area.move_child(_hand_gap_catcher, 0)


func _setup_seat_speech_bubbles() -> void:
	_speech_layer = CanvasLayer.new()
	_speech_layer.layer = 22
	add_child(_speech_layer)
	_speech_bubbles.clear()
	for ui_p in range(4):
		var b: Node = SEAT_SPEECH_BUBBLE_SCENE.instantiate()
		_speech_layer.add_child(b)
		_speech_bubbles.append(b)
		if b.has_method("set_tail_anchor"):
			# 气泡在桌心一侧（参考示意绿框）：下/上/右三家针脚从左侧指向头像左缘；左家在头像右侧用 LEFT
			match ui_p:
				0, 1, 2:
					b.call("set_tail_anchor", _SeatSpeechBubbleScr.TailAnchor.RIGHT)
				_:
					b.call("set_tail_anchor", _SeatSpeechBubbleScr.TailAnchor.LEFT)
		var cap: int = ui_p
		if b.has_signal("layout_finished"):
			b.connect("layout_finished", func() -> void: _place_guandan_speech_for_ui(cap))
		if b.has_method("hide_immediately"):
			b.call("hide_immediately")
	call_deferred("_layout_all_guandan_speech")


func _on_viewport_speech_layout() -> void:
	_layout_all_guandan_speech()


func _layout_all_guandan_speech() -> void:
	if _speech_bubbles.is_empty() or _seat_nodes.size() < 4:
		return
	for ui_p in range(4):
		var info: Dictionary = _seat_nodes[ui_p]
		var av: Control = info["avatar"] as Control
		_place_guandan_speech_bubble(_speech_bubbles[ui_p], av, ui_p)


func _place_guandan_speech_for_ui(ui_p: int) -> void:
	if ui_p < 0 or ui_p >= _speech_bubbles.size():
		return
	var info: Dictionary = _seat_nodes[ui_p]
	var av: Control = info["avatar"] as Control
	_place_guandan_speech_bubble(_speech_bubbles[ui_p], av, ui_p)


## 针脚对齐点：在头像朝向气泡的一侧外沿留缝，避免尾巴与头像贴图重叠
func _speech_tail_attach_global(avatar: Control, ui_pos: int) -> Vector2:
	var r: Rect2 = avatar.get_global_rect()
	var c: Vector2 = r.get_center()
	match ui_pos:
		0, 1, 2:
			return Vector2(r.position.x - _SPEECH_TAIL_GAP_PX, c.y)
		_:
			# 左家：整体抬高到「InfoAndLog」下沿以下，针脚贴在头像右侧偏上，LEFT 锚尾巴向左下指头像
			var x: float = r.end.x + _SPEECH_TAIL_GAP_PX
			var below_info: float = 0.0
			var info_n: Node = get_node_or_null("InfoAndLog")
			if info_n is Control:
				below_info = (info_n as Control).get_global_rect().end.y + 12.0
			var y_on_av: float = r.position.y + r.size.y * 0.20
			var y_candidate: float = maxf(below_info, y_on_av)
			var y_lo: float = r.position.y + 4.0
			var y_hi: float = r.position.y + r.size.y * 0.52
			var y: float = clampf(y_candidate, y_lo, y_hi)
			return Vector2(x, y)


func _clamp_speech_bubble_to_viewport(bubble: Control) -> void:
	if bubble == null:
		return
	var vp: Rect2 = bubble.get_viewport().get_visible_rect()
	var margin: float = 8.0
	var sz: Vector2 = bubble.size
	if sz.x < 2.0 or sz.y < 2.0:
		sz = bubble.get_combined_minimum_size()
	var pos: Vector2 = bubble.global_position
	var min_x: float = vp.position.x + margin
	var max_x: float = vp.end.x - sz.x - margin
	var min_y: float = vp.position.y + margin
	var max_y: float = vp.end.y - sz.y - margin
	if max_x < min_x:
		pos.x = vp.position.x + (vp.size.x - sz.x) * 0.5
	else:
		pos.x = clampf(pos.x, min_x, max_x)
	if max_y < min_y:
		pos.y = vp.position.y + (vp.size.y - sz.y) * 0.5
	else:
		pos.y = clampf(pos.y, min_y, max_y)
	bubble.global_position = pos


func _place_guandan_speech_bubble(bubble: Control, avatar: Control, ui_pos: int) -> void:
	if bubble == null or avatar == null:
		return
	if not bubble.has_method("get_tail_tip_local"):
		return
	if bubble.size.x < 8.0 or bubble.size.y < 8.0:
		return
	var attach_g: Vector2 = _speech_tail_attach_global(avatar, ui_pos)
	var tip_l: Vector2 = bubble.call("get_tail_tip_local")
	bubble.global_position = attach_g - tip_l
	_clamp_speech_bubble_to_viewport(bubble)


func _seat_say_logical(seat: int, line: String, duration_sec: float = 2.4) -> void:
	if line.is_empty() or _speech_bubbles.is_empty():
		return
	var ui_p: int = (seat - _self_seat + 4) % 4 if _self_seat >= 0 else seat
	if ui_p < 0 or ui_p >= _speech_bubbles.size():
		return
	var b: Node = _speech_bubbles[ui_p]
	if b != null and b.has_method("say"):
		b.call("say", line, duration_sec)


# ------------------------------------------------------------
# 顶栏：左侧牌局信息 + 右侧出牌记录（淡白色小字）
# ------------------------------------------------------------

func _style_guandan_info_label(lbl: Label) -> void:
	lbl.add_theme_font_size_override("font_size", 13)
	lbl.add_theme_color_override("font_color", Color(1, 0.94, 0.78, 0.95))
	lbl.add_theme_color_override("font_shadow_color", Color(0, 0, 0, 0.6))
	lbl.add_theme_constant_override("shadow_offset_x", 1)
	lbl.add_theme_constant_override("shadow_offset_y", 1)


func _gd_info_score_header(txt: String, txt_col: Color, hdr_bg: Color) -> PanelContainer:
	var pc := PanelContainer.new()
	var sbh := StyleBoxFlat.new()
	sbh.bg_color = hdr_bg
	sbh.corner_radius_top_left = 3
	sbh.corner_radius_top_right = 3
	sbh.corner_radius_bottom_left = 3
	sbh.corner_radius_bottom_right = 3
	pc.add_theme_stylebox_override("panel", sbh)
	var hl := Label.new()
	hl.text = txt
	hl.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	hl.add_theme_font_size_override("font_size", 8)
	hl.add_theme_color_override("font_color", txt_col)
	pc.add_child(hl)
	return pc


func _gd_info_score_value_panel(bg: Color, min_sz: Vector2) -> PanelContainer:
	var pc2 := PanelContainer.new()
	pc2.custom_minimum_size = min_sz
	var sbv := StyleBoxFlat.new()
	sbv.bg_color = bg
	sbv.corner_radius_top_left = 0
	sbv.corner_radius_top_right = 0
	sbv.corner_radius_bottom_left = 0
	sbv.corner_radius_bottom_right = 0
	pc2.add_theme_stylebox_override("panel", sbv)
	return pc2


func _build_info_corner() -> void:
	var root := HBoxContainer.new()
	root.name = "InfoAndLog"
	root.anchor_left = 0.0
	root.anchor_right = 1.0
	root.anchor_top = 0.0
	root.offset_left = 10
	root.offset_top = 6
	root.offset_right = -20
	root.custom_minimum_size = Vector2(0, 188)
	root.add_theme_constant_override("separation", 12)
	add_child(root)
	var left := VBoxContainer.new()
	left.custom_minimum_size = Vector2(300, 0)
	left.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	root.add_child(left)
	var _info_spacer := Control.new()
	_info_spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_info_spacer.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(_info_spacer)
	# 级数：我方 / 对方；数字与框约为原 2/3
	const SCORE_VAL_SZ := Vector2(33, 29)
	var score_row := HBoxContainer.new()
	score_row.add_theme_constant_override("separation", 4)
	score_row.alignment = BoxContainer.ALIGNMENT_BEGIN
	var score_and_level := HBoxContainer.new()
	score_and_level.add_theme_constant_override("separation", 14)
	score_and_level.alignment = BoxContainer.ALIGNMENT_BEGIN
	score_and_level.add_child(score_row)

	var our_col := VBoxContainer.new()
	our_col.add_theme_constant_override("separation", 2)
	our_col.add_child(_gd_info_score_header("我方", Color(0.35, 0.26, 0.06, 1), Color(0.88, 0.78, 0.52, 0.95)))
	var our_val_pc: PanelContainer = _gd_info_score_value_panel(Color(0.72, 0.52, 0.12, 0.96), SCORE_VAL_SZ)
	_lvl_our_value = Label.new()
	_lvl_our_value.text = "2"
	_lvl_our_value.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_lvl_our_value.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	_lvl_our_value.add_theme_font_size_override("font_size", 20)
	_lvl_our_value.add_theme_color_override("font_color", Color.WHITE)
	our_val_pc.add_child(_lvl_our_value)
	our_col.add_child(our_val_pc)
	score_row.add_child(our_col)

	var colon := Label.new()
	colon.text = ":"
	colon.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	colon.add_theme_font_size_override("font_size", 9)
	colon.add_theme_color_override("font_color", Color(1, 1, 1, 0.92))
	score_row.add_child(colon)

	var them_col := VBoxContainer.new()
	them_col.add_theme_constant_override("separation", 2)
	them_col.add_child(_gd_info_score_header("对方", Color(0.08, 0.38, 0.22, 1), Color(0.65, 0.88, 0.72, 0.92)))
	var them_val_pc: PanelContainer = _gd_info_score_value_panel(Color(0.12, 0.52, 0.30, 0.96), SCORE_VAL_SZ)
	_lvl_them_value = Label.new()
	_lvl_them_value.text = "2"
	_lvl_them_value.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_lvl_them_value.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	_lvl_them_value.add_theme_font_size_override("font_size", 20)
	_lvl_them_value.add_theme_color_override("font_color", Color.WHITE)
	them_val_pc.add_child(_lvl_them_value)
	them_col.add_child(them_val_pc)
	score_row.add_child(them_col)

	var level_block := HBoxContainer.new()
	level_block.add_theme_constant_override("separation", 8)
	level_block.alignment = BoxContainer.ALIGNMENT_CENTER
	_level_team_label = Label.new()
	_style_guandan_info_label(_level_team_label)
	_level_team_label.text = ""
	_level_team_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	level_block.add_child(_level_team_label)
	_level_card_rect = TextureRect.new()
	_level_card_rect.custom_minimum_size = Vector2(21, 29)
	_level_card_rect.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	_level_card_rect.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	level_block.add_child(_level_card_rect)
	score_and_level.add_child(level_block)
	left.add_child(score_and_level)
	_info_stage_label = Label.new()
	_style_guandan_info_label(_info_stage_label)
	_info_stage_label.text = "等待服务器派发…"
	_info_stage_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_info_stage_label.size_flags_vertical = Control.SIZE_SHRINK_BEGIN
	left.add_child(_info_stage_label)
	_turn_status_label = Label.new()
	_style_guandan_info_label(_turn_status_label)
	_turn_status_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_turn_status_label.text = ""
	left.add_child(_turn_status_label)
	var right := VBoxContainer.new()
	right.size_flags_horizontal = Control.SIZE_SHRINK_END
	right.custom_minimum_size = Vector2(GUANDAN_PLAY_LOG_PANEL_W, 0)
	root.add_child(right)
	var bgm_bar := HBoxContainer.new()
	bgm_bar.alignment = BoxContainer.ALIGNMENT_END
	bgm_bar.add_theme_constant_override("separation", 8)
	bgm_bar.custom_minimum_size = Vector2(GUANDAN_PLAY_LOG_PANEL_W, 28)
	var bgm_lbl := Label.new()
	bgm_lbl.text = "BGM"
	bgm_lbl.add_theme_font_size_override("font_size", 11)
	bgm_lbl.add_theme_color_override("font_color", Color(0.88, 0.94, 0.82, 0.92))
	bgm_bar.add_child(bgm_lbl)
	_bgm_slider = HSlider.new()
	_bgm_slider.custom_minimum_size = Vector2(86, 18)
	_bgm_slider.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_bgm_slider.min_value = 0.0
	_bgm_slider.max_value = 1.0
	_bgm_slider.step = 0.02
	_bgm_slider.value = _bgm_linear
	_bgm_slider.value_changed.connect(_on_bgm_slider_changed)
	bgm_bar.add_child(_bgm_slider)
	_btn_bgm_mute = Button.new()
	_btn_bgm_mute.text = "静音"
	_btn_bgm_mute.custom_minimum_size = Vector2(52, 26)
	_btn_bgm_mute.add_theme_font_size_override("font_size", 11)
	_btn_bgm_mute.pressed.connect(_on_bgm_mute_pressed)
	bgm_bar.add_child(_btn_bgm_mute)
	right.add_child(bgm_bar)
	var sc := ScrollContainer.new()
	sc.custom_minimum_size = Vector2(GUANDAN_PLAY_LOG_PANEL_W, 120)
	sc.size_flags_vertical = Control.SIZE_EXPAND_FILL
	sc.size_flags_horizontal = Control.SIZE_SHRINK_END
	sc.mouse_filter = Control.MOUSE_FILTER_STOP
	var pm := StyleBoxFlat.new()
	pm.bg_color = Color(0.02, 0.04, 0.03, 0.45)
	pm.border_color = Color(0.6, 0.55, 0.35, 0.4)
	pm.set_border_width_all(1)
	pm.corner_radius_top_left = 6
	pm.corner_radius_top_right = 6
	pm.corner_radius_bottom_left = 6
	pm.corner_radius_bottom_right = 6
	pm.content_margin_left = 6
	pm.content_margin_top = 4
	pm.content_margin_right = 4
	pm.content_margin_bottom = 4
	sc.add_theme_stylebox_override("panel", pm)
	right.add_child(sc)
	_play_log = RichTextLabel.new()
	_play_log.bbcode_enabled = true
	_play_log.fit_content = true
	_play_log.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_play_log.scroll_active = false
	_play_log.custom_minimum_size = Vector2(GUANDAN_PLAY_LOG_PANEL_W - 16, 8)
	_play_log.size_flags_horizontal = Control.SIZE_SHRINK_END
	_play_log.add_theme_font_size_override("normal_font_size", 11)
	_play_log.add_theme_color_override("default_color", Color(0.9, 0.95, 0.88, 0.95))
	sc.add_child(_play_log)


func _append_play_log_line(plain_line: String) -> void:
	if _play_log == null:
		return
	if _play_log.get_parsed_text().length() > 5000:
		_play_log.clear()
	_play_log.append_text(plain_line + "\n")
	call_deferred("_scroll_play_log_end")


func _scroll_play_log_end() -> void:
	if _play_log == null:
		return
	var p: Node = _play_log.get_parent()
	if p is ScrollContainer:
		var sc: ScrollContainer = p as ScrollContainer
		sc.queue_sort()
		_play_log.queue_redraw()
		call_deferred("_scroll_play_log_end_after_layout")


func _scroll_play_log_end_after_layout() -> void:
	if _play_log == null:
		return
	var p: Node = _play_log.get_parent()
	if not (p is ScrollContainer):
		return
	var sc: ScrollContainer = p as ScrollContainer
	var bar: VScrollBar = sc.get_v_scroll_bar()
	if bar != null:
		sc.scroll_vertical = int(bar.max_value)
	if sc.has_method("ensure_control_visible"):
		sc.call("ensure_control_visible", _play_log)


func _build_msg_label() -> void:
	_msg_label = Label.new()
	_msg_label.anchor_left = 0.5
	_msg_label.anchor_right = 0.5
	_msg_label.anchor_top = 1.0
	_msg_label.anchor_bottom = 1.0
	_msg_label.offset_left = -240
	_msg_label.offset_right = 240
	_msg_label.offset_top = -340
	_msg_label.offset_bottom = -316
	_msg_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_msg_label.add_theme_font_size_override("font_size", 14)
	_msg_label.add_theme_color_override("font_color", Color(1, 0.78, 0.7, 1))
	_msg_label.add_theme_color_override("font_shadow_color", Color(0, 0, 0, 0.6))
	_msg_label.add_theme_constant_override("shadow_offset_x", 1)
	_msg_label.add_theme_constant_override("shadow_offset_y", 1)
	_msg_label.text = ""
	add_child(_msg_label)


func _make_settle_scroll_box() -> ScrollContainer:
	var scc := ScrollContainer.new()
	scc.custom_minimum_size = Vector2(340, 210)
	scc.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scc.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scc.mouse_filter = Control.MOUSE_FILTER_STOP
	var sc_pm2 := StyleBoxFlat.new()
	sc_pm2.bg_color = Color(0.03, 0.06, 0.05, 0.45)
	sc_pm2.set_border_width_all(1)
	sc_pm2.border_color = Color(0.5, 0.55, 0.4, 0.35)
	sc_pm2.corner_radius_top_left = 10
	sc_pm2.corner_radius_top_right = 10
	sc_pm2.corner_radius_bottom_left = 10
	sc_pm2.corner_radius_bottom_right = 10
	sc_pm2.content_margin_left = 12
	sc_pm2.content_margin_top = 10
	sc_pm2.content_margin_right = 12
	sc_pm2.content_margin_bottom = 10
	scc.add_theme_stylebox_override("panel", sc_pm2)
	return scc


# 结算属于事件性弹窗，允许有底色以便信息聚焦
func _build_settle_overlay() -> void:
	_settle_overlay = Control.new()
	_settle_overlay.anchor_right = 1.0
	_settle_overlay.anchor_bottom = 1.0
	_settle_overlay.visible = false
	_settle_overlay.mouse_filter = Control.MOUSE_FILTER_STOP
	_settle_overlay.z_index = 500
	add_child(_settle_overlay)
	var dim := ColorRect.new()
	dim.anchor_right = 1.0
	dim.anchor_bottom = 1.0
	dim.color = Color(0.02, 0.05, 0.04, 0.62)
	_settle_dim = dim
	_settle_overlay.add_child(dim)
	var panel := PanelContainer.new()
	panel.anchor_left = 0.5
	panel.anchor_right = 0.5
	panel.anchor_top = 0.5
	panel.anchor_bottom = 0.5
	panel.offset_left = -400
	panel.offset_right = 400
	panel.offset_top = -250
	panel.offset_bottom = 250
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.06, 0.1, 0.08, 0.96)
	sb.border_color = Color(0.85, 0.68, 0.28, 0.75)
	sb.set_border_width_all(2)
	sb.corner_radius_top_left = 18
	sb.corner_radius_top_right = 18
	sb.corner_radius_bottom_left = 18
	sb.corner_radius_bottom_right = 18
	sb.content_margin_left = 22
	sb.content_margin_right = 22
	sb.content_margin_top = 18
	sb.content_margin_bottom = 18
	panel.add_theme_stylebox_override("panel", sb)
	_settle_panel = panel
	_settle_overlay.add_child(panel)
	var col := VBoxContainer.new()
	col.add_theme_constant_override("separation", 14)
	panel.add_child(col)
	var title := Label.new()
	title.text = "本局结算"
	title.add_theme_font_size_override("font_size", 26)
	title.add_theme_color_override("font_color", Color(1, 0.88, 0.45, 1))
	title.add_theme_color_override("font_shadow_color", Color(0, 0, 0, 0.55))
	title.add_theme_constant_override("shadow_offset_x", 1)
	title.add_theme_constant_override("shadow_offset_y", 2)
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	col.add_child(title)
	var sub := Label.new()
	sub.text = "左侧：名次与级牌　·　右侧：积分变动"
	sub.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	sub.add_theme_font_size_override("font_size", 12)
	sub.add_theme_color_override("font_color", Color(0.75, 0.88, 0.78, 0.88))
	col.add_child(sub)
	var settle_row := HBoxContainer.new()
	settle_row.add_theme_constant_override("separation", 16)
	settle_row.size_flags_vertical = Control.SIZE_EXPAND_FILL
	col.add_child(settle_row)

	var sc_l: ScrollContainer = _make_settle_scroll_box()
	settle_row.add_child(sc_l)
	_settle_label_left = Label.new()
	_settle_label_left.text = ""
	_settle_label_left.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_settle_label_left.add_theme_font_size_override("font_size", 15)
	_settle_label_left.add_theme_color_override("font_color", Color(0.93, 0.98, 0.9, 1))
	_settle_label_left.custom_minimum_size = Vector2(310, 8)
	sc_l.add_child(_settle_label_left)

	var sc_r: ScrollContainer = _make_settle_scroll_box()
	settle_row.add_child(sc_r)
	_settle_label_right = Label.new()
	_settle_label_right.text = ""
	_settle_label_right.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_settle_label_right.add_theme_font_size_override("font_size", 15)
	_settle_label_right.add_theme_color_override("font_color", Color(0.93, 0.98, 0.9, 1))
	_settle_label_right.custom_minimum_size = Vector2(310, 8)
	sc_r.add_child(_settle_label_right)

	_settle_wait_hint = Label.new()
	_settle_wait_hint.text = ""
	_settle_wait_hint.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_settle_wait_hint.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_settle_wait_hint.add_theme_font_size_override("font_size", 12)
	_settle_wait_hint.add_theme_color_override("font_color", Color(1.0, 0.82, 0.55, 0.95))
	col.add_child(_settle_wait_hint)
	var hint := Label.new()
	hint.text = "「下一局」继续对局 · 「回到大厅」离开"
	hint.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	hint.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	hint.add_theme_font_size_override("font_size", 12)
	hint.add_theme_color_override("font_color", Color(0.78, 0.86, 0.8, 0.9))
	col.add_child(hint)
	var settle_btn_row := HBoxContainer.new()
	settle_btn_row.alignment = BoxContainer.ALIGNMENT_CENTER
	settle_btn_row.add_theme_constant_override("separation", 16)
	col.add_child(settle_btn_row)
	_btn_continue = _make_btn(settle_btn_row, "下一局", _on_continue_pressed)
	_btn_settle_lobby = _make_btn(settle_btn_row, "回到大厅", _on_settle_lobby_pressed, "muted")


func _build_rubber_band() -> void:
	_rubber_band = ColorRect.new()
	_rubber_band.name = "RubberBand"
	_rubber_band.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_rubber_band.color = Color(0.28, 0.62, 1.0, 0.2)
	_rubber_band.visible = false
	_rubber_band.z_index = 350
	add_child(_rubber_band)


func _setup_guandan_bgm_and_settle_sfx() -> void:
	_bgm_linear_before_mute = _bgm_linear
	_bgm_player = AudioStreamPlayer.new()
	_bgm_player.name = "BgmGuandan"
	var bm: Resource = load(BGM_GUANDAN_PATH)
	if bm != null and bm is AudioStreamMP3:
		(bm as AudioStreamMP3).loop = true
		_bgm_player.stream = bm as AudioStream
	_apply_bgm_volume()
	add_child(_bgm_player)
	if _bgm_player.stream != null:
		_bgm_player.play()
	_settle_sfx = AudioStreamPlayer.new()
	_settle_sfx.name = "SettleSfx"
	var st: Resource = load(SFX_SETTLE_PATH)
	if st != null:
		_settle_sfx.stream = st as AudioStream
	add_child(_settle_sfx)


func _apply_bgm_volume() -> void:
	if _bgm_player == null:
		return
	var v: float = clampf(_bgm_linear, 0.0, 1.0)
	if v < 0.001:
		_bgm_player.volume_db = -80.0
	else:
		_bgm_player.volume_db = linear_to_db(v)


func _on_bgm_slider_changed(v: float) -> void:
	_bgm_linear = clampf(v, 0.0, 1.0)
	if _bgm_linear > 0.01:
		_bgm_linear_before_mute = _bgm_linear
	_apply_bgm_volume()
	if _btn_bgm_mute != null and _bgm_linear > 0.01:
		_btn_bgm_mute.text = "静音"


func _on_bgm_mute_pressed() -> void:
	if _bgm_player == null:
		return
	if _bgm_player.volume_db > -79.0:
		_bgm_linear_before_mute = maxf(_bgm_linear, 0.02)
		_bgm_linear = 0.0
		if _bgm_slider != null and _bgm_slider.value_changed.is_connected(_on_bgm_slider_changed):
			_bgm_slider.value_changed.disconnect(_on_bgm_slider_changed)
			_bgm_slider.value = 0.0
			_bgm_slider.value_changed.connect(_on_bgm_slider_changed)
		_apply_bgm_volume()
		if _btn_bgm_mute != null:
			_btn_bgm_mute.text = "开声"
	else:
		_bgm_linear = clampf(_bgm_linear_before_mute, 0.02, 1.0)
		if _bgm_slider != null and _bgm_slider.value_changed.is_connected(_on_bgm_slider_changed):
			_bgm_slider.value_changed.disconnect(_on_bgm_slider_changed)
			_bgm_slider.value = _bgm_linear
			_bgm_slider.value_changed.connect(_on_bgm_slider_changed)
		_apply_bgm_volume()
		if _btn_bgm_mute != null:
			_btn_bgm_mute.text = "静音"


# ------------------------------------------------------------
# 工具：构建小元件
# ------------------------------------------------------------

func _mk_text_label(text: String, font_size: int, color: Color) -> Label:
	var l := Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", font_size)
	l.add_theme_color_override("font_color", color)
	l.add_theme_color_override("font_shadow_color", Color(0, 0, 0, 0.65))
	l.add_theme_constant_override("shadow_offset_x", 1)
	l.add_theme_constant_override("shadow_offset_y", 1)
	return l


func _mk_seat_meta_richtext(align: HorizontalAlignment = HORIZONTAL_ALIGNMENT_CENTER) -> RichTextLabel:
	var r := RichTextLabel.new()
	r.bbcode_enabled = true
	r.fit_content = true
	r.scroll_active = false
	r.autowrap_mode = TextServer.AUTOWRAP_OFF
	r.horizontal_alignment = align
	r.add_theme_color_override("default_color", Color(1.0, 0.96, 0.68, 1.0))
	return r


## 立体金色按钮：亮顶 + 投影模拟凸起，按下时阴影收短、底色略压暗
func _gold_3d_stylebox(base: Color, state: String) -> StyleBoxFlat:
	var s := StyleBoxFlat.new()
	var fill := base
	var cr := 9
	var edge := Color(0.22, 0.14, 0.05, 1)
	match state:
		"hover":
			fill = base.lightened(0.07)
			edge = edge.lightened(0.08)
		"pressed":
			fill = base.darkened(0.14)
			edge = edge.darkened(0.06)
		"disabled":
			fill = Color(0.22, 0.2, 0.18, 0.72)
			edge = Color(0.35, 0.32, 0.3, 0.55)
		_:
			pass
	s.bg_color = fill
	s.border_color = edge
	s.border_width_top = 2
	s.border_width_left = 2
	s.border_width_right = 2
	s.border_width_bottom = 3
	s.corner_radius_top_left = cr
	s.corner_radius_top_right = cr
	s.corner_radius_bottom_left = cr
	s.corner_radius_bottom_right = cr
	s.content_margin_left = 14
	s.content_margin_right = 14
	s.content_margin_top = 9
	s.content_margin_bottom = 9
	if state == "pressed":
		s.shadow_size = 2
		s.shadow_offset = Vector2(0, 1)
		s.shadow_color = Color(0, 0, 0, 0.38)
	elif state == "disabled":
		s.shadow_size = 0
		s.shadow_offset = Vector2.ZERO
	else:
		s.shadow_size = 6
		s.shadow_offset = Vector2(0, 3)
		s.shadow_color = Color(0, 0, 0, 0.48)
	return s


func _gold_base_for_style(style: String) -> Color:
	match style:
		"primary":
			return Color(0.92, 0.72, 0.28, 1)
		"accent":
			return Color(0.86, 0.66, 0.26, 1)
		"muted":
			return Color(0.58, 0.44, 0.2, 1)
		_:
			return Color(0.82, 0.62, 0.24, 1)


func _style_action_button(b: Button, style: String) -> void:
	var g0: Color = _gold_base_for_style(style)
	b.add_theme_stylebox_override("normal", _gold_3d_stylebox(g0, "normal"))
	b.add_theme_stylebox_override("hover", _gold_3d_stylebox(g0, "hover"))
	b.add_theme_stylebox_override("pressed", _gold_3d_stylebox(g0, "pressed"))
	b.add_theme_stylebox_override("disabled", _gold_3d_stylebox(g0, "disabled"))
	b.add_theme_color_override("font_color", Color(0.12, 0.08, 0.04, 1))
	b.add_theme_color_override("font_pressed_color", Color(0.08, 0.05, 0.02, 1))
	b.add_theme_color_override("font_hover_color", Color(0.1, 0.06, 0.03, 1))
	b.add_theme_color_override("font_disabled_color", Color(0.45, 0.42, 0.4, 0.85))
	b.add_theme_color_override("font_shadow_color", Color(1.0, 0.92, 0.7, 0.35))
	b.add_theme_constant_override("shadow_offset_x", 0)
	b.add_theme_constant_override("shadow_offset_y", 1)
	b.add_theme_font_size_override("font_size", 15)


func _init_guandan_sfx() -> void:
	_sfx_card_stream = load(SFX_PLAY_PATH) as AudioStream
	if _sfx_card_stream != null and _sfx_card_stream is AudioStreamMP3:
		(_sfx_card_stream as AudioStreamMP3).loop = false
	_sfx_bomb_stream = load(SFX_BOMB_PATH) as AudioStream
	if _sfx_bomb_stream != null and _sfx_bomb_stream is AudioStreamMP3:
		(_sfx_bomb_stream as AudioStreamMP3).loop = false
	_sfx_rocket_stream = load(SFX_ROCKET_PATH) as AudioStream
	if _sfx_rocket_stream != null and _sfx_rocket_stream is AudioStreamMP3:
		(_sfx_rocket_stream as AudioStreamMP3).loop = false


func _sfx_gd_one(stream: AudioStream) -> void:
	if _sfx == null or stream == null:
		return
	_sfx.stream = stream
	_sfx.play()


func _sfx_gd_bomb_or_rocket(rocket: bool) -> void:
	if rocket:
		if _sfx_rocket_stream != null:
			_sfx_gd_one(_sfx_rocket_stream)
		return
	if _sfx_bomb_pl != null and _sfx_bomb_stream != null:
		_sfx_bomb_pl.stream = _sfx_bomb_stream
		_sfx_bomb_pl.play()


## 掼蛋出牌音效：与斗地主一致，普通落牌 + 炸弹/天炸额外一层
func _sfx_gd_on_play_effects(last_d: Dictionary) -> void:
	if _sfx_card_stream != null:
		_sfx_gd_one(_sfx_card_stream)
	var k: int = 0
	var k_v: Variant = last_d.get("kind", 0)
	if str(k_v).is_valid_int():
		k = int(k_v)
	var bt: int = int(last_d.get("bomb_tier", 0))
	# 与 play_line_builder GdPlayLine 常量一致
	if k == 11: # K_KING_BOMB
		_sfx_gd_bomb_or_rocket(true)
		return
	if k == 9 or k == 10 or bt > 0: # 同花顺、炸弹链
		_sfx_gd_bomb_or_rocket(false)
		return


func _cat_name_for_seat(seat: int, snap: Dictionary) -> String:
	if seat < 0 or seat > 3:
		return "?"
	var sc: Variant = snap.get("seat_cats", [])
	if sc is Array and seat < (sc as Array).size():
		var idx: int = int((sc as Array)[seat]) % GUANDAN_CAT_NAMES.size()
		if idx < 0:
			idx = 0
		return GUANDAN_CAT_NAMES[idx]
	return GUANDAN_CAT_NAMES[seat % 4]


func _append_tribute_event_to_play_log_if_any(te: Dictionary, snap: Dictionary) -> void:
	var from_s: int = int(te.get("from", -1))
	var to_s: int = int(te.get("to", -1))
	var card: int = int(te.get("card", -1))
	if from_s < 0:
		return
	var kind: String = str(te.get("kind", ""))
	var a: String = _cat_name_for_seat(from_s, snap)
	var b: String = _cat_name_for_seat(to_s, snap) if to_s >= 0 else "?"
	var lab: String = GuandanDefs.label_of(card) if card >= 0 else "?"
	if kind == "give":
		_append_play_log_line("%s 进贡 → %s：%s" % [a, b, lab])
		_seat_say_logical(from_s, "进贡 %s 给 %s" % [lab, b], 2.6)
	elif kind == "return":
		_append_play_log_line("%s 还贡 → %s：%s" % [a, b, lab])
		_seat_say_logical(from_s, "还贡 %s 给 %s" % [lab, b], 2.6)


func _append_resist_to_play_log_if_applicable(
	prev_ph: String, snap: Dictionary, te: Variant
) -> void:
	if prev_ph != "tribute_wait" or str(snap.get("phase", "")) != "play":
		return
	# 正常贡还结束也会 tribute_wait/return_wait → play，但会带最后一手还贡的 tribute_event
	if te is Dictionary and (te as Dictionary).get("kind", "") == "return":
		return
	var t: int = int(snap.get("turn", -1))
	if t < 0:
		return
	var leader: String = _cat_name_for_seat(t, snap)
	_append_play_log_line("抗贡成功，由 %s 先出牌" % leader)
	_seat_say_logical(t, "抗贡成功，我先出！", 2.8)


func _make_btn(parent: HBoxContainer, text: String, cb: Callable, style: String = "default") -> Button:
	var b := Button.new()
	b.text = text
	b.custom_minimum_size = Vector2(102, 44)
	_style_action_button(b, style)
	b.pressed.connect(cb)
	parent.add_child(b)
	return b


# ============================================================
# signal 处理
# ============================================================

func _on_match_gd_server(op_code: int, data: Dictionary) -> void:
	var op_snap: int = int(_hub.GD_OP_SNAPSHOT)
	var op_err: int = int(_hub.GD_OP_ERROR)
	var op_hint: int = int(_hub.GD_OP_HINT)
	var op_settle: int = int(_hub.GD_OP_SETTLEMENT)
	if op_code == op_snap:
		_apply_snapshot(data)
	elif op_code == op_err:
		var err: String = str(data.get("error", "错误"))
		_show_msg("服务端：%s" % err)
	elif op_code == op_hint:
		_apply_hint_response(data)
	elif op_code == op_settle:
		_apply_settlement(data)


func _apply_hint_response(d: Dictionary) -> void:
	if bool(d.get("pass", false)):
		_show_msg("提示：建议「过」")
		_selected_ids.clear()
		_render_hand()
		_update_controls()
		return
	var ids_v: Variant = d.get("ids", [])
	if typeof(ids_v) != TYPE_ARRAY or (ids_v as Array).is_empty():
		_show_msg("提示：暂无推荐，请手选或点「过」。")
		return
	_selected_ids.clear()
	for x in (ids_v as Array):
		_selected_ids[int(x)] = true
	_render_hand()
	_update_controls()


func _on_match_rt_disconnected() -> void:
	_set_info("对局连接已断开，请返回大厅。")


func _on_hand_gap_gui_input(ev: InputEvent) -> void:
	if ev is InputEventMouseButton and ev.button_index == MOUSE_BUTTON_LEFT and ev.pressed:
		_hand_press_down = true
		_hand_press_start = ev.global_position
		_hand_press_id = -1
		_rubber_ever = false
		set_process(true)


func _on_hand_card_gui_input(ev: InputEvent, id: int) -> void:
	if ev is InputEventMouseButton and ev.pressed:
		if ev.button_index == MOUSE_BUTTON_RIGHT:
			var ph: String = str(_snapshot.get("phase", ""))
			var tn: int = int(_snapshot.get("turn", -1))
			if ph == "play" and tn == _self_seat:
				_on_play_pressed()
			return
		if ev.button_index == MOUSE_BUTTON_LEFT:
			_hand_press_down = true
			_hand_press_start = ev.global_position
			_hand_press_id = id
			_rubber_ever = false
			set_process(true)


func _can_select_card_id(id: int) -> bool:
	var phase: String = str(_snapshot.get("phase", ""))
	var lvl: int = int(_snapshot.get("level_active", 12))
	if phase == "tribute_wait":
		var trib2: Variant = _snapshot.get("tribute", null)
		var pending_payer: int = -1
		if trib2 is Dictionary:
			pending_payer = int((trib2 as Dictionary).get("pending_payer", -1))
		if pending_payer == _self_seat and GuandanDefs.is_heart_level_card(int(id), lvl):
			return false
	if phase == "return_wait":
		var trib: Variant = _snapshot.get("tribute", null)
		var pending_receiver: int = -1
		if trib is Dictionary:
			pending_receiver = int((trib as Dictionary).get("pending_receiver", -1))
		if pending_receiver == _self_seat and not GuandanCardDefs.is_valid_return_card(int(id), lvl):
			return false
	return true


func _toggle_select_id(id: int) -> void:
	if _selected_ids.has(id):
		_selected_ids.erase(id)
	else:
		if not _can_select_card_id(id):
			return
		_selected_ids[id] = true
	_render_hand()
	_update_controls()


func _rect_select_union(end_global: Vector2) -> void:
	var r: Rect2 = Rect2(_hand_press_start, Vector2.ZERO).expand(end_global)
	for i in range(_hand_area.get_child_count()):
		var c: Node = _hand_area.get_child(i)
		if c == _hand_gap_catcher:
			continue
		if c is Control and c.has_meta("card_id"):
			var cr: Control = c as Control
			if r.intersects(cr.get_global_rect()):
				var cid: int = int(c.get_meta("card_id"))
				if _selected_ids.has(cid):
					_selected_ids.erase(cid)
				else:
					if _can_select_card_id(cid):
						_selected_ids[cid] = true
	_render_hand()
	_update_controls()


# ============================================================
# 快照 → UI
# ============================================================

func _apply_snapshot(d: Dictionary) -> void:
	_hide_loading_label()
	var prev_phase: String = str(_snapshot.get("phase", "")) if not _snapshot.is_empty() else ""
	var new_ph: String = str(d.get("phase", ""))
	if prev_phase == "finished" and new_ph == "deal" and _play_log != null:
		_play_log.clear()
	var animate_new_plays: bool = not _snapshot.is_empty()
	var new_seq: int = int(d.get("seq", -1))
	_track_last_action_transition(d, new_seq)
	var te_early: Variant = d.get("tribute_event", null)
	if te_early is Dictionary and int((te_early as Dictionary).get("from", -1)) >= 0:
		_append_tribute_event_to_play_log_if_any(te_early as Dictionary, d)
	_append_resist_to_play_log_if_applicable(prev_phase, d, te_early)
	var new_phase0: String = str(d.get("phase", ""))
	if prev_phase == "deal" and new_phase0 != "deal":
		_deal_fx_seq = -1
	if new_phase0 != prev_phase and (new_phase0 == "deal" or new_phase0 == "tribute_wait" or new_phase0 == "return_wait"):
		_play_anim_done_key.clear()
	_snapshot = d.duplicate(true)
	_last_seen_seq = new_seq
	_self_seat = int(d.get("self_seat", -1))
	var self_hand_raw: Variant = d.get("self_hand", [])
	_self_hand.clear()
	if self_hand_raw is Array:
		for v in (self_hand_raw as Array):
			_self_hand.append(int(v))
	var level: int = int(d.get("level_active", 12))
	_self_hand = _to_int_array(GuandanDefs.sort_hand(_self_hand, level))
	_cleanup_selection()
	var te: Variant = d.get("tribute_event", null)
	_render_all(animate_new_plays)
	if te is Dictionary and int(te.get("from", -1)) >= 0:
		_play_tribute_fly(te as Dictionary)
	var phase: String = str(d.get("phase", ""))
	if phase != "finished":
		_settle_overlay.visible = false
		if _settle_label_left != null:
			_settle_label_left.text = ""
		if _settle_label_right != null:
			_settle_label_right.text = ""
	else:
		_settle_overlay.visible = true
		if _settle_label_left != null and _settle_label_left.text.is_empty():
			_settle_label_left.text = "本局已结束。\n点「下一局」继续对局。"
		# phase=finished 时勿清空右栏；积分变动由 SETTLEMENT 包写入，快照会多次到达
		_update_settle_wait_hint()
	# 在更新结算层可见性之后，再同步「继续」等按钮
	_update_controls()


func _track_last_action_transition(new_snap: Dictionary, new_seq: int) -> void:
	var old_turn: int = int(_snapshot.get("turn", -1)) if not _snapshot.is_empty() else -1
	var new_last: Variant = new_snap.get("last", null)
	if new_last is Dictionary:
		var player: int = int((new_last as Dictionary).get("player", -1))
		var ids_v: Variant = (new_last as Dictionary).get("ids", [])
		var ids: Array = []
		if ids_v is Array:
			for v in (ids_v as Array):
				ids.append(int(v))
		var prev_last: Variant = _snapshot.get("last", null) if not _snapshot.is_empty() else null
		var changed: bool = true
		if prev_last is Dictionary:
			var p2: int = int((prev_last as Dictionary).get("player", -1))
			var ids_prev: Variant = (prev_last as Dictionary).get("ids", [])
			if p2 == player and ids_prev is Array and (ids_prev as Array).size() == ids.size():
				changed = false
		if player >= 0 and changed:
			_seat_last_action[player] = {"kind": "play", "ids": ids, "seq": new_seq}
			var lvl0: int = int(new_snap.get("level_active", 12))
			var log_body: String = GdPlayLine.play_log_descriptive_text(new_last as Dictionary, ids, lvl0)
			_seat_say_logical(player, log_body)
			_append_play_log_line("%s  %s" % [_cat_name_for_seat(player, new_snap), log_body])
			_sfx_gd_on_play_effects(new_last as Dictionary)
	else:
		_seat_last_action.clear()
	var new_turn: int = int(new_snap.get("turn", -1))
	if old_turn >= 0 and new_turn >= 0 and old_turn != new_turn:
		var last_player: int = -1
		if new_last is Dictionary:
			last_player = int((new_last as Dictionary).get("player", -1))
		if old_turn != last_player:
			_seat_last_action[old_turn] = {"kind": "pass", "ids": [], "seq": new_seq}
			_seat_say_logical(old_turn, GdPlayLine.speech_pass())
			_append_play_log_line("%s  过" % _cat_name_for_seat(old_turn, new_snap))
			_sfx_gd_one(SFX_PASS)


func _roster_has_any_human() -> bool:
	var r: Variant = _snapshot.get("roster", [])
	if r is Array:
		for e in (r as Array):
			if e is Dictionary and not bool((e as Dictionary).get("is_ai", true)):
				return true
	return false


func _update_settle_wait_hint() -> void:
	if _settle_wait_hint == null:
		return
	if _roster_has_any_human():
		_settle_wait_hint.text = "本桌有真人玩家时，需等待所有人确认「下一局」后才会继续发牌。"
	else:
		_settle_wait_hint.text = ""


func _play_settle_sfx_once() -> void:
	if _settle_sfx == null or _settle_sfx.stream == null:
		return
	_settle_sfx.play()


func _play_settle_overlay_entrance() -> void:
	if _settle_panel == null:
		return
	_settle_panel.scale = Vector2(0.86, 0.86)
	_settle_panel.modulate = Color(1, 1, 1, 0)
	if _settle_dim != null:
		_settle_dim.color = Color(0.02, 0.05, 0.04, 0.0)
	call_deferred("_tween_settle_overlay_in")


func _tween_settle_overlay_in() -> void:
	if _settle_panel == null or not is_instance_valid(_settle_panel):
		return
	_settle_panel.pivot_offset = _settle_panel.size * 0.5
	var tw: Tween = create_tween()
	tw.set_parallel(true)
	tw.tween_property(_settle_panel, "modulate", Color.WHITE, 0.34).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	tw.tween_property(_settle_panel, "scale", Vector2(1.04, 1.04), 0.38).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	if _settle_dim != null:
		tw.tween_property(_settle_dim, "color", Color(0.02, 0.05, 0.04, 0.62), 0.3)
	tw.tween_callback(_tween_settle_panel_pop_finish)


func _tween_settle_panel_pop_finish() -> void:
	if _settle_panel == null or not is_instance_valid(_settle_panel):
		return
	var t2: Tween = create_tween()
	t2.tween_property(_settle_panel, "scale", Vector2.ONE, 0.15).set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_OUT)


func _apply_settlement(d: Dictionary) -> void:
	var snap_for_name: Dictionary = _snapshot if not _snapshot.is_empty() else {}
	var lv: Array = d.get("levels", [])
	var delta: Array = d.get("score_delta", [])
	var order: Array = d.get("finished_order", [])
	var win_team: int = int(d.get("winner_team", -1))
	var left_lines: PackedStringArray = PackedStringArray()
	var right_lines: PackedStringArray = PackedStringArray()
	var rank_names: Array[String] = ["头游", "二游", "三游", "末游"]
	left_lines.append("── 名次 ──")
	for i in range(order.size()):
		var seat: int = int(order[i])
		var title: String = _player_line_title(seat, snap_for_name)
		left_lines.append("%s  %s" % [rank_names[clamp(i, 0, 3)], title])
	var my_t: int = _self_seat % 2 if _self_seat >= 0 else 0
	var lv_our: String = _rr_label(int(lv[my_t])) if lv.size() > my_t else "-"
	var lv_oth: String = _rr_label(int(lv[1 - my_t])) if lv.size() > (1 - my_t) else "-"
	left_lines.append("")
	left_lines.append("── 赛后级牌 ──")
	left_lines.append("我方：%s    对方：%s" % [lv_our, lv_oth])
	if win_team >= 0:
		var win_name: String = "我方" if win_team == my_t else "对方"
		left_lines.append("")
		left_lines.append("━━━━━━━━━━━━━━━━")
		left_lines.append("★ 整场胜利：%s ★" % win_name)

	if delta.size() >= 4:
		right_lines.append("── 积分变动 ──")
		for si in range(4):
			var tsi: String = _player_line_title(si, snap_for_name)
			right_lines.append("%s　%+d" % [tsi, int(delta[si])])
	elif delta.size() >= 2:
		right_lines.append("── 积分变动（按队）──")
		var d_our: int = int(delta[my_t])
		var d_oth: int = int(delta[1 - my_t])
		right_lines.append("我方 %+d    对方 %+d" % [d_our, d_oth])
	else:
		right_lines.append("（本盘无积分变动）")

	if _settle_label_left != null:
		_settle_label_left.text = "\n".join(left_lines)
	if _settle_label_right != null:
		_settle_label_right.text = "\n".join(right_lines)
	_update_settle_wait_hint()
	_play_settle_sfx_once()
	_settle_overlay.visible = true
	_play_settle_overlay_entrance()
	_update_controls()


func _to_int_array(arr: Array) -> Array[int]:
	var out: Array[int] = []
	for v in arr:
		out.append(int(v))
	return out


func _cleanup_selection() -> void:
	var in_hand: Dictionary = {}
	for id in _self_hand:
		in_hand[id] = true
	var to_drop: Array[int] = []
	for key in _selected_ids.keys():
		if not in_hand.has(int(key)):
			to_drop.append(int(key))
	for id in to_drop:
		_selected_ids.erase(id)
	var phase: String = str(_snapshot.get("phase", ""))
	if phase == "return_wait":
		var trib2: Variant = _snapshot.get("tribute", null)
		var pr2: int = -1
		if trib2 is Dictionary:
			pr2 = int((trib2 as Dictionary).get("pending_receiver", -1))
		if pr2 == _self_seat:
			var lvl2: int = int(_snapshot.get("level_active", 12))
			var bad: Array[int] = []
			for key2 in _selected_ids.keys():
				if not GuandanCardDefs.is_valid_return_card(int(key2), lvl2):
					bad.append(int(key2))
			for id2 in bad:
				_selected_ids.erase(id2)


# ============================================================
# 渲染
# ============================================================

func _render_all(animate_new_plays: bool = true) -> void:
	_render_info()
	_render_seats(animate_new_plays)
	_render_hand()
	_maybe_start_deal_fx()
	_update_controls()


func _avatar_center_global(seat: int) -> Vector2:
	var ui_p: int = (seat - _self_seat + 4) % 4 if _self_seat >= 0 else seat
	var info: Dictionary = _seat_nodes[ui_p]
	var av: Control = info["avatar"] as Control
	return av.get_global_rect().get_center()


func _play_tribute_fly(te: Dictionary) -> void:
	var from_s: int = int(te.get("from", -1))
	var to_s: int = int(te.get("to", -1))
	var card_id: int = int(te.get("card", -1))
	if from_s < 0 or to_s < 0 or card_id < 0:
		return
	var p: String = GuandanDefs.texture_path_for(card_id)
	if p.is_empty() or not ResourceLoader.exists(p):
		return
	var fly := TextureRect.new()
	fly.texture = load(p)
	fly.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	fly.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	fly.custom_minimum_size = Vector2(44, 62)
	fly.size = Vector2(44, 62)
	fly.z_index = 420
	add_child(fly)
	var a0: Vector2 = _avatar_center_global(from_s)
	var a1: Vector2 = _avatar_center_global(to_s)
	fly.global_position = a0 - fly.size * 0.5
	var tw := create_tween()
	tw.tween_property(fly, "global_position", a1 - fly.size * 0.5, 0.52).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_IN_OUT)
	tw.tween_callback(func() -> void:
		if is_instance_valid(fly):
			fly.queue_free()
	)


func _heart_level_card_id(level_rr: int) -> int:
	## 仅用红心牌面示意当前打的级数（第一副牌 ♥，id = 13 + rawRank）
	return 13 + clampi(level_rr, 0, 12)


func _render_info() -> void:
	if _info_stage_label == null:
		return
	if _snapshot.is_empty():
		_info_stage_label.text = "等待服务器派发…"
		_level_team_label.text = ""
		_level_card_rect.texture = null
		_turn_status_label.text = ""
		if _lvl_our_value != null:
			_lvl_our_value.text = "-"
		if _lvl_them_value != null:
			_lvl_them_value.text = "-"
		return
	var phase: String = str(_snapshot.get("phase", ""))
	var turn: int = int(_snapshot.get("turn", -1))
	var lv_active: int = int(_snapshot.get("level_active", 12))
	var levels: Array = _snapshot.get("levels", [])
	var lv_a: String = _rr_label(int(levels[0])) if levels.size() >= 1 else "-"
	var lv_b: String = _rr_label(int(levels[1])) if levels.size() >= 2 else "-"
	_info_stage_label.text = _phase_stage_line(phase)
	var my_team: int = _self_seat % 2 if _self_seat >= 0 else 0
	var our_lv: String = lv_a if my_team == 0 else lv_b
	var them_lv: String = lv_b if my_team == 0 else lv_a
	if _lvl_our_value != null:
		_lvl_our_value.text = our_lv
	if _lvl_them_value != null:
		_lvl_them_value.text = them_lv
	_level_team_label.text = "红心级牌"
	var hp: String = GuandanDefs.texture_path_for(_heart_level_card_id(lv_active))
	if not hp.is_empty() and ResourceLoader.exists(hp):
		_level_card_rect.texture = load(hp) as Texture2D
	else:
		_level_card_rect.texture = null
	var trib_v: Variant = _snapshot.get("tribute", null)
	var pending_payer: int = -1
	var pending_receiver: int = -1
	if trib_v is Dictionary:
		pending_payer = int((trib_v as Dictionary).get("pending_payer", -1))
		pending_receiver = int((trib_v as Dictionary).get("pending_receiver", -1))
	var turn_status: String = ""
	match phase:
		"play":
			if turn >= 0:
				turn_status = "当前该「%s」出牌" % _cat_name_for_seat(turn, _snapshot)
		"tribute_wait":
			if pending_payer >= 0:
				turn_status = "当前该「%s」进贡" % _cat_name_for_seat(pending_payer, _snapshot)
		"return_wait":
			if pending_receiver >= 0:
				turn_status = "当前该「%s」还贡" % _cat_name_for_seat(pending_receiver, _snapshot)
		"deal":
			var first_play_s: int = int(_snapshot.get("first_play_seat", -1))
			var fd_s: int = int(_snapshot.get("first_draw_seat", 0))
			if bool(_snapshot.get("is_first_round", false)) and first_play_s >= 0:
				turn_status = "首局：「%s」先接到第一张牌（自座%d逆时针发牌）。「%s」先出牌。" % [
					_cat_name_for_seat(fd_s, _snapshot), fd_s, _cat_name_for_seat(first_play_s, _snapshot),
				]
			else:
				turn_status = "发牌中…"
		"finished":
			turn_status = "本局结束，等待继续"
		_:
			turn_status = "阶段：%s" % _phase_zh(phase)
	_turn_status_label.text = turn_status


## 牌手一行：猫咪名（昵称 / AI / 玩家）+（我）
func _player_line_title(seat: int, snap: Dictionary) -> String:
	if seat < 0 or seat > 3:
		return "?"
	var cat_idx: int = seat % 4
	var sc_v: Variant = snap.get("seat_cats", [])
	if sc_v is Array and seat < (sc_v as Array).size():
		cat_idx = clampi(int((sc_v as Array)[seat]), 0, GUANDAN_CAT_NAMES.size() - 1)
	var cat_name: String = GUANDAN_CAT_NAMES[cat_idx]
	var nick: String = ""
	var is_ai: bool = false
	var roster_v: Variant = snap.get("roster", [])
	if roster_v is Array:
		for e in (roster_v as Array):
			if e is Dictionary and int((e as Dictionary).get("seat", -99)) == seat:
				nick = str((e as Dictionary).get("username", ""))
				is_ai = bool((e as Dictionary).get("is_ai", false))
				break
	var who: String
	if not nick.is_empty():
		who = nick
	elif is_ai:
		who = "AI"
	else:
		who = "玩家"
	var core: String = "%s（%s）" % [cat_name, who]
	if seat == _self_seat:
		core += "（我）"
	return core


func _set_info(text: String) -> void:
	if _info_stage_label != null:
		_info_stage_label.text = text
	if _level_team_label != null:
		_level_team_label.text = ""
	if _level_card_rect != null:
		_level_card_rect.texture = null
	if _turn_status_label != null:
		_turn_status_label.text = ""
	if _lvl_our_value != null:
		_lvl_our_value.text = "-"
	if _lvl_them_value != null:
		_lvl_them_value.text = "-"


func _render_seats(animate_new_plays: bool = true) -> void:
	var hand_lens: Array = _snapshot.get("hand_lens", [])
	var finished: Array = _snapshot.get("finished", [])
	var turn: int = int(_snapshot.get("turn", -1))
	var ph: String = str(_snapshot.get("phase", ""))
	var trib: Variant = _snapshot.get("tribute", null)
	var pending_payer: int = -1
	var pending_receiver: int = -1
	if trib is Dictionary:
		pending_payer = int((trib as Dictionary).get("pending_payer", -1))
		pending_receiver = int((trib as Dictionary).get("pending_receiver", -1))

	for ui_pos in range(4):
		var seat: int = _logical_seat_for_ui(ui_pos)
		var info: Dictionary = _seat_nodes[ui_pos]

		# 头像（与 seat_cats 一致；缺省按座位轮转四猫）
		var cat_idx: int = seat % 4
		var sc_v: Variant = _snapshot.get("seat_cats", [])
		if sc_v is Array and seat >= 0 and seat < (sc_v as Array).size():
			cat_idx = clampi(int((sc_v as Array)[seat]), 0, 3)
		var av_path: String = GUANDAN_CAT_TEXTURES[cat_idx]
		var av_tex: Texture2D = null
		if ResourceLoader.exists(av_path):
			av_tex = load(av_path)
		(info["avatar"] as TextureRect).texture = av_tex
		var is_ai2: bool = false
		var roster_v2: Variant = _snapshot.get("roster", [])
		if roster_v2 is Array:
			for e2 in (roster_v2 as Array):
				if e2 is Dictionary and int((e2 as Dictionary).get("seat", -99)) == seat:
					is_ai2 = bool((e2 as Dictionary).get("is_ai", false))
					break
		var name_lbl2: Label = info["name"] as Label
		name_lbl2.text = _player_line_title(seat, _snapshot)
		name_lbl2.add_theme_color_override("font_color", COLOR_SEAT_AI if is_ai2 else COLOR_SEAT_HUMAN)

		# meta：名次 + 剩张（大字）；贡还提示
		var hl: int = int(hand_lens[seat]) if seat < hand_lens.size() else 0
		var tags: Array[String] = []
		if seat == turn and ph == "play":
			tags.append("出牌")
		if seat == pending_payer:
			tags.append("待进贡")
		if seat == pending_receiver:
			tags.append("待还贡")
		var rpos2: int = finished.find(seat)
		var rank_bb: String = ""
		if rpos2 >= 0:
			var rnames2: Array[String] = ["头游", "二游", "三游", "末游"]
			var rnm: String = rnames2[clamp(rpos2, 0, 3)]
			rank_bb = "[font_size=14][color=#ffd699]%s · [/color][/font_size]" % rnm
		var extra_bb: String = ""
		if not tags.is_empty():
			extra_bb = "  [font_size=12][color=#b8dcc8][%s][/color][/font_size]" % "·".join(tags)
		var meta_rt: RichTextLabel = info["meta"] as RichTextLabel
		meta_rt.text = "%s[font_size=%d][color=#fff8d6]剩 %d 张[/color][/font_size]%s" % [rank_bb, SEAT_META_REMAIN_FONT, hl, extra_bb]

		var active_turn: bool = false
		match ph:
			"play":
				active_turn = seat == turn and turn >= 0
			"tribute_wait":
				active_turn = seat == pending_payer and pending_payer >= 0
			"return_wait":
				active_turn = seat == pending_receiver and pending_receiver >= 0
			_:
				active_turn = false
		var idle_fr: Panel = info.get("idle_frame", null) as Panel
		if idle_fr != null:
			var show_idle: bool = not active_turn and (ph == "play" or ph == "tribute_wait" or ph == "return_wait")
			idle_fr.visible = show_idle
		var glow_p: Panel = info.get("turn_glow", null) as Panel
		if glow_p != null:
			if active_turn:
				if not glow_p.has_meta("pulse_tween") or not (glow_p.get_meta("pulse_tween") as Tween).is_valid():
					_run_turn_glow_pulse(glow_p)
			else:
				_stop_turn_glow_pulse(glow_p)

		var rb: Label = info.get("rank_badge", null) as Label
		if rb != null:
			rb.visible = false

		# 牌背堆（仅对家展示；自家 back_row=null）
		# 若本人已上游（出完），后端会下发 teammate_hand：把队友牌翻成明牌渲染。
		var back_holder: Variant = info.get("back_row", null)
		if back_holder is Control:
			var open_ids: Array[int] = _teammate_open_ids_for_seat(seat)
			if ui_pos == 2 and not open_ids.is_empty():
				_render_teammate_open_hand(back_holder as Control, open_ids)
			else:
				_render_back_stack(back_holder as Control, str(info.get("back_dir", "h")), hl, seat == _self_seat)

		# 出牌区
		_render_play_area(info["play_row"] as Control, str(info.get("play_dir", "h")), info["act_label"] as Label, seat, animate_new_plays)


func _teammate_open_ids_for_seat(seat: int) -> Array[int]:
	var out: Array[int] = []
	var ts: int = int(_snapshot.get("teammate_seat", -1))
	var th: Variant = _snapshot.get("teammate_hand", null)
	if ts != seat or not (th is Array):
		return out
	for v in (th as Array):
		out.append(int(v))
	return out


func _render_back_stack(holder: Control, direction: String, hand_len: int, is_self: bool) -> void:
	for c in holder.get_children():
		c.queue_free()
	if is_self:
		return
	var n: int = hand_len
	if n <= 0:
		if direction == "h":
			holder.custom_minimum_size = Vector2(TOP_BACK_W, TOP_BACK_H)
		else:
			holder.custom_minimum_size = Vector2(SIDE_BACK_VISUAL_W, SIDE_BACK_VISUAL_H)
		return
	var back_path: String = GuandanDefs.CARD_BACK_PATH
	var back_tex: Texture2D = null
	if ResourceLoader.exists(back_path):
		back_tex = load(back_path)
	if direction == "h":
		var avail_w: float = max(get_viewport_rect().size.x - 400.0, 260.0)
		var step: float = TOP_BACK_STEP
		var total_w: float = TOP_BACK_W + (n - 1) * step
		if total_w > avail_w and n > 1:
			step = max((avail_w - TOP_BACK_W) / float(n - 1), TOP_BACK_MIN_STEP)
			total_w = TOP_BACK_W + (n - 1) * step
		holder.custom_minimum_size = Vector2(total_w, TOP_BACK_H)
		for i in range(n):
			var rect := TextureRect.new()
			rect.texture = back_tex
			rect.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
			rect.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
			rect.size = Vector2(TOP_BACK_W, TOP_BACK_H)
			rect.position = Vector2(i * step, 0)
			holder.add_child(rect)
	else:
		# 左/右家：每张牌背顺时针旋转 90°，竖向堆叠；空间不够时自动收紧 step。
		var avail_h: float = max(get_viewport_rect().size.y - 200.0, 240.0)
		var step_v: float = SIDE_BACK_STEP
		var total_h: float = SIDE_BACK_VISUAL_H + (n - 1) * step_v
		if total_h > avail_h and n > 1:
			step_v = max((avail_h - SIDE_BACK_VISUAL_H) / float(n - 1), SIDE_BACK_MIN_STEP)
			total_h = SIDE_BACK_VISUAL_H + (n - 1) * step_v
		holder.custom_minimum_size = Vector2(SIDE_BACK_VISUAL_W, total_h)
		var raw := Vector2(SIDE_BACK_VISUAL_H, SIDE_BACK_VISUAL_W)
		var visual := Vector2(SIDE_BACK_VISUAL_W, SIDE_BACK_VISUAL_H)
		var off := (visual - raw) * 0.5
		for i in range(n):
			var rect := TextureRect.new()
			rect.texture = back_tex
			rect.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
			rect.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
			rect.size = raw
			rect.pivot_offset = raw * 0.5
			rect.rotation_degrees = 90
			rect.position = Vector2(0, i * step_v) + off
			holder.add_child(rect)


## 顶部队友明牌：横向排列，空间不够自动压缩 step。按真实 id 渲染牌面。
func _play_anim_signature(sq: int, kind: String, ids: Array) -> String:
	var id_parts: PackedStringArray = PackedStringArray()
	for v in ids:
		id_parts.append(str(int(v)))
	return "%d:%s:%s" % [sq, kind, "|".join(id_parts)]


func _render_teammate_open_hand(holder: Control, ids: Array[int]) -> void:
	for c in holder.get_children():
		c.queue_free()
	var n: int = ids.size()
	if n <= 0:
		holder.custom_minimum_size = Vector2(TEAMMATE_CARD_W, TEAMMATE_CARD_H)
		return
	var avail_w: float = max(get_viewport_rect().size.x - 400.0, 260.0)
	var step: float = TEAMMATE_CARD_W * 0.21
	var total_w: float = TEAMMATE_CARD_W + (n - 1) * step
	if total_w > avail_w and n > 1:
		step = max((avail_w - TEAMMATE_CARD_W) / float(n - 1), TEAMMATE_STEP_MIN)
		total_w = TEAMMATE_CARD_W + (n - 1) * step
	holder.custom_minimum_size = Vector2(total_w, TEAMMATE_CARD_H)
	for i in range(n):
		var path: String = GuandanDefs.texture_path_for(int(ids[i]))
		if path.is_empty() or not ResourceLoader.exists(path):
			continue
		var rect := TextureRect.new()
		rect.texture = load(path)
		rect.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		rect.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		rect.size = Vector2(TEAMMATE_CARD_W, TEAMMATE_CARD_H)
		rect.position = Vector2(i * step, 0)
		holder.add_child(rect)


func _render_play_area(holder: Control, direction: String, act_label: Label, seat: int, animate_new_plays: bool) -> void:
	for c in holder.get_children():
		c.queue_free()
	act_label.text = ""
	if not _seat_last_action.has(seat):
		if direction == "h":
			holder.custom_minimum_size = Vector2(0, PLAY_CARD_H)
		else:
			holder.custom_minimum_size = Vector2(PLAY_CARD_H, 0)
		return
	var a: Dictionary = _seat_last_action[seat]
	var kind: String = str(a.get("kind", ""))
	if kind == "pass":
		act_label.text = "（过）"
		if direction == "h":
			holder.custom_minimum_size = Vector2(0, PLAY_CARD_H)
		else:
			holder.custom_minimum_size = Vector2(PLAY_CARD_H, 0)
		return
	var ids: Array = a.get("ids", [])
	var n: int = ids.size()
	if n <= 0:
		return
	var should_anim: bool = animate_new_plays and kind == "play"
	if should_anim:
		var sig: String = _play_anim_signature(int(a.get("seq", -1)), kind, ids)
		if str(_play_anim_done_key.get(seat, "")) == sig:
			should_anim = false
		else:
			_play_anim_done_key[seat] = sig
	if direction == "h":
		var step: float = PLAY_CARD_W + PLAY_OVERLAP_H
		var total_w: float = (n - 1) * step + PLAY_CARD_W
		holder.custom_minimum_size = Vector2(total_w, PLAY_CARD_H)
		for i in range(n):
			_add_play_card(holder, int(ids[i]), Vector2(i * step, 0), false, should_anim, i)
	else:
		var step_v: float = SIDE_PLAY_STEP
		var total_h: float = (n - 1) * step_v + PLAY_CARD_W
		holder.custom_minimum_size = Vector2(PLAY_CARD_H, total_h)
		for i in range(n):
			_add_play_card(holder, int(ids[i]), Vector2(0, i * step_v), true, should_anim, i)


func _add_play_card(holder: Control, id: int, visual_pos: Vector2, rotated: bool, animate: bool, stagger_i: int = 0) -> void:
	var path: String = GuandanDefs.texture_path_for(id)
	if path.is_empty() or not ResourceLoader.exists(path):
		return
	var rect := TextureRect.new()
	rect.texture = load(path)
	rect.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	rect.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	rect.mouse_filter = Control.MOUSE_FILTER_IGNORE
	if rotated:
		var raw := Vector2(PLAY_CARD_W, PLAY_CARD_H)
		var visual := Vector2(PLAY_CARD_H, PLAY_CARD_W)
		rect.size = raw
		rect.pivot_offset = raw * 0.5
		rect.rotation_degrees = 90
		rect.position = visual_pos + (visual - raw) * 0.5
	else:
		rect.size = Vector2(PLAY_CARD_W, PLAY_CARD_H)
		rect.pivot_offset = rect.size * 0.5
		rect.position = visual_pos
	holder.add_child(rect)
	if not animate:
		return
	var end_pos: Vector2 = rect.position
	var off: Vector2 = Vector2(0, 40) if not rotated else Vector2(36, 0)
	rect.scale = Vector2(0.32, 0.32)
	rect.modulate = Color(1, 1, 1, 0.15)
	rect.position = end_pos + off
	var d: float = 0.035 * float(stagger_i)
	var tw := create_tween()
	tw.set_parallel(true)
	tw.tween_property(rect, "position", end_pos, 0.26).set_delay(d).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	tw.tween_property(rect, "scale", Vector2.ONE, 0.26).set_delay(d).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	tw.tween_property(rect, "modulate:a", 1.0, 0.2).set_delay(d)


func _logical_seat_for_ui(ui_pos: int) -> int:
	if _self_seat < 0:
		return ui_pos
	return (_self_seat + ui_pos) % 4


func _deal_table_center_global() -> Vector2:
	var r: Rect2 = get_viewport_rect()
	return r.position + Vector2(r.size.x * 0.5, r.size.y * 0.42)


func _maybe_start_deal_fx() -> void:
	var ph: String = str(_snapshot.get("phase", ""))
	if ph != "deal":
		return
	var sq: int = int(_snapshot.get("seq", -1))
	if sq == _deal_fx_seq:
		return
	_deal_fx_seq = sq
	var tw: Tween = create_tween()
	for r in range(27):
		var rr: int = r
		tw.tween_callback(func() -> void: _deal_emit_round(rr))
		tw.tween_interval(0.038)


func _deal_emit_round(round_idx: int) -> void:
	if str(_snapshot.get("phase", "")) != "deal":
		return
	var p: String = GuandanDefs.CARD_BACK_PATH
	if p.is_empty() or not ResourceLoader.exists(p):
		return
	var tex: Texture2D = load(p) as Texture2D
	if tex == null:
		return
	var from_g: Vector2 = _deal_table_center_global()
	for s in range(4):
		_spawn_deal_fly(tex, from_g, s, round_idx * 4 + s)


func _spawn_deal_fly(tex: Texture2D, from_g: Vector2, seat: int, _idx: int) -> void:
	var fly := TextureRect.new()
	fly.texture = tex
	fly.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	fly.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	fly.custom_minimum_size = Vector2(38, 54)
	fly.size = Vector2(38, 54)
	fly.z_index = 380
	fly.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(fly)
	var to_c: Vector2 = _avatar_center_global(seat)
	fly.global_position = from_g - fly.size * 0.5
	var tw2: Tween = create_tween()
	tw2.tween_property(fly, "global_position", to_c - fly.size * 0.5, 0.2).set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_OUT)
	tw2.tween_callback(func() -> void:
		if is_instance_valid(fly):
			fly.queue_free()
	)


func _deal_hand_signature() -> String:
	if _self_hand.is_empty():
		return "empty"
	var s: String = ""
	for id in _self_hand:
		s += str(int(id)) + ","
	return s


## 发牌阶段：明牌自左向右依次滑入（与正式手牌同尺寸与压叠，便于衔接出牌阶段）
func _build_deal_hand_ltr_animation() -> void:
	var dsig: String = _deal_hand_signature()
	_deal_hand_anim_sig = dsig
	if _self_hand.is_empty():
		var hint0 := Label.new()
		hint0.text = "摸牌中…"
		hint0.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		hint0.custom_minimum_size = Vector2(260, HAND_CARD_H + 6)
		hint0.add_theme_font_size_override("font_size", 16)
		hint0.add_theme_color_override("font_color", Color(1, 0.93, 0.78, 0.95))
		hint0.mouse_filter = Control.MOUSE_FILTER_IGNORE
		_hand_area.add_child(hint0)
		_hand_area.custom_minimum_size = Vector2(280, HAND_CARD_H + 22)
		return
	var n: int = _self_hand.size()
	var vp_w: float = get_viewport_rect().size.x
	var avail: float = max(vp_w - 100.0, 520.0)
	var step: float = HAND_CARD_W + HAND_OVERLAP
	var total_w: float = (n - 1) * step + HAND_CARD_W
	if total_w > avail and n > 1:
		step = (avail - HAND_CARD_W) / float(n - 1)
		total_w = (n - 1) * step + HAND_CARD_W
	if step < 10.0:
		step = 10.0
		total_w = (n - 1) * step + HAND_CARD_W
	var base_y: float = 14.0
	_hand_area.custom_minimum_size = Vector2(total_w, HAND_CARD_H + 30.0)
	var cards: Array[TextureRect] = []
	for i in range(n):
		var id: int = int(_self_hand[i])
		var rect := TextureRect.new()
		rect.set_meta("deal_ltr_card", true)
		rect.set_meta("card_id", id)
		rect.mouse_filter = Control.MOUSE_FILTER_IGNORE
		rect.custom_minimum_size = Vector2(HAND_CARD_W, HAND_CARD_H)
		rect.size = Vector2(HAND_CARD_W, HAND_CARD_H)
		var path: String = GuandanDefs.texture_path_for(id)
		if not path.is_empty() and ResourceLoader.exists(path):
			rect.texture = load(path)
		rect.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		rect.stretch_mode = TextureRect.STRETCH_SCALE
		var x0: float = float(i) * step
		var final_p: Vector2 = Vector2(x0, base_y)
		rect.position = final_p + Vector2(-DEAL_HAND_SLIDE_PX, 0)
		rect.modulate = Color(1, 1, 1, 0)
		_hand_area.add_child(rect)
		cards.append(rect)
	var st := Label.new()
	st.text = "摸牌中…"
	st.position = Vector2(0, HAND_CARD_H + 14)
	st.custom_minimum_size = Vector2(total_w, 18)
	st.add_theme_font_size_override("font_size", 12)
	st.add_theme_color_override("font_color", Color(0.88, 0.82, 0.7, 0.88))
	st.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_hand_area.add_child(st)
	for i2 in range(n):
		var tw: Tween = create_tween()
		tw.tween_interval(DEAL_HAND_STAGGER_SEC * float(i2))
		tw.set_parallel(true)
		tw.tween_property(cards[i2], "modulate", Color.WHITE, DEAL_HAND_IN_DURATION * 0.55)
		tw.tween_property(cards[i2], "position", Vector2(float(i2) * step, base_y), DEAL_HAND_IN_DURATION).set_trans(
			Tween.TRANS_CUBIC
		).set_ease(Tween.EASE_OUT)


func _render_hand() -> void:
	if _hand_area == null:
		return
	_ensure_hand_gap_catcher()
	var ph: String = str(_snapshot.get("phase", ""))
	if ph != "deal":
		_deal_hand_anim_sig = ""
	else:
		var d_sig: String = _deal_hand_signature()
		if d_sig == _deal_hand_anim_sig and d_sig != "":
			_hand_area.move_child(_hand_gap_catcher, 0)
			return
	for i in range(_hand_area.get_child_count() - 1, -1, -1):
		var ch: Node = _hand_area.get_child(i)
		if ch == _hand_gap_catcher:
			continue
		ch.queue_free()
	if ph == "deal":
		_build_deal_hand_ltr_animation()
		_hand_area.move_child(_hand_gap_catcher, 0)
		return
	var n: int = _self_hand.size()
	if n <= 0:
		_hand_area.custom_minimum_size = Vector2(HAND_CARD_W, HAND_CARD_H + 18)
		return
	var vp_w: float = get_viewport_rect().size.x
	var avail: float = max(vp_w - 100.0, 520.0)
	var step: float = HAND_CARD_W + HAND_OVERLAP
	var total_w: float = (n - 1) * step + HAND_CARD_W
	if total_w > avail and n > 1:
		step = (avail - HAND_CARD_W) / float(n - 1)
		total_w = (n - 1) * step + HAND_CARD_W
	if step < 10.0:
		step = 10.0
		total_w = (n - 1) * step + HAND_CARD_W
	_hand_area.custom_minimum_size = Vector2(total_w, HAND_CARD_H + 18)
	var base_y: float = 14.0
	for i in range(n):
		var id: int = _self_hand[i]
		var rect := TextureRect.new()
		rect.set_meta("card_id", id)
		rect.mouse_filter = Control.MOUSE_FILTER_STOP
		rect.custom_minimum_size = Vector2(HAND_CARD_W, HAND_CARD_H)
		rect.size = Vector2(HAND_CARD_W, HAND_CARD_H)
		var path: String = GuandanDefs.texture_path_for(id)
		if not path.is_empty() and ResourceLoader.exists(path):
			rect.texture = load(path)
		rect.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		rect.stretch_mode = TextureRect.STRETCH_SCALE
		var sel_lift: float = (-16.0 if _selected_ids.has(id) else 0.0)
		var row_y: float = base_y + sel_lift
		rect.set_meta("hand_row_x", float(i * step))
		rect.set_meta("hand_row_y", row_y)
		if _selected_ids.has(id):
			rect.modulate = Color(1.12, 1.08, 0.82, 1)
		else:
			rect.modulate = Color.WHITE
		rect.position = Vector2(i * step, row_y)
		var cid: int = id
		rect.gui_input.connect(func(ev: InputEvent) -> void: _on_hand_card_gui_input(ev, cid))
		_hand_area.add_child(rect)
	_hand_area.move_child(_hand_gap_catcher, 0)


func _update_controls() -> void:
	var phase: String = str(_snapshot.get("phase", ""))
	var turn: int = int(_snapshot.get("turn", -1))
	var trib: Variant = _snapshot.get("tribute", null)
	var pending_payer: int = -1
	var pending_receiver: int = -1
	if trib is Dictionary:
		pending_payer = int((trib as Dictionary).get("pending_payer", -1))
		pending_receiver = int((trib as Dictionary).get("pending_receiver", -1))
	var last: Variant = _snapshot.get("last", null)
	var last_empty: bool = not (last is Dictionary)
	var self_finished: bool = _snapshot.get("finished", []) is Array and (_snapshot["finished"] as Array).has(_self_seat)

	var is_my_play: bool = phase == "play" and turn == _self_seat
	var is_my_pay: bool = phase == "tribute_wait" and pending_payer == _self_seat
	var is_my_return: bool = phase == "return_wait" and pending_receiver == _self_seat
	var is_finished: bool = phase == "finished"

	var in_play: bool = phase == "play"
	var in_tribute: bool = phase == "tribute_wait"
	var in_return: bool = phase == "return_wait"
	_btn_play.visible = in_play
	_btn_pass.visible = in_play
	_btn_hint.visible = in_play
	_btn_tribute.visible = in_tribute
	_btn_resist.visible = in_tribute
	_btn_return.visible = in_return
	_btn_delegate.visible = in_play
	var deleg_on: bool = false
	var ad_sn: Variant = _snapshot.get("ai_delegate", [])
	if ad_sn is Array and _self_seat >= 0 and (ad_sn as Array).size() > _self_seat:
		deleg_on = bool((ad_sn as Array)[_self_seat])
	if _btn_delegate != null:
		_btn_delegate.text = "取消托管" if deleg_on else "AI托管"

	_btn_play.disabled = not is_my_play
	_btn_pass.disabled = not is_my_play or last_empty
	_btn_hint.disabled = not is_my_play
	_btn_tribute.disabled = not is_my_pay
	_btn_resist.disabled = not is_my_pay
	_btn_return.disabled = not is_my_return
	_btn_delegate.disabled = false
	var can_continue: bool = is_finished
	if _settle_overlay != null and _settle_overlay.visible:
		can_continue = true
	if _btn_continue != null:
		_btn_continue.disabled = not can_continue
	if _btn_settle_lobby != null:
		_btn_settle_lobby.disabled = not can_continue

	# 操作提示：根据 phase + 角色动态文本
	var sel_n: int = _selected_ids.size()
	var hint: String = ""
	if is_finished:
		if _settle_overlay != null and _settle_overlay.visible:
			hint = "本局结束，点结算弹窗内「下一局」继续对局。"
		else:
			hint = "本局结束，点「下一局」继续对局。"
	elif is_my_pay:
		hint = "进贡：请选择 1 张你手里最大的牌（红心级牌除外）→ 勾选后点「进贡」。"
		if _can_i_resist():
			hint += "  你有 ≥2 张大王，也可点「抗贡」。"
	elif is_my_return:
		var lv_h: int = int(_snapshot.get("level_active", 12))
		if lv_h == 12:
			hint = "还贡：选 1 张 3～10 点（打 2 时不可选普通 2、JQK、A、王、红心级牌）→ 点「还贡」。"
		else:
			hint = "还贡：可选 3～10 点；非打 2 时也可选普通 2（不可 JQK、A、王、红心级牌）→ 点「还贡」。"
	elif phase == "tribute_wait":
		hint = "贡牌阶段 · 等待座 %d 进贡…" % pending_payer
	elif phase == "return_wait":
		hint = "还贡阶段 · 等待座 %d 还贡…" % pending_receiver
	elif self_finished and phase == "play":
		hint = "你已上游，队友手牌已翻开供你参考。"
	elif is_my_play:
		if last_empty:
			hint = "自由领出 · 选择任意合法牌型后点「出牌」。"
		else:
			var kind_zh: String = _kind_zh(str((last as Dictionary).get("kind", "0")))
			hint = "上家「%s」，选更大的同型或炸弹压制，也可「过」。" % kind_zh
		if sel_n > 0:
			var cand: String = _guess_pattern_name(sel_n)
			if cand.is_empty():
				hint += "  已选 %d 张。" % sel_n
			else:
				hint += "  已选 %d 张 · 候选：%s" % [sel_n, cand]
		var ad_v: Variant = _snapshot.get("ai_delegate", [])
		if ad_v is Array and _self_seat >= 0 and (ad_v as Array).size() > _self_seat:
			if (ad_v as Array)[_self_seat]:
				hint += "  [已 AI 托管]"
	elif phase == "play":
		hint = "等待座 %d 出牌…" % turn
	_hint_label.text = hint


func _guess_pattern_name(n: int) -> String:
	match n:
		1: return "单张"
		2: return "对子"
		3: return "三同"
		4: return "四炸"
		5: return "三带二 / 顺子 / 同花顺"
		6: return "连对(三对) / 钢板 / 六炸"
		7: return "七炸"
		8: return "连对(四对) / 八炸"
		10: return "连对(五对)"
		12: return "连对(六对)"
		_: return ""


func _can_i_resist() -> bool:
	var big: int = 0
	for id in _self_hand:
		if GuandanDefs.raw_rank(int(id)) == GuandanDefs.RR_BIG_JOKER:
			big += 1
	return big >= 2


# ============================================================
# 动作：向服务器发送
# ============================================================

func _selected_list() -> Array[int]:
	var out: Array[int] = []
	for id in _self_hand:
		if _selected_ids.has(id):
			out.append(int(id))
	return out


func _clear_selection() -> void:
	_selected_ids.clear()


func _on_play_pressed() -> void:
	var ids: Array[int] = _selected_list()
	if ids.is_empty():
		_show_msg("请至少选择一张牌。")
		return
	_hub.send_guandan_action_async(int(_hub.GD_REQ_PLAY), {"ids": ids})
	_clear_selection()


func _on_pass_pressed() -> void:
	_hub.send_guandan_action_async(int(_hub.GD_REQ_PASS), {})
	_clear_selection()


func _on_delegate_pressed() -> void:
	var ad: Variant = _snapshot.get("ai_delegate", [])
	var next_on: bool = true
	if ad is Array and _self_seat >= 0 and (ad as Array).size() > _self_seat:
		next_on = not bool((ad as Array)[_self_seat])
	else:
		next_on = true
	_hub.send_guandan_action_async(int(_hub.GD_REQ_DELEGATE), {"on": next_on})


func _on_hint_pressed() -> void:
	var phase: String = str(_snapshot.get("phase", ""))
	var lvl: int = int(_snapshot.get("level_active", 12))
	if phase == "tribute_wait":
		var tid: int = GuandanHintSelectScr.suggest_tribute_id(_self_hand, lvl)
		if tid < 0:
			_show_msg("无法选择进贡牌。")
			return
		_selected_ids = {tid: true}
	elif phase == "return_wait":
		var rid: int = GuandanHintSelectScr.suggest_return_id(_self_hand, lvl)
		if rid < 0:
			_show_msg("没有符合还贡条件的牌（3～10 点，不能选 2、JQK、王）。")
			return
		_selected_ids = {rid: true}
	elif phase == "play":
		var tn: int = int(_snapshot.get("turn", -1))
		if tn != _self_seat:
			return
		_hub.send_guandan_action_async(int(_hub.GD_REQ_HINT), {})
		return
	else:
		return
	_render_hand()
	_update_controls()


func _on_tribute_pressed() -> void:
	var ids: Array[int] = _selected_list()
	if ids.size() != 1:
		_show_msg("进贡请勾选一张牌。")
		return
	_hub.send_guandan_action_async(int(_hub.GD_REQ_TRIBUTE), {"id": ids[0]})
	_clear_selection()


func _on_resist_pressed() -> void:
	_hub.send_guandan_action_async(int(_hub.GD_REQ_TRIBUTE_RESIST), {})


func _on_return_pressed() -> void:
	var ids: Array[int] = _selected_list()
	if ids.size() != 1:
		_show_msg("还贡请勾选一张牌。")
		return
	_hub.send_guandan_action_async(int(_hub.GD_REQ_RETURN), {"id": ids[0]})
	_clear_selection()


func _on_continue_pressed() -> void:
	_hub.send_guandan_action_async(int(_hub.GD_REQ_CONTINUE), {})
	_settle_overlay.visible = false


func _async_goto_lobby() -> void:
	if _hub != null and _hub.has_method("leave_online_match_cleanup_async"):
		await _hub.leave_online_match_cleanup_async()
	get_tree().change_scene_to_file("res://scenes/multiplayer_lobby.tscn")


func _on_settle_lobby_pressed() -> void:
	_settle_overlay.visible = false
	await _async_goto_lobby()


func _on_leave_pressed() -> void:
	await _async_goto_lobby()


# ============================================================
# 工具
# ============================================================

func _truncate_line(s: String, max_chars: int) -> String:
	if s.length() <= max_chars:
		return s
	return s.substr(0, max_chars) + "…"


func _phase_stage_line(phase: String) -> String:
	match phase:
		"lobby": return "准备中"
		"deal": return "发牌阶段"
		"tribute_wait": return "进贡阶段"
		"return_wait": return "还贡阶段"
		"play": return "出牌阶段"
		"finished": return "本局结算"
		"waiting": return "等待开局"
		_: return "阶段：%s" % phase


func _phase_zh(phase: String) -> String:
	match phase:
		"lobby": return "准备中"
		"deal": return "发牌"
		"tribute_wait": return "进贡"
		"return_wait": return "还贡"
		"play": return "出牌"
		"finished": return "本局结算"
		_: return phase


func _kind_zh(k: String) -> String:
	if str(k).is_valid_int():
		return _kind_zh_int(int(k))
	match k:
		"single": return "单张"
		"pair": return "对子"
		"triple": return "三张"
		"triple_pair": return "三带二"
		"straight": return "顺子"
		"pair_straight": return "连对"
		"triple_straight": return "钢板"
		"bomb4": return "四炸"
		"bomb5": return "五炸"
		"bomb6": return "六炸"
		"bomb7": return "七炸"
		"bomb8": return "八炸"
		"straight_flush": return "同花顺"
		"king_bomb": return "天王炸"
		_: return k


func _kind_zh_int(ki: int) -> String:
	match ki:
		2: return "单张"
		3: return "对子"
		4: return "三张"
		5: return "三带二"
		6: return "顺子"
		7: return "连对"
		8: return "钢板"
		9: return "同花顺"
		10: return "炸弹"
		11: return "天王炸"
		_: return "牌型(%d)" % ki


func _rr_label(rr: int) -> String:
	if rr < 0:
		return "-"
	if rr == 13:
		return "小王"
	if rr == 14:
		return "大王"
	if rr < GuandanDefs.RAW_RANK_LABELS.size():
		return GuandanDefs.RAW_RANK_LABELS[rr]
	return str(rr)


func _show_msg(text: String) -> void:
	_msg_label.text = text
	var tree := get_tree()
	if tree == null:
		return
	tree.create_timer(3.0).timeout.connect(func() -> void:
		if is_instance_valid(_msg_label) and _msg_label.text == text:
			_msg_label.text = ""
	)
