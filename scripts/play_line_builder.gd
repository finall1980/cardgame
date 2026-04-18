extends RefCounted
class_name PlayLineBuilder
## 出牌/过牌时头像气泡台词；与 UI 牌型名一致的可复用文案。
const Rules = preload("res://scripts/ddz_rules.gd")
const _CD = preload("res://scripts/card_defs.gd")


static func _suit_zh(suit_idx: int) -> String:
	match suit_idx:
		0:
			return "方块"
		1:
			return "梅花"
		2:
			return "红桃"
		3:
			return "黑桃"
		_:
			return ""


static func speech_line_pass() -> String:
	return "过"


static func speech_line_for_play(pattern: Dictionary, card_ids: Array) -> String:
	var k: int = int(pattern.get("kind", Rules.Kind.INVALID))
	match k:
		Rules.Kind.SINGLE:
			return _line_single(card_ids)
		Rules.Kind.PAIR:
			return _line_pair(card_ids)
		_:
			return kind_display_name(pattern)


static func _line_single(card_ids: Array) -> String:
	if card_ids.is_empty():
		return ""
	var id: int = int(card_ids[0])
	if _CD.is_joker(id):
		return _CD.ddz_rank_to_label(_CD.ddz_rank_value(id))
	var s: String = _suit_zh(_CD.suit_of(id))
	var r: String = _CD.ddz_rank_to_label(_CD.ddz_rank_value(id))
	return s + r


static func _line_pair(card_ids: Array) -> String:
	if card_ids.size() < 2:
		return ""
	var r: int = _CD.ddz_rank_value(int(card_ids[0]))
	return "一对%s" % _CD.ddz_rank_to_label(r)


## 与 `main.gd` 中牌型展示名保持一致，供气泡「其他牌型」及后续复用。
static func kind_display_name(p: Dictionary) -> String:
	var k: int = int(p.get("kind", 0))
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
			var kk: int = int(p.get("extra", 0))
			return "飞机(%d连三)" % kk
		Rules.Kind.PLANE_WITH_WINGS:
			var exw: int = int(p.get("extra", 0))
			var kk2: int = exw >> 5
			var pw: int = exw & 31
			return "飞机带翅(%d连三·%d对翼)" % [kk2, pw]
		_:
			return "—"
