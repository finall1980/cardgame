extends RefCounted
class_name GuandanPlayLine
## 头像气泡：按服务端 kind（数值）与出牌 ids 生成本地化短句；与 `match_state` GD_KIND_* 一致。

const Defs := preload("res://scripts/guandan/card_defs.gd")

# 与 Modules/src/games/guandan/match_state.ts 一致
const K_SINGLE := 2
const K_PAIR := 3
const K_TRIPLE := 4
const K_TRIPLE_WITH_PAIR := 5
const K_STRAIGHT := 6
const K_PAIR_STRAIGHT := 7
const K_TRIPLE_STRAIGHT := 8
const K_STRAIGHT_FLUSH := 9
const K_BOMB := 10
const K_KING_BOMB := 11


static func speech_pass() -> String:
	return "过"


## JSON 可能把 kind 变成 float（如 2.0），str(2.0).is_valid_int() 为 false，会误判成 0 → 只显示「出牌」
static func _kind_to_int(kind_v: Variant) -> int:
	if kind_v == null:
		return 0
	var t: int = typeof(kind_v)
	if t == TYPE_INT:
		return int(kind_v)
	if t == TYPE_FLOAT:
		return int(round(float(kind_v)))
	var s: String = str(kind_v)
	if s.is_valid_int():
		return int(s)
	if s.is_valid_float():
		return int(round(float(s)))
	match s:
		"single":
			return K_SINGLE
		"pair":
			return K_PAIR
		"triple":
			return K_TRIPLE
		"triple_pair":
			return K_TRIPLE_WITH_PAIR
		"straight":
			return K_STRAIGHT
		"pair_straight":
			return K_PAIR_STRAIGHT
		"triple_straight":
			return K_TRIPLE_STRAIGHT
		"straight_flush":
			return K_STRAIGHT_FLUSH
		"bomb4", "bomb5", "bomb6", "bomb7", "bomb8":
			return K_BOMB
		"king_bomb":
			return K_KING_BOMB
		_:
			return 0


static func speech_play(last_d: Dictionary, ids: Array, level_active_rr: int = 12) -> String:
	if ids.is_empty():
		return "出牌"
	var kind_v: Variant = last_d.get("kind", 0)
	var kind: int = _kind_to_int(kind_v)
	var bomb_t: int = int(last_d.get("bomb_tier", 0))
	var main_v: int = int(last_d.get("main", 0))
	if kind == K_KING_BOMB:
		return "天王炸"
	if kind == K_STRAIGHT_FLUSH:
		if main_v <= -50:
			return "同花顺（小顺A2345）"
		return "同花顺"
	if kind == K_BOMB:
		return _speech_bomb(kind, int(last_d.get("len", ids.size())), bomb_t)
	match kind:
		K_SINGLE:
			return Defs.label_of(int(ids[0])) # 花色 + 点数
		K_PAIR:
			return "一对" + _rank_cn(int(ids[0]), level_active_rr)
		K_TRIPLE:
			return "三个" + _rank_cn(int(ids[0]), level_active_rr)
		K_TRIPLE_WITH_PAIR:
			return "三带二"
		K_STRAIGHT:
			if main_v <= -50:
				return "顺子（小顺A2345）"
			return "顺子"
		K_PAIR_STRAIGHT:
			return "连对"
		K_TRIPLE_STRAIGHT:
			return "钢板"
		_:
			return "出牌"


## 用于左上角出牌记录：牌型短述 + 按当前级牌顺序排列的具体牌（含花色）
static func format_sorted_card_spans(ids: Array, level_active_rr: int) -> String:
	if ids.is_empty():
		return ""
	var arr: Array = []
	for x in ids:
		arr.append(int(x))
	arr = Defs.sort_hand(arr, level_active_rr)
	var parts: PackedStringArray = []
	for id in arr:
		parts.append(Defs.label_of(int(id)))
	return " ".join(parts)


## 记录行正文（无玩家名）。单张不重复写两次「型 + 牌」
static func play_log_descriptive_text(last_d: Dictionary, ids: Array, level_active_rr: int) -> String:
	if ids.is_empty():
		return "出牌"
	var kind: int = _kind_to_int(last_d.get("kind", 0))
	if kind == K_SINGLE:
		return format_sorted_card_spans(ids, level_active_rr)
	var head: String = speech_play(last_d, ids, level_active_rr)
	var cards: String = format_sorted_card_spans(ids, level_active_rr)
	if cards.is_empty():
		return head
	return "%s：%s" % [head, cards]


static func _speech_bomb(_kind: int, nlen: int, bomb_t: int) -> String:
	if bomb_t == 7:
		return "天王炸"
	if nlen >= 4 and nlen <= 8:
		var names: Array[String] = ["四", "五", "六", "七", "八"]
		var i: int = nlen - 4
		if i >= 0 and i < names.size():
			return names[i] + "炸"
	if bomb_t >= 1 and bomb_t <= 6:
		var bn: Array[String] = ["四", "五", "同花", "六", "七", "八"]
		var j: int = bomb_t - 1
		if j >= 0 and j < bn.size() and j != 2:
			return bn[j] + "炸"
		if j == 2:
			return "同花顺"
	return "炸弹"


## 点数字面（3—2、小王大王交给 label_of）
static func _rank_cn(id: int, _level_active_rr: int) -> String:
	if Defs.is_joker(id):
		return Defs.label_of(id)
	var rr: int = Defs.raw_rank(id)
	if rr >= 0 and rr < Defs.RAW_RANK_LABELS.size():
		# 展示用 T→10
		var s: String = Defs.RAW_RANK_LABELS[rr]
		if s == "T":
			return "10"
		return s
	return Defs.label_of(id)
