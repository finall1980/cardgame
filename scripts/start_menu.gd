extends Control

@onready var _bgm: AudioStreamPlayer = %BgmPlayer


func _ready() -> void:
	if _bgm.stream is AudioStreamMP3:
		(_bgm.stream as AudioStreamMP3).loop = true
	_bgm.play()
	%StartBtn.pressed.connect(_on_start_pressed)


func _on_start_pressed() -> void:
	get_tree().change_scene_to_file("res://scenes/main.tscn")
