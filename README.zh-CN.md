# CodexGPT Bridge

**将 ChatGPT 网页模型接入 Codex。**

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

CodexGPT Bridge 将 Codex 连接到已登录的 ChatGPT 网页会话，支持模型选择、
独立的任务对话、图片、进度显示与取消。项目文件、工具和审批由 Codex 管理。

本项目是独立的第三方项目，与 OpenAI 没有隶属关系。

GPT 插件与 Full MCP 设置教程：[繁體中文](README.zh-TW.md#chatgpt-外掛設定) · [English](README.md#chatgpt-plugin-setup)。

**v0.1.103：** Full MCP 可自动下载并验证官方 Tunnel 程序，路径留空即可；Tunnel 凭据和插件权限仍需设置。

## 安装

从本仓库的 **[Releases](https://github.com/Fluxenith/codexgpt-bridge/releases/latest)** 页面下载适合你的操作系统的安装包。
Windows 使用 `CodexGPT-Bridge-Setup-<版本>.exe`；macOS 使用 DMG；
Linux 使用 AppImage 或 DEB。

**macOS 测试版：** Intel 和 Apple Silicon 安装包尚未经 Apple 公证。首次尝试
打开后，可能需要在“系统设置 → 隐私与安全性 → 仍要打开”中允许运行。
请确认来源可信后再允许，参见 [Apple 官方说明](https://support.apple.com/zh-cn/102445)。

你需要已安装的 Codex，以及可以使用所需模型的 ChatGPT 账号。
可用模型与使用额度取决于账号。

## 开始使用

1. 打开 Bridge，选择浏览器与工具连接方式。首次使用可选择 Simple；
   Full MCP 需要先完成连接器与 tunnel 配置。
2. 点击“打开 ChatGPT 登录”并登录。Chrome 登录完成后，
   返回 Bridge，点击“登录完成，继续”。
3. 点击“测试 ChatGPT 连接”，然后点击“安装 Web 模型”。
4. 重新启动 Codex，选择 `CodexGPT Bridge — …` 模型。

使用这些模型时，请保持 Bridge 运行。关闭主窗口后，程序会留在系统托盘；
“退出”会停止程序。“移除 Web 模型”会恢复先前由 Bridge 管理的设置。

界面支持英语、繁体中文、简体中文、日语和韩语，可从“语言”菜单切换。

## 更新与问题排查

GitHub 发布流程会将本仓库的更新网址内置到安装包，用户不需要手动设置。
Bridge 会在启动和后台运行时检查新版本。在线更新需要可访问的更新清单与安装包；
更新源尚不可用时，请从 **[Releases](https://github.com/Fluxenith/codexgpt-bridge/releases/latest)** 下载新版本。

连接失败时，请先确认 ChatGPT 登录状态，再运行 Bridge 的 **Doctor** 诊断。
报告问题时，请附上程序版本、操作系统和复现步骤，并移除账号信息、
私人路径、对话内容和凭证。

登录数据与设置保存在应用程序的本地用户配置文件中。

## 从源代码启动

使用 Node.js 22.20.0 或更新版本，以及 pnpm 11.19.0：

```powershell
pnpm install --frozen-lockfile
pnpm desktop
```

## Gemini Web（实验功能）

Bridge 也能把已登录的 Gemini 网页版账号接入 Codex，使用你 Gemini 网页版的账号与额度，
不需要 API key。

1. 在 Bridge 打开 **Gemini** 页面，点击 **启用 Gemini Web**。
2. 点击 **打开 Gemini 登录**，在 Bridge 内置的 Gemini 浏览器登录，无需关闭浏览器。
3. 点击 **继续并发现模型**，找出你账号可用的模型与思考等级。
4. 点击 **将 Gemini 模型添加到 Codex**，重新启动 Codex，选择 `gemini-web/` 开头的模型。

Simple 模式无需额外设置。Full MCP 还需要固定的公开 HTTPS 地址，并在 Gemini
英文界面连接自定义应用。

目前 Gemini 支持文本与 Codex 工具；附件、媒体、Canvas、深度研究、笔记本与子代理
尚未支持。Gemini 出错时，Bridge 不会自动重新发送请求。

Bridge 会自动操作已登录的 Gemini 网页，界面变化可能影响运行。使用前请先阅读
Google 的[服务条款](https://policies.google.com/terms)与 Gemini 相关政策；
此集成方式可能与其冲突。

## 第三方许可

依赖包的许可证保存在 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)
和 `LICENSES/` 中。本项目采用 [MIT 许可证](LICENSE)。
