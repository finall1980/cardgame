extends RefCounted
## 将 NakamaException 转为简短中文提示，供 UI 使用。
## 通过 preload(...).humanize(ex) 调用。


static func humanize(ex: NakamaException) -> String:
	if ex == null:
		return "未知错误。"
	if ex.cancelled:
		return "请求已取消。"
	var msg: String = ex.message.strip_edges()
	var lc: String = msg.to_lower()
	var sc: int = ex.status_code
	var grpc: int = ex.grpc_status_code
	if grpc == 4 or lc.find("deadline") >= 0 or lc.find("timeout") >= 0:
		return "连接超时，请检查网络或服务器是否可达。"
	if grpc == 14 or grpc == 13 or lc.find("connection") >= 0 or lc.find("refused") >= 0 or lc.find("unavailable") >= 0:
		return "无法连接服务器，请检查地址、端口或防火墙。"
	const GRPC_ALREADY_EXISTS := 6
	if grpc == GRPC_ALREADY_EXISTS or lc.find("already exists") >= 0 or lc.find("already registered") >= 0:
		return "该邮箱已注册，请直接登录。"
	if grpc == 5 or sc == 404 or lc.find("user not found") >= 0 or lc.find("account not found") >= 0:
		return "该邮箱尚未注册。"
	if grpc == 16 or grpc == 7 or lc.find("invalid") >= 0 or lc.find("credential") >= 0 or lc.find("unauthenticated") >= 0:
		return "邮箱或密码不正确。"
	if msg.is_empty():
		return "服务器返回错误（HTTP %d）。" % sc if sc > 0 else "通信失败。"
	return msg
