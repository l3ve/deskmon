# 截图与记忆链统一全局快捷键

## 意图与范围

在「偏好设置 → 区域截图」中配置一组全局快捷键，Deskmon 运行时在其他应用中也能启动现有截图流程。用户已明确：首次不绑定；使用 Tauri 全局快捷键插件；已有记忆链全局 `⌘V` 同时迁移。

本次只改快捷键配置、注册和事件接入。记忆链数据格式、顺序粘贴规则与截图标注、保存规则继续沿用 PRD 008、012。不扩展跨平台产品能力，不添加其他可配置热键。

## Approaches

- 沿用项目直接调用 Carbon 的方式：无新增依赖，但需要继续维护原生热键 FFI。
- 使用 `tauri-plugin-global-shortcut`：统一注册和释放，通过 Rust API 管理生命周期，需要新增 Cargo 依赖。**用户选择此方案，并要求一起迁移记忆链。**

官方文档：https://v2.tauri.app/plugin/global-shortcut/
官方插件源码：https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/global-shortcut/src/lib.rs
底层 macOS 源码：https://github.com/tauri-apps/global-hotkey/blob/dev/src/platform_impl/macos/mod.rs

普通 macOS 按键底层仍使用 Carbon；这说明迁移路径接近现有实现，不代表安全输入场景已经重新验证。

## 截图设置与交互

- `ScreenshotPreferences.shortcut: string | null`，序列化为 `shortcut`；新用户与缺失字段的旧设置均为 `null`。
- 区域截图面板增加「全局快捷键」录入控件和「清除」操作，未绑定显示「未设置」。
- 点击进入录入状态，显示「请按快捷键」；按下支持的组合后保存，`Escape` 取消录入，失焦也取消；清除是显式按钮。
- 实现者决定：首版支持字母、数字、方向键、空格及 F1–F12；要求至少一个 Command、Control 或 Option 修饰键，Shift 可以附加；不支持单独修饰键、媒体键与输入法组合输入。使用 `KeyboardEvent.code` 映射稳定的插件按键名。
- 使用 macOS 符号展示修饰键，持久化规范化 accelerator。前端和后端都验证合法性。
- 实现者决定：`Command+V` 固定预留给记忆链，即使当前没有会话也拒绝作为截图热键；系统占用由原生注册结果决定，不能把插件的 `is_registered` 当作其他应用占用检测。
- 录入当前已绑定的组合时不能触发截图。进入录入后暂时停用本应用截图热键，离开、关闭或取消时恢复；异常窗口关闭也必须恢复。记忆链 `⌘V` 生命周期不因录入而改变。
- 修改目录、恢复桌面或修复目录时保留热键；修改热键时保留目录。串行保存仅发送变更字段，由后端基于最新设置合并；失败的修改不进入后续请求，避免旧快照回写已修复的目录。
- 注册成功并持久化后才显示已保存；冲突或落盘失败时保留原绑定和原设置，并显示具体原因。更新期间串行处理，避免半完成状态接收截图请求。
- 原绑定保留到新配置原子落盘成功；落盘失败仅撤销候选绑定。释放失败的确切句柄保留并重试，过期句柄不能触发截图。落盘成功后的窗口刷新失败不能使保存结果变成失败。
- 启动时尝试恢复绑定；恢复失败不得阻止应用启动或清空配置，设置页显示未生效及原因，可修改或重试。

## 后端结构与生命周期

- 新建 `src-tauri/src/global_shortcuts.rs`，集中放置截图热键验证、运行期绑定状态、录入暂停和注册事务；`lib.rs` 只负责编排与 Tauri command。
- Rust 端初始化插件。设置页仅调用现有/新增应用 command，无需引入 JS 插件包或向所有窗口开放插件注册权限。
- 截图回调只处理 `Pressed`，进入主线程后调用现有 `start_region_screenshot`，复用权限检查和截图任务锁；任务进行中重复触发静默忽略。
- 回调不得持锁等待主线程，进入主线程后的事件需校验当前有效绑定及录入状态，丢弃已解绑事件。
- 记忆链保留独立的 `on_shortcut` 回调，捕获会话递增 ID；每次原生注册分配新的 ID，避免原生队列中的旧按键查找到新处理器。主线程上访问前台 App 与线程局部会话。
- 从 `memory_chain_paste.rs` 删除 Carbon 热键声明、全局事件 handler 和原生热键句柄；使用插件注册与释放 `Super+KeyV`。保留 CoreGraphics 的权限请求、定向粘贴事件、前台应用切换和剪贴板所有权处理。
- 仍然仅在会话开始后占用 `⌘V`。贴完、主动复制（含相同文本）、改选链、删除链、重置、空闲超时与退出时释放。释放某项只能调用其 `unregister`，不调用 `unregister_all` 以免注销截图键。
- 注册失败不启动新会话，提示原因并保持普通粘贴可用。旧会话事件通过捕获的会话 ID 避免推进新会话；实际消费和定向转发仍沿用已有队列机制。
- 插件版本需要确认处理回调后立即注销时不会持内部锁死锁；选择已包含该修复的发行版本并锁定 Cargo.lock。
- 使用插件 2.4.1 及匹配的 Tauri Rust/JS 2.12。插件间接依赖的 global-hotkey 0.8 尚未包含独占注册修复；经用户于 2026-11-23 明确授权，保留上游源码到 `src-tauri/vendor/global-hotkey/`，仅移植官方提交 `c0fb67af3349770d81e1a50a514056e31cee3f64` 的 macOS 独占注册与错误识别修复。补丁来源和升级移除条件见该目录 `README.deskmon.md`。

## 修改边界

- `src/settings.ts`、`src/types.ts`、`src/styles.css`：录入、显示、反馈和嵌套字段合并。
- `src/screenshot/shortcut.ts` 与对应测试：组合键解析和显示的纯逻辑。
- `src-tauri/src/settings.rs`：默认、兼容与持久化。
- `src-tauri/src/global_shortcuts.rs`：共享插件接入及截图绑定。
- `src-tauri/src/memory_chain_paste.rs`：记忆链热键迁移。
- `src-tauri/src/lib.rs`、`Cargo.toml`、`Cargo.lock`：应用编排与依赖。
- `package.json`、`package-lock.json`：匹配 Rust 端 Tauri 2.12 的 JS API；`src-tauri/vendor/global-hotkey/`：用户确认的上游兼容补丁。
- README、相关 PRD 的覆盖说明与 QA 清单：实现后更新当前能力，不抹除历史决策。
- `.ai/keypoint.md`、当日日志：按仓库规则记录实际完成的事实。

## 验证与验收

- 自动化验证默认不绑定、旧设置兼容、非法组合与 `⌘V` 被拒、目录与热键互不覆盖。
- 以可替换的注册器验证注册失败与持久化失败回滚、清除、启动失败降级、录入暂停/恢复与陈旧事件过滤。
- 记忆链回归验证只消费按下事件、旧会话不能推进新会话、释放自己的热键不影响截图热键。
- 运行 Vitest、TypeScript/Vite build、Rust tests 与 cargo check。
- 原生验证覆盖：其他应用触发截图、设置录入、冲突提示、清除、重启恢复、普通输入框/安全密码框/跨应用顺序粘贴、快速按键、主动复制与会话结束后普通粘贴。没有实际执行的原生检查明确列为待验收，不以单测替代。
- 如执行打包，必须先退出旧 App，再覆盖 `/Applications/Deskmon.app` 并重新打开，保持现有 Apple Development 签名身份。
