extends RefCounted
## 联机快照：牌型 Dictionary 与 JSON 安全结构互转（extra 可为 null / int / Array）。

const Rules = preload("res://scripts/ddz_rules.gd")


static func pattern_to_plain(p: Dictionary) -> Dictionary:
	if p.is_empty():
		return {"kind": int(Rules.Kind.PASS), "main": -1, "extra": null}
	var ex = p.get("extra", null)
	var ex_out = ex
	if typeof(ex) == TYPE_ARRAY:
		var a: Array = []
		for x in ex:
			a.append(x)
		ex_out = a
	return {"kind": int(float(p.get("kind", Rules.Kind.INVALID))), "main": int(float(p.get("main", -1))), "extra": ex_out}


static func plain_to_pattern(d: Dictionary) -> Dictionary:
	if d.is_empty():
		return {"kind": Rules.Kind.PASS, "main": -1, "extra": null}
	var k: int = int(float(d.get("kind", Rules.Kind.INVALID)))
	if k == int(Rules.Kind.PASS):
		return {"kind": Rules.Kind.PASS, "main": -1, "extra": null}
	var ex = d.get("extra", null)
	return {"kind": k, "main": int(float(d.get("main", -1))), "extra": ex}
