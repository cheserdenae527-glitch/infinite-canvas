# M0 容器检查

两个工作流分别报告注册表内容和当前应用的验证结果，应用通过不表示 AI coding 运行环境可用。

## AI coding 注册表诊断

`.github/workflows/m0-image-diagnostic.yml` 先读取 manifest、标签和 digest，收到匿名拉取令牌后立即遮蔽令牌。遇到多平台索引时，检查 `linux/amd64` 的子 manifest。

运行记录 [39356486970](https://github.com/cheserdenae527-glitch/infinite-canvas/actions/runs/39356486970) 显示，`zoonqi/ai_coding:latest` 的 digest 为 `sha256:b1e78f03d5108eb985d4b00aa6726a0179b1623124f92cafb884aa4554e38b24`，其内容是：

- `artifactType`: `application/vnd.docker.mcp.profile.v1+json`
- config: `application/vnd.oci.empty.v1+json`，2 字节的空 JSON。
- 唯一一层为 `application/json`，5623 字节，没有可选择的系统或架构。

这是 MCP profile 配置产物，无法作为带 shell 的容器运行。原来的 `docker pull` 因而报告 `unsupported media type application/vnd.oci.empty.v1+json`。改用 `--platform` 或固定同一个 digest 不会把 profile 变成运行镜像。

诊断现在将这类内容报告为 `runnable=false`、`BLOCKED`，跳过容器拉取。诊断成功只表示已识别注册表内容。若后续引用提供真实的 OCI/Docker 运行配置，则按 digest 固定拉取 `linux/amd64` 镜像；拉取失败会让诊断失败。

MCP profile 应通过 Docker MCP Toolkit 的 profile 导入功能使用。项目现在在同一工作流的 `probe-codex-runtime` job 中，从固定 digest 的 Docker Official `node:22-bookworm-slim` 基础镜像构建临时 Codex 编程环境，安装固定版本的 Codex CLI 与 Bun，并在禁网容器中检查命令和当前源码挂载。镜像只在 GitHub Actions runner 上构建和运行，不推送到 registry；探测不提供模型凭证，也不会发送 Codex 请求。参见 [Docker MCP Profiles](https://docs.docker.com/ai/mcp-catalog-and-toolkit/profiles/)、[Docker Official Node image](https://hub.docker.com/_/node) 和 [Codex CLI 官方安装说明](https://github.com/openai/codex#readme)。

这个临时镜像覆盖 Infinite Canvas 当前的 Node/Bun 开发工具链与 Codex CLI。要实际运行模型调用，用户仍需在自己的运行环境中配置 Codex 登录；M0 探测刻意不处理登录或凭证。

## 当前应用检查

`.github/workflows/m0-container-probe.yml` 检出触发运行的精确 `github.sha`，安装前端依赖并运行 `web` 的 Bun 测试，再用当前仓库的 `docker-compose.local.yml` 构建静态应用。此部署不需要 `.env`、管理员账号或模型 API Key。

HTTP 检查要求首页返回 HTML、包含 React 根节点，并实际引用构建后的 JavaScript 模块。每个引用的模块都须返回非空 JavaScript 和正确的 MIME 类型，避免 SPA 的 HTML 回退被误当成脚本加载成功。测试容器始终清理，不发布镜像或应用。

旧运行 [39356486861](https://github.com/cheserdenae527-glitch/infinite-canvas/actions/runs/39356486861) 的 HTTP 200 来自另行克隆的上游 Go 版本 `ccda172efba25cbee990a785bba715b90cc42b95`，不能用来证明当前静态前端代码已通过验证。

## 回归检查

在仓库根目录运行 `python3 tests/m0-workflows.test.py`。测试仅用 Python 标准库，直接执行工作流中的 Python 逻辑；以固定的注册表和 HTTP 响应验证 MCP profile 跳过拉取、运行镜像按 digest 拉取、平台选择、拉取失败传播，以及首页和 JavaScript 的内容、MIME 检查。测试不访问网络、不启动容器，也不需要安装 YAML 库。
