extends Node
## 供 MultiplayerSynchronizer 同步：仅房主写入，客人只读引擎下发的副本。

@export var sync_seq: int = 0
@export var state_json: String = ""
