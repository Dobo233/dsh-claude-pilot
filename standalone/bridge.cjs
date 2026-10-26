#!/usr/bin/env node
/**
 * claude-bridge — 独立进程版的 Claude Code 桥（不需要 DSH 也能用）。
 *
 * 两种投递方式，语义与 dsh-claude-pilot 的 claude_run / claude_resume 一致：
 *   1) HTTP       POST http://127.0.0.1:8788/run | /resume | /claude | /start   GET /health | /probe
 *   2) 文件信箱   mailbox/inbox/*.json  ->  mailbox/results/<同 id>.json
 *
 * 与 codex-bridge 的差别：Claude Code 没有 queue（无法往运行中的会话投消息），
 * 所以这里没有 /queue；多出来的是 jsonSchema 结构化输出。
 *
 * 用法： node bridge.cjs [--config bridge.config.json]
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const BRIDGE_DIR = __dirname;
const MAILBOX = path.join(BRIDGE_DIR, 'mailbox');
const INBOX = path.join(MAILBOX, 'inbox');
const RESULTS = path.join(MAILBOX, 'results');
const QUARANTINE = path.join(MAILBOX, 'quarantine');
for (const dir of [MAILBOX, INBOX, RESULTS, QUARANTINE]) fs.mkdirSync(dir, { recursive: true });

const DEFAULTS = {
  port: 8788,
  host: '127.0.0.1',
  claudePath: null,
  defaultCwd: null,
  defaultTimeoutMs: 600000,
  pollMs: 1000,
  maxOutputChars: 20000,
};

function log(msg) {
  const stamp = new Date().toISOString().replace('T', ' ').replace('Z', '');
  console.log('[' + stamp + '] ' + msg);
}

const EXE = process.platform === 'win32' ? 'claude.exe' : 'claude';

function findClaude(configured) {
  const cands = [];
  if (configured) cands.push(configured);
  if (process.env.CLAUDE_CLI_PATH) cands.push(process.env.CLAUDE_CLI_PATH);
  const nodeDir = path.dirname(process.execPath);
  cands.push(path.join(nodeDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', EXE));
  if (process.env.APPDATA) {
    cands.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', EXE));
  }
  cands.push(path.join(require('node:os').homedir(), '.local', 'bin', EXE));
  for (const c of cands) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {}
  }
  return EXE;
}

function loadConfig(explicit) {
  const file = explicit || path.join(BRIDGE_DIR, 'bridge.config.json');
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (fs.existsSync(file)) log('配置读取失败，用默认值：' + err.message);
  }
  const cfg = Object.assign({}, DEFAULTS, user);
  cfg.claudePath = findClaude(cfg.claudePath);
  if (!cfg.defaultCwd) cfg.defaultCwd = BRIDGE_DIR;
  return cfg;
}

function clamp(text, max) {
  if (!text) return '';
  if (text.length <= max) return text;
  return '…[前 ' + (text.length - max) + ' 字省略]…\n' + text.slice(-max);
}

/** .cmd / .bat 不能直接 spawn，只能经 cmd.exe 转发 */
function spawnTarget(bin, argv) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const quoted = argv.map(function (a) { return '"' + String(a).replace(/"/g, '""') + '"'; }).join(' ');
    return { bin: process.env.COMSPEC || 'cmd.exe', argv: ['/d', '/s', '/c', '"' + bin + '" ' + quoted] };
  }
  return { bin: bin, argv: argv };
}

function runClaude(cfg, argv, opts) {
  const cwd = opts.cwd || cfg.defaultCwd;
  const timeoutMs = Number(opts.timeoutMs || cfg.defaultTimeoutMs);
  const target = spawnTarget(cfg.claudePath, argv);
  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  let done = false;
  return new Promise(function (resolve) {
    function finish(status, extra) {
      if (done) return;
      done = true;
      const e = extra || {};
      resolve({
        status: status,
        exitCode: typeof e.exitCode === 'number' ? e.exitCode : null,
        durationMs: Date.now() - startedAt,
        cwd: cwd,
        argv: argv,
        stdout: clamp(stdout, cfg.maxOutputChars),
        stderr: clamp(stderr, cfg.maxOutputChars),
        parsed: parseClaudeJson(stdout),
        error: e.error || null,
      });
    }
    let child;
    try {
      child = spawn(target.bin, target.argv, {
        cwd: cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      return finish('error', { error: 'spawn 失败：' + err.message });
    }
    child.stdout.on('data', function (c) { stdout += c.toString('utf8'); });
    child.stderr.on('data', function (c) { stderr += c.toString('utf8'); });
    child.on('error', function (err) { finish('error', { error: String(err.message || err) }); });
    child.on('close', function (code) {
      if (code === 0) finish('done', { exitCode: 0 });
      else finish('failed', { exitCode: code, error: 'exit code ' + code });
    });
    if (timeoutMs > 0) {
      setTimeout(function () {
        try { child.kill(); } catch {}
        finish('timeout', { error: '超时 ' + timeoutMs + 'ms' });
      }, timeoutMs);
    }
  });
}

function parseClaudeJson(stdout) {
  const text = (stdout || '').trim();
  if (!text) return null;
  const idx = text.lastIndexOf('\n{');
  const body = idx >= 0 ? text.slice(idx + 1) : text;
  try {
    const obj = JSON.parse(body);
    if (obj && typeof obj === 'object' && 'session_id' in obj) return obj;
  } catch {}
  return null;
}

function baseArgs(req) {
  const argv = ['-p'];
  if (req.model) argv.push('--model', req.model);
  if (req.permissionMode) argv.push('--permission-mode', req.permissionMode);
  if (req.jsonSchema) argv.push('--json-schema', typeof req.jsonSchema === 'string' ? req.jsonSchema : JSON.stringify(req.jsonSchema));
  argv.push('--output-format', 'json');
  return argv;
}

function beginRun(cfg, req) {
  if (!req.prompt) return Promise.resolve({ status: 'error', error: '缺 prompt' });
  return runClaude(cfg, baseArgs(req).concat([req.prompt]), req).then(summarize);
}

function resumeRun(cfg, req) {
  if (!req.prompt) return Promise.resolve({ status: 'error', error: '缺 prompt' });
  if (!req.sessionId && !req.last) return Promise.resolve({ status: 'error', error: 'resume 需要 sessionId 或 last=true' });
  const argv = baseArgs(req);
  if (req.sessionId) argv.push('--resume', req.sessionId);
  else argv.push('--continue');
  if (req.fork) argv.push('--fork-session');
  argv.push(req.prompt);
  return runClaude(cfg, argv, req).then(summarize);
}

function summarize(r) {
  const p = r.parsed;
  return {
    status: p && p.is_error ? 'error' : r.status,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    sessionId: p ? p.session_id : null,
    result: p ? p.result : null,
    numTurns: p ? p.num_turns : null,
    costUsd: p ? p.total_cost_usd : null,
    stdout: p ? undefined : r.stdout,
    stderr: r.stderr || undefined,
    argv: r.argv,
    error: r.error || (p && p.is_error ? String(p.result) : undefined),
  };
}

function probe(cfg) {
  const v = spawnSync(cfg.claudePath, ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const h = spawnSync(cfg.claudePath, ['--help'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const help = (h.stdout || '') + (h.stderr || '');
  return {
    ok: v.status === 0,
    claudePath: cfg.claudePath,
    error: (v.error && String(v.error.message || v.error)) || undefined,
    version: (v.stdout || '').trim(),
    loggedIn: !/Not logged in/i.test(help),
    flags: ['--print', '--output-format', '--resume', '--continue', '--json-schema'].map(function (f) {
      return f + ':' + (help.indexOf(f) >= 0 ? 'yes' : 'no');
    }),
    port: cfg.port,
  };
}

function readBody(req) {
  return new Promise(function (resolve) {
    let body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        resolve({ __parseError: err.message });
      }
    });
  });
}

function send(res, code, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function startServer(cfg) {
  const server = http.createServer(async function (req, res) {
    const p = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && (p === '/health' || p === '/' || p === '/probe')) return send(res, 200, probe(cfg));
    if (req.method !== 'POST') return send(res, 405, { status: 'error', error: '只接受 GET /health、GET /probe 与 POST' });
    const body = await readBody(req);
    if (body.__parseError) return send(res, 400, { status: 'error', error: 'JSON 解析失败：' + body.__parseError });
    const routes = { '/run': beginRun, '/start': beginRun, '/claude': beginRun, '/resume': resumeRun };
    const handler = routes[p];
    if (!handler) return send(res, 404, { status: 'error', error: '未知路径 ' + p + '（可用 /run /resume /claude /start）' });
    log(p + ' <- ' + (body.prompt ? String(body.prompt).slice(0, 60).replace(/\s+/g, ' ') : '(无 prompt)'));
    try {
      const out = await handler(cfg, body);
      log(p + ' -> ' + out.status + (out.sessionId ? ' session=' + out.sessionId : ''));
      send(res, out.status === 'error' ? 500 : 200, out);
    } catch (err) {
      send(res, 500, { status: 'error', error: String(err && err.message || err) });
    }
  });
  server.listen(cfg.port, cfg.host, function () {
    log('HTTP listening on http://' + cfg.host + ':' + cfg.port);
  });
  return server;
}

function watchMailbox(cfg) {
  let busy = false;
  return setInterval(async function () {
    if (busy) return;
    busy = true;
    try {
      const files = fs.readdirSync(INBOX).filter(function (f) { return f.endsWith('.json'); });
      for (const f of files) {
        const full = path.join(INBOX, f);
        const id = path.basename(f, '.json');
        let req;
        try {
          req = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch (err) {
          fs.renameSync(full, path.join(QUARANTINE, f));
          fs.writeFileSync(path.join(QUARANTINE, id + '.error.txt'), 'JSON 解析失败：' + err.message, 'utf8');
          continue;
        }
        fs.renameSync(full, path.join(QUARANTINE, id + '.taken.json'));
        const op = req.op || 'run';
        const handler = op === 'resume' ? resumeRun : op === 'probe' ? function () { return Promise.resolve(probe(cfg)); } : beginRun;
        log('mailbox ' + id + ' op=' + op);
        const out = await handler(cfg, req);
        fs.writeFileSync(path.join(RESULTS, id + '.json'), JSON.stringify(Object.assign({ id: id, op: op, finishedAt: new Date().toISOString() }, out), null, 2), 'utf8');
        log('mailbox ' + id + ' -> ' + out.status);
      }
    } catch (err) {
      log('mailbox 轮询出错：' + String(err && err.message || err));
    } finally {
      busy = false;
    }
  }, cfg.pollMs);
}

function main() {
  const i = process.argv.indexOf('--config');
  const cfg = loadConfig(i > 0 ? process.argv[i + 1] : null);
  log('=== claude-bridge start  pid=' + process.pid + ' node=' + process.version + ' ===');
  log('claudePath=' + cfg.claudePath);
  const pr = probe(cfg);
  log('probe: ' + (pr.ok ? pr.version : '不可用 ' + (pr.error || '')));
  startServer(cfg);
  watchMailbox(cfg);
  log('mailbox watching ' + INBOX);
}

main();