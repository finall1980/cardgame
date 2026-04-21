extends Node
class_name CardDefs

const COUNT = 54
const RANKS_PER_SUIT = 13
## 与 `suit_of` 一致：方块、梅花、红桃、黑桃 → `assets/Cards/card{Diamonds|Clubs|Hearts|Spades}{牌面}.png`
const CARDS_SUIT_FOLDER: Array[String] = ["Diamonds", "Clubs", "Hearts", "Spades"]
## 兼容旧路径命名（仅文档/外部引用）
const PLAYINGCARD_SUIT_PREFIX: Array[String] = ["D", "C", "H", "S"]
## 与 `suit_of` 一致：方块、梅花、红桃、黑桃
const SUIT_NAMES_ZH: Array[String] = ["方块", "梅花", "红桃", "黑桃"]


static func suit_name_zh(suit_idx: int) -> String:
	if suit_idx >= 0 and suit_idx < SUIT_NAMES_ZH.size():
		return String(SUIT_NAMES_ZH[suit_idx])
	return ""


static func is_joker(card_id: int) -> bool:
	return card_id >= 52


static func suit_of(card_id: int) -> int:
	if card_id < 52:
		return int(card_id / float(RANKS_PER_SUIT))
	return -1


static func rank_of(card_id: int) -> int:
	if card_id < 52:
		return card_id % RANKS_PER_SUIT
	return (card_id - 52 + 13)


static func ddz_rank_value(card_id: int) -> int:
	if card_id >= 52:
		return 13 + (card_id - 52)
	return card_id % RANKS_PER_SUIT


## 斗地主 rank（0=3 … 12=2）→ `cardSpades7` 等文件名中的牌面部分
static func rank_to_cards_filename_suffix(rank: int) -> String:
	if rank >= 0 and rank <= 7:
		return str(rank + 3)
	if rank == 8:
		return "J"
	if rank == 9:
		return "Q"
	if rank == 10:
		return "K"
	if rank == 11:
		return "A"
	if rank == 12:
		return "2"
	return "A"


const _CARD_BACK_PATHS: Array[String] = [
	"res://assets/Cards/cardBack_blue5.png",
	"res://assets/Cards/cardBack_red5.png",
	"res://assets/Cards/cardBack_green5.png",
]
## 当前局牌背（每局 `_run_new_round` 或权威快照新 `dealSeed` 时随机）
static var _round_card_back_path: String = _CARD_BACK_PATHS[0]


static func pick_random_card_back_for_round() -> void:
	_round_card_back_path = _CARD_BACK_PATHS[randi() % _CARD_BACK_PATHS.size()]


static func texture_path_back(_which: int = 1) -> String:
	return _round_card_back_path


static func texture_path_for(card_id: int) -> String:
	if card_id < 0 or card_id >= COUNT:
		push_error("Invalid card_id: %s" % card_id)
		return ""
	## 52 小王 · 53 大王（与牌力一致：大王更大）
	if card_id == 52:
		return "res://assets/Cards/cardJokerB.png"
	if card_id == 53:
		return "res://assets/Cards/cardJokerR.png"
	var suit: int = suit_of(card_id)
	var rank: int = rank_of(card_id)
	var suf: String = rank_to_cards_filename_suffix(rank)
	return "res://assets/Cards/card%s%s.png" % [CARDS_SUIT_FOLDER[suit], suf]


static func make_full_deck() -> PackedInt32Array:
	var a = PackedInt32Array()
	a.resize(COUNT)
	for i in range(COUNT):
		a[i] = i
	return a


static func ddz_rank_to_label(r: int) -> String:
	if r == 13:
		return "小王"
	if r == 14:
		return "大王"
	var labels = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"]
	if r >= 0 and r < labels.size():
		return labels[r]
	return "?"


static func format_card_short(card_id: int) -> String:
	if card_id >= 52:
		return "小王" if card_id == 52 else "大王"
	var suits: Array[String] = ["♦", "♣", "♥", "♠"]
	var r: int = ddz_rank_value(card_id)
	var s: String = suits[suit_of(card_id)]
	return s + ddz_rank_to_label(r)


static func format_cards_list(ids: Array) -> String:
	if ids.is_empty():
		return ""
	var out := ""
	var i := 0
	for id in ids:
		if i > 0:
			out += " "
		out += format_card_short(int(id))
		i += 1
	return out
