# 开发与发布

普通用户请查看 [README](../README.md)。本页面向修改源码、自行构建或维护发布流程的人。

## 本地开发

需要 Python 3.12+、Node.js 24、[uv](https://docs.astral.sh/uv/)。

```bash
uv sync --locked
npm ci
npm start
```

开发模式以仓库目录作为首次默认工作区。桌面端用户数据目录与正式应用相同；需要独立测试配置时，设置 `WORKING_DESKTOP_DATA_DIR` 为临时目录。

后端基于 FastMCP，使用 Streamable HTTP；管理页面为同源 HTML/CSS/JavaScript，Electron 通过受限 IPC 调用管理接口。文件、搜索/Git、进程、工作区配置分别位于 `src/working_mcp_server/` 的独立模块中。

## 测试

```bash
uv run pytest -q
npm test
node --check src/working_mcp_server/static/app.js
```

源代码测试中的搜索、Git 和命令测试需要 `rg`、Git、Bash 可用。可先构建并准备桌面资源，再将 `build/desktop-resources/tools` 和其中的 Git `bin` 加到 PATH；Windows 还需 Git `usr/bin`。

真实 HTTP 集成测试需要允许监听本机端口：

```bash
WORKING_MCP_HTTP_TESTS=1 uv run pytest tests/test_http.py -q
```

打包后端及官方隧道客户端的集成验证：

```bash
npm run backend:build
npm run desktop:prepare
npm run backend:smoke
npm run tunnel:smoke
```

`tunnel:smoke` 使用真实官方 CLI、本机 MCP 和本地模拟控制端，验证认证转发及工具响应回传，不使用真实 OpenAI 账户。真实 ChatGPT 接入需完成 README 中的账号设置并调用工具验证。

## 本地打包

```bash
npm run dist:mac
# 在 Windows 上运行：
npm run dist:win
```

必须在目标操作系统和 CPU 架构上构建 Python 后端。产物位于 `release/`，`npm run pack` 只生成应用目录。

Windows 构建机需安装完整 Git for Windows（包含 Bash），默认从 `C:\Program Files\Git` 打包，可通过 `WORKING_BUILD_GIT_ROOT` 指定。macOS 使用 dugite 内置 Git，ripgrep 由 npm 包提供。最终用户无需安装这些工具。

CI 使用 uv 管理的 Python。cryptography 50+ 不再提供 Intel macOS wheel；Intel 构建需要 Rust 和 Homebrew OpenSSL（GitHub runner 已提供），通过 `OPENSSL_STATIC=1` 和 `OPENSSL_DIR` 静态链接，避免打包后与 Python 的 OpenSSL 动态库重名冲突。自行在 Intel Mac 构建时也需设置这两个变量，并清理以前的 cryptography 构建缓存后重新安装依赖。

`desktop:prepare` 会下载当前平台的 OpenAI 官方最新 tunnel-client，按同一发布的 SHA256SUMS 校验，并附带 cloudflared 和许可文件。下载失败或校验失败会中止打包。

项目自身使用 MIT；第三方组件保留各自许可。当前不配置 Windows 签名、macOS 开发者签名或公证，发布工作流也不会自动绕过系统校验。

## main 自动发布

工作流：[`desktop.yml`](../.github/workflows/desktop.yml)。推送 `main` 或在 Actions 中对 `main` 手动运行 **Release desktop apps** 即可，无需手动创建 tag 或提供个人访问令牌。

1. 读取完整标签历史，选择下一个稳定版本。首次使用 `package.json` 中的版本（当前为 `0.1.0`），之后对最高的 `vX.Y.Z` 标签递增 patch。手动调高 `package.json` 版本可发布新的 minor/major。
2. 在 macOS Apple Silicon、macOS Intel、Windows x64 runner 上原生构建。生成版本写入 CI 工作目录中的 npm/Python 元数据，不回写 `main`。
3. 执行测试、打包后端验证、官方 tunnel-client 离线集成验证，并生成安装包。安装包先上传为 Actions artifacts。
4. 三个平台全部成功后，校验七个安装包及更新元数据齐全、生成 `SHA256SUMS.txt`，为触发工作流的提交创建版本标签。
5. 创建 Release 草稿，上传全部下载文件，再将其公开为最新版本。自动附带 GitHub 生成的变更说明。

预期下载文件：

- macOS arm64：DMG、ZIP。
- macOS x64：DMG、ZIP。
- Windows x64：setup EXE、portable EXE、ZIP。
- `latest.yml`、`latest-arm64-mac.yml`、`latest-x64-mac.yml`：标准更新组件使用的元数据。
- `SHA256SUMS.txt`：以上文件的 SHA-256 校验值。

版本分配、构建和发布在同一工作流中完成，避免依赖 `GITHUB_TOKEN` 创建 tag 后再次触发工作流。只给发布 job `contents: write` 权限，构建 job 仅有读权限。工作流串行执行；GitHub 在繁忙时可能合并等待中的触发，最终会为实际执行的提交发布版本。

构建失败不会公开 Release。发布阶段中断时，可能保留版本标签和草稿；可在 Actions 中重跑失败任务，继续上传。已公开的同一提交版本重跑时不会覆盖下载文件。若失败提交之后推送新提交，会按已有标签选择下一版本，不挪动旧标签。

首次启用请确认仓库 Settings → Actions 允许运行工作流，组织策略允许发布 job 使用 `contents: write`。此配置使用仓库自带的 `GITHUB_TOKEN`，不需要额外配置 Secret。若仓库规则禁止创建 `v*` 标签，需要管理员允许该自动发布流程。

## 可选：仅运行 MCP 服务

命令行模式需要 Python、Bash、Git、ripgrep，适合自行部署者：

```bash
uv sync --locked
export WORKING_MCP_API_KEY='替换为随机生成的长密钥'
uv run working-mcp-server
# 或限制为只读：
uv run working-mcp-server --read-only
```

默认管理页面为 `http://127.0.0.1:8000/admin`，MCP 为 `/mcp`。命令行管理端与 MCP 使用相同 Key；桌面实例使用独立的私有管理凭据，无需用户登录。

参数支持 `--host`、`--port`、`--config`。首次命令行启动以当前目录作为默认工作区，后续读取已保存配置。远程部署需自行配置 HTTPS；Server 使用单进程，不要配置多个 Uvicorn worker。

## 更新与 Windows 启动回归

`desktop/updates.cjs` 使用固定的 GitHub 仓库正式 Release 源。默认自动检查、默认不自动下载，从不在普通退出时安装。Windows 安装版使用 electron-updater；macOS 只有具备开发者签名时才启用标准自动安装。当前未签名 macOS、Windows ZIP 和便携 EXE 使用带 SHA-256 校验的下载与替换引导。

两种 macOS 架构各自发布更新元数据，避免合并 artifacts 时覆盖 `latest-mac.yml`。发布校验和同时覆盖安装包和更新元数据。

Windows Git 通过 `scripts/git_bundle.cjs` 去掉文档、翻译和 GUI 资源，保留 DLL、Bash/coreutils、Git helpers、SSH/TLS 和许可证。构建会记录裁剪前后文件数/字节数。不能用不含 Bash 的 MinGit 直接替代。

当前 electron-builder 26.15.3 的 PortableOptions 不支持自定义脚本钩子。`scripts/prepare_windows.cjs` 因此在打包准备时安装仓库中维护的 `desktop/windows/portable.nsi` 模板，并严格检查打包器版本；升级打包器时需要重新审查模板。模板保留 NSIS 原生准备窗口、检查 TEMP 空间，使用每次启动独立的目录，避免删除运行中实例的文件。安装版继续使用标准 NSIS 向导，只添加临时盘和所选目标盘检查。

`scripts/windows_release_smoke.ps1` 在 Windows runner 对实际产物运行：

- 隔离 PATH，移除系统 Git/Bash，验证 ZIP、便携 EXE、安装版的真实窗口、启动耗时和 renderer/backend 就绪结果。
- 要求便携版在 10 秒内出现原生准备窗口，应用在 240 秒内就绪；结果属于 CI 机器，不能代表所有用户电脑。
- 独立测上一版便携版和安装版，记录失败，不把旧包的慢启动与安装崩溃混为同一根因。
- 安装版向导可见性、静默安装、覆盖升级、配置保留、静默卸载。
- 通过单独编译的 NSIS 测试程序，验证低空间时拒绝继续并返回 Windows 磁盘空间不足错误码 112。该测试不修改磁盘容量，也不在正式应用中引入测试绕过开关。

CI 保存 `windows-release-test-evidence`（日志、时间与窗口结果、Git 裁剪统计），测试失败会阻止公开 Release。该验证不包含所有杀毒软件、磁盘类型或真实用户安装环境；出现崩溃仍需保留独立日志复现。
