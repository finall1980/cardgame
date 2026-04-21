extends RefCounted

const _DECK_SIZE = 54

var _rng: RandomNumberGenerator


func _init(rng_seed: int = -1) -> void:
	_rng = RandomNumberGenerator.new()
	if rng_seed >= 0:
		_rng.seed = rng_seed
	else:
		_rng.randomize()


func shuffle_deck(deck: PackedInt32Array) -> void:
	var n: int = deck.size()
	var i: int = n - 1
	while i > 0:
		var j: int = _rng.randi_range(0, i)
		var t: int = deck[i]
		deck[i] = deck[j]
		deck[j] = t
		i -= 1


## 返回 { "hands": Array[PackedInt32Array], "bottom": PackedInt32Array, "trace": Array }
## trace 每项为 { "seat": 0..2, "card": 牌 id }，与发牌顺序 i%3 一致。
func deal_doudizhu_with_trace() -> Dictionary:
	var d: PackedInt32Array = PackedInt32Array()
	d.resize(_DECK_SIZE)
	for k in range(_DECK_SIZE):
		d[k] = k
	shuffle_deck(d)
	var p0: PackedInt32Array = PackedInt32Array()
	var p1: PackedInt32Array = PackedInt32Array()
	var p2: PackedInt32Array = PackedInt32Array()
	var trace: Array = []
	for i in range(51):
		var seat: int = i % 3
		var cid: int = d[i]
		trace.append({"seat": seat, "card": cid})
		match seat:
			0:
				p0.append(cid)
			1:
				p1.append(cid)
			_:
				p2.append(cid)
	var hands: Array = []
	hands.append(p0)
	hands.append(p1)
	hands.append(p2)
	var bottom: PackedInt32Array = PackedInt32Array()
	bottom.resize(3)
	bottom[0] = d[51]
	bottom[1] = d[52]
	bottom[2] = d[53]
	return {"hands": hands, "bottom": bottom, "trace": trace}


func deal_doudizhu() -> Array:
	var pkg: Dictionary = deal_doudizhu_with_trace()
	return [pkg["hands"], pkg["bottom"]]
