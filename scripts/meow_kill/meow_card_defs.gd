extends RefCounted
class_name MeowKillCardDefs
## 猫猫杀 V2（meowkill_newdesign.md）牌堆与美术 stem。
## 贴图目录：`res://assets/meow/cards/`（与本文件中的 stem 对应，不含扩展名）。

const ART_ROOT := "res://assets/meow/cards"

## 规划书牌堆（洗牌堆）：抓挠 28 / 闪躲 20 / 喵叫 24 / 装备 8 → **合计 80**。（全书写的「90」若含猫种 8 张等非洗牌组件另计；当前洗牌堆以表内四类为准。）
const COUNT_SCRATCH := 28
const COUNT_DODGE := 20
const COUNT_MEOW_FISH := 8
const COUNT_MEOW_TEASER := 6
const COUNT_MEOW_BRISTLE := 4
const COUNT_MEOW_SPRINT := 3
const COUNT_MEOW_BITE := 3
const COUNT_EQUIP := 8

const PLAYING_DECK_TOTAL := COUNT_SCRATCH + COUNT_DODGE + COUNT_MEOW_FISH + COUNT_MEOW_TEASER + COUNT_MEOW_BRISTLE + COUNT_MEOW_SPRINT + COUNT_MEOW_BITE + COUNT_EQUIP

## 抓挠 / 闪躲：按素材轮换的美术 stem（与 basic.png 分解顺序一致）。
const SCRATCH_ART_STEMS := [
	"card_scratch_art_tabby",
	"card_scratch_art_black",
	"card_scratch_art_orange",
	"card_scratch_art_calico",
]

const DODGE_ART_STEMS := [
	"card_dodge_art_siamese",
	"card_dodge_art_white",
	"card_dodge_art_longhair",
	"card_dodge_art_grey",
]

## 喵叫：与 `assets/meow/cards/card_meow_*.png` 一一对应。
const MEOW_FISH_STEMS := ["card_meow_fish"]
const MEOW_TEASER_STEMS := ["card_meow_teaser"]
const MEOW_BRISTLE_STEMS := ["card_meow_bristle"]
const MEOW_SPRINT_STEMS := ["card_meow_sprint"]
const MEOW_BITE_STEMS := ["card_meow_bite"]

## 装备洗牌堆 8 张：每类各 2 张。
const EQUIP_YARN_STEM := "equip_yarn_ball_a"
const EQUIP_TREE_STEM := "equip_cat_tree_a"
const EQUIP_BOX_STEM := "equip_cardboard_box_a"
const EQUIP_LASER_STEM := "equip_laser_pointer_a"

## 猫种（开局分配，非抽牌堆）。
const BREED_STEMS := [
	"breed_white",
	"breed_ragdoll",
	"breed_orange",
	"breed_british_shorthair",
	"breed_black",
	"breed_siamese",
	"breed_tabby",
	"breed_sphynx",
]

## 身份展示 stem（与 MK_ROLE 0–3：家/伴/野/独）。
const IDENTITY_STEMS := [
	"identity_house_cat",
	"identity_companion_cat",
	"identity_wild_cat",
	"identity_lone_cat",
]


static func art_path_from_stem(stem: String) -> String:
	return ART_ROOT.path_join("%s.png" % stem)


static func _stem_at(pool: Variant, i: int) -> String:
	var arr: Array = pool as Array
	if arr.is_empty():
		return ""
	return str(arr[posmod(i, arr.size())])


## 生成洗牌堆（80 张）：每项为 Dictionary，含 kind（逻辑类型）、zh（规则显示名）、stem（贴图 stem）。
static func build_deck_v2_entries() -> Array:
	var out: Array = []
	var si: int = 0
	for k in range(COUNT_SCRATCH):
		out.append({
			"kind": "scratch",
			"zh": "抓挠",
			"stem": _stem_at(SCRATCH_ART_STEMS, si),
		})
		si += 1
	var di: int = 0
	for k in range(COUNT_DODGE):
		out.append({
			"kind": "dodge",
			"zh": "闪躲",
			"stem": _stem_at(DODGE_ART_STEMS, di),
		})
		di += 1
	for k in range(COUNT_MEOW_FISH):
		out.append({
			"kind": "meow_fish",
			"zh": "小鱼干",
			"stem": _stem_at(MEOW_FISH_STEMS, k),
		})
	for k in range(COUNT_MEOW_TEASER):
		out.append({
			"kind": "meow_teaser",
			"zh": "逗猫棒",
			"stem": _stem_at(MEOW_TEASER_STEMS, k),
		})
	for k in range(COUNT_MEOW_BRISTLE):
		out.append({
			"kind": "meow_bristle",
			"zh": "炸毛",
			"stem": _stem_at(MEOW_BRISTLE_STEMS, k),
		})
	for k in range(COUNT_MEOW_SPRINT):
		out.append({
			"kind": "meow_sprint",
			"zh": "飞奔",
			"stem": _stem_at(MEOW_SPRINT_STEMS, k),
		})
	for k in range(COUNT_MEOW_BITE):
		out.append({
			"kind": "meow_bite",
			"zh": "咬咬",
			"stem": _stem_at(MEOW_BITE_STEMS, k),
		})
	out.append({"kind": "equip_yarn", "zh": "毛线球", "stem": EQUIP_YARN_STEM})
	out.append({"kind": "equip_yarn", "zh": "毛线球", "stem": EQUIP_YARN_STEM})
	out.append({"kind": "equip_tree", "zh": "猫爬架", "stem": EQUIP_TREE_STEM})
	out.append({"kind": "equip_tree", "zh": "猫爬架", "stem": EQUIP_TREE_STEM})
	out.append({"kind": "equip_box", "zh": "纸箱", "stem": EQUIP_BOX_STEM})
	out.append({"kind": "equip_box", "zh": "纸箱", "stem": EQUIP_BOX_STEM})
	out.append({"kind": "equip_laser", "zh": "激光笔", "stem": EQUIP_LASER_STEM})
	out.append({"kind": "equip_laser", "zh": "激光笔", "stem": EQUIP_LASER_STEM})
	return out


static func verify_deck_total() -> bool:
	return build_deck_v2_entries().size() == PLAYING_DECK_TOTAL


## 与现有服务端 instance id 兼容（CardRules：杀 0..19，闪 20..34，桃 35..42）：用于仅替换客户端贴图。
static func legacy_instance_texture_stem(instance_id: int) -> String:
	if instance_id >= 0 and instance_id < MeowKillCardRules.SLASH_MAX:
		return _stem_at(SCRATCH_ART_STEMS, instance_id)
	if instance_id >= MeowKillCardRules.SLASH_MAX and instance_id < MeowKillCardRules.JINK_MAX:
		return _stem_at(DODGE_ART_STEMS, instance_id - MeowKillCardRules.SLASH_MAX)
	if instance_id >= MeowKillCardRules.JINK_MAX and instance_id < MeowKillCardRules.PEACH_MAX:
		return _stem_at(MEOW_FISH_STEMS, instance_id - MeowKillCardRules.JINK_MAX)
	if instance_id == 43:
		return EQUIP_YARN_STEM
	if instance_id == 44:
		return EQUIP_TREE_STEM
	return "card_scratch_art_tabby"


static func legacy_texture_exists(instance_id: int) -> bool:
	var stem: String = legacy_instance_texture_stem(instance_id)
	return ResourceLoader.exists(art_path_from_stem(stem))


## 优先使用 `assets/meow/cards` 新素材；缺失则回退旧 `meowkill/big-card`。
static func hand_texture_path_or_legacy_fallback(instance_id: int) -> String:
	var stem: String = legacy_instance_texture_stem(instance_id)
	var p: String = art_path_from_stem(stem)
	if ResourceLoader.exists(p):
		return p
	return MeowKillCardAssets.hand_texture_path(MeowKillCardRules.card_key(instance_id))


static func play_texture_path_or_legacy_fallback(instance_id: int) -> String:
	var stem: String = legacy_instance_texture_stem(instance_id)
	var p_hand: String = art_path_from_stem(stem)
	if ResourceLoader.exists(p_hand):
		var fn: String = p_hand.get_file()
		var try_play: String = MeowKillCardAssets.PLAY_ROOT.path_join(fn)
		if ResourceLoader.exists(try_play):
			return try_play
		return p_hand
	return MeowKillCardAssets.play_texture_path(MeowKillCardRules.card_key(instance_id))
