class_name SiegeData
extends RefCounted
## M1 垂直切片：职业 / 武器 / 敌人 / 升级池 静态数据。
## 使用方式：SiegeData.CLASSES[&"ginger"]（不需要实例化）。

## 职业（M1.1：4 个，共享 3 种武器）
const CLASSES := {
	&"ginger": {
		"name": "橘猫守卫",
		"tagline": "平衡型 · 标准爪击投射",
		"hp": 150,
		"speed": 180.0,
		"color": Color(1.0, 0.62, 0.25),
		"weapon_id": &"claw_shot",
		"stat_overrides": {},
	},
	&"cow": {
		"name": "奶牛猫游侠",
		"tagline": "敏捷型 · 鱼骨扇射三连",
		"hp": 110,
		"speed": 210.0,
		"color": Color(0.95, 0.95, 0.95),
		"weapon_id": &"fishbone_fan",
		"stat_overrides": {},
	},
	&"am_short": {
		"name": "美短暴君",
		"tagline": "坦克型 · 震波近身 AoE",
		"hp": 220,
		"speed": 150.0,
		"color": Color(0.55, 0.60, 0.70),
		"weapon_id": &"shock_paw",
		"stat_overrides": {},
	},
	&"calico": {
		"name": "三花快手",
		"tagline": "高攻速 · 疾速连珠（低单发伤害）",
		"hp": 115,
		"speed": 190.0,
		"color": Color(0.98, 0.80, 0.55),
		"weapon_id": &"claw_shot",
		"stat_overrides": {
			"rate_mult": 1.9,
			"damage_mult": 0.55,
			"proj_speed_mult": 1.1,
		},
	},
}

const CLASS_ORDER: Array = [&"ginger", &"cow", &"am_short", &"calico"]

## 武器（M1.1：3 种差异化）
## kind:
##   &"projectile" - 直线投射，支持 count + spread_deg
##   &"aoe"        - 玩家原地范围爆破
const WEAPONS := {
	&"claw_shot": {
		"name": "爪击投射",
		"kind": &"projectile",
		"cooldown_ms": 900,
		"proj_count": 1,
		"proj_speed": 520.0,
		"proj_damage": 16,
		"proj_ttl_sec": 1.6,
		"proj_size": 7.0,
		"proj_color": Color(0.98, 0.95, 0.55),
		"spread_deg": 8.0,
	},
	&"fishbone_fan": {
		"name": "鱼骨扇射",
		"kind": &"projectile",
		"cooldown_ms": 1150,
		"proj_count": 3,
		"proj_speed": 460.0,
		"proj_damage": 9,
		"proj_ttl_sec": 1.2,
		"proj_size": 6.0,
		"proj_color": Color(0.55, 0.90, 1.0),
		"spread_deg": 34.0,
	},
	&"shock_paw": {
		"name": "震波爪击",
		"kind": &"aoe",
		"cooldown_ms": 1350,
		"radius": 110.0,
		"damage": 26,
		"color": Color(0.95, 0.55, 0.35, 0.55),
		"fx_ttl_sec": 0.28,
		"engage_slack": 70.0,
	},
}

## 敌人
const ENEMIES := {
	&"rat": {
		"name": "小鼠丁",
		"hp": 8,
		"speed": 95.0,
		"radius": 7.0,
		"touch_damage": 3,
		"base_damage": 2,
		"aggro_radius": 180.0,
		"aggro_release": 360.0,
		"xp": 1,
		"color": Color(0.78, 0.55, 0.30),
		"size": Vector2(14.0, 14.0),
	},
	&"stray": {
		"name": "流浪犬",
		"hp": 26,
		"speed": 120.0,
		"radius": 10.0,
		"touch_damage": 6,
		"base_damage": 4,
		"aggro_radius": 220.0,
		"aggro_release": 420.0,
		"xp": 3,
		"color": Color(0.55, 0.35, 0.22),
		"size": Vector2(20.0, 20.0),
	},
}

## 三选一升级池。stat/delta 用于直接修改玩家 stats 字典。
const UPGRADES := [
	{ "id": &"dmg", "label": "利爪精研", "desc": "伤害 +25%", "stat": "damage_mult", "delta": 0.25 },
	{ "id": &"rate", "label": "猫科反射", "desc": "攻速 +20%", "stat": "rate_mult", "delta": 0.20 },
	{ "id": &"proj", "label": "多重投射", "desc": "投射物 +1", "stat": "proj_extra", "delta": 1 },
	{ "id": &"move", "label": "灵巧步伐", "desc": "移速 +15%", "stat": "move_mult", "delta": 0.15 },
	{ "id": &"pickup", "label": "灵敏鼻尖", "desc": "拾取半径 +60%", "stat": "pickup_mult", "delta": 0.60 },
	{ "id": &"hp", "label": "膘肥体壮", "desc": "最大 HP +40（并回满）", "stat": "max_hp_add", "delta": 40 },
	{ "id": &"regen", "label": "舔毛自愈", "desc": "每 2s 回 1 HP", "stat": "regen_per2s", "delta": 1 },
	{ "id": &"spd", "label": "灵敏投射", "desc": "投射速度 +20%", "stat": "proj_speed_mult", "delta": 0.20 },
]

## 波次时间线：{at_sec, spawn_interval_sec, batch, kinds}
## kinds 是权重字典，加权随机选 kind
const WAVES := [
	{ "at_sec": 0.0, "spawn_interval_sec": 1.8, "batch": 2, "kinds": {&"rat": 1.0} },
	{ "at_sec": 30.0, "spawn_interval_sec": 1.3, "batch": 3, "kinds": {&"rat": 0.8, &"stray": 0.2} },
	{ "at_sec": 75.0, "spawn_interval_sec": 1.0, "batch": 4, "kinds": {&"rat": 0.6, &"stray": 0.4} },
	{ "at_sec": 120.0, "spawn_interval_sec": 0.7, "batch": 5, "kinds": {&"rat": 0.4, &"stray": 0.6} },
	{ "at_sec": 165.0, "spawn_interval_sec": 0.35, "batch": 6, "kinds": {&"rat": 0.4, &"stray": 0.6} },
]

## 等级曲线：xp_to_next(lv) = 5 * lv + 2 * lv*lv
static func xp_to_next(lv: int) -> int:
	return 5 * lv + 2 * lv * lv


static func pick_weighted(weights: Dictionary, rng: RandomNumberGenerator) -> StringName:
	var total := 0.0
	for k in weights:
		total += float(weights[k])
	if total <= 0.0:
		return &""
	var r := rng.randf() * total
	var acc := 0.0
	for k in weights:
		acc += float(weights[k])
		if r <= acc:
			return StringName(k)
	return weights.keys()[weights.size() - 1] as StringName


static func current_wave(elapsed_sec: float) -> Dictionary:
	var current: Dictionary = WAVES[0]
	for w in WAVES:
		if elapsed_sec >= float(w.at_sec):
			current = w
		else:
			break
	return current
