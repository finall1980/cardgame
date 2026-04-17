extends RefCounted
## 跟牌 + 叫分（0–3 分）；可选 ctx：农民配合、记牌辅助首出、ai_style
const Rules = preload("res://scripts/ddz_rules.gd")
const DdzAiPlay = preload("res://scripts/ddz_ai_play.gd")

## 与 main.CAT_NAMES 下标一致：丑丑妹=普通，咪宝=凶，毛睿睿=怂
const AI_STYLE_NORMAL := 0
const AI_STYLE_AGGRESSIVE := 1
const AI_STYLE_PASSIVE := 2


static func style_from_cat_id(cat_id: int) -> int:
	match cat_id:
		1:
			return AI_STYLE_AGGRESSIVE
		2:
			return AI_STYLE_PASSIVE
		_:
			return AI_STYLE_NORMAL


static func _is_farmer(me: int, landlord: int) -> bool:
	return me != landlord


static func _teammate_farmer(me: int, landlord: int) -> int:
	if me == landlord:
		return -1
	for i in range(3):
		if i != landlord and i != me:
			return i
	return -1


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


## 综合评估「当地主」潜力：点力、结构、炸弹、王炸；用于叫分与抢地主（抢地主阈值高于叫分）。
static func _rank_weight_landlord(r: int) -> float:
	if r <= 6:
		return 0.35 + float(r) * 0.04
	if r <= 8:
		return 1.05
	if r <= 10:
		return 1.55
	if r == 11:
		return 2.35
	if r == 12:
		return 3.6
	if r == 13:
		return 4.8
	if r == 14:
		return 5.8
	return 0.0


static func hand_landlord_strength(hand: PackedInt32Array) -> float:
	var b: Dictionary = _buckets(hand)
	var s: float = 0.0
	for rk in b.keys():
		var r: int = int(rk)
		var arr: Array = b[rk] as Array
		var n: int = arr.size()
		var w: float = _rank_weight_landlord(r)
		s += float(n) * w
		if n == 2 or n == 3:
			s += 0.2 * float(n) * w
		if n >= 4:
			s += 11.0
	if (b.get(13, []) as Array).size() >= 1 and (b.get(14, []) as Array).size() >= 1:
		s += 7.0
	return s


static func choose_bid(hand: PackedInt32Array, style: int = AI_STYLE_NORMAL) -> int:
	var s: float = hand_landlord_strength(hand)
	var t1: float = 15.0
	var t2: float = 24.0
	var t3: float = 34.0
	match style:
		AI_STYLE_AGGRESSIVE:
			t1 -= 3.5
			t2 -= 3.0
			t3 -= 2.5
		AI_STYLE_PASSIVE:
			t1 += 3.0
			t2 += 3.5
			t3 += 3.0
	if s >= t3:
		return 3
	if s >= t2:
		return 2
	if s >= t1:
		return 1
	return 0


static func choose_rob_landlord(hand: PackedInt32Array, current_multiplier: int, style: int = AI_STYLE_NORMAL) -> bool:
	var s: float = hand_landlord_strength(hand)
	var floor_s: float = 18.0
	var need: float = 30.0
	if current_multiplier >= 4:
		need = 44.0
	elif current_multiplier >= 2:
		need = 36.0
	match style:
		AI_STYLE_AGGRESSIVE:
			floor_s = 14.0
			if current_multiplier >= 4:
				need = 39.0
			elif current_multiplier >= 2:
				need = 31.0
			else:
				need = 25.0
		AI_STYLE_PASSIVE:
			floor_s = 22.0
			if current_multiplier >= 4:
				need = 50.0
			elif current_multiplier >= 2:
				need = 42.0
			else:
				need = 36.0
	if s < floor_s:
		return false
	return s >= need


## 与 `find_follow` 中「农民让队友收尾」分支一致，供人类「提示」区分文案。
static func is_farmer_yield_pass(ctx: Dictionary, last: Dictionary) -> bool:
	if last.is_empty():
		return false
	var lk: int = int(last.get("kind", Rules.Kind.INVALID))
	if lk == Rules.Kind.PASS or lk == Rules.Kind.ROCKET:
		return false
	if ctx.is_empty():
		return false
	var me: int = int(ctx.get("me", -1))
	var ld: int = int(ctx.get("landlord", -1))
	var last_pl: int = int(ctx.get("last_player", -1))
	var passes: int = int(ctx.get("passes", 0))
	if _is_farmer(me, ld) and passes == 1:
		var mate: int = _teammate_farmer(me, ld)
		if mate == last_pl:
			var ast: int = int(ctx.get("ai_style", AI_STYLE_NORMAL))
			return ast != AI_STYLE_AGGRESSIVE
	return false


static func find_follow(hand: PackedInt32Array, last: Dictionary, ctx: Dictionary = {}) -> Array:
	if last.is_empty():
		return []
	var lk: int = int(last.get("kind", Rules.Kind.INVALID))
	if lk == Rules.Kind.PASS:
		return []
	if lk == Rules.Kind.ROCKET:
		return []
	if not ctx.is_empty():
		var me: int = int(ctx.get("me", -1))
		var ld: int = int(ctx.get("landlord", -1))
		var last_pl: int = int(ctx.get("last_player", -1))
		var passes: int = int(ctx.get("passes", 0))
		if _is_farmer(me, ld) and passes == 1:
			var mate: int = _teammate_farmer(me, ld)
			if mate == last_pl:
				var ast: int = int(ctx.get("ai_style", AI_STYLE_NORMAL))
				if ast != AI_STYLE_AGGRESSIVE:
					return []
	var b: Dictionary = _buckets(hand)
	var same := _try_same_pattern(hand, b, last)
	if not same.is_empty():
		return same
	var bomb := _try_bomb(b, last)
	if not bomb.is_empty():
		if ctx.is_empty() or not _should_avoid_bomb(ctx, hand, last):
			return bomb
	return _try_rocket(b)


static func _should_avoid_bomb(ctx: Dictionary, hand: PackedInt32Array, last: Dictionary) -> bool:
	var last_is_bomb: bool = int(last.get("kind", 0)) == Rules.Kind.BOMB
	if last_is_bomb:
		return false
	var min_o: int = int(ctx.get("min_opp_cards", 0))
	var ast: int = int(ctx.get("ai_style", AI_STYLE_NORMAL))
	var long_h: bool = hand.size() >= 10
	var opp_heavy: bool = min_o >= 9
	match ast:
		AI_STYLE_AGGRESSIVE:
			return opp_heavy and long_h and min_o >= 12
		AI_STYLE_PASSIVE:
			return min_o >= 6 and hand.size() >= 8
		_:
			return opp_heavy and long_h


static func _try_same_pattern(hand: PackedInt32Array, b: Dictionary, last: Dictionary) -> Array:
	var lk: int = int(last.get("kind", 0))
	match lk:
		Rules.Kind.SINGLE:
			return _follow_single(b, int(last.get("main", -1)))
		Rules.Kind.PAIR:
			return _follow_pair(b, int(last.get("main", -1)))
		Rules.Kind.TRIPLE:
			return _follow_triple(b, int(last.get("main", -1)))
		Rules.Kind.STRAIGHT:
			return _follow_straight(b, int(last.get("main", -1)), int(last.get("extra", 0)))
		Rules.Kind.TRIPLE_WITH_SINGLE:
			return _follow_triple_single(b, int(last.get("main", -1)))
		Rules.Kind.TRIPLE_WITH_PAIR:
			return _follow_triple_pair(b, int(last.get("main", -1)))
		Rules.Kind.PAIR_STRAIGHT:
			return _follow_pair_straight(b, int(last.get("main", -1)), int(last.get("extra", 0)))
		Rules.Kind.FOUR_WITH_TWO:
			return _follow_four_with_two(b, int(last.get("main", -1)), int(last.get("extra", 0)))
		Rules.Kind.PLANE:
			return _follow_plane_bruteforce(hand, int(last.get("main", -1)))
		Rules.Kind.BOMB:
			return []
	return []


static func _follow_single(b: Dictionary, need_gt: int) -> Array:
	for r in range(need_gt + 1, 15):
		var arr: Array = b.get(r, []) as Array
		if arr.size() >= 1:
			return [arr[0]]
	return []


static func _follow_pair(b: Dictionary, need_gt: int) -> Array:
	for r in range(need_gt + 1, 15):
		var arr: Array = b.get(r, []) as Array
		if arr.size() >= 2:
			return [arr[0], arr[1]]
	return []


static func _follow_triple(b: Dictionary, need_gt: int) -> Array:
	for r in range(need_gt + 1, 15):
		var arr: Array = b.get(r, []) as Array
		if arr.size() >= 3:
			return [arr[0], arr[1], arr[2]]
	return []


static func _follow_straight(b: Dictionary, need_top_gt: int, length: int) -> Array:
	if length < 5:
		return []
	for top in range(need_top_gt + 1, 12):
		var bot: int = top - (length - 1)
		if bot < 0:
			continue
		var ok := true
		for r in range(bot, top + 1):
			if r == 12 or r >= 13:
				ok = false
				break
			if (b.get(r, []) as Array).size() < 1:
				ok = false
				break
		if not ok:
			continue
		var out: Array = []
		for r in range(bot, top + 1):
			out.append((b.get(r, []) as Array)[0])
		return out
	return []


static func _follow_triple_single(b: Dictionary, need_main_gt: int) -> Array:
	for tr in range(need_main_gt + 1, 13):
		var ta: Array = b.get(tr, []) as Array
		if ta.size() < 3:
			continue
		for kri in range(15):
			if kri == tr:
				continue
			var ka: Array = b.get(kri, []) as Array
			if ka.size() < 1:
				continue
			return [ta[0], ta[1], ta[2], ka[0]]
	return []


static func _follow_triple_pair(b: Dictionary, need_main_gt: int) -> Array:
	for tr in range(need_main_gt + 1, 13):
		var ta: Array = b.get(tr, []) as Array
		if ta.size() < 3:
			continue
		for pri in range(15):
			if pri == tr:
				continue
			var pa: Array = b.get(pri, []) as Array
			if pa.size() < 2:
				continue
			return [ta[0], ta[1], ta[2], pa[0], pa[1]]
	return []


static func _follow_pair_straight(b: Dictionary, need_top_gt: int, n_cards: int) -> Array:
	var n_pairs: int = n_cards / 2
	if n_pairs < 3:
		return []
	for top in range(need_top_gt + 1, 12):
		var bot: int = top - (n_pairs - 1)
		if bot < 0:
			continue
		var ok := true
		var out: Array = []
		for r in range(bot, top + 1):
			if r == 12 or r >= 13:
				ok = false
				break
			var pa: Array = b.get(r, []) as Array
			if pa.size() < 2:
				ok = false
				break
			out.append(pa[0])
			out.append(pa[1])
		if ok:
			return out
	return []


static func _buckets_minus_four(b: Dictionary, four_rank: int) -> Dictionary:
	var out: Dictionary = {}
	for k in b.keys():
		var arr: Array = (b[k] as Array).duplicate()
		var ki: int = int(k)
		if ki == four_rank:
			for _t in 4:
				if arr.size() > 0:
					arr.remove_at(0)
		if arr.size() > 0:
			out[ki] = arr
	return out


static func _follow_four_with_two(b: Dictionary, need_four_gt: int, extra: int) -> Array:
	for fr in range(need_four_gt + 1, 13):
		var fa: Array = b.get(fr, []) as Array
		if fa.size() < 4:
			continue
		var b2: Dictionary = _buckets_minus_four(b, fr)
		if extra == 6:
			var kick := _pick_two_singles_except(b2, fr)
			if kick.size() == 2:
				return [fa[0], fa[1], fa[2], fa[3], kick[0], kick[1]]
		elif extra == 8:
			var kickp := _pick_two_pairs_except(b2, fr)
			if kickp.size() == 4:
				return [fa[0], fa[1], fa[2], fa[3], kickp[0], kickp[1], kickp[2], kickp[3]]
	return []


static func _pick_two_singles_except(b2: Dictionary, fr: int) -> Array:
	var out: Array = []
	for r in range(15):
		if r == fr:
			continue
		var a: Array = b2.get(r, []) as Array
		if a.size() >= 1:
			out.append(a[0])
			if out.size() == 2:
				return out
	return []


static func _pick_two_pairs_except(b2: Dictionary, fr: int) -> Array:
	var out: Array = []
	for r in range(15):
		if r == fr:
			continue
		var a: Array = b2.get(r, []) as Array
		if a.size() >= 2:
			out.append(a[0])
			out.append(a[1])
			if out.size() == 4:
				return out
	return []


static func _follow_plane_bruteforce(hand: PackedInt32Array, need_main_gt: int) -> Array:
	var ids: Array = []
	for i in hand.size():
		ids.append(hand[i])
	var n: int = ids.size()
	if n < 10:
		return []
	var idx: Array = []
	for j in range(10):
		idx.append(j)
	while true:
		var combo: Array = []
		for j in range(10):
			combo.append(ids[idx[j]])
		var pat: Dictionary = Rules.classify(combo)
		if int(pat.get("kind", 0)) == Rules.Kind.PLANE and int(pat.get("main", -1)) > need_main_gt:
			return combo
		var t: int = 9
		while t >= 0 and idx[t] >= n - 10 + t:
			t -= 1
		if t < 0:
			break
		idx[t] += 1
		for j in range(t + 1, 10):
			idx[j] = idx[j - 1] + 1
	return []


static func _try_bomb(b: Dictionary, last: Dictionary) -> Array:
	var last_is_bomb: bool = int(last.get("kind", 0)) == Rules.Kind.BOMB
	var need_main: int = int(last.get("main", -1))
	for r in range(13):
		var arr: Array = b.get(r, []) as Array
		if arr.size() < 4:
			continue
		if last_is_bomb and r <= need_main:
			continue
		return [arr[0], arr[1], arr[2], arr[3]]
	return []


static func _try_rocket(b: Dictionary) -> Array:
	var a13: Array = b.get(13, []) as Array
	var a14: Array = b.get(14, []) as Array
	if a13.size() >= 1 and a14.size() >= 1:
		return [a13[0], a14[0]]
	return []


static func find_free_lead(hand: PackedInt32Array, ctx: Dictionary = {}) -> Array:
	return DdzAiPlay.choose_free_lead(hand, ctx)
