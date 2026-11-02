'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('./src/core/store');
const { ClaudeRunner } = require('./src/core/claude');
const { Studio } = require('./src/core/studio');
const { UseApi, hasProviderToken } = require('./src/core/providers/useapi');
const { FlowBridge, newBridgeKey } = require('./src/core/bridge');
const { Media } = require('./src/core/media');
const { RenderQueue } = require('./src/core/queue');
const { compileScene, lintProject, compileQuick, splitQuickBlocks } = require('./src/core/compiler');
const { referencePrompts } = require('./src/core/brain');
const pricing = require('./src/core/pricing');
const { VIDEO_MODELS, IMAGE_MODELS } = require('./src/core/models');
const { readJson, writeJson, ensureDir, uid } = require('./src/core/util');

const APP_NAME = 'HÊU';
app.setName(APP_NAME);
// Giữ nguyên thư mục cài đặt cũ (token, email…) sau khi đổi tên app
app.setPath('userData', path.join(app.getPath('appData'), 'H2 Video Studio'));
app.setAppUserModelId('vn.heu.h2videostudio');

// ---------- Cài đặt ----------
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS = {
  workspace: path.join(app.getPath('documents'), 'H2VideoStudio'),
  veoToken: '',   // API useapi.net cho Veo 3.1 / Omni Flash / ảnh Nano Banana (Google Flow)
  museToken: '',  // API useapi.net cho Meta Muse
  veoMode: '',    // 'extension' = qua tiện ích Chrome (tài khoản Flow đang đăng nhập) · 'useapi' = token useapi.net
  flowBridgePort: 47321,
  flowBridgeKey: '',
  flowEmail: '',
  museEmail: '',
  claudePath: '',
  claudeModel: '',
  maxParallel: 4,
  maxParallelFlow: 4,
  maxParallelMuse: 2,
  ffmpegPath: '',
  retries: 2,
  defaultModel: 'veo-3.1-fast',
  crossfade: 0,
  plans: pricing.DEFAULT_PLANS,
  rates: pricing.DEFAULT_RATES,
  notify: true
};
let settings = Object.assign({}, DEFAULT_SETTINGS, readJson(SETTINGS_FILE, {}));
settings.rates = Object.assign({}, pricing.DEFAULT_RATES, settings.rates || {});
// Chuyển cài đặt cũ: trước đây 1 ô token dùng chung → tách thành API Veo 3 và API Muse.
if (settings.useapiToken) {
  if (!settings.veoToken && !settings.museToken) {
    if (settings.flowEmail || !settings.museEmail) settings.veoToken = settings.useapiToken;
    if (settings.museEmail) settings.museToken = settings.useapiToken;
    if (!settings.veoToken && !settings.museToken) settings.veoToken = settings.useapiToken;
  }
  delete settings.useapiToken;
  writeJson(SETTINGS_FILE, settings);
}
// Chế độ chạy Veo 3: mặc định dùng tiện ích Chrome nếu chưa có token useapi.net
if (!settings.veoMode) settings.veoMode = settings.veoToken ? 'useapi' : 'extension';
if (!settings.flowBridgeKey) settings.flowBridgeKey = newBridgeKey();
writeJson(SETTINGS_FILE, settings);
const getSettings = () => settings;

// ---------- Dịch vụ ----------
const store = new Store(settings.workspace);
const runner = new ClaudeRunner({ getSettings, workDir: path.join(app.getPath('userData'), 'claude-work') });
const studio = new Studio({ store, runner });
const api = new UseApi(getSettings);
const media = new Media(getSettings, path.join(app.getPath('userData'), 'tools'));
const bridge = new FlowBridge({ getSettings, version: app.getVersion() });
const queue = new RenderQueue({ workspace: settings.workspace, api, media, store, getSettings, bridge });
let bridgeError = null;
function startBridge() {
  bridge.start(Number(settings.flowBridgePort) || 47321).then(() => { bridgeError = null; }).catch((e) => {
    bridgeError = e.code === 'EADDRINUSE' ? `Cổng ${settings.flowBridgePort} đang bị chiếm (có thể HÊU đang mở 2 cửa sổ). Đổi cổng trong Cài đặt.` : e.message;
  });
}
startBridge();
bridge.on('status', (st) => send('bridge:status', { ...st, error: bridgeError }));

let win;
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

queue.on('update', (t) => {
  send('queue:update', t);
  if (settings.notify && Notification.isSupported() && (t.status === 'done' || t.status === 'failed') && win && !win.isFocused()) {
    new Notification({ title: t.status === 'done' ? 'Xong: ' + t.label : 'Lỗi: ' + t.label, body: t.status === 'done' ? 'Video đã tải về máy.' : String(t.error || '').slice(0, 120) }).show();
  }
});
queue.on('stats', (s) => send('queue:stats', s));
queue.on('reset', () => send('queue:reset'));
queue.on('project', (id) => send('project:changed', id));

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700,
    backgroundColor: '#14171a', title: APP_NAME,
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(() => {
  // Cập nhật bản tiện ích Chrome đã chép trước đó (sau khi cập nhật, bấm ↻ ở chrome://extensions)
  try { if (fs.existsSync(path.join(extInstallDir(), 'manifest.json'))) installExtension(); } catch { /* bỏ qua */ }
  createWindow();
  queue.pump();
  setInterval(checkInbox, 3000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { runner.cancelAll(); if (process.platform !== 'darwin') app.quit(); });

// ---------- IPC tiện ích ----------
function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; } catch (e) { return { ok: false, error: e.message || String(e) }; }
  });
}
const progress = (job) => (p) => send('claude:progress', { job, ...p });

// Cài đặt
handle('settings:get', () => ({
  ...settings, appVersion: app.getVersion(), appName: APP_NAME, modelsVideo: VIDEO_MODELS, modelsImage: IMAGE_MODELS,
  system: { ramGB: Math.round(os.totalmem() / 1073741824), cpus: os.cpus().length }
}));
handle('settings:set', (patch) => {
  const oldWs = settings.workspace;
  settings = Object.assign({}, settings, patch);
  writeJson(SETTINGS_FILE, settings);
  if (patch.flowBridgePort !== undefined) { bridge.stop(); startBridge(); }
  if (patch.workspace && patch.workspace !== oldWs) { store.setWorkspace(settings.workspace); queue.setWorkspace(settings.workspace); send('queue:reset'); }
  queue.pump();
  return settings;
});
handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
handle('dialog:file', async (filters) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: filters || [] });
  return r.canceled ? null : r.filePaths[0];
});
handle('shell:open', (p) => shell.openPath(p));

// ---------- Tiện ích Chrome (HÊU Flow Helper) ----------
function extSourceDir() {
  return path.join(__dirname, 'flow-extension').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}
function extInstallDir() {
  return path.join(app.getPath('userData'), 'flow-extension');
}
// Chép tiện ích ra thư mục thật (Chrome không đọc được bên trong app.asar), rồi mở thư mục đó
function installExtension() {
  const src = extSourceDir();
  const dst = ensureDir(extInstallDir());
  for (const f of fs.readdirSync(src)) fs.writeFileSync(path.join(dst, f), fs.readFileSync(path.join(src, f)));
  return dst;
}
handle('bridge:status', () => ({ ...bridge.status(), error: bridgeError, extDir: extInstallDir(), extInstalled: fs.existsSync(path.join(extInstallDir(), 'manifest.json')) }));
handle('bridge:installExt', () => { const d = installExtension(); shell.openPath(d); return d; });
handle('bridge:newKey', () => { settings.flowBridgeKey = newBridgeKey(); writeJson(SETTINGS_FILE, settings); return settings.flowBridgeKey; });
handle('bridge:restart', () => { bridge.stop(); startBridge(); return true; });
handle('shell:reveal', (p) => shell.showItemInFolder(p));
handle('shell:url', (u) => shell.openExternal(u));

// Dự án
handle('projects:list', () => store.list());
handle('projects:create', (name, brief) => store.create(name, { brief: Object.assign({ model: settings.defaultModel }, brief || {}) }));
handle('projects:get', (id) => store.get(id));
// Lưu từ giao diện: các bản render (takes/selected) và ảnh tham chiếu luôn lấy từ ổ đĩa,
// vì hàng đợi có thể vừa ghi thêm trong lúc người dùng đang sửa chữ.
handle('projects:save', (p) => {
  const disk = store.get(p.id);
  for (const s of p.script.scenes) {
    const d = disk.script.scenes.find((x) => x.id === s.id);
    s.takes = d ? d.takes : (s.takes || []);
    s.selected = d ? d.selected : (s.selected || '');
  }
  for (const list of ['characters', 'locations']) {
    for (const it of p[list]) {
      const d = disk[list].find((x) => x.id === it.id);
      if (d) it.refImages = d.refImages;
    }
  }
  return store.save(p);
});
handle('projects:remove', (id) => store.remove(id));
handle('projects:duplicate', (id, name, keep) => store.duplicate(id, name, keep || {}));
handle('trash:list', () => store.listTrash());
handle('trash:restore', (folder) => store.restore(folder));
handle('trash:purge', (folder) => store.purge(folder));
handle('projects:compile', (id) => {
  const p = store.get(id);
  return {
    scenes: p.script.scenes.map((s, i) => ({ id: s.id, ...compileScene(p, s, i) })),
    lint: lintProject(p),
    estimate: pricing.estimateProject(p, { rates: settings.rates })
  };
});

// Claude
handle('claude:test', () => runner.test());
handle('claude:cancel', () => runner.cancelAll());
handle('claude:bible', (id, instr) => studio.buildBible(id, instr, progress('bible')));
handle('claude:script', (id, opts) => studio.writeScript(id, opts || {}, progress('script')));
handle('claude:review', (id) => studio.review(id, progress('review')));
handle('claude:applyReview', (id, idx) => studio.applyReview(id, idx));
handle('claude:rewrite', (id, sceneId, instr) => studio.rewriteScene(id, sceneId, instr, progress('rewrite')));
handle('claude:polish', (id, text, instr) => studio.polishQuick(id || null, splitQuickBlocks(text), instr, progress('polish')).then((arr) => arr.join('\n\n')));
handle('competitor:analyze', async ({ url, notes, transcript }) => {
  let meta = null, tx = transcript || '';
  if (url && !tx) {
    try {
      send('claude:progress', { job: 'competitor', step: 'Đang lấy thông tin và phụ đề video (yt-dlp)…' });
      const r = await media.fetchCompetitor(url, path.join(app.getPath('userData'), 'competitor-tmp'));
      meta = r.meta; tx = r.transcript;
    } catch (e) {
      send('claude:progress', { job: 'competitor', step: 'Không lấy được phụ đề (' + e.message.slice(0, 80) + '), Claude sẽ tự đọc trang.' });
    }
  }
  send('claude:progress', { job: 'competitor', step: 'Claude đang phân tích…' });
  const report = await studio.analyzeCompetitor({ url, meta, transcript: tx, notes }, progress('competitor'));
  const rec = { id: uid('r_'), url, meta, report, at: new Date().toISOString() };
  writeJson(path.join(ensureDir(path.join(settings.workspace, 'competitors')), rec.id + '.json'), rec);
  return rec;
});
handle('competitor:list', () => {
  const dir = ensureDir(path.join(settings.workspace, 'competitors'));
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f), null)).filter(Boolean)
    .map((r) => ({ id: r.id || '', url: r.url, title: (r.report && r.report.title) || (r.meta && r.meta.title) || r.url, at: r.at, report: r.report, meta: r.meta }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
});
handle('competitor:toProject', (rec, ideaIndex) => {
  const rb = Object.assign({}, rec.report.recommendedBrief || {});
  const idea = rec.report.ideas && rec.report.ideas[ideaIndex];
  if (idea) { rb.topic = idea.title + (idea.angle ? ' — ' + idea.angle : ''); rb.notes = 'Hook: ' + (idea.hook || ''); }
  const brief = { model: settings.defaultModel };
  for (const k of ['topic', 'goal', 'genre', 'audience', 'narration', 'aspect', 'targetSeconds', 'dialogueLanguage', 'notes']) if (rb[k]) brief[k] = rb[k];
  const p = store.create(idea ? idea.title : (rb.topic || 'Từ phân tích đối thủ'), { brief, competitor: { url: rec.url, report: rec.report, at: rec.at } });
  if (rb.styleSuggestion) store.update(p.id, (cur) => { cur.style.visualStyle = rb.styleSuggestion; return cur; });
  return p;
});

// Ảnh tham chiếu
handle('refs:prompts', (id, type, itemId) => {
  const p = store.get(id);
  const item = (type === 'location' ? p.locations : p.characters).find((x) => x.id === itemId);
  return referencePrompts(p, item, type);
});
handle('refs:add', async (id, type, itemId) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Ảnh', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
  if (r.canceled) return store.get(id);
  const dir = ensureDir(path.join(store.projectDir(id), 'refs'));
  return store.update(id, (p) => {
    const item = (type === 'location' ? p.locations : p.characters).find((x) => x.id === itemId);
    for (const f of r.filePaths) {
      const dest = path.join(dir, Date.now() + '_' + path.basename(f).replace(/[^\w.-]+/g, '_'));
      fs.copyFileSync(f, dest);
      item.refImages.push(dest);
    }
    return p;
  });
});
handle('refs:remove', (id, type, itemId, file) => store.update(id, (p) => {
  const item = (type === 'location' ? p.locations : p.characters).find((x) => x.id === itemId);
  item.refImages = item.refImages.filter((f) => f !== file);
  return p;
}));
handle('refs:primary', (id, type, itemId, file) => store.update(id, (p) => {
  const item = (type === 'location' ? p.locations : p.characters).find((x) => x.id === itemId);
  item.refImages = [file, ...item.refImages.filter((f) => f !== file)];
  return p;
}));
handle('refs:generate', (id, type, itemId, { prompt, model, aspect, useExisting }) => {
  const p = store.get(id);
  const item = (type === 'location' ? p.locations : p.characters).find((x) => x.id === itemId);
  return queue.add({ kind: 'image', projectId: id, target: { type, id: itemId }, label: 'Ảnh ' + item.name, model: model || 'nano-banana-pro', prompt, aspect: aspect || (type === 'location' ? p.brief.aspect : '16:9'), refs: useExisting ? item.refImages.slice(0, 3) : [] });
});

handle('refs:quickImage', ({ prompt, model, aspect, refFiles }) => queue.add({ kind: 'image', label: 'Ảnh nhanh', model: model || 'nano-banana-pro', prompt, aspect: aspect || '16:9', refs: refFiles || [] }));

// Hàng đợi
handle('queue:list', () => queue.list());
handle('queue:stats', () => queue.stats());
handle('queue:pause', (v) => queue.pause(v));
handle('queue:cancel', (tid) => queue.cancel(tid));
handle('queue:retry', (tid) => queue.retry(tid));
handle('queue:clear', () => queue.clearFinished());
handle('queue:quick', ({ projectId, text, model, aspect, duration, refFiles, startFrame }) => {
  const p = projectId ? store.get(projectId) : null;
  const blocks = splitQuickBlocks(text);
  if (!blocks.length) throw new Error('Chưa có prompt nào.');
  return blocks.map((b, i) => {
    const c = compileQuick(p, b, { model, aspect });
    const refs = [...(refFiles || []), ...c.refs.map((r) => r.file)].slice(0, VIDEO_MODELS[model].maxRefs || 0);
    return queue.add({ projectId: null, label: (p ? p.name + ' · ' : '') + 'Nhanh #' + (i + 1), model, prompt: c.prompt, aspect, duration, refs, startFrameFile: i === 0 ? startFrame || null : null });
  });
});
handle('queue:scenes', (projectId, sceneIds, opts) => enqueueScenes(projectId, sceneIds, opts || {}));

async function enqueueScenes(projectId, sceneIds, { onlyMissing = false, model } = {}) {
  const p = store.get(projectId);
  const modelId = model || p.brief.model;
  const batch = {};
  const added = [];
  for (let i = 0; i < p.script.scenes.length; i++) {
    const s = p.script.scenes[i];
    if (!s.enabled) continue;
    if (sceneIds && !sceneIds.includes(s.id)) continue;
    if (onlyMissing && s.selected && fs.existsSync(s.selected)) continue;
    let c = compileScene(p, s, i, { model: modelId });
    let dependsOn = null, startFrameFile = null;
    if (c.plan.chain) {
      const prev = p.script.scenes[i - 1];
      if (batch[prev.id]) dependsOn = batch[prev.id];
      else if (prev.selected && fs.existsSync(prev.selected)) {
        startFrameFile = await media.lastFrame(prev.selected, path.join(store.projectDir(p.id), 'frames', prev.id + '_last.png'));
      } else {
        c = compileScene(p, s, i, { model: modelId, noChain: true }); // không có cảnh trước → dùng ảnh tham chiếu
      }
    }
    const t = queue.add({ projectId: p.id, sceneId: s.id, label: `${p.name} · ${s.id}${s.title ? ' ' + s.title : ''}`, model: modelId, prompt: c.prompt, aspect: p.brief.aspect, duration: c.duration, refs: c.refs.map((r) => r.file), dependsOn, startFrameFile });
    batch[s.id] = t.id;
    added.push(t);
  }
  return added;
}

// MCP gửi yêu cầu render qua thư mục inbox
function checkInbox() {
  const dir = path.join(settings.workspace, 'inbox');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const file = path.join(dir, f);
    const req = readJson(file, null);
    fs.rmSync(file, { force: true });
    if (req && req.type === 'render') {
      enqueueScenes(req.projectId, req.scenes, { onlyMissing: !req.scenes }).then(() => send('toast', 'Claude Desktop vừa gửi lệnh render.')).catch((e) => send('toast', 'Lệnh render từ Claude lỗi: ' + e.message));
    }
  }
  // báo giao diện khi Claude Desktop sửa dự án
  for (const p of store.list()) {
    if (lastSeen[p.id] && lastSeen[p.id] !== p.updatedAt) send('project:changed', p.id);
    lastSeen[p.id] = p.updatedAt;
  }
}
const lastSeen = {};

// Chọn bản render & ghép phim
handle('scene:select', (id, sceneId, file) => store.update(id, (p) => { const s = p.script.scenes.find((x) => x.id === sceneId); if (s) s.selected = file; return p; }));
handle('media:concat', async (id) => {
  const p = store.get(id);
  const files = p.script.scenes.filter((s) => s.enabled && s.selected && fs.existsSync(s.selected)).map((s) => s.selected);
  const missing = p.script.scenes.filter((s) => s.enabled && !(s.selected && fs.existsSync(s.selected))).map((s) => s.id);
  if (!files.length) throw new Error('Chưa có cảnh nào render xong.');
  const out = path.join(ensureDir(path.join(store.projectDir(id), 'exports')), `${p.name.replace(/[^\wÀ-ỹ -]+/g, '').trim() || 'phim'}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.mp4`);
  send('claude:progress', { job: 'concat', step: `Đang ghép ${files.length} cảnh…` });
  await media.concat(files, out, { aspect: p.brief.aspect, crossfade: Number(settings.crossfade) || 0 });
  return { out, missing };
});

// Kho video
handle('library:list', () => {
  const vids = queue.tasks.filter((t) => t.status === 'done' && t.output && fs.existsSync(t.output)).map((t) => ({ id: t.id, file: t.output, thumb: t.thumb, label: t.label, model: t.model, kind: t.kind, at: t.finishedAt, prompt: t.prompt }));
  return vids.reverse();
});

// Bảng giá
handle('pricing:get', (projectId) => ({
  plans: settings.plans,
  rates: settings.rates,
  models: pricing.modelTable(settings.rates),
  project: projectId ? pricing.estimateProject(store.get(projectId), { rates: settings.rates }) : null
}));

// Kiểm tra kết nối — từng bên riêng: 'flow' (Veo 3), 'muse' hoặc bỏ trống = bên nào có API thì kiểm tra bên đó
handle('api:test', async (which) => {
  const out = {};
  const doFlow = !which || which === 'flow';
  const doMuse = !which || which === 'muse';
  if (doFlow) {
    if (!hasProviderToken(settings, 'flow')) out.flowMissing = true;
    else try { out.flow = await api.flowAccounts(); } catch (e) { out.flowError = e.message; }
  }
  if (doMuse) {
    if (!hasProviderToken(settings, 'muse')) out.museMissing = true;
    else if (!(settings.museEmail || '').trim()) out.museNoEmail = true;
    else try { out.muse = await api.museAccount(); } catch (e) { out.museError = e.message; }
  }
  return out;
});

// Kết nối Claude Desktop (MCP)
function claudeDesktopConfigPath() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}
function mcpServerPath() {
  return path.join(__dirname, 'src', 'mcp', 'server.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}
handle('mcp:status', () => {
  const cfg = readJson(claudeDesktopConfigPath(), {});
  return { installed: !!(cfg.mcpServers && cfg.mcpServers['h2-video-studio']), configPath: claudeDesktopConfigPath() };
});
handle('mcp:install', () => {
  const file = claudeDesktopConfigPath();
  const cfg = readJson(file, {});
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers['h2-video-studio'] = {
    command: process.execPath,
    args: [mcpServerPath()],
    env: { ELECTRON_RUN_AS_NODE: '1', H2_WORKSPACE: settings.workspace }
  };
  writeJson(file, cfg);
  return { configPath: file };
});
handle('mcp:uninstall', () => {
  const file = claudeDesktopConfigPath();
  const cfg = readJson(file, {});
  if (cfg.mcpServers) delete cfg.mcpServers['h2-video-studio'];
  writeJson(file, cfg);
  return true;
});

// Đường dẫn file → URL cho thẻ <video>/<img>
handle('file:url', (p) => (p ? 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '') : ''));
