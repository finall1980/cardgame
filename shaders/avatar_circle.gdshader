shader_type canvas_item;
render_mode blend_mix;

/// 仅贴外缘的装饰环厚度（占半径比例），越小头像越大、边越细
uniform float ring_band : hint_range(0.025, 0.12) = 0.052;
uniform vec4 ring_inner : source_color = vec4(1.0, 0.9, 0.42, 1.0);
uniform vec4 ring_outer : source_color = vec4(0.28, 0.88, 0.78, 1.0);

void fragment() {
	vec2 p = UV * 2.0 - 1.0;
	float d = length(p);
	if (d > 1.0) {
		discard;
	}

	vec4 tex = texture(TEXTURE, UV);
	float inner_r = 1.0 - ring_band;

	// 内圈完整显示贴图，不与描边混色（避免“吃掉”脸部）
	if (d <= inner_r) {
		COLOR = tex;
	} else {
		float span = max(1e-4, ring_band);
		float t = clamp((d - inner_r) / span, 0.0, 1.0);
		float pulse = 0.92 + 0.08 * sin(TIME * 2.8);
		vec3 ring_rgb = mix(ring_inner.rgb, ring_outer.rgb, t) * pulse;
		// 外缘轻微抗锯齿
		float edge_a = 1.0 - smoothstep(0.985, 1.0, d);
		COLOR = vec4(ring_rgb, edge_a);
	}
}
