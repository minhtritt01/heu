'use strict';
// HÀNG ĐỢI RENDER: chạy song song có giới hạn, tự thử lại khi lỗi tạm thời, nối khung cuối → khung đầu
// giữa các cảnh, nhớ ảnh đã upload, và chạy tiếp các job đang dở khi mở lại app.
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { ensureDir, readJson, writeJson, uid, fileHash, sleep } = require('./util');
const { videoModel, IMAGE_MODELS } = require('./models');
const { hasProviderToken } = require('./providers/useapi');

const ACTIVE = ['uploading', 'running', 'downloading', 'preparing'];

class RenderQueue extends EventEmitter {
  constructor({ workspace, api, media, store, getSettings, bridge }) {
    super();
    this.api = api;
    this.bridge = bridge || null;
    this.media = media;
    this.store = store;
    this.getSettings = getSettings;
    this.setWorkspace(workspace);
    this.paused = false;
    this.running = new Set();
    this.cancelled = new Set();
  }

  setWorkspace(workspace) {
    this.workspace = workspace;
    this.file = path.join(workspace, 'queue.json');
    this.cacheFile = path.join(workspace, 'upload-cache.json');
    this.quickDir = ensureDir(path.join(workspace, 'quick'));
    this.tasks = readJson(this.file, []);
    this.cache = readJson(this.cacheFile, {});
    // job đang chạy dở lúc tắt app: nếu đã có jobid thì poll tiếp, chưa có thì xếp lại hàng
    for (const t of this.tasks) {
      if (ACTIVE.includes(t.status)) { t.status = 'queued'; t.progress = 'Chạy tiếp sau khi mở lại app'; }
    }
  }

  persist() {
    const keep = this.tasks.slice(-800);
    this.tasks = keep;
    writeJson(this.file, keep);
  }

  stats() {
    const c = (st) => this.tasks.filter((t) => st.includes(t.status)).length;
    return { total: this.tasks.length, queued: c(['queued', 'waiting']), running: c(ACTIVE), done: c(['done']), failed: c(['failed']), paused: this.paused };
  }

  list() {
    return this.tasks.slice().reverse();
  }

  emitUpdate(t) {
    this.emit('update', t);
    this.emit('stats', this.stats());
  }

  set(t, patch) {
    Object.assign(t, patch);
    this.persist();
    this.emitUpdate(t);
  }

  // ---- thêm việc ----
  add(spec) {
    // Chỉ đòi API của đúng nhà cung cấp mà model này dùng (Veo → API Veo 3, Muse → API Muse).
    const pv = providerOf({ kind: spec.kind || 'video', model: spec.model });
    if (!hasProviderToken(this.getSettings(), pv)) {
      const label = (spec.kind === 'image' ? IMAGE_MODELS[spec.model] : videoModel(spec.model)) || {};
      throw Object.assign(new Error(pv === 'muse'
        ? `Model ${label.label || 'Meta Muse'} cần API Meta Muse. Vào Cài đặt → “API Meta Muse” để nhập (không cần nhập API Veo 3).`
        : `Model ${label.label || 'Veo 3'} cần API Veo 3 (Google Flow). Vào Cài đặt → “API Veo 3” để nhập (không cần nhập API Muse).`), { code: 'NO_KEY', provider: pv });
    }
    const t = {
      id: uid('t_'),
      kind: spec.kind || 'video',
      projectId: spec.projectId || null,
      sceneId: spec.sceneId || null,
      target: spec.target || null, // ảnh tham chiếu: {type:'character'|'location', id}
      label: spec.label || (spec.sceneId ? spec.sceneId : 'Video nhanh'),
      model: spec.model,
      prompt: spec.prompt,
      aspect: spec.aspect || '16:9',
      duration: spec.duration || 8,
      refs: spec.refs || [],
      startFrameFile: spec.startFrameFile || null,
      dependsOn: spec.dependsOn || null,
      status: spec.dependsOn ? 'waiting' : 'queued',
      progress: spec.dependsOn ? 'Chờ cảnh trước xong để lấy khung cuối' : 'Đang chờ',
      attempts: 0,
      createdAt: new Date().toISOString()
    };
    this.tasks.push(t);
    this.persist();
    this.emitUpdate(t);
    this.pump();
    return t;
  }

  pause(v) { this.paused = v; this.emit('stats', this.stats()); if (!v) this.pump(); }

  cancel(id) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.cancelled.add(id);
    if (!ACTIVE.includes(t.status)) this.set(t, { status: 'cancelled', progress: 'Đã hủy' });
  }

  retry(id) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t || ACTIVE.includes(t.status)) return;
    this.cancelled.delete(id);
    this.set(t, { status: t.dependsOn ? 'waiting' : 'queued', error: null, progress: 'Xếp hàng lại', attempts: 0, jobid: null });
    this.pump();
  }

  clearFinished() {
    this.tasks = this.tasks.filter((t) => !['done', 'cancelled'].includes(t.status));
    this.persist();
    this.emit('stats', this.stats());
    this.emit('reset');
  }

  // ---- bộ lập lịch ----
  pump() {
    if (this.paused) return;
    const max = Math.max(1, Number(this.getSettings().maxParallel) || 2);
    // mở khóa task đang chờ cảnh trước
    for (const t of this.tasks.filter((x) => x.status === 'waiting')) {
      const dep = this.tasks.find((x) => x.id === t.dependsOn);
      if (!dep || dep.status === 'done') this.set(t, { status: 'queued', progress: 'Đang chờ' });
      else if (['failed', 'cancelled'].includes(dep.status)) this.set(t, { status: 'failed', error: 'Cảnh trước bị lỗi nên không lấy được khung cuối. Bấm "Thử lại" sau khi render lại cảnh trước, hoặc đổi chế độ nối sang "ảnh tham chiếu".' });
    }
    // Giới hạn riêng từng nhà cung cấp (Muse mặc định 2 job/tài khoản, Flow chịu được nhiều hơn)
    const s = this.getSettings();
    // Chế độ Tiện ích Chrome: một tab Flow làm lần lượt từng việc
    const caps = { flow: s.veoMode === 'extension' ? 1 : Math.max(1, Number(s.maxParallelFlow) || max), muse: Math.max(1, Number(s.maxParallelMuse) || 2) };
    const busy = { flow: 0, muse: 0 };
    for (const id of this.running) {
      const r = this.tasks.find((x) => x.id === id);
      if (r) busy[providerOf(r)]++;
    }
    for (const t of this.tasks) {
      if (this.running.size >= max) break;
      if (t.status !== 'queued' || this.running.has(t.id)) continue;
      const pv = providerOf(t);
      if (busy[pv] >= caps[pv]) continue;
      busy[pv]++;
      this.running.add(t.id);
      this.exec(t).finally(() => { this.running.delete(t.id); this.pump(); });
    }
  }

  isCancelled(t) { return this.cancelled.has(t.id); }

  async exec(t) {
    const retries = Number(this.getSettings().retries ?? 2);
    for (;;) {
      try {
        this.set(t, { status: 'preparing', progress: 'Chuẩn bị', error: null, startedAt: new Date().toISOString() });
        if (t.kind === 'image') await this.runImage(t);
        else await this.runVideo(t);
        this.set(t, { status: 'done', progress: 'Hoàn tất', finishedAt: new Date().toISOString() });
        return;
      } catch (e) {
        if (this.isCancelled(t)) { this.set(t, { status: 'cancelled', progress: 'Đã hủy' }); return; }
        t.attempts++;
        const can = e.retryable && t.attempts <= retries;
        if (!can) {
          this.set(t, { status: 'failed', error: friendlyError(e), progress: 'Thất bại' });
          return;
        }
        const wait = e.status === 429 ? 60000 : 20000 * t.attempts;
        this.set(t, { status: 'preparing', progress: `Lỗi tạm thời, thử lại lần ${t.attempts} sau ${Math.round(wait / 1000)}s`, jobid: null });
        await sleep(wait);
      }
    }
  }

  // ---- upload có nhớ (không upload lại cùng một ảnh) ----
  async upload(provider, file) {
    if (!fs.existsSync(file)) throw Object.assign(new Error('Không tìm thấy ảnh ' + file), { retryable: false });
    const s = this.getSettings();
    const account = provider === 'muse' ? s.museEmail : s.flowEmail;
    const key = `${provider}|${account || ''}|${fileHash(file)}`;
    if (this.cache[key]) return this.cache[key];
    const id = provider === 'muse' ? await this.api.museUpload(file) : await this.api.flowUpload(file);
    this.cache[key] = id;
    writeJson(this.cacheFile, this.cache);
    return id;
  }

  outDir(t) {
    if (t.projectId) return ensureDir(path.join(this.store.projectDir(t.projectId), t.kind === 'image' ? 'refs' : 'videos'));
    return this.quickDir;
  }

  outName(t, ext) {
    const base = (t.sceneId || t.label || 'video').replace(/[^\w-]+/g, '_').slice(0, 40);
    const dir = this.outDir(t);
    let n = 1;
    while (fs.existsSync(path.join(dir, `${base}_v${n}.${ext}`))) n++;
    return path.join(dir, `${base}_v${n}.${ext}`);
  }

  async runVideo(t) {
    const m = videoModel(t.model);
    const opts = { isCancelled: () => this.isCancelled(t), onTick: (st, ms) => this.set(t, { progress: `${m.label}: ${st || 'đang tạo'} · ${Math.round(ms / 1000)}s` }) };

    // Nối mạch: lấy khung cuối của cảnh trước
    if (t.dependsOn && !t.startFrameFile) {
      const dep = this.tasks.find((x) => x.id === t.dependsOn);
      if (dep && dep.output) {
        this.set(t, { progress: 'Lấy khung cuối của cảnh trước' });
        const png = path.join(path.dirname(dep.output), '..', 'frames', path.basename(dep.output, '.mp4') + '_last.png');
        t.startFrameFile = await this.media.lastFrame(dep.output, png);
      }
    }

    this.set(t, { status: 'uploading', progress: 'Tải ảnh tham chiếu lên' });
    let file;
    if (m.provider === 'muse') {
      const images = [];
      if (t.startFrameFile) images.push(await this.upload('muse', t.startFrameFile));
      for (const r of t.refs) images.push(await this.upload('muse', r));
      this.set(t, { status: 'running', progress: 'Gửi lệnh tạo video tới Meta Muse' });
      const job = t.jobid ? { jobid: t.jobid } : await this.api.museCreate('video', { prompt: t.prompt, images });
      this.set(t, { jobid: job.jobid });
      const r = job.immediate && job.immediate.result ? { assetIds: job.immediate.result.assets.map((a) => a.assetId) } : await this.api.waitMuse(job.jobid, opts);
      if (!r.assetIds.length) throw Object.assign(new Error('Muse không trả về video'), { retryable: true });
      this.set(t, { status: 'downloading', progress: 'Tải video về máy' });
      file = await this.api.museDownload(r.assetIds[0], this.outName(t, 'mp4'));
    } else if (this.viaChrome()) {
      file = await this.runViaChrome(t, 'video', m.label, 'mp4');
    } else {
      const startImage = t.startFrameFile ? await this.upload('flow', t.startFrameFile) : null;
      const refs = [];
      if (!startImage) for (const r of t.refs.slice(0, m.maxRefs)) refs.push(await this.upload('flow', r));
      let apiModel = m.apiModel;
      let duration = t.duration;
      if (refs.length && m.maxRefs === 0) refs.length = 0;
      if (refs.length && m.refsNeed8s) duration = 8;
      this.set(t, { status: 'running', progress: `Gửi lệnh tạo video tới ${m.label}` });
      const jobid = t.jobid || await this.api.flowCreateVideo({ prompt: t.prompt, model: apiModel, aspect: t.aspect, duration, startImage, refs });
      this.set(t, { jobid });
      const r = await this.api.waitFlow(jobid, opts);
      if (!r.urls.length) throw Object.assign(new Error('Flow không trả về video'), { retryable: true });
      this.set(t, { status: 'downloading', progress: 'Tải video về máy' });
      file = await this.api.downloadUrl(r.urls[0], this.outName(t, 'mp4'));
      if (r.credits != null) t.creditsLeft = r.credits;
    }
    let thumb = null;
    try { thumb = await this.media.thumbnail(file, file.replace(/\.mp4$/, '.jpg')); } catch { /* không có ffmpeg thì bỏ ảnh nhỏ */ }
    this.set(t, { output: file, thumb });
    if (t.projectId && t.sceneId) {
      this.store.update(t.projectId, (p) => {
        const s = p.script.scenes.find((x) => x.id === t.sceneId);
        if (s) {
          s.takes.push({ file, thumb, taskId: t.id, model: t.model, at: new Date().toISOString() });
          s.selected = file; // bản mới nhất được chọn mặc định
        }
        return p;
      });
      this.emit('project', t.projectId);
    }
  }

  viaChrome() {
    return this.getSettings().veoMode === 'extension' && !!this.bridge;
  }

  // Giao việc cho tiện ích Chrome: tiện ích dán prompt vào Google Flow, bấm Tạo, gửi file về.
  async runViaChrome(t, kind, label, ext) {
    const notes = [];
    if (t.refs && t.refs.length) notes.push('chưa gửi ảnh tham chiếu');
    if (t.startFrameFile) notes.push('chưa gửi khung đầu');
    const note = notes.length ? ` (chế độ Chrome: ${notes.join(', ')})` : '';
    this.set(t, { status: 'running', progress: `Chờ Chrome nhận việc · ${label}${note}` });
    const r = await this.bridge.submit({
      kind, model: t.model, prompt: t.prompt, aspect: t.aspect, label: t.label,
      dest: this.outName(t, ext),
      isCancelled: () => this.isCancelled(t),
      onProgress: (msg) => this.set(t, { progress: `Chrome · ${msg}${note}` })
    });
    this.set(t, { status: 'downloading', progress: 'Đã nhận file từ Chrome' });
    return r.file;
  }

  async runImage(t) {
    const im = IMAGE_MODELS[t.model] || IMAGE_MODELS['nano-banana-pro'];
    this.set(t, { status: 'uploading', progress: 'Chuẩn bị ảnh mẫu' });
    let file;
    if (im.provider === 'muse') {
      const images = [];
      for (const r of t.refs) images.push(await this.upload('muse', r));
      const ar = t.aspect === '9:16' ? '9:16' : t.aspect === '1:1' ? '1:1' : '16:9';
      const prompt = `In exactly ${ar} aspect ratio, ${t.prompt}`;
      this.set(t, { status: 'running', progress: 'Meta Muse đang vẽ' });
      const job = await this.api.museCreate('image', { prompt, images });
      this.set(t, { jobid: job.jobid });
      const r = job.immediate && job.immediate.result ? { assetIds: job.immediate.result.assets.map((a) => a.assetId) } : await this.api.waitMuse(job.jobid, { isCancelled: () => this.isCancelled(t) });
      if (!r.assetIds.length) throw Object.assign(new Error('Muse không trả về ảnh'), { retryable: true });
      const ext = /\.(\w+)$/.exec(r.assetIds[0]);
      file = await this.api.museDownload(r.assetIds[0], this.outName(t, ext ? ext[1] : 'webp'));
    } else if (this.viaChrome()) {
      file = await this.runViaChrome(t, 'image', im.label, 'jpg');
    } else {
      const refs = [];
      for (const r of t.refs.slice(0, im.maxRefs)) refs.push(await this.upload('flow', r));
      this.set(t, { status: 'running', progress: im.label + ' đang vẽ' });
      const r = await this.api.flowCreateImage({ prompt: t.prompt, model: im.apiModel, aspect: t.aspect, refs, count: 1 });
      this.set(t, { status: 'downloading', progress: 'Tải ảnh về' });
      if (r.urls.length) file = await this.api.downloadUrl(r.urls[0], this.outName(t, 'jpg'));
      else if (r.base64.length) { file = this.outName(t, 'png'); fs.writeFileSync(file, Buffer.from(r.base64[0], 'base64')); }
      else throw Object.assign(new Error('Flow không trả về ảnh (có thể bị bộ lọc nội dung chặn). Thử Imagen 4 hoặc sửa prompt.'), { retryable: false });
    }
    this.set(t, { output: file, thumb: file });
    if (t.projectId && t.target) {
      this.store.update(t.projectId, (p) => {
        const list = t.target.type === 'location' ? p.locations : p.characters;
        const item = list.find((x) => x.id === t.target.id);
        if (item && !item.refImages.includes(file)) item.refImages.push(file);
        return p;
      });
      this.emit('project', t.projectId);
    }
  }
}

function providerOf(t) {
  const m = t.kind === 'image' ? IMAGE_MODELS[t.model] : videoModel(t.model);
  return m && m.provider === 'muse' ? 'muse' : 'flow';
}

function friendlyError(e) {
  const s = e.status;
  const msg = e.message || String(e);
  if (e.bridge) {
    if (s === 403) return 'Flow từ chối prompt (bộ lọc nội dung). Sửa câu chữ rồi thử lại. ' + msg;
    if (s === 402) return 'Tài khoản Google Flow không đủ credit cho model này (tài khoản miễn phí thường chỉ tạo được ảnh Nano Banana). ' + msg;
    return msg;
  }
  if (s === 401) {
    if (/^Chưa nhập/.test(msg)) return msg;
    const name = e.provider === 'muse' ? 'Meta Muse' : 'Veo 3';
    return `useapi.net từ chối token ${name} (401). Token sai, đã bị đổi, hoặc dán thiếu ký tự — lấy lại token tại useapi.net, dán vào ô “API ${name}” rồi bấm “Kiểm tra ${name}”. Chi tiết: ${msg}`;
  }
  if (s === 402) return 'Gói useapi.net hết hạn — gia hạn tại useapi.net.';
  if (s === 403 || s === 422) return 'Prompt hoặc ảnh bị bộ lọc nội dung từ chối. Sửa lại câu chữ (tránh bạo lực, người thật, thương hiệu) rồi thử lại. Chi tiết: ' + msg;
  if (s === 412) return 'Tài khoản Muse đã hết hạn mức tuần này. Chờ reset hoặc thêm tài khoản khác. ' + msg;
  if (s === 596) return 'Tài khoản Google/Meta bị đăng xuất hoặc cần xác minh. Đăng nhập lại trên useapi.net. ' + msg;
  return msg;
}

module.exports = { RenderQueue, friendlyError };
