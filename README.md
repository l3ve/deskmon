# Deskmon

macOS 桌面像素史莱姆宠物，基于 Tauri 2 + Vanilla TypeScript。

## 开发

```bash
npm install
npm run tauri dev
```

## 构建

```bash
npm run tauri build -- --bundles app
```

构建完成后，macOS app 位于：

```text
src-tauri/target/release/bundle/macos/Deskmon.app
```

## V1 能力

- 透明无边框小尺寸桌宠窗口。
- 7 状态 sprite sheet 像素史莱姆，代码绘制作为加载兜底。
- 活动区域内自动移动、休息、拖拽、暂停、隐藏。
- 菜单栏入口和宠物原生小菜单。
- 1 / 5 / 10 / 25 分钟计时器。
- 设置窗口：大小、活跃程度、置顶开关、自定义活动区域框选。
