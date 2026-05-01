extends Node2D
## 《喵家保卫战》M1.1 单机垂直切片：
##   - 4 职业（橘猫 / 奶牛猫 / 美短 / 三花）
##   - 3 武器（爪击投射 / 鱼骨扇射 / 震波爪击 AoE）
##   - 2 敌人（小鼠丁 / 流浪犬），2 状态 AI（冲基地 / 追玩家）
##   - 经验球、团队等级、升级三选一
##   - 基地 HP、波次时间线、3 分钟胜利 / 基地爆炸失败
## 模拟数据用 Packed* 平行数组；武器逻辑在 siege_weapons.gd，通过 arena 暴露的 public API 调用。

@warning_ignore("shadowed_global_identifier")
const SiegeData := preload("res://scripts/siege/siege_data.gd")
const SiegeWeapons := preload("res://scripts/siege/siege_weapons.gd")

const MAP_SIZE := Vector2(2400.0, 2400.0)
const MATCH_DURATION_SEC := 180.0      # 3 分钟 MVP
const BASE_MAX_HP := 1200
const BASE_RADIUS := 60.0
const PLAYER_RADIUS := 14.0
const PICKUP_BASE_RADIUS := 58.0
const ATTRACT_RADIUS_MULT := 2.2        # 拾取半径 × 此倍数内就开始吸
const ATTRACT_ACCEL := 1400.0
const ENEMY_SEPARATION_JITTER := 0.06
const I_FRAME_SEC := 0.5
const TOUCH_COOLDOWN_SEC := 0.6
const SPAWN_RING_MIN := 520.0
const SPAWN_RING_MAX := 760.0
const BASE_DAMAGE_INTERVAL_SEC := 0.8   # 敌人在基地附近每隔多久扣基地 HP

@onready var _player: Node2D = $Player
@onready var _player_mark: ColorRect = $Player/Mark
@onready var _base: Node2D = $HomeBase
@onready var _base_mark: ColorRect = $HomeBase/Mark
@onready var _aoe_fx_mm: MultiMeshInstance2D = $AoeFx
@onready var _enemies_mm: MultiMeshInstance2D = $Enemies
@onready var _proj_mm: MultiMeshInstance2D = $Projectiles
@onready var _orbs_mm: MultiMeshInstance2D = $XpOrbs
@onready var _lbl_hp: Label = $HUD/HUDRoot/TopLeft/LblHp
@onready var _lbl_base: Label = $HUD/HUDRoot/TopLeft/LblBase
@onready var _lbl_lv: Label = $HUD/HUDRoot/TopLeft/LblLv
@onready var _lbl_xp: Label = $HUD/HUDRoot/TopLeft/LblXp
@onready var _lbl_time: Label = $HUD/HUDRoot/TopRight/LblTime
@onready var _lbl_kills: Label = $HUD/HUDRoot/TopRight/LblKills
@onready var _lbl_stats: Label = $HUD/HUDRoot/BottomLeft/LblStats
@onready var _level_up_panel: Control = $HUD/LevelUpPanel
@onready var _level_up_vbox: VBoxContainer = $HUD/LevelUpPanel/CenterContainer/PanelContainer/VBox
@onready var _banner: Label = $HUD/Banner
@onready var _damage_flash: ColorRect = $HUD/DamageFlash

var _rng := RandomNumberGenerator.new()

## 玩家
var _p_class_id: StringName = &""
var _p_pos := Vector2.ZERO
var _p_vel := Vector2.ZERO
var _p_hp: int = 0
var _p_max_hp: int = 0
var _p_level: int = 1
var _p_xp: int = 0
var _p_xp_need: int = 0
var _p_weapon_cd_ms: int = 0
var _p_iframes: float = 0.0
var _p_regen_acc: float = 0.0

## stats：乘法倍率默认 1.0，加法默认 0
var _stats: Dictionary = {
	"damage_mult": 1.0,
	"rate_mult": 1.0,
	"proj_extra": 0,
	"move_mult": 1.0,
	"pickup_mult": 1.0,
	"proj_speed_mult": 1.0,
	"max_hp_add": 0,
	"regen_per2s": 0,
}

## 基地
var _base_pos := Vector2.ZERO
var _base_hp: int = BASE_MAX_HP

## 敌人（平行数组，swap-pop 删除）
var _e_pos := PackedVector2Array()
var _e_vel := PackedVector2Array()
var _e_hp := PackedInt32Array()
var _e_kind := PackedInt32Array()     # 0=rat 1=stray
var _e_state := PackedInt32Array()    # 0=to_base 1=chase
var _e_touch_cd := PackedFloat32Array()
var _e_base_cd := PackedFloat32Array()

const KIND_LIST: Array[StringName] = [&"rat", &"stray"]

## 投射物
var _pr_pos := PackedVector2Array()
var _pr_vel := PackedVector2Array()
var _pr_ttl := PackedFloat32Array()
var _pr_dmg := PackedInt32Array()
var _pr_color := PackedColorArray()

## AoE 视觉特效（方形淡出；M1.1 先用 Quad，视觉识别已足够）
var _fx_pos := PackedVector2Array()
var _fx_radius := PackedFloat32Array()
var _fx_color := PackedColorArray()
var _fx_ttl := PackedFloat32Array()
var _fx_ttl_max := PackedFloat32Array()

## 经验球
var _xp_pos := PackedVector2Array()
var _xp_val := PackedInt32Array()

## 运行状态
var _elapsed: float = 0.0
var _spawn_acc: float = 0.0
var _kills: int = 0
var _paused: bool = false
var _ended: bool = false
var _ended_win: bool = false

## 升级队列（支持连升多级，最多 3 连）
var _pending_level_ups: int = 0

## 面板用途区分：选角 / 升级 / 无
const PANEL_MODE_NONE := 0
const PANEL_MODE_CLASS_SELECT := 1
const PANEL_MODE_LEVEL_UP := 2
var _panel_mode: int = PANEL_MODE_NONE

## 临时调试开关：设为 &"cow" / &"am_short" 等可跳过选角面板直接开打。
## 正式发布时保持 &""（弹面板等玩家选）。
const _DEBUG_AUTOPICK_CLASS: StringName = &""


func _ready() -> void:
	_rng.randomize()
	_register_input_actions()
	_setup_multimeshes()
	_setup_world()
	_hide_panel()
	## 把玩家放到基地位置、渲染为灰色占位；选角之后再根据职业上色
	_p_pos = _base_pos + Vector2(0, -BASE_RADIUS - 30.0)
	_player.position = _p_pos
	_player_mark.color = Color(0.35, 0.35, 0.35)
	_base_mark.color = Color(0.45, 0.85, 0.55)
	var b := BASE_RADIUS * 2.0
	_base_mark.offset_left = -b * 0.5
	_base_mark.offset_top = -b * 0.5
	_base_mark.offset_right = b * 0.5
	_base_mark.offset_bottom = b * 0.5
	print("[siege] arena ready. waiting for class select")
	_show_class_select()


func _register_input_actions() -> void:
	var pairs := {
		&"siege_up": [KEY_W, KEY_UP],
		&"siege_down": [KEY_S, KEY_DOWN],
		&"siege_left": [KEY_A, KEY_LEFT],
		&"siege_right": [KEY_D, KEY_RIGHT],
	}
	for action_name in pairs.keys():
		var action: StringName = action_name
		if not InputMap.has_action(action):
			InputMap.add_action(action)
		for key in pairs[action]:
			if not _action_has_key(action, key):
				var ev := InputEventKey.new()
				ev.physical_keycode = key
				InputMap.action_add_event(action, ev)


func _action_has_key(action: StringName, key: int) -> bool:
	for ev in InputMap.action_get_events(action):
		if ev is InputEventKey and (ev as InputEventKey).physical_keycode == key:
			return true
	return false


func _setup_multimeshes() -> void:
	_enemies_mm.multimesh = _make_multimesh(Vector2(16.0, 16.0))
	_proj_mm.multimesh = _make_multimesh(Vector2(7.0, 7.0))
	_orbs_mm.multimesh = _make_multimesh(Vector2(9.0, 9.0))
	## AoE 的 Quad 基础尺寸 16，实例 scale = radius*2/16
	_aoe_fx_mm.multimesh = _make_multimesh(Vector2(16.0, 16.0))
	_aoe_fx_mm.z_index = -1


func _make_multimesh(default_quad: Vector2) -> MultiMesh:
	var quad := QuadMesh.new()
	quad.size = default_quad
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_2D
	mm.use_colors = true
	mm.mesh = quad
	return mm


func _setup_world() -> void:
	_base_pos = MAP_SIZE * 0.5
	_base.position = _base_pos


func _setup_player() -> void:
	var cls: Dictionary = SiegeData.CLASSES[_p_class_id]
	_p_max_hp = int(cls.hp)
	_p_hp = _p_max_hp
	_p_xp_need = SiegeData.xp_to_next(_p_level)
	_p_pos = _base_pos + Vector2(0, -BASE_RADIUS - 30.0)
	_player.position = _p_pos
	_player_mark.color = cls.color
	var mark_size := 28.0
	_player_mark.offset_left = -mark_size * 0.5
	_player_mark.offset_top = -mark_size * 0.5
	_player_mark.offset_right = mark_size * 0.5
	_player_mark.offset_bottom = mark_size * 0.5


func _apply_class_starting_stats() -> void:
	var cls: Dictionary = SiegeData.CLASSES[_p_class_id]
	var overrides: Variant = cls.get("stat_overrides", {})
	if typeof(overrides) != TYPE_DICTIONARY:
		return
	for k in overrides.keys():
		var v_cur: Variant = _stats.get(String(k), 0)
		var v_new: Variant = overrides[k]
		## 乘法型 stat 用覆盖；加法型用累加
		if typeof(v_cur) == TYPE_FLOAT:
			_stats[String(k)] = float(v_new)
		else:
			_stats[String(k)] = int(v_cur) + int(v_new)


func _process(delta: float) -> void:
	if _ended or _paused:
		_tick_damage_flash(delta)
		_update_hud()
		return
	_elapsed += delta
	_tick_player(delta)
	_tick_weapon(delta)
	_tick_spawner(delta)
	_tick_enemies(delta)
	_tick_projectiles(delta)
	_tick_pr_vs_enemies()
	_tick_enemies_vs_player(delta)
	_tick_enemies_vs_base(delta)
	_tick_orbs(delta)
	_tick_fx(delta)
	_tick_level_up_queue()
	_tick_damage_flash(delta)
	_refresh_multimeshes()
	_check_end_conditions()
	_update_hud()
	_log_periodic(delta)


func _tick_player(delta: float) -> void:
	var input_vec: Vector2 = Input.get_vector(&"siege_left", &"siege_right", &"siege_up", &"siege_down")
	var cls: Dictionary = SiegeData.CLASSES[_p_class_id]
	var speed: float = float(cls.speed) * float(_stats.move_mult)
	var target_vel: Vector2 = input_vec * speed
	_p_vel = _p_vel.lerp(target_vel, clampf(12.0 * delta, 0.0, 1.0))
	_p_pos += _p_vel * delta
	_p_pos.x = clampf(_p_pos.x, 0.0, MAP_SIZE.x)
	_p_pos.y = clampf(_p_pos.y, 0.0, MAP_SIZE.y)
	_player.position = _p_pos

	_p_iframes = maxf(0.0, _p_iframes - delta)
	var regen: int = int(_stats.regen_per2s)
	if regen > 0:
		_p_regen_acc += delta
		while _p_regen_acc >= 2.0:
			_p_regen_acc -= 2.0
			_p_hp = mini(_p_max_hp, _p_hp + regen)


func _tick_weapon(delta: float) -> void:
	if _p_class_id == &"":
		return
	var weapon_id: StringName = SiegeData.CLASSES[_p_class_id].weapon_id
	SiegeWeapons.tick(weapon_id, self, delta)


## -------- 武器 public API（被 siege_weapons.gd 调用） --------

func closest_enemy_to(pt: Vector2) -> int:
	return _closest_enemy_to(pt)

func get_enemy_pos(idx: int) -> Vector2:
	return _e_pos[idx]

func enemy_count() -> int:
	return _e_pos.size()

func fire_projectile(pos: Vector2, dir: Vector2, speed: float, ttl: float, dmg: int, color: Color = Color(1, 1, 1, 1)) -> void:
	_pr_pos.append(pos)
	_pr_vel.append(dir * speed)
	_pr_ttl.append(ttl)
	_pr_dmg.append(dmg)
	_pr_color.append(color)

func apply_aoe(pos: Vector2, radius: float, dmg: int) -> int:
	var r2: float = radius * radius
	var hit_count: int = 0
	var i: int = 0
	while i < _e_pos.size():
		if _e_pos[i].distance_squared_to(pos) <= r2:
			_e_hp[i] -= dmg
			if _e_hp[i] <= 0:
				_kill_enemy(i)
				hit_count += 1
				continue
			hit_count += 1
		i += 1
	return hit_count

func spawn_fx(pos: Vector2, radius: float, color: Color, ttl: float) -> void:
	_fx_pos.append(pos)
	_fx_radius.append(radius)
	_fx_color.append(color)
	_fx_ttl.append(ttl)
	_fx_ttl_max.append(maxf(ttl, 0.0001))


func _closest_enemy_to(pt: Vector2) -> int:
	var n := _e_pos.size()
	if n == 0:
		return -1
	var best := -1
	var best_d2 := INF
	for i in n:
		var d2 := _e_pos[i].distance_squared_to(pt)
		if d2 < best_d2:
			best_d2 = d2
			best = i
	return best


func _tick_spawner(delta: float) -> void:
	if _elapsed >= MATCH_DURATION_SEC:
		return
	_spawn_acc += delta
	var wave: Dictionary = SiegeData.current_wave(_elapsed)
	var interval: float = float(wave.spawn_interval_sec)
	while _spawn_acc >= interval:
		_spawn_acc -= interval
		_spawn_batch(int(wave.batch), wave.kinds)


func _spawn_batch(count: int, kinds_weights: Dictionary) -> void:
	for i in count:
		var kind: StringName = SiegeData.pick_weighted(kinds_weights, _rng)
		if kind == &"":
			continue
		_spawn_one(kind)


func _spawn_one(kind: StringName) -> void:
	var data: Dictionary = SiegeData.ENEMIES[kind]
	var angle: float = _rng.randf() * TAU
	var r: float = lerpf(SPAWN_RING_MIN, SPAWN_RING_MAX, _rng.randf())
	var pos: Vector2 = _p_pos + Vector2(cos(angle), sin(angle)) * r
	pos.x = clampf(pos.x, 20.0, MAP_SIZE.x - 20.0)
	pos.y = clampf(pos.y, 20.0, MAP_SIZE.y - 20.0)
	_e_pos.append(pos)
	_e_vel.append(Vector2.ZERO)
	_e_hp.append(int(data.hp))
	_e_kind.append(_kind_index(kind))
	_e_state.append(0)
	_e_touch_cd.append(0.0)
	_e_base_cd.append(0.0)


func _kind_index(kind: StringName) -> int:
	return KIND_LIST.find(kind)


func _spawn_initial_enemies(n: int) -> void:
	for i in n:
		_spawn_one(&"rat")


func _tick_enemies(delta: float) -> void:
	var n: int = _e_pos.size()
	if n == 0:
		return
	for i in n:
		var kind: StringName = KIND_LIST[_e_kind[i]]
		var data: Dictionary = SiegeData.ENEMIES[kind]
		var speed: float = float(data.speed)
		var aggro_r: float = float(data.aggro_radius)
		var release_r: float = float(data.aggro_release)

		var p: Vector2 = _e_pos[i]
		var state: int = _e_state[i]
		var to_player: Vector2 = _p_pos - p
		var to_player_d2: float = to_player.length_squared()

		if state == 0 and to_player_d2 <= aggro_r * aggro_r:
			state = 1
		elif state == 1 and to_player_d2 >= release_r * release_r:
			state = 0
		_e_state[i] = state

		var target: Vector2 = _p_pos if state == 1 else _base_pos
		var dir: Vector2 = (target - p).normalized()
		## 随机扰动让它们不重叠一条线
		dir = dir.rotated(_rng.randf_range(-ENEMY_SEPARATION_JITTER, ENEMY_SEPARATION_JITTER))
		var v: Vector2 = dir * speed
		_e_vel[i] = v
		p += v * delta
		p.x = clampf(p.x, 0.0, MAP_SIZE.x)
		p.y = clampf(p.y, 0.0, MAP_SIZE.y)
		_e_pos[i] = p

		_e_touch_cd[i] = maxf(0.0, _e_touch_cd[i] - delta)
		_e_base_cd[i] = maxf(0.0, _e_base_cd[i] - delta)


func _tick_projectiles(delta: float) -> void:
	var n: int = _pr_pos.size()
	if n == 0:
		return
	var i: int = 0
	while i < _pr_pos.size():
		_pr_ttl[i] -= delta
		if _pr_ttl[i] <= 0.0:
			_pop_projectile(i)
			continue
		_pr_pos[i] = _pr_pos[i] + _pr_vel[i] * delta
		var p: Vector2 = _pr_pos[i]
		if p.x < -50.0 or p.x > MAP_SIZE.x + 50.0 or p.y < -50.0 or p.y > MAP_SIZE.y + 50.0:
			_pop_projectile(i)
			continue
		i += 1


func _pop_projectile(i: int) -> void:
	var last := _pr_pos.size() - 1
	if i != last:
		_pr_pos[i] = _pr_pos[last]
		_pr_vel[i] = _pr_vel[last]
		_pr_ttl[i] = _pr_ttl[last]
		_pr_dmg[i] = _pr_dmg[last]
		_pr_color[i] = _pr_color[last]
	_pr_pos.resize(last)
	_pr_vel.resize(last)
	_pr_ttl.resize(last)
	_pr_dmg.resize(last)
	_pr_color.resize(last)


func _pop_fx(i: int) -> void:
	var last: int = _fx_pos.size() - 1
	if i != last:
		_fx_pos[i] = _fx_pos[last]
		_fx_radius[i] = _fx_radius[last]
		_fx_color[i] = _fx_color[last]
		_fx_ttl[i] = _fx_ttl[last]
		_fx_ttl_max[i] = _fx_ttl_max[last]
	_fx_pos.resize(last)
	_fx_radius.resize(last)
	_fx_color.resize(last)
	_fx_ttl.resize(last)
	_fx_ttl_max.resize(last)


func _tick_fx(delta: float) -> void:
	var i: int = 0
	while i < _fx_pos.size():
		_fx_ttl[i] -= delta
		if _fx_ttl[i] <= 0.0:
			_pop_fx(i)
			continue
		i += 1


func _tick_pr_vs_enemies() -> void:
	## 暴力 O(P×E)；P≤50 E≤500 的量级下仍在 25000 次距离检查，单机完全够
	var pi: int = 0
	while pi < _pr_pos.size():
		var pp: Vector2 = _pr_pos[pi]
		var hit_any := false
		var ei: int = 0
		while ei < _e_pos.size():
			var kind: StringName = KIND_LIST[_e_kind[ei]]
			var r: float = float(SiegeData.ENEMIES[kind].radius) + 4.0
			if pp.distance_squared_to(_e_pos[ei]) <= r * r:
				_e_hp[ei] -= _pr_dmg[pi]
				if _e_hp[ei] <= 0:
					_kill_enemy(ei)
					continue    # 继续同 ei 检查（已被 swap 的那只）
				hit_any = true
				break           # 投射物每发只击中 1 敌，M1 先不做穿透
			ei += 1
		if hit_any:
			_pop_projectile(pi)
			continue
		pi += 1


func _kill_enemy(i: int) -> void:
	var kind: StringName = KIND_LIST[_e_kind[i]]
	var data: Dictionary = SiegeData.ENEMIES[kind]
	_spawn_xp_orb(_e_pos[i], int(data.xp))
	_kills += 1
	var last: int = _e_pos.size() - 1
	if i != last:
		_e_pos[i] = _e_pos[last]
		_e_vel[i] = _e_vel[last]
		_e_hp[i] = _e_hp[last]
		_e_kind[i] = _e_kind[last]
		_e_state[i] = _e_state[last]
		_e_touch_cd[i] = _e_touch_cd[last]
		_e_base_cd[i] = _e_base_cd[last]
	_e_pos.resize(last)
	_e_vel.resize(last)
	_e_hp.resize(last)
	_e_kind.resize(last)
	_e_state.resize(last)
	_e_touch_cd.resize(last)
	_e_base_cd.resize(last)


func _tick_enemies_vs_player(_delta: float) -> void:
	if _p_iframes > 0.0:
		return
	var rp: float = PLAYER_RADIUS
	for i in _e_pos.size():
		var kind: StringName = KIND_LIST[_e_kind[i]]
		var r: float = float(SiegeData.ENEMIES[kind].radius) + rp
		if _e_pos[i].distance_squared_to(_p_pos) <= r * r and _e_touch_cd[i] <= 0.0:
			var dmg: int = int(SiegeData.ENEMIES[kind].touch_damage)
			_p_hp = maxi(0, _p_hp - dmg)
			_p_iframes = I_FRAME_SEC
			_e_touch_cd[i] = TOUCH_COOLDOWN_SEC
			_flash_damage()
			return


func _tick_enemies_vs_base(_delta: float) -> void:
	for i in _e_pos.size():
		var kind: StringName = KIND_LIST[_e_kind[i]]
		var r: float = float(SiegeData.ENEMIES[kind].radius) + BASE_RADIUS
		if _e_pos[i].distance_squared_to(_base_pos) <= r * r and _e_base_cd[i] <= 0.0:
			_base_hp = maxi(0, _base_hp - int(SiegeData.ENEMIES[kind].base_damage))
			_e_base_cd[i] = BASE_DAMAGE_INTERVAL_SEC
			_flash_damage()


func _spawn_xp_orb(pos: Vector2, val: int) -> void:
	_xp_pos.append(pos)
	_xp_val.append(val)


func _tick_orbs(delta: float) -> void:
	var pickup_r: float = PICKUP_BASE_RADIUS * float(_stats.pickup_mult)
	var pickup_r2: float = pickup_r * pickup_r
	var attract_r: float = pickup_r * ATTRACT_RADIUS_MULT
	var attract_r2: float = attract_r * attract_r
	var i: int = 0
	while i < _xp_pos.size():
		var op: Vector2 = _xp_pos[i]
		var d2: float = op.distance_squared_to(_p_pos)
		if d2 <= pickup_r2:
			_p_xp += _xp_val[i]
			_pop_orb(i)
			continue
		elif d2 <= attract_r2:
			var dir: Vector2 = (_p_pos - op).normalized()
			var speed: float = 80.0 + (attract_r2 - d2) / attract_r2 * 500.0
			_xp_pos[i] = op + dir * speed * delta
		i += 1


func _pop_orb(i: int) -> void:
	var last: int = _xp_pos.size() - 1
	if i != last:
		_xp_pos[i] = _xp_pos[last]
		_xp_val[i] = _xp_val[last]
	_xp_pos.resize(last)
	_xp_val.resize(last)


func _tick_level_up_queue() -> void:
	while _p_xp >= _p_xp_need:
		_p_xp -= _p_xp_need
		_p_level += 1
		_p_xp_need = SiegeData.xp_to_next(_p_level)
		_pending_level_ups += 1
	if _pending_level_ups > 0 and not _paused:
		_begin_level_up()


func _begin_level_up() -> void:
	if _panel_mode == PANEL_MODE_CLASS_SELECT:
		return   # 选角面板还没关闭，等它关闭后会再次触发（_process 里反复检查）
	var choices: Array = _roll_upgrade_choices(3)
	if choices.is_empty():
		_pending_level_ups = 0
		return
	_paused = true
	_show_level_up_panel(choices)
	print("[siege] level up! lv=%d pending=%d elapsed=%.1f kills=%d" % [
		_p_level, _pending_level_ups, _elapsed, _kills,
	])


func _roll_upgrade_choices(k: int) -> Array:
	var pool: Array = SiegeData.UPGRADES.duplicate()
	pool.shuffle()
	if pool.size() > k:
		pool.resize(k)
	return pool


func _show_level_up_panel(choices: Array) -> void:
	_clear_panel_children()
	var title := Label.new()
	title.text = "Lv %d！选一张强化" % _p_level
	title.add_theme_font_size_override(&"font_size", 20)
	title.add_theme_color_override(&"font_color", Color(0.98, 0.95, 0.75))
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_level_up_vbox.add_child(title)
	for ch in choices:
		var btn := Button.new()
		btn.custom_minimum_size = Vector2(360, 56)
		btn.text = "【%s】 %s" % [ch.label, ch.desc]
		btn.add_theme_font_size_override(&"font_size", 15)
		btn.pressed.connect(_on_choice_picked.bind(ch))
		_level_up_vbox.add_child(btn)
	_panel_mode = PANEL_MODE_LEVEL_UP
	_level_up_panel.visible = true


func _show_class_select() -> void:
	_clear_panel_children()
	var title := Label.new()
	title.text = "选择你的猫"
	title.add_theme_font_size_override(&"font_size", 22)
	title.add_theme_color_override(&"font_color", Color(0.98, 0.95, 0.75))
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_level_up_vbox.add_child(title)
	for cls_id in SiegeData.CLASS_ORDER:
		var cls: Dictionary = SiegeData.CLASSES[cls_id]
		var weapon: Dictionary = SiegeData.WEAPONS[cls.weapon_id]
		var btn := Button.new()
		btn.custom_minimum_size = Vector2(420, 68)
		btn.text = "【%s】 %s\nHP %d · 速度 %.0f · 武器：%s" % [
			cls.name, cls.tagline, int(cls.hp), float(cls.speed), weapon.name,
		]
		btn.add_theme_font_size_override(&"font_size", 14)
		btn.pressed.connect(_on_class_picked.bind(cls_id))
		_level_up_vbox.add_child(btn)
	_panel_mode = PANEL_MODE_CLASS_SELECT
	_paused = true
	_level_up_panel.visible = true
	if _DEBUG_AUTOPICK_CLASS != &"":
		call_deferred("_on_class_picked", _DEBUG_AUTOPICK_CLASS)


func _on_class_picked(cls_id: StringName) -> void:
	_p_class_id = cls_id
	_setup_player()
	_apply_class_starting_stats()
	_hide_panel()
	_spawn_initial_enemies(8)
	_show_banner("守好家，3 分钟！", 2.0)
	_paused = false
	print("[siege] class picked: %s hp=%d weapon=%s" % [
		_p_class_id, _p_hp, SiegeData.CLASSES[_p_class_id].weapon_id,
	])


func _clear_panel_children() -> void:
	for child in _level_up_vbox.get_children():
		child.queue_free()


func _hide_panel() -> void:
	_level_up_panel.visible = false
	_panel_mode = PANEL_MODE_NONE


func _on_choice_picked(ch: Dictionary) -> void:
	_apply_upgrade(ch)
	_hide_panel()
	_pending_level_ups -= 1
	_paused = false
	if _pending_level_ups > 0:
		call_deferred("_begin_level_up")


func _apply_upgrade(ch: Dictionary) -> void:
	var stat_name: String = String(ch.stat)
	var cur: Variant = _stats.get(stat_name, 0)
	if typeof(cur) == TYPE_FLOAT:
		_stats[stat_name] = float(cur) + float(ch.delta)
	else:
		_stats[stat_name] = int(cur) + int(ch.delta)
	if stat_name == "max_hp_add":
		_p_max_hp = int(SiegeData.CLASSES[_p_class_id].hp) + int(_stats.max_hp_add)
		_p_hp = _p_max_hp


func _refresh_multimeshes() -> void:
	var em: MultiMesh = _enemies_mm.multimesh
	em.instance_count = _e_pos.size()
	for i in _e_pos.size():
		var kind: StringName = KIND_LIST[_e_kind[i]]
		var data: Dictionary = SiegeData.ENEMIES[kind]
		var size: Vector2 = data.size
		## 用 scale 控制敌人外观；QuadMesh 的 size 默认 16，所以 scale = size / 16
		var scale_xy: Vector2 = size / 16.0
		var t := Transform2D(0.0, Vector2.ZERO).scaled(scale_xy)
		t.origin = _e_pos[i]
		em.set_instance_transform_2d(i, t)
		em.set_instance_color(i, data.color)

	var pm: MultiMesh = _proj_mm.multimesh
	pm.instance_count = _pr_pos.size()
	for i in _pr_pos.size():
		pm.set_instance_transform_2d(i, Transform2D(0.0, _pr_pos[i]))
		pm.set_instance_color(i, _pr_color[i])

	var om: MultiMesh = _orbs_mm.multimesh
	om.instance_count = _xp_pos.size()
	for i in _xp_pos.size():
		om.set_instance_transform_2d(i, Transform2D(0.0, _xp_pos[i]))
		om.set_instance_color(i, Color(0.45, 0.95, 1.0))

	var fm: MultiMesh = _aoe_fx_mm.multimesh
	fm.instance_count = _fx_pos.size()
	for i in _fx_pos.size():
		var scale_xy: Vector2 = Vector2.ONE * (_fx_radius[i] * 2.0 / 16.0)
		var t := Transform2D(0.0, Vector2.ZERO).scaled(scale_xy)
		t.origin = _fx_pos[i]
		fm.set_instance_transform_2d(i, t)
		var base_c: Color = _fx_color[i]
		var alpha_mul: float = clampf(_fx_ttl[i] / _fx_ttl_max[i], 0.0, 1.0)
		fm.set_instance_color(i, Color(base_c.r, base_c.g, base_c.b, base_c.a * alpha_mul))


func _check_end_conditions() -> void:
	if _base_hp <= 0:
		_ended = true
		_ended_win = false
		_show_banner("基地爆炸…失败。按 R 重开", 99.0)
	elif _p_hp <= 0:
		_ended = true
		_ended_win = false
		_show_banner("橘猫倒下了…失败。按 R 重开", 99.0)
	elif _elapsed >= MATCH_DURATION_SEC and _e_pos.is_empty():
		_ended = true
		_ended_win = true
		_show_banner("守住了！胜利。按 R 重开", 99.0)


func _log_periodic(delta: float) -> void:
	_log_acc += delta
	if _log_acc >= 5.0:
		_log_acc -= 5.0
		print("[siege] t=%.1f hp=%d base=%d lv=%d xp=%d/%d kills=%d enemies=%d proj=%d orbs=%d fx=%d" % [
			_elapsed, _p_hp, _base_hp, _p_level, _p_xp, _p_xp_need, _kills,
			_e_pos.size(), _pr_pos.size(), _xp_pos.size(), _fx_pos.size(),
		])


func _update_hud() -> void:
	@warning_ignore("integer_division")
	var mm_ss := "%02d:%02d" % [int(_elapsed) / 60, int(_elapsed) % 60]
	@warning_ignore("integer_division")
	var total_ss := "%02d:%02d" % [int(MATCH_DURATION_SEC) / 60, int(MATCH_DURATION_SEC) % 60]
	_lbl_hp.text = "HP  %d / %d" % [_p_hp, _p_max_hp]
	_lbl_base.text = "基地  %d / %d" % [_base_hp, BASE_MAX_HP]
	_lbl_lv.text = "Lv %d" % _p_level
	_lbl_xp.text = "XP  %d / %d" % [_p_xp, _p_xp_need]
	_lbl_time.text = "时间  %s / %s" % [mm_ss, total_ss]
	_lbl_kills.text = "击杀  %d    敌×%d" % [_kills, _e_pos.size()]
	_lbl_stats.text = "伤害×%.2f  攻速×%.2f  投射+%d  移速×%.2f  拾取×%.2f" % [
		_stats.damage_mult, _stats.rate_mult, _stats.proj_extra, _stats.move_mult, _stats.pickup_mult,
	]


var _banner_ttl: float = 0.0
var _log_acc: float = 0.0


func _show_banner(text: String, ttl: float) -> void:
	_banner.text = text
	_banner.visible = true
	_banner_ttl = ttl


func _tick_damage_flash(delta: float) -> void:
	if _damage_flash.modulate.a > 0.0:
		_damage_flash.modulate.a = maxf(0.0, _damage_flash.modulate.a - delta * 2.0)
	_banner_ttl -= delta
	if _banner_ttl <= 0.0:
		_banner.visible = false


func _flash_damage() -> void:
	_damage_flash.modulate.a = 0.35


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo:
		var k := event as InputEventKey
		if k.keycode == KEY_R and _ended:
			get_tree().reload_current_scene()
		elif k.keycode == KEY_ESCAPE:
			get_tree().quit()
