# 《喵家保卫战》M0 · 安卓真机性能验证清单（C 路线）

目的：把 `scenes/siege/perf_demo.tscn` 压测脚本导出到 Android 真机跑一次，拿到 **手机端的 MultiMesh 上限**，回填进 `docs/meow_home_siege_M0_PERF_REPORT.md`。

---

## 一、预期产出（你回发给我的东西）

1. 完整 `adb logcat` 中所有 `[perf]` 开头的行（所有档位的 `tier done` 以及每 0.25s 的采样）
2. 手机信息：**型号 / SoC / Android 版本 / 屏幕分辨率**
3. 跑到哪一档时出现：
   - ① 平均 FPS 跌破 60
   - ② 平均 FPS 跌破 30（卡手）
   - ③ 明显发烫或系统限频（如果你感觉到）

不用截图 HUD，logcat 里已经把所有数字都打出来了。

---

## 二、准备一次性工具（只装一次）

macOS：

```bash
brew install android-platform-tools   # 提供 adb
adb --version                         # 能打印版本就好
```

手机：**开发者选项 → USB 调试**打开，插 USB，授权电脑调试。

```bash
adb devices   # 能看到你的手机，状态 device 即可
```

---

## 三、导出 APK（二选一）

两种路径都行，**推荐 A**（Godot 编辑器里点一下就行）。

### 方案 A · Godot 编辑器导出（推荐）

1. 打开本项目：`/Users/song/GameDev/CardGame`
2. 项目 → 导出：
   - 如果弹"未找到导出模板"→ 点击下载并安装
   - 已有 `Android` 预设（`gradle_build/use_gradle_build=false`，走官方预构建模板，不需要 Android Studio / SDK）
3. **临时改 Main Scene 为 perf_demo**：
   - 打开 `project.godot`，把 `run/main_scene` 改成：
     ```
     run/main_scene="res://scenes/siege/perf_demo.tscn"
     ```
   - 测完再改回 `res://scenes/start_menu.tscn`
4. 在导出对话框里点「**Export Project**」→ 保存为 `perf_demo.apk`（debug 模板，勾选"Export With Debug"）
   - 第一次会自动生成 debug keystore，无需手动操作
5. 可选：把 `preset.3 · Android` 的 **Orientation** 设为 `Landscape`，视野更大

### 方案 B · 命令行导出（不想开编辑器）

```bash
cd /Users/song/GameDev/CardGame

# 1. 临时改 main_scene
cp project.godot project.godot.bak
sed -i '' 's|run/main_scene=.*|run/main_scene="res://scenes/siege/perf_demo.tscn"|' project.godot

# 2. 导出（把 <GODOT> 换成你的 Godot 4.6 可执行文件路径）
<GODOT> --headless --path . --export-debug "Android" perf_demo.apk

# 3. 恢复
mv project.godot.bak project.godot
```

---

## 四、安装 + 运行 + 抓 log

```bash
cd /Users/song/GameDev/CardGame

# 安装（-r 覆盖旧版）
adb install -r perf_demo.apk

# 开始抓 log（另开一个 Terminal 保持不动）
adb logcat -c                                # 清空 buffer
adb logcat godot:V *:S | tee perf_demo_android.log

# 回到手机，从桌面点 "DouDizhu" 图标启动
# 或者命令行启动（包名看导出预设里的 package/unique_name，默认 com.cardgame.doudizhu）
# adb shell am start -n com.cardgame.doudizhu/com.godot.game.GodotApp
```

压测会自动跑完 7 档（约 18 秒）后停在最后一档并打印：

```
[perf] stress plan complete, holding on last tier, press ESC to quit
```

此时手动 **强制退出 app** 或：

```bash
adb shell am force-stop com.cardgame.doudizhu
```

**Ctrl+C** 停止 logcat 抓取，文件存为 `perf_demo_android.log`。

---

## 五、关键 log 样例

你只需要把这样的行发给我（文件整份就行）：

```
[perf] tier 0 done: secs=2.5 avg_fps=120 avg_cpu_ms=8.3 ...
[perf] tier 1 done: secs=2.5 avg_fps=...
...
[perf] tier 6 done: ...
```

以及每 0.25 秒那种：

```
[perf] t=3.1 tier=1 enemies=2000 proj=300 fps=60 cpu=10.4 phys=0.0 draw=12 ...
```

---

## 六、失败兜底

- **adb 看不到手机**：换根数据线；确认 USB 模式是"文件传输"而非"仅充电"；手机端重新授权本电脑。
- **安装时提示签名冲突**：先 `adb uninstall com.cardgame.doudizhu`。
- **启动后黑屏 / 崩溃**：logcat 里找 `FATAL`、`AndroidRuntime`、`godot` 开头的 E 级行，全部发我。
- **FPS 从第一档就低（<30）**：大概率是 main_scene 没改对，跑的是斗地主不是 perf_demo；检查 `project.godot`。

---

## 七、完成后

告诉我：

1. 贴 `perf_demo_android.log` 内容（或者只贴所有 `[perf]` 行）
2. 告诉我手机型号 / SoC / Android 版本

我会把结果回写到 `docs/meow_home_siege_M0_PERF_REPORT.md` 的 "移动端基线" 一节，并据此决定：

- 单局敌人在场上限（手机档位）
- 是否需要 SpatialHash 提前做
- 需不需要把 enemy 四方向朝向动画简化为常驻 1 张图
