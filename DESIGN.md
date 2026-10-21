---
name: 局域网联机
description: 沿用项目主页视觉的双向扫码通信演示
colors:
  background: "#082b3a"
  text: "#e4f2ec"
  surface: "#123844"
  muted: "#aac7cb"
  border: "#527a80"
  divider: "#527a8066"
  accent: "#f2d492"
  accent-text: "#143440"
  accent-hover: "#ffe5af"
  accent-active: "#ffe6b1"
  button: "#173f4c"
  button-hover: "#265563"
  button-active: "#295665"
  button-hover-border: "#a6bdaf"
  field: "#052432"
  placeholder: "#a0bdc1"
  readonly-text: "#bbd2d3"
  connected: "#a9e7bd"
  error-border: "#dfab9f"
  error-text: "#f8d2c9"
  qr-background: "#fff"
  camera-background: "#031b25"
typography:
  display:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(30px, 5vw, 42px)"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-.025em"
  headline:
    fontSize: "23px"
    fontWeight: 650
    lineHeight: 1.4
  title:
    fontSize: "18px"
    lineHeight: 1.5
  body:
    fontSize: "15px"
    lineHeight: 1.75
  lead:
    fontSize: "18px"
    lineHeight: 1.75
  label:
    fontSize: "15px"
    lineHeight: 1.5
  button:
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.4
  field:
    fontSize: "16px"
    lineHeight: 1.6
  code:
    fontFamily: "ui-monospace, monospace"
    fontSize: "16px"
    lineHeight: 1.6
rounded:
  field: "8px"
  button: "9px"
  notice: "10px"
spacing:
  small: "8px"
  medium: "12px"
  control-gap: "16px"
  heading-gap: "20px"
  page-inset: "24px"
  section: "28px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-text}"
    typography: "{typography.button}"
    rounded: "{rounded.button}"
    padding: "11px 18px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-primary-active:
    backgroundColor: "{colors.accent-active}"
  button-secondary:
    backgroundColor: "{colors.button}"
    textColor: "{colors.text}"
    typography: "{typography.button}"
    rounded: "{rounded.button}"
    padding: "11px 18px"
  button-secondary-hover:
    backgroundColor: "{colors.button-hover}"
  button-secondary-active:
    backgroundColor: "{colors.button-active}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.button}"
    rounded: "{rounded.button}"
    padding: "11px 18px"
  textarea:
    backgroundColor: "{colors.field}"
    textColor: "{colors.text}"
    typography: "{typography.field}"
    rounded: "{rounded.field}"
    padding: "12px"
    width: "100%"
  notice:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.notice}"
    padding: "16px"
---

# Design System: 局域网联机

## Overview

**Creative North Star: "沿用项目主页的深青工具界面"**

延续仓库主页的深青背景、浅色文字与金色强调，优先让用户看清当前连接状态和下一步操作。页面以标题、分隔线和留白建立层级；二维码与相机画面承担实际配对任务，不使用装饰图片。

**Key Characteristics:**

- 系统字体与紧凑、可扫描的操作布局。
- 金色主操作，透明背景的退出、取消和清空操作。
- 平面分区；提示和输入控件通过底色与边框区分。

本文件依据 `demo/style.css` 与 `demo/index.html` 记录已实现的视觉；不代表真实手机扫码、手势或局域网连接已验收。产品边界见 `PRODUCT.md`。

## Colors

主强调使用 `accent`，承担主按钮、链接、配对提示与键盘焦点。深青 `background` 配合浅色 `text`，次要说明使用 `muted`；`surface`、`field` 与 `button` 提供不同操作区域的底色。

连接成功使用 `connected`，错误提示使用 `error-border` 与 `error-text`。状态同时以文字说明，不只依赖颜色。二维码保持白色底面，相机未显示画面时使用更深的底色。

## Typography

全页继承系统无衬线字体栈；只读配对文本与二进制消息采用系统等宽字体。标题、区块标题、正文与控件的实际尺寸见 frontmatter。

说明正文最长 74ch，首段引导最长 50ch。辅助说明通常为 14px，日志元数据与页脚为 13px；消息正文为 15px、行高 1.6。字节计数和日志元数据使用等宽数字；长配对信息、设备标识和消息允许换行。

## Layout

主内容居中，最大宽度 1008px；页面最小宽度为 280px。外侧默认留白 24px，顶部 20px，并与对应安全区取较大值。主体分区使用上边框和 28px 垂直留白，不套用重复卡片。

初始操作、房间设备、配对与消息按使用阶段显示。配对双方区域同时可见时使用等宽双栏，间隔 28px；发送目标与格式使用间隔 16px 的双栏。680px 及以下均改为单栏，页面左右留白调整为至少 20px。

操作行和设备列表允许换行。消息记录独立滚动，最大高度 440px；正文页面保持正常滚动。页面与交互/滚动区域声明 `touch-action: manipulation`，实际移动设备手势仍需单独验证。

## Elevation & Depth

当前样式没有阴影、渐变、动画或过渡。深浅底色、1px 边框与留白承担区域区分；键盘焦点使用金色 3px 外轮廓，偏移 4px。

## Shapes

输入框和二维码使用 `rounded.field`；按钮使用 `rounded.button`；提示与相机画面使用 `rounded.notice`。状态点是 7px 圆点，导航箭头是 20px 线条图标。

## Components

- **按钮：** 主、次、透明三种实际变体。最小高度 46px；hover 仅在支持悬停的设备生效，active 更换底色，disabled 透明度为 0.5。透明按钮仍保留边框。所有变体沿用统一焦点轮廓。
- **输入与选择：** 字号 16px，深色底面与清晰边框。文本框最小高度 96px，允许垂直调整；选择框最小高度 46px，右侧使用内联箭头。只读配对文本使用独立的浅色文字与等宽字体。
- **配对区域：** 二维码宽度不超过 380px，附说明和保存入口；扫描画面比例为 4:3。配对文本放在可展开的原生 `details` 中，摘要最小高度 44px。
- **提示与状态：** 加载和错误使用有边框的提示面；错误含关闭入口。房间连接状态位于页头，设备清单直接列出设备与状态。
- **消息记录：** 使用分隔线列表，元数据在消息上方；消息保留换行并可断开长文本。空记录有说明，清空入口与标题同行。
- **导航：** 页头的“返回项目主页”为带线条箭头的文本链接，最小高度 44px，目标由构建配置提供。

## Do's and Don'ts

### Do:

- **Do** 沿用现有深青、浅色文字与金色强调，并从已实现的控件变体扩展。
- **Do** 保持状态文字、可见焦点、可换行的长内容和移动端单栏布局。
- **Do** 将视觉记录与浏览器测试、线上资源及真机验收结论分别维护。

### Don't:

- **Don't** 为这个通信演示另建视觉主题或添加未经确认的装饰图片。
- **Don't** 仅用颜色表示连接或错误状态。
- **Don't** 把源码中的触摸策略视为真机手势已经通过验收。
