extends Control
class_name SeatSpeechBubble
## 思考气泡：圆角矩形主体 + 三圆针脚；**主体宽高随文案测量**，不再强制固定比例。

enum TailAnchor {
	BOTTOM_LEFT,
	BOTTOM_RIGHT,
	RIGHT,
	## 尾巴向左伸出（气泡主体在右），用于左侧玩家：气泡靠桌面中央、针脚指向左缘头像
	LEFT,
}

const _TEXT_MAX_W_CAP := 300.0
const _PAD_H := 14.0
const _PAD_TOP := 12.0
const _PAD_BOTTOM := 14.0
const _MAX_HEIGHT_FRAC := 0.38
## 主体最小尺寸（避免圆角画不出来）
const _BODY_MIN_W := 52.0
const _BODY_MIN_H := 34.0

const _TAIL_EXT := 38.0
## 主框与尾巴圆线宽（约为原先 2.75 的 1/4）
const _OUTLINE_W := 1.0
const _CORNER_R_MAX := 18.0
## 暖色羊皮纸感气泡 + 古铜描边，与牌桌金绿协调
const _FILL_COLOR := Color(0.97, 0.93, 0.84, 0.96)
const _STROKE_COLOR := Color(0.48, 0.32, 0.12, 0.92)

const _TAIL_R1 := 7.5
const _TAIL_R2 := 5.2
const _TAIL_R3 := 3.2
const _TAIL_GAP := 2.0

signal layout_finished

@onready var _label: Label = $Label

var _tail_anchor: TailAnchor = TailAnchor.BOTTOM_LEFT
var _hide_timer: Timer
var _body_style: StyleBoxFlat
## 圆角矩形主体（本地坐标）
var _body_rect: Rect2 = Rect2()


func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	clip_contents = false
	_body_style = StyleBoxFlat.new()
	_body_style.bg_color = _FILL_COLOR
	_body_style.border_color = _STROKE_COLOR
	var bw: int = maxi(1, int(round(_OUTLINE_W)))
	_body_style.set_border_width_all(bw)
	_body_style.shadow_color = Color(0, 0, 0, 0.28)
	_body_style.shadow_size = 6
	_body_style.shadow_offset = Vector2(0, 2)
	if _label:
		_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
		_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		_label.custom_minimum_size = Vector2(_effective_text_max_w(), 0)
	_label.set_anchors_preset(Control.PRESET_TOP_LEFT)
	call_deferred("_rebuild_body_rect_from_total_size")
	call_deferred("_sync_label_in_body")
	_hide_timer = Timer.new()
	_hide_timer.one_shot = true
	add_child(_hide_timer)
	_hide_timer.timeout.connect(_on_hide_timeout)
	visible = false


func _notification(what: int) -> void:
	if what == NOTIFICATION_RESIZED:
		_rebuild_body_rect_from_total_size()
		_sync_label_in_body()
		queue_redraw()


func _draw() -> void:
	if size.x < 2.0 or size.y < 2.0:
		return
	if _body_rect.size.x < 2.0:
		return
	if _body_style:
		var cr: int = clampi(
			int(round(minf(_CORNER_R_MAX, minf(_body_rect.size.x, _body_rect.size.y) * 0.22))),
			0,
			64
		)
		_body_style.corner_radius_top_left = cr
		_body_style.corner_radius_top_right = cr
		_body_style.corner_radius_bottom_right = cr
		_body_style.corner_radius_bottom_left = cr
		draw_style_box(_body_style, _body_rect)
	_draw_tail_circles()


func _tail_direction() -> Vector2:
	match _tail_anchor:
		TailAnchor.BOTTOM_LEFT:
			return Vector2(-1.0, 1.0).normalized()
		TailAnchor.BOTTOM_RIGHT:
			return Vector2(1.0, 1.0).normalized()
		TailAnchor.RIGHT:
			return Vector2(1.0, 0.28).normalized()
		TailAnchor.LEFT:
			# 向左并略向下，从信息区下方指向左侧头像
			return Vector2(-1.0, 0.42).normalized()
	return Vector2.RIGHT


func _body_edge_point_on_rect(body: Rect2, outward: Vector2) -> Vector2:
	var c: Vector2 = body.get_center()
	var hw: float = body.size.x * 0.5
	var hh: float = body.size.y * 0.5
	var d: Vector2 = outward.normalized()
	var tx: float = INF
	var ty: float = INF
	if absf(d.x) > 1e-6:
		tx = hw / absf(d.x)
	if absf(d.y) > 1e-6:
		ty = hh / absf(d.y)
	var t: float = minf(tx, ty)
	return c + d * t


func _draw_tail_circles() -> void:
	var dir: Vector2 = _tail_direction()
	var edge: Vector2 = _body_edge_point_on_rect(_body_rect, dir)
	var c1: Vector2 = edge + dir * (_TAIL_R1 + 3.0)
	var step12: float = _TAIL_R1 + _TAIL_R2 + _TAIL_GAP
	var step23: float = _TAIL_R2 + _TAIL_R3 + _TAIL_GAP
	var c2: Vector2 = c1 + dir * step12
	var c3: Vector2 = c2 + dir * step23
	var centers: Array[Vector2] = [c1, c2, c3]
	var radii: Array[float] = [_TAIL_R1, _TAIL_R2, _TAIL_R3]
	for i in 3:
		var c: Vector2 = centers[i]
		var rr: float = radii[i]
		draw_circle(c, rr, _FILL_COLOR)
		draw_arc(c, rr, 0.0, TAU, maxi(12, int(rr * 5.0)), _STROKE_COLOR, _OUTLINE_W, true)


func _effective_text_max_w() -> float:
	var vr: Rect2 = get_viewport().get_visible_rect()
	var side_margin: float = 40.0
	var avail: float = vr.size.x - side_margin * 2.0
	return clampf(minf(_TEXT_MAX_W_CAP, avail), 72.0, _TEXT_MAX_W_CAP)


func set_tail_anchor(anchor: TailAnchor) -> void:
	_tail_anchor = anchor
	call_deferred("_rebuild_body_rect_from_total_size")
	call_deferred("_sync_label_in_body")
	call_deferred("queue_redraw")


## 尾巴圆点链最外侧（气泡泡尖约指向此处），供桌面把该点对齐到头像中心
func get_tail_tip_local() -> Vector2:
	if _body_rect.size.x < 2.0:
		return size * 0.5
	var dir: Vector2 = _tail_direction()
	var edge: Vector2 = _body_edge_point_on_rect(_body_rect, dir)
	var c1: Vector2 = edge + dir * (_TAIL_R1 + 3.0)
	var step12: float = _TAIL_R1 + _TAIL_R2 + _TAIL_GAP
	var step23: float = _TAIL_R2 + _TAIL_R3 + _TAIL_GAP
	var c2: Vector2 = c1 + dir * step12
	var c3: Vector2 = c2 + dir * step23
	return c3 + dir * _TAIL_R3


func _compute_body_size(need_w: float, need_h: float) -> Vector2:
	return Vector2(maxf(need_w, _BODY_MIN_W), maxf(need_h, _BODY_MIN_H))


func _compute_control_size(body: Vector2) -> Vector2:
	match _tail_anchor:
		TailAnchor.BOTTOM_LEFT, TailAnchor.BOTTOM_RIGHT:
			return Vector2(body.x + _TAIL_EXT, body.y + _TAIL_EXT * 0.35)
		TailAnchor.RIGHT, TailAnchor.LEFT:
			return Vector2(body.x + _TAIL_EXT * 1.55, body.y + _TAIL_EXT * 0.65)
	return body + Vector2(_TAIL_EXT, _TAIL_EXT)


func _body_rect_for_size(total: Vector2, body: Vector2) -> Rect2:
	match _tail_anchor:
		TailAnchor.BOTTOM_LEFT:
			return Rect2(Vector2(_TAIL_EXT, _TAIL_EXT * 0.35), body)
		TailAnchor.BOTTOM_RIGHT:
			return Rect2(Vector2(total.x - body.x - _TAIL_EXT, _TAIL_EXT * 0.35), body)
		TailAnchor.RIGHT:
			return Rect2(Vector2(_TAIL_EXT * 0.45, _TAIL_EXT * 0.25), body)
		TailAnchor.LEFT:
			return Rect2(Vector2(total.x - body.x - _TAIL_EXT * 0.45, _TAIL_EXT * 0.25), body)
	return Rect2(Vector2.ZERO, body)


func _infer_body_from_total(total: Vector2) -> Vector2:
	match _tail_anchor:
		TailAnchor.BOTTOM_LEFT, TailAnchor.BOTTOM_RIGHT:
			return Vector2(total.x - _TAIL_EXT, total.y - _TAIL_EXT * 0.35)
		TailAnchor.RIGHT, TailAnchor.LEFT:
			return Vector2(total.x - _TAIL_EXT * 1.55, total.y - _TAIL_EXT * 0.65)
	return total


func _rebuild_body_rect_from_total_size() -> void:
	if size.x < 8.0 or size.y < 8.0:
		return
	var body: Vector2 = _infer_body_from_total(size)
	_body_rect = _body_rect_for_size(size, body)


func _sync_label_in_body() -> void:
	if _label == null or _body_rect.size.x < 2.0:
		return
	var inner_w: float = maxf(8.0, _body_rect.size.x - _PAD_H * 2.0)
	var inner_h: float = maxf(8.0, _body_rect.size.y - _PAD_TOP - _PAD_BOTTOM)
	_label.position = _body_rect.position + Vector2(_PAD_H, _PAD_TOP)
	_label.size = Vector2(inner_w, inner_h)


func say(text: String, duration_sec: float = 2.5) -> void:
	if _label:
		_label.text = text
	visible = true
	_after_say_layout(duration_sec)


func _after_say_layout(duration_sec: float) -> void:
	await get_tree().process_frame
	await get_tree().process_frame
	if _label == null:
		return
	var text: String = _label.text
	var vr: Rect2 = get_viewport().get_visible_rect()
	var max_inner_h: float = maxf(36.0, vr.size.y * _MAX_HEIGHT_FRAC - _PAD_TOP - _PAD_BOTTOM)
	var max_tw_inner: float = minf(_effective_text_max_w(), vr.size.x - 32.0 - _PAD_H * 2.0)
	max_tw_inner = maxf(max_tw_inner, 48.0)

	var font: Font = _label.get_theme_font("font")
	if font == null:
		font = ThemeDB.fallback_font
	var fs: int = _label.get_theme_font_size("font_size")
	var line_fallback: float = maxf(float(font.get_height(fs)), 14.0)

	var raw_w: float = 24.0
	if not text.is_empty():
		raw_w = float(font.get_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, -1, fs).x)
	# 先按「单行自然宽度」起算，再放宽直到总高不超出；最后二分收窄宽度
	var tw: float = clampf(raw_w + 14.0, 32.0, max_tw_inner)
	var ms: Vector2 = font.get_multiline_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, tw, fs)
	if ms.y < 1.5:
		ms.y = line_fallback
	var guard: int = 0
	while ms.y > max_inner_h and tw < max_tw_inner - 0.5 and guard < 64:
		tw = minf(tw + maxf(10.0, (ms.y - max_inner_h) * 0.22), max_tw_inner)
		ms = font.get_multiline_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, tw, fs)
		guard += 1

	var h0: float = maxf(ms.y, line_fallback)
	var lo: float = 32.0
	var hi: float = tw
	for _shrink in range(24):
		if hi - lo < 2.5:
			break
		var mid: float = (lo + hi) * 0.5
		var tm: Vector2 = font.get_multiline_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, mid, fs)
		var th: float = maxf(tm.y, line_fallback)
		if th > h0 + 0.85:
			lo = mid
		else:
			hi = mid
	tw = hi
	ms = font.get_multiline_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, tw, fs)
	if ms.y < 1.5:
		ms.y = line_fallback

	var need_w: float = tw + _PAD_H * 2.0
	var need_h: float = ms.y + _PAD_TOP + _PAD_BOTTOM
	var body: Vector2 = _compute_body_size(need_w, need_h)
	var total: Vector2 = _compute_control_size(body)
	custom_minimum_size = total
	size = total
	_body_rect = _body_rect_for_size(total, body)
	var inner_w: float = maxf(8.0, _body_rect.size.x - _PAD_H * 2.0)
	_label.custom_minimum_size = Vector2(inner_w, 0)
	_label.position = _body_rect.position + Vector2(_PAD_H, _PAD_TOP)
	_label.size = Vector2(inner_w, _body_rect.size.y - _PAD_TOP - _PAD_BOTTOM)
	queue_redraw()
	layout_finished.emit()
	if _hide_timer:
		_hide_timer.stop()
		_hide_timer.wait_time = maxf(0.4, duration_sec)
		_hide_timer.start()


func hide_immediately() -> void:
	if _hide_timer:
		_hide_timer.stop()
	visible = false


func _on_hide_timeout() -> void:
	visible = false
