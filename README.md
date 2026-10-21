# Working MCP

让 AI 编程助手直接使用你电脑上的项目：读取与搜索代码、修改文件、运行命令、查看 Git 历史。

Working MCP 是支持 **Windows 和 macOS** 的桌面应用。双击打开即可启动 MCP Server，通过中文管理界面选择工作区和工具权限。支持 Streamable HTTP，也可以通过 OpenAI Secure MCP Tunnel 连接 ChatGPT。

**[下载最新版本](https://github.com/jeweis/working-mcp-server/releases/latest)** · [查看所有版本](https://github.com/jeweis/working-mcp-server/releases) · [反馈问题](https://github.com/jeweis/working-mcp-server/issues)

## 下载与安装

在 Releases 页面展开 **Assets**，根据电脑选择安装包：

| 你的电脑 | 下载文件 | 使用方式 |
| --- | --- | --- |
| macOS，Apple Silicon（M 系列） | `Working-MCP-版本-mac-arm64.dmg` | 打开 DMG，将应用拖入 Applications |
| macOS，Intel | `Working-MCP-版本-mac-x64.dmg` | 打开 DMG，将应用拖入 Applications |
| Windows，x64 | `Working-MCP-版本-win-x64-setup.exe` | 运行安装向导 |
| Windows，x64，免安装 | `Working-MCP-版本-win-x64-portable.exe` | 双击运行 |

macOS 也提供 ZIP 压缩包。`Source code` 是项目源码，普通使用者请选择上面的安装包。macOS 可在「关于本机」查看芯片类型。

无需安装 Python、Node.js、Git 或 ripgrep。应用已包含运行所需组件；项目自身需要的开发环境（例如 Node、Java、Docker）仍需自行安装。

当前安装包尚未配置开发者签名和 macOS 公证，系统可能提示无法验证开发者。请确认下载来源为本仓库 Releases，并按系统提供的应用许可流程处理。企业设备可能需要管理员允许。

## 第一次使用

1. 打开 **Working MCP**。管理端直接进入，无需登录；MCP Server 自动启动。
2. 在「工作区与权限」点击「添加工作区」，选择你要交给 AI 助手处理的项目目录，并设为默认工作区。首次启动默认使用 Documents 目录。
3. 选择「只读模式」或「全部工具」。初次连接可以先用只读模式查看代码。
4. 在「连接设置」复制 **MCP 地址**和 **MCP API Key**，填入你的 AI 客户端。
5. 让助手调用 `workspace_current`，确认返回的工作区名称和绝对路径是你的项目。

使用期间请保持应用打开。退出应用会停止 MCP Server、隧道和托管的后台命令。

## 连接 AI 客户端

客户端需要支持 **Streamable HTTP MCP** 和 Bearer Token 认证。不同客户端的配置字段可能不同，请按下面的对应关系填写：

| 配置项 | 填写内容 |
| --- | --- |
| 名称 | `Working MCP` |
| 传输方式 | `Streamable HTTP`，部分客户端显示为 `HTTP` |
| Server URL | 管理端显示的 MCP 地址，例如 `http://127.0.0.1:8000/mcp` |
| Bearer Token / API Key | 管理端「连接设置」中的 MCP API Key |
| 自定义请求头（如有） | `Authorization: Bearer 你的MCP_API_Key` |

以管理端实际显示的地址为准：端口被占用时，应用会自动使用其他空闲端口。`127.0.0.1` 仅供这台电脑访问；ChatGPT 等远程客户端请使用下一节的隧道。

MCP API Key 首次启动时自动生成，重启后保留。你可以在管理端查看、复制、修改或重新生成；修改后旧密钥立即失效，需要更新客户端配置。请勿将密钥提交到代码仓库或分享给他人。

## 连接 ChatGPT

桌面端的「ChatGPT 隧道」内置官方 tunnel-client，并提供分步引导。你需要具备相应 OpenAI Platform 组织和 ChatGPT 工作区权限，具体可用性以账号和[官方 Secure MCP Tunnel 指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)为准。

1. 打开 [Platform Tunnel 设置](https://platform.openai.com/settings/organization/tunnels)，创建或选择 Tunnel，关联目标 ChatGPT 工作区，复制 Tunnel ID。
2. 创建具有 **Tunnels Read + Use** 权限的 OpenAI Platform 运行 API Key。创建或修改 Tunnel 还需要 **Read + Manage** 权限。
3. 在应用「ChatGPT 隧道」填写 Tunnel ID 和运行密钥，保存并启动，等待显示「隧道就绪」。
4. 打开 [ChatGPT Plugins](https://chatgpt.com/plugins)，选择 **＋ → Add custom MCP server**。Connection 选择 **Tunnel** 并选择相同的 ID；Authentication 选择 **No authentication**，审阅提示后创建并安装插件。
5. 在 ChatGPT 中启用插件，调用 `workspace_current`。真实工具调用成功后，才表示接入完成。页面提供可复制的验证提示词。

这里有两种密钥，请勿混用：

| 密钥 | 用途 |
| --- | --- |
| 本机 MCP API Key，默认 `wmcp_...` | AI 客户端连接本机 MCP；隧道转发时由应用自动附加 |
| OpenAI 运行 API Key，通常 `sk-...` | tunnel-client 连接 OpenAI 的隧道服务 |

ChatGPT 选择 No authentication 时，本机 MCP 的认证仍然开启：应用会在本机转发请求时自动附加 MCP API Key。隧道通过出站 HTTPS 工作，无需在路由器开放端口。

运行密钥默认只在本次应用打开期间保留。勾选「使用系统加密记住运行密钥」后，会使用系统加密保存；需要自动连接时，再勾选「下次打开应用自动连接」。停止隧道不会停止本机 MCP Server。

## 工作区与权限

你可以添加多个项目目录、重命名工作区和设置默认工作区。移除工作区只移除配置，不会删除磁盘文件。已有运行中进程的工作区需要先停止进程才能移除。

- **只读模式**：仅暴露读取、搜索、Git 查看和工作区工具，共 11 个工具。
- **全部工具**：额外允许文件修改、命令执行和进程管理，共 17 个工具。

切换模式立即生效。切到只读时会停止托管的命令，已完成的文件修改会保留。客户端未刷新工具列表时，可重新连接。

每个 AI 会话可以独立选择工作区，不会改变其他会话正在处理的项目。默认工作区用于新会话；切换工作区不会改变已启动后台命令的目录。

**全部工具模式允许执行本地命令，不是沙箱。** 文件工具会限制在所选工作区内，但 Shell 命令可能访问电脑上的其他位置。请只连接你信任的客户端，并按需要开启全部工具。

## 提供给助手的工具

| 能力 | 工具 |
| --- | --- |
| 浏览与搜索代码 | `ls`、`read`、`grep`、`glob` |
| 修改文件 | `edit`、`write` |
| 执行命令与管理后台任务 | `bash`、`process_list`、`process_output`、`process_stop` |
| 查看 Git 状态与历史 | `git_status`、`git_diff`、`git_log`、`git_show` |
| 查看与切换工作区 | `workspace_list`、`workspace_current`、`workspace_switch` |

可以把下面这段要求交给助手：

> 先调用 workspace_current 确认工作区，保存返回的 session_id，后续工具调用继续传入这个 ID。需要切换项目时先调用 workspace_list，再用 workspace_switch 选择工作区。修改已有文件前先 read；长时间命令使用 bash 的 background=true，并通过 process_output 查看结果。

Git 工具用于查看状态、差异和历史。需要提交、恢复或其他 Git 操作时，可在全部工具模式下通过 `bash` 执行，并由你与助手确认操作范围。

## 常见问题

**客户端连接失败或提示 401**

确认应用仍在运行，URL 包含 `/mcp`，并使用当前 MCP API Key。修改密钥或端口后，需要更新客户端配置。

**只能读取，不能修改或运行命令**

检查是否开启了只读模式。切换为全部工具后，刷新客户端工具列表或重新连接。

**找不到项目或 Git 历史**

在管理端添加现有项目目录，并让助手确认当前工作区。使用 Git 工具时，请选择 Git 仓库根目录。

**ChatGPT 中看不到 Tunnel**

检查 Tunnel 关联的 ChatGPT 工作区，以及用户和运行密钥的权限。权限调整可能需要等待生效；企业账号的关联可能需要管理员或 OpenAI 客户团队协助。管理端提供诊断、脱敏日志和官方说明入口。

**更新会丢失配置吗？**

正常替换应用或安装新版本会保留用户数据目录中的配置。macOS 通常位于 `~/Library/Application Support/Working MCP`，Windows 通常位于 `%APPDATA%/Working MCP`。备份时请将密钥文件视为敏感信息；加密保存的运行密钥不保证能迁移到其他电脑或系统账号。

**遇到其他问题**

请在 [Issues](https://github.com/jeweis/working-mcp-server/issues) 提供操作系统、应用版本、复现步骤和脱敏后的错误信息。不要上传 API Key 或包含私人项目内容的日志。

## 开源协议

本项目使用 [MIT License](LICENSE)，允许使用、修改和分发。随安装包分发的第三方组件遵循各自的许可证。

希望参与开发或自行构建？请查看[开发与发布说明](docs/development.md)。
