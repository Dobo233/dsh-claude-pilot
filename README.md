# dsh-claude-pilot

把本机 **Claude Code CLI** 接成 [DeepSeek Harness](https://github.com/deepseek-ai) 的原生工具。与 [dsh-codex-pilot](https://github.com/OWNER/dsh-codex-pilot) 是一对：同一套 `run / resume / probe` 语义，按你手上有哪个 CLI 选哪个。

| 形态 | 入口 | 需要什么 |
| --- | --- | --- |
| **DSH 插件**（推荐） | `lib/index.js`，注册 `claude_*` 工具 | 已装 DSH + 本机 `claude` 且**已登录** |
| **独立桥** | `standalone/bridge.cjs`，HTTP + 文件信箱 | 只要 Node ≥ 20 |

## 安装

```bash
dsh plugin --profile web add github:<owner>/dsh-claude-pilot
dsh plugin --profile web add E:\path\to\dsh-claude-pilot   # 本地
```

装完重启 DSH，工具面板里应出现 `claude_run / claude_resume / claude_probe`。

## 工具

| 工具 | 干什么 | 底层 |
| --- | --- | --- |
| `claude_run` | 开一次性 print 会话跑一整块任务，返回结果 + `session_id` | `claude -p "<prompt>" --output-format json [--model m] [--permission-mode p] [--json-schema s]` |
| `claude_resume` | 续接会话：给 `sessionId`，或 `last=true`（当前目录最近一次），`fork=true` 分叉 | `--resume <id>` / `--continue` / `--fork-session` |
| `claude_probe` | 体检：可执行文件、版本、关键旗标是否齐 | `claude --version` / `claude --help` |

返回里最有用的不是正文而是 `sessionId`：拿到就能 `claude_resume sessionId=...` 接着聊，上下文不丢。

### 关于 `--json-schema`

Claude Code 独有能力（Codex 侧没有对应物）：给一个 JSON Schema 字符串，让它按结构返回，适合要机器可读结果时用。Codex 侧换来的独有能力是 `codex_queue`（往运行中的会话投消息）。

| 能力 | Codex | Claude Code |
| --- | --- | --- |
| 一次性任务 | `codex_run` | `claude_run` |
| 续接会话 | `codex_resume` | `claude_resume` |
| 往运行中会话投消息 | `codex_queue` ✅ | ❌ 无此 IPC |
| 结构化输出 | ❌ | `--json-schema` ✅ |

## 配置

```yaml
claudePath: null          # 显式路径；null = 自动探测（node 同目录的 node_modules/@anthropic-ai/claude-code/bin/claude.exe → %APPDATA%\npm\... → ~/.local/bin/claude → PATH）
defaultCwd: null          # 默认工作目录
timeoutMs: 600000
maxOutputChars: 20000     # 超长保留尾部
permissionMode: null      # null = 用 Claude Code 自己的设置；可选 default / acceptEdits / plan / bypassPermissions
extraEnv: {}
```

### 无头登录（CI / 桥 / 不开终端界面）

Claude Code 的登录态**不跟桌面端共享**：CLI 自己的凭据只在 `~/.claude.json` 的 `claudeAiOauth` 字段或 `~/.claude/.credentials.json` 里，两者都没有时 `-p` 会直接返回 `Not logged in · Please run /login`。

两种补法：

```powershell
claude            # 交互式一次，进来后 /login（浏览器 OAuth，选同一个账号）
claude setup-token   # 充："Set up a long-lived authentication token (requires Claude subscription)"
```

`setup-token` 拿到的是长期 token，放进环境变量即可被本插件继承（`env` 是 `process.env` 直通）：

```powershell
$env:CLAUDE_CODE_OAUTH_TOKEN = '<token>'          # 当前会话生效
# 或只给插件：配置里 extraEnv: { CLAUDE_CODE_OAUTH_TOKEN: '<token>' }
```
## 独立桥（不用 DSH）

```bash
node standalone/bridge.cjs        # 默认 http://127.0.0.1:8788
```

- HTTP：`GET /health`、`GET /probe`、`POST /run`、`POST /resume`（别名 `POST /claude`、`POST /start`）；**没有 `/queue`**
- 文件信箱：`mailbox/inbox/<id>.json` → `mailbox/results/<id>.json`
- Windows 最短路径：`.\standalone\ask.ps1 "任务描述"`（桥没起来会自动拉起）

请求体：`{ prompt, cwd?, model?, permissionMode?, jsonSchema?, timeoutMs?, sessionId?, last?, fork? }`。

## 排错

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| `result: "Not logged in · Please run /login"`，exit=1 | 这台机器的 Claude Code 没登录（本插件转发的是 CLI 的登录态） | 终端跑一次 `claude` 完成 `/login`，再用 `claude_probe` 确认 |
| `claude_probe` 报 `--resume: no` | Claude Code 版本太老 | 升级 `@anthropic-ai/claude-code` |
| spawn 失败 `EINVAL` | 指向了 `claude.cmd`（Windows 上 .cmd 不能被 Node 直接 spawn） | 让 `claudePath` 指向 `...\claude-code\bin\claude.exe`，插件只对 `.cmd` 才走 cmd.exe 转发 |

## 安全边界

- 只跑**本机已登录**的 Claude Code，不读取、不转发、不存储任何凭据。
- Claude Code 默认会问权限；想无人工跑完要么在设置里放行，要么显式传 `permissionMode: "bypassPermissions"`（自己承担风险）。
- 桥只绑 `127.0.0.1`，**没有鉴权**：不要暴露到公网。

## 兼容性

- DSH `0.2.x`；Node `^22.19.0 || >=24.0.0`
- Claude Code `2.1.187` 实测（`-p / --output-format / --resume / --continue / --json-schema` 全在）

## English

`dsh-claude-pilot` exposes the local Claude Code CLI as DSH tools (`claude_run`, `claude_resume`, `claude_probe`) with session continuity via `session_id` → `--resume`, plus a standalone loopback bridge. It wraps your already-authenticated `claude` binary — no credential handling. Claude Code has no way to inject a message into a running session, so there is no `queue` counterpart; instead it exposes `--json-schema` structured output. Loopback only, no auth.

## License

MIT