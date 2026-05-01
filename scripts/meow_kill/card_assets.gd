extends RefCounted
class_name MeowKillCardAssets
## 猫猫杀游戏牌贴图：手牌用大图目录 `meowkill/big-card`，出牌区用 `meowkill/card`。
## `card_key` 使用小写蛇形名（与 QSanguosha / sunxi 常见 objectName 一致），如 `slash`、`snatch`、`crossbow`。
## 文件名在仓库中大小写不一致时，通过扫描目录建立「小写 stem → 真实文件名」索引，避免手写映射表。

const HAND_ROOT := "res://meowkill/big-card"
const PLAY_ROOT := "res://meowkill/card"

static var _hand_by_lc: Dictionary = {}
static var _play_by_lc: Dictionary = {}
static var _indexed: bool = false


static func _fill_png_index(root: String, into: Dictionary) -> void:
	var d: DirAccess = DirAccess.open(root)
	if d == null:
		push_error("MeowKillCardAssets: cannot open %s" % root)
		return
	d.list_dir_begin()
	var fn: String = d.get_next()
	while fn != "":
		if not d.current_is_dir() and fn.ends_with(".png"):
			var stem: String = fn.get_basename()
			into[stem.to_lower()] = fn
		fn = d.get_next()
	d.list_dir_end()


static func ensure_index() -> void:
	if _indexed:
		return
	_indexed = true
	_hand_by_lc.clear()
	_play_by_lc.clear()
	_fill_png_index(HAND_ROOT, _hand_by_lc)
	_fill_png_index(PLAY_ROOT, _play_by_lc)


## 手牌区贴图路径（`big-card`）。
static func hand_texture_path(card_key: String) -> String:
	ensure_index()
	var lc: String = card_key.to_lower()
	var fn: String = str(_hand_by_lc.get(lc, "%s.png" % lc))
	return HAND_ROOT.path_join(fn)


## 出牌区 / 桌面中央展示用贴图（`card`）；若该牌仅在 big-card 存在则回退到手牌图。
static func play_texture_path(card_key: String) -> String:
	ensure_index()
	var lc: String = card_key.to_lower()
	var fn: String = str(_play_by_lc.get(lc, _hand_by_lc.get(lc, "%s.png" % lc)))
	var p: String = PLAY_ROOT.path_join(fn)
	if ResourceLoader.exists(p):
		return p
	return hand_texture_path(card_key)


static func has_hand_art(card_key: String) -> bool:
	return ResourceLoader.exists(hand_texture_path(card_key))


static func has_play_art(card_key: String) -> bool:
	var p: String = play_texture_path(card_key)
	return ResourceLoader.exists(p)


## 返回已扫描到的游戏牌 key（小写 stem），便于调试或 UI 列表。
static func all_known_hand_keys() -> PackedStringArray:
	ensure_index()
	var out: PackedStringArray = PackedStringArray()
	for k in _hand_by_lc.keys():
		out.append(str(k))
	out.sort()
	return out
