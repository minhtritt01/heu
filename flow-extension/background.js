// HÊU Flow Helper — chạy nền trong Chrome.
// Vòng lặp: chào HÊU → hỏi việc → làm trên tab Google Flow → gửi file về HÊU.
importScripts('flow-page.js');

const DEF = { host: 'http://127.0.0.1:47321', key: '' };
let cfg = { ...DEF };
let looping = false;
let busy = false;
const state = { connected: false, flowTab: false, flowUrl: null, note: 'Đang khởi động…', lastJob: null, lastError: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadCfg() {
  const s = await chrome.storage.local.get(['host', 'key']);
  cfg = { host: (s.host || DEF.host).replace(/\/+$/, ''), key: (s.key || '').trim().toUpperCase() };
}

async function api(path, opts = {}) {
  const res = await fetch(cfg.host + path, { ...opts, headers: { 'X-HEU-Key': cfg.key, ...(opts.headers || {}) } });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { text }; }
  if (!res.ok) throw new Error(data.error || ('HÊU trả lỗi ' + res.status));
  return data;
}
const postJson = (path, obj) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

async function findFlowTab() {
  const tabs = await chrome.tabs.query({});
  const proj = tabs.filter((t) => /^https:\/\/(flow\.google\.com|labs\.google\/fx\/([a-z-]+\/)?tools\/flow)\/project\//.test(t.url || ''));
  return proj.find((t) => t.active) || proj[0] || null;
}

async function exec(tabId, func, args = []) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
  return r ? r.result : null;
}

// Cú bấm "thật" qua Chrome DevTools Protocol — Flow bỏ qua cú bấm giả bằng script.
async function realClick(tabId, x, y, hoverOnly = false) {
  const target = { tabId };
  try { await chrome.debugger.attach(target, '1.3'); } catch (e) {
    if (!/already attached/i.test(e.message)) throw Object.assign(new Error('Không điều khiển được tab Flow (hãy đóng DevTools/F12 của tab đó): ' + e.message), { retryable: true });
  }
  try {
    const send = (type, extra = {}) => chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
    await send('mouseMoved', { button: 'none' });
    if (!hoverOnly) {
      await sleep(80);
      await send('mousePressed');
      await sleep(60);
      await send('mouseReleased');
    }
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

function extOf(type, url) {
  if (/mp4/.test(type)) return 'mp4';
  if (/webm/.test(type)) return 'webm';
  if (/png/.test(type)) return 'png';
  if (/webp/.test(type)) return 'webp';
  if (/jpe?g/.test(type)) return 'jpg';
  return /\/video\//.test(url) ? 'mp4' : 'jpg';
}

async function runJob(job, tab) {
  state.lastJob = job.id;
  const progress = async (p) => {
    state.note = p;
    const r = await postJson('/bridge/progress?id=' + job.id, { progress: p }).catch(() => ({}));
    if (r.cancelled) throw Object.assign(new Error('Đã hủy'), { cancelled: true });
  };
  await progress('Chuẩn bị trang Flow');
  await chrome.tabs.update(tab.id, { active: true });
  await sleep(600);

  const prep = await exec(tab.id, heuPrepare, [job]);
  if (!prep || !prep.ok) throw new Error((prep && prep.error) || 'Không chuẩn bị được trang Flow');
  await progress(`Bấm Tạo · ${job.flowModel || job.kind}${prep.credits != null ? ' · ' + prep.credits + ' credit' : ''}`);
  await realClick(tab.id, prep.btn.x, prep.btn.y);

  const head = String(job.prompt).slice(0, 40);
  const t0 = Date.now();
  const limit = (job.kind === 'video' ? 15 : 5) * 60 * 1000;
  let hovered = 0;
  let noStart = 0;
  for (;;) {
    await sleep(3000);
    if (Date.now() - t0 > limit) throw Object.assign(new Error('Quá thời gian chờ Flow tạo xong'), { retryable: true });
    const c = await exec(tab.id, heuCheck, [prep.seen, job.kind, head]);
    if (!c) continue;
    if (c.state === 'failed') throw new Error(c.error || 'Flow báo lỗi');
    if (c.state === 'needHover') {
      if (hovered++ > 4) throw new Error('Video đã xong nhưng không lấy được link tải. Mở “Dò giao diện” trong tiện ích và gửi kết quả cho người hỗ trợ.');
      await realClick(tab.id, c.x, c.y, true);
      continue;
    }
    if (c.state === 'done') {
      await progress('Tải file từ Flow');
      // Link flow-content.google đã ký sẵn → tải thẳng, không cần cookie
      let res = await fetch(c.url).catch(() => null);
      if (!res || !res.ok) res = await fetch(c.url, { credentials: 'include' });
      if (!res.ok) throw Object.assign(new Error('Tải file từ Flow lỗi ' + res.status), { retryable: true });
      const type = res.headers.get('content-type') || '';
      const blob = await res.blob();
      await progress('Gửi file về HÊU (' + Math.round(blob.size / 1024) + ' KB)');
      await api(`/bridge/upload?id=${job.id}&ext=${extOf(type, c.url)}&mediaId=${encodeURIComponent(c.mediaId || '')}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
      state.note = 'Xong ' + job.id;
      return;
    }
    // Nút Tạo chưa ăn (prompt vẫn còn nguyên, chưa có ô mới) → bấm lại 1 lần
    if (c.promptLeft && !c.progress && ++noStart === 3) {
      await progress('Bấm Tạo lại');
      const again = await exec(tab.id, heuPrepare, [job]);
      if (again && again.ok) await realClick(tab.id, again.btn.x, again.btn.y);
    } else if (c.promptLeft && !c.progress && noStart > 8) {
      throw Object.assign(new Error('Flow không bắt đầu tạo. Có thể Google đang hỏi xác minh — mở tab Flow và kiểm tra.'), { retryable: true });
    }
    await progress(`Flow đang tạo ${c.progress || ''} · ${Math.round((Date.now() - t0) / 1000)}s`);
  }
}

async function loop() {
  if (looping) return;
  looping = true;
  try {
    for (;;) {
      await loadCfg();
      if (!cfg.key) { state.connected = false; state.note = 'Chưa nhập mã ghép nối (bấm biểu tượng tiện ích)'; await sleep(3000); continue; }
      const tab = await findFlowTab();
      state.flowTab = !!tab;
      state.flowUrl = tab ? tab.url : null;
      try {
        await postJson('/bridge/hello', { version: chrome.runtime.getManifest().version, flowTab: !!tab, flowUrl: state.flowUrl, busy, note: state.note });
        state.connected = true;
      } catch (e) {
        state.connected = false;
        state.note = /Failed to fetch/i.test(e.message) ? 'Không thấy app HÊU — hãy mở HÊU trên máy này' : e.message;
        await sleep(4000);
        continue;
      }
      if (!tab) { state.note = 'Đã nối HÊU. Hãy mở một dự án trong Google Flow.'; await sleep(2500); continue; }
      if (!busy) {
        const { job } = await api('/bridge/next').catch(() => ({ job: null }));
        if (job) {
          busy = true;
          try { await runJob(job, tab); state.lastError = null; } catch (e) {
            state.lastError = e.message;
            if (!e.cancelled) await postJson('/bridge/error?id=' + job.id, { message: e.message, retryable: !!e.retryable }).catch(() => {});
          } finally { busy = false; }
          continue;
        }
        state.note = 'Sẵn sàng — chờ việc từ HÊU';
      }
      await sleep(2000);
    }
  } finally {
    looping = false;
  }
}

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  (async () => {
    if (msg.type === 'status') return reply({ ...state, busy, host: cfg.host, hasKey: !!cfg.key });
    if (msg.type === 'save') { await chrome.storage.local.set({ host: msg.host || DEF.host, key: msg.key || '' }); await loadCfg(); loop(); return reply({ ok: true }); }
    if (msg.type === 'diag') {
      const tab = await findFlowTab();
      if (!tab) return reply({ error: 'Chưa mở dự án Google Flow nào' });
      return reply(await exec(tab.id, heuDiagnose));
    }
    reply({});
  })();
  return true;
});

chrome.alarms.create('heu-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => loop());
chrome.runtime.onStartup.addListener(() => loop());
chrome.runtime.onInstalled.addListener(() => loop());
loop();
