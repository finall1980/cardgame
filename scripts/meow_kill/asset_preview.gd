extends Control
## 编辑器 / 运行时快速校验 meowkill 资源路径。运行本场景即可查看手牌、出牌区、武将拼接。
##
## 菜单：项目 → 运行 → 指定主场景 可临时指向本场景；或从文件系统双击 .tscn 后点运行当前场景。

const CardAssets := preload("res://scripts/meow_kill/card_assets.gd")
const GeneralAssets := preload("res://scripts/meow_kill/general_assets.gd")

## 与 `meowkill/big-card` 中 stem 一致的小写 key。
const SAMPLE_CARD_KEYS: PackedStringArray = ["slash", "jink", "peach", "snatch", "crossbow", "duel"]

## `generals/big` 有立绘的 id；`kingdom` 与 frame 文件名一致。
const DEMO_GENERAL_ID := "erzhang"
const DEMO_KINGDOM := "wu"

const HAND_CARD_SIZE := Vector2(76, 108)
const PLAY_CARD_SIZE := Vector2(76, 108)
const GENERAL_CARD_SIZE := Vector2(150, 210)

@onready var _hand_row: HBoxContainer = %HandRow
@onready var _play_row: HBoxContainer = %PlayRow
@onready var _general_stack: Control = %GeneralStack
@onready var _hint: Label = %HintLabel


func _ready() -> void:
	CardAssets.ensure_index()
	_hint.text = "手牌目录: meowkill/big-card  ·  出牌: meowkill/card  ·  武将: %s + %s框" % [DEMO_GENERAL_ID, DEMO_KINGDOM]
	for k: String in SAMPLE_CARD_KEYS:
		_hand_row.add_child(_make_card_rect(CardAssets.hand_texture_path(k), HAND_CARD_SIZE, k))
		_play_row.add_child(_make_card_rect(CardAssets.play_texture_path(k), PLAY_CARD_SIZE, k))
	_build_general_demo()


func _make_card_rect(path: String, card_size: Vector2, card_key: String) -> Control:
	var cell: MarginContainer = MarginContainer.new()
	cell.add_theme_constant_override("margin_right", 6)
	var t: TextureRect = TextureRect.new()
	t.custom_minimum_size = card_size
	t.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	t.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	if ResourceLoader.exists(path):
		t.texture = load(path) as Texture2D
	else:
		t.modulate = Color(1, 0.3, 0.3, 0.85)
	cell.add_child(t)
	cell.tooltip_text = "%s\n%s" % [card_key, path]
	return cell


func _build_general_demo() -> void:
	for c: Node in _general_stack.get_children():
		c.queue_free()
	_general_stack.custom_minimum_size = GENERAL_CARD_SIZE

	var layers: Dictionary = GeneralAssets.compose_layer_paths(DEMO_GENERAL_ID, DEMO_KINGDOM)
	var pre: String = str(layers.get("precomposed", ""))
	if not pre.is_empty() and ResourceLoader.exists(pre):
		var single: TextureRect = TextureRect.new()
		single.set_anchors_preset(Control.PRESET_FULL_RECT)
		single.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		single.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		single.texture = load(pre) as Texture2D
		_general_stack.add_child(single)
		var cap: Label = Label.new()
		cap.text = "预合成卡 %s" % DEMO_GENERAL_ID
		cap.add_theme_font_size_override("font_size", 12)
		cap.position = Vector2(4, 4)
		_general_stack.add_child(cap)
		return

	var frame_path: String = str(layers.get("kingdom_frame", ""))
	var portrait_path: String = str(layers.get("portrait_big", ""))
	var overlay_path: String = GeneralAssets.compact_frame_path("playing")

	var frame_tex: TextureRect = TextureRect.new()
	frame_tex.set_anchors_preset(Control.PRESET_FULL_RECT)
	frame_tex.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	frame_tex.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_COVERED
	if ResourceLoader.exists(frame_path):
		frame_tex.texture = load(frame_path) as Texture2D
	_general_stack.add_child(frame_tex)

	if not portrait_path.is_empty():
		var portrait: TextureRect = TextureRect.new()
		portrait.set_anchors_preset(Control.PRESET_CENTER)
		portrait.offset_left = -55
		portrait.offset_top = -70
		portrait.offset_right = 55
		portrait.offset_bottom = 70
		portrait.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		portrait.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		portrait.texture = load(portrait_path) as Texture2D
		_general_stack.add_child(portrait)

	if ResourceLoader.exists(overlay_path):
		var over: TextureRect = TextureRect.new()
		over.set_anchors_preset(Control.PRESET_FULL_RECT)
		over.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		over.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		over.texture = load(overlay_path) as Texture2D
		_general_stack.add_child(over)

	var cap2: Label = Label.new()
	cap2.text = "拼接 %s" % DEMO_GENERAL_ID
	cap2.add_theme_font_size_override("font_size", 12)
	cap2.position = Vector2(4, 4)
	_general_stack.add_child(cap2)
