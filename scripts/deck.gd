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


func deal_doudizhu() -> Array:
	var d: PackedInt32Array = PackedInt32Array()
	d.resize(_DECK_SIZE)
	for k in range(_DECK_SIZE):
		d[k] = k
	shuffle_deck(d)
	var p0: PackedInt32Array = PackedInt32Array()
	var p1: PackedInt32Array = PackedInt32Array()
	var p2: PackedInt32Array = PackedInt32Array()
	for i in range(51):
		match i % 3:
			0:
				p0.append(d[i])
			1:
				p1.append(d[i])
			_:
				p2.append(d[i])
	var hands: Array = []
	hands.append(p0)
	hands.append(p1)
	hands.append(p2)
	var bottom: PackedInt32Array = PackedInt32Array()
	bottom.resize(3)
	bottom[0] = d[51]
	bottom[1] = d[52]
	bottom[2] = d[53]
	return [hands, bottom]
