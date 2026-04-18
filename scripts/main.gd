extends Control
## 斗地主：摸牌 → 叫地主 → 出牌；日志；扩展牌型见 Rules。

const Rules = preload("res://scripts/ddz_rules.gd")
const DdzAi = preload("res://scripts/ddz_ai.gd")
const Deck = preload("res://scripts/deck.gd")
const SFX_DEAL_PATH: String = "res://MusicAssets/shuffle-cards.mp3"
const SFX_PLAY_PATH: String = "res://MusicAssets/carddrop.mp3"
const SFX_PASS: AudioStream = preload("res://audio/sfx_pass.wav")
const SFX_BOMB: AudioStream = preload("res://audio/sfx_bomb.wav")
const DEFAULT_BGM_VOLUME_PCT: float = 60.0

signal human_bid_chosen(score: int)
signal human_rob_chosen(rob: bool)

## 猫咪身份：0=丑丑妹 1=咪宝 2=毛睿睿（与头像资源顺序一致）
const CAT_NAMES: Array[String] = ["丑丑妹", "咪宝", "毛睿睿"]
const CAT_AVATAR_PATHS: Array[String] = [
	"res://assets/avatars/cat_chou.png",
	"res://assets/avatars/cat_mibao.png",
	"res://assets/avatars/cat_maoruirui.png",
]
const SCORE_START: int = 5000
const BASE_L_WIN: int = 100
const BASE_F_WIN: int = 50
const BASE_L_LOSE: int = 100
const HUMAN_INDEX: int = 0

const _CARD_W: float = 78.0
const _CARD_H: float = 108.0
const _FAN_STEP: float = 24.0
const _HAND_BASE_Y: float = 12.0
const _AI_THINK_SEC: float = 0.58
const _AI_EXTRA_PAUSE_SEC: float = 0.22
const _TABLE_CARD_W_CENTER: float = 54.0
const _TABLE_CARD_H_CENTER: float = 75.0
const _PLAY_ANIM_DURATION: float = 0.34
const _PLAY_ANIM_STAGGER: float = 0.045

@onready var _title: Label = %Title
@onready var _status: RichTextLabel = %Status
@onready var _play_kind_labels: Array[Label] = [%PlayKindP0, %PlayKindP1, %PlayKindP2]
@onready var _play_cards_rows: Array[HBoxContainer] = [%PlayCardsP0, %PlayCardsP1, %PlayCardsP2]
@onready var _hand_row: Control = %HandRow
@onready var _btn_play: Button = %BtnPlay
@onready var _btn_hint: Button = %BtnHint
@onready var _btn_pass: Button = %BtnPass
@onready var _btn_new: Button = %BtnNew
@onready var _btn_back_menu: Button = %BtnBackMenu
@onready var _label_p0: Label = %LabelP0
@onready var _label_p1: Label = %LabelP1
@onready var _label_p2: Label = %LabelP2
@onready var _avatar_p0: TextureRect = %AvatarP0
@onready var _avatar_p1: TextureRect = %AvatarP1
@onready var _avatar_p2: TextureRect = %AvatarP2
@onready var _maocao_val0: Label = %MaocaoVal0
@onready var _maocao_val1: Label = %MaocaoVal1
@onready var _maocao_val2: Label = %MaocaoVal2
@onready var _landlord_badges: Array[Label] = [%LandlordBadgeP0, %LandlordBadgeP1, %LandlordBadgeP2]
@onready var _deal_layer: CanvasLayer = %DealLayer
@onready var _game_log: RichTextLabel = %GameLog
@onready var _bottom_cards: HBoxContainer = %BottomCards
@onready var _bidding_row: VBoxContainer = %BiddingRow
@onready var _btn_bid0: Button = %BtnBid0
@onready var _btn_bid1: Button = %BtnBid1
@onready var _btn_bid2: Button = %BtnBid2
@onready var _btn_bid3: Button = %BtnBid3
@onready var _opp_p2: HBoxContainer = %OppP2
@onready var _opp_p1: HBoxContainer = %OppP1
@onready var _opp_lbl2: Label = %OppLbl2
@onready var _opp_lbl1: Label = %OppLbl1
@onready var _deal_fan: HBoxContainer = %DealCardFan
@onready var _sfx: AudioStreamPlayer = $SfxPlayer
@onready var _sfx_bomb: AudioStreamPlayer = %SfxBombPlayer
@onready var _bgm: AudioStreamPlayer = %BgmPlayer
@onready var _bgm_slider: HSlider = %BgmVolumeSlider
@onready var _bgm_pct_label: Label = %BgmVolumeValue
@onready var _rob_row: VBoxContainer = %RobRow
@onready var _settlement_layer: CanvasLayer = $SettlementLayer
@onready var _settle_body: RichTextLabel = %SettleBody
@onready var _btn_settle_continue: Button = %BtnSettleContinue
@onready var _btn_settle_menu: Button = %BtnSettleMenu
@onready var _play_anim_root: Control = $PlayAnimLayer/PlayAnimRoot

var _deck: RefCounted
var _hands: Array = []
var _bottom: PackedInt32Array = PackedInt32Array()
var _bids: Array = [0, 0, 0]
var _landlord: int = 0
var _turn: int = 0
var _last: Dictionary = {}
var _last_player: int = -1
var _passes: int = 0
var _winner: int = -1
var _bidding_active: bool = false
## 已打出牌：各点力张数（ddz_rank 0…14）
var _seen_rank: Array = []
var _last_play_ids: Array = []
var _winner_logged: bool = false
var _scores: Array = [SCORE_START, SCORE_START, SCORE_START]
## 最终倍率 = _mult_base × _mult_rob × _mult_play（与 `_round_multiplier` 同步）
var _mult_base: int = 1
var _mult_rob: int = 1
var _mult_play: int = 1
var _rob_count: int = 0
var _play_bomb_count: int = 0
var _play_rocket_count: int = 0
var _round_multiplier: int = 1
## 本盘内第几局（一盘 = 进入主场景到回菜单；每局 = 发牌→打完→结算）
var _match_round_index: int = 0
var _settlement_shown: bool = false
var _in_rob_phase: bool = false
var _last_round_deltas: Array = [0, 0, 0]

var _card_buttons: Dictionary = {}
var _card_select_tweens: Dictionary = {}
## 人类出牌时从手牌按钮捕获的起点（全局坐标）；非人类为空则用手牌区/对手区估算
var _play_anim_starts_override: Array = []
var _play_anim_token: int = 0
## 桌面已落牌展示的「上一手」签名（动画播完写入）；pending 为正在飞的同一手，避免「过」触发的 _refresh_ui 重复播
var _play_area_display_signature: String = ""
var _play_area_pending_signature: String = ""
## 座位 p 当前扮演的猫咪 id（0…2）；仅在新一盘（进入本场景）时随机，局间不变
var _seat_cat: Array = [0, 1, 2]
var _sfx_play_stream: AudioStream
var _sfx_deal_stream: AudioStream


func _ready() -> void:
	_deck = Deck.new()
	_sfx_play_stream = load(SFX_PLAY_PATH) as AudioStream
	if _sfx_play_stream != null and _sfx_play_stream is AudioStreamMP3:
		(_sfx_play_stream as AudioStreamMP3).loop = false
	_sfx_deal_stream = load(SFX_DEAL_PATH) as AudioStream
	if _sfx_deal_stream != null and _sfx_deal_stream is AudioStreamMP3:
		(_sfx_deal_stream as AudioStreamMP3).loop = false
	if _bgm and _bgm.stream is AudioStreamMP3:
		(_bgm.stream as AudioStreamMP3).loop = true
	if _bgm:
		_apply_bgm_volume_percent(DEFAULT_BGM_VOLUME_PCT)
		if _bgm_slider:
			_bgm_slider.value = DEFAULT_BGM_VOLUME_PCT
		_update_bgm_pct_label()
		_bgm.play()
	if _bgm_slider:
		_bgm_slider.value_changed.connect(_on_bgm_volume_changed)
	if _sfx_bomb and SFX_BOMB:
		_sfx_bomb.stream = SFX_BOMB
	_btn_play.pressed.connect(_on_play_pressed)
	_btn_hint.pressed.connect(_on_hint_pressed)
	_btn_pass.pressed.connect(_on_pass_pressed)
	_btn_new.pressed.connect(_on_redeal_pressed)
	_btn_back_menu.pressed.connect(_on_back_to_menu_pressed)
	_btn_bid0.pressed.connect(func() -> void: human_bid_chosen.emit(0))
	_btn_bid1.pressed.connect(func() -> void: human_bid_chosen.emit(1))
	_btn_bid2.pressed.connect(func() -> void: human_bid_chosen.emit(2))
	_btn_bid3.pressed.connect(func() -> void: human_bid_chosen.emit(3))
	%BtnRobYes.pressed.connect(func() -> void: human_rob_chosen.emit(true))
	%BtnRobNo.pressed.connect(func() -> void: human_rob_chosen.emit(false))
	_shuffle_seat_cats()
	_apply_name_plates()
	await _play_deal_sequence()
	await _run_new_round()


func _log_line(bb: String) -> void:
	print("[Game] ", bb.replace("[b]", "").replace("[/b]", ""))
	if _game_log:
		_game_log.append_text(bb + "\n")
		await get_tree().process_frame
		var scroll := _game_log_scroll()
		if scroll:
			await get_tree().process_frame
			var sb := scroll.get_v_scroll_bar()
			if sb:
				scroll.scroll_vertical = int(sb.max_value)


func _shuffle_seat_cats() -> void:
	var perm: Array = [0, 1, 2]
	perm.shuffle()
	_seat_cat = perm


func _cat_name(seat_idx: int) -> String:
	return String(CAT_NAMES[int(_seat_cat[seat_idx])])


func _apply_name_plates() -> void:
	_label_p0.text = "%s · 你操作" % _cat_name(0)
	_label_p1.text = "%s · AI" % _cat_name(1)
	_label_p2.text = "%s · AI" % _cat_name(2)
	var avs: Array[TextureRect] = [_avatar_p0, _avatar_p1, _avatar_p2]
	for p in range(3):
		var cid: int = int(_seat_cat[p])
		var tex: Texture2D = load(String(CAT_AVATAR_PATHS[cid])) as Texture2D
		if tex:
			avs[p].texture = tex


func _sfx_play(stream: AudioStream) -> void:
	if _sfx and stream:
		_sfx.stream = stream
		_sfx.play()


func _apply_bgm_volume_percent(pct: float) -> void:
	if not _bgm:
		return
	var lin: float = clampf(pct / 100.0, 0.0, 1.0)
	if lin <= 0.0001:
		_bgm.volume_db = -80.0
	else:
		_bgm.volume_db = linear_to_db(lin)


func _update_bgm_pct_label() -> void:
	if _bgm_pct_label and _bgm_slider:
		_bgm_pct_label.text = "%d%%" % int(_bgm_slider.value)


func _on_bgm_volume_changed(_value: float) -> void:
	_apply_bgm_volume_percent(float(_bgm_slider.value))
	_update_bgm_pct_label()


func _sfx_play_bomb() -> void:
	if _sfx_bomb:
		_sfx_bomb.play()


func _play_deal_sequence() -> void:
	_deal_layer.show()
	_set_in_game_interactive(false)
	_sfx_play(_sfx_deal_stream)
	for c in _deal_fan.get_children():
		c.queue_free()
	var n_fan := 17
	for i in n_fan:
		var tex_rect := TextureRect.new()
		tex_rect.texture = load(CardDefs.texture_path_back(1 + (i % 5))) as Texture2D
		tex_rect.ignore_texture_size = true
		tex_rect.custom_minimum_size = Vector2(48, 69)
		tex_rect.expand_mode = TextureRect.EXPAND_FIT_WIDTH_PROPORTIONAL
		tex_rect.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		tex_rect.modulate.a = 0.0
		_deal_fan.add_child(tex_rect)
		var tw := create_tween()
		tw.tween_property(tex_rect, "modulate:a", 1.0, 0.07).set_delay(i * 0.032)
	await get_tree().create_timer(0.72).timeout
	await get_tree().create_timer(0.58).timeout
	_deal_layer.hide()
	_set_in_game_interactive(true)


func _set_in_game_interactive(on: bool) -> void:
	if _bidding_active:
		return
	_btn_play.disabled = not on
	_btn_hint.disabled = not on
	_btn_pass.disabled = not on
	_btn_new.disabled = not on


func _ddz_less(a: int, b: int) -> bool:
	return CardDefs.ddz_rank_value(a) < CardDefs.ddz_rank_value(b)


func _on_redeal_pressed() -> void:
	await _play_deal_sequence()
	await _run_new_round()


func _on_back_to_menu_pressed() -> void:
	get_tree().change_scene_to_file("res://scenes/start_menu.tscn")


func _run_new_round() -> void:
	_match_round_index += 1
	_apply_name_plates()
	_refresh_score_strip()
	_winner = -1
	_last.clear()
	_last_play_ids.clear()
	_last_player = -1
	_passes = 0
	_seen_rank.clear()
	for _i in range(15):
		_seen_rank.append(0)
	_game_log.clear()
	_winner_logged = false
	_settlement_shown = false
	_bidding_active = true
	if _title:
		_title.text = "斗地主 · 叫地主中…"
	_btn_new.disabled = true
	_btn_play.disabled = true
	_btn_hint.disabled = true
	_btn_pass.disabled = true
	if _match_round_index == 1:
		await _log_line("[color=#c8f0dd][b]新一盘 · 第 1 局[/b][/color]  [font_size=10][color=#7aaa96]（座位已随机，局间不换角）[/color][/font_size]")
	else:
		await _log_line("[color=#c8f0dd][b]第 %d 局[/b][/color]" % _match_round_index)
	var dealt: Array = _deck.deal_doudizhu()
	_hands = dealt[0]
	_bottom = dealt[1]
	for p in range(3):
		var h: PackedInt32Array = _hands[p]
		var arr: Array = []
		for i in h.size():
			arr.append(h[i])
		arr.sort_custom(_ddz_less)
		var nh: PackedInt32Array = PackedInt32Array()
		nh.resize(arr.size())
		for i in arr.size():
			nh[i] = arr[i]
		_hands[p] = nh
	_refresh_bottom_card_strip()
	_refresh_ui()
	await _run_bidding_phase()
	_apply_landlord_merge()
	# 桌面清空，首家出牌权交给地主（与叫倍阶段无关）
	_last.clear()
	_last_play_ids.clear()
	_passes = 0
	_last_player = -1
	_turn = _landlord
	_refresh_match_title()
	await _log_line("首家出牌：[b]%s[/b]（地主先出）" % _cat_name(_landlord))
	_after_state_changed()


func _sync_round_multiplier() -> void:
	_round_multiplier = _mult_base * _mult_rob * _mult_play


func _reset_multiplier_components() -> void:
	_mult_base = 1
	_mult_rob = 1
	_mult_play = 1
	_rob_count = 0
	_play_bomb_count = 0
	_play_rocket_count = 0
	_sync_round_multiplier()


func _bid_choice_label(b: int) -> String:
	match b:
		0:
			return "不叫"
		1:
			return "1倍"
		2:
			return "2倍"
		3:
			return "3倍"
	return str(b)


func _bottom_ids_array() -> Array:
	var a: Array = []
	for i in _bottom.size():
		a.append(_bottom[i])
	return a


func _refresh_bottom_card_strip() -> void:
	for c in _bottom_cards.get_children():
		c.queue_free()
	for i in _bottom.size():
		var tex_rect := TextureRect.new()
		tex_rect.texture = load(CardDefs.texture_path_for(_bottom[i])) as Texture2D
		tex_rect.ignore_texture_size = true
		tex_rect.custom_minimum_size = Vector2(52, 72)
		tex_rect.expand_mode = TextureRect.EXPAND_FIT_WIDTH_PROPORTIONAL
		tex_rect.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		_bottom_cards.add_child(tex_rect)


func _run_bidding_phase() -> void:
	_bids = [0, 0, 0]
	_reset_multiplier_components()
	_in_rob_phase = false
	await _log_line("[color=#b8e8d0][b]叫地主[/b][/color]  底牌 " + CardDefs.format_cards_list(_bottom_ids_array()))
	for i in range(3):
		await _log_line("%s 思考叫倍率中…" % _cat_name(i))
		var bid: int = 0
		if i == HUMAN_INDEX:
			_bidding_row.visible = true
			_set_bid_buttons_disabled(false)
			bid = await _human_bid_once()
			_bidding_row.visible = false
		else:
			await get_tree().create_timer(0.4).timeout
			bid = DdzAi.choose_bid(_hands[i], DdzAi.style_from_cat_id(int(_seat_cat[i])))
		_bids[i] = bid
		await _log_line("%s 选择：[b]%s[/b]" % [_cat_name(i), _bid_choice_label(bid)])
	var candidate: int = _resolve_call_candidate()
	var best_call: int = 0
	for j in range(3):
		if int(_bids[j]) > best_call:
			best_call = int(_bids[j])
	if _bids[0] == 0 and _bids[1] == 0 and _bids[2] == 0:
		_landlord = 0
		_mult_base = 1
		_sync_round_multiplier()
		await _log_line("三家均未叫倍，默认地主：[b]%s[/b] ｜ 基础倍率 [b]×1[/b]（无抢地主）" % _cat_name(_landlord))
	else:
		_mult_base = max(1, best_call)
		_sync_round_multiplier()
		await _log_line("[b]叫地主方[/b]（最高倍率，同倍取后叫）：%s ｜ 基础倍率 [b]×%d[/b]" % [_cat_name(candidate), _mult_base])
		await _run_rob_landlord_phase(candidate)
	_bidding_active = false
	_in_rob_phase = false
	_set_in_game_interactive(true)


func _resolve_call_candidate() -> int:
	var best: int = -1
	var best_i: int = 0
	for i in range(3):
		if _bids[i] >= best:
			best = _bids[i]
			best_i = i
	if best <= 0:
		return 0
	return best_i


func _run_rob_landlord_phase(candidate: int) -> void:
	_in_rob_phase = true
	if _status:
		_status.text = _build_status_text()
	_mult_rob = 1
	_rob_count = 0
	_sync_round_multiplier()
	var last_robber: int = -1
	await _log_line("[color=#e8d8b8][b]抢地主[/b][/color]  从下家起每人一次 · 抢则倍率 [b]×2[/b] · 不叫者不可抢")
	for step in range(3):
		var i: int = (candidate + 1 + step) % 3
		await _log_line("%s 抢地主选择…" % _cat_name(i))
		if int(_bids[i]) == 0:
			await _log_line("%s [b]不可抢[/b]（已不叫）" % _cat_name(i))
			continue
		var do_rob: bool = false
		if i == HUMAN_INDEX:
			_rob_row.visible = true
			do_rob = await _human_rob_once()
			_rob_row.visible = false
		else:
			await get_tree().create_timer(0.38).timeout
			var mult_before_rob: int = _mult_base * _mult_rob
			do_rob = DdzAi.choose_rob_landlord(_hands[i], mult_before_rob, DdzAi.style_from_cat_id(int(_seat_cat[i])))
		if do_rob:
			_mult_rob *= 2
			_rob_count += 1
			_sync_round_multiplier()
			last_robber = i
			await _log_line("%s [b]抢地主[/b]！当前总倍率：×%d（基础×%d × 抢×%d）" % [_cat_name(i), _round_multiplier, _mult_base, _mult_rob])
		else:
			await _log_line("%s 不抢" % _cat_name(i))
	if last_robber >= 0:
		_landlord = last_robber
	else:
		_landlord = candidate
	await _log_line("最终地主：[b]%s[/b] ｜ 当前总倍率：×%d（基础×%d × 抢×%d，出牌后炸弹/王炸再累乘）" % [_cat_name(_landlord), _round_multiplier, _mult_base, _mult_rob])


func _human_rob_once() -> bool:
	var v: Variant = await human_rob_chosen
	return bool(v)


func _human_bid_once() -> int:
	var score: Variant = await human_bid_chosen
	return int(score)


func _apply_landlord_merge() -> void:
	var landlord_hand: PackedInt32Array = _hands[_landlord]
	var merged: Array = []
	for i in landlord_hand.size():
		merged.append(landlord_hand[i])
	for i in _bottom.size():
		merged.append(_bottom[i])
	merged.sort_custom(_ddz_less)
	var nh: PackedInt32Array = PackedInt32Array()
	nh.resize(merged.size())
	for i in merged.size():
		nh[i] = merged[i]
	_hands[_landlord] = nh
	for c in _bottom_cards.get_children():
		c.queue_free()


func _set_bid_buttons_disabled(disabled: bool) -> void:
	_btn_bid0.disabled = disabled
	_btn_bid1.disabled = disabled
	_btn_bid2.disabled = disabled
	_btn_bid3.disabled = disabled


func _after_state_changed() -> void:
	_refresh_ui()
	if _winner >= 0:
		if not _settlement_shown:
			_settlement_shown = true
			call_deferred("_run_settlement_flow")
		return
	call_deferred("_tick_ai")


func _refresh_match_title() -> void:
	if _title:
		_title.text = "斗地主 · 地主：%s · 倍数×%d" % [_cat_name(_landlord), _round_multiplier]


func _refresh_score_strip() -> void:
	if _maocao_val0:
		_maocao_val0.text = str(int(_scores[0]))
	if _maocao_val1:
		_maocao_val1.text = str(int(_scores[1]))
	if _maocao_val2:
		_maocao_val2.text = str(int(_scores[2]))


func _any_score_broke() -> bool:
	for i in range(3):
		if int(_scores[i]) <= 0:
			return true
	return false


func _apply_round_scores() -> void:
	var m: int = _round_multiplier
	var w: int = _winner
	var L: int = _landlord
	for i in range(3):
		_last_round_deltas[i] = 0
	if w == L:
		_last_round_deltas[L] = BASE_L_WIN * m
		for i in range(3):
			if i != L:
				_last_round_deltas[i] = -BASE_F_WIN * m
	else:
		for i in range(3):
			if i != L:
				_last_round_deltas[i] = BASE_F_WIN * m
		_last_round_deltas[L] = -BASE_L_LOSE * m
	for i in range(3):
		_scores[i] = int(_scores[i]) + int(_last_round_deltas[i])
	_refresh_score_strip()


func _format_settlement_bbcode() -> String:
	var s: String = ""
	s += "[center][color=#7ec8a3][font_size=12]─── 倍率计算 ───[/font_size][/color][/center]\n\n"
	s += "[color=#a8e6cf]基础倍率（叫地主）[/color]   [font_size=15][b][color=#fff8e0]×%d[/color][/b][/font_size]\n" % _mult_base
	if _rob_count > 0:
		s += "[color=#a8e6cf]抢地主[/color]   [font_size=15][b][color=#fff8e0]×%d[/color][/b][/font_size]  [color=#88bba0]（%d 次抢，每次×2）[/color]\n" % [_mult_rob, _rob_count]
	else:
		s += "[color=#a8e6cf]抢地主[/color]   [font_size=15][b][color=#fff8e0]×1[/color][/b][/font_size]  [color=#88bba0]（未抢）[/color]\n"
	if _play_bomb_count == 0 and _play_rocket_count == 0:
		s += "[color=#a8e6cf]出牌加翻[/color]   [font_size=15][b][color=#fff8e0]×1[/color][/b][/font_size]  [color=#88bba0]（无炸弹/王炸）[/color]\n"
	else:
		var bomb_part: String = ""
		if _play_bomb_count > 0:
			bomb_part = "炸弹 %d 次（各×2）" % _play_bomb_count
		var rocket_part: String = ""
		if _play_rocket_count > 0:
			rocket_part = "王炸 %d 次（各×4）" % _play_rocket_count
		var detail: String = bomb_part
		if detail != "" and rocket_part != "":
			detail += "；"
		detail += rocket_part
		s += "[color=#a8e6cf]出牌加翻[/color]   [font_size=15][b][color=#fff8e0]×%d[/color][/b][/font_size]  [color=#88bba0]（%s）[/color]\n" % [_mult_play, detail]
	s += "\n[center][color=#6abf8f][font_size=12]──────────[/font_size][/color][/center]\n"
	s += "[center][font_size=16][b][color=#ffe8a0]最终倍率  ×%d[/color][/b][/font_size][/center]\n" % _round_multiplier
	s += "[center][color=#9bcbb0][font_size=12]%d × %d × %d[/font_size][/color][/center]\n\n" % [_mult_base, _mult_rob, _mult_play]
	if _winner == _landlord:
		s += "[center][font_size=15][b][color=#ffd966]地主胜 · %s[/color][/b][/font_size][/center]\n\n" % _cat_name(_winner)
	else:
		s += "[center][font_size=15][b][color=#8fd4ff]农民胜 · %s[/color][/b][/font_size][/center]\n\n" % _cat_name(_winner)
	for i in range(3):
		var d: int = int(_last_round_deltas[i])
		var dsign: String = "+" if d >= 0 else ""
		var col: String = "#b8f0c8" if d >= 0 else "#ffb8b8"
		s += "[color=#c8e8d8]%s[/color]  [color=%s][b]%s%d[/b][/color]  [color=#88bba0]→ 猫草[/color]  [b][color=#f5ffe8]%d[/color][/b]\n" % [_cat_name(i), col, dsign, d, int(_scores[i])]
	if _any_score_broke():
		s += "\n[center][color=#ffaa88]有玩家猫草≤0，整局游戏结束。[/color][/center]"
	return s


func _run_settlement_flow() -> void:
	_apply_round_scores()
	if _settle_body:
		_settle_body.text = _format_settlement_bbcode()
	_settlement_layer.show()
	_set_in_game_interactive(false)
	var broke := _any_score_broke()
	_btn_settle_continue.visible = not broke
	_btn_settle_menu.visible = broke
	if broke:
		await _btn_settle_menu.pressed
		_settlement_layer.hide()
		get_tree().change_scene_to_file("res://scenes/start_menu.tscn")
	else:
		await _btn_settle_continue.pressed
		_settlement_layer.hide()
		await _play_deal_sequence()
		await _run_new_round()


func _make_ai_ctx(me: int) -> Dictionary:
	var oa: int = _hands[(me + 1) % 3].size()
	var ob: int = _hands[(me + 2) % 3].size()
	var min_opp: int = oa if oa < ob else ob
	return {
		"me": me,
		"landlord": _landlord,
		"last_player": _last_player,
		"passes": _passes,
		"seen_rank": _seen_rank.duplicate(),
		"min_opp_cards": min_opp,
		"ai_style": DdzAi.style_from_cat_id(int(_seat_cat[me])),
	}


func _tick_ai() -> void:
	if _winner >= 0:
		return
	if _turn == HUMAN_INDEX:
		return
	if _bidding_active:
		return
	var who: int = _turn
	await _log_line("%s 思考出牌中…" % _cat_name(who))
	await get_tree().create_timer(_AI_THINK_SEC).timeout
	await get_tree().create_timer(_AI_EXTRA_PAUSE_SEC).timeout
	if _winner >= 0:
		return
	if _turn == HUMAN_INDEX:
		return
	var hand: PackedInt32Array = _hands[who]
	var ctx: Dictionary = _make_ai_ctx(who)
	if _last.is_empty():
		var lead: Array = DdzAi.find_free_lead(hand, ctx)
		var pat: Dictionary = Rules.classify(lead)
		await _log_play(who, lead, pat)
		_state_play(who, lead, pat)
		_after_state_changed()
		return
	var follow: Array = DdzAi.find_follow(hand, _last, ctx)
	if follow.is_empty():
		await _log_line("%s [b]过[/b]" % _cat_name(who))
		_state_pass(who)
	else:
		var pat2: Dictionary = Rules.classify(follow)
		await _log_play(who, follow, pat2)
		_state_play(who, follow, pat2)
	_after_state_changed()


func _log_play(who: int, card_ids: Array, pat: Dictionary) -> void:
	var who_name: String = _cat_name(who)
	var kn: String = _kind_name(pat)
	var cs: String = CardDefs.format_cards_list(card_ids)
	await _log_line("%s 出牌：[b]%s[/b] ｜ %s" % [who_name, kn, cs])


func _state_pass(who: int) -> void:
	_sfx_play(SFX_PASS)
	_passes += 1
	_turn = (who + 1) % 3
	if _passes >= 2:
		_last.clear()
		_last_play_ids.clear()
		_passes = 0
		_turn = _last_player


func _register_seen_cards(card_ids: Array) -> void:
	for id in card_ids:
		var r: int = CardDefs.ddz_rank_value(int(id))
		if r >= 0 and r < _seen_rank.size():
			_seen_rank[r] = int(_seen_rank[r]) + 1


func _state_play(who: int, card_ids: Array, pattern: Dictionary) -> void:
	if who == HUMAN_INDEX:
		_capture_human_play_starts(card_ids)
	else:
		_play_anim_starts_override.clear()
	_register_seen_cards(card_ids)
	_last_play_ids = card_ids.duplicate()
	_sfx_play(_sfx_play_stream)
	var pk: int = int(pattern.get("kind", Rules.Kind.INVALID))
	if pk == Rules.Kind.BOMB:
		_play_bomb_count += 1
		_mult_play *= 2
		_sync_round_multiplier()
		_sfx_play_bomb()
		_log_line_sync("炸弹！出牌倍率×%d ｜ 当前总倍率：×%d" % [_mult_play, _round_multiplier])
		_refresh_match_title()
	elif pk == Rules.Kind.ROCKET:
		_play_rocket_count += 1
		_mult_play *= 4
		_sync_round_multiplier()
		_log_line_sync("王炸！出牌倍率×%d ｜ 当前总倍率：×%d" % [_mult_play, _round_multiplier])
		_refresh_match_title()
	var hand: PackedInt32Array = _hands[who]
	var remove_set: Dictionary = {}
	for id in card_ids:
		remove_set[id] = true
	var newh: Array = []
	for i in hand.size():
		if not remove_set.has(hand[i]):
			newh.append(hand[i])
	var nh: PackedInt32Array = PackedInt32Array()
	nh.resize(newh.size())
	for i in newh.size():
		nh[i] = newh[i]
	_hands[who] = nh
	if nh.size() == 0:
		_winner = who
		_last = pattern.duplicate(true)
		_last_player = who
		_passes = 0
		return
	_last = pattern.duplicate(true)
	_last_player = who
	_passes = 0
	_turn = (who + 1) % 3


func _refresh_ui() -> void:
	if _winner >= 0:
		_refresh_match_title()
		_status.text = "[center][color=#ffd4a8]对局结束[/color]  ·  [color=#fffef0]胜者：%s[/color][/center]" % _cat_name(_winner)
		if not _winner_logged:
			_winner_logged = true
			_log_line_sync("[color=#ffd8b0]对局结束[/color] · 胜者 [b]%s[/b] · 等待结算" % _cat_name(_winner))
		_btn_play.disabled = true
		_btn_hint.disabled = true
		_btn_pass.disabled = true
		_btn_new.disabled = true
		_btn_back_menu.visible = true
	else:
		_status.text = _build_status_text()
		_btn_back_menu.visible = false
		if not _bidding_active:
			_refresh_match_title()
	for c in _hand_row.get_children():
		c.queue_free()
	_card_buttons.clear()
	_card_select_tweens.clear()
	var hand0: PackedInt32Array = _hands[HUMAN_INDEX]
	var n: int = hand0.size()
	if n > 0:
		var total_w: float = (n - 1) * _FAN_STEP + _CARD_W
		_hand_row.custom_minimum_size = Vector2(total_w, _HAND_BASE_Y + _CARD_H + 8.0)
	var idx := 0
	for id in hand0:
		var tb := TextureButton.new()
		tb.toggle_mode = true
		tb.ignore_texture_size = true
		tb.texture_normal = load(CardDefs.texture_path_for(id)) as Texture2D
		tb.custom_minimum_size = Vector2(_CARD_W, _CARD_H)
		tb.stretch_mode = TextureButton.STRETCH_KEEP_ASPECT_CENTERED
		tb.set_anchors_preset(Control.PRESET_TOP_LEFT)
		var x: float = idx * _FAN_STEP
		tb.position = Vector2(x, _HAND_BASE_Y)
		tb.size = Vector2(_CARD_W, _CARD_H)
		tb.z_index = idx
		tb.set_meta("fan_x", x)
		tb.set_meta("fan_base_y", _HAND_BASE_Y)
		tb.pivot_offset = Vector2(_CARD_W * 0.5, _CARD_H * 0.5)
		tb.toggled.connect(func(pressed: bool) -> void: _on_card_toggled(tb, pressed))
		tb.gui_input.connect(func(ev: InputEvent) -> void: _on_hand_card_gui_input(ev, tb))
		_hand_row.add_child(tb)
		_card_buttons[id] = tb
		idx += 1
	_update_play_buttons()
	_refresh_opponent_strips()
	_refresh_play_area()
	_refresh_landlord_badges()


func _refresh_landlord_badges() -> void:
	if _landlord_badges.size() != 3:
		return
	var show_badges: bool = not _bidding_active
	for p in range(3):
		_landlord_badges[p].visible = show_badges and p == _landlord


func _refresh_opponent_strips() -> void:
	for c in _opp_p2.get_children():
		c.queue_free()
	for c in _opp_p1.get_children():
		c.queue_free()
	var n2: int = int(_hands[2].size())
	var n1: int = int(_hands[1].size())
	_opp_lbl2.text = "%d张" % n2
	_opp_lbl1.text = "%d张" % n1
	var show2: int = mini(8, maxi(1, n2))
	var show1: int = mini(8, maxi(1, n1))
	for i in show2:
		var tr2 := TextureRect.new()
		tr2.texture = load(CardDefs.texture_path_back(1 + (i % 5))) as Texture2D
		tr2.ignore_texture_size = true
		tr2.custom_minimum_size = Vector2(38, 52)
		tr2.expand_mode = TextureRect.EXPAND_FIT_WIDTH_PROPORTIONAL
		tr2.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		_opp_p2.add_child(tr2)
	for i in show1:
		var tr1 := TextureRect.new()
		tr1.texture = load(CardDefs.texture_path_back(1 + (i % 5))) as Texture2D
		tr1.ignore_texture_size = true
		tr1.custom_minimum_size = Vector2(38, 52)
		tr1.expand_mode = TextureRect.EXPAND_FIT_WIDTH_PROPORTIONAL
		tr1.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		_opp_p1.add_child(tr1)


func _build_status_text() -> String:
	if _bidding_active:
		if _in_rob_phase:
			return "[center][color=#ffe9c2][font_size=14]抢地主阶段[/font_size][/color]\n[font_size=12][color=#e8f6ef]轮到你时，点「抢地主」或「不抢」[/color][/font_size]\n[font_size=11][color=#8fbcaa]未叫牌的玩家不可抢[/color][/font_size][/center]"
		return "[center][color=#c8f5e0][font_size=14]叫地主阶段[/font_size][/color]\n[font_size=12][color=#eefaf3]轮到你时，在下方选择本局基础倍率[/color][/font_size]\n[font_size=11][color=#9ec9b0]可选：不叫，或 1～3 倍[/color][/font_size][/center]"
	var name_turn: String = _cat_name(_turn)
	var parts: String = "[center][color=#a8dcc4]当前出牌[/color]  [color=#fffef0]%s[/color]" % name_turn
	if _last.is_empty():
		if _turn == HUMAN_INDEX:
			parts += "  ·  [color=#c8e8d8]桌面空 · 自由出牌（仅你操作手牌）[/color]"
		else:
			parts += "  ·  [color=#c8e8d8]桌面空 · 自由出牌[/color]"
	else:
		parts += "  ·  [color=#c8e8d8]上家牌型：%s[/color]" % _kind_name(_last)
	parts += "[/center]"
	return parts


func _kind_name(p: Dictionary) -> String:
	var k: int = p.get("kind", 0)
	match k:
		Rules.Kind.SINGLE:
			return "单张"
		Rules.Kind.PAIR:
			return "对子"
		Rules.Kind.TRIPLE:
			return "三张"
		Rules.Kind.STRAIGHT:
			return "顺子(%d张)" % int(p.get("extra", 0))
		Rules.Kind.BOMB:
			return "炸弹"
		Rules.Kind.ROCKET:
			return "王炸"
		Rules.Kind.TRIPLE_WITH_SINGLE:
			return "三带一"
		Rules.Kind.TRIPLE_WITH_PAIR:
			return "三带二"
		Rules.Kind.PAIR_STRAIGHT:
			return "连对(%d张)" % int(p.get("extra", 0))
		Rules.Kind.FOUR_WITH_TWO:
			var ex: int = int(p.get("extra", 0))
			return "四带二(%d张)" % ex
		Rules.Kind.PLANE:
			return "飞机(10张)"
		_:
			return "—"


func _selected_cards(override_tb: TextureButton = null, override_pressed: bool = false) -> Array:
	var out: Array = []
	for id in _card_buttons.keys():
		var b: BaseButton = _card_buttons[id]
		var on: bool = override_pressed if (override_tb != null and b == override_tb) else b.button_pressed
		if on:
			out.append(id)
	return out


func _on_hand_card_gui_input(ev: InputEvent, _tb: TextureButton) -> void:
	if ev is InputEventMouseButton and ev.pressed and ev.button_index == MOUSE_BUTTON_RIGHT:
		if _submit_human_play():
			get_viewport().set_input_as_handled()


func _tween_card_select_visual(tb: TextureButton, pressed: bool) -> void:
	var bx: float = float(tb.get_meta("fan_x"))
	var base_y: float = float(tb.get_meta("fan_base_y"))
	var lift := 0.0 if not pressed else -27.0
	var sc := 1.0 if not pressed else 1.07
	if _card_select_tweens.has(tb):
		var old: Variant = _card_select_tweens[tb]
		if old is Tween and is_instance_valid(old):
			(old as Tween).kill()
	var tw := create_tween()
	tw.set_parallel(true)
	tw.set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	tw.tween_property(tb, "position", Vector2(bx, base_y + lift), 0.14)
	tw.tween_property(tb, "scale", Vector2(sc, sc), 0.14)
	_card_select_tweens[tb] = tw
	tw.finished.connect(func() -> void: _card_select_tweens.erase(tb))


func _on_card_toggled(tb: TextureButton, pressed: bool) -> void:
	_tween_card_select_visual(tb, pressed)
	_update_play_buttons(tb, pressed)


func _is_valid_play_pattern(p: Dictionary) -> bool:
	return p.kind != Rules.Kind.INVALID and p.kind != Rules.Kind.PASS


func _update_play_buttons(override_tb: TextureButton = null, override_pressed: bool = false) -> void:
	var mine: bool = (_winner < 0 and _turn == HUMAN_INDEX and not _bidding_active)
	_btn_play.disabled = not mine
	_btn_hint.disabled = not mine
	var table_empty := _last.is_empty()
	_btn_pass.disabled = not mine or table_empty
	if not mine:
		return
	var sel: Array = _selected_cards(override_tb, override_pressed)
	var p: Dictionary = Rules.classify(sel)
	var can_play := false
	if _is_valid_play_pattern(p):
		if table_empty:
			can_play = true
		else:
			can_play = Rules.beats(_last, p)
	_btn_play.disabled = not can_play


## 与「出牌」按钮完全相同的判定与执行；成功则返回 true（供右键吞掉事件）。
func _submit_human_play() -> bool:
	if _turn != HUMAN_INDEX or _winner >= 0 or _bidding_active:
		return false
	var sel: Array = _selected_cards()
	var p: Dictionary = Rules.classify(sel)
	if not _is_valid_play_pattern(p):
		return false
	if _last.is_empty():
		pass
	else:
		if not Rules.beats(_last, p):
			return false
	_log_line_sync("你（%s）出牌：%s ｜ %s" % [_cat_name(HUMAN_INDEX), _kind_name(p), CardDefs.format_cards_list(sel)])
	_state_play(HUMAN_INDEX, sel, p)
	_after_state_changed()
	return true


func _on_play_pressed() -> void:
	_submit_human_play()


func _apply_ids_to_hand_selection(ids: Array) -> void:
	var want: Dictionary = {}
	for x in ids:
		want[int(x)] = true
	for id in _card_buttons.keys():
		var tb: TextureButton = _card_buttons[id]
		var on: bool = want.has(int(id))
		tb.set_pressed_no_signal(on)
		_tween_card_select_visual(tb, on)
	_update_play_buttons()


func _on_hint_pressed() -> void:
	if _turn != HUMAN_INDEX or _winner >= 0 or _bidding_active:
		return
	var hand: PackedInt32Array = _hands[HUMAN_INDEX]
	var ctx: Dictionary = _make_ai_ctx(HUMAN_INDEX)
	var rec: Array = []
	if _last.is_empty():
		rec = DdzAi.find_free_lead(hand, ctx)
	else:
		rec = DdzAi.find_follow(hand, _last, ctx)
	if rec.is_empty():
		if _last.is_empty():
			if _status:
				_status.text = "[center][color=#ffd8a0]提示：[/color][color=#fff5e6]暂无可出的推荐组合[/color][/center]"
		else:
			var lk: int = int(_last.get("kind", 0))
			if lk == Rules.Kind.ROCKET:
				if _status:
					_status.text = "[center][color=#ffd8a0]提示：[/color][color=#fff5e6]上家王炸，无法压过，请「过」[/color][/center]"
			elif DdzAi.is_farmer_yield_pass(ctx, _last):
				if _status:
					_status.text = "[center][color=#ffd8a0]提示：[/color][color=#fff5e6]AI 策略为让队友收尾，请「过」[/color][/center]"
			else:
				if _status:
					_status.text = "[center][color=#ffd8a0]提示：[/color][color=#fff5e6]没有能压过上家的牌，请「过」[/color][/center]"
		return
	_apply_ids_to_hand_selection(rec)
	if _status:
		_status.text = _build_status_text()


func _on_pass_pressed() -> void:
	if _turn != HUMAN_INDEX or _winner >= 0 or _bidding_active:
		return
	if _last.is_empty():
		return
	_log_line_sync("%s [b]过[/b]" % _cat_name(HUMAN_INDEX))
	_state_pass(HUMAN_INDEX)
	_after_state_changed()


func _game_log_scroll() -> ScrollContainer:
	var p: Node = _game_log.get_parent()
	if p is ScrollContainer:
		return p as ScrollContainer
	if p:
		var gp: Node = p.get_parent()
		if gp is ScrollContainer:
			return gp as ScrollContainer
	return null


func _log_line_sync(s: String) -> void:
	print("[Game] ", s)
	if _game_log:
		_game_log.append_text(s + "\n")
		var scroll := _game_log_scroll()
		if scroll:
			var sb := scroll.get_v_scroll_bar()
			if sb:
				scroll.scroll_vertical = int(sb.max_value)


func _capture_human_play_starts(ids: Array) -> void:
	_play_anim_starts_override.clear()
	for x in ids:
		var cid: int = int(x)
		if not _card_buttons.has(cid):
			_play_anim_starts_override.clear()
			return
		var tb: TextureButton = _card_buttons[cid]
		_play_anim_starts_override.append(tb.global_position)


func _play_anim_start_positions(who: int, n: int, cw: float, _ch: float) -> Array:
	if who == HUMAN_INDEX and _play_anim_starts_override.size() == n:
		return _play_anim_starts_override.duplicate()
	var sep: float = 8.0
	var r: Rect2
	match who:
		0:
			r = _hand_row.get_global_rect()
		1:
			r = _opp_p1.get_global_rect()
		2:
			r = _opp_p2.get_global_rect()
	if r.size.x < 2.0 or r.size.y < 2.0:
		r = Rect2(Vector2(80, 200), Vector2(540, 150))
	var total_w: float = float(n) * cw + float(max(0, n - 1)) * sep
	var x0: float = r.position.x + (r.size.x - total_w) * 0.5
	var y0: float = r.position.y + r.size.y * 0.28
	var out: Array = []
	for i in range(n):
		out.append(Vector2(x0 + float(i) * (cw + sep), y0))
	return out


## 与最终落牌一致：在真实 PlayCards HBox 内用同尺寸占位控件跑一次布局后取 global_position。
func _measure_play_row_end_positions(who: int, n: int, cw: float, ch: float) -> Array:
	var row: HBoxContainer = _play_cards_rows[who]
	while row.get_child_count() > 0:
		var x: Node = row.get_child(row.get_child_count() - 1)
		row.remove_child(x)
		x.free()
	var ph: Array[Control] = []
	for _i in n:
		var c := Control.new()
		c.custom_minimum_size = Vector2(cw, ch)
		c.mouse_filter = Control.MOUSE_FILTER_IGNORE
		row.add_child(c)
		ph.append(c)
	await get_tree().process_frame
	var out: Array = []
	for c in ph:
		out.append(c.global_position)
	for c in ph:
		row.remove_child(c)
		c.free()
	return out


## 占位测量失败时的后备（旧逻辑：按 PlayZone 估算，可能与实机略有偏差）。
func _play_anim_end_positions(who: int, n: int, cw: float, ch: float) -> Array:
	var sep: float = 8.0 if who == HUMAN_INDEX else 6.0
	var zone: Control = _play_cards_rows[who].get_parent() as Control
	var zr: Rect2 = zone.get_global_rect()
	if zr.size.x < 2.0 or zr.size.y < 2.0:
		zr = Rect2(Vector2(200, 180), Vector2(420, 144))
	var total_w: float = float(n) * cw + float(max(0, n - 1)) * sep
	var x0: float = zr.position.x + (zr.size.x - total_w) * 0.5
	var y0: float = zr.position.y + zr.size.y * 0.52 - ch * 0.5
	var out: Array = []
	for i in range(n):
		out.append(Vector2(x0 + float(i) * (cw + sep), y0))
	return out


func _play_area_signature() -> String:
	if _last.is_empty():
		return ""
	return _play_area_signature_from(_last_player, _last_play_ids)


func _play_area_signature_from(who: int, ids: Array) -> String:
	var bits: PackedInt32Array = PackedInt32Array()
	for x in ids:
		bits.append(int(x))
	bits.sort()
	var parts: Array[String] = []
	for i in bits.size():
		parts.append(str(int(bits[i])))
	return "%d:%s" % [who, ",".join(parts)]


func _populate_play_row_cards(who: int, ids: Array) -> void:
	var cw: float = _TABLE_CARD_W_CENTER
	var ch: float = _TABLE_CARD_H_CENTER
	var row: HBoxContainer = _play_cards_rows[who]
	for id in ids:
		var tex_rect := TextureRect.new()
		tex_rect.texture = load(CardDefs.texture_path_for(int(id))) as Texture2D
		tex_rect.ignore_texture_size = true
		tex_rect.custom_minimum_size = Vector2(cw, ch)
		tex_rect.expand_mode = TextureRect.EXPAND_FIT_WIDTH_PROPORTIONAL
		tex_rect.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		row.add_child(tex_rect)


func _refresh_play_area() -> void:
	if _last.is_empty():
		_play_area_display_signature = ""
		_play_area_pending_signature = ""
		_play_anim_token += 1
		for c in _play_anim_root.get_children():
			c.queue_free()
		for p in range(3):
			for c in _play_cards_rows[p].get_children():
				c.queue_free()
			_play_kind_labels[p].text = ""
		return
	var sig: String = _play_area_signature()
	if sig == _play_area_display_signature or sig == _play_area_pending_signature:
		return
	_play_area_pending_signature = sig
	_play_anim_token += 1
	var my_token: int = _play_anim_token
	for c in _play_anim_root.get_children():
		c.queue_free()
	for p in range(3):
		for c in _play_cards_rows[p].get_children():
			c.queue_free()
		_play_kind_labels[p].text = ""
	var who: int = _last_player
	if who < 0 or who > 2:
		return
	_play_kind_labels[who].text = "%s · %s" % [_kind_name(_last), _cat_name(who)]
	var ids_copy: Array = _last_play_ids.duplicate()
	call_deferred("_start_play_card_animation_async", who, ids_copy, my_token)


func _start_play_card_animation_async(who: int, ids: Array, token: int) -> void:
	if token != _play_anim_token:
		return
	await get_tree().process_frame
	if token != _play_anim_token:
		return
	var n: int = ids.size()
	if n == 0:
		return
	var cw: float = _TABLE_CARD_W_CENTER
	var ch: float = _TABLE_CARD_H_CENTER
	var starts: Array = _play_anim_start_positions(who, n, cw, ch)
	var ends: Array = await _measure_play_row_end_positions(who, n, cw, ch)
	if ends.size() != n:
		ends = _play_anim_end_positions(who, n, cw, ch)
	if starts.size() != n or ends.size() != n:
		_finish_play_card_animation(who, ids, token)
		return
	var tw := create_tween()
	tw.set_parallel(true)
	for i in range(n):
		var cid: int = int(ids[i])
		var tex_rect := TextureRect.new()
		tex_rect.texture = load(CardDefs.texture_path_for(cid)) as Texture2D
		tex_rect.ignore_texture_size = true
		tex_rect.custom_minimum_size = Vector2(cw, ch)
		tex_rect.size = Vector2(cw, ch)
		tex_rect.expand_mode = TextureRect.EXPAND_FIT_WIDTH_PROPORTIONAL
		tex_rect.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		tex_rect.top_level = true
		tex_rect.z_index = 100 + i
		tex_rect.pivot_offset = Vector2(cw * 0.5, ch * 0.5)
		_play_anim_root.add_child(tex_rect)
		tex_rect.global_position = starts[i]
		tex_rect.scale = Vector2(0.76, 0.76)
		tex_rect.modulate = Color(1, 1, 1, 0.9)
		var d: float = _PLAY_ANIM_STAGGER * float(i)
		tw.tween_property(tex_rect, "global_position", ends[i], _PLAY_ANIM_DURATION).set_delay(d).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
		tw.tween_property(tex_rect, "scale", Vector2.ONE, _PLAY_ANIM_DURATION).set_delay(d).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
		tw.tween_property(tex_rect, "modulate", Color(1, 1, 1, 1), _PLAY_ANIM_DURATION * 0.75).set_delay(d)
	await tw.finished
	if token != _play_anim_token:
		var sig_drop: String = _play_area_signature_from(who, ids)
		if sig_drop == _play_area_pending_signature:
			_play_area_pending_signature = ""
		return
	_finish_play_card_animation(who, ids, token)


func _finish_play_card_animation(who: int, ids: Array, token: int) -> void:
	if token != _play_anim_token:
		var sig_fail: String = _play_area_signature_from(who, ids)
		if sig_fail == _play_area_pending_signature:
			_play_area_pending_signature = ""
		return
	for c in _play_anim_root.get_children():
		c.queue_free()
	_play_anim_starts_override.clear()
	if _last.is_empty() or _last_player != who:
		_play_area_pending_signature = ""
		return
	if _last_play_ids.size() != ids.size():
		_play_area_pending_signature = ""
		return
	_populate_play_row_cards(who, ids)
	_play_area_display_signature = _play_area_signature()
	_play_area_pending_signature = ""
