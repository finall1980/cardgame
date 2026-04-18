extends Node
class_name CardDefs

const COUNT = 54
const RANKS_PER_SUIT = 13
## 与 `suit_of` 一致：方块、梅花、红桃、黑桃 → 资源前缀 D/C/H/S
const PLAYINGCARD_SUIT_PREFIX: Array[String] = ["D", "C", "H", "S"]


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


## `rank_of` 为斗地主顺序：0=3 … 7=10, 8=J, 9=Q, 10=K, 11=A, 12=2 → 资源编号 1–13（A=1, 2=2, 3–10, J=11, Q=12, K=13）
static func rank_to_playingcard_asset_num(rank: int) -> int:
	if rank >= 0 and rank <= 7:
		return rank + 3
	if rank == 8:
		return 11
	if rank == 9:
		return 12
	if rank == 10:
		return 13
	if rank == 11:
		return 1
	if rank == 12:
		return 2
	return 1


static func texture_path_back(_which: int = 1) -> String:
	return "res://assets/playingcards/Back-B.png"


static func texture_path_for(card_id: int) -> String:
	if card_id < 0 or card_id >= COUNT:
		push_error("Invalid card_id: %s" % card_id)
		return ""
	if card_id == 52:
		return "res://assets/playingcards/X-B.png"
	if card_id == 53:
		return "res://assets/playingcards/X-R.png"
	var suit: int = suit_of(card_id)
	var rank: int = rank_of(card_id)
	var num: int = rank_to_playingcard_asset_num(rank)
	return "res://assets/playingcards/%s-%d.png" % [PLAYINGCARD_SUIT_PREFIX[suit], num]


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
