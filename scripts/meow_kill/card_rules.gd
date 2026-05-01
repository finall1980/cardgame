extends RefCounted
class_name MeowKillCardRules
## 与服务端 `Modules/src/games/meow_kill/rules.ts` 实例 id 区间一致。

const SLASH_MAX := 20
const JINK_MAX := 35
const PEACH_MAX := 43
const EQUIP_YARN_ID := 43
const EQUIP_WEAPON_ID := 44


static func card_key(instance_id: int) -> String:
	if instance_id >= 0 and instance_id < SLASH_MAX:
		return "slash"
	if instance_id >= SLASH_MAX and instance_id < JINK_MAX:
		return "jink"
	if instance_id >= JINK_MAX and instance_id < PEACH_MAX:
		return "peach"
	if instance_id == EQUIP_YARN_ID:
		return "equip_ball"
	if instance_id == EQUIP_WEAPON_ID:
		return "equip_weapon"
	return "?"


static func card_label_zh(instance_id: int) -> String:
	match card_key(instance_id):
		"slash":
			return "杀"
		"jink":
			return "闪"
		"peach":
			return "桃"
		"equip_ball":
			return "毛线球"
		"equip_weapon":
			return "猫爬架"
		_:
			return "?"
