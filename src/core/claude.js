'use strict';
// Gọi Claude đang cài trên máy (Claude Code CLI, đăng nhập bằng tài khoản Claude Pro/Max — không cần API key).
// Chạy ở chế độ không tương tác: `claude -p --output-format json`, prompt đưa qua stdin.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractJson, ensureDir } = require('./util');

const IS_WIN = process.platform === 'win32';

// Tìm lệnh claude: đường dẫn trong Cài đặt > nơi cài mặc định > PATH.
function resolveClaude(custom) {
  if (custom && fs.existsSync(custom)) return custom;
  const home = os.homedir();
  const candidates = IS_WIN
    ? [path.join(home, '.local', 'bin', 'claude.exe'), path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'), path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd')]
    : [path.join(home, '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  try {
    const out = execFileSync(IS_WIN ? 'where' : 'which', ['claude'], { encoding: 'utf8' }).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const exe = out.find((s) => /\.exe$/i.test(s)) || out.find((s) => /\.cmd$/i.test(s)) || out[0];
    if (exe) return exe;
  } catch { /* không có trong PATH */ }
  return null;
}

class ClaudeRunner {
  constructor(opts) {
    this.opts = opts; // { getSettings: () => settings, workDir }
    this.active = new Set();
  }

  settings() {
    return this.opts.getSettings();
  }

  binary() {
    return resolveClaude(this.settings().claudePath);
  }

  // Chạy một lượt Claude, trả về văn bản kết quả.
  run(prompt, { tools = [], timeoutMs = 15 * 60 * 1000, onProgress } = {}) {
    const bin = this.binary();
    if (!bin) {
      return Promise.reject(new Error('Không tìm thấy Claude trên máy. Cài Claude Code (https://claude.com/claude-code), mở Terminal gõ `claude` để đăng nhập một lần, rồi bấm "Kiểm tra" trong Cài đặt.'));
    }
    const s = this.settings();
    const args = ['-p', '--output-format', 'json', '--permission-mode', 'dontAsk'];
    if (tools.length) args.push('--allowedTools', tools.join(','));
    if (s.claudeModel) args.push('--model', s.claudeModel);
    // Thư mục làm việc riêng, trống: Claude không đọc nhầm file/CLAUDE.md của nơi khác.
    const cwd = ensureDir(this.opts.workDir);
    const useShell = IS_WIN && /\.(cmd|bat)$/i.test(bin);

    return new Promise((resolve, reject) => {
      const child = spawn(useShell ? `"${bin}"` : bin, args, { cwd, shell: useShell, windowsHide: true, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'h2-video-studio' } });
      this.active.add(child);
      let out = '', err = '';
      const started = Date.now();
      const tick = setInterval(() => onProgress && onProgress({ seconds: Math.round((Date.now() - started) / 1000) }), 2000);
      const timer = setTimeout(() => { child.kill(); reject(new Error('Claude chạy quá lâu, đã dừng.')); }, timeoutMs);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => { clearTimeout(timer); clearInterval(tick); this.active.delete(child); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer); clearInterval(tick); this.active.delete(child);
        let payload = null;
        try { payload = JSON.parse(out); } catch { /* không phải JSON */ }
        if (payload && typeof payload.result === 'string') {
          if (payload.is_error) return reject(new Error('Claude báo lỗi: ' + payload.result.slice(0, 400)));
          return resolve({ text: payload.result, cost: payload.total_cost_usd || 0 });
        }
        if (code !== 0) return reject(new Error((err || out || 'Claude thoát với mã ' + code).slice(0, 600)));
        resolve({ text: out, cost: 0 });
      });
      child.stdin.end(prompt, 'utf8');
    });
  }

  // Chạy và đọc JSON; nếu Claude trả JSON lỗi thì nhờ Claude sửa lại một lần.
  async runJson(prompt, opts = {}) {
    const first = await this.run(prompt, opts);
    try {
      return extractJson(first.text);
    } catch {
      const fix = await this.run(
        'The following text was supposed to be ONE valid JSON value but it is not parseable. Return ONLY the corrected JSON, no commentary, no code fences.\n\n' + first.text.slice(0, 60000),
        { timeoutMs: 5 * 60 * 1000 }
      );
      return extractJson(fix.text);
    }
  }

  async test() {
    const bin = this.binary();
    if (!bin) return { ok: false, message: 'Chưa tìm thấy lệnh claude trên máy.' };
    let version = '';
    try {
      version = execFileSync(bin, ['--version'], { encoding: 'utf8', shell: IS_WIN && /\.(cmd|bat)$/i.test(bin), timeout: 20000 }).trim();
    } catch (e) {
      return { ok: false, message: 'Có file claude nhưng không chạy được: ' + e.message };
    }
    try {
      const r = await this.run('Reply with exactly: OK', { timeoutMs: 120000 });
      return { ok: /ok/i.test(r.text), message: `Claude ${version} sẵn sàng (${bin}).`, path: bin };
    } catch (e) {
      return { ok: false, message: `Tìm thấy Claude ${version} nhưng chưa chạy được: ${e.message}. Mở Terminal, gõ "claude" và đăng nhập một lần.` };
    }
  }

  cancelAll() {
    for (const c of this.active) { try { c.kill(); } catch { /* bỏ qua */ } }
    this.active.clear();
  }
}

module.exports = { ClaudeRunner, resolveClaude };
