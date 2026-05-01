extends Node2D
## M0 性能验证：MultiMesh 批量绘制敌人/投射物，按时间阶梯压测找拐点。
## 启动即进入自动压测，跑完全部档位后自动退出（便于 MCP 抓一次性数据）。
##
## 手动操作（按下任意键关闭自动压测后才生效）：
##   =/+  敌人 +100   -  敌人 -100
##   ]    投射 +50    [  投射 -50
##   A    切换 AI 复杂度（simple/complex）
##   R    重置 (500/100)
##   S    切换自动压测
##   ESC  退出

const ENEMY_SIZE := Vector2(12.0, 12.0)
const PROJ_SIZE := Vector2(5.0, 5.0)
const ARENA_SIZE := Vector2(2400.0, 2400.0)
const ENEMY_SPEED_MIN := 40.0
const ENEMY_SPEED_MAX := 120.0
const PROJ_SPEED := 500.0
const REPORT_INTERVAL := 0.25
const WARMUP_PER_TIER := 0.6

## 自动压测默认开启；每档持续 3 秒，跑完自动退出
const AUTO_STRESS_DEFAULT := true
const STRESS_PLAN := [
	{"secs": 2.5, "enemies": 500, "proj": 100},
	{"secs": 2.5, "enemies": 2000, "proj": 300},
	{"secs": 2.5, "enemies": 5000, "proj": 1000},
	{"secs": 2.5, "enemies": 8000, "proj": 1500},
	{"secs": 2.5, "enemies": 12000, "proj": 2000},
	{"secs": 2.5, "enemies": 15000, "proj": 3000},
	{"secs": 2.5, "enemies": 20000, "proj": 4000},
]

@onready var _enemies_mm: MultiMeshInstance2D = $Enemies
@onready var _proj_mm: MultiMeshInstance2D = $Projectiles
@onready var _player: Node2D = $Player
@onready var _hud: Label = $HUD/Label

var _enemy_pos := PackedVector2Array()
var _enemy_vel := PackedVector2Array()
var _proj_pos := PackedVector2Array()
var _proj_vel := PackedVector2Array()

var _report_acc := 0.0
var _complex_ai := true

var _auto_stress := AUTO_STRESS_DEFAULT
var _stress_idx := -1
var _stress_elapsed := 0.0
var _tier_fps_samples: Array[int] = []
var _tier_cpu_ms_samples: Array[float] = []
var _tier_warmup := 0.0


func _ready() -> void:
	randomize()
	## 关闭 VSync 以测出真实 CPU/GPU 预算；HUD 里 fps 才反映实际处理能力
	DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
	Engine.max_fps = 0
	_player.position = get_viewport_rect().size * 0.5
	_setup_multimeshes()
	if _auto_stress:
		_enter_stress_tier(0)
	else:
		_set_counts(500, 100)
	print("[perf] demo started. stress=%s tiers=%d" % [_auto_stress, STRESS_PLAN.size()])


func _setup_multimeshes() -> void:
	_enemies_mm.multimesh = _make_multimesh(ENEMY_SIZE)
	_proj_mm.multimesh = _make_multimesh(PROJ_SIZE)


func _make_multimesh(quad_size: Vector2) -> MultiMesh:
	var quad := QuadMesh.new()
	quad.size = quad_size
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_2D
	mm.use_colors = true
	mm.mesh = quad
	return mm


func _set_counts(n_enemies: int, n_proj: int) -> void:
	n_enemies = maxi(0, n_enemies)
	n_proj = maxi(0, n_proj)
	_resize_enemies(n_enemies)
	_resize_projectiles(n_proj)


func _resize_enemies(n: int) -> void:
	var old_n := _enemy_pos.size()
	_enemy_pos.resize(n)
	_enemy_vel.resize(n)
	var mm := _enemies_mm.multimesh
	mm.instance_count = n
	var center: Vector2 = _player.position
	for i in range(old_n, n):
		var angle := randf() * TAU
		var r := 220.0 + randf() * (ARENA_SIZE.x * 0.45)
		var pos := center + Vector2(cos(angle), sin(angle)) * r
		var spd := lerpf(ENEMY_SPEED_MIN, ENEMY_SPEED_MAX, randf())
		_enemy_pos[i] = pos
		_enemy_vel[i] = (center - pos).normalized() * spd
		mm.set_instance_color(i, _color_for_enemy(i))


func _resize_projectiles(n: int) -> void:
	var old_n := _proj_pos.size()
	_proj_pos.resize(n)
	_proj_vel.resize(n)
	var mm := _proj_mm.multimesh
	mm.instance_count = n
	var center: Vector2 = _player.position
	for i in range(old_n, n):
		_proj_pos[i] = center
		var a := randf() * TAU
		_proj_vel[i] = Vector2(cos(a), sin(a)) * PROJ_SPEED
		mm.set_instance_color(i, Color(0.4, 0.95, 1.0))


func _color_for_enemy(i: int) -> Color:
	var k := i % 4
	match k:
		0: return Color(1.0, 0.45, 0.25)
		1: return Color(0.95, 0.75, 0.30)
		2: return Color(0.75, 0.45, 0.85)
		_: return Color(0.40, 0.85, 0.55)


func _process(delta: float) -> void:
	_step_enemies(delta)
	_step_projectiles(delta)
	if _auto_stress:
		_tick_stress(delta)
	_tier_warmup += delta
	_report_acc += delta
	if _report_acc >= REPORT_INTERVAL:
		_report_acc = 0.0
		_sample_and_hud()


func _step_enemies(delta: float) -> void:
	var n := _enemy_pos.size()
	if n == 0:
		return
	var mm := _enemies_mm.multimesh
	var center: Vector2 = _player.position
	var half_arena: Vector2 = ARENA_SIZE * 0.5
	var lerp_t := clampf(2.0 * delta, 0.0, 1.0)
	var jitter := 0.04
	for i in n:
		var p := _enemy_pos[i]
		var v := _enemy_vel[i]
		if _complex_ai:
			var dir := (center - p).normalized()
			var spd := v.length()
			v = v.lerp(dir * spd, lerp_t)
			v = v.rotated(randf_range(-jitter, jitter))
		p += v * delta
		if p.distance_squared_to(center) < 900.0:
			v = -v
		var dx := p.x - center.x
		var dy := p.y - center.y
		if absf(dx) > half_arena.x:
			v.x = -v.x
			p.x = center.x + signf(dx) * half_arena.x
		if absf(dy) > half_arena.y:
			v.y = -v.y
			p.y = center.y + signf(dy) * half_arena.y
		_enemy_pos[i] = p
		_enemy_vel[i] = v
		mm.set_instance_transform_2d(i, Transform2D(0.0, p))


func _step_projectiles(delta: float) -> void:
	var n := _proj_pos.size()
	if n == 0:
		return
	var mm := _proj_mm.multimesh
	var center: Vector2 = _player.position
	var max_r := ARENA_SIZE.x * 0.55
	var max_r_sq := max_r * max_r
	for i in n:
		var p := _proj_pos[i] + _proj_vel[i] * delta
		if p.distance_squared_to(center) > max_r_sq:
			p = center
			var a := randf() * TAU
			_proj_vel[i] = Vector2(cos(a), sin(a)) * PROJ_SPEED
		_proj_pos[i] = p
		mm.set_instance_transform_2d(i, Transform2D(0.0, p))


func _tick_stress(delta: float) -> void:
	_stress_elapsed += delta
	var tier: Dictionary = STRESS_PLAN[_stress_idx]
	if _stress_elapsed >= float(tier.secs):
		_print_tier_summary(_stress_idx)
		_stress_elapsed = 0.0
		_tier_fps_samples.clear()
		_tier_warmup = 0.0
		var next_idx := _stress_idx + 1
		if next_idx >= STRESS_PLAN.size():
			print("[perf] stress plan complete, holding on last tier")
			_auto_stress = false
			return
		_enter_stress_tier(next_idx)


func _enter_stress_tier(idx: int) -> void:
	_stress_idx = idx
	_stress_elapsed = 0.0
	_tier_warmup = 0.0
	_tier_fps_samples.clear()
	_tier_cpu_ms_samples.clear()
	var tier: Dictionary = STRESS_PLAN[idx]
	_set_counts(int(tier.enemies), int(tier.proj))
	print("[perf] --- tier %d/%d: enemies=%d proj=%d for %.1fs ---" % [
		idx + 1, STRESS_PLAN.size(), int(tier.enemies), int(tier.proj), float(tier.secs),
	])


func _print_tier_summary(idx: int) -> void:
	if _tier_fps_samples.is_empty():
		print("[perf] tier %d summary: no samples" % [idx + 1])
		return
	var total := 0
	var minv := _tier_fps_samples[0]
	var maxv := _tier_fps_samples[0]
	for v in _tier_fps_samples:
		total += v
		if v < minv:
			minv = v
		if v > maxv:
			maxv = v
	var avg_fps: float = float(total) / float(_tier_fps_samples.size())
	var cpu_total := 0.0
	var cpu_min := _tier_cpu_ms_samples[0]
	var cpu_max := _tier_cpu_ms_samples[0]
	for c in _tier_cpu_ms_samples:
		cpu_total += c
		if c < cpu_min:
			cpu_min = c
		if c > cpu_max:
			cpu_max = c
	var avg_cpu: float = cpu_total / float(_tier_cpu_ms_samples.size())
	var tier: Dictionary = STRESS_PLAN[idx]
	print("[perf] TIER %d SUMMARY enemies=%d proj=%d avg_fps=%.1f min=%d max=%d cpu_avg=%.2fms cpu_min=%.2f cpu_max=%.2f samples=%d" % [
		idx + 1, int(tier.enemies), int(tier.proj),
		avg_fps, minv, maxv,
		avg_cpu, cpu_min, cpu_max,
		_tier_fps_samples.size(),
	])


func _sample_and_hud() -> void:
	var fps := Engine.get_frames_per_second()
	var frame_ms := 1000.0 / maxf(float(fps), 1.0)
	## CPU 帧逻辑耗时（不受 VSync 影响，这才是真实预算占用）
	var cpu_ms := Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0
	var gpu_ms := Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS) * 1000.0
	var draws := int(Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME))
	var items := int(Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME))
	var mem_mb := Performance.get_monitor(Performance.MEMORY_STATIC) / 1048576.0
	var ai_mode := "complex" if _complex_ai else "simple"
	var tier_label := "tier %d/%d" % [_stress_idx + 1, STRESS_PLAN.size()] if _auto_stress else "manual"
	_hud.text = "[%s]\nFPS: %d (%.2f ms)\nCPU Frame: %.2f ms\nEnemies: %d\nProjectiles: %d\nDraw Calls: %d\nRender Objs: %d\nMem: %.1f MB\nAI: %s" % [
		tier_label, fps, frame_ms, cpu_ms, _enemy_pos.size(), _proj_pos.size(), draws, items, mem_mb, ai_mode,
	]
	## warmup 结束后才纳入统计，避免切档瞬间抖动污染均值
	if _tier_warmup >= WARMUP_PER_TIER:
		_tier_fps_samples.append(fps)
		_tier_cpu_ms_samples.append(cpu_ms)
		print("[perf] %s fps=%d cpu_ms=%.2f phys_ms=%.2f enemies=%d proj=%d draws=%d" % [
			tier_label, fps, cpu_ms, gpu_ms, _enemy_pos.size(), _proj_pos.size(), draws,
		])


func _unhandled_input(event: InputEvent) -> void:
	if not (event is InputEventKey) or not event.pressed or event.echo:
		return
	var k: InputEventKey = event
	match k.keycode:
		KEY_S:
			_auto_stress = not _auto_stress
			print("[perf] auto_stress = %s" % _auto_stress)
		KEY_EQUAL, KEY_PLUS, KEY_KP_ADD:
			_auto_stress = false
			_set_counts(_enemy_pos.size() + 100, _proj_pos.size())
		KEY_MINUS, KEY_KP_SUBTRACT:
			_auto_stress = false
			_set_counts(_enemy_pos.size() - 100, _proj_pos.size())
		KEY_BRACKETRIGHT:
			_auto_stress = false
			_set_counts(_enemy_pos.size(), _proj_pos.size() + 50)
		KEY_BRACKETLEFT:
			_auto_stress = false
			_set_counts(_enemy_pos.size(), _proj_pos.size() - 50)
		KEY_A:
			_complex_ai = not _complex_ai
		KEY_R:
			_auto_stress = false
			_set_counts(500, 100)
		KEY_ESCAPE:
			get_tree().quit()
