extends Control
## 斗地主：摸牌 → 叫地主 → 出牌；日志；扩展牌型见 Rules。

const Rules = preload("res://scripts/ddz_rules.gd")
const DdzAi = preload("res://scripts/ddz_ai.gd")
const Deck = preload("res://scripts/deck.gd")
const PlayLineBuilderScr = preload("res://scripts/play_line_builder.gd")
const DdzNetSyncScr = preload("res://scripts/ddz_net_sync.gd")
const _MatchReplicaScript = preload("res://scripts/ddz_match_replica.gd")
const SFX_DEAL_PATH: String = "res://MusicAssets/shuffle-cards.mp3"
const SFX_PLAY_PATH: String = "res://MusicAssets/carddrop.mp3"
const SFX_BOMB_PATH: String = "res://MusicAssets/medium-explosion.mp3"
const SFX_ROCKET_PATH: String = "res://MusicAssets/launch.mp3"
const SFX_SETTLEMENT_PATH: String = "res://MusicAssets/level.mp3"
const SFX_PASS: AudioStream = preload("res://audio/sfx_pass.wav")
const DEFAULT_BGM_VOLUME_PCT: float = 60.0
const SEAT_SPEECH_BUBBLE_SCENE: PackedScene = preload("res://scenes/seat_speech_bubble.tscn")
const _SeatSpeechBubbleScr = preload("res://scripts/seat_speech_bubble.gd")

## 叫牌 / 抢地主阶段气泡（与按钮文案一致）
const BUBBLE_BID_NO := "不叫"
const BUBBLE_BID_CALL := "叫地主"
const BUBBLE_ROB_YES := "抢地主"
const BUBBLE_ROB_NO := "不抢"
const BUBBLE_ROB_BLOCKED := "没叫牌，不能抢"
const BUBBLE_BID_ROB_SEC := 2.8

signal human_bid_chosen(score: int)
signal human_rob_chosen(rob: bool)

## 猫咪身份：0=丑丑妹 1=咪宝 2=毛睿睿（与头像资源顺序一致）
const CAT_NAMES: Array[String] = ["丑丑妹", "咪宝", "毛睿睿"]
const CAT_AVATAR_PATHS: Array[String] = [
	"res://assets/avatars/cat_chou.png",
	"res://assets/avatars/cat_mibao.png",
	"res://assets/avatars/cat_maoruirui.png",
]
const SCORE_START: int = 3000
## 每局基础筹码单位 100；地主胜：地主 +100×倍率×2，农民各 -100×倍率；农民胜相反
const BASE_L_WIN: int = 200
const BASE_F_WIN: int = 100
const BASE_L_LOSE: int = 200
const HUMAN_INDEX: int = 0

const _CARD_W: float = 78.0
const _CARD_H: float = 108.0
const _FAN_STEP: float = 24.0
const _HAND_BASE_Y: float = 12.0
const _AI_THINK_SEC: float = 0.58
const _AI_EXTRA_PAUSE_SEC: float = 0.22
## 联网对局：玩家出牌思考时间（秒）；超时跟牌自动「过」，首家必出时自动出推荐首出。
const ONLINE_PLAY_TURN_SEC: float = 20.0
const _TABLE_CARD_W_CENTER: float = 54.0
const _TABLE_CARD_H_CENTER: float = 75.0
const _PLAY_ANIM_DURATION: float = 0.34
const _PLAY_ANIM_STAGGER: float = 0.045
## 联网/本机发牌轨迹动画：每张间隔（秒）
const _DEAL_TRACE_STEP_SEC: float = 0.038
## 发牌动画结束后、叫牌阶段开始前的停顿（秒）
const _POST_DEAL_TO_BID_PAUSE_SEC: float = 1.0

@onready var _title: Label = %Title
@onready var _status: RichTextLabel = %Status
@onready var _play_kind_labels: Array[Label] = [%PlayKindP0, %PlayKindP1, %PlayKindP2]
@onready var _play_cards_rows: Array[HBoxContainer] = [%PlayCardsP0, %PlayCardsP1, %PlayCardsP2]
@onready var _hand_row: Control = %HandRow
@onready var _btn_play: Button = %BtnPlay
@onready var _btn_hint: Button = %BtnHint
@onready var _btn_pass: Button = %BtnPass
@onready var _btn_settings_redeal: Button = %BtnSettingsRedeal
@onready var _btn_settings_to_menu: Button = %BtnSettingsToMenu
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
@onready var _bottom_cards_caption: Label = %BottomLabel
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
@onready var _user_info_panel: PanelContainer = %UserInfoPanel
@onready var _user_hud_username: Label = %UserHudUsername
@onready var _user_hud_display: Label = %UserHudDisplayName

var _deck: RefCounted
var _hands: Array = []
var _bottom: PackedInt32Array = PackedInt32Array()
## 本局洗牌种子（快照同步，客人可重放发牌轨迹）
var _last_deal_seed: int = -1
## 客人已播放过轨迹动画的种子，避免每条快照重复播
var _net_last_shown_deal_seed: int = -2
## 叫牌：-1 未轮到/未表态（抢地主仍可抢），0 不叫，1 叫地主（每局至多一人）
var _bids: Array = [-1, -1, -1]
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
var _sfx_bomb_stream: AudioStream
var _sfx_rocket_stream: AudioStream
var _sfx_settlement_stream: AudioStream
var _speech_layer: CanvasLayer
var _speech_bubbles: Array = []
var _dlg_confirm_redeal: ConfirmationDialog
var _dlg_confirm_menu: ConfirmationDialog
var _online_battle: bool = false
## 服务端权威斗地主（独立场景 online_match）；为 true 时不跑本地发牌/AI/房主快照/ENet。
var _server_authoritative: bool = false
var _srv_public_buf: Dictionary = {}
var _srv_last_seq: int = -1
## 已应用的公共快照 seq；私信若先到达须排队，等对应公共快照落地后再应用，否则 awaitSeat/叫牌 UI 仍读旧 _srv_public_buf。
var _srv_last_applied_public_seq: int = -1
var _srv_pending_private: Array[Dictionary] = []
var _srv_phase: String = ""
var _srv_cats_assigned: bool = false
## 服务端权威：结算阶段三人「继续」就绪（与快照 continueReady 对齐）
var _srv_continue_ready: Array = [false, false, false]
var _srv_settlement_base_bb: String = ""
## 服务端权威：结算包到达后先 2s + 赢家气泡，再显示结算层
var _srv_settlement_intro_running: bool = false
var _srv_pending_settlement: Dictionary = {}
var _srv_last_pub_phase: String = ""
var _srv_nicks_fetch_scheduled: bool = false
## 服务端权威：已播放过出牌/过牌音效与气泡的快照 seq（避免重复投递）
var _srv_feedback_applied_seq: int = -1
## 应用公共快照前保存，供 _refresh_ui 之后播反馈（便于本机出牌动画从手牌起点飞）
var _srv_fb_prev_passes: int = 0
var _srv_fb_prev_turn: int = 0
var _srv_fb_prev_last_player: int = -1
var _srv_fb_prev_last_ids: Array = []
## 服务端权威：已展示过发牌动效的 dealSeed（与快照 dealSeed 字符串对齐）
var _srv_last_deal_seed_for_anim: String = ""
## 服务端权威：已用于随机牌背的 dealSeed（新一局换 seed 时再随机背面）
var _srv_round_back_deal_seed: String = ""
## 服务端权威：牌局信息日志（与上一快照对比，避免重复）
var _srv_log_prev_phase: String = ""
var _srv_log_prev_bids: PackedInt32Array = PackedInt32Array([-1, -1, -1])
var _srv_log_prev_rob_count: int = -1
var _srv_logged_finish_seq: int = -1
## 服务端权威：抢地主动作序号（单调递增），用于播「抢/不抢」气泡
var _srv_prev_rob_action_seq: int = -1
## 服务端权威：上一快照的 awaitSeat（叫牌阶段用于「轮到谁」日志，避免重复）
var _srv_log_prev_await_seat: int = -2
## 单机：本局首家叫牌座位（仅本地局用于状态栏）
var _local_call_round_start_seat: int = -1
var _online_turn_epoch: int = 0
var _online_deadline_msec: int = 0
var _net_is_host: bool = false
## 联网：本机逻辑座位；进房后由 seat_by_uid 与快照/副本同步写入。
var _my_net_seat: int = 0
var _net_guest_booted: bool = false
var _net_guest_bid_ready: bool = false
var _net_guest_bid_value: int = 0
var _net_guest_rob_ready: bool = false
var _net_guest_rob_value: bool = false
## 房主侧：正在等待远端叫分/抢地主的座位（0～2）。
var _net_remote_await_seat: int = -1
## 并入快照，供客人显示叫分/抢地主等待 UI。
var _net_awaits: Dictionary = {}
## 快照单调序号（仅房主递增）；客人丢弃 seq ≤ 已应用值的乱序/重复包。
var _net_snap_seq: int = 0
var _net_last_applied_seq: int = -1
## 房主侧对局日志环形缓冲，随快照下发 log_tail。
const _NET_LOG_TAIL_MAX := 160
var _net_host_log_ring: Array[String] = []
## 房主结算界面：继续 / 回菜单 由本机按钮或客人 RPC 触发。
var _net_host_continue_gate: bool = false
var _net_host_menu_gate: bool = false
## 对端掉线 / 连接断开：只处理一次，避免重复弹窗与切场景。
var _net_peer_abort_done: bool = false
## 联网：房主随机后的 user_id → 逻辑座位 0/1/2（A/B/C）；客人仅从快照同步。
var _net_seat_by_uid: Dictionary = {}
## 联网：客人已向房主上报本机钱包（用于 2 真人+AI 时房主正确显示对方筹码）
var _net_guest_wallet_sent: bool = false
## 服务端权威：已用本机钱包初始化过 `_scores`（每局仅一次）
var _wallet_init_done_srv: bool = false
## 联网：AI 所在逻辑座位（2 真人+1AI）；三真人时为 -1。
var _net_ai_logical_seat: int = -1
## 联网 2+1：AI 扮演的猫咪 id（0～2）；三真人为 -1。
var _net_ai_cat_id: int = -1
## 联网：user_id → 桌上显示昵称（快照同步）。
var _net_nick_by_uid: Dictionary = {}
## Godot MultiplayerSynchronizer 复用的对局副本（仅房主写入）。
var _match_replica: Node
var _mp_synchronizer: MultiplayerSynchronizer
## ENet 远端 peer_id → Nakama user_id（房主侧 RPC 映射）。
var _net_peer_id_to_uid: Dictionary = {}


## Nakama user_id 在 RT / HTTP / JSON 间格式应一致；统一后再做字典键，避免客人端匹配不到座位与昵称。
func _net_norm_uid(uid: Variant) -> String:
	return str(uid).strip_edges().to_lower()


func _local_seat() -> int:
	if _online_battle:
		if _my_net_seat >= 0:
			return _my_net_seat
		return 0
	return HUMAN_INDEX


## 逻辑座位 → UI 方位（0=本机下方，1=右手侧，2=左手侧）；与 `_refresh_opponent_strips` 一致。
func _view_slot_for_logical(logical: int) -> int:
	return (logical - _local_seat() + 3) % 3


func _logical_seat_for_view_slot(view_slot: int) -> int:
	return (_local_seat() + view_slot) % 3


func _net_rt_sorted_user_ids() -> Array[String]:
	var hub: Node = get_node_or_null("/root/OnlineSession")
	if hub == null or not hub.has_method("get_rt_match_sorted_user_ids"):
		return []
	return hub.get_rt_match_sorted_user_ids()


func _net_online_human_count() -> int:
	## 以房主快照里的 seat_by_uid 为准（2+1 为 2）；勿仅用 RT presences，否则偶发 3+ 导致误判为三真人、AI 席消失。
	if _online_battle and not _net_seat_by_uid.is_empty():
		return _net_seat_by_uid.size()
	return _net_rt_sorted_user_ids().size()


## 2 真人+AI 时 AI 所在逻辑座位；若尚未写入则用 seat_by_uid 反推，再不行则退化为 seat2（旧约定）。
func _net_effective_ai_seat() -> int:
	if not _online_battle:
		return -1
	if _net_online_human_count() >= 3:
		return -1
	if _net_ai_logical_seat >= 0:
		return _net_ai_logical_seat
	if _net_seat_by_uid.size() == 2:
		var used: Dictionary = {}
		for v in _net_seat_by_uid.values():
			used[int(v)] = true
		for s in range(3):
			if not used.has(s):
				return s
	if _net_online_human_count() == 2:
		return 2
	return -1


## 联网：该逻辑座位是否为真人客户端（非 AI 席）。
func _net_is_human_controlled_seat(seat: int) -> bool:
	if not _online_battle:
		return true
	if _server_authoritative:
		for k in _net_seat_by_uid.keys():
			if int(_net_seat_by_uid[k]) == seat:
				return true
		return false
	if _net_online_human_count() >= 3:
		return true
	var ai_s: int = _net_effective_ai_seat()
	if ai_s < 0:
		return true
	return seat != ai_s


func _net_seat_for_user_id(uid: String) -> int:
	var u := _net_norm_uid(uid)
	if _net_seat_by_uid.has(u):
		return int(_net_seat_by_uid[u])
	return -1


func _net_uid_for_logical_seat(seat: int) -> String:
	for k in _net_seat_by_uid.keys():
		if int(_net_seat_by_uid[k]) == seat:
			return _net_norm_uid(k)
	return ""


func _net_display_name_for_logical_seat(logical: int) -> String:
	var ai_s: int = _net_effective_ai_seat()
	if _net_online_human_count() < 3 and ai_s >= 0 and logical == ai_s:
		var cid: int = clampi(_net_ai_cat_id, 0, CAT_NAMES.size() - 1)
		return String(CAT_NAMES[cid])
	var uid: String = _net_uid_for_logical_seat(logical)
	if not uid.is_empty() and _net_nick_by_uid.has(uid):
		return str(_net_nick_by_uid[uid])
	return "玩家"


func _net_ring_push_line(line: String) -> void:
	if not (_online_battle and _net_is_host):
		return
	_net_host_log_ring.append(line)
	while _net_host_log_ring.size() > _NET_LOG_TAIL_MAX:
		_net_host_log_ring.pop_front()


func _net_apply_log_tail_from_snapshot(lt: Variant) -> void:
	if lt == null or typeof(lt) != TYPE_ARRAY:
		return
	if not _game_log:
		return
	_game_log.clear()
	for ln in lt as Array:
		_game_log.append_text(str(ln) + "\n")
	_ensure_game_log_scroll_bottom()


func _net_apply_settlement_ui_from_snapshot(d: Dictionary) -> void:
	if bool(d.get("settlement_open", false)):
		var sbb: String = str(d.get("settle_body_bb", ""))
		if _settle_body:
			_settle_body.text = sbb
		_settlement_layer.show()
		_set_in_game_interactive(false)
		var broke := _any_score_broke()
		_btn_settle_continue.visible = not broke
		_btn_settle_menu.visible = broke
	else:
		_settlement_layer.hide()


func _on_settle_continue_any() -> void:
	if _server_authoritative:
		var hub: Node = get_node_or_null("/root/OnlineSession")
		if hub != null and hub.has_method("send_ddz_authoritative_async"):
			hub.send_ddz_authoritative_async(OnlineSession.DDZ_REQ_CONTINUE, {})
		if _btn_settle_continue:
			_btn_settle_continue.disabled = true
		return
	if _online_battle and not _net_is_host:
		var hub: Node = get_node_or_null("/root/OnlineSession")
		if hub != null and hub.has_method("send_client_action_async"):
			hub.send_client_action_async({"action": "settle_continue"})
		return
	_net_host_continue_gate = true


func _on_settle_menu_any() -> void:
	if _server_authoritative:
		await _return_to_start_menu_async()
		return
	if _online_battle and not _net_is_host:
		var hub: Node = get_node_or_null("/root/OnlineSession")
		if hub != null and hub.has_method("send_client_action_async"):
			hub.send_client_action_async({"action": "settle_menu"})
		return
	_net_host_menu_gate = true


func _exit_tree() -> void:
	if multiplayer.peer_connected.is_connected(_on_host_enet_peer_connected):
		multiplayer.peer_connected.disconnect(_on_host_enet_peer_connected)
	var hub: Node = get_node_or_null("/root/OnlineSession")
	if hub != null and hub.has_signal("match_client_action") and hub.match_client_action.is_connected(_on_net_client_action):
		hub.match_client_action.disconnect(_on_net_client_action)
	if hub != null and hub.has_signal("match_peer_left") and hub.match_peer_left.is_connected(_on_net_match_peer_left):
		hub.match_peer_left.disconnect(_on_net_match_peer_left)
	if hub != null and hub.has_signal("match_rt_disconnected") and hub.match_rt_disconnected.is_connected(_on_net_match_rt_disconnected):
		hub.match_rt_disconnected.disconnect(_on_net_match_rt_disconnected)
	if hub != null and hub.has_signal("match_ddz_server") and hub.match_ddz_server.is_connected(_on_srv_ddz_message):
		hub.match_ddz_server.disconnect(_on_srv_ddz_message)
	if hub != null and hub.has_signal("match_chat_received") and hub.match_chat_received.is_connected(_on_match_nakama_chat_received):
		hub.match_chat_received.disconnect(_on_match_nakama_chat_received)


func _on_chat_send_pressed() -> void:
	_submit_chat_line()


func _on_chat_input_submitted(_t: String) -> void:
	_submit_chat_line()


func _submit_chat_line() -> void:
	var inp := get_node_or_null("%ChatInput") as LineEdit
	if inp == null:
		return
	var t: String = inp.text.strip_edges()
	if t.is_empty():
		return
	inp.text = ""
	var hub: Node = get_node_or_null("/root/OnlineSession")
	if _server_authoritative and hub != null and hub.has_method("send_match_chat_async"):
		_submit_match_chat_async(t)


func _submit_match_chat_async(t: String) -> void:
	var hub: Node = get_node_or_null("/root/OnlineSession")
	if hub != null and hub.has_method("send_match_chat_async"):
		await hub.send_match_chat_async(t)


func _chat_escape_richtext(s: String) -> String:
	## RichTextLabel BBCode：用户昵称/正文中的 [ ] 需转义，否则易截断或误解析。
	return s.replace("[", "[lb]").replace("]", "[rb]")


func _on_match_nakama_chat_received(username: String, text: String, sender_id: String) -> void:
	var chat_log := get_node_or_null("%ChatLog") as RichTextLabel
	if chat_log == null:
		return
	var uid: String = _net_norm_uid(sender_id)
	var nick: String = username
	if not uid.is_empty() and _net_nick_by_uid.has(uid):
		nick = str(_net_nick_by_uid[uid])
	var line: String = "[color=#a8d4c8]%s[/color]: %s\n" % [_chat_escape_richtext(nick), _chat_escape_richtext(text)]
	chat_log.append_text(line)
	call_deferred("_scroll_chat_to_end")


func _scroll_chat_to_end() -> void:
	var chat_log := get_node_or_null("%ChatLog") as RichTextLabel
	if chat_log == null:
		return
	var p: Node = chat_log.get_parent()
	if p is ScrollContainer:
		var scroll: ScrollContainer = p as ScrollContainer
		var sb := scroll.get_v_scroll_bar()
		if sb:
			scroll.scroll_vertical = int(sb.max_value)


func _join_match_nakama_chat_async() -> void:
	var hub: Node = get_node_or_null("/root/OnlineSession")
	if hub == null or not hub.has_method("join_match_chat_async"):
		return
	var ok: bool = await hub.join_match_chat_async(hub.get_online_match_id())
	if not ok:
		push_warning("对局聊天频道加入失败（仍可游戏）")


func _on_srv_ddz_message(op_code: int, d: Dictionary) -> void:
	if not _server_authoritative:
		return
	match op_code:
		101:
			_srv_apply_snapshot_message(d)
		102:
			push_warning("DDZ 服务端拒绝: %s" % str(d.get("error", d)))
		120:
			_srv_apply_settlement_payload(d)


func _srv_apply_snapshot_message(d: Dictionary) -> void:
	## 私信：yourSeat + yourHand；公共服务快照必有 phase（buildPublicSnapshot）。仅 yourHand 为 Array 会误把异常包当私信，导致永远不走路公共快照 → 无手牌、无底牌。
	if (
		d.has("yourSeat")
		and typeof(d.get("yourHand", null)) == TYPE_ARRAY
		and not d.has("phase")
	):
		var ps: int = int(round(float(d.get("seq", -1))))
		## 已过时的私信（公共快照 seq 已更大）丢弃，避免覆盖较新局面下的手牌。
		if ps >= 0 and ps < _srv_last_applied_public_seq:
			return
		## 同一 broadcast 内服务端先发公共再发私信；若客户端先收到私信，须等公共落地再应用手牌。
		if ps >= 0 and ps > _srv_last_applied_public_seq:
			_srv_pending_private.append(d.duplicate(true))
			return
		_srv_apply_private_hand(d)
		return
	## 丢弃 seq 更小的公共快照（乱序旧包）；同 seq 重复投递则再应用一次（幂等）。
	var seq: int = int(round(float(d.get("seq", -1))))
	if seq >= 0 and seq < _srv_last_applied_public_seq:
		return
	if seq >= 0:
		_srv_last_seq = seq
		_srv_last_applied_public_seq = seq
	_srv_public_buf = d.duplicate()
	_srv_apply_public_state(d)
	_flush_srv_pending_private_for_seq(seq)
	_refresh_ui()
	_srv_emit_authoritative_turn_feedback(
		seq,
		_srv_fb_prev_passes,
		_srv_fb_prev_turn,
		_srv_fb_prev_last_player,
		_srv_fb_prev_last_ids
	)
	_srv_refresh_bid_rob_visibility()


func _flush_srv_pending_private_for_seq(public_seq: int) -> void:
	if public_seq < 0 or _srv_pending_private.is_empty():
		return
	## 仅 ps==public_seq 时 flush 会在「公共快照先到、私信后到且 seq 已前进」时永远配不上，导致无手牌、无叫牌 UI。
	var kept: Array[Dictionary] = []
	var to_apply: Array[Dictionary] = []
	for d in _srv_pending_private:
		var ps: int = int(round(float(d.get("seq", -1))))
		if ps >= 0 and ps <= public_seq:
			to_apply.append(d)
		else:
			kept.append(d)
	to_apply.sort_custom(func(a: Dictionary, b: Dictionary) -> bool:
		return int(round(float(a.get("seq", -1)))) < int(round(float(b.get("seq", -1))))
	)
	for d in to_apply:
		_srv_apply_private_hand(d)
	_srv_pending_private = kept


func _srv_apply_private_hand(d: Dictionary) -> void:
	var seat: int = int(d.get("yourSeat", -1))
	var arr: Array = d.get("yourHand", [])
	if seat < 0 or seat > 2:
		return
	var nh := PackedInt32Array()
	nh.resize(arr.size())
	for i in arr.size():
		nh[i] = int(arr[i])
	_hands[seat] = nh
	_my_net_seat = seat
	_refresh_ui()
	if _server_authoritative:
		_srv_refresh_bid_rob_visibility()
		## 公共快照往往先于私信到达：`_srv_apply_public_state` 里 deferred 的发牌动效会因本家手牌尚未 17 张而直接 return；
		## 私信落地后须再尝试一次（`_srv_try_play_deal_present` 内用 dealSeed / `_srv_last_deal_seed_for_anim` 防重复）。
		var ds: String = str(_srv_public_buf.get("dealSeed", ""))
		if _srv_phase == "bidding_call" and not ds.is_empty():
			call_deferred("_srv_try_play_deal_present", ds)


func _srv_apply_public_state(d: Dictionary) -> void:
	_srv_fb_prev_passes = _passes
	_srv_fb_prev_turn = _turn
	_srv_fb_prev_last_player = _last_player
	_srv_fb_prev_last_ids.clear()
	for x in _last_play_ids:
		_srv_fb_prev_last_ids.append(int(x))
	var sbu: Variant = d.get("seatByUserId", {})
	_net_seat_by_uid.clear()
	if typeof(sbu) == TYPE_DICTIONARY:
		for k in (sbu as Dictionary).keys():
			_net_seat_by_uid[_net_norm_uid(str(k))] = int((sbu as Dictionary)[k])
	_net_ai_logical_seat = -1
	var hubn: Node = get_node_or_null("/root/OnlineSession")
	var my_seat_known: bool = false
	if hubn != null and hubn.session != null:
		var uid: String = _net_norm_uid(hubn.session.user_id)
		if _net_seat_by_uid.has(uid):
			_my_net_seat = int(_net_seat_by_uid[uid])
			my_seat_known = true
	_srv_phase = str(d.get("phase", ""))
	match _srv_phase:
		"bidding_call":
			_bidding_active = true
			_in_rob_phase = false
		"bidding_rob":
			_bidding_active = false
			_in_rob_phase = true
		_:
			_bidding_active = false
			_in_rob_phase = false
	var ds_snap: String = str(d.get("dealSeed", ""))
	if _server_authoritative and _srv_phase == "bidding_call" and not ds_snap.is_empty() and ds_snap != _srv_round_back_deal_seed:
		CardDefs.pick_random_card_back_for_round()
		_srv_round_back_deal_seed = ds_snap
	var ba: Array = d.get("bids", [-1, -1, -1])
	for i in range(3):
		var bv: Variant = ba[i] if i < ba.size() else -1
		_bids[i] = int(round(float(bv)))
	_landlord = int(round(float(d.get("landlord", 0))))
	_turn = clampi(int(round(float(d.get("turn", 0)))), 0, 2)
	_passes = int(d.get("passes", 0))
	_last_player = int(d.get("lastPlayer", -1))
	_winner = int(d.get("winner", -1))
	var lp: Variant = d.get("lastPattern", null)
	if lp != null and typeof(lp) == TYPE_DICTIONARY:
		_last = DdzNetSyncScr.plain_to_pattern(lp as Dictionary)
	else:
		_last = {}
	_last_play_ids.clear()
	var lids: Array = d.get("lastPlayIds", [])
	for x in lids:
		_last_play_ids.append(int(x))
	_mult_base = int(d.get("multBase", 1))
	_mult_rob = int(d.get("multRob", 1))
	_mult_play = int(d.get("multPlay", 1))
	_rob_count = int(d.get("robCount", 0))
	_play_bomb_count = int(d.get("playBombCount", 0))
	_play_rocket_count = int(d.get("playRocketCount", 0))
	_round_multiplier = int(d.get("mult", _mult_base * _mult_rob * _mult_play))
	var hc: Array = d.get("handsCount", [0, 0, 0])
	while _hands.size() < 3:
		_hands.append(PackedInt32Array())
	for s in range(3):
		if my_seat_known and s == _my_net_seat:
			continue
		var cnt: int = clampi(int(round(float(hc[s] if s < hc.size() else 0))), 0, 54)
		var pha: PackedInt32Array = PackedInt32Array()
		pha.resize(maxi(0, cnt))
		for j in range(cnt):
			pha[j] = -1
		_hands[s] = pha
	## JSON 浮点或序列化误差时 int() 可能截成 2 → 只 round 再取整。叫牌/抢地主阶段底牌必为 3 张（合并进地主手牌后才为 0）。
	var ph_d: String = str(d.get("phase", ""))
	var bc: int = clampi(int(round(float(d.get("bottomCount", 0)))), 0, 3)
	if bc <= 0 and (ph_d == "bidding_call" or ph_d == "bidding_rob"):
		bc = 3
	_bottom = PackedInt32Array()
	if bc > 0:
		_bottom.resize(bc)
		for i in range(bc):
			_bottom[i] = -1
	if hubn != null and hubn.session != null:
		var self_id: String = _net_norm_uid(hubn.session.user_id)
		var nm: String = str(hubn.profile_display_name)
		if nm.is_empty():
			nm = str(hubn.profile_username)
		if nm.is_empty():
			nm = str(hubn.session.username)
		_net_nick_by_uid[self_id] = nm if not nm.is_empty() else "玩家"
	var cr: Variant = d.get("continueReady", null)
	if cr != null and typeof(cr) == TYPE_ARRAY:
		var cra: Array = cr as Array
		_srv_continue_ready = [false, false, false]
		for i in range(mini(3, cra.size())):
			_srv_continue_ready[i] = bool(cra[i])
	else:
		_srv_continue_ready = [false, false, false]
	var seat_cat_v: Variant = d.get("seatCat", null)
	if seat_cat_v != null and typeof(seat_cat_v) == TYPE_ARRAY and (seat_cat_v as Array).size() >= 3:
		var sca: Array = seat_cat_v as Array
		for ii in range(3):
			_seat_cat[ii] = clampi(int(sca[ii]), 0, 2)
		_srv_cats_assigned = true
	elif not _srv_cats_assigned and _net_seat_by_uid.size() >= 3 and not _server_authoritative:
		_shuffle_seat_cats()
		_srv_cats_assigned = true
	if _server_authoritative and _net_seat_by_uid.size() >= 3 and not _srv_nicks_fetch_scheduled:
		var need_nicks := false
		for k in _net_seat_by_uid.keys():
			if not _net_nick_by_uid.has(_net_norm_uid(str(k))):
				need_nicks = true
				break
		if need_nicks:
			_srv_nicks_fetch_scheduled = true
			call_deferred("_srv_deferred_fetch_nicks")
	if _server_authoritative and _srv_phase == "bidding_call" and _match_round_index < 1:
		_match_round_index = 1
	if _server_authoritative and _srv_last_pub_phase == "finished" and _srv_phase == "bidding_call":
		_match_round_index += 1
		## 新一局 dealSeed 与上一局不同，但须清空否则与 _srv_last_deal_seed_for_anim 比较会误判已播发牌动画
		_srv_last_deal_seed_for_anim = ""
	var _skip_bottom_refresh := false
	if _server_authoritative and _srv_phase == "play" and _srv_last_pub_phase != "play":
		var brv: Variant = d.get("bottomRevealIds", [])
		if brv != null and typeof(brv) == TYPE_ARRAY and (brv as Array).size() >= 3:
			_skip_bottom_refresh = true
			call_deferred("_srv_bottom_reveal_async", (brv as Array).duplicate())
	_srv_last_pub_phase = _srv_phase
	_apply_name_plates()
	if not _skip_bottom_refresh:
		_refresh_bottom_card_strip()
	if _server_authoritative and _srv_phase != "finished" and _settlement_layer and _settlement_layer.visible:
		_settlement_layer.hide()
		_settlement_shown = false
		_srv_settlement_base_bb = ""
		if _btn_settle_continue:
			_btn_settle_continue.disabled = false
		_set_in_game_interactive(true)
	_srv_refresh_settlement_continue_line()
	_srv_append_authoritative_game_log(d)
	_srv_emit_rob_bubble_if_needed(d)
	if _server_authoritative and not _wallet_init_done_srv and _my_net_seat >= 0:
		call_deferred("_srv_deferred_init_wallet_scores")
	call_deferred("_srv_try_play_deal_present", str(d.get("dealSeed", "")))


func _srv_deferred_init_wallet_scores() -> void:
	if not _server_authoritative or _wallet_init_done_srv:
		return
	if _my_net_seat < 0 or _my_net_seat > 2:
		return
	var hub: Node = get_node_or_null("/root/OnlineSession")
	if hub == null or not hub.has_method("sync_wallet_async"):
		return
	await hub.sync_wallet_async()
	for s in range(3):
		if not _net_is_human_controlled_seat(s):
			_scores[s] = 3000
		elif s == _my_net_seat:
			_scores[s] = int(hub.wallet_coins)
		else:
			_scores[s] = 3000
	_wallet_init_done_srv = true
	_refresh_score_strip()


func _host_init_online_scores_if_host() -> void:
	if not _online_battle or not _net_is_host or _server_authoritative:
		return
	var hub: Node = get_node_or_null("/root/OnlineSession")
	if hub == null or not hub.has_method("sync_wallet_async"):
		return
	await hub.sync_wallet_async()
	for s in range(3):
		if not _net_is_human_controlled_seat(s):
			_scores[s] = 3000
		elif s == _local_seat():
			_scores[s] = int(hub.wallet_coins)
		else:
			_scores[s] = 3000
	_refresh_score_strip()


func _persist_wallet_after_round_online_async() -> void:
	var hub: Node = get_node_or_null("/root/OnlineSession")
	if hub == null or not hub.has_method("apply_wallet_delta_async"):
		return
	if hub.offline_mode or not hub.is_logged_in():
		return
	if not _online_battle:
		return
	var delta: int = 0
	if _server_authoritative:
		var sd: Array = _srv_pending_settlement.get("scoreDelta", [])
		if sd.size() > _my_net_seat and _my_net_seat >= 0:
			delta = int(sd[_my_net_seat])
	else:
		delta = int(_last_round_deltas[_local_seat()])
	await hub.apply_wallet_delta_async(delta)


func _srv_try_play_deal_present(deal_seed_s: String) -> void:
	if not _server_authoritative:
		return
	if _srv_phase != "bidding_call":
		return
	if deal_seed_s.is_empty() or deal_seed_s == _srv_last_deal_seed_for_anim:
		return
	var all_17 := true
	for s in range(3):
		if int((_hands[s] as PackedInt32Array).size()) != 17:
			all_17 = false
			break
	if not all_17:
		return
	_srv_last_deal_seed_for_anim = deal_seed_s
	_bidding_row.visible = false
	_rob_row.visible = false
	var trace_raw: Variant = _srv_public_buf.get("dealTrace", [])
	var trace: Array = trace_raw if typeof(trace_raw) == TYPE_ARRAY else []
	if trace.size() == 51:
		await _play_deal_trace_anim_async(trace)
	else:
		push_warning("服务端未提供 dealTrace（或长度≠51），回退扇形发牌动画")
		await _play_deal_sequence()
	await get_tree().create_timer(_POST_DEAL_TO_BID_PAUSE_SEC).timeout
	if not is_inside_tree():
		return
	_refresh_ui()
	_srv_refresh_bid_rob_visibility()


func _srv_emit_rob_bubble_if_needed(d: Dictionary) -> void:
	if not _server_authoritative:
		return
	if str(d.get("phase", "")) != "bidding_rob":
		return
	var ras: int = int(round(float(d.get("robActionSeq", -1))))
	if ras <= _srv_prev_rob_action_seq:
		return
	var lrs: int = int(round(float(d.get("lastRobActionSeat", -1))))
	_srv_prev_rob_action_seq = ras
	if lrs < 0 or lrs > 2:
		return
	if bool(d.get("lastRobSkippedNoBid", false)):
		_seat_say(lrs, BUBBLE_ROB_BLOCKED, BUBBLE_BID_ROB_SEC)
		_log_line_sync("%s [b]%s[/b]（叫牌阶段未叫，跳过抢地主）" % [_cat_name(lrs), BUBBLE_ROB_BLOCKED])
	elif bool(d.get("lastRobActionWasRob", false)):
		_seat_say(lrs, BUBBLE_ROB_YES, BUBBLE_BID_ROB_SEC)
		_log_line_sync(
			"%s：[b]%s[/b] ｜ 抢倍 ×%d ｜ 当前总倍率 ×%d"
			% [_cat_name(lrs), BUBBLE_ROB_YES, int(round(float(d.get("multRob", 1)))), int(round(float(d.get("mult", 1))))]
		)
	else:
		_seat_say(lrs, BUBBLE_ROB_NO, BUBBLE_BID_ROB_SEC)
		_log_line_sync("%s %s" % [_cat_name(lrs), BUBBLE_ROB_NO])


func _srv_append_authoritative_game_log(d: Dictionary) -> void:
	if not _server_authoritative or _game_log == null:
		return
	var ph: String = str(d.get("phase", ""))
	var seq: int = int(round(float(d.get("seq", -1))))
	var prev_ph: String = _srv_log_prev_phase
	## 新一局进入叫牌：先复位叫牌 diff 基准（勿与上一局 bids 比较）
	if ph != prev_ph and ph == "bidding_call":
		_srv_log_prev_bids = PackedInt32Array([-1, -1, -1])
		_srv_log_prev_rob_count = -1
		_srv_log_prev_await_seat = -2
	## 先处理叫牌变化（含「叫地主」后 phase 已为 bidding_rob 的快照），再打印阶段切换文案
	if ph == "bidding_call" or ph == "bidding_rob":
		var ba2: Array = d.get("bids", [-1, -1, -1])
		for i in range(3):
			var nv: int = int(round(float(ba2[i] if i < ba2.size() else -1)))
			var ov: int = int(_srv_log_prev_bids[i]) if i < _srv_log_prev_bids.size() else -1
			if nv != ov and (nv >= 0 or ov >= 0):
				_log_line_sync("%s：[b]%s[/b]" % [_cat_name(i), _bid_choice_label(nv)])
				_seat_say(i, _bid_speech_line(nv), BUBBLE_BID_ROB_SEC)
		_srv_log_prev_bids.resize(3)
		for i in range(3):
			_srv_log_prev_bids[i] = int(round(float(ba2[i] if i < ba2.size() else -1)))
	if ph != prev_ph:
		if ph == "bidding_call" and prev_ph == "finished":
			_log_line_sync("[color=#c8f0dd][b]──────── 第 %d 局 · 叫地主 ────────[/b][/color]" % maxi(1, _match_round_index))
		elif ph == "bidding_call" and prev_ph.is_empty():
			_log_line_sync("[color=#c8f0dd][b]第 %d 局[/b][/color]  [font_size=10][color=#7aaa96]（联网 · 服务端权威）[/color][/font_size]" % maxi(1, _match_round_index))
		match ph:
			"bidding_call":
				var crs: int = int(round(float(d.get("callRoundStartSeat", -1))))
				var crs_txt: String = _cat_name(crs) if crs >= 0 and crs <= 2 else "?"
				_log_line_sync(
					"[color=#b8e8d0][b]叫地主阶段开始[/b][/color]  本局首家叫牌：[b]%s[/b]  ·  底牌 %d 张 · 有人叫即进入抢地主"
					% [crs_txt, int(round(float(d.get("bottomCount", 3))))]
				)
			"bidding_rob":
				_log_line_sync("[color=#e8d8b8][b]抢地主阶段[/b][/color] 抢则总倍率再×2 · 未叫牌者不可抢")
			"play":
				var ld0: int = int(round(float(d.get("landlord", 0))))
				var m0: int = int(round(float(d.get("mult", 1))))
				_log_line_sync("[color=#a8dcc4][b]出牌阶段[/b][/color] 地主 [b]%s[/b] 首家先出 ｜ 当前倍率 ×%d" % [_cat_name(ld0), m0])
			"finished":
				pass
		_srv_log_prev_phase = ph
	if ph == "bidding_call":
		var aws: int = int(round(float(d.get("awaitSeat", -1))))
		if aws >= 0 and aws <= 2 and aws != _srv_log_prev_await_seat:
			_log_line_sync("[color=#c8e8d8]轮到 [b]%s[/b] 决定：不叫 或 叫地主[/color]" % _cat_name(aws))
		_srv_log_prev_await_seat = aws
	if ph == "bidding_rob":
		var rc: int = int(d.get("robCount", 0))
		if _srv_log_prev_rob_count < 0:
			_srv_log_prev_rob_count = rc
		else:
			_srv_log_prev_rob_count = rc
	if ph == "finished" and seq > _srv_logged_finish_seq:
		var wn: int = int(d.get("winner", -1))
		if wn >= 0 and wn <= 2:
			_log_line_sync(
				"[color=#f5e6d3][b]结算阶段[/b][/color] 胜方：[b]%s[/b] ｜ 总倍率 ×%d"
				% [_cat_name(wn), int(round(float(d.get("mult", 1))))]
			)
		_srv_logged_finish_seq = seq


func _srv_emit_authoritative_turn_feedback(
	new_seq: int,
	prev_passes: int,
	prev_turn: int,
	prev_last_player: int,
	prev_last_ids: Array
) -> void:
	if not _server_authoritative or new_seq < 0:
		return
	if new_seq <= _srv_feedback_applied_seq:
		return
	if _srv_phase != "play" and _srv_phase != "finished":
		return
	## 过牌：第一手 pass 后 passes 递增；两家 pass 清空桌面时 passes 变为 0
	if _srv_phase == "play" and _passes > prev_passes:
		_seat_say(prev_turn, PlayLineBuilderScr.speech_line_pass())
		_sfx_play(SFX_PASS)
		_log_line_sync("%s [b]过[/b]" % _cat_name(prev_turn))
		_srv_feedback_applied_seq = new_seq
		return
	if (
		_srv_phase == "play"
		and prev_passes == 1
		and _passes == 0
		and _last.is_empty()
	):
		_seat_say(prev_turn, PlayLineBuilderScr.speech_line_pass())
		_sfx_play(SFX_PASS)
		_log_line_sync("%s [b]过[/b]" % _cat_name(prev_turn))
		_srv_feedback_applied_seq = new_seq
		return
	## 仅桌面出牌变化时播（避免只更新了 handsCount 等导致误判）
	var table_changed: bool = _last_player != prev_last_player
	if not table_changed:
		if _last_play_ids.size() != prev_last_ids.size():
			table_changed = true
		else:
			for i in range(_last_play_ids.size()):
				var cur_id: int = int(_last_play_ids[i])
				var prev_id: int = int(prev_last_ids[i]) if i < prev_last_ids.size() else -999
				if cur_id != prev_id:
					table_changed = true
					break
	if not table_changed:
		return
	var pk: int = int(_last.get("kind", Rules.Kind.INVALID)) if not _last.is_empty() else Rules.Kind.INVALID
	if _last_play_ids.is_empty() or pk == Rules.Kind.PASS or pk == Rules.Kind.INVALID:
		return
	var who: int = _last_player
	if who < 0 or who > 2:
		return
	var ids: Array = []
	for x in _last_play_ids:
		ids.append(int(x))
	_seat_say(who, PlayLineBuilderScr.speech_line_for_play(_last, ids))
	_log_line_sync(
		"%s 出牌：[b]%s[/b] ｜ %s" % [_cat_name(who), _kind_name(_last), CardDefs.format_cards_list(ids)]
	)
	if who == _local_seat():
		_capture_human_play_starts(ids)
	else:
		_play_anim_starts_override.clear()
	_register_seen_cards(ids)
	if pk == Rules.Kind.BOMB:
		_sfx_play(_sfx_play_stream)
		_sfx_play_bomb()
		_log_line_sync("炸弹！出牌倍率×%d ｜ 当前总倍率：×%d" % [_mult_play, _round_multiplier])
	elif pk == Rules.Kind.ROCKET:
		_sfx_play(_sfx_play_stream)
		_sfx_play_rocket()
		_log_line_sync("王炸！出牌倍率×%d ｜ 当前总倍率：×%d" % [_mult_play, _round_multiplier])
	else:
		_sfx_play(_sfx_play_stream)
	_srv_feedback_applied_seq = new_seq


func _srv_refresh_settlement_continue_line() -> void:
	if not _server_authoritative or _srv_phase != "finished" or not _settlement_shown or _settle_body == null:
		return
	var nready: int = 0
	for i in range(mini(3, _srv_continue_ready.size())):
		if _srv_continue_ready[i]:
			nready += 1
	var base_bb: String = _srv_settlement_base_bb if not _srv_settlement_base_bb.is_empty() else _settle_body.text
	_settle_body.text = base_bb + "\n\n[center][color=#a8dcc4]全员继续：%d/3[/color][/center]" % nready
	if _btn_settle_continue:
		var mys: int = _local_seat()
		var mine_ready: bool = mys >= 0 and mys < _srv_continue_ready.size() and _srv_continue_ready[mys]
		_btn_settle_continue.disabled = mine_ready


func _srv_deferred_fetch_nicks() -> void:
	_srv_nicks_fetch_scheduled = false
	if not _server_authoritative or _net_seat_by_uid.size() < 3:
		return
	await _net_host_refresh_nicks_async()
	_apply_name_plates()


func _srv_refresh_bid_rob_visibility() -> void:
	if not _server_authoritative:
		return
	var aws: int = int(round(float(_srv_public_buf.get("awaitSeat", -1))))
	match _srv_phase:
		"bidding_call":
			_bidding_row.visible = (aws == _local_seat())
			_set_bid_buttons_disabled(aws != _local_seat())
			_rob_row.visible = false
		"bidding_rob":
			_bidding_row.visible = false
			_rob_row.visible = (aws == _local_seat())
		_:
			_bidding_row.visible = false
			_rob_row.visible = false


func _srv_apply_settlement_payload(d: Dictionary) -> void:
	if _server_authoritative and _srv_settlement_intro_running:
		return
	var w: int = int(d.get("winner", -1))
	var L: int = int(d.get("landlord", -1))
	var sd: Array = d.get("scoreDelta", [])
	var txt: String = "[center]本局结束\n胜者座位：%d\n地主：%d\n倍率：×%s\n积分变化：%s[/center]" % [
		w, L, str(d.get("mult", "?")), str(sd)
	]
	_srv_settlement_base_bb = txt
	if _settle_body:
		_settle_body.text = txt
	if _server_authoritative:
		_srv_settlement_intro_running = true
		_srv_pending_settlement = d.duplicate(true)
		if _settlement_layer:
			_settlement_layer.visible = false
		_settlement_shown = false
		call_deferred("_srv_deferred_settlement_intro")
		return
	if _settlement_layer:
		_settlement_layer.visible = true
	_settlement_shown = true
	_srv_refresh_settlement_continue_line()


func _srv_deferred_settlement_intro() -> void:
	_srv_settlement_intro_async()


func _srv_settlement_intro_async() -> void:
	await get_tree().create_timer(2.0).timeout
	if not is_inside_tree() or not _server_authoritative:
		_srv_settlement_intro_running = false
		return
	var w: int = clampi(int(_srv_pending_settlement.get("winner", -1)), 0, 2)
	_seat_say(w, "我赢了！（%s）最棒！" % _cat_name(w), 3.2)
	await get_tree().create_timer(3.2).timeout
	if not is_inside_tree() or not _server_authoritative:
		_srv_settlement_intro_running = false
		return
	_apply_round_scores()
	await _persist_wallet_after_round_online_async()
	if _sfx_settlement_stream:
		_sfx_play(_sfx_settlement_stream)
	if _settle_body:
		_settle_body.text = _format_settlement_bbcode()
	if _settlement_layer:
		_settlement_layer.visible = true
	var broke := _any_score_broke()
	if _btn_settle_continue:
		_btn_settle_continue.visible = not broke
	if _btn_settle_menu:
		_btn_settle_menu.visible = broke
	_settlement_shown = true
	_srv_refresh_settlement_continue_line()
	_srv_settlement_intro_running = false
	_set_in_game_interactive(false)


func _setup_online_net_replication() -> void:
	if not _online_battle or _match_replica != null:
		return
	_mp_synchronizer = MultiplayerSynchronizer.new()
	_mp_synchronizer.name = "MatchMultiplayerSynchronizer"
	add_child(_mp_synchronizer)
	_mp_synchronizer.root_path = NodePath(".")
	_match_replica = _MatchReplicaScript.new()
	_match_replica.name = "MatchReplica"
	_mp_synchronizer.add_child(_match_replica)
	_match_replica.set_multiplayer_authority(1, true)
	var cfg := SceneReplicationConfig.new()
	var p_seq := NodePath("MatchReplica:sync_seq")
	cfg.add_property(p_seq)
	cfg.property_set_replication_mode(p_seq, SceneReplicationConfig.REPLICATION_MODE_ON_CHANGE)
	var p_json := NodePath("MatchReplica:state_json")
	cfg.add_property(p_json)
	cfg.property_set_replication_mode(p_json, SceneReplicationConfig.REPLICATION_MODE_ON_CHANGE)
	_mp_synchronizer.replication_config = cfg
	if _net_is_host and not multiplayer.peer_connected.is_connected(_on_host_enet_peer_connected):
		multiplayer.peer_connected.connect(_on_host_enet_peer_connected)


@rpc("any_peer", "call_remote", "reliable")
func host_register_uid(uid: String) -> void:
	if not _online_battle or not _net_is_host:
		return
	var pid: int = multiplayer.get_remote_sender_id()
	_net_peer_id_to_uid[pid] = _net_norm_uid(uid)


@rpc("any_peer", "call_remote", "reliable")
func host_register_starting_coins(coins: int) -> void:
	if not _online_battle or not _net_is_host or _server_authoritative:
		return
	var pid: int = multiplayer.get_remote_sender_id()
	var uid: String = str(_net_peer_id_to_uid.get(pid, ""))
	if uid.is_empty() or not _net_seat_by_uid.has(uid):
		return
	var s: int = int(_net_seat_by_uid[uid])
	_scores[s] = clampi(int(coins), 0, 999999999)
	_refresh_score_strip()
	call_deferred("_net_broadcast_snapshot_if_host")


@rpc("any_peer", "call_remote", "reliable")
func host_receive_client_action(payload: Dictionary) -> void:
	if not _online_battle or not _net_is_host:
		return
	var pid: int = multiplayer.get_remote_sender_id()
	var uid: String = str(_net_peer_id_to_uid.get(pid, ""))
	if uid.is_empty():
		return
	_on_net_client_action(payload, uid)


func client_forward_action_to_host(payload: Dictionary) -> void:
	if not _online_battle or _net_is_host:
		return
	if multiplayer.has_multiplayer_peer():
		rpc_id(1, "host_receive_client_action", payload)


func _on_host_enet_peer_connected(_id: int) -> void:
	if not _online_battle or not _net_is_host:
		return
	call_deferred("_net_broadcast_snapshot_if_host")


func _host_wait_enet_guests_ready_async() -> void:
	if not _online_battle or not _net_is_host:
		return
	if not multiplayer.has_multiplayer_peer():
		return
	var want: int = maxi(0, _net_rt_sorted_user_ids().size() - 1)
	if want <= 0:
		return
	var deadline_msec: int = Time.get_ticks_msec() + 30000
	while multiplayer.get_peers().size() < want:
		if Time.get_ticks_msec() >= deadline_msec:
			push_warning("房主：等待 ENet 客人连接超时，对局状态可能未同步（请客人后进主场景或检查端口）。")
			break
		await get_tree().process_frame


@rpc("any_peer", "call_remote", "reliable")
func rpc_client_receive_match_state(d: Dictionary) -> void:
	if not _online_battle or _net_is_host:
		return
	_net_guest_apply_full_state_dict(d)


func _setup_user_hud() -> void:
	var hub: Node = get_node_or_null("/root/OnlineSession")
	if hub == null or not hub.is_logged_in() or hub.offline_mode:
		_user_info_panel.visible = false
		return
	_user_info_panel.visible = true
	await hub.refresh_profile_async()
	var uname: String = hub.profile_username
	var dname: String = hub.profile_display_name
	_user_hud_username.text = "用户名：%s" % (uname if not uname.is_empty() else "—")
	_user_hud_display.text = "显示名称：%s" % (dname if not dname.is_empty() else "—")


func _ready() -> void:
	var hub0: Node = get_node_or_null("/root/OnlineSession")
	_online_battle = hub0 != null and hub0.has_method("is_in_online_match") and hub0.is_in_online_match()
	if _server_authoritative:
		_online_battle = true
	_deck = Deck.new()
	_sfx_play_stream = load(SFX_PLAY_PATH) as AudioStream
	if _sfx_play_stream != null and _sfx_play_stream is AudioStreamMP3:
		(_sfx_play_stream as AudioStreamMP3).loop = false
	_sfx_deal_stream = load(SFX_DEAL_PATH) as AudioStream
	if _sfx_deal_stream != null and _sfx_deal_stream is AudioStreamMP3:
		(_sfx_deal_stream as AudioStreamMP3).loop = false
	_sfx_bomb_stream = load(SFX_BOMB_PATH) as AudioStream
	if _sfx_bomb_stream != null and _sfx_bomb_stream is AudioStreamMP3:
		(_sfx_bomb_stream as AudioStreamMP3).loop = false
	_sfx_rocket_stream = load(SFX_ROCKET_PATH) as AudioStream
	if _sfx_rocket_stream != null and _sfx_rocket_stream is AudioStreamMP3:
		(_sfx_rocket_stream as AudioStreamMP3).loop = false
	_sfx_settlement_stream = load(SFX_SETTLEMENT_PATH) as AudioStream
	if _sfx_settlement_stream != null and _sfx_settlement_stream is AudioStreamMP3:
		(_sfx_settlement_stream as AudioStreamMP3).loop = false
	if _bgm and _bgm.stream is AudioStreamMP3:
		(_bgm.stream as AudioStreamMP3).loop = true
	if _bgm:
		var init_bgm_pct: float = 0.0 if _online_battle else DEFAULT_BGM_VOLUME_PCT
		_apply_bgm_volume_percent(init_bgm_pct)
		if _bgm_slider:
			_bgm_slider.value = init_bgm_pct
		_update_bgm_pct_label()
		_bgm.play()
	await _setup_user_hud()
	if _server_authoritative:
		_net_is_host = false
		_net_guest_booted = true
		_my_net_seat = 0
		if hub0 != null and hub0.has_signal("match_ddz_server"):
			hub0.match_ddz_server.connect(_on_srv_ddz_message)
			## 大厅等待期间已下发的快照会进 OnlineSession 缓冲，此处重放以免无手牌。
			if hub0.has_method("replay_rt_ddz_buffer"):
				_srv_last_seq = -1
				_srv_last_applied_public_seq = -1
				_srv_feedback_applied_seq = -1
				_srv_log_prev_phase = ""
				_srv_log_prev_rob_count = -1
				_srv_logged_finish_seq = -1
				_srv_prev_rob_action_seq = -1
				_srv_log_prev_bids = PackedInt32Array([-1, -1, -1])
				_srv_log_prev_await_seat = -2
				_srv_last_deal_seed_for_anim = ""
				_srv_round_back_deal_seed = ""
				_srv_pending_private.clear()
				hub0.replay_rt_ddz_buffer()
		add_to_group("ddz_game_main")
		if _title:
			_title.text = "斗地主 · 联网（服务端权威）"
		if _status:
			_status.text = "[center][color=#c8e8d8]等待服务器同步…[/color][/center]"
		var chat_dock := get_node_or_null("ChatDock")
		if chat_dock:
			chat_dock.visible = true
		var btn_chat := get_node_or_null("%BtnChatSend") as Button
		var chat_inp := get_node_or_null("%ChatInput") as LineEdit
		if btn_chat and not btn_chat.pressed.is_connected(_on_chat_send_pressed):
			btn_chat.pressed.connect(_on_chat_send_pressed)
		if chat_inp and not chat_inp.text_submitted.is_connected(_on_chat_input_submitted):
			chat_inp.text_submitted.connect(_on_chat_input_submitted)
		if hub0 != null and hub0.has_signal("match_chat_received"):
			hub0.match_chat_received.connect(_on_match_nakama_chat_received)
		call_deferred("_join_match_nakama_chat_async")
	elif _online_battle and hub0.has_method("get_online_match_id"):
		print("[Game] 联网对局 match_id=%s" % hub0.get_online_match_id())
	if not _server_authoritative and _online_battle and hub0.has_method("is_rt_match_host"):
		_net_is_host = hub0.is_rt_match_host()
		if not _net_is_host:
			_my_net_seat = -1
		print("[Game] 联网房主（权威）: %s ｜本机座位=%d ｜真人=%d" % ["本地" if _net_is_host else "对端", _my_net_seat, _net_online_human_count()])
	if not _server_authoritative and _online_battle and hub0.has_method("ensure_match_enet_multiplayer_async"):
		var enet_ok: bool = await hub0.ensure_match_enet_multiplayer_async()
		if not enet_ok:
			push_warning("联网：ENet 未就绪，状态无法同步（本机双开请先启动房主端主场景，再启动客人端）。")
		else:
			_setup_online_net_replication()
			add_to_group("ddz_game_main")
			if not _net_is_host and hub0.session != null:
				rpc_id(1, "host_register_uid", str(hub0.session.user_id))
				await get_tree().create_timer(0.06).timeout
	if _online_battle and hub0 != null and hub0.has_signal("match_peer_left"):
		hub0.match_peer_left.connect(_on_net_match_peer_left)
	if _online_battle and hub0 != null and hub0.has_signal("match_rt_disconnected"):
		hub0.match_rt_disconnected.connect(_on_net_match_rt_disconnected)
	set_process(_online_battle)
	if _bgm_slider:
		_bgm_slider.value_changed.connect(_on_bgm_volume_changed)
	if _sfx_bomb and _sfx_bomb_stream:
		_sfx_bomb.stream = _sfx_bomb_stream
	_btn_play.pressed.connect(_on_play_pressed)
	_btn_hint.pressed.connect(_on_hint_pressed)
	_btn_pass.pressed.connect(_on_pass_pressed)
	_btn_settle_continue.pressed.connect(_on_settle_continue_any)
	_btn_settle_menu.pressed.connect(_on_settle_menu_any)
	_dlg_confirm_redeal = ConfirmationDialog.new()
	_dlg_confirm_redeal.title = "重新发牌"
	_dlg_confirm_redeal.dialog_text = "是否终止当前游戏并重新发牌？"
	_dlg_confirm_redeal.ok_button_text = "确定"
	_dlg_confirm_redeal.cancel_button_text = "取消"
	add_child(_dlg_confirm_redeal)
	_dlg_confirm_redeal.confirmed.connect(_on_redeal_confirmed)
	call_deferred("_apply_styled_confirmation_dialog", _dlg_confirm_redeal)
	_dlg_confirm_menu = ConfirmationDialog.new()
	_dlg_confirm_menu.title = "返回开始界面"
	_dlg_confirm_menu.dialog_text = "是否返回开始界面？当前对局将结束。"
	_dlg_confirm_menu.ok_button_text = "确定"
	_dlg_confirm_menu.cancel_button_text = "取消"
	add_child(_dlg_confirm_menu)
	_dlg_confirm_menu.confirmed.connect(_on_to_menu_confirmed)
	call_deferred("_apply_styled_confirmation_dialog", _dlg_confirm_menu)
	if _should_return_to_lobby():
		_dlg_confirm_menu.title = "返回大厅"
		_dlg_confirm_menu.dialog_text = "是否返回联机大厅？当前对局将结束。"
	if is_instance_valid(_btn_settings_to_menu) and _should_return_to_lobby():
		_btn_settings_to_menu.text = "返回大厅"
	if is_instance_valid(_btn_settle_menu) and _should_return_to_lobby():
		_btn_settle_menu.text = "返回大厅"
	if _server_authoritative and is_instance_valid(_btn_settings_redeal):
		_btn_settings_redeal.queue_free()
	if is_instance_valid(_btn_settings_redeal):
		_btn_settings_redeal.pressed.connect(_on_settings_redeal_pressed)
	_btn_settings_to_menu.pressed.connect(_on_settings_to_menu_pressed)
	_btn_bid0.text = "不叫"
	_btn_bid3.text = "叫地主"
	_btn_bid1.visible = false
	_btn_bid2.visible = false
	_btn_bid0.pressed.connect(func() -> void: _on_bid_choice_pressed(0))
	_btn_bid3.pressed.connect(func() -> void: _on_bid_choice_pressed(1))
	%BtnRobYes.pressed.connect(func() -> void: _on_rob_choice_pressed(true))
	%BtnRobNo.pressed.connect(func() -> void: _on_rob_choice_pressed(false))
	if not _online_battle:
		_shuffle_seat_cats()
	if not _online_battle or _net_is_host:
		_apply_name_plates()
	_setup_seat_speech()
	if _server_authoritative:
		pass
	elif _online_battle and not _net_is_host:
		if _deal_layer:
			_deal_layer.hide()
		if _status:
			_status.text = "[center][color=#c8e8d8]已匹配，正在等待房主同步…[/color][/center]"
		while not _net_guest_booted:
			await get_tree().process_frame
	if not _server_authoritative and not (_online_battle and not _net_is_host):
		await _run_new_round()


## 套用与结算区一致的墨绿牌桌风格（部分引擎版本上若仍走系统原生弹窗，主题可能不完全生效）。
func _apply_styled_confirmation_dialog(dlg: ConfirmationDialog) -> void:
	dlg.unresizable = true
	dlg.min_size = Vector2(300, 148)
	dlg.dialog_autowrap = true
	var panel: StyleBoxFlat = StyleBoxFlat.new()
	panel.bg_color = Color(0.07, 0.14, 0.11, 0.96)
	panel.border_color = Color(0.42, 0.72, 0.52, 0.85)
	panel.set_border_width_all(2)
	panel.set_corner_radius_all(14)
	panel.content_margin_left = 20.0
	panel.content_margin_top = 14.0
	panel.content_margin_right = 20.0
	panel.content_margin_bottom = 16.0
	panel.shadow_color = Color(0, 0, 0, 0.42)
	panel.shadow_size = 10
	panel.shadow_offset = Vector2(0, 4)
	dlg.add_theme_stylebox_override("panel", panel)
	dlg.add_theme_color_override("title_color", Color(0.98, 0.94, 0.78, 1))
	dlg.add_theme_font_size_override("title_font_size", 17)
	var body: Label = dlg.get_label()
	if body:
		body.add_theme_font_size_override("font_size", 14)
		body.add_theme_color_override("font_color", Color(0.88, 0.96, 0.9, 1))
		body.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		body.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	var ok: Button = dlg.get_ok_button()
	var cancel: Button = dlg.get_cancel_button()
	if cancel:
		_apply_confirm_dialog_button_style(cancel, false)
	if ok:
		_apply_confirm_dialog_button_style(ok, true)


func _should_return_to_lobby() -> bool:
	if _server_authoritative:
		return true
	var hub: Node = get_node_or_null("/root/OnlineSession")
	return _online_battle and hub != null and hub.has_method("is_logged_in") and hub.is_logged_in()


func _apply_styled_accept_dialog(dlg: AcceptDialog) -> void:
	dlg.unresizable = true
	dlg.min_size = Vector2(320, 168)
	dlg.dialog_autowrap = true
	var panel: StyleBoxFlat = StyleBoxFlat.new()
	panel.bg_color = Color(0.07, 0.14, 0.11, 0.96)
	panel.border_color = Color(0.42, 0.72, 0.52, 0.85)
	panel.set_border_width_all(2)
	panel.set_corner_radius_all(14)
	panel.content_margin_left = 22.0
	panel.content_margin_top = 16.0
	panel.content_margin_right = 22.0
	panel.content_margin_bottom = 18.0
	panel.shadow_color = Color(0, 0, 0, 0.45)
	panel.shadow_size = 12
	panel.shadow_offset = Vector2(0, 4)
	dlg.add_theme_stylebox_override("panel", panel)
	dlg.add_theme_color_override("title_color", Color(0.98, 0.94, 0.78, 1))
	dlg.add_theme_font_size_override("title_font_size", 18)
	var body: Label = dlg.get_label()
	if body:
		body.add_theme_font_size_override("font_size", 14)
		body.add_theme_color_override("font_color", Color(0.88, 0.96, 0.9, 1))
		body.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		body.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	var ok: Button = dlg.get_ok_button()
	if ok:
		_apply_confirm_dialog_button_style(ok, true)


func _apply_confirm_dialog_button_style(btn: Button, primary: bool) -> void:
	var n := StyleBoxFlat.new()
	n.bg_color = Color(0.2, 0.44, 0.3, 0.96) if not primary else Color(0.26, 0.52, 0.35, 0.98)
	n.border_color = Color(0.48, 0.78, 0.55, 0.75)
	n.set_border_width_all(1)
	n.set_corner_radius_all(9)
	n.content_margin_left = 18.0
	n.content_margin_top = 7.0
	n.content_margin_right = 18.0
	n.content_margin_bottom = 7.0
	var h := n.duplicate() as StyleBoxFlat
	h.bg_color = Color(0.26, 0.5, 0.34, 1.0) if not primary else Color(0.3, 0.58, 0.4, 1.0)
	var p := n.duplicate() as StyleBoxFlat
	p.bg_color = Color(0.16, 0.36, 0.24, 1.0) if not primary else Color(0.2, 0.44, 0.3, 1.0)
	btn.add_theme_stylebox_override("normal", n)
	btn.add_theme_stylebox_override("hover", h)
	btn.add_theme_stylebox_override("pressed", p)
	btn.add_theme_stylebox_override("focus", n)
	btn.add_theme_font_size_override("font_size", 14)
	btn.add_theme_color_override("font_color", Color(0.96, 0.98, 0.94))
	btn.add_theme_color_override("font_hover_color", Color(1, 1, 1))
	btn.custom_minimum_size = Vector2(100, 32)


func _log_line(bb: String) -> void:
	print("[Game] ", bb.replace("[b]", "").replace("[/b]", ""))
	if _online_battle and _net_is_host:
		_net_ring_push_line(bb)
	if _game_log:
		_game_log.append_text(bb + "\n")
		await _ensure_game_log_scroll_bottom()


func _shuffle_seat_cats() -> void:
	var perm: Array = [0, 1, 2]
	perm.shuffle()
	_seat_cat = perm


## 联网房主：随机座位 0/1/2；2+1 时随机选一只猫作为 AI 牌手；三真人无 AI 猫。叫牌顺序仍为 0→1→2。
func _net_host_roll_seats_and_cats_once() -> void:
	if not _online_battle or not _net_is_host:
		return
	var ids: Array[String] = _net_rt_sorted_user_ids()
	var n: int = ids.size()
	if n < 2:
		return
	_net_seat_by_uid.clear()
	_net_ai_logical_seat = -1
	_net_ai_cat_id = -1
	if n == 2:
		var bag: Array[String] = [str(ids[0]), str(ids[1]), "__AI__"]
		bag.shuffle()
		for s in range(3):
			var tok: String = bag[s]
			if tok == "__AI__":
				_net_ai_logical_seat = s
			else:
				_net_seat_by_uid[_net_norm_uid(tok)] = s
		_net_ai_cat_id = randi() % 3
		var ai_se: int = _net_ai_logical_seat
		for s in range(3):
			_seat_cat[s] = _net_ai_cat_id if s == ai_se else 0
	elif n >= 3:
		var perm: Array[int] = [0, 1, 2]
		perm.shuffle()
		var nt: int = mini(3, n)
		for i in range(nt):
			_net_seat_by_uid[_net_norm_uid(str(ids[i]))] = int(perm[i])
		for s in range(3):
			_seat_cat[s] = s % 3
	var hub: Node = get_node_or_null("/root/OnlineSession")
	if hub != null and hub.session != null:
		var mid: String = _net_norm_uid(hub.session.user_id)
		if _net_seat_by_uid.has(mid):
			_my_net_seat = int(_net_seat_by_uid[mid])


func _net_host_refresh_nicks_async() -> void:
	_net_nick_by_uid.clear()
	var hub: Node = get_node_or_null("/root/OnlineSession")
	if hub == null or hub.session == null:
		return
	var all_ids: PackedStringArray = PackedStringArray()
	for k in _net_seat_by_uid.keys():
		all_ids.append(_net_norm_uid(k))
	if all_ids.is_empty():
		return
	var client = hub.get_client()
	var pack = await client.get_users_async(hub.session, all_ids, null, null)
	if pack.is_exception():
		for i in range(all_ids.size()):
			_net_nick_by_uid[_net_norm_uid(all_ids[i])] = "玩家"
	else:
		for u in pack.users:
			if u == null:
				continue
			var nid: String = _net_norm_uid(u.id)
			var nn: String = str(u.display_name)
			if nn.is_empty():
				nn = str(u.username)
			if nn.is_empty():
				nn = "玩家"
			_net_nick_by_uid[nid] = nn
		for i in range(all_ids.size()):
			var iks: String = _net_norm_uid(all_ids[i])
			if not _net_nick_by_uid.has(iks):
				_net_nick_by_uid[iks] = "玩家"
	var my_id: String = _net_norm_uid(hub.session.user_id)
	if not hub.profile_display_name.is_empty():
		_net_nick_by_uid[my_id] = hub.profile_display_name
	elif not hub.profile_username.is_empty():
		_net_nick_by_uid[my_id] = hub.profile_username


func _cat_name(seat_idx: int) -> String:
	if _server_authoritative:
		var cid: int = clampi(int(_seat_cat[seat_idx]), 0, CAT_NAMES.size() - 1)
		if _net_is_human_controlled_seat(seat_idx):
			var uid: String = _net_uid_for_logical_seat(seat_idx)
			var nick: String = "玩家"
			if not uid.is_empty() and _net_nick_by_uid.has(uid):
				nick = str(_net_nick_by_uid[uid])
			return "%s（%s）" % [CAT_NAMES[cid], nick]
		return String(CAT_NAMES[cid])
	if _online_battle:
		return _net_display_name_for_logical_seat(seat_idx)
	return String(CAT_NAMES[int(_seat_cat[seat_idx])])


func _setup_seat_speech() -> void:
	_speech_layer = CanvasLayer.new()
	_speech_layer.layer = 22
	add_child(_speech_layer)
	for i in range(3):
		var b: Node = SEAT_SPEECH_BUBBLE_SCENE.instantiate()
		_speech_layer.add_child(b)
		_speech_bubbles.append(b)
		if b.has_method("set_tail_anchor"):
			match i:
				0:
					b.call("set_tail_anchor", _SeatSpeechBubbleScr.TailAnchor.RIGHT)
				1:
					b.call("set_tail_anchor", _SeatSpeechBubbleScr.TailAnchor.BOTTOM_RIGHT)
				_:
					b.call("set_tail_anchor", _SeatSpeechBubbleScr.TailAnchor.BOTTOM_LEFT)
		var seat_idx: int = i
		if b.has_signal("layout_finished"):
			b.connect("layout_finished", func() -> void: _place_speech_bubble_for_seat(seat_idx))
		b.hide_immediately()
	if not get_viewport().size_changed.is_connected(_on_viewport_size_changed_speech):
		get_viewport().size_changed.connect(_on_viewport_size_changed_speech)
	call_deferred("_layout_all_speech_bubbles")


func _on_viewport_size_changed_speech() -> void:
	_layout_all_speech_bubbles()


func _layout_all_speech_bubbles() -> void:
	if _speech_bubbles.is_empty():
		return
	var avatars: Array[Control] = [_avatar_p0, _avatar_p1, _avatar_p2]
	for i in range(3):
		_place_speech_bubble(_speech_bubbles[i], avatars[i], i)


func _place_speech_bubble_for_seat(seat: int) -> void:
	if seat < 0 or seat >= _speech_bubbles.size():
		return
	var avatars: Array[Control] = [_avatar_p0, _avatar_p1, _avatar_p2]
	_place_speech_bubble(_speech_bubbles[seat], avatars[seat], seat)


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


func _place_speech_bubble(bubble: Control, avatar: Control, seat: int) -> void:
	if bubble == null or avatar == null:
		return
	var g: Rect2 = avatar.get_global_rect()
	var bs: Vector2 = bubble.size
	if bs.x < 4.0 or bs.y < 4.0:
		bs = bubble.get_combined_minimum_size()
	match seat:
		0:
			## 下方玩家：气泡在头像左侧，针脚朝右指向头像（红圈）
			bubble.global_position = Vector2(
				g.position.x - bs.x - 10.0,
				g.position.y + g.size.y * 0.5 - bs.y * 0.5
			)
		1:
			## 右侧 AI：气泡在头像左上，针脚朝右下指向头像（黄圈）
			bubble.global_position = Vector2(
				g.position.x - bs.x + 44.0,
				g.position.y - bs.y - 12.0
			)
		_:
			## 左侧 AI：气泡在头像右上，针脚朝左下指向头像（蓝圈）
			bubble.global_position = Vector2(
				g.end.x + 10.0,
				g.position.y - bs.y - 12.0
			)
	_clamp_speech_bubble_to_viewport(bubble)


func _seat_say(who: int, line: String, duration_sec: float = 2.5) -> void:
	var vs: int = _view_slot_for_logical(who)
	if vs < 0 or vs >= _speech_bubbles.size():
		return
	var b: Node = _speech_bubbles[vs]
	if b and b.has_method("say"):
		b.call("say", line, duration_sec)


func _apply_name_plates() -> void:
	var labels: Array[Label] = [_label_p0, _label_p1, _label_p2]
	var avatars: Array[TextureRect] = [_avatar_p0, _avatar_p1, _avatar_p2]
	if _online_battle and _server_authoritative:
		for vs in range(3):
			var log_s: int = _logical_seat_for_view_slot(vs)
			var disp: String = _cat_name(log_s)
			if log_s == _local_seat():
				labels[vs].text = "%s · 你" % disp
			else:
				labels[vs].text = disp
			var cid: int = clampi(int(_seat_cat[log_s]), 0, CAT_AVATAR_PATHS.size() - 1)
			var tex3: Texture2D = load(String(CAT_AVATAR_PATHS[cid])) as Texture2D
			if tex3:
				avatars[vs].texture = tex3
		return
	if _online_battle:
		for vs in range(3):
			var log_s: int = _logical_seat_for_view_slot(vs)
			var is_ai: bool = not _net_is_human_controlled_seat(log_s)
			var disp: String = _net_display_name_for_logical_seat(log_s)
			if log_s == _local_seat():
				labels[vs].text = "%s（你）" % disp
			elif is_ai:
				labels[vs].text = "%s（AI）" % disp
				var ac: int = clampi(_net_ai_cat_id, 0, CAT_AVATAR_PATHS.size() - 1)
				var tex_ai: Texture2D = load(String(CAT_AVATAR_PATHS[ac])) as Texture2D
				if tex_ai:
					avatars[vs].texture = tex_ai
			else:
				labels[vs].text = "%s（联网）" % disp
				avatars[vs].texture = null
	else:
		_label_p0.text = "%s · 你操作" % _cat_name(0)
		_label_p1.text = "%s · AI" % _cat_name(1)
		_label_p2.text = "%s · AI" % _cat_name(2)
		for p in range(3):
			var cid: int = int(_seat_cat[p])
			var tex2: Texture2D = load(String(CAT_AVATAR_PATHS[cid])) as Texture2D
			if tex2:
				avatars[p].texture = tex2


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


func _sfx_play_rocket() -> void:
	if _sfx_rocket_stream:
		_sfx_play(_sfx_rocket_stream)


func _play_deal_sequence() -> void:
	_deal_layer.show()
	_set_in_game_interactive(false)
	_sfx_play(_sfx_deal_stream)
	## 联网权威：发牌扇略放慢，便于看清动画
	var slow: bool = _server_authoritative
	var step: float = 0.056 if slow else 0.032
	var fade: float = 0.1 if slow else 0.07
	var pause1: float = 1.05 if slow else 0.72
	var pause2: float = 0.95 if slow else 0.58
	for c in _deal_fan.get_children():
		c.queue_free()
	var n_fan := 17
	for i in n_fan:
		var tex_rect := TextureRect.new()
		tex_rect.texture = load(CardDefs.texture_path_back()) as Texture2D
		tex_rect.ignore_texture_size = true
		tex_rect.custom_minimum_size = Vector2(48, 69)
		tex_rect.expand_mode = TextureRect.EXPAND_FIT_WIDTH_PROPORTIONAL
		tex_rect.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		tex_rect.modulate.a = 0.0
		_deal_fan.add_child(tex_rect)
		var tw := create_tween()
		tw.tween_property(tex_rect, "modulate:a", 1.0, fade).set_delay(i * step)
	await get_tree().create_timer(pause1).timeout
	await get_tree().create_timer(pause2).timeout
	_deal_layer.hide()
	_set_in_game_interactive(true)


func _refresh_opp_strip_dealing(box: HBoxContainer, lbl: Label, n: int) -> void:
	for c in box.get_children():
		c.queue_free()
	lbl.text = "%d张" % n
	if n <= 0:
		return
	var show_n: int = mini(8, maxi(1, n))
	for i in show_n:
		var tr_back := TextureRect.new()
		tr_back.texture = load(CardDefs.texture_path_back()) as Texture2D
		tr_back.ignore_texture_size = true
		tr_back.custom_minimum_size = Vector2(38, 52)
		tr_back.expand_mode = TextureRect.EXPAND_FIT_WIDTH_PROPORTIONAL
		tr_back.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		box.add_child(tr_back)


## 本机手牌区：追加一张（发牌顺序）；仅对新牌做渐显，避免整排重建打断 tween。
func _append_local_hand_card_deal(cid: int) -> void:
	var idv: int = int(cid)
	var idx: int = _hand_row.get_child_count()
	var step: float = mini(_FAN_STEP, 52.0)
	var n: int = idx + 1
	var total_w: float = (n - 1) * step + _CARD_W
	_hand_row.custom_minimum_size = Vector2(total_w, _HAND_BASE_Y + _CARD_H + 8.0)
	var tb := TextureButton.new()
	tb.toggle_mode = true
	tb.ignore_texture_size = true
	tb.texture_normal = load(CardDefs.texture_path_for(idv)) as Texture2D
	tb.custom_minimum_size = Vector2(_CARD_W, _CARD_H)
	tb.stretch_mode = TextureButton.STRETCH_KEEP_ASPECT_CENTERED
	tb.set_anchors_preset(Control.PRESET_TOP_LEFT)
	var x: float = idx * step
	tb.position = Vector2(x, _HAND_BASE_Y)
	tb.size = Vector2(_CARD_W, _CARD_H)
	tb.z_index = idx
	tb.set_meta("fan_x", x)
	tb.set_meta("fan_base_y", _HAND_BASE_Y)
	tb.pivot_offset = Vector2(_CARD_W * 0.5, _CARD_H * 0.5)
	tb.disabled = true
	tb.modulate.a = 0.0
	tb.scale = Vector2(0.92, 0.92)
	tb.toggled.connect(func(pressed: bool) -> void: _on_card_toggled(tb, pressed))
	tb.gui_input.connect(func(ev: InputEvent) -> void: _on_hand_card_gui_input(ev, tb))
	_hand_row.add_child(tb)
	_card_buttons[idv] = tb
	var tw := create_tween()
	tw.set_parallel(true)
	tw.set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_OUT)
	tw.tween_property(tb, "modulate:a", 1.0, 0.12)
	tw.tween_property(tb, "scale", Vector2.ONE, 0.12)


## 按房主（或本地）同一 trace 一张张发牌：print、对手张数、本机手牌渐显；结束 `_refresh_ui()` + 底牌条。
func _play_deal_trace_anim_async(trace: Array) -> void:
	if trace.is_empty() or trace.size() != 51:
		push_warning("发牌轨迹异常 size=%d，跳过动画" % trace.size())
		return
	_deal_layer.show()
	for c in _deal_fan.get_children():
		c.queue_free()
	_sfx_play(_sfx_deal_stream)
	for c in _bottom_cards.get_children():
		c.queue_free()
	for _tbb in _card_select_tweens.keys():
		var twv: Variant = _card_select_tweens[_tbb]
		if twv is Tween and is_instance_valid(twv):
			(twv as Tween).kill()
	_card_select_tweens.clear()
	for c in _hand_row.get_children():
		c.queue_free()
	_card_buttons.clear()
	_refresh_opp_strip_dealing(_opp_p2, _opp_lbl2, 0)
	_refresh_opp_strip_dealing(_opp_p1, _opp_lbl1, 0)
	var me: int = _local_seat()
	var s_right: int = (me + 1) % 3
	var s_left: int = (me + 2) % 3
	var counts: Array[int] = [0, 0, 0]
	var step_i := 0
	for ent in trace:
		if typeof(ent) != TYPE_DICTIONARY:
			continue
		var seat: int = clampi(int((ent as Dictionary).get("seat", 0)), 0, 2)
		var cid: int = int((ent as Dictionary).get("card", 0))
		step_i += 1
		print(
			"[发牌] 第%d/51 → 逻辑座位%d（%s） %s"
			% [step_i, seat, _cat_name(seat), CardDefs.format_card_short(cid)]
		)
		counts[seat] = counts[seat] + 1
		if seat == me:
			_append_local_hand_card_deal(cid)
		elif seat == s_left:
			_refresh_opp_strip_dealing(_opp_p2, _opp_lbl2, counts[s_left])
		elif seat == s_right:
			_refresh_opp_strip_dealing(_opp_p1, _opp_lbl1, counts[s_right])
		await get_tree().create_timer(_DEAL_TRACE_STEP_SEC).timeout
	_refresh_ui()
	_refresh_bottom_card_strip()
	_refresh_play_area()
	_refresh_landlord_badges()
	_deal_layer.hide()


func _set_in_game_interactive(on: bool) -> void:
	if _bidding_active or _in_rob_phase:
		return
	_btn_play.disabled = not on
	_btn_hint.disabled = not on
	_btn_pass.disabled = not on
	if is_instance_valid(_btn_settings_redeal):
		_btn_settings_redeal.disabled = (not on) or _online_battle
	_btn_settings_to_menu.disabled = not on


func _ddz_less(a: int, b: int) -> bool:
	return CardDefs.ddz_rank_value(a) < CardDefs.ddz_rank_value(b)


func _on_settings_redeal_pressed() -> void:
	_dlg_confirm_redeal.popup_centered()


func _on_redeal_confirmed() -> void:
	_settlement_layer.hide()
	if not (_online_battle and not _net_is_host):
		await _run_new_round()


func _on_settings_to_menu_pressed() -> void:
	_dlg_confirm_menu.popup_centered()


func _on_to_menu_confirmed() -> void:
	_settlement_layer.hide()
	await _return_to_start_menu_async()


func _on_net_match_peer_left(left_user_id: String) -> void:
	if not _online_battle or _net_peer_abort_done:
		return
	var hub: Node = get_node_or_null("/root/OnlineSession")
	if hub == null or not hub.has_method("get_rt_match_host_user_id"):
		return
	if hub.session != null and left_user_id == hub.session.user_id:
		return
	var hid: String = hub.get_rt_match_host_user_id()
	var msg: String = "对局已中断"
	if left_user_id == hid:
		msg = "房主已离开对局" if not _net_is_host else "对方已离开对局"
	else:
		msg = "对方已离开对局" if _net_is_host else "对局已中断"
	_net_peer_abort_done = true
	_peer_abort_then_menu_async(msg)


func _on_net_match_rt_disconnected() -> void:
	if not _online_battle or _net_peer_abort_done:
		return
	_net_peer_abort_done = true
	_peer_abort_then_menu_async("与服务器连接已断开")


func _peer_abort_then_menu_async(msg: String) -> void:
	if not is_inside_tree():
		return
	_set_in_game_interactive(false)
	if _settlement_layer:
		_settlement_layer.hide()
	var go_lobby: bool = _should_return_to_lobby()
	var ad := AcceptDialog.new()
	ad.title = "对局中断"
	ad.ok_button_text = "返回大厅" if go_lobby else "确定"
	ad.dialog_text = msg + ("\n\n将返回联机大厅。" if go_lobby else "\n\n将返回开始界面。")
	add_child(ad)
	call_deferred("_apply_styled_accept_dialog", ad)
	ad.popup_centered()
	await ad.confirmed
	if is_instance_valid(ad) and ad.is_inside_tree():
		ad.queue_free()
	if not is_inside_tree():
		return
	await _return_to_start_menu_async()


func _return_to_start_menu_async() -> void:
	var hub: Node = get_node_or_null("/root/OnlineSession")
	if hub != null and hub.has_method("leave_online_match_cleanup_async"):
		await hub.leave_online_match_cleanup_async()
	if _should_return_to_lobby():
		get_tree().change_scene_to_file("res://scenes/multiplayer_lobby.tscn")
	else:
		get_tree().change_scene_to_file("res://scenes/start_menu.tscn")


func _run_new_round() -> void:
	_match_round_index += 1
	_local_call_round_start_seat = -1
	CardDefs.pick_random_card_back_for_round()
	if _online_battle and _net_is_host:
		var ids_chk: Array[String] = _net_rt_sorted_user_ids()
		if _net_seat_by_uid.is_empty() and ids_chk.size() >= 2:
			_net_host_roll_seats_and_cats_once()
			await _net_host_refresh_nicks_async()
	for sb in _speech_bubbles:
		if sb and sb.has_method("hide_immediately"):
			sb.call("hide_immediately")
	_apply_name_plates()
	_refresh_score_strip()
	call_deferred("_layout_all_speech_bubbles")
	_winner = -1
	_last.clear()
	_last_play_ids.clear()
	_last_player = -1
	_passes = 0
	_seen_rank.clear()
	for _i in range(15):
		_seen_rank.append(0)
	_game_log.clear()
	if _online_battle and _net_is_host:
		_net_host_log_ring.clear()
	_winner_logged = false
	_settlement_shown = false
	_bidding_active = true
	if is_instance_valid(_btn_settings_redeal):
		_btn_settings_redeal.disabled = true
	_btn_play.disabled = true
	_btn_hint.disabled = true
	_btn_pass.disabled = true
	if _match_round_index == 1:
		await _log_line("[color=#c8f0dd][b]新一盘 · 第 1 局[/b][/color]  [font_size=10][color=#7aaa96]（座位已随机，局间不换角）[/color][/font_size]")
	else:
		await _log_line("[color=#c8f0dd][b]第 %d 局[/b][/color]" % _match_round_index)
	if _match_round_index == 1 and _online_battle and _net_is_host and not _server_authoritative:
		await _host_init_online_scores_if_host()
	if _online_battle and _net_is_host:
		await _host_wait_enet_guests_ready_async()
	var deal_seed: int = randi()
	_last_deal_seed = deal_seed
	var deck_inst := Deck.new(deal_seed)
	_deck = deck_inst
	var pkg: Dictionary = deck_inst.deal_doudizhu_with_trace()
	_hands = pkg["hands"] as Array
	_bottom = pkg["bottom"] as PackedInt32Array
	var deal_trace: Array = pkg["trace"] as Array
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
	await _play_deal_trace_anim_async(deal_trace)
	await get_tree().create_timer(_POST_DEAL_TO_BID_PAUSE_SEC).timeout
	if not is_inside_tree():
		return
	if _online_battle and _net_is_host:
		_net_broadcast_snapshot_if_host()
	await _run_bidding_phase()
	await _bottom_reveal_local_async()
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
			return "叫地主"
		-1:
			return "—"
	return str(b)


func _bid_speech_line(bid: int) -> String:
	match bid:
		0:
			return BUBBLE_BID_NO
		1:
			return BUBBLE_BID_CALL
	return ""


func _bottom_ids_array() -> Array:
	var a: Array = []
	for i in _bottom.size():
		a.append(_bottom[i])
	return a


func _format_card_ids_for_log(p: PackedInt32Array) -> String:
	var a: Array = []
	for i in p.size():
		a.append(p[i])
	return CardDefs.format_cards_list(a)


func _refresh_bottom_card_strip_face_up(ids: PackedInt32Array) -> void:
	for c in _bottom_cards.get_children():
		c.queue_free()
	if _bottom_cards:
		_bottom_cards.visible = true
	for i in ids.size():
		var tex_rect := TextureRect.new()
		var bid: int = int(ids[i])
		tex_rect.texture = load(CardDefs.texture_path_for(bid)) as Texture2D
		tex_rect.ignore_texture_size = true
		tex_rect.custom_minimum_size = Vector2(52, 72)
		tex_rect.expand_mode = TextureRect.EXPAND_FIT_WIDTH_PROPORTIONAL
		tex_rect.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		_bottom_cards.add_child(tex_rect)


func _clear_bottom_strip_only() -> void:
	for c in _bottom_cards.get_children():
		c.queue_free()
	if _bottom_cards:
		_bottom_cards.visible = false


## PhaseInfoPanel 内「底牌说明 + 三张底牌」与叫牌/抢地主同属一段 UI；出牌阶段应隐藏，仅保留标题与状态行。
func _sync_phase_info_bidding_strip() -> void:
	if _bottom_cards_caption:
		_bottom_cards_caption.visible = _bidding_active or _in_rob_phase
	_refresh_bottom_card_strip()


func _srv_bottom_reveal_async(ids: Array) -> void:
	if not is_inside_tree() or _bottom_cards == null:
		return
	var pha := PackedInt32Array()
	pha.resize(ids.size())
	for i in ids.size():
		pha[i] = int(ids[i])
	_refresh_bottom_card_strip_face_up(pha)
	_log_line_sync(
		"[color=#d8e8c8][b]底牌已翻开[/b][/color]  %s  ｜ 地主 [b]%s[/b]"
		% [_format_card_ids_for_log(pha), _cat_name(_landlord)]
	)
	await get_tree().create_timer(2.0).timeout
	if not is_inside_tree():
		return
	_refresh_bottom_card_strip()


func _bottom_reveal_local_async() -> void:
	if _bottom.size() < 3:
		return
	var pha: PackedInt32Array = _bottom.duplicate()
	_refresh_bottom_card_strip_face_up(pha)
	_log_line_sync(
		"[color=#d8e8c8][b]底牌已翻开[/b][/color]  %s  ｜ 地主 [b]%s[/b]"
		% [_format_card_ids_for_log(pha), _cat_name(_landlord)]
	)
	await get_tree().create_timer(2.0).timeout
	if not is_inside_tree():
		return
	_clear_bottom_strip_only()


func _refresh_bottom_card_strip() -> void:
	for c in _bottom_cards.get_children():
		c.queue_free()
	## 底牌说明与三张牌背仅用于叫牌/抢地主阶段；出牌后整块隐藏，避免与牌局信息栏「糊在一起」占高度
	if not _bidding_active and not _in_rob_phase:
		if _bottom_cards:
			_bottom_cards.visible = false
		return
	if _bottom_cards:
		_bottom_cards.visible = true
	for i in _bottom.size():
		var tex_rect := TextureRect.new()
		var bid: int = int(_bottom[i])
		var tex_path: String = CardDefs.texture_path_back() if bid < 0 else CardDefs.texture_path_for(bid)
		tex_rect.texture = load(tex_path) as Texture2D
		tex_rect.ignore_texture_size = true
		tex_rect.custom_minimum_size = Vector2(52, 72)
		tex_rect.expand_mode = TextureRect.EXPAND_FIT_WIDTH_PROPORTIONAL
		tex_rect.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		_bottom_cards.add_child(tex_rect)


func _local_deal_fresh_pack_same_round() -> void:
	CardDefs.pick_random_card_back_for_round()
	var deal_seed: int = randi()
	_last_deal_seed = deal_seed
	var deck_inst := Deck.new(deal_seed)
	_deck = deck_inst
	var pkg: Dictionary = deck_inst.deal_doudizhu_with_trace()
	_hands = pkg["hands"] as Array
	_bottom = pkg["bottom"] as PackedInt32Array
	var deal_trace: Array = pkg["trace"] as Array
	for p in range(3):
		var h: PackedInt32Array = _hands[p]
		var arr: Array = []
		for j in h.size():
			arr.append(h[j])
		arr.sort_custom(_ddz_less)
		var nh: PackedInt32Array = PackedInt32Array()
		nh.resize(arr.size())
		for j in arr.size():
			nh[j] = arr[j]
		_hands[p] = nh
	await _play_deal_trace_anim_async(deal_trace)


func _run_bidding_phase() -> void:
	_reset_multiplier_components()
	_in_rob_phase = false
	var start_seat: int = 0
	var candidate: int = -1
	while true:
		_bids = [-1, -1, -1]
		start_seat = randi_range(0, 2)
		_local_call_round_start_seat = start_seat
		await _log_line(
			"[color=#b8e8d0][b]叫地主阶段开始[/b][/color]  本局首家叫牌：[b]%s[/b]  ·  底牌 %s"
			% [_cat_name(start_seat), CardDefs.format_cards_list(_bottom_ids_array())]
		)
		candidate = -1
		for step in range(3):
			var i: int = (start_seat + step) % 3
			await _log_line("%s 思考中…" % _cat_name(i))
			var bid: int = 0
			if i == _local_seat():
				_bidding_row.visible = true
				_set_bid_buttons_disabled(false)
				bid = await _human_bid_once()
				_bidding_row.visible = false
			elif _online_battle and _net_is_host and _net_is_human_controlled_seat(i) and i != _local_seat():
				_net_remote_await_seat = i
				_net_awaits = {"await_bid": true, "await_seat": i}
				call_deferred("_net_broadcast_snapshot_if_host")
				await get_tree().process_frame
				bid = clampi(await _await_guest_bid_async(), 0, 1)
				_net_awaits = {}
				_net_remote_await_seat = -1
				call_deferred("_net_broadcast_snapshot_if_host")
			else:
				await get_tree().create_timer(0.4).timeout
				bid = DdzAi.choose_bid(_hands[i], DdzAi.style_from_cat_id(int(_seat_cat[i])))
			bid = clampi(bid, 0, 1)
			_bids[i] = bid
			if _online_battle and _net_is_host:
				call_deferred("_net_broadcast_snapshot_if_host")
			await _log_line("%s 选择：[b]%s[/b]" % [_cat_name(i), _bid_choice_label(bid)])
			_seat_say(i, _bid_speech_line(bid), BUBBLE_BID_ROB_SEC)
			if bid == 1:
				candidate = i
				break
		if candidate >= 0:
			break
		if int(_bids[0]) == 0 and int(_bids[1]) == 0 and int(_bids[2]) == 0:
			await _log_line("三家均未叫地主，重新发牌…")
			await _local_deal_fresh_pack_same_round()
			if _online_battle and _net_is_host:
				call_deferred("_net_broadcast_snapshot_if_host")
			continue
		break
	_mult_base = 1
	_sync_round_multiplier()
	await _log_line("[b]叫地主方[/b]（本局唯一叫地主）：%s ｜ 基础倍率 [b]×1[/b]" % _cat_name(candidate))
	await _run_rob_landlord_phase(candidate)
	_bidding_active = false
	_in_rob_phase = false
	_set_in_game_interactive(true)


func _run_rob_landlord_phase(candidate: int) -> void:
	_in_rob_phase = true
	if _title:
		_title.text = "斗地主 · 抢地主中…"
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
			_seat_say(i, BUBBLE_ROB_BLOCKED, BUBBLE_BID_ROB_SEC)
			continue
		var do_rob: bool = false
		if i == _local_seat():
			_rob_row.visible = true
			do_rob = await _human_rob_once()
			_rob_row.visible = false
		elif _online_battle and _net_is_host and _net_is_human_controlled_seat(i) and i != _local_seat():
			_net_remote_await_seat = i
			_net_awaits = {"await_rob": true, "await_seat": i}
			call_deferred("_net_broadcast_snapshot_if_host")
			await get_tree().process_frame
			do_rob = await _await_guest_rob_async()
			_net_awaits = {}
			_net_remote_await_seat = -1
			call_deferred("_net_broadcast_snapshot_if_host")
		else:
			await get_tree().create_timer(0.38).timeout
			var mult_before_rob: int = _mult_base * _mult_rob
			do_rob = DdzAi.choose_rob_landlord(_hands[i], mult_before_rob, DdzAi.style_from_cat_id(int(_seat_cat[i])))
		if do_rob:
			_mult_rob *= 2
			_rob_count += 1
			_sync_round_multiplier()
			last_robber = i
			await _log_line("%s [b]%s[/b]！当前总倍率：×%d（基础×%d × 抢×%d）" % [_cat_name(i), BUBBLE_ROB_YES, _round_multiplier, _mult_base, _mult_rob])
			_seat_say(i, BUBBLE_ROB_YES, BUBBLE_BID_ROB_SEC)
		else:
			await _log_line("%s %s" % [_cat_name(i), BUBBLE_ROB_NO])
			_seat_say(i, BUBBLE_ROB_NO, BUBBLE_BID_ROB_SEC)
	if last_robber >= 0:
		_landlord = last_robber
	else:
		_landlord = candidate
	await _log_line("最终地主：[b]%s[/b] ｜ 当前总倍率：×%d（基础×%d × 抢×%d，出牌后炸弹/王炸再累乘）" % [_cat_name(_landlord), _round_multiplier, _mult_base, _mult_rob])
	_seat_say(_landlord, "这把我是地主了，哈哈！", 3.6)


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
	_bottom = PackedInt32Array()
	for c in _bottom_cards.get_children():
		c.queue_free()


func _set_bid_buttons_disabled(disabled: bool) -> void:
	_btn_bid0.disabled = disabled
	_btn_bid3.disabled = disabled


func _after_state_changed() -> void:
	_refresh_ui()
	if _winner >= 0:
		_online_bump_turn_timer_epoch()
		if not _settlement_shown:
			_settlement_shown = true
			call_deferred("_run_settlement_flow")
		call_deferred("_net_broadcast_snapshot_if_host")
		return
	call_deferred("_tick_ai")
	call_deferred("_online_schedule_human_turn_timer_if_needed")
	call_deferred("_net_broadcast_snapshot_if_host")


func _refresh_match_title() -> void:
	if not _title:
		return
	var mode: String = "联网 " if _online_battle else ""
	_title.text = "%s倍数×%d ｜ 地主：%s" % [mode, _round_multiplier, _cat_name(_landlord)]


func _online_bump_turn_timer_epoch() -> void:
	_online_turn_epoch += 1
	_online_deadline_msec = 0


func _online_schedule_human_turn_timer_if_needed() -> void:
	if _online_battle and not _net_is_host and _turn == _local_seat() and not _bidding_active and _winner < 0:
		_online_bump_turn_timer_epoch()
		return
	if not _online_battle or _winner >= 0 or _bidding_active or _turn != _local_seat():
		_online_bump_turn_timer_epoch()
		return
	_online_bump_turn_timer_epoch()
	var epoch: int = _online_turn_epoch
	_online_deadline_msec = Time.get_ticks_msec() + int(ONLINE_PLAY_TURN_SEC * 1000.0)
	_online_run_human_turn_timer_async(epoch, ONLINE_PLAY_TURN_SEC)


func _online_run_human_turn_timer_async(epoch: int, wait_sec: float = ONLINE_PLAY_TURN_SEC) -> void:
	if wait_sec < 0.05:
		return
	await get_tree().create_timer(wait_sec).timeout
	if epoch != _online_turn_epoch:
		return
	if not _online_battle or _winner >= 0 or _bidding_active or _turn != _local_seat():
		return
	_online_on_play_time_expired()


func _net_broadcast_snapshot_if_host() -> void:
	if not _online_battle or not _net_is_host:
		return
	if _match_replica == null:
		return
	_net_snap_seq += 1
	var d: Dictionary = _net_build_snapshot()
	d["seq"] = _net_snap_seq
	var js: String = JSON.stringify(d)
	_match_replica.set("state_json", js)
	_match_replica.set("sync_seq", _net_snap_seq)
	if multiplayer.has_multiplayer_peer():
		for peer_id in multiplayer.get_peers():
			rpc_client_receive_match_state.rpc_id(peer_id, d)


func _net_build_snapshot() -> Dictionary:
	var hands: Array = []
	for p in range(3):
		var arr: Array = []
		var h: PackedInt32Array = _hands[p]
		for i in h.size():
			arr.append(int(h[i]))
		hands.append(arr)
	var bottom_a: Array = []
	for i in _bottom.size():
		bottom_a.append(int(_bottom[i]))
	var t_left_ms := 0
	if _winner < 0 and not _bidding_active and _turn == _local_seat() and _online_deadline_msec > 0:
		t_left_ms = maxi(0, _online_deadline_msec - Time.get_ticks_msec())
	var settle_bb: String = ""
	if _settle_body:
		settle_bb = _settle_body.text
	var sbu_send: Dictionary = {}
	for kk in _net_seat_by_uid.keys():
		sbu_send[str(kk)] = int(_net_seat_by_uid[kk])
	var nick_send: Dictionary = {}
	for nk in _net_nick_by_uid.keys():
		nick_send[str(nk)] = str(_net_nick_by_uid[nk])
	var d := {
		"v": 3,
		"seq": _net_snap_seq,
		"deal_seed": _last_deal_seed,
		"seat_by_uid": sbu_send,
		"ai_seat": _net_effective_ai_seat(),
		"ai_cat_id": _net_ai_cat_id,
		"nick_by_uid": nick_send,
		"hands": hands,
		"bottom": bottom_a,
		"bids": [int(_bids[0]), int(_bids[1]), int(_bids[2])],
		"landlord": _landlord,
		"turn": _turn,
		"bidding": _bidding_active,
		"in_rob": _in_rob_phase,
		"passes": _passes,
		"last_player": _last_player,
		"winner": _winner,
		"last": DdzNetSyncScr.pattern_to_plain(_last),
		"last_ids": _last_play_ids.duplicate(),
		"seen_rank": _seen_rank.duplicate(),
		"scores": [int(_scores[0]), int(_scores[1]), int(_scores[2])],
		"m_base": _mult_base,
		"m_rob": _mult_rob,
		"m_play": _mult_play,
		"rob_c": _rob_count,
		"bomb_c": _play_bomb_count,
		"rock_c": _play_rocket_count,
		"round_mul": _round_multiplier,
		"seat_cat": [_seat_cat[0], _seat_cat[1], _seat_cat[2]],
		"match_round": _match_round_index,
		"sett_shown": _settlement_shown,
		"win_log": _winner_logged,
		"t_left_ms": t_left_ms,
		"log_tail": _net_host_log_ring.duplicate(),
		"settlement_open": _settlement_layer.visible,
		"settle_body_bb": settle_bb,
	}
	for k in _net_awaits.keys():
		d[k] = _net_awaits[k]
	return d


func _net_sync_guest_play_timer_from_snapshot(d: Dictionary) -> void:
	if _net_is_host:
		return
	var tl: int = int(d.get("t_left_ms", 0))
	_online_turn_epoch += 1
	var epoch: int = _online_turn_epoch
	_online_deadline_msec = 0
	var wn: int = int(d.get("winner", -1))
	if tl > 0 and not bool(d.get("bidding", false)) and int(d.get("turn", -1)) == _local_seat() and wn < 0:
		_online_deadline_msec = Time.get_ticks_msec() + tl
		_online_run_human_turn_timer_async(epoch, tl / 1000.0)


func _net_guest_apply_full_state_dict(d: Dictionary) -> void:
	if not _online_battle or _net_is_host:
		return
	var inseq: int = int(float(d.get("seq", -1)))
	if inseq >= 0 and inseq <= _net_last_applied_seq:
		return
	if inseq >= 0:
		_net_last_applied_seq = inseq
	_net_apply_snapshot(d)
	if _online_battle and not _net_is_host and not _net_guest_wallet_sent and not _server_authoritative:
		var hubg: Node = get_node_or_null("/root/OnlineSession")
		if hubg != null and hubg.has_method("sync_wallet_async"):
			await hubg.sync_wallet_async()
			if multiplayer.has_multiplayer_peer():
				rpc_id(1, "host_register_starting_coins", int(hubg.wallet_coins))
		_net_guest_wallet_sent = true
	if _online_battle and not _net_is_host:
		var ds_anim: int = int(d.get("deal_seed", -1))
		if ds_anim >= 0 and ds_anim != _net_last_shown_deal_seed and bool(d.get("bidding", false)):
			var all_17 := true
			for _si in range(3):
				if int((_hands[_si] as PackedInt32Array).size()) != 17:
					all_17 = false
					break
			if all_17:
				var deck_re = Deck.new(ds_anim)
				var pkg_re: Dictionary = deck_re.deal_doudizhu_with_trace()
				await _play_deal_trace_anim_async(pkg_re["trace"] as Array)
				_net_last_shown_deal_seed = ds_anim
	_net_guest_booted = true
	_apply_name_plates()
	var guest_await_bid: bool = bool(d.get("await_bid", false)) or bool(d.get("bid", false))
	if guest_await_bid:
		var aws_b: int = int(d.get("await_seat", -1))
		if aws_b < 0 or aws_b > 2:
			_bidding_row.visible = false
			_set_bid_buttons_disabled(true)
		elif aws_b == _local_seat():
			_bidding_row.visible = true
			_set_bid_buttons_disabled(false)
		else:
			_bidding_row.visible = false
			_set_bid_buttons_disabled(true)
	elif bool(d.get("await_rob", false)) or bool(d.get("rob", false)):
		var aws_r: int = int(d.get("await_seat", -1))
		if aws_r < 0 or aws_r > 2:
			_rob_row.visible = false
		elif aws_r == _local_seat():
			_rob_row.visible = true
		else:
			_rob_row.visible = false
	else:
		_bidding_row.visible = false
		_rob_row.visible = false
	_net_sync_guest_play_timer_from_snapshot(d)
	_net_apply_log_tail_from_snapshot(d.get("log_tail", null))
	_net_apply_settlement_ui_from_snapshot(d)
	_refresh_ui()
	if not _bidding_active and (_settlement_layer == null or not _settlement_layer.visible):
		_set_in_game_interactive(true)
	call_deferred("_layout_all_speech_bubbles")
	call_deferred("_tick_ai")


func _net_apply_seat_layout_from_snapshot_maybe(d: Dictionary) -> void:
	if not _online_battle:
		return
	var sbuv: Variant = d.get("seat_by_uid", null)
	if sbuv != null and typeof(sbuv) == TYPE_DICTIONARY and not (sbuv as Dictionary).is_empty():
		_net_seat_by_uid.clear()
		for kk in (sbuv as Dictionary).keys():
			_net_seat_by_uid[_net_norm_uid(kk)] = int((sbuv as Dictionary)[kk])
		_net_ai_logical_seat = int(d.get("ai_seat", -1))
		if _net_ai_logical_seat < 0 and _net_seat_by_uid.size() == 2:
			var used_ai: Dictionary = {}
			for v_ai in _net_seat_by_uid.values():
				used_ai[int(v_ai)] = true
			for s_ai in range(3):
				if not used_ai.has(s_ai):
					_net_ai_logical_seat = s_ai
					break
	else:
		var ids2: Array[String] = _net_rt_sorted_user_ids()
		_net_seat_by_uid.clear()
		if ids2.size() == 2:
			_net_seat_by_uid[_net_norm_uid(str(ids2[0]))] = 0
			_net_seat_by_uid[_net_norm_uid(str(ids2[1]))] = 1
			_net_ai_logical_seat = 2
		elif ids2.size() >= 3:
			for ii in range(mini(3, ids2.size())):
				_net_seat_by_uid[_net_norm_uid(str(ids2[ii]))] = ii
			_net_ai_logical_seat = -1
	var hubl: Node = get_node_or_null("/root/OnlineSession")
	if hubl != null and hubl.session != null:
		var mid3: String = _net_norm_uid(hubl.session.user_id)
		if _net_seat_by_uid.has(mid3):
			_my_net_seat = int(_net_seat_by_uid[mid3])


func _net_apply_nicks_ai_from_snapshot_maybe(d: Dictionary) -> void:
	if not _online_battle:
		return
	_net_ai_cat_id = int(d.get("ai_cat_id", -1))
	var nickv: Variant = d.get("nick_by_uid", null)
	_net_nick_by_uid.clear()
	if nickv != null and typeof(nickv) == TYPE_DICTIONARY:
		for kk in (nickv as Dictionary).keys():
			_net_nick_by_uid[_net_norm_uid(kk)] = str((nickv as Dictionary)[kk])
	else:
		var hubx: Node = get_node_or_null("/root/OnlineSession")
		if hubx != null and hubx.session != null:
			var uid_loc: String = _net_norm_uid(hubx.session.user_id)
			var nm_loc: String = hubx.profile_display_name
			if nm_loc.is_empty():
				nm_loc = hubx.profile_username
			if nm_loc.is_empty():
				nm_loc = hubx.session.username
			if nm_loc.is_empty():
				nm_loc = "玩家"
			_net_nick_by_uid[uid_loc] = nm_loc
	if _net_ai_cat_id < 0 and _net_online_human_count() < 3:
		var aix2: int = _net_effective_ai_seat()
		if aix2 >= 0 and aix2 < 3:
			_net_ai_cat_id = clampi(int(_seat_cat[aix2]), 0, 2)
	var hubm: Node = get_node_or_null("/root/OnlineSession")
	if hubm != null and hubm.session != null:
		var self_id: String = _net_norm_uid(hubm.session.user_id)
		var nm_self: String = str(hubm.profile_display_name)
		if nm_self.is_empty():
			nm_self = str(hubm.profile_username)
		if nm_self.is_empty():
			nm_self = str(hubm.session.username)
		if not nm_self.is_empty():
			_net_nick_by_uid[self_id] = nm_self


func _net_apply_snapshot(d: Dictionary) -> void:
	_net_apply_seat_layout_from_snapshot_maybe(d)
	var hands_raw: Array = d.get("hands", [])
	_hands.clear()
	for pi in range(mini(3, hands_raw.size())):
		var arr: Array = hands_raw[pi] as Array
		var nh: PackedInt32Array = PackedInt32Array()
		nh.resize(arr.size())
		for j in arr.size():
			nh[j] = int(arr[j])
		_hands.append(nh)
	while _hands.size() < 3:
		_hands.append(PackedInt32Array())
	var bot: Array = d.get("bottom", []) as Array
	_bottom = PackedInt32Array()
	_bottom.resize(bot.size())
	for i in bot.size():
		_bottom[i] = int(bot[i])
	var bb: Array = d.get("bids", [-1, -1, -1]) as Array
	if bb.size() >= 3:
		_bids[0] = int(bb[0])
		_bids[1] = int(bb[1])
		_bids[2] = int(bb[2])
	_landlord = int(d.get("landlord", 0))
	_turn = clampi(int(d.get("turn", 0)), 0, 2)
	_bidding_active = bool(d.get("bidding", false))
	_in_rob_phase = bool(d.get("in_rob", false))
	_passes = int(d.get("passes", 0))
	_last_player = int(d.get("last_player", -1))
	_winner = int(d.get("winner", -1))
	var lplain: Dictionary = d.get("last", {}) as Dictionary
	_last = DdzNetSyncScr.plain_to_pattern(lplain)
	var lids: Array = d.get("last_ids", []) as Array
	_last_play_ids.clear()
	for x in lids:
		_last_play_ids.append(int(x))
	var sr: Array = d.get("seen_rank", []) as Array
	_seen_rank.clear()
	for x in sr:
		_seen_rank.append(int(x))
	while _seen_rank.size() < 15:
		_seen_rank.append(0)
	var sc: Array = d.get("scores", []) as Array
	if sc.size() >= 3:
		_scores[0] = int(sc[0])
		_scores[1] = int(sc[1])
		_scores[2] = int(sc[2])
	_mult_base = int(d.get("m_base", 1))
	_mult_rob = int(d.get("m_rob", 1))
	_mult_play = int(d.get("m_play", 1))
	_rob_count = int(d.get("rob_c", 0))
	_play_bomb_count = int(d.get("bomb_c", 0))
	_play_rocket_count = int(d.get("rock_c", 0))
	_round_multiplier = int(d.get("round_mul", 1))
	var cats: Array = d.get("seat_cat", []) as Array
	if cats.size() >= 3:
		_seat_cat[0] = int(float(cats[0]))
		_seat_cat[1] = int(float(cats[1]))
		_seat_cat[2] = int(float(cats[2]))
	_match_round_index = int(d.get("match_round", 0))
	_settlement_shown = bool(d.get("sett_shown", false))
	_winner_logged = bool(d.get("win_log", false))
	if d.has("deal_seed"):
		_last_deal_seed = int(d.get("deal_seed", -1))
	_net_apply_nicks_ai_from_snapshot_maybe(d)
	_refresh_bottom_card_strip()


func _on_bid_choice_pressed(score: int) -> void:
	var b: int = clampi(score, 0, 1)
	if _server_authoritative:
		var hub: Node = get_node_or_null("/root/OnlineSession")
		if hub != null and hub.has_method("send_ddz_authoritative_async"):
			hub.send_ddz_authoritative_async(10, {"bid": b})
		_bidding_row.visible = false
		return
	if _online_battle and not _net_is_host:
		var hub2: Node = get_node_or_null("/root/OnlineSession")
		if hub2 != null and hub2.has_method("send_client_action_async"):
			hub2.send_client_action_async({"action": "bid", "score": b})
		_bidding_row.visible = false
		return
	human_bid_chosen.emit(b)


func _on_rob_choice_pressed(rob: bool) -> void:
	if _server_authoritative:
		var hub: Node = get_node_or_null("/root/OnlineSession")
		if hub != null and hub.has_method("send_ddz_authoritative_async"):
			hub.send_ddz_authoritative_async(11, {"rob": rob})
		_rob_row.visible = false
		return
	if _online_battle and not _net_is_host:
		var hub2: Node = get_node_or_null("/root/OnlineSession")
		if hub2 != null and hub2.has_method("send_client_action_async"):
			hub2.send_client_action_async({"action": "rob", "rob": rob})
		_rob_row.visible = false
		return
	human_rob_chosen.emit(rob)


func _await_guest_bid_async() -> int:
	_net_guest_bid_ready = false
	while not _net_guest_bid_ready:
		await get_tree().process_frame
	return clampi(_net_guest_bid_value, 0, 1)


func _await_guest_rob_async() -> bool:
	_net_guest_rob_ready = false
	while not _net_guest_rob_ready:
		await get_tree().process_frame
	return _net_guest_rob_value


func _on_net_client_action(d: Dictionary, sender_user_id: String) -> void:
	if not _online_battle or not _net_is_host:
		return
	var hub: Node = get_node_or_null("/root/OnlineSession")
	if hub == null or not hub.has_method("get_rt_match_host_user_id"):
		return
	var hid: String = hub.get_rt_match_host_user_id()
	if not hid.is_empty() and sender_user_id == hid:
		return
	var sender_seat: int = _net_seat_for_user_id(sender_user_id)
	if sender_seat < 0:
		return
	var act: String = str(d.get("action", ""))
	match act:
		"bid":
			if sender_seat != _net_remote_await_seat:
				return
			_net_guest_bid_value = clampi(int(d.get("score", 0)), 0, 1)
			_net_guest_bid_ready = true
		"rob":
			if sender_seat != _net_remote_await_seat:
				return
			_net_guest_rob_value = bool(d.get("rob", false))
			_net_guest_rob_ready = true
		"pass":
			if _bidding_active or _winner >= 0:
				return
			if _turn != sender_seat:
				return
			if _last.is_empty():
				return
			_log_line_sync("%s [b]过[/b]" % _cat_name(sender_seat))
			_state_pass(sender_seat)
			_after_state_changed()
		"play":
			if _bidding_active or _winner >= 0:
				return
			if _turn != sender_seat:
				return
			var raw: Array = d.get("cards", []) as Array
			var sel: Array = []
			for x in raw:
				sel.append(int(x))
			var p: Dictionary = Rules.classify(sel)
			if not _is_valid_play_pattern(p):
				return
			if _last.is_empty():
				pass
			else:
				if not Rules.beats(_last, p):
					return
			_log_line_sync("%s 出牌：%s ｜ %s" % [_cat_name(sender_seat), _kind_name(p), CardDefs.format_cards_list(sel)])
			_state_play(sender_seat, sel, p)
			_after_state_changed()
		"timeout_lead":
			if _bidding_active or _winner >= 0:
				return
			if _turn != sender_seat:
				return
			if not _last.is_empty():
				return
			var hand: PackedInt32Array = _hands[sender_seat]
			if hand.is_empty():
				return
			var ctx: Dictionary = _make_ai_ctx(sender_seat)
			var lead: Array = DdzAi.find_free_lead(hand, ctx)
			if lead.is_empty():
				return
			var pat: Dictionary = Rules.classify(lead)
			_log_line_sync("[color=#ffb380]出牌超时[/color]（联网）自动出牌：%s ｜ %s" % [_kind_name(pat), CardDefs.format_cards_list(lead)])
			_state_play(sender_seat, lead, pat)
			_after_state_changed()
		"timeout_pass":
			if _bidding_active or _winner >= 0:
				return
			if _turn != sender_seat:
				return
			if _last.is_empty():
				return
			_log_line_sync("[color=#ffb380]出牌超时[/color]（联网）自动 [b]过[/b]")
			_state_pass(sender_seat)
			_after_state_changed()
		"settle_continue":
			if _settlement_layer.visible:
				_net_host_continue_gate = true
		"settle_menu":
			if _settlement_layer.visible:
				_net_host_menu_gate = true
		_:
			pass


func _online_on_play_time_expired() -> void:
	_online_deadline_msec = 0
	if _online_battle and not _net_is_host:
		var hub: Node = get_node_or_null("/root/OnlineSession")
		if hub != null and hub.has_method("send_client_action_async"):
			if _last.is_empty():
				hub.send_client_action_async({"action": "timeout_lead"})
			else:
				hub.send_client_action_async({"action": "timeout_pass"})
		return
	if _last.is_empty():
		var hand: PackedInt32Array = _hands[_local_seat()]
		if hand.is_empty():
			return
		var ctx: Dictionary = _make_ai_ctx(_local_seat())
		var lead: Array = DdzAi.find_free_lead(hand, ctx)
		if lead.is_empty():
			return
		var pat: Dictionary = Rules.classify(lead)
		_log_line_sync("[color=#ffb380]出牌超时[/color]，自动出牌：%s ｜ %s" % [_kind_name(pat), CardDefs.format_cards_list(lead)])
		_state_play(_local_seat(), lead, pat)
	else:
		_log_line_sync("[color=#ffb380]出牌超时[/color]，自动 [b]过[/b]")
		_state_pass(_local_seat())
	_after_state_changed()


func _process(_delta: float) -> void:
	if not _online_battle or _online_deadline_msec == 0:
		return
	if _winner >= 0 or _bidding_active or _turn != _local_seat():
		return
	var left: float = (_online_deadline_msec - Time.get_ticks_msec()) / 1000.0
	if left < 0.0:
		left = 0.0
	var tail: String = "过" if not _last.is_empty() else "出牌"
	if _status:
		_status.text = _build_status_text() + "\n[center][font_size=11][color=#ffb380]剩余 %.1f 秒 · 超时%s[/color][/center]" % [left, tail]


func _refresh_score_strip() -> void:
	var vals: Array[Label] = [_maocao_val0, _maocao_val1, _maocao_val2]
	for vs in range(mini(3, vals.size())):
		var lbl: Label = vals[vs]
		if lbl:
			var log_s: int = _logical_seat_for_view_slot(vs)
			lbl.text = str(int(_scores[log_s]))


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
	s += "[color=#a8e6cf]基础倍率（叫地主）[/color]   [font_size=15][b][color=#fff8e0]×%d[/color][/b][/font_size]  [color=#88bba0]（固定×1）[/color]\n" % _mult_base
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
		s += "[color=#c8e8d8]%s[/color]  [color=%s][b]%s%d[/b][/color]  [color=#88bba0]→ 游戏币[/color]  [b][color=#f5ffe8]%d[/color][/b]\n" % [_cat_name(i), col, dsign, d, int(_scores[i])]
	if _any_score_broke():
		s += "\n[center][color=#ffaa88]有玩家游戏币≤0，整局游戏结束。[/color][/center]"
	return s


func _run_settlement_flow() -> void:
	if _sfx_settlement_stream:
		_sfx_play(_sfx_settlement_stream)
	_apply_round_scores()
	await _persist_wallet_after_round_online_async()
	if _online_battle and _net_is_host:
		call_deferred("_net_broadcast_snapshot_if_host")
	if _settle_body:
		_settle_body.text = _format_settlement_bbcode()
	_settlement_layer.show()
	if _online_battle and _net_is_host:
		call_deferred("_net_broadcast_snapshot_if_host")
	_set_in_game_interactive(false)
	var broke := _any_score_broke()
	_btn_settle_continue.visible = not broke
	_btn_settle_menu.visible = broke
	if broke:
		if _online_battle and _net_is_host:
			_net_host_menu_gate = false
			while not _net_host_menu_gate:
				await get_tree().process_frame
			_net_host_menu_gate = false
		else:
			await _btn_settle_menu.pressed
		_settlement_layer.hide()
		if _online_battle and _net_is_host:
			call_deferred("_net_broadcast_snapshot_if_host")
		await _return_to_start_menu_async()
	else:
		if _online_battle and _net_is_host:
			_net_host_continue_gate = false
			while not _net_host_continue_gate:
				await get_tree().process_frame
			_net_host_continue_gate = false
		else:
			await _btn_settle_continue.pressed
		_settlement_layer.hide()
		if _online_battle and _net_is_host:
			call_deferred("_net_broadcast_snapshot_if_host")
		if not (_online_battle and not _net_is_host):
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
	if _server_authoritative:
		return
	if _online_battle and not _net_is_host:
		return
	if _winner >= 0:
		return
	if _turn == _local_seat():
		return
	if _bidding_active:
		return
	if _online_battle and _net_is_host and _net_is_human_controlled_seat(_turn):
		return
	var who: int = _turn
	await _log_line("%s 思考出牌中…" % _cat_name(who))
	await get_tree().create_timer(_AI_THINK_SEC).timeout
	await get_tree().create_timer(_AI_EXTRA_PAUSE_SEC).timeout
	if _winner >= 0:
		return
	if _turn == _local_seat():
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
	_seat_say(who, PlayLineBuilderScr.speech_line_pass())
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
	_seat_say(who, PlayLineBuilderScr.speech_line_for_play(pattern, card_ids))
	if who == _local_seat():
		_capture_human_play_starts(card_ids)
	else:
		_play_anim_starts_override.clear()
	_register_seen_cards(card_ids)
	_last_play_ids = card_ids.duplicate()
	var pk: int = int(pattern.get("kind", Rules.Kind.INVALID))
	if pk == Rules.Kind.BOMB:
		_sfx_play(_sfx_play_stream)
		_play_bomb_count += 1
		_mult_play *= 2
		_sync_round_multiplier()
		_sfx_play_bomb()
		_log_line_sync("炸弹！出牌倍率×%d ｜ 当前总倍率：×%d" % [_mult_play, _round_multiplier])
		_refresh_match_title()
	elif pk == Rules.Kind.ROCKET:
		_sfx_play(_sfx_play_stream)
		_play_rocket_count += 1
		_mult_play *= 4
		_sync_round_multiplier()
		_sfx_play_rocket()
		_log_line_sync("王炸！出牌倍率×%d ｜ 当前总倍率：×%d" % [_mult_play, _round_multiplier])
		_refresh_match_title()
	else:
		_sfx_play(_sfx_play_stream)
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
		if is_instance_valid(_btn_settings_redeal):
			_btn_settings_redeal.disabled = true
	else:
		_status.text = _build_status_text()
		if _bidding_active or _in_rob_phase:
			if _title:
				_title.text = "斗地主 · 抢地主中…" if _in_rob_phase else "斗地主 · 叫地主中…"
		else:
			_refresh_match_title()
	_sync_phase_info_bidding_strip()
	for c in _hand_row.get_children():
		c.queue_free()
	_card_buttons.clear()
	_card_select_tweens.clear()
	var hand0: PackedInt32Array = _hands[_local_seat()]
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
	var show_badges: bool = not _bidding_active and not _in_rob_phase
	for vs in range(3):
		var log_l: int = _logical_seat_for_view_slot(vs)
		_landlord_badges[vs].visible = show_badges and log_l == _landlord


func _refresh_opponent_strips() -> void:
	for c in _opp_p2.get_children():
		c.queue_free()
	for c in _opp_p1.get_children():
		c.queue_free()
	var me: int = _local_seat()
	var s_right: int = (me + 1) % 3
	var s_left: int = (me + 2) % 3
	var n2: int = int(_hands[s_left].size())
	var n1: int = int(_hands[s_right].size())
	_opp_lbl2.text = "%d张" % n2
	_opp_lbl1.text = "%d张" % n1
	var show2: int = mini(8, maxi(1, n2))
	var show1: int = mini(8, maxi(1, n1))
	for i in show2:
		var tr2 := TextureRect.new()
		tr2.texture = load(CardDefs.texture_path_back()) as Texture2D
		tr2.ignore_texture_size = true
		tr2.custom_minimum_size = Vector2(38, 52)
		tr2.expand_mode = TextureRect.EXPAND_FIT_WIDTH_PROPORTIONAL
		tr2.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		_opp_p2.add_child(tr2)
	for i in show1:
		var tr1 := TextureRect.new()
		tr1.texture = load(CardDefs.texture_path_back()) as Texture2D
		tr1.ignore_texture_size = true
		tr1.custom_minimum_size = Vector2(38, 52)
		tr1.expand_mode = TextureRect.EXPAND_FIT_WIDTH_PROPORTIONAL
		tr1.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		_opp_p1.add_child(tr1)


func _build_status_text() -> String:
	if _bidding_active or _in_rob_phase:
		if _in_rob_phase:
			return "[center][color=#ffe9c2][font_size=14]抢地主阶段[/font_size][/color]\n[font_size=12][color=#e8f6ef]轮到你时，点「抢地主」或「不抢」[/color][/font_size]\n[font_size=11][color=#8fbcaa]未叫牌的玩家不可抢[/color][/font_size][/center]"
		var first_line: String = "本局首家叫牌：—"
		if _server_authoritative:
			var crs_st: int = int(round(float(_srv_public_buf.get("callRoundStartSeat", -1))))
			if crs_st >= 0 and crs_st <= 2:
				first_line = "本局首家叫牌：%s" % _cat_name(crs_st)
		elif _local_call_round_start_seat >= 0:
			first_line = "本局首家叫牌：%s" % _cat_name(_local_call_round_start_seat)
		return "[center][color=#c8f5e0][font_size=14]叫地主阶段[/font_size][/color]\n[font_size=12][color=#eefaf3]轮到你时选「不叫」或「叫地主」[/color][/font_size]\n[font_size=11][color=#9ec9b0]%s[/color][/font_size][/center]" % first_line
	var name_turn: String = _cat_name(_turn)
	return "[center][color=#a8dcc4]等待出牌：[/color][color=#fffef0]%s[/color][/center]" % name_turn


func _kind_name(p: Dictionary) -> String:
	return PlayLineBuilderScr.kind_display_name(p)


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
	var mine: bool = (_winner < 0 and _turn == _local_seat() and not _bidding_active)
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
	if _turn != _local_seat() or _winner >= 0 or _bidding_active:
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
	if _server_authoritative:
		var hubs: Node = get_node_or_null("/root/OnlineSession")
		if hubs != null and hubs.has_method("send_ddz_authoritative_async"):
			hubs.send_ddz_authoritative_async(12, {"cards": sel})
		return true
	if _online_battle and not _net_is_host:
		var hub: Node = get_node_or_null("/root/OnlineSession")
		if hub != null and hub.has_method("send_client_action_async"):
			hub.send_client_action_async({"action": "play", "cards": sel})
		return true
	_log_line_sync("你（%s）出牌：%s ｜ %s" % [_cat_name(_local_seat()), _kind_name(p), CardDefs.format_cards_list(sel)])
	_state_play(_local_seat(), sel, p)
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
	if _turn != _local_seat() or _winner >= 0 or _bidding_active:
		return
	var hand: PackedInt32Array = _hands[_local_seat()]
	var ctx: Dictionary = _make_ai_ctx(_local_seat())
	var rec: Array = []
	if _last.is_empty():
		rec = DdzAi.find_free_lead(hand, ctx)
	else:
		rec = DdzAi.find_follow(hand, _last, ctx)
	if rec.is_empty():
		if _last.is_empty():
			if _status:
				_status.text = "[center][color=#ffd8a0]提示[/color] [color=#fff5e6]暂无可出[/color][/center]"
		else:
			var lk: int = int(_last.get("kind", 0))
			if lk == Rules.Kind.ROCKET:
				if _status:
					_status.text = "[center][color=#ffd8a0]提示[/color] [color=#fff5e6]王炸请「过」[/color][/center]"
			elif DdzAi.is_farmer_yield_pass(ctx, _last):
				if _status:
					_status.text = "[center][color=#ffd8a0]提示[/color] [color=#fff5e6]建议「过」[/color][/center]"
			else:
				if _status:
					_status.text = "[center][color=#ffd8a0]提示[/color] [color=#fff5e6]请「过」[/color][/center]"
		return
	_apply_ids_to_hand_selection(rec)
	if _status:
		_status.text = _build_status_text()


func _on_pass_pressed() -> void:
	if _turn != _local_seat() or _winner >= 0 or _bidding_active:
		return
	if _last.is_empty():
		return
	if _server_authoritative:
		var hubp: Node = get_node_or_null("/root/OnlineSession")
		if hubp != null and hubp.has_method("send_ddz_authoritative_async"):
			hubp.send_ddz_authoritative_async(13, {})
		return
	if _online_battle and not _net_is_host:
		var hub: Node = get_node_or_null("/root/OnlineSession")
		if hub != null and hub.has_method("send_client_action_async"):
			hub.send_client_action_async({"action": "pass"})
		return
	_log_line_sync("%s [b]过[/b]" % _cat_name(_local_seat()))
	_state_pass(_local_seat())
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


## RichTextLabel 追加后须等布局再滚到底，否则 max_value 未更新
func _ensure_game_log_scroll_bottom() -> void:
	await get_tree().process_frame
	await get_tree().process_frame
	var scroll := _game_log_scroll()
	if scroll and is_instance_valid(scroll):
		var sb := scroll.get_v_scroll_bar()
		if sb:
			scroll.scroll_vertical = int(sb.max_value)


func _log_line_sync(s: String) -> void:
	print("[Game] ", s)
	if _online_battle and _net_is_host:
		_net_ring_push_line(s)
	if _game_log:
		_game_log.append_text(s + "\n")
		_ensure_game_log_scroll_bottom()


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
	if who == _local_seat() and _play_anim_starts_override.size() == n:
		return _play_anim_starts_override.duplicate()
	var sep: float = 8.0
	var r: Rect2
	var mep: int = _local_seat()
	if who == mep:
		r = _hand_row.get_global_rect()
	elif who == (mep + 1) % 3:
		r = _opp_p1.get_global_rect()
	else:
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
	var row: HBoxContainer = _play_cards_rows[_view_slot_for_logical(who)]
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
	var sep: float = 8.0 if who == _local_seat() else 6.0
	var zone: Control = _play_cards_rows[_view_slot_for_logical(who)].get_parent() as Control
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
	var row: HBoxContainer = _play_cards_rows[_view_slot_for_logical(who)]
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
	var who_vs: int = _view_slot_for_logical(who)
	_play_kind_labels[who_vs].text = "%s · %s" % [_kind_name(_last), _cat_name(who)]
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
