/**
 * dsh-claude-pilot — 把本机 Claude Code CLI 接成 DSH 原生工具（host 半）。
 *
 * 与 codex-pilot 对称：run / resume / probe。
 * Claude Code 没有 `queue`（不存在往运行中会话投递消息的 IPC），
 * 所以这里不假装有；多出来的是 --json-schema 结构化输出。
 *
 * 调用面：`claude -p "<prompt>" --output-format json`
 *   → { type:"result", result, session_id, is_error, num_turns, total_cost_usd, duration_ms }
 * session_id 就是 claude --resume <id> 要的 id，所以 resume 是它的直接延续。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "claude-pilot";
export const inject = ["tools"];

const DEFAULTS = {
  /** 显式指定 claude 可执行文件；null = 自动探测 */
  claudePath: null,
  /** 默认工作目录；null = DSH 进程 cwd */
  defaultCwd: null,
  timeoutMs: 600000,
  maxOutputChars: 20000,
  /** 额外传给 CLI 的权限模式；null = 用 Claude Code 自己的设置 */
  permissionMode: null,
  extraEnv: {},
};

const EXE = process.platform === "win32" ? "claude.exe" : "claude";

export function resolveClaudePath(cfg) {
  const cands = [];
  const push = (p) => p && cands.push(p);
  push(cfg.claudePath);
  push(process.env.CLAUDE_CLI_PATH);
  // npm 全局安装：node 同目录（nvm-windows / program files）
  const nodeDir = dirname(process.execPath);
  push(join(nodeDir, "node_modules", "@anthropic-ai", "claude-code", "bin", EXE));
  // npm 全局默认前缀
  if (process.env.APPDATA) {
    push(join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", EXE));
  }
  // 原生安装脚本
  push(join(homedir(), ".local", "bin", EXE));
  push("/usr/local/bin/claude");
  push(join(homedir(), ".claude", "local", EXE));
  for (const c of cands) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {}
  }
  return "claude";
}

function clamp(text, max) {
  if (!text) return "";
  if (text.length <= max) return text;
  return "…[前 " + (text.length - max) + " 字省略]…\n" + text.slice(-max);
}

/** .cmd / .bat 不能直接 spawn（Node 会 EINVAL），只能经 cmd.exe 转发。 */
function spawnTarget(bin, argv) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    const quoted = argv.map((a) => '"' + String(a).replace(/"/g, '""') + '"').join(" ");
    return { bin: process.env.COMSPEC || "cmd.exe", argv: ["/d", "/s", "/c", '"' + bin + '" ' + quoted] };
  }
  return { bin, argv };
}

function runCli(cfg, argv, opts) {
  const cwd = opts.cwd || cfg.defaultCwd || process.cwd();
  const timeoutMs = Number(opts.timeoutMs || cfg.timeoutMs);
  const startedAt = Date.now();
  const target = spawnTarget(cfg.claudePath, argv);
  let stdout = "";
  let stderr = "";
  let settled = false;
  let timer = null;

  return new Promise((done) => {
    const finish = (status, extra) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const e = extra || {};
      done({
        status,
        exitCode: typeof e.exitCode === "number" ? e.exitCode : null,
        durationMs: Date.now() - startedAt,
        cwd,
        argv,
        stdout: clamp(stdout, cfg.maxOutputChars),
        stderr: clamp(stderr, cfg.maxOutputChars),
        error: e.error || null,
        parsed: parseClaudeJson(stdout),
      });
    };

    let child;
    try {
      child = spawn(target.bin, target.argv, {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...cfg.extraEnv },
      });
    } catch (err) {
      return finish("error", { error: "spawn 失败：" + err.message });
    }

    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("error", (err) => finish("error", { error: String(err.message || err) }));
    child.on("close", (code) =>
      code === 0
        ? finish("done", { exitCode: 0 })
        : finish("failed", { exitCode: code, error: "exit code " + code }),
    );

    const abort = () => {
      try {
        child.kill();
      } catch {}
      finish("cancelled", { error: "已取消" });
    };
    if (opts.signal) {
      if (opts.signal.aborted) abort();
      else opts.signal.addEventListener("abort", abort, { once: true });
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        finish("timeout", { error: "超时 " + timeoutMs + "ms" });
      }, timeoutMs);
    }
  });
}

function parseClaudeJson(stdout) {
  const text = (stdout || "").trim();
  if (!text) return null;
  const start = text.lastIndexOf("\n{");
  const body = start >= 0 ? text.slice(start + 1) : text;
  try {
    const obj = JSON.parse(body);
    if (obj && typeof obj === "object" && "session_id" in obj) return obj;
  } catch {}
  return null;
}

function render(r) {
  const p = r.parsed;
  const lines = [];
  if (p) {
    if (r.status !== "done") lines.push("[" + r.status + "] exit=" + r.exitCode);
    lines.push(
      "[" +
        (p.is_error ? "error" : "ok") +
        "] " +
        ((p.duration_ms || r.durationMs) / 1000).toFixed(1) +
        "s  turns=" +
        (p.num_turns ?? "?") +
        (p.total_cost_usd != null ? "  cost=$" + Number(p.total_cost_usd).toFixed(4) : ""),
    );
    lines.push("sessionId: " + p.session_id + "   （续接：claude_resume sessionId=" + p.session_id + "）");
    lines.push("---- result ----");
    lines.push(typeof p.result === "string" ? p.result : JSON.stringify(p.result, null, 2));
    const other = Object.keys(p).filter(
      (k) => !["result", "session_id", "num_turns", "total_cost_usd", "duration_ms", "is_error", "type", "subtype", "uuid"].includes(k),
    );
    if (other.length) {
      lines.push("---- meta ----");
      for (const k of other) lines.push(k + ": " + JSON.stringify(p[k]).slice(0, 2000));
    }
  } else {
    lines.push("[" + r.status + "] exit=" + r.exitCode + "  " + (r.durationMs / 1000).toFixed(1) + "s");
    lines.push("cwd: " + r.cwd);
  }
  if (r.error) lines.push("error: " + r.error);
  if (!p && r.stdout) lines.push("---- stdout ----", r.stdout);
  if (r.stderr) lines.push("---- stderr ----", r.stderr);
  return lines.join("\n");
}

const output = {
  schema: { type: "string" },
  render: (_args, value) => [{ type: "text", text: value }],
};

function baseArgs(cfg, args) {
  const argv = ["-p"];
  if (args.model) argv.push("--model", args.model);
  const mode = args.permissionMode || cfg.permissionMode;
  if (mode) argv.push("--permission-mode", mode);
  if (args.jsonSchema) argv.push("--json-schema", args.jsonSchema);
  argv.push("--output-format", "json");
  return argv;
}

function buildTools(cfg) {
  const call = (argv, args, exec) =>
    runCli(cfg, argv, {
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
      signal: exec && exec.signal,
    }).then(render);

  return [
    defineTool({
      name: "claude_run",
      description:
        "把一块独立任务交给本机 Claude Code，用一次性 print 会话（claude -p --output-format json）同步跑完并取回结果与 sessionId。" +
        "输出的 sessionId 可以直接喂给 claude_resume 继续对话。",
      parameters: {
        prompt: { type: "string", required: true, description: "交给 Claude Code 的完整任务描述" },
        cwd: { type: "string", description: "工作目录；默认用插件配置的 defaultCwd 或 DSH 进程 cwd" },
        model: { type: "string", description: "覆盖模型（透传 --model，别名或全名）" },
        permissionMode: {
          type: "string",
          description: "权限模式（透传 --permission-mode）：default / acceptEdits / plan / bypassPermissions",
        },
        jsonSchema: {
          type: "string",
          description: "可选 JSON Schema 字符串，要求 Claude 按该结构返回（透传 --json-schema）",
        },
        timeoutMs: { type: "integer", description: "超时毫秒，默认 600000" },
      },
      output,
      execute(args, exec) {
        return call([...baseArgs(cfg, args), args.prompt], args, exec);
      },
    }),

    defineTool({
      name: "claude_resume",
      description:
        "续接一个已有的 Claude Code 会话：给 sessionId 继续，或 last=true 续接当前目录最近一次会话（--continue），" +
        "fork=true 时开一个分叉的新 sessionId（--fork-session）。",
      parameters: {
        prompt: { type: "string", required: true, description: "续接时发送的消息" },
        sessionId: { type: "string", description: "claude_run 返回的 sessionId" },
        last: { type: "boolean", description: "true = 续接当前工作目录最近一次会话（等价 --continue）" },
        fork: { type: "boolean", description: "true = 分叉成新会话（等价 --fork-session）" },
        cwd: { type: "string", description: "工作目录；--continue 是按目录找会话的，这里要和上次一致" },
        model: { type: "string", description: "覆盖模型" },
        timeoutMs: { type: "integer", description: "超时毫秒" },
      },
      output,
      execute(args, exec) {
        if (!args.sessionId && !args.last) {
          return Promise.resolve("[error] claude_resume 需要 sessionId 或 last=true");
        }
        const argv = baseArgs(cfg, args);
        if (args.sessionId) argv.push("--resume", args.sessionId);
        else argv.push("--continue");
        if (args.fork) argv.push("--fork-session");
        argv.push(args.prompt);
        return call(argv, args, exec);
      },
    }),

    defineTool({
      name: "claude_probe",
      description:
        "体检：报告解析到的 claude 可执行文件、版本，以及 -p / --output-format / --resume / --continue 是否可用。" +
        "claude_* 工具报错时先跑它。",
      parameters: {},
      output,
      execute() {
        const v = spawnSyncSafe(cfg, ["--version"]);
        const h = spawnSyncSafe(cfg, ["--help"]);
        const need = ["--print", "--output-format", "--resume", "--continue", "--json-schema"];
        const flags = need.map((f) => f + ": " + (h.body.includes(f) ? "yes" : "no"));
        return [
          "claudePath: " + cfg.claudePath,
          "--version: " + (v.body.trim() || "(失败) " + v.error),
          "help: " + (h.ok ? "ok" : "不可用 " + h.error),
          flags.join("  |  "),
        ].join("\n");
      },
    }),
  ];
}

function spawnSyncSafe(cfg, argv) {
  const target = spawnTarget(cfg.claudePath, argv);
  try {
    const r = spawnSync(target.bin, target.argv, {
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true,
      env: { ...process.env, ...cfg.extraEnv },
    });
    return {
      ok: r.status === 0,
      body: (r.stdout || "") + (r.stderr || ""),
      error: r.error ? String(r.error.message || r.error) : "",
    };
  } catch (e) {
    return { ok: false, body: "", error: String(e.message || e) };
  }
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  cfg.claudePath = resolveClaudePath(cfg);
  for (const tool of buildTools(cfg)) ctx.tools.register(tool);
}