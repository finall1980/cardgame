extends RefCounted
class_name MeowKillGeneralAssets
## 武将相关资源路径。完整武将牌若已有合成图，用 `generals/card/*.jpg`；
## 否则用 `generals/big` 肖像 + `kingdom/frame` 等在游戏内拼接（见 `compose_layer_paths`）。

const PORTRAIT_BIG_ROOT := "res://meowkill/generals/big"
const FULLSKIN_GENERALS_ROOT := "res://meowkill/fullskin/generals/full"
const CARD_FLAT_ROOT := "res://meowkill/generals/card"
const KINGDOM_FRAME_ROOT := "res://meowkill/kingdom/frame"
const KINGDOM_ICON_ROOT := "res://meowkill/kingdom/icon"
const COMPACT_FRAME_ROOT := "res://meowkill/compact/frame"


static func kingdom_frame_path(kingdom: String) -> String:
	return KINGDOM_FRAME_ROOT.path_join("%s.png" % kingdom.to_lower())


static func kingdom_icon_path(kingdom: String) -> String:
	return KINGDOM_ICON_ROOT.path_join("%s.png" % kingdom.to_lower())


## 全身立绘底图（猫猫杀主将牌面）。
static func fullskin_path(general_id: String) -> String:
	var p: String = FULLSKIN_GENERALS_ROOT.path_join("%s.png" % general_id)
	return p if ResourceLoader.exists(p) else ""


## 大卡半身像（部分武将仅有合成卡而无 big，返回空字符串）。
static func portrait_big_path(general_id: String) -> String:
	var p: String = PORTRAIT_BIG_ROOT.path_join("%s.png" % general_id)
	return p if ResourceLoader.exists(p) else ""


## 已合成的武将牌立绘（jpg 为主）。
static func precomposed_card_path(general_id: String) -> String:
	for ext: String in ["jpg", "png"]:
		var p: String = CARD_FLAT_ROOT.path_join("%s.%s" % [general_id, ext])
		if ResourceLoader.exists(p):
			return p
	return ""


## 牌面状态装饰框：playing / responding / selected / sos 等（按素材实际文件名）。
static func compact_frame_path(state: String) -> String:
	return COMPACT_FRAME_ROOT.path_join("%s.png" % state)


## 拼接一层 UI 时推荐的图层路径（TextureRect 自下而上叠放顺序由场景决定）。
static func compose_layer_paths(general_id: String, kingdom: String) -> Dictionary:
	return {
		"kingdom_frame": kingdom_frame_path(kingdom),
		"kingdom_icon": kingdom_icon_path(kingdom),
		"portrait_big": portrait_big_path(general_id),
		"precomposed": precomposed_card_path(general_id),
	}
