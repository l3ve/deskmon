# 截图与记忆链统一全局快捷键 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 通过 Tauri 插件提供默认未绑定的截图全局快捷键，并迁移记忆链 `⌘V`。

**Architecture:** Rust 后端管理全局注册与生命周期；前端负责组合键录入与反馈。截图复用现有入口，记忆链只替换热键来源，保留粘贴、焦点和剪贴板所有权机制。

**Tech Stack:** Tauri 2、tauri-plugin-global-shortcut、Rust、TypeScript、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-23-global-shortcuts-design.md`

## Global Constraints

- 首次和旧设置缺失 shortcut 字段时均为 `null`。
- `Command+V` 固定预留给记忆链。
- 仅通过 Rust API 注册；回调仅处理 `Pressed`，原生状态在主线程访问。
- 不修改记忆链加密文件格式，不修改现有截图编辑和保存行为。
- 修改或修复截图目录时必须保留 shortcut，修改 shortcut 时必须保留目录。
- 打包后必须退出旧应用、覆盖安装并打开；普通 build/check/test 不属于打包。

## Review Focus

- 记忆链会话中注销热键造成插件内部锁重入或主线程等待死锁。
- 录入现有绑定、失焦或关闭设置窗口导致截图误触发或永久停用。
- 修改/修复截图目录和连续偏好保存导致 shortcut 丢失。
- 插件固定快捷键 ID 复用后，旧回调推进新的记忆链会话。
- 启动恢复失败或保存失败造成磁盘设置、注册状态与页面反馈不一致。

---

### Task 1: 组合键契约与设置兼容

**Files:** 新建 `src/screenshot/shortcut.ts`、`shortcut.test.ts`；修改 `src/types.ts`、`src-tauri/src/settings.rs`。

**Interfaces:** 前端 `shortcutFromEvent(event: KeyboardEvent): string | null`、`formatShortcut(shortcut: string | null): string`；后端 `ScreenshotPreferences.shortcut: Option<String>`。

- [x] 写失败测试：`Meta+Shift+KeyA` 转为规范组合；单修饰键、无修饰键、输入法事件、`Meta+KeyV` 不产生绑定；Escape 由控件取消而不是录入。
- [x] `npm test -- src/screenshot/shortcut.test.ts`，确认预期失败。
- [x] 实现映射与显示；新增 Rust 兼容测试，缺失字段与默认值都为空、序列化往返保留目录和键。
- [x] `npm test -- src/screenshot/shortcut.test.ts` 和 `cargo test --manifest-path src-tauri/Cargo.toml settings::tests`，预期通过。

### Task 2: 插件注册、截图事务与记忆链迁移

**Files:** 新建 `src-tauri/src/global_shortcuts.rs`；修改 `Cargo.toml`、`Cargo.lock`、`lib.rs`、`memory_chain_paste.rs`。

**Interfaces:** `validate_screenshot_shortcut(value: Option<&str>) -> Result<Option<Shortcut>, String>`；`restore_screenshot_shortcut(app: &AppHandle, configured: Option<&str>) -> ScreenshotShortcutStatus`；`set_screenshot_shortcut_recording(app: &AppHandle, recording: bool) -> Result<ScreenshotShortcutStatus, String>`；`screenshot_shortcut_status(app: &AppHandle) -> ScreenshotShortcutStatus`。`ScreenshotShortcutStatus` 为 camelCase 序列化结构，字段为 `active: bool`、`recording: bool`、`error: Option<String>`，并加入 `BootstrapPayload`。设置持久化事务通过 `save_user_preferences` 提交 `UserPreferencesPatch`，返回权威 `PreferencesSavePayload`；`get_saved_preferences` 只读返回同一结构。注册器抽象留给实现者选择。记忆链保持现有 `start`、`cancel`、`poll_clipboard` 对外接口。

- [x] 写注册事务失败测试：新键注册失败保留旧键；持久化失败撤销新键并恢复旧键；清除只释放截图键；启动失败保留配置并返回错误状态。
- [x] 写回调与会话回归测试：只处理按下、录入时不截图、过期绑定/会话事件被忽略、释放记忆链不影响截图。
- [x] `cargo test --manifest-path src-tauri/Cargo.toml`，确认新增测试预期失败。
- [x] 加入已修复回调重入死锁的插件发行版本，初始化插件并实现后端事务与录入状态；回调切主线程前不持有应用锁。
- [x] 修改 `memory_chain_paste` 使用插件会话回调；删除 Carbon FFI，仅保留 CoreGraphics 转发；每个回调捕获会话 ID，drop 只释放自己的组合。
- [x] 更新偏好保存和目录修复路径，保留嵌套字段；提供启动恢复失败与录入状态的前端可读反馈；窗口销毁恢复热键。
- [x] `cargo test --manifest-path src-tauri/Cargo.toml`、`cargo check --manifest-path src-tauri/Cargo.toml`，预期通过。

### Task 3: 设置录入、联调与交付

**Files:** 修改 `src/settings.ts`、`src/styles.css`、README、PRD 007/008/012 覆盖说明及 `docs/qa/v1-smoke-checklist.md`；按需增加设置联调测试。

**Interfaces:** 使用 Task 1 的组合键函数和 Task 2 的 Tauri command；页面显示配置值及实际生效错误，保存队列只发送字段 patch，后端基于最新设置合并，避免页面旧快照污染其他来源的更改。

- [x] 写回归测试：更改目录保留键、更改键保留目录、快速连续修改不丢字段、Escape/blur 恢复录入前状态、失败恢复原展示。
- [x] `npm test`，确认新增测试预期失败。
- [x] 实现录入控件、清除、状态反馈和嵌套合并，使用现有面板视觉与布局；避免重渲染丢失录入收尾。
- [x] `npm test`、`npm run build`、`cargo test --manifest-path src-tauri/Cargo.toml`，预期全部通过。
- [x] 完成全改动独立代码审查，修复重要问题并补回归测试。
- [x] 完成 macOS 双进程独占注册验证与签名、退出、覆盖安装、重启检查；浏览器验证录入/取消/清除。原生 UI 连接超时，安全输入框与跨应用完整按键验收仍待用户实机确认。
- [x] 更新 README/PRD/QA、关键决策和当日日志，记录完成范围、测试证据及未执行的原生验收。
- [x] 发送 `deskmon notify` 完成通知，向用户交付变更与验收结果。

## 执行方式

用户确认当前会话直接实施并独立审查，另明确同意 vendor 上游独占注册补丁。当前目录使用 `codex/global-shortcuts` 分支，尚未合并或推送。

## 实施修订与验证证据

- 独立审查确认并修复：原生 ID 重用、旧页面完整快照覆盖、启动冲突阻断其他设置、录入准备/销毁竞态、设置部分写入、候选键清理失败和提交结果误报。
- 注册原键保留至新值成功落盘；清理失败句柄继续跟踪，非当前句柄事件不能截图。
- 使用原子设置文件替换与后端字段 patch。Tauri Rust/JS 同步 2.12。
- 43 项 Vitest、45 项 Rust 测试、TypeScript/Vite build、cargo check 通过；原生双进程注册检查 RED→GREEN。
- 已生成 Apple Development 签名应用，关闭旧版后覆盖 `/Applications/Deskmon.app` 并重启；签名和可执行文件一致性检查通过。
- 未声称完成安全密码框、跨应用快速粘贴和真实截图按键的全流程验收：原生 UI 自动化连接超时。
