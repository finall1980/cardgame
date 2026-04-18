extends RefCounted
## 斗地主牌型：单/对/三/顺/炸/王炸/三带一/三带二/连对/四带二/飞机/飞机带翅膀。

enum Kind {
	INVALID = 0,
	PASS,
	SINGLE,
	PAIR,
	TRIPLE,
	STRAIGHT,
	BOMB,
	ROCKET,
	TRIPLE_WITH_SINGLE,
	TRIPLE_WITH_PAIR,
	PAIR_STRAIGHT,
	FOUR_WITH_TWO,
	PLANE,
	PLANE_WITH_WINGS,
}


static func _rank_counts(cards: Array) -> Dictionary:
	var m: Dictionary = {}
	for id in cards:
		var v := CardDefs.ddz_rank_value(id)
		m[v] = m.get(v, 0) + 1
	return m


static func _sorted_ranks(cards: Array) -> Array:
	var r: Array = []
	for id in cards:
		r.append(CardDefs.ddz_rank_value(id))
	r.sort()
	return r


static func _total_n(counts: Dictionary) -> int:
	var s := 0
	for v in counts.values():
		s += int(v)
	return s


static func classify(cards: Array) -> Dictionary:
	if cards.is_empty():
		return {"kind": Kind.PASS, "main": -1, "extra": null}
	var n: int = cards.size()
	if n == 2:
		var a: int = cards[0]
		var b: int = cards[1]
		if (a == 52 and b == 53) or (a == 53 and b == 52):
			return {"kind": Kind.ROCKET, "main": 14, "extra": null}

	var counts: Dictionary = _rank_counts(cards)
	var vals: Array = counts.values()
	var keys: Array = counts.keys()
	keys.sort()

	if n == 1:
		return {"kind": Kind.SINGLE, "main": CardDefs.ddz_rank_value(cards[0]), "extra": null}

	if n == 2 and vals.size() == 1 and vals[0] == 2:
		return {"kind": Kind.PAIR, "main": keys[0], "extra": null}

	if n == 3 and vals.size() == 1 and vals[0] == 3:
		return {"kind": Kind.TRIPLE, "main": keys[0], "extra": null}

	if n == 4:
		if vals.size() == 1 and vals[0] == 4:
			return {"kind": Kind.BOMB, "main": keys[0], "extra": null}
		if _is_triple_single(counts):
			var triple_rank: int = _triple_rank_in(counts)
			return {"kind": Kind.TRIPLE_WITH_SINGLE, "main": triple_rank, "extra": 4}
		return {"kind": Kind.INVALID, "main": -1, "extra": null}

	if n == 5:
		if _is_straight(counts, n):
			var sr: Array = _sorted_ranks(cards)
			return {"kind": Kind.STRAIGHT, "main": sr[sr.size() - 1], "extra": n}
		if _is_triple_pair(counts):
			return {"kind": Kind.TRIPLE_WITH_PAIR, "main": _triple_rank_in(counts), "extra": 5}
		return {"kind": Kind.INVALID, "main": -1, "extra": null}

	if n >= 5:
		if _is_straight(counts, n):
			var sr2: Array = _sorted_ranks(cards)
			return {"kind": Kind.STRAIGHT, "main": sr2[sr2.size() - 1], "extra": n}

	if n >= 6 and n % 2 == 0 and _is_pair_straight(counts):
		var pr: Array = _pair_straight_ranks(counts)
		return {"kind": Kind.PAIR_STRAIGHT, "main": pr[pr.size() - 1], "extra": n}

	## 四带二（先于飞机类，避免与部分张数重叠误判）
	if n == 6 and _is_four_two_singles(counts) and _four_kickers_no_joker_bomb(counts, cards):
		return {"kind": Kind.FOUR_WITH_TWO, "main": _four_rank_in(counts), "extra": 6}
	if n == 8 and _is_four_two_pairs(counts) and _four_kickers_no_joker_bomb(counts, cards):
		return {"kind": Kind.FOUR_WITH_TWO, "main": _four_rank_in(counts), "extra": 8}

	## 飞机：仅连续三张，不含 2（点力 12）与王牌，张数 = 3*k，k>=2
	var pure := _try_pure_plane(counts)
	if not pure.is_empty():
		return pure

	## 飞机带翅膀
	var pww := _try_plane_with_wings(counts)
	if not pww.is_empty():
		return pww

	return {"kind": Kind.INVALID, "main": -1, "extra": null}


## 所带牌不能为双王；不能含「炸弹」（剩余牌里出现 4 张同点或双王）
static func _four_kickers_no_joker_bomb(counts: Dictionary, _cards: Array) -> bool:
	var fr := _four_rank_in(counts)
	for k in counts.keys():
		var rk: int = int(k)
		var c: int = int(counts[k])
		if rk == fr:
			continue
		if c >= 4:
			return false
		if rk >= 13 and c >= 1:
			return false
	return true


static func _is_triple_single(counts: Dictionary) -> bool:
	if counts.size() != 2:
		return false
	var got3 := false
	var got1 := false
	for c in counts.values():
		if c == 3:
			got3 = true
		elif c == 1:
			got1 = true
	return got3 and got1


static func _triple_rank_in(counts: Dictionary) -> int:
	for k in counts.keys():
		if counts[k] == 3:
			return int(k)
	return -1


static func _is_triple_pair(counts: Dictionary) -> bool:
	if counts.size() != 2:
		return false
	var got3 := false
	var got2 := false
	for c in counts.values():
		if c == 3:
			got3 = true
		elif c == 2:
			got2 = true
	return got3 and got2


static func _is_straight(counts: Dictionary, n: int) -> bool:
	if counts.size() != n:
		return false
	for c in counts.values():
		if c != 1:
			return false
	var ranks: Array = counts.keys()
	ranks.sort()
	for r in ranks:
		if r == 12 or r >= 13:
			return false
	for i in range(1, ranks.size()):
		if ranks[i] != ranks[i - 1] + 1:
			return false
	return true


static func _is_pair_straight(counts: Dictionary) -> bool:
	var npr := 0
	for c in counts.values():
		if c != 2:
			return false
		npr += 1
	if npr < 3:
		return false
	var ranks: Array = counts.keys()
	ranks.sort()
	for r in ranks:
		if r == 12 or r >= 13:
			return false
	for i in range(1, ranks.size()):
		if ranks[i] != ranks[i - 1] + 1:
			return false
	return true


static func _pair_straight_ranks(counts: Dictionary) -> Array:
	var ranks: Array = counts.keys()
	ranks.sort()
	return ranks


static func _is_four_two_singles(counts: Dictionary) -> bool:
	if counts.size() != 3:
		return false
	var got4 := false
	var n1 := 0
	for c in counts.values():
		if c == 4:
			got4 = true
		elif c == 1:
			n1 += 1
	return got4 and n1 == 2


static func _is_four_two_pairs(counts: Dictionary) -> bool:
	if counts.size() != 3:
		return false
	var got4 := false
	var n2 := 0
	for c in counts.values():
		if c == 4:
			got4 = true
		elif c == 2:
			n2 += 1
	return got4 and n2 == 2


static func _four_rank_in(counts: Dictionary) -> int:
	for k in counts.keys():
		if counts[k] == 4:
			return int(k)
	return -1


## 飞机：两段及以上连续三张，点力在 3～A（0～11），每点恰好 3 张
static func _try_pure_plane(counts: Dictionary) -> Dictionary:
	var n := _total_n(counts)
	if n % 3 != 0 or n < 6:
		return {}
	var k: int = n / 3
	if counts.size() != k:
		return {}
	for st in range(0, 12):
		if st + k - 1 > 11:
			break
		var ok := true
		for r in range(st, st + k):
			if int(counts.get(r, 0)) != 3:
				ok = false
				break
		if ok:
			return {"kind": Kind.PLANE, "main": st + k - 1, "extra": k}
	return {}


## 飞机带翅膀：连续 k 组三张（0～11）+ k 组翅膀（单或对），翅膀点力互不同且不在飞机点力上，无王、无炸弹
static func _try_plane_with_wings(counts: Dictionary) -> Dictionary:
	var n := _total_n(counts)
	for k in range(2, 13):
		var min_cards: int = 4 * k
		var max_cards: int = 5 * k
		if n < min_cards or n > max_cards:
			continue
		var num_pair_wings: int = n - 4 * k
		if num_pair_wings < 0 or num_pair_wings > k:
			continue
		for st in range(0, 12):
			if st + k - 1 > 11:
				break
			var pat := _match_plane_wings_at(counts, st, k, num_pair_wings)
			if not pat.is_empty():
				return pat
	return {}


static func _match_plane_wings_at(full: Dictionary, st: int, k: int, num_pair_wings: int) -> Dictionary:
	var c: Dictionary = {}
	for kk in full.keys():
		c[int(kk)] = int(full[kk])
	for r in range(st, st + k):
		if c.get(r, 0) < 3:
			return {}
		c[r] = int(c[r]) - 3
		if c[r] == 0:
			c.erase(r)
	## 飞机段上不能再有剩余牌（否则第 4 张不能当翅膀）
	for r in range(st, st + k):
		if c.get(r, 0) != 0:
			return {}
	var singles := 0
	var pairs := 0
	for rk in c.keys():
		var cnt: int = int(c[rk])
		if rk >= 13:
			return {}
		if cnt != 1 and cnt != 2:
			return {}
		if cnt == 1:
			singles += 1
		else:
			pairs += 1
	if singles + pairs != k:
		return {}
	if pairs != num_pair_wings:
		return {}
	## extra：高 5 位存 k，低 5 位存对子翅膀数（与 same_pattern 一致）
	var ex: int = (k << 5) | num_pair_wings
	return {"kind": Kind.PLANE_WITH_WINGS, "main": st + k - 1, "extra": ex}


static func same_pattern_kind(a: Dictionary, b: Dictionary) -> bool:
	if a.kind != b.kind:
		return false
	var ea = a.get("extra", null)
	var eb = b.get("extra", null)
	return ea == eb


static func beats(last: Dictionary, cur: Dictionary) -> bool:
	if cur.kind == Kind.INVALID:
		return false
	if last.kind == Kind.PASS or last.is_empty():
		return cur.kind != Kind.PASS and cur.kind != Kind.INVALID
	if cur.kind == Kind.ROCKET:
		return true
	if last.kind == Kind.ROCKET:
		return false
	if cur.kind == Kind.BOMB:
		if last.kind != Kind.BOMB:
			return true
		return cur.main > last.main
	if last.kind == Kind.BOMB:
		return false
	if not same_pattern_kind(last, cur):
		return false
	return cur.main > last.main
