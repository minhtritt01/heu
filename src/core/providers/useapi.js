'use strict';
// Kết nối Veo 3.1 / Omni Flash / Nano Banana (Google Flow) và Meta Muse qua useapi.net.
// Mỗi bên có API token riêng: veoToken cho Google Flow (Veo 3.1, Omni Flash, ảnh Nano Banana/Imagen),
// museToken cho Meta Muse. Chỉ cần nhập token của bên bạn dùng. (useapiToken cũ vẫn được dùng làm dự phòng.)
// Video tốn credit của tài khoản Google Flow / Muse của bạn.
// Tài liệu: https://useapi.net/docs/api-google-flow-v1  ·  https://useapi.net/docs/api-muse-v1
const fs = require('fs');
const { mimeOf, deepFind, sleep } = require('../util');

const BASE = 'https://api.useapi.net/v1';

const PROVIDER_NAME = { flow: 'Veo 3 (Google Flow)', muse: 'Meta Muse' };

// Token của từng nhà cung cấp. Bản cũ chỉ có 1 ô useapiToken → dùng làm dự phòng cho cả hai.
function providerToken(settings, provider) {
  const s = settings || {};
  const own = provider === 'muse' ? s.museToken : s.veoToken;
  // Dọn token dán nhầm: khoảng trắng/xuống dòng, dấu ngoặc, chữ "Bearer " ở đầu
  return String(own || s.useapiToken || '').replace(/\s+/g, '').replace(/^["'`]+|["'`]+$/g, '').replace(/^Bearer/i, '');
}
function hasProviderToken(settings, provider) {
  // Chế độ "Tiện ích Chrome": Veo 3 chạy qua tài khoản Flow đang đăng nhập trong Chrome, không cần token
  if (provider === 'flow' && settings && settings.veoMode === 'extension') return true;
  return !!providerToken(settings, provider);
}

class ApiError extends Error {
  constructor(message, status, body, provider) {
    super(message);
    this.status = status;
    this.body = body;
    this.provider = provider || null;
    // 503 "glitched", 429 bận, 5xx lỗi mạng → thử lại được; 403/422 là bị từ chối nội dung → phải sửa prompt.
    this.retryable = status === 429 || status === 503 || status === 502 || status === 500 || status === 504 || status === 0;
  }
}

class UseApi {
  constructor(getSettings, fetchImpl) {
    this.getSettings = getSettings;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
  }

  token(provider = 'flow') {
    const t = providerToken(this.getSettings(), provider);
    if (!t) {
      const where = provider === 'muse' ? 'ô “API Meta Muse”' : 'ô “API Veo 3”';
      throw new ApiError(`Chưa nhập API ${PROVIDER_NAME[provider]}. Vào Cài đặt → ${where} để nhập.`, 401, null, provider);
    }
    return t;
  }

  async req(method, path, { json, body, contentType, raw } = {}) {
    const provider = path.startsWith('/muse') ? 'muse' : 'flow';
    const headers = { Authorization: 'Bearer ' + this.token(provider) };
    let payload = body;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(json); }
    else if (contentType) headers['Content-Type'] = contentType;
    let res;
    try {
      res = await this.fetch(BASE + path, { method, headers, body: payload });
    } catch (e) {
      throw new ApiError('Mất kết nối tới useapi.net: ' + e.message, 0, null, provider);
    }
    if (raw && res.ok) return res;
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = { text }; }
    if (!res.ok && res.status !== 201 && res.status !== 202) {
      const msg = (data && (data.error && (data.error.message || data.error)) ) || text || res.statusText;
      throw new ApiError(`${PROVIDER_NAME[provider]} ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`.slice(0, 500), res.status, data, provider);
    }
    return data;
  }

  // ---------------- Google Flow (Veo 3.1, Omni Flash, ảnh) ----------------
  flowEmail() {
    return (this.getSettings().flowEmail || '').trim();
  }

  async flowUpload(file) {
    const email = this.flowEmail();
    const path = '/google-flow/assets' + (email ? '/' + encodeURIComponent(email) : '');
    const data = await this.req('POST', path, { body: fs.readFileSync(file), contentType: mimeOf(file) });
    const id = data && data.mediaGenerationId && (data.mediaGenerationId.mediaGenerationId || data.mediaGenerationId);
    if (!id || typeof id !== 'string') throw new ApiError('Upload ảnh lên Flow không trả về mã ảnh.', 500, data);
    return id;
  }

  // Tạo video. refs/startImage là mã đã upload (mediaGenerationId).
  async flowCreateVideo({ prompt, model, aspect, duration, startImage, endImage, refs = [] }) {
    const body = {
      prompt,
      model,
      aspectRatio: aspect === '9:16' ? 'portrait' : 'landscape',
      duration: Number(duration) || 8,
      async: true
    };
    const email = this.flowEmail();
    if (email && !startImage && !refs.length) body.email = email;
    if (startImage) body.startImage = startImage;
    if (endImage && startImage) body.endImage = endImage;
    if (!startImage) refs.forEach((r, i) => { body['referenceImage_' + (i + 1)] = r; });
    const data = await this.req('POST', '/google-flow/videos', { json: body });
    if (!data.jobid && !data.jobId) throw new ApiError('Flow không trả về jobid', 500, data);
    return data.jobid || data.jobId;
  }

  async flowJob(jobid) {
    const data = await this.req('GET', '/google-flow/jobs/' + encodeURIComponent(jobid));
    const status = data.status;
    if (status === 'completed') {
      const media = (data.response && data.response.media) || [];
      const urls = media.map((m) => m.videoUrl).filter(Boolean);
      return { done: true, urls, mediaIds: media.map((m) => m.mediaGenerationId).filter(Boolean), credits: data.response && data.response.remainingCredits, raw: data };
    }
    if (status === 'failed' || status === 'error') {
      const code = (data.error && data.error.code) || data.code || 500;
      throw new ApiError('Flow báo lỗi: ' + JSON.stringify(data.error || data.response || data).slice(0, 400), Number(code) || 500, data);
    }
    return { done: false, status };
  }

  async flowCreateImage({ prompt, model, aspect, refs = [], count = 1 }) {
    const body = { prompt, model, aspectRatio: aspect === '9:16' ? 'portrait' : aspect === '1:1' ? 'square' : 'landscape', count };
    const email = this.flowEmail();
    if (email && !refs.length) body.email = email;
    refs.forEach((r, i) => { body['reference_' + (i + 1)] = r; });
    const data = await this.req('POST', '/google-flow/images', { json: body });
    // Ảnh trả về dạng URL ký sẵn hoặc base64 — tìm cả hai.
    const urls = deepFind(data, (s) => /^https?:\/\//.test(s) && !/useapi\.net\/docs/.test(s));
    const b64 = deepFind(data, (s) => s.length > 2000 && /^[A-Za-z0-9+/=]+$/.test(s.slice(0, 200)));
    return { urls, base64: b64, raw: data };
  }

  // ---------------- Meta Muse ----------------
  museEmail() {
    return (this.getSettings().museEmail || '').trim();
  }

  async museUpload(file) {
    const email = this.museEmail();
    const q = email ? '?email=' + encodeURIComponent(email) : '';
    const data = await this.req('POST', '/muse/assets' + q, { body: fs.readFileSync(file), contentType: mimeOf(file) });
    if (!data.assetId) throw new ApiError('Upload lên Muse không trả về assetId', 500, data);
    return data.assetId;
  }

  async museCreate(kind, { prompt, images = [], videos = [] }) {
    const body = { prompt, async: true };
    images.slice(0, 9).forEach((a, i) => { body['image_' + (i + 1)] = a; });
    videos.slice(0, 3).forEach((a, i) => { body['video_' + (i + 1)] = a; });
    const email = this.museEmail();
    if (email && !images.length && !videos.length) body.email = email;
    const data = await this.req('POST', '/muse/jobs/' + (kind === 'image' ? 'image' : 'video'), { json: body });
    if (!data.jobid) throw new ApiError('Muse không trả về jobid', 500, data);
    if (data.status === 'completed') return { jobid: data.jobid, immediate: data };
    return { jobid: data.jobid };
  }

  async museJob(jobid) {
    const data = await this.req('GET', '/muse/jobs/' + encodeURIComponent(jobid));
    if (data.status === 'completed') {
      const assets = (data.result && data.result.assets) || [];
      return { done: true, assetIds: assets.map((a) => a.assetId).filter(Boolean), text: data.result && data.result.text, raw: data };
    }
    if (data.status === 'failed' || data.error) {
      const code = (data.error && data.error.code) || data.code || 500;
      throw new ApiError('Muse báo lỗi: ' + JSON.stringify(data.error || data).slice(0, 400), Number(code) || 500, data);
    }
    return { done: false, status: data.status };
  }

  async museDownload(assetId, dest) {
    const res = await this.req('GET', '/muse/assets/' + encodeURIComponent(assetId), { raw: true });
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return dest;
  }

  async museAccount() {
    const email = this.museEmail();
    if (!email) return null;
    return this.req('GET', '/muse/accounts/' + encodeURIComponent(email));
  }

  async flowAccounts() {
    return this.req('GET', '/google-flow/accounts');
  }

  // Tải file từ URL ký sẵn (không cần token).
  async downloadUrl(url, dest) {
    let res;
    try { res = await this.fetch(url); } catch (e) { throw new ApiError('Không tải được file: ' + e.message, 0); }
    if (!res.ok) throw new ApiError('Tải file lỗi ' + res.status, res.status);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return dest;
  }

  // Chờ job xong (poll mỗi 10 giây).
  async waitFlow(jobid, { onTick, timeoutMs = 20 * 60 * 1000, isCancelled } = {}) {
    const t0 = Date.now();
    for (;;) {
      if (isCancelled && isCancelled()) throw new ApiError('Đã hủy', 499);
      const r = await this.flowJob(jobid);
      if (r.done) return r;
      onTick && onTick(r.status, Date.now() - t0);
      if (Date.now() - t0 > timeoutMs) throw new ApiError('Quá thời gian chờ Flow', 504);
      await sleep(10000);
    }
  }

  async waitMuse(jobid, { onTick, timeoutMs = 20 * 60 * 1000, isCancelled } = {}) {
    const t0 = Date.now();
    for (;;) {
      if (isCancelled && isCancelled()) throw new ApiError('Đã hủy', 499);
      const r = await this.museJob(jobid);
      if (r.done) return r;
      onTick && onTick(r.status, Date.now() - t0);
      if (Date.now() - t0 > timeoutMs) throw new ApiError('Quá thời gian chờ Muse', 504);
      await sleep(10000);
    }
  }
}

module.exports = { UseApi, ApiError, providerToken, hasProviderToken, PROVIDER_NAME };
