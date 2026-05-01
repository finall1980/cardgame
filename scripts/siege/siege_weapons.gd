extends RefCounted
## 武器系统：按 weapon_id 分派到不同开火逻辑。
## 所有武器通过 arena 暴露的稳定 API 操作模拟数据，不直接摸 arena 的私有数组：
##   arena._p_pos: Vector2
##   arena._p_weapon_cd_ms: int  (读写)
##   arena._stats: Dictionary
##   arena.closest_enemy_to(pt) -> int
##   arena.get_enemy_pos(idx) -> Vector2
##   arena.enemy_count() -> int
##   arena.fire_projectile(pos, dir, speed, ttl, dmg, color)
##   arena.apply_aoe(pos, radius, dmg) -> int
##   arena.spawn_fx(pos, radius, color, ttl)

@warning_ignore("shadowed_global_identifier")
const SiegeData := preload("res://scripts/siege/siege_data.gd")


static func tick(weapon_id: StringName, arena: Node2D, delta: float) -> void:
	if not SiegeData.WEAPONS.has(weapon_id):
		return
	var weapon: Dictionary = SiegeData.WEAPONS[weapon_id]
	arena._p_weapon_cd_ms -= int(delta * 1000.0)
	if arena._p_weapon_cd_ms > 0:
		return
	var kind: StringName = weapon.get("kind", &"projectile")
	match kind:
		&"projectile":
			_fire_projectile(arena, weapon)
		&"aoe":
			_fire_aoe(arena, weapon)


static func _apply_cooldown(arena: Node2D, weapon: Dictionary) -> void:
	var base_cd: int = int(weapon.cooldown_ms)
	var rate: float = float(arena._stats.get("rate_mult", 1.0))
	arena._p_weapon_cd_ms = maxi(40, int(base_cd / maxf(rate, 0.1)))


static func _fire_projectile(arena: Node2D, weapon: Dictionary) -> void:
	var target: int = arena.closest_enemy_to(arena._p_pos)
	if target < 0:
		return
	_apply_cooldown(arena, weapon)

	var n: int = int(weapon.proj_count) + int(arena._stats.get("proj_extra", 0))
	if n < 1:
		n = 1
	var dir: Vector2 = (arena.get_enemy_pos(target) - arena._p_pos).normalized()
	var spread_rad: float = deg_to_rad(float(weapon.spread_deg))
	var dmg: int = int(round(float(weapon.proj_damage) * float(arena._stats.get("damage_mult", 1.0))))
	var spd: float = float(weapon.proj_speed) * float(arena._stats.get("proj_speed_mult", 1.0))
	var ttl: float = float(weapon.proj_ttl_sec)
	var color: Color = weapon.get("proj_color", Color(1.0, 1.0, 1.0, 1.0))
	for i in n:
		var angle: float = 0.0
		if n > 1:
			angle = lerpf(-spread_rad, spread_rad, float(i) / float(n - 1))
		arena.fire_projectile(arena._p_pos, dir.rotated(angle), spd, ttl, dmg, color)


static func _fire_aoe(arena: Node2D, weapon: Dictionary) -> void:
	## AoE 需要附近有敌人才触发（避免空放 CD）
	var base_r: float = float(weapon.radius) * float(arena._stats.get("range_mult", 1.0))
	var slack: float = float(weapon.get("engage_slack", 60.0))
	var target: int = arena.closest_enemy_to(arena._p_pos)
	if target < 0:
		return
	var dist: float = arena.get_enemy_pos(target).distance_to(arena._p_pos)
	if dist > base_r + slack:
		return
	_apply_cooldown(arena, weapon)
	var dmg: int = int(round(float(weapon.damage) * float(arena._stats.get("damage_mult", 1.0))))
	arena.apply_aoe(arena._p_pos, base_r, dmg)
	arena.spawn_fx(arena._p_pos, base_r, weapon.color, float(weapon.fx_ttl_sec))
