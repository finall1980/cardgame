extends Node
class_name CardDefs

const COUNT = 54
const RANKS_PER_SUIT = 13
const SUIT_NAMES = ["Diamonds", "Clubs", "Hearts", "Spades"]


static func is_joker(card_id: int) -> bool:
	return card_id >= 52


static func suit_of(card_id: int) -> int:
	if card_id < 52:
		return int(card_id / RANKS_PER_SUIT)
	return -1


static func rank_of(card_id: int) -> int:
	if card_id < 52:
		return card_id % RANKS_PER_SUIT
	return (card_id - 52 + 13)


static func ddz_rank_value(card_id: int) -> int:
	if card_id >= 52:
		return 13 + (card_id - 52)
	return card_id % RANKS_PER_SUIT


static func rank_to_filename_suffix(rank: int) -> String:
	if rank >= 0 and rank <= 7:
		return str(3 + rank)
	if rank == 8:
		return "J"
	if rank == 9:
		return "Q"
	if rank == 10:
		return "K"
	if rank == 11:
		return "ACE"
	if rank == 12:
		return "2"
	return ""


static func texture_path_back(which: int = 1) -> String:
	var w: int = clampi(which, 1, 5)
	return "res://CardsAssets/Back_%d.png" % w


static func texture_path_for(card_id: int) -> String:
	if card_id < 0 or card_id >= COUNT:
		push_error("Invalid card_id: %s" % card_id)
		return ""
	# 52=小王 53=大王；资源文件名与牌面约定相反时在此对调贴图
	if card_id == 52:
		return "res://CardsAssets/Joker_2.png"
	if card_id == 53:
		return "res://CardsAssets/Joker_1.png"
	var suit: int = suit_of(card_id)
	var rank: int = rank_of(card_id)
	var suf: String = rank_to_filename_suffix(rank)
	return "res://CardsAssets/%s_%s.png" % [SUIT_NAMES[suit], suf]


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
