extends RefCounted
class_name GuandanHintSelect
## 轻量「提示」：自由领出 / 跟牌时选最小可压牌（单张、对子、三张）；复杂牌型请自行选牌。

const Defs := preload("res://scripts/guandan/card_defs.gd")

const K_SINGLE := 2
const K_PAIR := 3
const K_TRIPLE := 4


static func suggest_ids(snapshot: Dictionary, hand: Array[int]) -> Array[int]:
	if hand.is_empty():
		return []
	var lvl: int = int(snapshot.get("level_active", 12))
	var last_v: Variant = snapshot.get("last", null)
	var sorted: Array[int] = hand.duplicate()
	sorted.sort_custom(func(a: int, b: int) -> bool:
		var va: int = Defs.rank_value(int(a), lvl)
		var vb: int = Defs.rank_value(int(b), lvl)
		if va != vb:
			return va < vb
		return int(a) < int(b)
	)
	if last_v == null or not (last_v is Dictionary):
		return [sorted[0]]
	var last: Dictionary = last_v
	var lk: int = int(last.get("kind", 0))
	var lm: int = int(last.get("main", -9999))
	var lb: int = int(last.get("bomb_tier", 0))
	if lb > 0:
		return []
	match lk:
		K_SINGLE:
			for id in sorted:
				if Defs.rank_value(int(id), lvl) > lm:
					return [int(id)]
		K_PAIR:
			return _suggest_pair(sorted, lvl, lm)
		K_TRIPLE:
			return _suggest_triple(sorted, lvl, lm)
		_:
			return []
	return []


static func _suggest_pair(sorted: Array[int], lvl: int, lm: int) -> Array[int]:
	var by_rr: Dictionary = {}
	for id in sorted:
		var rr: int = Defs.raw_rank(id)
		if rr >= 13:
			continue
		if not by_rr.has(rr):
			by_rr[rr] = []
		(by_rr[rr] as Array).append(int(id))
	var keys: Array = by_rr.keys()
	keys.sort_custom(func(a: Variant, b: Variant) -> bool:
		return Defs.rank_value_from_raw(int(a), lvl) < Defs.rank_value_from_raw(int(b), lvl)
	)
	for k in keys:
		var rr: int = int(k)
		var arr: Array = by_rr[rr] as Array
		if arr.size() < 2:
			continue
		var rv: int = Defs.rank_value_from_raw(rr, lvl)
		if rv > lm:
			return [int(arr[0]), int(arr[1])]
	return []


static func _suggest_triple(sorted: Array[int], lvl: int, lm: int) -> Array[int]:
	var by_rr: Dictionary = {}
	for id in sorted:
		var rr: int = Defs.raw_rank(id)
		if rr >= 13:
			continue
		if not by_rr.has(rr):
			by_rr[rr] = []
		(by_rr[rr] as Array).append(int(id))
	var keys: Array = by_rr.keys()
	keys.sort_custom(func(a: Variant, b: Variant) -> bool:
		return Defs.rank_value_from_raw(int(a), lvl) < Defs.rank_value_from_raw(int(b), lvl)
	)
	for k in keys:
		var rr: int = int(k)
		var arr: Array = by_rr[rr] as Array
		if arr.size() < 3:
			continue
		var rv: int = Defs.rank_value_from_raw(rr, lvl)
		if rv > lm:
			return [int(arr[0]), int(arr[1]), int(arr[2])]
	return []


## 进贡：选非 ♥ 级牌中点力最大的一张
static func suggest_tribute_id(hand: Array[int], level_rr: int) -> int:
	var best: int = -1
	var best_val: int = -99999
	for id in hand:
		if Defs.is_heart_level_card(int(id), level_rr):
			continue
		var v: int = Defs.rank_value(int(id), level_rr)
		if v > best_val:
			best_val = v
			best = int(id)
	if best < 0:
		for id in hand:
			if Defs.is_heart_level_card(int(id), level_rr):
				return int(id)
	return best


## 还贡：3..10；非打 2 时普通 2 可还；禁王、红心级牌、JQKA
static func suggest_return_id(hand: Array[int], level_rr: int) -> int:
	var best: int = -1
	var best_val: int = 99999
	for id in hand:
		if not Defs.is_valid_return_card(int(id), level_rr):
			continue
		var v: int = Defs.rank_value(int(id), level_rr)
		if v < best_val:
			best_val = v
			best = int(id)
	return best
