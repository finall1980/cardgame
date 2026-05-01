extends Node
class_name MeowKillTableLayout
## 桌面方位：逻辑座位换算为「相对本家」索引 d∈[0,n)，用于绑定固定位置的 5/8 个 plaque 节点。
## 图示见 `docs/meow_kill_TABLE_LAYOUT.md`。


static func relative_seat(self_seat: int, seat: int, n: int) -> int:
	var nn: int = clampi(n, 2, 8)
	return ((seat - self_seat) % nn + nn) % nn
