extends RefCounted
## AI 出牌策略：首家自由出牌、跟牌仍由 ddz_ai.gd 处理。
const Rules = preload("res://scripts/ddz_rules.gd")


static func _buckets(hand: PackedInt32Array) -> Dictionary:
	var b: Dictionary = {}
	for cid in hand:
		var r := CardDefs.ddz_rank_value(cid)
		if not b.has(r):
			b[r] = []
		(b[r] as Array).append(cid)
	for k in b.keys():
		(b[k] as Array).sort()
	return b


## 5 张顺子（不含 2 与王牌），取「高张最小」的一条。
static func _weakest_straight_five(b: Dictionary) -> Array:
	for top in range(4, 12):
		var bot: int = top - 4
		if bot < 0:
			continue
		var out: Array = []
		var ok := true
		for r in range(bot, top + 1):
			if r == 12 or r >= 13:
				ok = false
				break
			var arr: Array = b.get(r, []) as Array
			if arr.size() < 1:
				ok = false
				break
			out.append(arr[0])
		if ok:
			return out
	return []


static func _weakest_pair(b: Dictionary) -> Array:
	for r in range(0, 15):
		var arr: Array = b.get(r, []) as Array
		if arr.size() >= 2:
			return [arr[0], arr[1]]
	return []


static func _weakest_triple(b: Dictionary) -> Array:
	for r in range(0, 15):
		var arr: Array = b.get(r, []) as Array
		if arr.size() >= 3:
			return [arr[0], arr[1], arr[2]]
	return []


static func _weakest_single_from_hand(hand: PackedInt32Array, _b: Dictionary) -> Array:
	var best: int = int(hand[0])
	var best_v := CardDefs.ddz_rank_value(best)
	for i in range(1, hand.size()):
		var cid := int(hand[i])
		var v := CardDefs.ddz_rank_value(cid)
		if v < best_v or (v == best_v and cid < best):
			best = cid
			best_v = v
	return [best]


## 仅一张的散牌（不拆对子/三张），优先于对子打出，利于保留对子与大牌结构。
static func _weakest_orphan_single(b: Dictionary) -> Array:
	for r in range(15):
		var arr: Array = b.get(r, []) as Array
		if arr.size() == 1:
			return [arr[0]]
	return []


const _STYLE_AGG := 1


static func _seen_rank_must_play(b: Dictionary, ctx: Dictionary) -> Array:
	var seen: Array = ctx.get("seen_rank", []) as Array
	if seen.size() < 15:
		return []
	for r in range(13):
		var played: int = int(seen[r]) if r < seen.size() else 0
		if played == 3:
			var arr2: Array = b.get(r, []) as Array
			if arr2.size() >= 1:
				return [arr2[0]]
	return []


## 首家：普通/怂 — 顺子 → 散张 → 小对 → 小三张 → 记牌必出 → 最小单张。
## 凶（ai_style=1）— 顺子 → 小对 → 小三张 → 散张 → … 偏快抢节奏。
static func choose_free_lead(hand: PackedInt32Array, ctx: Dictionary = {}) -> Array:
	if hand.is_empty():
		return []
	var b: Dictionary = _buckets(hand)
	var st := _weakest_straight_five(b)
	var straight_ok := false
	if not st.is_empty():
		var pat: Dictionary = Rules.classify(st)
		straight_ok = pat.kind == Rules.Kind.STRAIGHT

	var style := int(ctx.get("ai_style", 0))
	if style == _STYLE_AGG:
		if straight_ok:
			return st
		var pr_a := _weakest_pair(b)
		if not pr_a.is_empty():
			return pr_a
		var tr_a := _weakest_triple(b)
		if not tr_a.is_empty():
			return tr_a
		var os_a := _weakest_orphan_single(b)
		if not os_a.is_empty():
			return os_a
		var sn_a := _seen_rank_must_play(b, ctx)
		if not sn_a.is_empty():
			return sn_a
		return _weakest_single_from_hand(hand, b)

	if straight_ok:
		return st
	var os := _weakest_orphan_single(b)
	if not os.is_empty():
		return os
	var pr := _weakest_pair(b)
	if not pr.is_empty():
		return pr
	var triple_pl := _weakest_triple(b)
	if not triple_pl.is_empty():
		return triple_pl
	var sn := _seen_rank_must_play(b, ctx)
	if not sn.is_empty():
		return sn
	return _weakest_single_from_hand(hand, b)
