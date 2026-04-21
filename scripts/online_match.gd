extends "res://scripts/main.gd"
## 服务端权威联网斗地主：继承主场景逻辑与 UI，通过 `_server_authoritative` 关闭本地发牌/AI/房主快照。
## 单机请使用 `main.tscn`；本场景由匹配成功后进入，与 `Modules/src/main.ts` 协议对应。


func _init() -> void:
	_server_authoritative = true
