'use strict';
// CẦU NỐI TIỆN ÍCH CHROME (chế độ "Tiện ích Chrome" cho Veo 3 / ảnh Flow)
// HÊU mở một máy chủ nhỏ chỉ nghe trên 127.0.0.1. Tiện ích "HÊU Flow Helper" trong Chrome hỏi việc ở đây,
// tự dán prompt vào trang Google Flow mà bạn đang đăng nhập, bấm Tạo như người dùng, chờ kết quả,
// rồi gửi file video/ảnh về lại HÊU. Không dùng token, không gọi API ẩn của Google.
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const EventEmitter = require('events');

// Tên model hiển thị trong menu của Flow (đã đối chiếu giao diện Flow 11/2026)
const FLOW_LABELS = {
  'veo-3.1-fast': 'Veo 3.1 - Fast',
  'veo-3.1-lite': 'Veo 3.1 - Lite',
  'veo-3.1-quality': 'Veo 3.1 - Quality',
  'omni-flash': 'Omni 1.1 Flash',
  'nano-banana-pro': 'Nano Banana Pro',
  'nano-banana-2': 'Nano Banana 2.1',
  'nano-banana-2-lite': 'Nano Banana 2 Lite',
  'imagen-4': 'Nano Banana 2.1'
};

class FlowBridge extends EventEmitter {
  constructor({ getSettings, version = '1' } = {}) {
    super();
    this.getSettings = getSettings || (() => ({}));
    this.version = version;
    this.jobs = new Map(); // id → job
    this.order = [];
    this.server = null;
    this.port = null;
    this.ext = { lastSeen: 0, version: null, flowTab: false, flowUrl: null, note: null, busy: false };
  }

  key() {
    return String(this.getSettings().flowBridgeKey || '');
  }

  start(port) {
    if (this.server) return Promise.resolve(this.port);
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => this.handle(req, res).catch((e) => this.send(res, 500, { error: e.message })));
      srv.on('error', reject);
      srv.listen(port || 0, '127.0.0.1', () => {
        this.server = srv;
        this.port = srv.address().port;
        resolve(this.port);
      });
    });
  }

  stop() {
    if (this.server) this.server.close();
    this.server = null;
  }

  status() {
    const connected = Date.now() - this.ext.lastSeen < 8000;
    const pending = [...this.jobs.values()].filter((j) => !j.done).length;
    return { running: !!this.server, port: this.port, key: this.key(), connected, ...this.ext, pending };
  }

  isReady() {
    const s = this.status();
    return s.connected && s.flowTab;
  }

  // Giao việc cho tiện ích. Trả về Promise { file } khi tiện ích gửi file về.
  submit({ kind = 'video', model, prompt, aspect = '16:9', dest, label, onProgress, isCancelled, timeoutMs = 15 * 60 * 1000 }) {
    const id = 'j_' + crypto.randomBytes(6).toString('hex');
    return new Promise((resolve, reject) => {
      const job = {
        id, kind, model, flowModel: FLOW_LABELS[model] || null, prompt, aspect, label, dest,
        createdAt: Date.now(), takenAt: null, done: false, onProgress, resolve, reject
      };
      this.jobs.set(id, job);
      this.order.push(id);
      const tick = setInterval(() => {
        if (job.done) return clearInterval(tick);
        if (isCancelled && isCancelled()) return this.finish(job, Object.assign(new Error('Đã hủy'), { status: 499 }));
        const waited = Date.now() - job.createdAt;
        if (!job.takenAt && waited > 60000 && !this.status().connected) {
          return this.finish(job, Object.assign(new Error('Tiện ích HÊU Flow Helper chưa kết nối. Mở Chrome, bật tiện ích và mở một dự án Google Flow (xem Cài đặt → API Veo 3).'), { retryable: true, status: 0 }));
        }
        if (waited > timeoutMs) this.finish(job, Object.assign(new Error('Quá thời gian chờ Flow trong Chrome'), { retryable: true, status: 504 }));
      }, 2000);
      if (tick.unref) tick.unref();
    });
  }

  finish(job, err, value) {
    if (job.done) return;
    job.done = true;
    this.order = this.order.filter((x) => x !== job.id);
    setTimeout(() => this.jobs.delete(job.id), 60000).unref?.();
    if (err) job.reject(err); else job.resolve(value);
  }

  nextJob() {
    for (const id of this.order) {
      const j = this.jobs.get(id);
      if (j && !j.done && !j.takenAt) return j;
    }
    return null;
  }

  send(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(obj === undefined ? '' : JSON.stringify(obj));
  }

  async body(req, limit = 5 * 1024 * 1024) {
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > limit) throw new Error('Dữ liệu quá lớn');
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    // Chỉ nhận yêu cầu từ tiện ích (origin chrome-extension://) hoặc không có origin. Trang web lạ bị chặn.
    const origin = req.headers.origin || '';
    if (origin && !origin.startsWith('chrome-extension://')) return this.send(res, 403, { error: 'origin' });
    if (p === '/bridge/ping') return this.send(res, 200, { app: 'HEU', version: this.version, needKey: true });
    if (!this.key() || req.headers['x-heu-key'] !== this.key()) return this.send(res, 401, { error: 'Sai mã ghép nối. Mở HÊU → Cài đặt → API Veo 3 để lấy mã.' });

    this.ext.lastSeen = Date.now();
    if (req.method === 'POST' && p === '/bridge/hello') {
      const b = JSON.parse((await this.body(req)).toString() || '{}');
      Object.assign(this.ext, { version: b.version || null, flowTab: !!b.flowTab, flowUrl: b.flowUrl || null, note: b.note || null, busy: !!b.busy });
      this.emit('status', this.status());
      return this.send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/bridge/next') {
      const j = this.nextJob();
      if (!j) return this.send(res, 200, { job: null });
      j.takenAt = Date.now();
      j.onProgress && j.onProgress('Chrome đã nhận việc');
      const { id, kind, model, flowModel, prompt, aspect } = j;
      return this.send(res, 200, { job: { id, kind, model, flowModel, prompt, aspect } });
    }
    const id = url.searchParams.get('id');
    const job = id && this.jobs.get(id);
    if (req.method === 'POST' && p === '/bridge/progress') {
      const b = JSON.parse((await this.body(req)).toString() || '{}');
      if (job && !job.done && job.onProgress) job.onProgress(String(b.progress || '').slice(0, 160));
      return this.send(res, 200, { ok: true, cancelled: !job || job.done });
    }
    if (req.method === 'POST' && p === '/bridge/error') {
      const b = JSON.parse((await this.body(req)).toString() || '{}');
      if (job) {
        const msg = String(b.message || 'Lỗi trong Flow');
        const status = /policy|violat|safety|blocked|không phù hợp|guideline/i.test(msg) ? 403 : /credit|quota|limit/i.test(msg) ? 402 : 500;
        this.finish(job, Object.assign(new Error('Flow (Chrome): ' + msg), { status, retryable: !!b.retryable, provider: 'flow', bridge: true }));
      }
      return this.send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/bridge/upload') {
      if (!job) return this.send(res, 404, { error: 'job' });
      const buf = await this.body(req, 800 * 1024 * 1024);
      if (buf.length < 1000) {
        this.finish(job, Object.assign(new Error('File nhận từ Chrome bị rỗng'), { retryable: true }));
        return this.send(res, 400, { error: 'empty' });
      }
      const ext = (url.searchParams.get('ext') || '').replace(/[^a-z0-9]/gi, '').slice(0, 5);
      let dest = job.dest;
      if (ext && !dest.endsWith('.' + ext)) dest = dest.replace(/\.[a-z0-9]+$/i, '') + '.' + ext;
      fs.writeFileSync(dest, buf);
      this.finish(job, null, { file: dest, mediaId: url.searchParams.get('mediaId') || null });
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, { error: 'not found' });
  }
}

function newBridgeKey() {
  return crypto.randomBytes(4).toString('hex').toUpperCase().replace(/(.{4})/, '$1-');
}

module.exports = { FlowBridge, FLOW_LABELS, newBridgeKey };
