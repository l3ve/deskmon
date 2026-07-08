# Key Point

## Key Files

- `src/pet.ts`: 桌宠控制器，负责拖拽、移动循环、悬停暂停、计时器事件和右键触发原生小菜单。
- `src/pet/activityCadence.ts`: 桌宠活动节奏策略，集中管理安静/标准/活泼的速度、run 概率、休息窗口、到达阈值和状态切换节奏常量。
- `src/pet/geometry.ts`: 桌宠前端坐标、插值、移动和矩形 clamp 工具。
- `src/pet/giantCelebration.ts`: 倒计时结束巨型庆祝动效的状态、分段时间和尺寸/位置插值。
- `src/pet/slime.ts`: 默认史莱姆 sprite sheet 加载、逐帧裁剪、锚点归一化和代码绘制兜底。
- `src/assets/slime/*.png`: 默认史莱姆 7 个状态的 sprite sheet 素材。
- `src-tauri/src/lib.rs`: macOS 窗口、托盘菜单、计时器状态、Tauri command 和应用编排。
- `src-tauri/src/geometry.rs`: 后端屏幕、活动区域、宠物物理尺寸和可见工作区 clamp 逻辑。
- `src-tauri/src/settings.rs`: 用户偏好类型、默认值、逻辑尺寸映射和 settings.json 读写。
- `src-tauri/assets/tray-icon.png`: macOS 菜单栏专用 template 图标，编译进 Rust，不放进 `src-tauri/icons`。
- `src-tauri/src/remember.rs`: “记忆力”状态、文本规范化、笔记本加密/解密和核心规则测试。
- `src/remember.ts`: “记忆力”窗口前端，负责记忆中/笔记本列表、详情和管理操作。
- `docs/prds/001-tauri-mac-desktop-pet.md`: V1 产品边界和交互规格。
- `docs/prds/002-remember-clipboard-history.md`: “记忆力”剪贴板历史功能边界和实现决策。
- `docs/prds/003-remember-variable-library.md`: “记忆力”变量库的 key/value 私密取出、搜索和自动清理边界。
- `docs/prds/004-timer-finished-giant-celebration.md`: 倒计时结束时巨型庆祝提醒/巨型庆祝动效的触发、分段、尺寸、恢复和测试边界。
- `docs/prds/005-desktop-pet-animation-polish.md`: 桌宠动画节奏优化 PRD，限定为不新增能力、不改素材，只打磨现有 7 个状态的播放和移动观感。
- `docs/designs/remember-variable-library.svg`: “记忆力”变量库窗口设计图源文件。
- `docs/designs/remember-variable-library.png`: “记忆力”变量库窗口设计图预览。
- `docs/designs/remember-variable-library-ui-flow.svg`: “记忆力”变量库完整交互状态总览图。
- `docs/designs/remember-variable-library-ui-flow.png`: “记忆力”变量库完整交互状态预览图。
- `docs/designs/remember-variable-library-ui.md`: “记忆力”变量库 UI 信息架构和交互状态说明。
- `docs/qa/v1-smoke-checklist.md`: V1 发布前手工 smoke test 清单。

## Important Decisions

- 左键单击宠物不触发操作；右键打开宠物小菜单。
- 鼠标悬停在宠物上时，自主移动暂停，但动画和计时器继续。
- 悬停暂停不能只依赖 `pointerleave`；需要用原生 cursor/window frame 定期校准，避免丢事件后卡 idle。
- 宠物小菜单使用 macOS 原生弹出菜单，不使用前端自绘菜单作为常规交互。
- 原生菜单倒计时用 `MenuItem::set_text` 更新已有菜单项文本，避免整棵菜单重建。
- 菜单栏提供“移回活动区域”；该入口会显示宠物、移到当前活动区域内并持久化位置，宠物小菜单保持轻量不放归位入口。
- 菜单栏托盘图标使用独立的 32x32 template PNG，通过 `include_bytes!` 接入；主体非透明边界约 28x28，应用图标和托盘图标不要共用同一张彩色 icon。
- 设置页活动区域框选在拖动阶段先限制在默认活动区域内，并即时提示尺寸/最小尺寸/保存状态；后端仍用 `normalize_activity_area` 兜底。
- “记忆力”剪贴板历史是 001 后的独立功能；只支持纯文本，菜单栏入口叫“记忆力”，宠物小菜单轻量入口叫“回忆”。
- “记忆中”是运行期临时历史，最多 10 条，不落盘；“笔记本”是用户主动保存的持久历史，最多 50 条。
- “笔记本”必须加密存储且不允许文本明文落盘；V1 采用本地随机 key 文件 + 加密数据文件，不做强安全承诺。
- 剪贴板轮询启动时先把当前剪贴板作为基线但不加入“记忆中”，之后新增文本才进入临时历史。
- “记忆力”使用 `arboard` 读写纯文本剪贴板，`chacha20poly1305` 加密笔记本，原生确认用 `tauri-plugin-dialog`。
- 菜单栏把“记忆力”和“记住刚想到的”作为一级入口分组展示；“记住刚想到的”只读取当前系统剪贴板并保存到“笔记本”，不主动写入“记忆中”，成功/失败都用 macOS 通知反馈。
- 小菜单“回忆”分“记忆中”和“笔记本”，显示全部可用条目，条目预览截断到 20 字符，不显示序号，点击只写回剪贴板不自动粘贴。
- “笔记本”支持多条同时放在最上面，只在“记忆力”窗口内管理；忘记笔记本内容需要系统原生确认。
- “记忆力”窗口触发系统原生确认弹窗后，确认或取消都要把焦点恢复回“记忆力”窗口。
- 取消笔记本条目的“放在最上面”后，该条要排到非置顶内容的第一条。
- “记忆力”不展示也不记录真实复制/保存时间；后端只保存内部顺序值用于排序和置顶。
- 菜单栏打开“记忆力”窗口时要 show/unminimize/focus，并在 macOS 上短暂置顶后恢复，避免被其他窗口盖住。
- “记忆力”窗口默认内尺寸保持小宠物应用调性，使用 920x620；最小内尺寸不低于 780x520。
- “记忆力”窗口 shell 无错误时只能是标题 + 主内容两行；只有显示错误条时才使用三行，避免主内容落在 auto 行导致列表区域坍缩。
- “记忆力”窗口左侧的“记忆中”和“笔记本”列表需要各自滚动，不能让一个列表挤掉另一个。
- “记忆力”窗口里“记忆中”为空时只保留短提示块，不要占掉半个列表区；“笔记本”要获得主要空间。
- “记忆力”窗口重绘前后要保留两个列表各自的 scrollTop，避免点击条目或状态刷新后滚动条跳回顶部。
- “记忆力”窗口的回忆/记住/忘记/置顶操作放在左侧条目 hover/focus 操作区，右侧详情区只用于查看完整内容。
- “记忆力”窗口不放手动刷新和“全部忘记”按钮；内容刷新依靠事件同步，“记忆中”只做单条忘记。
- “记忆力”窗口的“记忆中”分组说明使用“临时想到的 N 条”，不要再用“临时捧着”。
- “记忆力”窗口前端采用桌面工作台：顶部来源筛选/搜索/新增变量入口，左侧按来源分组列表，右侧只做详情和状态反馈。
- “变量库”是“记忆力”的第三个分组，和“记忆中”“笔记本”分开建模，但取出入口统一走“回忆”。
- “变量库”条目使用 key/value/note；key 必填且唯一，value 必填，note 可选，最多 50 条。
- “变量库”全部默认按私密值处理；列表、小菜单、确认文案和复制反馈只显示 key，不显示 value。
- 变量库前端直接接 Tauri 命令；snapshot 只传 key/note/id，value 只能通过 reveal/copy 命令临时取出。
- 变量库和笔记本共用加密数据文件，持久化结构包含 notebook、variables 和 variableClipboardCleanupEnabled；解密时要兼容旧版 notebook 数组明文结构。
- 变量 value 只能在“记忆力”窗口详情区临时显示；切换条目、关闭窗口或状态刷新后要重新隐藏。
- 复制变量只把 value 写入剪贴板，不自动粘贴，也不把 value 主动加入“记忆中”；写系统剪贴板前要先更新内部剪贴板基线，避免轮询误记 secret。
- 变量复制后的自动清理是全局开关；开启后 30 秒内若剪贴板变成其他内容则取消，到期仍匹配本次 value 才清空。
- 变量复制自动清理开关放在“变量”分组标题右侧，作为变量库全局设置，不放进单个变量详情里。
- “记忆力”搜索覆盖“记忆中”“笔记本”“变量库”，但变量只搜索 key 和 note，不搜索 value。
- 删除变量需要系统原生确认，确认文案只显示 key，并沿用确认后恢复“记忆力”窗口焦点的规则。
- 默认皮肤优先使用 7 个状态 sprite sheet，代码绘制史莱姆保留为加载兜底。
- 默认桌宠角色素材与应用 icon 保持一致：淡紫白小幽灵/软团子角色，替换时仍放在 `src/assets/slime/*.png` 并保持原 sprite sheet 布局。
- 桌宠动画优化的下一步边界是先调代码节奏：以标准档为主手感，同步校准安静/活泼，不新增状态、不改 PNG 素材、不加新设置。
- 桌宠活动档位参数从 `pet.ts` 移到 `src/pet/activityCadence.ts`；到达目标后的休息会保留本轮选中的 `idle`/`sleep`，避免 `sleep` 只闪一帧。
- 桌宠前端保持模块边界：`pet.ts` 只做控制器流程，sprite 细节放 `src/pet/slime.ts`，巨型庆祝算法放 `src/pet/giantCelebration.ts`，通用坐标算法放 `src/pet/geometry.ts`。
- Tauri 后端保持模块边界：`lib.rs` 只做 command、窗口/菜单和应用编排；屏幕/活动区域算法放 `geometry.rs`，settings 类型和持久化放 `settings.rs`。
- `src-tauri/icons` 只保留 `tauri.conf.json` 的 `bundle.icon` 声明项：`32x32.png`、`128x128.png`、`128x128@2x.png`、`icon.icns`、`icon.ico`。
- `idle/sleep/timer-waiting/celebrate/dragged` 当前按 6x1 切帧，`walk/run` 按 6x2 切帧。
- `walk/run` 的 6x2 帧表按方向分行播放：walk 第 0 行向左、第 1 行向右；run 第 0 行向右、第 1 行向左，不能把两行当连续 12 帧循环。
- `walk/run` 当前播放速度为 walk 5fps、run 8fps，避免 6 帧动作切换过快。
- sprite 帧会逐帧裁剪有效内容，并用最大连通色块作为史莱姆主体锚点归一化到固定显示盒。
- sprite 绘制会额外约束整帧内容留在 32x32 逻辑画布内，并保留 2px 安全边距，避免沙漏/特效/拖尾被裁切。
- `src/assets/slime/*.png` 当前已处理为带 alpha 的透明 PNG；后续替换素材也应保持透明通道。
- 默认 sprite sheet 中孤立小碎片和边缘残影按素材层清理，不在运行时代码里增加通用碎片过滤。
- `celebrate.png` 仍按 6x1 切帧，但当前素材宽 2520px，每帧 420px，用空白边距容纳彩纸和主体跨格部分。
- 宠物移动坐标按 native 物理像素处理；`petDimensions` 用于逻辑窗口/canvas 尺寸，`petWindowDimensions` 用于活动区域边界和拖拽/移动 clamp。
- `move_pet_window` 只负责移动窗口和更新内存中的 `last_position`；磁盘持久化要低频 debounce 或通过 `persist_pet_position` 在拖拽结束/进入休息点显式触发。
- 巨型庆祝动效使用 `set_pet_temporary_presentation` 临时调整宠物窗口；这个命令只改窗口 size/position/always_on_top，不更新 `last_position`、不写 settings。
- 倒计时结束的巨型庆祝只在宠物可见且未被拖拽时触发；隐藏或拖拽中都只保留 macOS 通知。
- 巨型庆祝固定 7 秒，不抢焦点，不显示桌面文字，不新增设置项；这 7 秒称为“巨型庆祝动效”。
- 巨型庆祝动效分三段：0-3s 进入段同时放大并移动，3-6s 停留段原地庆祝，6-7s 恢复段缩回并回到原位置。
- 巨型庆祝动效全程播放 `celebrate`；进入段按中心点直线插值并用 ease-out，恢复段按中心点直线插值并用 ease-in-out。
- 巨型庆祝尺寸按宠物当前屏幕可用工作区自适应，目标约为限制维度的 45%，意图上下限约 320px 到 560px，最终必须留在可用工作区内。
- 巨型庆祝期间禁止拖拽和右键宠物菜单；如果新计时器启动，立即结束庆祝并回到计时等待状态。
- 巨型庆祝期间如果用户隐藏宠物，立即中断动效，先恢复普通尺寸/位置再隐藏。
- 巨型庆祝期间如果设置变化，恢复时尊重新尺寸/置顶；如果屏幕环境变化，动效不中途重算，恢复时按当前可见工作区 clamp。
- 设置页连续保存要基于本地 draft preferences 合并，避免快速切换多个控件时后一个请求用旧 bootstrap 覆盖前一个字段。
- 设置页 UX 使用左侧摘要栏 + 右侧行为/活动区域面板；`settings-workspace/sidebar/panel` 结构需要对应样式，不要只改 TS 结构。
- MCP 试验优先作为开发期本地 stdio server，暴露 repo 状态、日志、PRD 和 QA 动作；不要把 AI 对话/长期记忆直接并入 V1 产品体验，涉及剪贴板或笔记本内容时默认只读或显式确认。

## Known Issues

- `timer-waiting` 曾出现第 5 帧左缘被切平；原因是第 5 帧左侧轮廓溢出到第 4 帧右边界，不能简单当残影删除。

## Things To Avoid

- 不要用每秒 `set_menu` 重建原生菜单来刷新倒计时。
- 替换 `src/assets/slime/*.png` 时不要改帧布局，除非同步更新 `src/pet.ts` 里的 `slimeSpriteSheets` 配置。
- 不要在代码里按颜色阈值主动去除 sprite 白边，边缘和透明度问题应通过素材本身解决。
- 不要在运行时做通用连通域碎片删除，避免误删庆祝粒子、沙漏等非主体元素。
- 清理 sprite sheet 边缘组件前，要先确认它不是相邻帧溢出的真实轮廓。
- 不要为了 `celebrate` 彩纸跨格问题改运行时切帧逻辑，优先用更宽的单帧素材留白解决。
- 不要在每次自主移动 tick 里写 `settings.json` 或重复设置窗口 size，长期运行会造成无意义 I/O 和 native 调用。
- 不要把倒计时完成强提醒做成常驻全屏 overlay、抢焦点弹窗、音效或可配置提醒系统；本轮只做短暂巨型庆祝。
- 不要在宠物隐藏或用户拖拽时触发巨型庆祝，也不要松手后补触发。
- 不要把巨型庆祝的临时尺寸、位置或置顶状态写进用户偏好。
- 不要用 `move_pet_window` 驱动巨型庆祝动效逐帧移动，否则会污染普通宠物位置和触发无意义 settings 写入。
- 不要用左上角插值做巨型庆祝动效；尺寸变化时应按中心点插值，避免视觉中心漂移。
- 不要把巨型庆祝做成瞬间变大/瞬间恢复，也不要做弧线、弹跳或物理模拟。
- 不要把“记忆中”默认持久化；只有用户主动“记住它”的内容才能写入加密存储。
- 不要把剪贴板历史塞成宠物小菜单里的管理界面；小菜单只做“回忆”，记住/忘记/放在最上面放“记忆力”窗口。
- 不要把变量库实现成特殊笔记本条目；变量有独立的 key/value 私密规则和搜索规则。
- 不要监听 `Cmd+V` 或注册全局快捷键来判断私密变量是否已粘贴；自动清理只做剪贴板内容匹配。
- 不要让变量 value 参与搜索、菜单预览、系统确认文案、复制成功反馈或“记忆中”临时历史。
- 不要重新提交未被 `bundle.icon` 引用的 `icon.png`、`Square*Logo.png`、`StoreLogo.png` 或 `src-tauri/icons/variants`。
- 不要把带圆角背景的应用 icon 直接设置为 `icon_as_template(true)` 的菜单栏图标，否则 macOS 会按 alpha mask 渲染成白色方块。
