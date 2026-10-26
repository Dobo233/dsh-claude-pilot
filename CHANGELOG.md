# Changelog

## 0.1.0

- 首个版本：`claude_run` / `claude_resume` / `claude_probe` 三个 DSH 工具。
- `claude_run` 解析 `--output-format json`，把 `session_id` 回显成可直接续接的提示。
- `claude_resume` 支持 `sessionId` / `last`（`--continue`）/ `fork`（`--fork-session`）。
- 可选 `--json-schema` 结构化输出、`--permission-mode` 权限模式。
- 独立桥 `standalone/bridge.cjs`（HTTP + 文件信箱）与 `standalone/ask.ps1`。
- Windows：`claude.cmd` 经 cmd.exe 转发，指向 `.exe` 时直接 spawn。