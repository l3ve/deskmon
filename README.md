# Deskmon

Deskmon 是一个 macOS 桌面像素史莱姆宠物。它会在桌面安全区域里活动、休息、被拖拽，也能用很轻的方式帮你计时和回忆剪贴板文本。

项目基于 Tauri 2、Vanilla TypeScript 和 Rust 构建。当前目标是把“小宠物真实存在于桌面上”的体验打磨稳定，而不是做成完整工作助手或养成游戏。

## 当前能力

### 桌面宠物

- 透明、无边框、小尺寸的 macOS 桌宠窗口。
- 默认像素风史莱姆，使用 7 个状态的 sprite sheet。
- 支持 idle、walk、run、sleep、timer-waiting、celebrate、dragged 状态。
- 可在活动区域内自动移动，也可以暂停、隐藏、拖拽和移回活动区域。
- 鼠标悬停在宠物上时会暂停自主移动，减少误触。
- 左键单击不触发操作；右键打开原生宠物小菜单。

### 计时器

- 固定支持 1 / 5 / 10 / 25 分钟。
- 同一时间只允许一个计时器。
- 计时中可从菜单查看剩余时间或取消。
- 计时完成后发送 macOS 通知；宠物可见时会播放庆祝动画。

### 记忆力

- 自动捕获运行期间的纯文本剪贴板变化，放入临时的“记忆中”。
- “记忆中”最多 10 条，只存在内存里，退出后清空。
- 用户主动“记住它”后，文本会进入加密持久化的“笔记本”。
- “笔记本”最多 50 条，支持回忆、忘记和多条放在最上面。
- 菜单栏提供“记忆力”和“记住刚想到的”入口。
- 宠物右键小菜单提供轻量“回忆”，点击后只写回系统剪贴板，不自动粘贴。

### 设置

- 调整宠物大小：小 / 中 / 大。
- 调整活跃程度：安静 / 标准 / 活泼。
- 开关宠物窗口置顶。
- 用鼠标框选自定义活动区域。

## 不做什么

V1 保持克制，明确不做这些能力：

- 点击穿透和常驻全屏 overlay。
- AI 对话、语音、联网模型调用或养成系统。
- 开机自启动和宠物动作音效。
- 拖图生成皮肤或用户导入 sprite sheet。
- 图片、文件、富文本剪贴板历史。
- 自动粘贴、全局快捷键、云同步、导出或导入。

## 快速开始

### 环境要求

- macOS
- Node.js 和 npm
- Rust 工具链
- Tauri 2 依赖环境

### 安装依赖

```bash
npm install
```

### 开发运行

```bash
npm run tauri dev
```

### 前端构建检查

```bash
npm run build
```

### Rust 测试

```bash
cd src-tauri
cargo test
```

### 打包 macOS App

```bash
npm run tauri build -- --bundles app
```

构建完成后，macOS app 位于：

```text
src-tauri/target/release/bundle/macos/Deskmon.app
```

## 项目结构

```text
src/
  main.ts          # 前端入口和窗口路由
  pet.ts           # 桌宠渲染、拖拽、动画和右键小菜单触发
  settings.ts      # 设置窗口前端
  remember.ts      # 记忆力窗口前端
  assets/slime/    # 默认史莱姆 sprite sheet

src-tauri/
  src/lib.rs       # Tauri 窗口、菜单、计时器、设置和系统交互
  src/remember.rs  # 记忆力状态、文本规则和加密存储
  tauri.conf.json  # Tauri 应用配置

docs/
  prds/            # 产品需求文档
  qa/              # 手工验收清单
  designs/         # 设计稿和视觉参考
```

## 文档入口

- [桌面像素史莱姆 PRD](docs/prds/001-tauri-mac-desktop-pet.md)
- [记忆力剪贴板历史 PRD](docs/prds/002-remember-clipboard-history.md)
- [V1 smoke test 清单](docs/qa/v1-smoke-checklist.md)
- [记忆力窗口设计稿](docs/designs/remember-window-redesign.png)

## 隐私边界

“记忆中”只保存在运行期内存里，退出后清空。“笔记本”会加密保存在本机，但这不是强安全模型：它的目标是避免文本明文落盘，不承诺抵抗攻击者同时拿到本地 key 文件和加密数据文件的场景。
