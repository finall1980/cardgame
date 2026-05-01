extends RefCounted
class_name GuandanCardDefs
## 掼蛋牌面工具：id 空间 0..107（与服务端 `Modules/src/games/guandan/rules.ts` 一致）。
##   baseId = id % 54
##     - 0..51 花色牌（suit * 13 + rawRank；0♠ 1♥ 2♣ 3♦；rawRank 0..12 对应 3..A..2）
##     - 52    小王 (rawRank 13)
##     - 53    大王 (rawRank 14)
##
## M1+：贴图沿用 `res://assets/Cards/card{Spades|Hearts|Clubs|Diamonds}{3..A,2}.png` 与 `cardJokerB/R.png`（斗地主同款），
## 掼蛋花色顺序（0♠ 1♥ 2♣ 3♦）→ 文件夹名数组 `CARD_FOLDER_BY_GD_SUIT`。

const SUIT_GLYPHS: PackedStringArray = ["♠", "♥", "♣", "♦"]
const RAW_RANK_LABELS: PackedStringArray = ["3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A", "2"]
## 掼蛋 suit index → DDZ 贴图目录后缀；0♠ 1♥ 2♣ 3♦
const CARD_FOLDER_BY_GD_SUIT: PackedStringArray = ["Spades", "Hearts", "Clubs", "Diamonds"]
## rawRank 0..12 → 文件名数字/字母（3..10/J/Q/K/A/2）
const CARD_RANK_SUFFIX: PackedStringArray = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"]
const CARD_BACK_PATH: String = "res://assets/Cards/cardBack_red5.png"
## rankValue：3→0, 4→1, ..., T→7, J→12 (>2), Q→13, 级牌→14, 2→13(非级), 小王→15, 大王→16
## 但本文件不重复服务端 classify，只需提供 sort key（以 levelRank 调整）。

const RR_SMALL_JOKER := 13
const RR_BIG_JOKER := 14
const RR_A := 11
const RR_2 := 12


static func base_id(id: int) -> int:
	return id if id < 54 else id - 54


static func raw_rank(id: int) -> int:
	var b: int = base_id(id)
	if b < 52:
		return b % 13
	return 13 + (b - 52)


## 花色：-1 表示王
static func suit(id: int) -> int:
	var b: int = base_id(id)
	if b >= 52:
		return -1
	@warning_ignore("integer_division")
	return b / 13


static func is_heart_level_card(id: int, level_rank: int) -> bool:
	return suit(id) == 1 and raw_rank(id) == level_rank


## 还贡：3～10 点（raw 0..7）；非「打 2」时普通 2（非红心级牌）可还贡；禁止 JQKA、王、红心级牌。
static func is_valid_return_card(id: int, level_rank: int) -> bool:
	var rr: int = raw_rank(id)
	if rr >= RR_SMALL_JOKER:
		return false
	if is_heart_level_card(id, level_rank):
		return false
	if rr <= 7:
		return true
	if rr == RR_2 and level_rank != RR_2:
		return true
	return false


## 与服务端 `gdRankValueFromRaw` 保持一致（纯函数，供客户端排序 / 提示使用）。
static func rank_value(id: int, level_rank: int) -> int:
	return rank_value_from_raw(raw_rank(id), level_rank)


static func rank_value_from_raw(rr: int, level_rank: int) -> int:
	if rr == 14:
		return 16
	if rr == 13:
		return 15
	if rr == level_rank:
		return 14
	# 非打 2 时，普通 2 全场最小
	if rr == 12:
		return -1
	if rr == 11:
		return 12
	return rr


## 文字标签：例如 "♠K" / "♥2" / "小王"。
static func label_of(id: int) -> String:
	var rr: int = raw_rank(id)
	if rr == RR_SMALL_JOKER:
		return "小王"
	if rr == RR_BIG_JOKER:
		return "大王"
	var s: int = suit(id)
	var s_str: String = SUIT_GLYPHS[s] if s >= 0 and s < SUIT_GLYPHS.size() else "?"
	return s_str + RAW_RANK_LABELS[rr]


## 是否小/大王
static func is_joker(id: int) -> bool:
	var rr: int = raw_rank(id)
	return rr == RR_SMALL_JOKER or rr == RR_BIG_JOKER


## 返回贴图路径；王单独处理；正常牌按花色+点数组合。
static func texture_path_for(id: int) -> String:
	var rr: int = raw_rank(id)
	if rr == RR_SMALL_JOKER:
		return "res://assets/Cards/cardJokerB.png"
	if rr == RR_BIG_JOKER:
		return "res://assets/Cards/cardJokerR.png"
	var s: int = suit(id)
	if s < 0 or s >= CARD_FOLDER_BY_GD_SUIT.size():
		return ""
	if rr < 0 or rr >= CARD_RANK_SUFFIX.size():
		return ""
	return "res://assets/Cards/card%s%s.png" % [CARD_FOLDER_BY_GD_SUIT[s], CARD_RANK_SUFFIX[rr]]


## 排序：按当前 level_rank 下的 rank_value 升序；相同点按原 id 稳定。
static func sort_hand(hand: Array, level_rank: int) -> Array:
	var arr: Array = hand.duplicate()
	arr.sort_custom(func(a: int, b: int) -> bool:
		var va: int = rank_value(int(a), level_rank)
		var vb: int = rank_value(int(b), level_rank)
		if va != vb:
			return va < vb
		return int(a) < int(b)
	)
	return arr
