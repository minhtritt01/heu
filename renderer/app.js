'use strict';
/* HÊU — giao diện (JS thuần, không cần build). */

const S = {
  page: 'quick',
  settings: null,
  projects: [],
  project: null,
  projTab: 'idea',
  compiled: null,
  queue: [],
  stats: { total: 0, queued: 0, running: 0, done: 0, failed: 0, paused: false },
  quick: { mode: 'video', projectId: '', text: '', model: 'veo-3.1-fast', imageModel: 'nano-banana-pro', aspect: '16:9', duration: 8, refFiles: [], startFrame: null },
  competitor: { url: '', notes: '', transcript: '', current: null, list: [] },
  pricing: null,
  pricingProject: '',
  openScenes: new Set(),
  claudeOk: null,
  mcp: null,
  queueFilter: 'all',
  projView: 'list',
  trash: []
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fileUrl = (p) => (p ? 'file:///' + encodeURI(String(p).replace(/\\/g, '/').replace(/^\/+/, '')).replace(/#/g, '%23').replace(/\?/g, '%3F') : '');
const fmtVnd = (n) => (Number(n) || 0).toLocaleString('vi-VN') + 'đ';
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '');

async function call(name, ...args) {
  try {
    return await window.h2.call(name, ...args);
  } catch (e) {
    toast(e.message, 'err');
    throw e;
  }
}

// ---- API riêng cho từng nhà cung cấp: Veo 3 (Google Flow) và Meta Muse ----
const PROV_NAME = { flow: 'Veo 3', muse: 'Meta Muse' };
function hasKey(provider) {
  const s = S.settings || {};
  if (provider === 'flow' && s.veoMode === 'extension') return true;
  return !!String((provider === 'muse' ? s.museToken : s.veoToken) || s.useapiToken || '').trim();
}
function providerOfModel(id, kind = 'video') {
  const list = kind === 'video' ? S.settings.modelsVideo : S.settings.modelsImage;
  return list[id] && list[id].provider === 'muse' ? 'muse' : 'flow';
}
// Kiểm tra trước khi gửi: chỉ đòi API của đúng model đang chọn
function requireKey(modelId, kind = 'video') {
  const pv = providerOfModel(modelId, kind);
  if (hasKey(pv)) return true;
  toast(`Model này dùng ${PROV_NAME[pv]} nhưng bạn chưa nhập API ${PROV_NAME[pv]}. Vào Cài đặt → ô “API ${PROV_NAME[pv]}”.`, 'err');
  return false;
}
function keyWarnHtml(modelId, kind = 'video') {
  const pv = providerOfModel(modelId, kind);
  if (pv === 'flow' && S.settings.veoMode === 'extension') {
    const b = S.bridge || {};
    if (b.connected && b.flowTab) return '';
    return `<div class="keywarn"><span class="dot warn"></span><span class="kt">Veo 3 đang chạy <b>qua Chrome</b> nhưng ${b.connected ? 'chưa mở dự án Google Flow' : 'tiện ích HÊU Flow Helper chưa kết nối'}. Việc vẫn xếp hàng, sẽ chạy khi Chrome sẵn sàng.</span><button class="btn sm" data-act="go-settings">Xem cách nối</button></div>`;
  }
  if (hasKey(pv)) return '';
  return `<div class="keywarn"><span class="dot warn"></span><span class="kt">Model này chạy bằng <b>${PROV_NAME[pv]}</b> — bạn chưa nhập <b>API ${PROV_NAME[pv]}</b>. Chỉ cần nhập API của bên mình dùng.</span><button class="btn sm" data-act="go-settings">Nhập API ${PROV_NAME[pv]}</button></div>`;
}
// Nút “?” trên đầu mỗi trang → mở đúng mục trong Hướng dẫn
function helpBtn(section) {
  return `<button class="btn sm help" data-act="help" data-s="${section}" title="Xem hướng dẫn chi tiết cho trang này">? Hướng dẫn</button>`;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 9000 : 4500);
}

// Lớp phủ khi Claude đang chạy
async function busy(title, fn) {
  $('#busyTitle').textContent = title;
  $('#busyStep').textContent = 'Claude trên máy đang suy nghĩ… (thường 30 giây – 3 phút)';
  $('#busy').classList.add('on');
  try {
    return await fn();
  } finally {
    $('#busy').classList.remove('on');
  }
}
$('#busyCancel').onclick = () => window.h2.call('claude:cancel');
window.h2.on('claude:progress', (p) => {
  if (p.step) $('#busyStep').textContent = p.step;
  else if (p.seconds != null) $('#busyStep').textContent = `Claude đang viết… ${p.seconds}s`;
});
window.h2.on('toast', (m) => toast(m));

// ---------------- Điều hướng ----------------
function go(page) {
  S.page = page;
  $$('.nav').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
  render();
}
$$('.nav').forEach((n) => (n.onclick = () => go(n.dataset.page)));

function render() {
  const fn = PAGES[S.page] || PAGES.quick;
  $('#main').innerHTML = fn();
  const after = AFTER[S.page];
  if (after) after();
}

// ---------------- Thành phần dùng chung ----------------
function statsHtml() {
  const s = S.stats;
  return `<div class="stats">
    <div class="stat g"><small>Tổng task</small><b>${s.total}</b></div>
    <div class="stat b"><small>Đang chạy</small><b>${s.running}</b></div>
    <div class="stat"><small>Chờ</small><b>${s.queued}</b></div>
    <div class="stat g"><small>Hoàn tất</small><b>${s.done}</b></div>
    <div class="stat r"><small>Thất bại</small><b>${s.failed}</b></div>
  </div>`;
}

const STATUS_VI = { queued: 'Chờ', waiting: 'Chờ cảnh trước', preparing: 'Chuẩn bị', uploading: 'Đang tải ảnh', running: 'Đang tạo', downloading: 'Đang tải về', done: 'Xong', failed: 'Lỗi', cancelled: 'Đã hủy' };
const ACTIVE = ['preparing', 'uploading', 'running', 'downloading'];

function qItemHtml(t) {
  const thumb = t.thumb ? `style="background-image:url('${fileUrl(t.thumb)}')"` : '';
  const chip = t.status === 'done' ? 'g' : t.status === 'failed' ? 'r' : ACTIVE.includes(t.status) ? 'b' : '';
  const model = (S.settings && (S.settings.modelsVideo[t.model] || S.settings.modelsImage[t.model]) || {}).label || t.model;
  return `<div class="qitem" id="q_${t.id}">
    <div class="qthumb" ${thumb}>${t.thumb ? '' : t.kind === 'image' ? '🖼' : '🎬'}</div>
    <div style="min-width:0">
      <div class="t" title="${esc(t.prompt)}">${esc(t.label)}</div>
      <div class="p"><span class="chip ${chip}">${STATUS_VI[t.status] || t.status}</span> ${esc(model)} · ${esc(t.progress || '')}</div>
      ${t.error ? `<div class="e">${esc(t.error)}</div>` : ''}
      ${ACTIVE.includes(t.status) ? '<div class="bar-prog"><i></i></div>' : ''}
    </div>
    <div class="col" style="gap:4px">
      ${t.output ? `<button class="btn sm" data-act="open" data-path="${esc(t.output)}">Mở</button>` : ''}
      ${['failed', 'cancelled'].includes(t.status) ? `<button class="btn sm" data-act="q-retry" data-id="${t.id}">Thử lại</button>` : ''}
      ${['queued', 'waiting', ...ACTIVE].includes(t.status) ? `<button class="btn sm danger" data-act="q-cancel" data-id="${t.id}">Hủy</button>` : ''}
    </div>
  </div>`;
}

function queuePanelHtml(limit = 40) {
  const items = S.queue.slice(0, limit);
  return `<div class="card">
    <h3>Hàng đợi render <span class="muted small">${S.stats.running} đang chạy · ${S.stats.queued} chờ</span><span class="sp"></span>
      <button class="btn sm" data-act="q-pause">${S.stats.paused ? '▶ Tiếp tục' : '⏸ Tạm dừng'}</button>
      <button class="btn sm" data-act="q-clear">Dọn task xong</button>
      <button class="btn sm" data-act="open" data-path="${esc(S.settings ? S.settings.workspace : '')}">Thư mục</button>
    </h3>
    <div id="qlist">${items.length ? items.map(qItemHtml).join('') : `<div class="empty"><div class="big">⌁</div>Chưa có video nào trong hàng đợi.<br><span class="small">Nhập prompt hoặc kịch bản rồi bấm “Tạo video”.</span></div>`}</div>
  </div>`;
}

function modelOptions(selected, kind = 'video') {
  const list = kind === 'video' ? S.settings.modelsVideo : S.settings.modelsImage;
  return Object.entries(list).map(([id, m]) => `<option value="${id}" ${id === selected ? 'selected' : ''}>${esc(m.label)}${hasKey(m.provider === 'muse' ? 'muse' : 'flow') ? '' : ' — chưa nhập API'}</option>`).join('');
}

function projectOptions(selected, emptyLabel = '— Không gắn dự án —') {
  return `<option value="">${emptyLabel}</option>` + S.projects.map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
}

// ================= TRANG: TẠO NHANH =================
const PAGES = {};
const AFTER = {};

PAGES.quick = () => {
  const q = S.quick;
  const m = S.settings.modelsVideo[q.model];
  const blocks = q.text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean).length;
  const durOpts = (m ? m.durations : [8]).map((d) => `<option ${d === Number(q.duration) ? 'selected' : ''} value="${d}">${d} giây</option>`).join('');
  return `
  <div class="head"><div><h1>Tạo video nhanh</h1><p>Gõ mô tả từng video, các video cách nhau 1 DÒNG TRẮNG. Gõ <b>@</b> để chèn nhân vật đã khóa của dự án.</p></div><span class="sp"></span>${helpBtn('quick')}${statsHtml()}</div>
  <div class="split">
    <div class="card composer">
      <div class="row">
        <select id="qProject" style="max-width:260px">${projectOptions(q.projectId, '— Không dùng nhân vật dự án —')}</select>
        <div class="seg"><button class="${q.mode === 'video' ? 'on' : ''}" data-act="q-mode" data-v="video">Video</button><button class="${q.mode === 'image' ? 'on' : ''}" data-act="q-mode" data-v="image">Ảnh</button></div>
        <span class="sp"></span>
        <span class="chip ${blocks ? 'g' : ''}">${blocks} ${q.mode === 'video' ? 'video' : 'ảnh'}</span>
      </div>
      <div style="position:relative">
        <textarea id="qText" placeholder="Gõ để mô tả video — cảnh, ánh sáng, chuyển động camera, lời thoại trong ngoặc kép…&#10;&#10;Muốn tạo nhiều video một lượt thì cách nhau 1 DÒNG TRẮNG (Enter 2 lần). Gõ @ để chèn nhân vật.">${esc(q.text)}</textarea>
        <div class="mention" id="mention" style="display:none"></div>
      </div>
      <div class="row small">
        <span class="muted">Ảnh tham chiếu:</span>
        ${q.refFiles.map((f, i) => `<span class="chip">${esc(f.split(/[\\/]/).pop())} <a href="#" data-act="q-ref-del" data-i="${i}">✕</a></span>`).join('')}
        <button class="btn sm" data-act="q-ref-add">+ Ảnh tham chiếu</button>
        ${q.mode === 'video' ? `<span class="muted">Khung đầu:</span>${q.startFrame ? `<span class="chip">${esc(q.startFrame.split(/[\\/]/).pop())} <a href="#" data-act="q-start-del">✕</a></span>` : '<button class="btn sm" data-act="q-start-add">+ Đầu → Cuối</button>'}` : ''}
      </div>
      <div class="row bar">
        ${q.mode === 'video'
          ? `<select id="qModel" style="width:240px">${modelOptions(q.model)}</select>
             <select id="qDur" style="width:100px">${durOpts}</select>`
          : `<select id="qImgModel" style="width:260px">${modelOptions(q.imageModel, 'image')}</select>`}
        <div class="seg">${['16:9', '9:16'].concat(q.mode === 'image' ? ['1:1'] : []).map((a) => `<button class="${q.aspect === a ? 'on' : ''}" data-act="q-aspect" data-v="${a}">${a}</button>`).join('')}</div>
        ${threadsHtml()}
        <span class="sp"></span>
        <button class="btn ai" data-act="q-polish" title="Claude viết lại các prompt cho mạch lạc, đồng nhất nhân vật">✨ Claude chuốt prompt</button>
        <button class="btn pri" data-act="q-send">${q.mode === 'video' ? 'Tạo video ➤' : 'Tạo ảnh ➤'}</button>
      </div>
      ${m && q.mode === 'video' ? `<div class="muted small mt">${esc(m.note)}</div>` : ''}
      ${q.mode === 'video' ? keyWarnHtml(q.model) : keyWarnHtml(q.imageModel, 'image')}
    </div>
    ${queuePanelHtml()}
  </div>`;
};

AFTER.quick = () => {
  const ta = $('#qText');
  ta.oninput = () => { S.quick.text = ta.value; mentionCheck(ta); updateBlockCount(); };
  ta.onkeydown = mentionKey;
  $('#qProject').onchange = (e) => { S.quick.projectId = e.target.value; loadMentionChars(); };
  if ($('#qModel')) $('#qModel').onchange = (e) => { S.quick.model = e.target.value; S.quick.duration = S.settings.modelsVideo[e.target.value].defaultDuration; render(); };
  if ($('#qDur')) $('#qDur').onchange = (e) => { S.quick.duration = Number(e.target.value); };
  if ($('#qImgModel')) $('#qImgModel').onchange = (e) => { S.quick.imageModel = e.target.value; render(); };
  loadMentionChars();
};

function updateBlockCount() {
  const n = S.quick.text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean).length;
  const chip = $('.composer .chip');
  if (chip) { chip.textContent = `${n} ${S.quick.mode === 'video' ? 'video' : 'ảnh'}`; chip.className = 'chip ' + (n ? 'g' : ''); }
}

// ---- gợi ý @nhân vật ----
let mentionChars = [];
let mentionIdx = 0;
async function loadMentionChars() {
  mentionChars = [];
  if (!S.quick.projectId) return;
  const p = await call('projects:get', S.quick.projectId);
  mentionChars = p.characters.map((c) => ({ tag: c.tag, name: c.name, hasRef: c.refImages.length > 0 }));
}
function mentionCheck(ta) {
  const box = $('#mention');
  const before = ta.value.slice(0, ta.selectionStart);
  const m = before.match(/@([a-z0-9_]*)$/i);
  if (!m || !mentionChars.length) { box.style.display = 'none'; return; }
  const list = mentionChars.filter((c) => c.tag.slice(1).startsWith(m[1].toLowerCase()) || c.name.toLowerCase().includes(m[1].toLowerCase()));
  if (!list.length) { box.style.display = 'none'; return; }
  mentionIdx = Math.min(mentionIdx, list.length - 1);
  box.innerHTML = list.map((c, i) => `<div class="${i === mentionIdx ? 'on' : ''}" data-tag="${c.tag}">${esc(c.name)} <span class="tag">${c.tag}</span> ${c.hasRef ? '🖼' : ''}</div>`).join('');
  box.style.display = 'block';
  box.style.left = '10px';
  box.style.top = Math.min(ta.scrollHeight, 260) + 'px';
  $$('#mention div').forEach((d) => (d.onmousedown = (e) => { e.preventDefault(); insertMention(d.dataset.tag); }));
}
function mentionKey(e) {
  const box = $('#mention');
  if (box.style.display !== 'block') return;
  const items = $$('#mention div');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    mentionIdx = (mentionIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items.forEach((d, i) => d.classList.toggle('on', i === mentionIdx));
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    insertMention(items[mentionIdx].dataset.tag);
  } else if (e.key === 'Escape') box.style.display = 'none';
}
function insertMention(tag) {
  const ta = $('#qText');
  const pos = ta.selectionStart;
  const before = ta.value.slice(0, pos).replace(/@([a-z0-9_]*)$/i, tag + ' ');
  ta.value = before + ta.value.slice(pos);
  ta.selectionStart = ta.selectionEnd = before.length;
  S.quick.text = ta.value;
  $('#mention').style.display = 'none';
  ta.focus();
}

// ================= TRANG: DỰ ÁN =================
PAGES.projects = () => (S.project ? projectEditorHtml() : projectListHtml());

function projectListHtml() {
  return `
  <div class="head"><div><h1>Dự án</h1><p>Mỗi dự án = 1 phim: ý tưởng → nhân vật khóa → kịch bản liền mạch → prompt đã kiểm tra → render & ghép.</p></div><span class="sp"></span>${helpBtn('projects')}</div>
  <div class="card" style="margin-bottom:14px">
    <h3>＋ Tạo dự án mới</h3>
    <div class="grid3">
      <label class="f"><span>Tên dự án</span><input type="text" id="npName" placeholder="VD: Ông và cháu câu cá"></label>
      <label class="f" style="grid-column:span 2"><span>Chủ đề / ý tưởng</span><input type="text" id="npTopic" placeholder="VD: Bé gái lần đầu câu cá cùng ông trên sông Mê Kông, học tính kiên nhẫn"></label>
    </div>
    <div class="row mt"><span class="muted small">Có video đối thủ? Vào “Phân tích đối thủ” để tạo dự án từ báo cáo.</span><span class="sp"></span><button class="btn pri" data-act="p-create">Tạo dự án</button></div>
  </div>
  <div class="tabs">
    <div class="tab ${S.projView === 'list' ? 'on' : ''}" data-act="pv" data-v="list">Dự án (${S.projects.length})</div>
    <div class="tab ${S.projView === 'trash' ? 'on' : ''}" data-act="pv" data-v="trash">🗑 Thùng rác (${S.trash.length})</div>
  </div>
  ${S.projView === 'trash' ? trashHtml() : `<div class="plist">
    ${S.projects.map((p) => `<div class="card pcard" data-act="p-open" data-id="${p.id}">
      <h4>${esc(p.name)}</h4>
      <div class="muted small" style="min-height:34px">${esc((p.topic || '').slice(0, 110))}</div>
      <div class="row mt small"><span class="chip">${p.characters} nhân vật</span><span class="chip">${p.scenes} cảnh</span><span class="chip">${esc((S.settings.modelsVideo[p.model] || {}).label || '')}</span><span class="sp"></span><span class="muted">${fmtTime(p.updatedAt)}</span></div>
      <div class="row mt"><span class="sp"></span><button class="btn sm" data-act="p-dup" data-id="${p.id}" data-name="${esc(p.name)}">⧉ Nhân bản</button><button class="btn sm danger" data-act="p-del-card" data-id="${p.id}" data-name="${esc(p.name)}">Xóa</button></div>
    </div>`).join('') || '<div class="empty">Chưa có dự án nào.</div>'}
  </div>`}`;
}

function trashHtml() {
  if (!S.trash.length) return '<div class="empty card"><div class="big">🗑</div>Thùng rác trống.</div>';
  return `<div class="muted small" style="margin-bottom:10px">Dự án đã xóa nằm ở đây cùng toàn bộ ảnh và video. Bấm Khôi phục để đưa về danh sách dự án.</div>
  <div class="plist">${S.trash.map((t) => `<div class="card">
    <h4 style="margin:0 0 4px">${esc(t.name)}</h4>
    <div class="muted small" style="min-height:34px">${esc((t.topic || '').slice(0, 110))}</div>
    <div class="row mt small"><span class="chip">${t.characters} nhân vật</span><span class="chip">${t.scenes} cảnh</span><span class="sp"></span><span class="muted">Xóa lúc ${fmtTime(t.deletedAt)}</span></div>
    <div class="row mt"><span class="sp"></span><button class="btn sm danger" data-act="t-purge" data-f="${esc(t.folder)}" data-name="${esc(t.name)}">Xóa vĩnh viễn</button><button class="btn sm pri" data-act="t-restore" data-f="${esc(t.folder)}">↺ Khôi phục</button></div>
  </div>`).join('')}</div>`;
}

// Hộp thoại nhân bản
function dupDialog(id, name) {
  const box = document.createElement('div');
  box.id = 'modal';
  box.innerHTML = `<div class="mbox card col">
    <h3>⧉ Nhân bản dự án</h3>
    <label class="f"><span>Tên dự án mới</span><input type="text" id="dupName" value="${esc(name)} (bản sao)"></label>
    <label class="f"><span>Giữ lại những gì?</span></label>
    <label class="row small"><input type="radio" name="dupKeep" value="script" checked> Nhân vật + phong cách + kịch bản (chưa có video) — để làm lại / làm biến thể</label>
    <label class="row small"><input type="radio" name="dupKeep" value="videos"> Giữ tất cả, kể cả video đã render</label>
    <label class="row small"><input type="radio" name="dupKeep" value="cast"> Chỉ nhân vật + phong cách + ảnh tham chiếu — để viết “Phần 2”</label>
    <div class="muted small">Ảnh tham chiếu nhân vật luôn được chép sang, nên nhân vật ở bản mới giống hệt bản cũ.</div>
    <div class="row end"><button class="btn" id="dupCancel">Hủy</button><button class="btn pri" id="dupOk">Nhân bản</button></div>
  </div>`;
  document.body.appendChild(box);
  $('#dupName').select();
  $('#dupCancel').onclick = () => box.remove();
  $('#dupOk').onclick = async () => {
    const v = $('input[name=dupKeep]:checked').value;
    const keep = v === 'cast' ? { script: false } : v === 'videos' ? { videos: true } : {};
    const newName = $('#dupName').value.trim() || name + ' (bản sao)';
    box.remove();
    const p = await busy('Đang nhân bản dự án…', () => call('projects:duplicate', id, newName, keep));
    await loadProjects();
    S.page = 'projects';
    $$('.nav').forEach((n) => n.classList.toggle('active', n.dataset.page === 'projects'));
    await openProject(p.id, v === 'cast' ? 'script' : 'idea');
    toast('Đã nhân bản: ' + p.name);
  };
}

// Chip chọn số luồng render (giống “6 luồng” của ViraAI)
function threadsHtml() {
  const s = S.settings;
  const n = Number(s.maxParallel) || 2;
  const sys = s.system || {};
  return `<label class="chip g" title="Số video render cùng lúc. Muse tối đa ${s.maxParallelMuse || 2} luồng/tài khoản, Flow ${s.maxParallelFlow || n}.">⚡
    <select data-threads style="background:transparent;border:0;padding:0 2px;width:auto;color:inherit">${[1, 2, 3, 4, 5, 6, 8, 10].map((v) => `<option value="${v}" ${v === n ? 'selected' : ''}>${v}</option>`).join('')}</select> luồng
    ${sys.ramGB ? `<span class="muted">· ${sys.ramGB} GB RAM</span>` : ''}</label>`;
}

const TABS = [['idea', 'Ý tưởng & phong cách'], ['cast', 'Nhân vật & bối cảnh'], ['script', 'Kịch bản'], ['check', 'Prompt & kiểm tra'], ['render', 'Render & ghép phim']];

function projectEditorHtml() {
  const p = S.project;
  return `
  <div class="head">
    <button class="btn" data-act="p-back">← Dự án</button>
    <div style="flex:1;min-width:240px"><input type="text" data-bind="name" value="${esc(p.name)}" style="font-size:18px;font-weight:700;background:transparent;border-color:transparent;padding-left:0"></div>
    <span class="chip">${p.characters.length} nhân vật</span><span class="chip">${p.script.scenes.length} cảnh</span>
    <button class="btn sm" data-act="open" data-path="${esc(S.settings.workspace + '/projects/' + p.id)}">Thư mục</button>
    <button class="btn sm" data-act="p-dup" data-id="${p.id}" data-name="${esc(p.name)}">⧉ Nhân bản</button>
    <button class="btn sm danger" data-act="p-delete">Xóa</button>
  </div>
  <div class="row" style="margin:-4px 0 8px"><span class="muted small">Làm lần lượt 5 bước dưới đây. Bấm “? Hướng dẫn” để xem tác dụng từng nút.</span><span class="sp"></span>${helpBtn('tab-' + S.projTab)}</div>
  <div class="tabs">${TABS.map(([id, label], i) => `<div class="tab ${S.projTab === id ? 'on' : ''}" data-act="p-tab" data-v="${id}"><span class="n">${i + 1}</span>${label}</div>`).join('')}</div>
  <div id="ptab">${({ idea: tabIdea, cast: tabCast, script: tabScript, check: tabCheck, render: tabRender })[S.projTab]()}</div>`;
}

function field(label, path, { type = 'text', area = false, rows = 3, placeholder = '', options = null, span = 1, hint = '' } = {}) {
  const v = getPath(S.project, path);
  let input;
  if (options) input = `<select data-bind="${path}">${options.map(([val, lab]) => `<option value="${esc(val)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>`;
  else if (area) input = `<textarea data-bind="${path}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(v)}</textarea>`;
  else input = `<input type="${type}" data-bind="${path}" value="${esc(v)}" placeholder="${esc(placeholder)}">`;
  return `<label class="f" style="grid-column:span ${span}"><span>${label}</span>${input}${hint ? `<small>${hint}</small>` : ''}</label>`;
}

function tabIdea() {
  const p = S.project;
  const c = p.competitor && p.competitor.report;
  return `
  <div class="grid2">
    <div class="card col">
      <h3>Ý tưởng & thông số phim</h3>
      ${field('Chủ đề (Claude bám chặt chủ đề này, không lan man)', 'brief.topic', { area: true, rows: 2 })}
      ${field('Mục tiêu / thông điệp cuối phim', 'brief.goal', { placeholder: 'VD: người xem thấy kiên nhẫn được đền đáp' })}
      <div class="grid2">
        ${field('Thể loại', 'brief.genre', { placeholder: 'hoạt hình gia đình, kinh dị, sinh tồn…' })}
        ${field('Khán giả', 'brief.audience', { placeholder: 'trẻ em 6-12, người Mỹ 25-40…' })}
        ${field('Ngôn ngữ lời thoại', 'brief.dialogueLanguage', { options: [['English', 'Tiếng Anh'], ['Vietnamese', 'Tiếng Việt'], ['Japanese', 'Tiếng Nhật'], ['Korean', 'Tiếng Hàn'], ['Spanish', 'Tiếng Tây Ban Nha']] })}
        ${field('Kiểu âm thanh', 'brief.narration', { options: [['dialogue', 'Nhân vật nói thoại'], ['voiceover', 'Giọng dẫn chuyện'], ['none', 'Không lời (chỉ SFX/nhạc)']] })}
        ${field('Độ dài phim mong muốn (giây)', 'brief.targetSeconds', { type: 'number' })}
        ${field('Model video', 'brief.model', { options: Object.entries(S.settings.modelsVideo).map(([id, m]) => [id, m.label + (hasKey(m.provider === 'muse' ? 'muse' : 'flow') ? '' : ' — chưa nhập API')]) })}
      </div>
      ${keyWarnHtml(p.brief.model)}
      <div class="row"><span class="muted small">Khung hình</span><div class="seg">${['16:9', '9:16'].map((a) => `<button class="${p.brief.aspect === a ? 'on' : ''}" data-act="p-aspect" data-v="${a}">${a}</button>`).join('')}</div></div>
      ${field('Ghi chú thêm cho Claude', 'brief.notes', { area: true, rows: 2 })}
    </div>
    <div class="card col">
      <h3>Khóa phong cách (chèn nguyên văn vào mọi prompt)</h3>
      ${field('Phong cách hình ảnh', 'style.visualStyle', { area: true, rows: 2, placeholder: '2D flat vector animation, thick outlines…' })}
      ${field('Bảng màu', 'style.palette')}
      ${field('Ánh sáng', 'style.lighting')}
      ${field('Ngôn ngữ máy quay mặc định', 'style.camera')}
      ${field('Thế giới / thời đại', 'style.world')}
      ${field('Cấm xuất hiện (negative)', 'style.negative', { area: true, rows: 2 })}
      <div class="row end"><input type="text" id="bibleInstr" placeholder="Yêu cầu thêm cho Claude (tùy chọn)" style="flex:1"><button class="btn ai" data-act="ai-bible">✨ Claude dựng phong cách & nhân vật</button></div>
    </div>
  </div>
  ${c ? `<div class="card mt"><h3>Đang dùng phân tích đối thủ: ${esc(c.title || p.competitor.url)}</h3><div class="muted">${esc(c.summary || '')}</div><div class="small mt"><b>Hook:</b> ${esc(c.hook && c.hook.text)} — ${esc(c.hook && c.hook.technique)}</div></div>` : ''}`;
}

function tabCast() {
  const p = S.project;
  const charCard = (c, i) => `
    <div class="card col">
      <div class="row"><span class="tag">${esc(c.tag)}</span><b>${esc(c.name)}</b><span class="sp"></span>
        <button class="btn sm" data-act="ref-prompts" data-type="character" data-id="${c.id}">Prompt ảnh tham chiếu</button>
        <button class="btn sm danger" data-act="cast-del" data-list="characters" data-i="${i}">✕</button></div>
      <div class="grid3">
        ${field('Tên', `characters.${i}.name`)}
        ${field('Tag (@…)', `characters.${i}.tag`)}
        ${field('Vai trò', `characters.${i}.role`)}
      </div>
      ${field('Khóa nhận dạng — ngoại hình cố định (tiếng Anh)', `characters.${i}.identity`, { area: true, rows: 4 })}
      ${field('Trang phục cố định', `characters.${i}.wardrobe`, { area: true, rows: 2 })}
      <div class="grid2">${field('Giọng nói', `characters.${i}.voice`)}${field('Tính cách', `characters.${i}.personality`)}</div>
      <div class="small muted">Ảnh tham chiếu (ảnh viền xanh = ảnh chính gửi cho model). Nên có 1 bảng nhân vật 4 góc + 1 ảnh cận mặt.</div>
      <div class="refs">${refsHtml(c, 'character')}</div>
      <div id="rp_${c.id}"></div>
    </div>`;
  const locCard = (l, i) => `
    <div class="card col">
      <div class="row"><span class="tag">${esc(l.tag)}</span><b>${esc(l.name)}</b><span class="sp"></span>
        <button class="btn sm" data-act="ref-prompts" data-type="location" data-id="${l.id}">Prompt ảnh bối cảnh</button>
        <button class="btn sm danger" data-act="cast-del" data-list="locations" data-i="${i}">✕</button></div>
      <div class="grid2">${field('Tên', `locations.${i}.name`)}${field('Tag (#…)', `locations.${i}.tag`)}</div>
      ${field('Mô tả cố định (tiếng Anh)', `locations.${i}.description`, { area: true, rows: 3 })}
      <div class="refs">${refsHtml(l, 'location')}</div>
      <div id="rp_${l.id}"></div>
    </div>`;
  return `
  <div class="row" style="margin-bottom:12px">
    <span class="muted">Khóa nhận dạng càng cụ thể (mặt, tóc, màu mắt, dáng người, dấu riêng) thì nhân vật càng giống nhau giữa các cảnh.</span><span class="sp"></span>
    <button class="btn" data-act="cast-add" data-list="characters">＋ Nhân vật</button>
    <button class="btn" data-act="cast-add" data-list="locations">＋ Bối cảnh</button>
    <button class="btn ai" data-act="ai-bible">✨ Claude hoàn thiện</button>
  </div>
  <h3>Nhân vật</h3>
  <div class="chars">${p.characters.map(charCard).join('') || '<div class="empty">Chưa có nhân vật. Bấm “Claude hoàn thiện” để Claude tạo từ chủ đề.</div>'}</div>
  <h3 class="mt">Bối cảnh</h3>
  <div class="chars">${p.locations.map(locCard).join('') || '<div class="empty">Chưa có bối cảnh.</div>'}</div>`;
}

function refsHtml(item, type) {
  return item.refImages.map((f, i) => `<div class="ref ${i === 0 ? 'primary' : ''}" style="background-image:url('${fileUrl(f)}')" title="${esc(f)}">
      <button class="x" data-act="ref-del" data-type="${type}" data-id="${item.id}" data-file="${esc(f)}">✕</button>
      ${i ? `<button class="star" data-act="ref-primary" data-type="${type}" data-id="${item.id}" data-file="${esc(f)}">★ chính</button>` : ''}
    </div>`).join('') + `<div class="ref add" data-act="ref-add" data-type="${type}" data-id="${item.id}" title="Thêm ảnh từ máy">＋</div>`;
}

function tabScript() {
  const p = S.project;
  const sc = p.script;
  const charOpts = p.characters.map((c) => c.tag);
  return `
  <div class="card col">
    <div class="row">
      <h3 style="margin:0">Kịch bản</h3><span class="sp"></span>
      <input type="number" id="sceneCount" placeholder="Số cảnh (tự tính)" style="width:150px">
      <input type="text" id="scriptInstr" placeholder="Yêu cầu thêm (VD: kết có twist, hài hước…)" style="width:320px">
      <button class="btn ai" data-act="ai-script">✨ Claude viết kịch bản</button>
    </div>
    ${field('Logline', 'script.logline', { area: true, rows: 2 })}
    ${sc.outline && sc.outline.length ? `<div class="row small">${sc.outline.map((o) => `<span class="chip" title="${esc(o.summary)}"><b>${esc(o.part)}</b> ${esc(o.scenes || '')}</span>`).join('')}</div>` : ''}
  </div>
  <div class="row mt" style="margin-bottom:8px"><span class="muted small">Mỗi cảnh = 1 shot liền. KHÔNG tả ngoại hình nhân vật ở đây — app tự chèn khóa nhận dạng. “Nối liền” = cảnh lấy khung cuối cảnh trước làm khung đầu.</span><span class="sp"></span>
    <button class="btn sm" data-act="sc-expand">Mở/đóng tất cả</button><button class="btn sm" data-act="sc-add">＋ Thêm cảnh</button></div>
  ${sc.scenes.map((s, i) => sceneHtml(s, i, charOpts)).join('') || '<div class="empty card">Chưa có cảnh nào. Bấm “Claude viết kịch bản”.</div>'}`;
}

function sceneHtml(s, i, charOpts) {
  const open = S.openScenes.has(s.id);
  const P = `script.scenes.${i}`;
  const words = s.dialogue.reduce((n, d) => n + String(d.line || '').trim().split(/\s+/).filter(Boolean).length, 0);
  return `<div class="scene ${s.enabled ? '' : 'off'}">
    <div class="sh" data-act="sc-toggle" data-id="${s.id}">
      <span class="id">${s.id}</span><b>${esc(s.title || '(chưa đặt tên)')}</b>
      <span class="chip">${s.duration}s</span>${s.beat ? `<span class="chip b">${esc(s.beat)}</span>` : ''}
      <span class="chip">${esc(s.location)}</span>${s.characters.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')}
      <span class="chip ${s.transition === 'continuous' ? 'g' : ''}">${{ continuous: 'Nối liền', cut: 'Cắt cảnh', 'time-skip': 'Nhảy thời gian' }[s.transition] || s.transition}</span>
      ${s.dialogue.length ? `<span class="chip">💬 ${words} từ</span>` : ''}
      <span class="sp"></span>
      <span class="muted small">${esc((s.action || '').slice(0, 70))}</span>
    </div>
    ${open ? `<div class="sb">
      ${field('Tiêu đề', P + '.title')}
      <div class="grid3">${field('Giây', P + '.duration', { type: 'number' })}${field('Nhịp', P + '.beat')}${field('Cách nối', P + '.transition', { options: [['continuous', 'Nối liền'], ['cut', 'Cắt cảnh'], ['time-skip', 'Nhảy thời gian']] })}</div>
      ${field('Bối cảnh (#tag)', P + '.location')}
      ${field('Thời điểm', P + '.timeOfDay')}
      <label class="f full"><span>Nhân vật có mặt</span><div class="row">${charOpts.map((t) => `<label class="chip"><input type="checkbox" data-act="sc-char" data-i="${i}" data-tag="${t}" ${s.characters.includes(t) ? 'checked' : ''}> ${t}</label>`).join('') || '<span class="muted small">Chưa có nhân vật</span>'}</div></label>
      ${field('Khung mở đầu (startState)', P + '.startState', { area: true, rows: 2, span: 1 })}
      ${field('Khung kết thúc (endState)', P + '.endState', { area: true, rows: 2 })}
      <div class="full">${field('Hành động (1 hành động chính, tiếng Anh)', P + '.action', { area: true, rows: 3 })}</div>
      <div class="full"><label class="f"><span>Lời thoại / dẫn chuyện</span></label>
        ${s.dialogue.map((d, j) => `<div class="dlg">
          <input type="text" data-bind="${P}.dialogue.${j}.who" value="${esc(d.who)}" placeholder="@tag / Narrator">
          <input type="text" data-bind="${P}.dialogue.${j}.line" value="${esc(d.line)}" placeholder="Câu thoại">
          <input type="text" data-bind="${P}.dialogue.${j}.delivery" value="${esc(d.delivery || '')}" placeholder="cách nói">
          <button class="btn sm" data-act="dlg-del" data-i="${i}" data-j="${j}">✕</button></div>`).join('')}
        <button class="btn sm" data-act="dlg-add" data-i="${i}">＋ Câu thoại</button></div>
      ${field('Máy quay', P + '.camera')}
      ${field('Âm thanh', P + '.sound')}
      ${field('Không khí', P + '.mood')}
      <label class="f"><span>Prompt tự viết (bỏ trống = app tự ghép có khóa nhân vật)</span><textarea data-bind="${P}.promptOverride" rows="2">${esc(s.promptOverride)}</textarea></label>
      <div class="row full">
        <button class="btn sm" data-act="sc-move" data-i="${i}" data-d="-1">↑</button><button class="btn sm" data-act="sc-move" data-i="${i}" data-d="1">↓</button>
        <button class="btn sm" data-act="sc-enable" data-i="${i}">${s.enabled ? 'Tắt cảnh' : 'Bật cảnh'}</button>
        <button class="btn sm danger" data-act="sc-del" data-i="${i}">Xóa</button>
        <span class="sp"></span>
        <input type="text" id="rw_${s.id}" placeholder="Muốn sửa gì cảnh này?" style="width:260px">
        <button class="btn sm ai" data-act="ai-rewrite" data-id="${s.id}">✨ Claude viết lại cảnh</button>
      </div>
    </div>` : ''}
  </div>`;
}

function tabCheck() {
  const p = S.project;
  const c = S.compiled;
  const r = p.review;
  if (!c) return '<div class="empty">Đang ghép prompt…</div>';
  const levelChip = { error: 'r', warn: 'w', info: 'b' };
  return `
  <div class="grid2">
    <div class="card">
      <h3>Kiểm tra tự động (miễn phí, tức thì)<span class="sp"></span><span class="chip ${c.lint.some((x) => x.level === 'error') ? 'r' : 'g'}">${c.lint.length} ghi chú</span></h3>
      ${c.lint.map((x) => `<div class="issue"><span class="chip ${levelChip[x.level]}">${x.scene || 'Chung'}</span><span>${esc(x.msg)}</span></div>`).join('') || '<div class="muted">Không phát hiện lỗi cấu trúc.</div>'}
      <hr><div class="row"><span class="muted small">Cách nối cảnh:</span>
        <div class="seg">${[['auto', 'Tự động'], ['refs', 'Ảnh tham chiếu'], ['chain', 'Khung cuối → đầu']].map(([v, l]) => `<button class="${p.continuity.mode === v ? 'on' : ''}" data-act="p-cont" data-v="${v}">${l}</button>`).join('')}</div></div>
      <div class="muted small mt">Tự động: cảnh “Nối liền” lấy khung cuối cảnh trước (liền mạch tuyệt đối), cảnh “Cắt cảnh” dùng ảnh tham chiếu nhân vật (giữ mặt). Meta Muse dùng được cả hai cùng lúc.</div>
    </div>
    <div class="card">
      <h3>Claude kiểm tra nhất quán<span class="sp"></span><button class="btn ai" data-act="ai-review">✨ ${r ? 'Kiểm tra lại' : 'Kiểm tra'}</button></h3>
      ${r ? `<div class="row"><div class="score" style="color:${r.score >= 80 ? 'var(--ok)' : r.score >= 60 ? 'var(--warn)' : 'var(--err)'}">${r.score}</div><div class="muted">${esc(r.summary)}</div></div>
        <hr>
        ${(r.issues || []).map((x) => `<div class="issue"><span class="chip ${x.severity === 'high' ? 'r' : x.severity === 'medium' ? 'w' : 'b'}">${esc(x.scene || 'Chung')}</span><div><b>${esc(x.type)}</b> · ${esc(x.problem)}<div class="muted small">→ ${esc(x.fix)}</div></div></div>`).join('') || '<div class="muted">Không có vấn đề.</div>'}
        ${(r.patches || []).length ? `<hr><b>Claude đề xuất sửa ${r.patches.length} chỗ</b>
          ${r.patches.map((pt, i) => `<label class="issue" style="cursor:pointer"><span><input type="checkbox" class="patchChk" value="${i}" ${pt.applied ? 'disabled' : 'checked'}> ${esc(pt.scene)}</span><span><b>${esc(pt.field)}</b>${pt.applied ? ' <span class="chip g">đã áp dụng</span>' : ''}<div class="muted small mono">${esc(typeof pt.value === 'string' ? pt.value : JSON.stringify(pt.value))}</div></span></label>`).join('')}
          <div class="row end mt"><button class="btn pri" data-act="apply-patches">Áp dụng sửa đã chọn</button></div>` : ''}`
        : '<div class="muted">Claude đọc toàn bộ bible + kịch bản + prompt cuối cùng, tìm chỗ lệch chủ đề, lệch nhân vật, đứt mạch, thoại quá dài… rồi đề xuất sửa từng trường. Nên chạy trước khi render để đỡ tốn credit.</div>'}
    </div>
  </div>
  <h3 class="mt">Prompt cuối cùng gửi cho model</h3>
  ${c.scenes.map((x) => `<div class="card" style="margin-bottom:10px">
    <div class="row"><span class="tag">${x.id}</span><span class="chip">${x.duration}s</span>
      ${x.plan.chain ? '<span class="chip g">⛓ nối khung cuối cảnh trước</span>' : ''}
      ${x.refs.map((r) => `<span class="chip b">🖼 ${esc(r.name)}</span>`).join('')}
      ${x.warnings.map((w) => `<span class="chip w" title="${esc(w)}">⚠ ${esc(w.slice(0, 50))}…</span>`).join('')}
      <span class="sp"></span><span class="muted small">${x.prompt.length} ký tự</span><button class="btn sm" data-act="copy" data-text="${esc(x.prompt)}">Sao chép</button></div>
    <pre class="prompt mt">${esc(x.prompt)}</pre></div>`).join('')}`;
}

function tabRender() {
  const p = S.project;
  const est = S.compiled && S.compiled.estimate;
  const tasksByScene = {};
  for (const t of S.queue) if (t.projectId === p.id && t.sceneId && !tasksByScene[t.sceneId]) tasksByScene[t.sceneId] = t;
  const doneCount = p.script.scenes.filter((s) => s.enabled && s.selected).length;
  const enabled = p.script.scenes.filter((s) => s.enabled).length;
  return `
  <div class="grid2">
    <div class="card">
      <h3>Render<span class="sp"></span>${threadsHtml()}</h3>
      <div class="row"><span class="muted">Model:</span><b>${esc(S.settings.modelsVideo[p.brief.model].label)}</b><span class="muted">· ${enabled} cảnh · ${doneCount} đã có video</span></div>
      ${keyWarnHtml(p.brief.model)}
      ${est ? `<div class="muted small mt">Ước tính (tính cả ~30% render lại): ${est.credits ? `<b>${est.credits}</b> credit Flow ≈ <b>${fmtVnd(est.vnd)}</b>` : ''}${est.museQuotaPercent ? ` · ~${est.museQuotaPercent}% hạn mức tuần Muse` : ''}</div>` : ''}
      <div class="row mt">
        <button class="btn pri" data-act="render-missing">Render cảnh chưa có video</button>
        <button class="btn" data-act="render-all">Render lại tất cả</button>
      </div>
    </div>
    <div class="card">
      <h3>Ghép thành phim</h3>
      <div class="muted small">Ghép các bản đã chọn (viền xanh) theo thứ tự cảnh, chuẩn hóa về ${p.brief.aspect === '9:16' ? '1080×1920' : '1920×1080'} 24fps, giữ âm thanh gốc của từng clip.</div>
      <div class="row mt"><button class="btn pri" data-act="concat" ${doneCount ? '' : 'disabled'}>🎞 Ghép phim (${doneCount}/${enabled} cảnh)</button>
      <button class="btn" data-act="open" data-path="${esc(S.settings.workspace + '/projects/' + p.id + '/exports')}">Mở thư mục xuất</button></div>
    </div>
  </div>
  <div class="mt">
  ${p.script.scenes.map((s, i) => {
    const t = tasksByScene[s.id];
    return `<div class="card ${s.enabled ? '' : 'off'}" style="margin-bottom:10px">
      <div class="row"><span class="tag">${s.id}</span><b>${esc(s.title)}</b>
        ${t ? `<span class="chip ${t.status === 'done' ? 'g' : t.status === 'failed' ? 'r' : 'b'}">${STATUS_VI[t.status]}</span><span class="muted small">${esc(t.progress || '')}</span>` : ''}
        <span class="sp"></span>
        <button class="btn sm" data-act="render-one" data-id="${s.id}">${s.takes.length ? '↻ Render thêm bản' : '▶ Render'}</button></div>
      ${t && t.error ? `<div class="small" style="color:var(--err)">${esc(t.error)}</div>` : ''}
      ${s.takes.length ? `<div class="takes mt">${s.takes.map((k, j) => `<div class="take ${k.file === s.selected ? 'sel' : ''}" data-act="take-select" data-id="${s.id}" data-file="${esc(k.file)}">
          <video src="${fileUrl(k.file)}" preload="metadata" muted onmouseover="this.play()" onmouseout="this.pause()"></video>
          <div class="c"><span>Bản ${j + 1}</span><span>${k.file === s.selected ? '✓ dùng' : 'chọn'}</span></div></div>`).join('')}</div>` : ''}
    </div>`;
  }).join('')}
  </div>`;
}

AFTER.projects = () => {
  if (S.project && S.projTab === 'check' && !S.compiled) refreshCompiled();
  if (S.project && S.projTab === 'render' && !S.compiled) refreshCompiled();
};

// ---- ràng buộc dữ liệu form ↔ dự án ----
function getPath(o, path) {
  return path.split('.').reduce((a, k) => (a == null ? a : a[k]), o) ?? '';
}
function setPath(o, path, v) {
  const ks = path.split('.');
  let cur = o;
  for (let i = 0; i < ks.length - 1; i++) cur = cur[ks[i]];
  const old = cur[ks[ks.length - 1]];
  cur[ks[ks.length - 1]] = typeof old === 'number' ? Number(v) : v;
}
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProject, 500);
}
async function saveProject() {
  clearTimeout(saveTimer);
  if (!S.project) return;
  S.project = await call('projects:save', S.project);
  S.compiled = null;
}
$('#main').addEventListener('change', async (e) => {
  const el = e.target;
  if (el.matches('[data-threads]')) {
    const n = Number(el.value);
    const patch = { maxParallel: n };
    if ((Number(S.settings.maxParallelFlow) || 0) < n) patch.maxParallelFlow = n;
    S.settings = { ...S.settings, ...(await call('settings:set', patch)) };
    $$('[data-threads]').forEach((x) => (x.value = String(n)));
    toast(`Render ${n} luồng cùng lúc`);
    return;
  }
  if (el.dataset.bind && S.project) {
    setPath(S.project, el.dataset.bind, el.value);
    if (/\.tag$/.test(el.dataset.bind)) {
      const v = el.value.trim().toLowerCase();
      const isLoc = el.dataset.bind.startsWith('locations');
      setPath(S.project, el.dataset.bind, (v.startsWith(isLoc ? '#' : '@') ? v : (isLoc ? '#' : '@') + v).replace(/[^@#a-z0-9_]/g, ''));
    }
    scheduleSave();
  }
});

async function openProject(id, tab) {
  S.project = await call('projects:get', id);
  S.compiled = null;
  if (tab) S.projTab = tab;
  render();
}
async function refreshCompiled() {
  if (!S.project) return;
  await saveProject();
  S.compiled = await call('projects:compile', S.project.id);
  if (S.page === 'projects') render();
}
async function reloadProject() {
  if (!S.project) return;
  S.project = await call('projects:get', S.project.id);
  S.compiled = null;
  render();
}
window.h2.on('project:changed', (id) => {
  if (S.project && S.project.id === id && S.page === 'projects') {
    // không ghi đè khi người dùng đang gõ
    const active = document.activeElement;
    if (active && active.dataset && active.dataset.bind) return;
    reloadProject();
  }
});

// ================= TRANG: PHÂN TÍCH ĐỐI THỦ =================
PAGES.competitor = () => {
  const c = S.competitor;
  const r = c.current && c.current.report;
  return `
  <div class="head"><div><h1>Phân tích video đối thủ</h1><p>Dán link YouTube/TikTok. App tự lấy tiêu đề, lượt xem và phụ đề; Claude trên máy mổ xẻ hook, cấu trúc, nhịp, lý do viral rồi đề xuất ý tưởng của riêng bạn.</p></div><span class="sp"></span>${helpBtn('competitor')}</div>
  <div class="split">
    <div class="col">
      <div class="card col">
        <label class="f"><span>Link video</span><input type="url" id="cUrl" value="${esc(c.url)}" placeholder="https://www.youtube.com/watch?v=…"></label>
        <label class="f"><span>Bạn muốn rút ra gì? (tùy chọn)</span><input type="text" id="cNotes" value="${esc(c.notes)}" placeholder="VD: muốn làm kênh tương tự nhưng nhân vật người Việt"></label>
        <details><summary class="muted small">Dán kịch bản / phụ đề thủ công (khi video không có phụ đề)</summary><textarea id="cTx" rows="6">${esc(c.transcript)}</textarea></details>
        <div class="row end"><button class="btn ai" data-act="ai-competitor">✨ Phân tích</button></div>
      </div>
      ${r ? reportHtml(c.current) : ''}
    </div>
    <div class="card"><h3>Đã phân tích</h3>
      ${c.list.map((x, i) => `<div class="qitem" style="grid-template-columns:1fr auto"><div style="min-width:0"><div class="t">${esc(x.title)}</div><div class="p">${fmtTime(x.at)} · ${esc(x.url || '')}</div></div><button class="btn sm" data-act="c-show" data-i="${i}">Xem</button></div>`).join('') || '<div class="muted">Chưa có.</div>'}
    </div>
  </div>`;
};
function reportHtml(rec) {
  const r = rec.report;
  const li = (a) => (a && a.length ? `<ul>${a.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<div class="muted">—</div>');
  return `<div class="card rep">
    <h3>${esc(r.title || 'Báo cáo')}<span class="sp"></span><span class="chip">${esc(r.channel || '')}</span>${r.views ? `<span class="chip g">${Number(r.views).toLocaleString('vi-VN')} views</span>` : ''}</h3>
    <div>${esc(r.summary)}</div>
    <h4>Hook</h4><div><b>${esc(r.hook && r.hook.text)}</b><div class="muted">${esc(r.hook && r.hook.technique)}</div></div>
    <h4>Cấu trúc</h4><table class="t"><tr><th>Phần</th><th>Thời điểm</th><th>Mục đích</th><th>Kỹ thuật</th></tr>${(r.structure || []).map((s) => `<tr><td>${esc(s.part)}</td><td>${esc(s.time)}</td><td>${esc(s.purpose)}</td><td>${esc(s.technique)}</td></tr>`).join('')}</table>
    <div class="grid2"><div><h4>Nhịp dựng</h4>${esc(r.pacing)}</div><div><h4>Hình ảnh</h4>${esc(r.visualStyle)}</div><div><h4>Âm thanh</h4>${esc(r.audioStyle)}</div><div><h4>Tiêu đề / Thumbnail</h4>${esc(r.titlePattern)}<br>${esc(r.thumbnailPattern)}</div></div>
    <div class="grid2"><div><h4>Vì sao hiệu quả</h4>${li(r.whyItWorks)}</div><div><h4>Điểm yếu để vượt mặt</h4>${li(r.weaknesses)}</div></div>
    <h4>Mẹo giữ chân người xem</h4>${li(r.retentionTricks)}
    <h4>Ý tưởng cho bạn</h4>
    ${(r.ideas || []).map((d, i) => `<div class="idea"><div class="row"><b>${esc(d.title)}</b><span class="sp"></span><button class="btn sm pri" data-act="c-to-project" data-i="${i}">Tạo dự án từ ý tưởng này</button></div><div class="small">${esc(d.angle)}</div><div class="small muted">Hook: ${esc(d.hook)} · ${esc(d.whyBetter)}</div></div>`).join('')}
    <div class="row end"><button class="btn" data-act="c-to-project" data-i="-1">Tạo dự án theo đề xuất chung</button></div>
  </div>`;
}
AFTER.competitor = () => {
  $('#cUrl').oninput = (e) => (S.competitor.url = e.target.value);
  $('#cNotes').oninput = (e) => (S.competitor.notes = e.target.value);
  $('#cTx').oninput = (e) => (S.competitor.transcript = e.target.value);
};

// ================= TRANG: TIẾN TRÌNH =================
PAGES.queue = () => {
  const f = S.queueFilter;
  const filt = { all: () => true, active: (t) => ['queued', 'waiting', ...ACTIVE].includes(t.status), done: (t) => t.status === 'done', failed: (t) => t.status === 'failed' }[f];
  const list = S.queue.filter(filt);
  return `<div class="head"><div><h1>Tiến trình render</h1><p>Video tự tải về thư mục dự án. Đóng app vẫn giữ hàng đợi, mở lại sẽ chạy tiếp.</p></div><span class="sp"></span>${helpBtn('queue')}${statsHtml()}</div>
  <div class="row" style="margin-bottom:12px"><div class="seg">${[['all', 'Tất cả'], ['active', 'Đang chạy/chờ'], ['done', 'Xong'], ['failed', 'Lỗi']].map(([v, l]) => `<button class="${f === v ? 'on' : ''}" data-act="q-filter" data-v="${v}">${l}</button>`).join('')}</div>
  <span class="sp"></span>${threadsHtml()}<button class="btn" data-act="q-retry-all">Thử lại tất cả lỗi</button></div>
  <div id="qlist">${list.map(qItemHtml).join('') || '<div class="empty">Trống.</div>'}</div>`;
};

// ================= TRANG: KHO VIDEO =================
PAGES.library = () => `<div class="head"><div><h1>Kho video</h1><p>Tất cả video & ảnh đã tạo xong.</p></div><span class="sp"></span>${helpBtn('library')}</div><div class="lib" id="lib"><div class="empty">Đang tải…</div></div>`;
AFTER.library = async () => {
  const items = await call('library:list');
  $('#lib').innerHTML = items.map((v) => `<div class="card v">
    ${v.kind === 'image' ? `<img src="${fileUrl(v.file)}">` : `<video src="${fileUrl(v.file)}" controls preload="metadata"></video>`}
    <div class="c"><div class="small" style="font-weight:600">${esc(v.label)}</div><div class="muted small">${esc((S.settings.modelsVideo[v.model] || S.settings.modelsImage[v.model] || {}).label || v.model)} · ${fmtTime(v.at)}</div>
    <div class="row mt"><button class="btn sm" data-act="open" data-path="${esc(v.file)}">Mở</button><button class="btn sm" data-act="reveal" data-path="${esc(v.file)}">Hiện trong thư mục</button><button class="btn sm" data-act="copy" data-text="${esc(v.prompt)}">Chép prompt</button></div></div></div>`).join('') || '<div class="empty">Chưa có video nào.</div>';
};

// ================= TRANG: BẢNG GIÁ =================
PAGES.pricing = () => {
  const pr = S.pricing;
  if (!pr) return '<div class="empty">Đang tải bảng giá…</div>';
  return `
  <div class="head"><div><h1>Bảng giá</h1><p>Gói bản quyền phần mềm (bạn tự đặt giá để bán) và chi phí thật khi tạo video.</p></div><span class="sp"></span>${helpBtn('pricing')}<button class="btn" data-act="pr-edit">✎ Sửa gói</button></div>
  <div class="plans">
    ${pr.plans.map((p) => `<div class="card plan ${p.highlight ? 'hl' : ''}">${p.highlight ? '<span class="badge">PHỔ BIẾN</span>' : ''}
      <b>${esc(p.name)}</b><div class="price">${p.price ? fmtVnd(p.price) : 'Miễn phí'} <small>/ ${esc(p.period)}</small></div>
      <ul>${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>`).join('')}
  </div>
  <div id="planEditor"></div>
  <div class="card mt">
    <h3>Chi phí tạo 1 clip theo model<span class="sp"></span>
      <span class="muted small">Gói Google:</span><div class="seg">${['pro', 'ultra'].map((v) => `<button class="${pr.rates.flowPlan === v ? 'on' : ''}" data-act="pr-plan" data-v="${v}">${v === 'pro' ? 'AI Pro' : 'AI Ultra'}</button>`).join('')}</div></h3>
    <table class="t"><tr><th>Model</th><th>Nguồn</th><th>Thời lượng</th><th>Credit</th><th>Ước tính</th><th>Ảnh tham chiếu</th><th>Ghi chú</th></tr>
      ${pr.models.map((m) => `<tr><td><b>${esc(m.label)}</b></td><td>${esc(m.provider)}</td><td>${m.seconds}s</td><td>${m.credits || '—'}</td>
        <td>${m.quotaPercent ? `~${m.quotaPercent}% hạn mức tuần (gói Muse miễn phí)` : `${fmtVnd(m.vnd)} <span class="muted">($${m.usd})</span>`}</td>
        <td>${m.maxRefs || 'Không'}</td><td class="muted small">${esc(m.note)}</td></tr>`).join('')}
    </table>
    <div class="muted small mt">Phí cố định: useapi.net $${pr.rates.useapiMonthlyUsd}/tháng cho mỗi tài khoản (Veo 3 và Muse nhập API riêng, chỉ trả cho bên bạn dùng) + gói Google AI để có credit Flow. ${esc(pr.rates.claudeNote)} Tỉ giá ${fmtVnd(pr.rates.usdToVnd)}/USD — sửa trong Cài đặt.</div>
  </div>
  <div class="card mt">
    <h3>Ước tính chi phí một dự án<span class="sp"></span><select id="prProject" style="width:260px">${projectOptions(S.pricingProject, '— Chọn dự án —')}</select></h3>
    ${pr.project ? `<div class="grid3">
      <div class="stat"><small>Số cảnh × thời lượng</small><b>${pr.project.scenes} cảnh · ${pr.project.seconds}s</b></div>
      <div class="stat g"><small>Credit Flow (gồm ~30% render lại)</small><b>${pr.project.credits || 0}</b></div>
      <div class="stat g"><small>Thành tiền ước tính</small><b>${pr.project.museQuotaPercent ? '~' + pr.project.museQuotaPercent + '% Muse' : fmtVnd(pr.project.vnd)}</b></div>
    </div>` : '<div class="muted">Chọn một dự án để xem ước tính.</div>'}
  </div>`;
};
AFTER.pricing = async () => {
  if (!S.pricing) { S.pricing = await call('pricing:get', S.pricingProject || null); render(); return; }
  $('#prProject').onchange = async (e) => { S.pricingProject = e.target.value; S.pricing = await call('pricing:get', S.pricingProject || null); render(); };
};

// ---- Bảng kết nối tiện ích Chrome (HÊU Flow Helper) ----
function bridgePanelHtml() {
  const b = S.bridge || {};
  const step = (n, ok, title, body) => `<div class="bstep ${ok ? 'ok' : ''}"><div class="bn">${ok ? '✓' : n}</div><div><b>${title}</b><div class="muted small">${body}</div></div></div>`;
  return `<div id="bridgePanel" class="col" style="gap:8px">
    <div class="muted small">HÊU điều khiển trang <b>Google Flow</b> trong Chrome bạn đang đăng nhập: tự dán prompt, bấm Tạo, tải kết quả về. Không cần token. Video tốn credit của tài khoản Google đó; ảnh Nano Banana 2.1 thường 0 credit.</div>
    ${b.error ? `<div class="keywarn"><span class="dot err"></span><span class="kt">${esc(b.error)}</span><button class="btn sm" data-act="bridge-restart">Thử lại</button></div>` : ''}
    ${step(1, b.extInstalled, 'Lấy tiện ích', `<button class="btn sm" data-act="bridge-install">📁 Mở thư mục tiện ích</button> HÊU chép tiện ích ra thư mục và mở sẵn.`)}
    ${step(2, b.connected, 'Cài vào Chrome', `Mở <kbd>chrome://extensions</kbd> → bật <b>Developer mode</b> (góc phải) → <b>Load unpacked</b> → chọn thư mục vừa mở. <button class="btn sm" data-act="copy" data-text="chrome://extensions">Chép địa chỉ</button>`)}
    ${step(3, b.connected, 'Nhập mã ghép nối', `Bấm biểu tượng <b>HÊU Flow Helper</b> trên Chrome, dán mã <kbd class="bkey">${esc(b.key || S.settings.flowBridgeKey || '')}</kbd> <button class="btn sm" data-act="copy" data-text="${esc(b.key || S.settings.flowBridgeKey || '')}">Chép mã</button> rồi bấm “Lưu & kết nối”.`)}
    ${step(4, b.connected && b.flowTab, 'Mở một dự án Google Flow', `Đăng nhập Google trong Chrome, mở <b>flow.google.com</b> và vào (hoặc tạo) một dự án. Giữ tab đó mở. <button class="btn sm" data-act="url" data-u="https://flow.google.com/">Mở Flow</button>`)}
    <div class="row small"><span class="dot ${b.connected && b.flowTab ? 'ok' : b.connected ? 'warn' : ''}"></span>
      ${b.connected ? (b.flowTab ? 'Sẵn sàng — Chrome đã nối và đang mở dự án Flow' : 'Đã nối Chrome — còn thiếu tab dự án Flow') : 'Chưa thấy tiện ích Chrome kết nối'}
      ${b.note ? `<span class="muted">· ${esc(b.note)}</span>` : ''}<span class="sp"></span>
      <button class="btn sm" data-act="bridge-newkey" title="Tạo mã mới (phải dán lại vào tiện ích)">Đổi mã</button></div>
  </div>`;
}
async function refreshBridge() {
  try { S.bridge = await window.h2.call('bridge:status'); } catch { return; }
  const el = document.getElementById('bridgePanel');
  if (el && S.page === 'settings') el.outerHTML = bridgePanelHtml();
  updateSide();
}
window.h2.on('bridge:status', () => refreshBridge());
setInterval(() => { if (S.settings && S.settings.veoMode === 'extension') refreshBridge(); }, 3000);

// ================= TRANG: CÀI ĐẶT =================
PAGES.settings = () => {
  const s = S.settings;
  const inp = (k, label, type = 'text', ph = '') => `<label class="f"><span>${label}</span><input type="${type}" data-set="${k}" value="${esc(s[k] ?? '')}" placeholder="${esc(ph)}"></label>`;
  return `
  <div class="head"><div><h1>Cài đặt</h1><p>Phiên bản ${esc(s.appVersion)}</p></div></div>
  <div class="grid2">
    <div class="card col full">
      <h3>① API tạo video — nhập riêng cho từng model<span class="sp"></span>${helpBtn('api')}</h3>
      <div class="muted small">Veo 3 và Meta Muse dùng <b>2 API riêng</b>. Bạn dùng model nào thì chỉ cần nhập API của model đó — <b>không bắt buộc nhập cả hai</b>. Model chưa có API sẽ hiện chữ “chưa nhập API” trong danh sách chọn model.</div>
      <div class="grid2">
        <div class="card col apibox ${hasKey('flow') ? 'on' : ''}">
          <div class="row"><b>🎬 Veo 3 (Google Flow)</b><span class="sp"></span><span class="chip ${hasKey('flow') ? 'g' : ''}">${s.veoMode === 'extension' ? 'Qua Chrome' : hasKey('flow') ? '✓ Đã nhập' : 'Chưa nhập'}</span></div>
          <div class="muted small">Dùng cho: <b>Veo 3.1 Fast / Lite / Quality</b>, <b>Omni Flash</b> và ảnh <b>Nano Banana</b>.</div>
          <div class="row"><span class="small muted">Cách chạy:</span><div class="seg">
            <button class="${s.veoMode === 'extension' ? 'on' : ''}" data-act="veo-mode" data-v="extension">Tiện ích Chrome (tài khoản Flow của bạn)</button>
            <button class="${s.veoMode !== 'extension' ? 'on' : ''}" data-act="veo-mode" data-v="useapi">Token useapi.net</button></div></div>
          ${s.veoMode === 'extension' ? bridgePanelHtml() : `
          ${inp('veoToken', 'API Veo 3 (token useapi.net — bắt đầu bằng user:)', 'password', 'user:12345-…')}
          ${inp('flowEmail', 'Email tài khoản Google Flow (bỏ trống = tự chọn)', 'text', 'ban@gmail.com')}
          <div class="row"><button class="btn" data-act="api-test" data-w="flow">Kiểm tra Veo 3</button>${s.veoToken ? '<button class="btn sm danger" data-act="key-clear" data-k="veoToken">Xóa API</button>' : ''}<span id="apiRes_flow" class="small muted"></span></div>
          <div class="small"><a href="#" data-act="url" data-u="https://useapi.net/docs/start-here/setup-useapi">Cách lấy token</a> · <a href="#" data-act="url" data-u="https://useapi.net/docs/start-here/setup-google-flow">Thêm tài khoản Google Flow</a></div>`}
        </div>
        <div class="card col apibox ${hasKey('muse') ? 'on' : ''}">
          <div class="row"><b>🎞 API Meta Muse</b><span class="sp"></span><span class="chip ${hasKey('muse') ? 'g' : ''}">${hasKey('muse') ? '✓ Đã nhập' : 'Chưa nhập'}</span></div>
          <div class="muted small">Dùng cho: video <b>Meta Muse</b> (~10 giây có tiếng) và ảnh <b>Meta Muse Image</b>. Gói Muse miễn phí làm được khoảng 30–50 video/tuần.</div>
          ${inp('museToken', 'API Meta Muse (token useapi.net của tài khoản có Muse)', 'password', 'user:12345-…')}
          ${inp('museEmail', 'Email tài khoản Meta Muse (cần để kiểm tra hạn mức)', 'text', 'ban@gmail.com')}
          <div class="row"><button class="btn" data-act="api-test" data-w="muse">Kiểm tra Muse</button>${hasKey('muse') ? '<button class="btn sm danger" data-act="key-clear" data-k="museToken">Xóa API</button>' : ''}<span id="apiRes_muse" class="small muted"></span></div>
          <div class="small"><a href="#" data-act="url" data-u="https://useapi.net/docs/start-here/setup-useapi">Cách lấy token</a> · <a href="#" data-act="url" data-u="https://useapi.net/docs/start-here/setup-muse">Thêm tài khoản Muse</a></div>
        </div>
      </div>
      <div class="muted small">Mẹo: nếu cùng một tài khoản useapi.net có cả Flow và Muse thì dán cùng một token vào cả hai ô. Nếu dùng 2 tài khoản khác nhau thì mỗi ô một token.</div>
    </div>
    <div class="card col">
      <h3>② Claude trên máy (viết kịch bản, khóa nhân vật, phân tích)</h3>
      <div class="muted small">App gọi Claude Code cài trên máy này, chạy bằng gói Claude Pro/Max của bạn — không cần API key. Cài 1 lần: mở PowerShell, chạy <kbd>irm https://claude.ai/install.ps1 | iex</kbd>, rồi gõ <kbd>claude</kbd> để đăng nhập.</div>
      ${inp('claudePath', 'Đường dẫn lệnh claude (bỏ trống = tự tìm)', 'text', 'C:\\Users\\…\\.local\\bin\\claude.exe')}
      ${inp('claudeModel', 'Model Claude (bỏ trống = mặc định)', 'text', 'opus / sonnet')}
      <div class="row"><button class="btn" data-act="claude-test">Kiểm tra Claude</button><span id="claudeRes" class="small muted"></span></div>
      <hr>
      <b>Dùng Claude Desktop</b>
      <div class="muted small">Gắn app vào Claude Desktop để Claude đọc dự án và ghi kịch bản/nhân vật ngược lại — chỉ cần chat “viết kịch bản cho dự án X”.</div>
      <div class="row"><span id="mcpRes" class="small">${S.mcp ? (S.mcp.installed ? '<span class="dot ok"></span>Đã kết nối' : '<span class="dot"></span>Chưa kết nối') : ''}</span><span class="sp"></span>
        <button class="btn" data-act="mcp-install">${S.mcp && S.mcp.installed ? 'Kết nối lại' : 'Kết nối Claude Desktop'}</button>
        ${S.mcp && S.mcp.installed ? '<button class="btn sm danger" data-act="mcp-uninstall">Gỡ</button>' : ''}</div>
    </div>
    <div class="card col">
      <h3>③ Render</h3>
      <div class="grid3">${inp('maxParallel', 'Tổng số luồng (1–10)', 'number')}${inp('maxParallelFlow', 'Luồng tối đa cho Veo/Flow', 'number')}${inp('maxParallelMuse', 'Luồng tối đa cho Meta Muse', 'number')}</div>
      <div class="muted small">Muse mặc định chỉ cho 2 job cùng lúc mỗi tài khoản — đặt cao hơn chỉ có ích khi bạn đã tăng maxJobs trên useapi.net hoặc có nhiều tài khoản. Máy bạn: ${S.settings.system ? S.settings.system.ramGB + ' GB RAM, ' + S.settings.system.cpus + ' nhân CPU' : ''}. Render chạy trên máy chủ Google/Meta nên số luồng không làm nặng máy, chỉ bước tải về và ghép phim dùng máy.</div>
      <div class="grid2">${inp('retries', 'Tự thử lại khi lỗi', 'number')}${inp('crossfade', 'Chuyển cảnh mờ khi ghép (giây)', 'number')}</div>
      <label class="f"><span>File ffmpeg.exe (bỏ trống = dùng bản đi kèm app)</span><div class="row"><input type="text" data-set="ffmpegPath" value="${esc(s.ffmpegPath || '')}" placeholder="C:\\ffmpeg\\bin\\ffmpeg.exe" style="flex:1"><button class="btn" data-act="pick-ffmpeg">Chọn…</button></div></label>
      <label class="f"><span>Model mặc định cho dự án mới</span><select data-set="defaultModel">${modelOptions(s.defaultModel)}</select></label>
      <label class="f"><span>Thư mục lưu dự án & video</span><div class="row"><input type="text" value="${esc(s.workspace)}" readonly style="flex:1"><button class="btn" data-act="pick-ws">Đổi…</button></div></label>
      <label class="row small"><input type="checkbox" data-set="notify" ${s.notify ? 'checked' : ''}> Thông báo Windows khi video xong / lỗi</label>
    </div>
    <div class="card col">
      <h3>④ Đơn giá (cho Bảng giá)</h3>
      <div class="grid2">
        <label class="f"><span>Tỉ giá VNĐ / USD</span><input type="number" data-rate="usdToVnd" value="${s.rates.usdToVnd}"></label>
        <label class="f"><span>Phí useapi.net / tháng (USD)</span><input type="number" data-rate="useapiMonthlyUsd" value="${s.rates.useapiMonthlyUsd}"></label>
        <label class="f"><span>Giá 1 credit Flow — gói Pro (USD)</span><input type="number" step="0.001" data-rate="flowCreditUsdPro" value="${s.rates.flowCreditUsdPro}"></label>
        <label class="f"><span>Giá 1 credit Flow — gói Ultra (USD)</span><input type="number" step="0.001" data-rate="flowCreditUsdUltra" value="${s.rates.flowCreditUsdUltra}"></label>
      </div>
    </div>
  </div>`;
};
AFTER.settings = async () => {
  $$('[data-set]').forEach((el) => (el.onchange = async () => {
    const k = el.dataset.set;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number') v = Number(v);
    S.settings = { ...S.settings, ...(await call('settings:set', { [k]: v })) };
    toast('Đã lưu');
    updateSide();
    if (k === 'veoToken' || k === 'museToken') render();
  }));
  $$('[data-rate]').forEach((el) => (el.onchange = async () => {
    const rates = { ...S.settings.rates, [el.dataset.rate]: Number(el.value) };
    S.settings = { ...S.settings, ...(await call('settings:set', { rates })) };
    S.pricing = null;
    toast('Đã lưu đơn giá');
  }));
  if (!S.mcp) { S.mcp = await call('mcp:status'); render(); }
};

// ================= TRANG: HƯỚNG DẪN =================
PAGES.guide = () => {
  const toc = [
    ['start', 'Bắt đầu nhanh'], ['api', 'Nhập API Veo 3 / Muse'], ['chrome', 'Veo 3 qua Chrome'], ['models', 'Chọn model'],
    ['quick', 'Tạo nhanh'], ['projects', 'Dự án'], ['tab-idea', '① Ý tưởng'], ['tab-cast', '② Nhân vật'],
    ['tab-script', '③ Kịch bản'], ['tab-check', '④ Kiểm tra'], ['tab-render', '⑤ Render & ghép'],
    ['competitor', 'Phân tích đối thủ'], ['queue', 'Tiến trình render'], ['library', 'Kho video'],
    ['pricing', 'Bảng giá'], ['settings', 'Cài đặt'], ['errors', 'Lỗi thường gặp'], ['tips', 'Mẹo']
  ];
  const sec = (id, title, body) => `<div class="card guide" id="g_${id}"><h3>${title}</h3>${body}</div>`;
  const tool = (name, what, how) => `<div class="gtool"><b>${name}</b><div>${what}</div>${how ? `<div class="muted small">Cách dùng: ${how}</div>` : ''}</div>`;
  const keyChip = (pv) => `<span class="chip ${hasKey(pv) ? 'g' : 'w'}">${pv === 'muse' ? 'API Muse' : 'API Veo 3'} ${hasKey(pv) ? '✓' : '— chưa nhập'}</span>`;
  const vm = S.settings.modelsVideo;
  const im = S.settings.modelsImage;
  return `
  <div class="head"><div><h1>Hướng dẫn sử dụng</h1><p>Cách dùng và tác dụng của từng công cụ trong HÊU. Bấm một mục để nhảy tới.</p></div></div>
  <div class="gtoc">${toc.map(([id, l]) => `<button class="chip" data-act="g-jump" data-s="${id}">${l}</button>`).join('')}</div>
  <div class="col">

  ${sec('start', '🚀 Bắt đầu nhanh (5 phút)', `<ol>
    <li><b>Chọn bên bạn sẽ dùng</b>: Veo 3 (Google Flow) hay Meta Muse — hoặc cả hai. Chỉ cần nhập API của bên mình dùng.</li>
    <li>Vào <b>Cài đặt → ① API tạo video</b>, dán token vào ô <b>API Veo 3</b> và/hoặc ô <b>API Meta Muse</b>, bấm <b>Kiểm tra</b> ngay dưới ô đó.</li>
    <li>Cài <b>Claude Code</b> (PowerShell: <kbd>irm https://claude.ai/install.ps1 | iex</kbd>), gõ <kbd>claude</kbd> để đăng nhập gói Pro/Max, rồi vào Cài đặt bấm <b>Kiểm tra Claude</b>. Claude dùng để viết kịch bản, khóa nhân vật, phân tích — không có Claude vẫn tạo video nhanh được.</li>
    <li>Thử ngay ở <b>Tạo nhanh</b>: gõ 1 câu mô tả, chọn model có API, bấm <b>Tạo video ➤</b>.</li>
    <li>Làm phim dài nhiều cảnh nhất quán nhân vật: dùng <b>Dự án</b> (5 bước).</li>
  </ol>
  <div class="small">Trạng thái hiện tại: ${keyChip('flow')} ${keyChip('muse')}</div>`)}

  ${sec('api', '🔑 Nhập API riêng cho Veo 3 và Meta Muse', `
    <p>HÊU có <b>2 ô API tách riêng</b>. App chỉ đòi API của <b>đúng model bạn đang chọn</b>:</p>
    <ul>
      <li><b>API Veo 3</b> → dùng cho Veo 3.1 Fast / Lite / Quality, Gemini Omni Flash và ảnh Nano Banana Pro / Nano Banana 2 / Imagen 4.</li>
      <li><b>API Meta Muse</b> → dùng cho video Meta Muse và ảnh Meta Muse Image.</li>
      <li>Chỉ dùng Veo 3 → chỉ nhập API Veo 3. Chỉ dùng Muse → chỉ nhập API Muse. Model chưa có API sẽ ghi “— chưa nhập API” trong danh sách chọn, và app nhắc bạn trước khi gửi (không mất credit).</li>
    </ul>
    <b>Lấy API Veo 3</b><ol>
      <li>Đăng ký useapi.net, lấy API token (dạng <kbd>user:12345-…</kbd>).</li>
      <li>Trên useapi.net thêm tài khoản Google Flow — tài khoản Google cần gói <b>Google AI Pro hoặc Ultra</b> để có credit Veo.</li>
      <li>Dán token vào ô <b>API Veo 3</b>, (tùy chọn) nhập email Google Flow nếu bạn có nhiều tài khoản, bấm <b>Kiểm tra Veo 3</b>.</li>
    </ol>
    <b>Lấy API Meta Muse</b><ol>
      <li>Đăng ký useapi.net (có thể là tài khoản khác với bên Veo), lấy API token.</li>
      <li>Thêm tài khoản Meta Muse (đăng nhập được bằng email + mật khẩu). Gói miễn phí ~30–50 video/tuần.</li>
      <li>Dán token vào ô <b>API Meta Muse</b>, nhập <b>email Muse</b> (để app xem hạn mức tuần), bấm <b>Kiểm tra Muse</b>.</li>
    </ol>
    <div class="muted small">Một tài khoản useapi.net có cả Flow và Muse thì dán cùng một token vào cả hai ô. Nút <b>Xóa API</b> gỡ token khỏi máy. Token chỉ lưu trên máy bạn.</div>
    <div class="row mt"><button class="btn pri" data-act="go-settings">Mở Cài đặt để nhập API</button></div>`)}

  ${sec('chrome', '🧩 Veo 3 qua Chrome — dùng tài khoản Google Flow của bạn, không cần token', `
    <p>Chế độ <b>Tiện ích Chrome</b>: HÊU giao từng prompt cho tiện ích <b>HÊU Flow Helper</b>. Tiện ích dán prompt vào trang Google Flow bạn đang mở, chọn đúng model / khung hình, bấm Tạo như bạn bấm tay, chờ xong rồi gửi file về HÊU (vào hàng đợi, kho video, cảnh của dự án như bình thường).</p>
    <b>Cài một lần</b><ol>
      <li>Cài đặt → khung Veo 3 → chọn <b>Tiện ích Chrome</b> → bấm <b>📁 Mở thư mục tiện ích</b>.</li>
      <li>Trong Chrome mở <kbd>chrome://extensions</kbd>, bật <b>Developer mode</b>, bấm <b>Load unpacked</b>, chọn thư mục vừa mở.</li>
      <li>Bấm biểu tượng HÊU Flow Helper trên thanh Chrome, dán <b>mã ghép nối</b> hiện trong Cài đặt, bấm <b>Lưu & kết nối</b>.</li>
      <li>Mở <b>flow.google.com</b>, vào một <b>dự án</b> (không phải trang chủ) và giữ tab đó mở. 4 bước trong Cài đặt chuyển xanh là xong.</li>
    </ol>
    <b>Khi chạy</b><ul>
      <li>Làm <b>lần lượt từng việc</b> (một tab Flow) — chậm hơn useapi nhưng không tốn phí trung gian.</li>
      <li>Chrome hiện dòng “HÊU Flow Helper đang gỡ lỗi trình duyệt” lúc bấm nút — đó là cách gửi cú bấm thật vào Flow, bình thường. Đừng mở F12 trên tab Flow.</li>
      <li>Nếu Google hỏi xác minh, bạn tự xác minh trong tab Flow; việc sẽ chạy tiếp hoặc bấm “Thử lại”.</li>
      <li>Credit: ảnh Nano Banana 2.1 thường 0 credit; video Veo trừ credit của tài khoản Google (tài khoản miễn phí có thể không đủ).</li>
      <li>Bản này <b>chưa gửi ảnh tham chiếu và khung đầu</b> sang Flow — prompt vẫn có đầy đủ mô tả nhân vật đã khóa.</li>
      <li>Có lỗi lạ: bấm biểu tượng tiện ích → <b>Dò giao diện Flow</b> và gửi kết quả cho người hỗ trợ (Flow đổi giao diện thì cần cập nhật tiện ích).</li>
    </ul>
    <div class="row mt"><button class="btn pri" data-act="go-settings">Mở Cài đặt để nối Chrome</button></div>`)}

  ${sec('models', '🎛 Chọn model nào?', `
    <table class="t"><tr><th>Model</th><th>Cần API</th><th>Thời lượng</th><th>Ảnh tham chiếu</th><th>Khi nào dùng</th></tr>
    ${Object.values(vm).map((m) => `<tr><td><b>${esc(m.label)}</b></td><td>${keyChip(m.provider === 'muse' ? 'muse' : 'flow')}</td><td>${m.durations.join(' / ')} giây</td><td>${m.maxRefs ? 'tối đa ' + m.maxRefs : 'không'}</td><td>${esc(m.note || '')}</td></tr>`).join('')}
    </table>
    <div class="mt"><b>Model ảnh</b> (bảng nhân vật, ảnh bối cảnh, tab Ảnh ở Tạo nhanh):</div>
    <ul>${Object.values(im).map((m) => `<li><b>${esc(m.label)}</b> — ${m.provider === 'muse' ? 'API Muse' : 'API Veo 3'}, ${m.maxRefs ? 'nhận tối đa ' + m.maxRefs + ' ảnh mẫu' : 'không nhận ảnh mẫu'}</li>`).join('')}</ul>`)}

  ${sec('quick', '✦ Tạo nhanh — làm hàng loạt video/ảnh như ViraAI', `
    ${tool('Ô mô tả (prompt)', 'Mỗi đoạn văn = 1 video. Các video cách nhau <b>1 dòng trắng</b> (Enter 2 lần). Chip xanh góc phải đếm số video sẽ tạo.', 'tả cảnh, ánh sáng, chuyển động máy quay, lời thoại đặt trong ngoặc kép. Nên viết tiếng Anh cho model hiểu tốt nhất.')}
    ${tool('Chọn dự án + gõ @', 'Chọn một dự án ở ô trên cùng, rồi gõ <kbd>@</kbd> trong prompt để chèn nhân vật đã khóa. App tự thay @tag bằng mô tả ngoại hình đầy đủ và gửi kèm ảnh tham chiếu → nhân vật giống nhau giữa các video.', 'gõ @, dùng ↑ ↓ chọn, Enter để chèn.')}
    ${tool('Video / Ảnh', 'Chuyển giữa tạo video và tạo ảnh. Chế độ Ảnh có thêm khung 1:1.', '')}
    ${tool('+ Ảnh tham chiếu', 'Gửi kèm ảnh nhân vật/đồ vật để model vẽ giống. Số ảnh tối đa tùy model (xem bảng Chọn model).', 'bấm, chọn file PNG/JPG/WEBP; bấm ✕ để bỏ.')}
    ${tool('+ Đầu → Cuối (khung đầu)', 'Dùng 1 ảnh làm khung hình mở đầu video đầu tiên — video sẽ “chuyển động” từ chính ảnh đó.', 'chỉ áp dụng cho video đầu tiên trong danh sách. Với Veo, khi có khung đầu thì không gửi kèm ảnh tham chiếu được (Muse thì được cả hai).')}
    ${tool('Model + thời lượng', 'Chọn model video và số giây. Danh sách thời lượng thay đổi theo model.', 'model ghi “chưa nhập API” là model bạn chưa có API → vào Cài đặt nhập API đúng bên đó.')}
    ${tool('16:9 / 9:16', 'Khung ngang (YouTube) hoặc dọc (Shorts, TikTok, Reels).', '')}
    ${tool('⚡ Số luồng', 'Số video render cùng lúc. Render chạy trên máy chủ Google/Meta nên không làm nặng máy. Muse tối đa 2 luồng mỗi tài khoản.', '')}
    ${tool('✨ Claude chuốt prompt', 'Claude viết lại toàn bộ prompt cho rõ ràng, đồng nhất nhân vật và phong cách, giữ đúng số video.', 'bấm, gõ hướng muốn chỉnh (hoặc bỏ trống), đọc lại rồi mới bấm Tạo.')}
    ${tool('Tạo video ➤ / Tạo ảnh ➤', 'Đưa tất cả vào hàng đợi render. Video xong tự tải về máy, hiện ở bảng bên phải và trong Kho video.', '')}`)}

  ${sec('projects', '▣ Dự án — làm một phim nhiều cảnh nhất quán', `
    <p>Mỗi dự án = 1 phim. Làm lần lượt 5 tab: <b>Ý tưởng → Nhân vật → Kịch bản → Kiểm tra → Render & ghép</b>. Mọi thứ tự lưu.</p>
    ${tool('＋ Tạo dự án mới', 'Tạo dự án trống với tên và chủ đề.', 'gõ tên + chủ đề càng cụ thể càng tốt, bấm Tạo dự án.')}
    ${tool('⧉ Nhân bản', 'Sao chép dự án: giữ nhân vật + kịch bản (làm biến thể), giữ cả video, hoặc chỉ giữ nhân vật để viết “Phần 2”. Ảnh tham chiếu luôn được chép sang nên nhân vật giống hệt.', '')}
    ${tool('Xóa / 🗑 Thùng rác', 'Xóa đưa dự án vào Thùng rác, khôi phục được. “Xóa vĩnh viễn” mới xóa hẳn ảnh và video.', '')}
    ${tool('Thư mục', 'Mở thư mục dự án trên máy (ảnh, video, bản xuất).', '')}`)}

  ${sec('tab-idea', '① Ý tưởng & phong cách', `
    ${tool('Chủ đề, mục tiêu, thể loại, khán giả', 'Claude bám chặt các thông tin này khi viết — chủ đề càng rõ, phim càng không lan man.', '')}
    ${tool('Ngôn ngữ thoại / Kiểu âm thanh', 'Nhân vật nói thoại, giọng dẫn chuyện, hoặc không lời (chỉ nhạc/SFX).', '')}
    ${tool('Độ dài phim', 'Số giây mong muốn — Claude tự chia số cảnh theo thời lượng của model.', '')}
    ${tool('Model video + khung hình', 'Model dùng cho cả dự án. Nếu model thuộc bên chưa nhập API, app hiện cảnh báo vàng kèm nút nhập API.', '')}
    ${tool('Khóa phong cách', 'Phong cách hình ảnh, bảng màu, ánh sáng, máy quay, thế giới, danh sách cấm. Phần này được <b>chèn nguyên văn vào mọi prompt</b> để mọi cảnh cùng một “look”.', 'viết tiếng Anh, ngắn gọn, cụ thể (VD: “2D flat vector, thick outlines, warm pastel palette”).')}
    ${tool('✨ Claude dựng phong cách & nhân vật', 'Claude đọc chủ đề rồi điền khóa phong cách, tạo nhân vật và bối cảnh. Có ô “yêu cầu thêm” để định hướng.', 'bấm xong sẽ tự chuyển sang tab Nhân vật.')}`)}

  ${sec('tab-cast', '② Nhân vật & bối cảnh', `
    ${tool('Khóa nhận dạng', 'Mô tả ngoại hình cố định (mặt, tóc, mắt, dáng, dấu riêng) + trang phục. App chèn nguyên văn vào mọi cảnh có nhân vật này → không bị “đổi mặt”.', 'càng cụ thể càng giống. Viết tiếng Anh.')}
    ${tool('Tag @… / #…', 'Mã gọi nhân vật (@) và bối cảnh (#) dùng trong kịch bản và trang Tạo nhanh.', '')}
    ${tool('Prompt ảnh tham chiếu', 'Sinh sẵn prompt cho: bảng nhân vật 4 góc, ảnh cận mặt, bảng biểu cảm (và ảnh bối cảnh). Có nút Sao chép để dùng ở nơi khác.', 'chọn model ảnh, tick “dùng ảnh đã có làm mẫu” nếu muốn giữ đúng mặt, bấm Tạo ảnh — ảnh tự gắn vào nhân vật.')}
    ${tool('Ảnh tham chiếu (＋, ★ chính, ✕)', 'Ảnh viền xanh là <b>ảnh chính</b> gửi cho model ở mọi cảnh. Nên có 1 bảng 4 góc + 1 ảnh cận mặt.', '＋ thêm ảnh từ máy, ★ đặt làm ảnh chính, ✕ xóa.')}
    ${tool('✨ Claude hoàn thiện', 'Claude bổ sung/chuốt lại nhân vật và bối cảnh còn thiếu.', '')}`)}

  ${sec('tab-script', '③ Kịch bản', `
    ${tool('✨ Claude viết kịch bản', 'Claude viết kịch bản liền mạch, chia cảnh vừa thời lượng model, mỗi cảnh có khung mở/kết rõ để cảnh sau nối đúng cảnh trước.', 'điền số cảnh (bỏ trống = tự tính) và yêu cầu thêm (twist, hài…). Viết lại sẽ thay toàn bộ cảnh.')}
    ${tool('Thẻ cảnh', 'Bấm vào tiêu đề cảnh để mở: giây, nhịp, cách nối, bối cảnh, nhân vật có mặt, khung mở/kết, hành động, thoại, máy quay, âm thanh, không khí.', 'KHÔNG tả ngoại hình nhân vật trong hành động — app tự chèn khóa nhận dạng.')}
    ${tool('Cách nối', '<b>Nối liền</b>: lấy khung cuối cảnh trước làm khung đầu (liền mạch tuyệt đối). <b>Cắt cảnh</b>: dùng ảnh tham chiếu. <b>Nhảy thời gian</b>: chuyển cảnh có khoảng cách thời gian.', '')}
    ${tool('Lời thoại', 'Mỗi dòng: ai nói (@tag/Narrator), câu thoại, cách nói. Chip 💬 đếm số từ — clip 8 giây chỉ chứa ~16 từ.', '')}
    ${tool('Prompt tự viết', 'Ghi đè prompt của cảnh. Bỏ trống để app tự ghép (khuyên dùng vì có khóa nhân vật).', '')}
    ${tool('↑ ↓ / Tắt cảnh / Xóa', 'Đổi thứ tự, tạm bỏ cảnh khỏi render và ghép phim, hoặc xóa.', '')}
    ${tool('✨ Claude viết lại cảnh', 'Sửa riêng 1 cảnh theo yêu cầu, giữ mạch với cảnh trước/sau.', 'gõ “muốn sửa gì” rồi bấm.')}`)}

  ${sec('tab-check', '④ Prompt & kiểm tra', `
    ${tool('Kiểm tra tự động', 'Miễn phí, tức thì: báo thoại quá dài, thiếu ảnh tham chiếu, model không nhận ảnh, sai thời lượng…', 'sửa hết lỗi đỏ trước khi render.')}
    ${tool('Cách nối cảnh', '<b>Tự động</b> (khuyên dùng), <b>Ảnh tham chiếu</b> (giữ mặt), <b>Khung cuối → đầu</b> (liền mạch nhất, dùng cho Veo Lite/Quality vì không nhận ảnh tham chiếu).', '')}
    ${tool('✨ Claude kiểm tra', 'Claude đọc toàn bộ phong cách + kịch bản + prompt cuối, chấm điểm, chỉ ra chỗ lệch chủ đề, lệch nhân vật, đứt mạch và đề xuất sửa từng trường.', 'tick các sửa muốn dùng → “Áp dụng sửa đã chọn”. Mục tiêu điểm ≥ 85 — đỡ tốn credit render lại.')}
    ${tool('Prompt cuối cùng', 'Đúng nội dung sẽ gửi cho model, kèm ảnh tham chiếu và cảnh báo. Có nút Sao chép.', '')}`)}

  ${sec('tab-render', '⑤ Render & ghép phim', `
    ${tool('Render cảnh chưa có video', 'Chỉ render cảnh chưa có bản nào — tiết kiệm credit.', 'cần API đúng bên của model dự án.')}
    ${tool('Render lại tất cả / ▶ Render / ↻ Render thêm bản', 'Render toàn bộ hoặc từng cảnh. Mỗi lần render thêm 1 “bản” để bạn chọn bản đẹp nhất.', '')}
    ${tool('Ước tính chi phí', 'Credit Flow / % hạn mức Muse dự kiến, đã cộng ~30% render lại.', '')}
    ${tool('Chọn bản (viền xanh)', 'Rê chuột lên để xem thử, bấm để chọn bản dùng khi ghép.', '')}
    ${tool('🎞 Ghép phim', 'Ghép các bản đã chọn theo thứ tự cảnh bằng FFmpeg, chuẩn hóa 1080p 24fps, giữ âm thanh gốc. Có thể đặt chuyển cảnh mờ trong Cài đặt.', 'bấm “Mở thư mục xuất” để lấy file MP4.')}`)}

  ${sec('competitor', '◎ Phân tích đối thủ', `
    ${tool('Link video', 'Dán link YouTube/TikTok. App tự lấy tiêu đề, lượt xem và phụ đề.', '')}
    ${tool('Bạn muốn rút ra gì?', 'Định hướng cho Claude (VD: làm kênh tương tự với nhân vật người Việt).', '')}
    ${tool('Dán kịch bản / phụ đề thủ công', 'Dùng khi video không có phụ đề.', '')}
    ${tool('✨ Phân tích', 'Claude mổ xẻ hook, cấu trúc theo thời gian, nhịp dựng, hình ảnh, âm thanh, kiểu tiêu đề/thumbnail, vì sao viral, điểm yếu để vượt mặt và đưa ý tưởng mới.', '')}
    ${tool('Tạo dự án từ ý tưởng này', 'Tạo luôn dự án mới đã gắn báo cáo — Claude sẽ dùng báo cáo khi dựng phong cách và viết kịch bản.', '')}
    ${tool('Đã phân tích', 'Danh sách báo cáo cũ, bấm Xem để mở lại.', '')}`)}

  ${sec('queue', '≡ Tiến trình render', `
    ${tool('Bộ lọc', 'Tất cả / Đang chạy-chờ / Xong / Lỗi.', '')}
    ${tool('⏸ Tạm dừng / ▶ Tiếp tục', 'Dừng nhận việc mới (việc đang chạy vẫn chạy nốt).', '')}
    ${tool('Thử lại / Thử lại tất cả lỗi', 'Gửi lại task lỗi. Lỗi tạm thời (mạng, máy chủ bận) app đã tự thử lại theo số lần trong Cài đặt.', '')}
    ${tool('Hủy / Dọn task xong', 'Hủy task đang chờ/chạy; dọn các task đã xong khỏi danh sách (file video vẫn còn).', '')}
    <div class="muted small">Đóng app vẫn giữ hàng đợi, mở lại sẽ chạy tiếp. Video tự tải về thư mục dự án.</div>`)}

  ${sec('library', '▶ Kho video', `
    ${tool('Xem / Mở / Hiện trong thư mục', 'Tất cả video và ảnh đã tạo xong, xem ngay trong app.', '')}
    ${tool('Chép prompt', 'Sao chép prompt đã tạo ra video đó để dùng lại hoặc chỉnh tiếp.', '')}`)}

  ${sec('pricing', '◆ Bảng giá', `
    ${tool('Gói bán phần mềm', 'Các gói bạn tự đặt giá để bán HÊU cho khách.', 'bấm ✎ Sửa gói, mỗi dòng: Tên | Giá | kỳ hạn | x (nổi bật) | tính năng; cách nhau bằng dấu ;')}
    ${tool('Chi phí theo model', 'Credit/giây và tiền VNĐ ước tính cho từng model.', 'đơn giá sửa ở Cài đặt → ④ Đơn giá.')}
    ${tool('Ước tính một dự án', 'Chọn dự án để xem tổng credit và tiền dự kiến.', '')}`)}

  ${sec('settings', '⚙ Cài đặt', `
    ${tool('① API tạo video', '2 ô riêng: API Veo 3 và API Meta Muse, mỗi ô có nút Kiểm tra và Xóa API. Chỉ cần nhập bên bạn dùng.', '')}
    ${tool('② Claude trên máy', 'Đường dẫn lệnh claude (bỏ trống = tự tìm), model Claude (opus/sonnet), nút Kiểm tra Claude.', '')}
    ${tool('Kết nối Claude Desktop', 'Gắn HÊU vào Claude Desktop: chat “viết kịch bản cho dự án X” là Claude đọc/ghi thẳng vào app.', 'bấm Kết nối, thoát hẳn Claude Desktop rồi mở lại.')}
    ${tool('③ Render', 'Tổng số luồng, luồng riêng Veo/Muse, số lần tự thử lại, chuyển cảnh mờ khi ghép, file ffmpeg, model mặc định, thư mục lưu, thông báo Windows.', '')}
    ${tool('④ Đơn giá', 'Tỉ giá, phí useapi.net, giá credit Flow — dùng cho Bảng giá và ước tính.', '')}`)}

  ${sec('errors', '🩺 Lỗi thường gặp', `<ul>
    <li><b>“Model này dùng Veo 3/Muse nhưng bạn chưa nhập API”</b> → vào Cài đặt nhập đúng ô của model đó, hoặc đổi sang model của bên đã có API.</li>
    <li><b>401 – Sai hoặc thiếu API</b> → token sai/hết hạn. Dán lại token đúng vào ô của bên báo lỗi rồi bấm Kiểm tra.</li>
    <li><b>402</b> → gói useapi.net hết hạn, gia hạn trên useapi.net.</li>
    <li><b>403 / 422</b> → prompt hoặc ảnh bị bộ lọc nội dung. Sửa câu chữ: tránh bạo lực, người thật nổi tiếng, thương hiệu.</li>
    <li><b>412 (Muse)</b> → hết hạn mức tuần. Chờ reset hoặc thêm tài khoản Muse khác.</li>
    <li><b>596</b> → tài khoản Google/Meta bị đăng xuất, cần đăng nhập lại trên useapi.net.</li>
    <li><b>“Cảnh trước bị lỗi nên không lấy được khung cuối”</b> → render lại cảnh trước, hoặc đổi cách nối sang “Ảnh tham chiếu”.</li>
    <li><b>Claude chưa chạy được</b> → mở PowerShell gõ <kbd>claude</kbd> đăng nhập lại; tài khoản phải là Pro/Max.</li>
  </ul>`)}

  ${sec('tips', '💡 Mẹo', `<ul>
    <li>Clip 8 giây chỉ chứa ~16 từ thoại; thoại dài sẽ bị cắt.</li>
    <li>Veo 3.1 Lite/Quality không nhận ảnh tham chiếu → để cách nối “Khung cuối → đầu”.</li>
    <li>Muse luôn ra ~10 giây và nhận được khung đầu + ảnh nhân vật cùng lúc — hợp khi cần vừa liền mạch vừa giữ mặt.</li>
    <li>Chạy “Claude kiểm tra” trước khi render để đỡ tốn credit.</li>
    <li>Muốn làm Phần 2 cùng nhân vật: Nhân bản → “Chỉ nhân vật + phong cách”.</li>
  </ul>`)}
  </div>`;
};
AFTER.guide = () => {
  if (!S.guideSection) return;
  const t = document.getElementById('g_' + S.guideSection);
  S.guideSection = null;
  if (t) setTimeout(() => t.scrollIntoView({ block: 'start' }), 30);
};
function openGuide(section) {
  S.guideSection = section;
  go('guide');
}

// ================= HÀNH ĐỘNG (click) =================
const ACT = {
  open: (el) => call('shell:open', el.dataset.path),
  reveal: (el) => call('shell:reveal', el.dataset.path),
  url: (el) => call('shell:url', el.dataset.u),
  copy: (el) => { navigator.clipboard.writeText(el.dataset.text); toast('Đã sao chép'); },

  // tạo nhanh
  'q-mode': (el) => { S.quick.mode = el.dataset.v; if (el.dataset.v === 'video' && S.quick.aspect === '1:1') S.quick.aspect = '16:9'; render(); },
  'q-aspect': (el) => { S.quick.aspect = el.dataset.v; render(); },
  'q-ref-add': async () => { const f = await call('dialog:file', [{ name: 'Ảnh', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]); if (f) { S.quick.refFiles.push(f); render(); } },
  'q-ref-del': (el) => { S.quick.refFiles.splice(Number(el.dataset.i), 1); render(); },
  'q-start-add': async () => { const f = await call('dialog:file', [{ name: 'Ảnh', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]); if (f) { S.quick.startFrame = f; render(); } },
  'q-start-del': () => { S.quick.startFrame = null; render(); },
  'q-polish': async () => {
    if (!S.quick.text.trim()) return toast('Nhập vài prompt trước đã', 'err');
    const instr = prompt('Muốn Claude chỉnh theo hướng nào? (bỏ trống = làm mạch lạc, đồng nhất)') ?? null;
    if (instr === null) return;
    const out = await busy('Claude đang chuốt prompt…', () => call('claude:polish', S.quick.projectId || null, S.quick.text, instr));
    S.quick.text = out;
    render();
    toast('Claude đã viết lại. Xem lại rồi bấm Tạo.');
  },
  'q-send': async () => {
    const q = S.quick;
    if (!q.text.trim()) return toast('Chưa có prompt nào', 'err');
    if (!requireKey(q.mode === 'video' ? q.model : q.imageModel, q.mode === 'video' ? 'video' : 'image')) return;
    if (q.mode === 'video') {
      const ts = await call('queue:quick', { projectId: q.projectId || null, text: q.text, model: q.model, aspect: q.aspect, duration: q.duration, refFiles: q.refFiles, startFrame: q.startFrame });
      toast(`Đã thêm ${ts.length} video vào hàng đợi`);
    } else {
      const blocks = q.text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
      for (const b of blocks) await call('refs:quickImage', { prompt: b, model: q.imageModel, aspect: q.aspect, refFiles: q.refFiles }).catch(() => {});
      toast(`Đã thêm ${blocks.length} ảnh vào hàng đợi`);
    }
  },

  // hàng đợi
  'q-pause': () => call('queue:pause', !S.stats.paused),
  'q-clear': async () => { await call('queue:clear'); await loadQueue(); render(); },
  'q-cancel': (el) => call('queue:cancel', el.dataset.id),
  'q-retry': (el) => call('queue:retry', el.dataset.id),
  'q-retry-all': async () => { for (const t of S.queue.filter((x) => x.status === 'failed')) await call('queue:retry', t.id); },
  'q-filter': (el) => { S.queueFilter = el.dataset.v; render(); },

  // dự án
  'p-create': async () => {
    const name = $('#npName').value.trim() || 'Dự án mới';
    const p = await call('projects:create', name, { topic: $('#npTopic').value.trim() });
    await loadProjects();
    await openProject(p.id, 'idea');
  },
  'p-open': (el) => openProject(el.dataset.id, 'idea'),
  'p-dup': async (el) => { if (S.project) await saveProject(); dupDialog(el.dataset.id, el.dataset.name); },
  'p-del-card': async (el) => {
    if (!confirm(`Xóa dự án "${el.dataset.name}"? Dự án sẽ vào Thùng rác, khôi phục được.`)) return;
    await call('projects:remove', el.dataset.id); await loadProjects(); render(); toast('Đã chuyển vào Thùng rác');
  },
  pv: (el) => { S.projView = el.dataset.v; render(); },
  't-restore': async (el) => {
    const p = await call('trash:restore', el.dataset.f);
    await loadProjects(); S.projView = 'list'; render(); toast('Đã khôi phục: ' + p.name);
  },
  't-purge': async (el) => {
    if (!confirm(`Xóa VĨNH VIỄN "${el.dataset.name}" cùng toàn bộ ảnh và video? Không lấy lại được.`)) return;
    await call('trash:purge', el.dataset.f); await loadProjects(); render();
  },
  'pick-ffmpeg': async () => {
    const f = await call('dialog:file', [{ name: 'ffmpeg', extensions: ['exe'] }]);
    if (!f) return;
    S.settings = { ...S.settings, ...(await call('settings:set', { ffmpegPath: f })) }; render(); toast('Đã đặt FFmpeg');
  },
  'p-back': async () => { await saveProject(); S.project = null; await loadProjects(); render(); },
  'p-delete': async () => {
    if (!confirm(`Xóa dự án "${S.project.name}"? (chuyển vào thùng rác trong thư mục làm việc)`)) return;
    await call('projects:remove', S.project.id); S.project = null; await loadProjects(); render(); toast('Đã chuyển vào Thùng rác — vào tab Thùng rác để khôi phục.');
  },
  'p-tab': async (el) => { await saveProject(); S.projTab = el.dataset.v; S.compiled = null; render(); },
  'p-aspect': (el) => { S.project.brief.aspect = el.dataset.v; scheduleSave(); render(); },
  'p-cont': async (el) => { S.project.continuity.mode = el.dataset.v; await saveProject(); refreshCompiled(); },

  'ai-bible': async () => {
    await saveProject();
    const instr = ($('#bibleInstr') && $('#bibleInstr').value) || '';
    S.project = await busy('Claude đang dựng phong cách, nhân vật & bối cảnh…', () => call('claude:bible', S.project.id, instr));
    S.projTab = 'cast'; render();
    toast('Xong! Đọc lại khóa nhận dạng của từng nhân vật rồi tạo ảnh tham chiếu.');
  },
  'ai-script': async () => {
    if (S.project.script.scenes.some((s) => s.takes.length) && !confirm('Viết lại kịch bản sẽ thay toàn bộ cảnh (video đã render vẫn còn trong thư mục). Tiếp tục?')) return;
    await saveProject();
    const opts = { sceneCount: Number($('#sceneCount').value) || undefined, instructions: $('#scriptInstr').value };
    S.project = await busy('Claude đang viết kịch bản liền mạch…', () => call('claude:script', S.project.id, opts));
    S.openScenes = new Set(); render();
    toast(`Đã có ${S.project.script.scenes.length} cảnh. Sang tab “Prompt & kiểm tra” để soát lỗi.`);
  },
  'ai-review': async () => {
    await saveProject();
    S.project = await busy('Claude đang soát nhất quán toàn phim…', () => call('claude:review', S.project.id));
    await refreshCompiled();
  },
  'apply-patches': async () => {
    const idx = $$('.patchChk').filter((c) => c.checked && !c.disabled).map((c) => Number(c.value));
    if (!idx.length) return;
    S.project = await call('claude:applyReview', S.project.id, idx);
    toast(`Đã áp dụng ${idx.length} sửa đổi`);
    await refreshCompiled();
  },
  'ai-rewrite': async (el) => {
    await saveProject();
    const instr = $('#rw_' + el.dataset.id).value;
    S.project = await busy(`Claude đang viết lại cảnh ${el.dataset.id}…`, () => call('claude:rewrite', S.project.id, el.dataset.id, instr));
    render();
  },

  // nhân vật & bối cảnh
  'cast-add': (el) => {
    const list = el.dataset.list;
    const n = S.project[list].length + 1;
    S.project[list].push(list === 'characters'
      ? { id: 'c_' + Date.now(), tag: '@nv' + n, name: 'Nhân vật ' + n, role: '', identity: '', wardrobe: '', voice: '', personality: '', refPrompts: {}, refImages: [] }
      : { id: 'l_' + Date.now(), tag: '#bc' + n, name: 'Bối cảnh ' + n, description: '', refPrompt: '', refImages: [] });
    scheduleSave(); render();
  },
  'cast-del': (el) => { if (!confirm('Xóa mục này?')) return; S.project[el.dataset.list].splice(Number(el.dataset.i), 1); scheduleSave(); render(); },
  'ref-add': async (el) => { await saveProject(); S.project = await call('refs:add', S.project.id, el.dataset.type, el.dataset.id); render(); },
  'ref-del': async (el) => { S.project = await call('refs:remove', S.project.id, el.dataset.type, el.dataset.id, el.dataset.file); render(); },
  'ref-primary': async (el) => { S.project = await call('refs:primary', S.project.id, el.dataset.type, el.dataset.id, el.dataset.file); render(); },
  'ref-prompts': async (el) => {
    await saveProject();
    const box = $('#rp_' + el.dataset.id);
    if (box.innerHTML) { box.innerHTML = ''; return; }
    const rp = await call('refs:prompts', S.project.id, el.dataset.type, el.dataset.id);
    const names = { sheet: 'Bảng nhân vật 4 góc', portrait: 'Ảnh cận mặt', expressions: 'Bảng biểu cảm', plate: 'Ảnh bối cảnh' };
    box.innerHTML = Object.entries(rp).map(([k, v]) => `<div class="card" style="background:#161b1f;margin-top:8px">
      <div class="row"><b>${names[k] || k}</b><span class="sp"></span>
        <select class="imgModel" style="width:190px">${modelOptions(hasKey('flow') ? 'nano-banana-pro' : 'muse-image', 'image')}</select>
        <label class="small"><input type="checkbox" class="useEx"> dùng ảnh đã có làm mẫu</label>
        <button class="btn sm" data-act="copy" data-text="${esc(v)}">Sao chép</button>
        <button class="btn sm pri" data-act="ref-gen" data-type="${el.dataset.type}" data-id="${el.dataset.id}" data-k="${k}">Tạo ảnh</button></div>
      <textarea class="mono rpText" rows="4" data-k="${k}">${esc(v)}</textarea></div>`).join('');
  },
  'ref-gen': async (el) => {
    const card = el.closest('.card');
    const promptText = $('.rpText', card).value;
    const model = $('.imgModel', card).value;
    const useExisting = $('.useEx', card).checked;
    const aspect = el.dataset.k === 'sheet' || el.dataset.k === 'expressions' ? '16:9' : el.dataset.k === 'portrait' ? '1:1' : undefined;
    if (!requireKey(model, 'image')) return;
    await call('refs:generate', S.project.id, el.dataset.type, el.dataset.id, { prompt: promptText, model, aspect, useExisting });
    toast('Đã gửi tạo ảnh. Ảnh xong sẽ tự gắn vào nhân vật/bối cảnh.');
  },

  // kịch bản
  'sc-toggle': (el, e) => { if (e.target.closest('input,button,select,textarea')) return; const id = el.dataset.id; S.openScenes.has(id) ? S.openScenes.delete(id) : S.openScenes.add(id); render(); },
  'sc-expand': () => { const all = S.project.script.scenes.map((s) => s.id); S.openScenes = S.openScenes.size ? new Set() : new Set(all); render(); },
  'sc-add': () => {
    const sc = S.project.script.scenes;
    const max = sc.reduce((m, s) => Math.max(m, Number(String(s.id).replace(/\D/g, '')) || 0), 0);
    const id = 'S' + String(max + 1).padStart(2, '0');
    const prev = sc[sc.length - 1];
    sc.push({ id, title: '', beat: '', duration: S.settings.modelsVideo[S.project.brief.model].defaultDuration, location: prev ? prev.location : '', timeOfDay: prev ? prev.timeOfDay : '', characters: prev ? [...prev.characters] : [], startState: prev ? prev.endState : '', action: '', dialogue: [], camera: '', sound: '', mood: '', endState: '', transition: 'continuous', promptOverride: '', enabled: true, takes: [], selected: '' });
    S.openScenes.add(id); scheduleSave(); render();
  },
  'sc-del': (el) => { if (!confirm('Xóa cảnh?')) return; S.project.script.scenes.splice(Number(el.dataset.i), 1); scheduleSave(); render(); },
  'sc-move': (el) => {
    const i = Number(el.dataset.i), j = i + Number(el.dataset.d);
    const sc = S.project.script.scenes;
    if (j < 0 || j >= sc.length) return;
    [sc[i], sc[j]] = [sc[j], sc[i]]; scheduleSave(); render();
  },
  'sc-enable': (el) => { const s = S.project.script.scenes[Number(el.dataset.i)]; s.enabled = !s.enabled; scheduleSave(); render(); },
  'sc-char': (el) => {
    const s = S.project.script.scenes[Number(el.dataset.i)];
    const t = el.dataset.tag;
    s.characters = el.checked ? [...new Set([...s.characters, t])] : s.characters.filter((x) => x !== t);
    scheduleSave();
  },
  'dlg-add': (el) => { S.project.script.scenes[Number(el.dataset.i)].dialogue.push({ who: '', line: '', delivery: '' }); scheduleSave(); render(); },
  'dlg-del': (el) => { S.project.script.scenes[Number(el.dataset.i)].dialogue.splice(Number(el.dataset.j), 1); scheduleSave(); render(); },

  // render
  'render-missing': async () => { if (!requireKey(S.project.brief.model)) return; await saveProject(); const ts = await call('queue:scenes', S.project.id, null, { onlyMissing: true }); toast(ts.length ? `Đã xếp ${ts.length} cảnh vào hàng đợi` : 'Cảnh nào cũng đã có video'); },
  'render-all': async () => { if (!requireKey(S.project.brief.model)) return; if (!confirm('Render lại tất cả cảnh (tốn credit)?')) return; await saveProject(); const ts = await call('queue:scenes', S.project.id, null, {}); toast(`Đã xếp ${ts.length} cảnh`); },
  'render-one': async (el) => { if (!requireKey(S.project.brief.model)) return; await saveProject(); await call('queue:scenes', S.project.id, [el.dataset.id], {}); toast('Đã xếp cảnh ' + el.dataset.id); },
  'take-select': async (el) => { S.project = await call('scene:select', S.project.id, el.dataset.id, el.dataset.file); render(); },
  concat: async () => {
    const r = await busy('Đang ghép phim bằng FFmpeg…', () => call('media:concat', S.project.id));
    toast('Đã xuất phim: ' + r.out + (r.missing.length ? `\n(Bỏ qua cảnh chưa có video: ${r.missing.join(', ')})` : ''));
    call('shell:reveal', r.out);
  },

  // đối thủ
  'ai-competitor': async () => {
    const c = S.competitor;
    if (!c.url.trim() && !c.transcript.trim()) return toast('Dán link hoặc kịch bản video đối thủ', 'err');
    c.current = await busy('Đang phân tích video đối thủ…', () => call('competitor:analyze', { url: c.url.trim(), notes: c.notes, transcript: c.transcript }));
    c.list = await call('competitor:list');
    render();
  },
  'c-show': (el) => { S.competitor.current = S.competitor.list[Number(el.dataset.i)]; render(); },
  'c-to-project': async (el) => {
    const p = await call('competitor:toProject', S.competitor.current, Number(el.dataset.i));
    await loadProjects();
    S.page = 'projects';
    $$('.nav').forEach((n) => n.classList.toggle('active', n.dataset.page === 'projects'));
    await openProject(p.id, 'idea');
    toast('Đã tạo dự án. Bấm “Claude dựng phong cách & nhân vật” để bắt đầu.');
  },

  // bảng giá
  'pr-plan': async (el) => { const rates = { ...S.settings.rates, flowPlan: el.dataset.v }; S.settings = { ...S.settings, ...(await call('settings:set', { rates })) }; S.pricing = await call('pricing:get', S.pricingProject || null); render(); },
  'pr-edit': () => {
    const box = $('#planEditor');
    if (box.innerHTML) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="card mt"><h3>Sửa gói bán (mỗi gói: tên | giá VNĐ | kỳ hạn | nổi bật (x) | các quyền lợi cách nhau bằng ;)</h3>
      <textarea id="planText" rows="6" class="mono">${esc(S.pricing.plans.map((p) => [p.name, p.price, p.period, p.highlight ? 'x' : '', p.features.join('; ')].join(' | ')).join('\n'))}</textarea>
      <div class="row end mt"><button class="btn pri" data-act="pr-save">Lưu bảng giá</button></div></div>`;
  },
  'pr-save': async () => {
    const plans = $('#planText').value.split('\n').map((l) => l.split('|').map((s) => s.trim())).filter((a) => a[0]).map((a, i) => ({ id: 'plan' + i, name: a[0], price: Number(String(a[1] || '0').replace(/\D/g, '')) || 0, period: a[2] || 'tháng', highlight: /x/i.test(a[3] || ''), features: (a[4] || '').split(';').map((s) => s.trim()).filter(Boolean) }));
    S.settings = { ...S.settings, ...(await call('settings:set', { plans })) };
    S.pricing = await call('pricing:get', S.pricingProject || null);
    render(); toast('Đã lưu bảng giá');
  },

  // cài đặt
  'api-test': async (el) => {
    const w = el.dataset.w;
    const box = $('#apiRes_' + w);
    box.textContent = 'Đang kiểm tra…';
    const r = await call('api:test', w).catch(() => ({}));
    if (w === 'flow') {
      box.innerHTML = r.flowMissing ? '<span class="dot warn"></span>Chưa nhập API Veo 3'
        : r.flowError ? '<span class="dot err"></span>' + esc(r.flowError)
        : '<span class="dot ok"></span>Veo 3 kết nối OK';
    } else {
      box.innerHTML = r.museMissing ? '<span class="dot warn"></span>Chưa nhập API Muse'
        : r.museNoEmail ? '<span class="dot warn"></span>Đã có API — nhập thêm email Muse để kiểm tra hạn mức'
        : r.museError ? '<span class="dot err"></span>' + esc(r.museError)
        : '<span class="dot ok"></span>Muse kết nối OK' + (r.muse && r.muse.quota ? ` (đã dùng ${r.muse.quota.percentUsed}% tuần)` : '');
    }
  },
  'key-clear': async (el) => {
    if (!confirm('Xóa API này khỏi máy?')) return;
    S.settings = { ...S.settings, ...(await call('settings:set', { [el.dataset.k]: '', useapiToken: '' })) };
    updateSide(); render(); toast('Đã xóa API');
  },
  'go-settings': () => go('settings'),
  'veo-mode': async (el) => { S.settings = { ...S.settings, ...(await call('settings:set', { veoMode: el.dataset.v })) }; await refreshBridge(); render(); toast(el.dataset.v === 'extension' ? 'Veo 3 sẽ chạy qua Chrome. Làm theo 4 bước bên dưới.' : 'Veo 3 sẽ chạy bằng token useapi.net.'); },
  'bridge-install': async () => { const d = await call('bridge:installExt'); toast('Đã mở thư mục tiện ích:\n' + d + '\nTrong Chrome: Load unpacked → chọn thư mục này.'); refreshBridge(); },
  'bridge-newkey': async () => { if (!confirm('Tạo mã ghép nối mới? Phải dán lại mã vào tiện ích Chrome.')) return; await call('bridge:newKey'); S.settings = await call('settings:get'); refreshBridge(); },
  'bridge-restart': async () => { await call('bridge:restart'); setTimeout(refreshBridge, 500); },
  help: (el) => openGuide(el.dataset.s),
  'g-jump': (el) => { const t = document.getElementById('g_' + el.dataset.s); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
  'claude-test': async () => {
    $('#claudeRes').textContent = 'Đang gọi Claude… (tối đa 2 phút)';
    const r = await call('claude:test');
    S.claudeOk = r.ok;
    $('#claudeRes').innerHTML = `<span class="dot ${r.ok ? 'ok' : 'err'}"></span>${esc(r.message)}`;
    updateSide();
  },
  'mcp-install': async () => { const r = await call('mcp:install'); S.mcp = await call('mcp:status'); render(); toast('Đã thêm vào Claude Desktop (' + r.configPath + '). Thoát hẳn Claude Desktop rồi mở lại.'); },
  'mcp-uninstall': async () => { await call('mcp:uninstall'); S.mcp = await call('mcp:status'); render(); },
  'pick-ws': async () => { const d = await call('dialog:folder'); if (!d) return; S.settings = { ...S.settings, ...(await call('settings:set', { workspace: d })) }; await loadProjects(); await loadQueue(); render(); }
};

$('#main').addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACT[el.dataset.act];
  if (!fn) return;
  if (el.tagName === 'A') e.preventDefault();
  if (el.type === 'checkbox' && el.dataset.act !== 'sc-char') return;
  Promise.resolve(fn(el, e)).catch(() => {});
});

// ================= DỮ LIỆU & SỰ KIỆN =================
async function loadProjects() { S.projects = await call('projects:list'); S.trash = await call('trash:list'); }
async function loadQueue() { S.queue = await call('queue:list'); S.stats = await call('queue:stats'); }

window.h2.on('queue:update', (t) => {
  const i = S.queue.findIndex((x) => x.id === t.id);
  if (i >= 0) S.queue[i] = t; else S.queue.unshift(t);
  const el = document.getElementById('q_' + t.id);
  if (el) el.outerHTML = qItemHtml(t);
  else if ((S.page === 'quick' || S.page === 'queue') && $('#qlist')) {
    const list = $('#qlist');
    if (list.querySelector('.empty')) list.innerHTML = '';
    list.insertAdjacentHTML('afterbegin', qItemHtml(t));
  }
  if (S.page === 'projects' && S.project && S.projTab === 'render' && t.projectId === S.project.id && ['done', 'failed'].includes(t.status)) reloadProject();
});
window.h2.on('queue:stats', (s) => {
  S.stats = s;
  const st = $('.stats');
  if (st) st.outerHTML = statsHtml();
  updateSide();
});
window.h2.on('queue:reset', async () => { await loadQueue(); if (['quick', 'queue'].includes(S.page)) render(); });

function updateSide() {
  const s = S.settings;
  $('#sideStatus').innerHTML = `
    ${s.veoMode === 'extension'
      ? `<div><span class="dot ${S.bridge && S.bridge.connected && S.bridge.flowTab ? 'ok' : S.bridge && S.bridge.connected ? 'warn' : ''}"></span>Veo 3 qua Chrome: ${S.bridge && S.bridge.connected ? (S.bridge.flowTab ? 'sẵn sàng' : 'mở dự án Flow') : 'chưa nối'}</div>`
      : `<div><span class="dot ${hasKey('flow') ? 'ok' : ''}"></span>API Veo 3 ${hasKey('flow') ? 'đã nhập' : 'chưa nhập'}</div>`}
    <div><span class="dot ${hasKey('muse') ? 'ok' : ''}"></span>API Muse ${hasKey('muse') ? 'đã nhập' : 'chưa nhập'}</div>
    ${!hasKey('flow') && !hasKey('muse') ? '<div class="small" style="color:var(--warn)">Nhập ít nhất 1 API để tạo video</div>' : ''}
    <div><span class="dot ${S.claudeOk === true ? 'ok' : S.claudeOk === false ? 'err' : ''}"></span>Claude ${S.claudeOk === true ? 'sẵn sàng' : S.claudeOk === false ? 'chưa chạy được' : 'chưa kiểm tra'}</div>
    <div style="margin-top:6px">${S.stats.running} đang chạy · ${S.stats.queued} chờ</div>`;
}

(async function init() {
  S.settings = await call('settings:get');
  try { S.bridge = await call('bridge:status'); } catch { S.bridge = null; }
  S.quick.model = S.settings.defaultModel;
  S.quick.duration = S.settings.modelsVideo[S.quick.model].defaultDuration;
  await Promise.all([loadProjects(), loadQueue()]);
  S.competitor.list = await call('competitor:list');
  updateSide();
  // Nếu model mặc định thuộc bên chưa có API nhưng bên kia đã có → tự chọn model của bên đã có API
  if (!hasKey(providerOfModel(S.quick.model))) {
    const alt = Object.entries(S.settings.modelsVideo).find(([, m]) => hasKey(m.provider === 'muse' ? 'muse' : 'flow'));
    if (alt) { S.quick.model = alt[0]; S.quick.duration = alt[1].defaultDuration; }
  }
  if (!hasKey(providerOfModel(S.quick.imageModel, 'image'))) {
    const alt = Object.entries(S.settings.modelsImage).find(([, m]) => hasKey(m.provider === 'muse' ? 'muse' : 'flow'));
    if (alt) S.quick.imageModel = alt[0];
  }
  const anyKey = hasKey('flow') || hasKey('muse');
  go(anyKey ? 'quick' : 'settings');
  if (!anyKey) toast('Chào mừng đến với HÊU! Dùng Veo 3 thì nhập API Veo 3, dùng Muse thì nhập API Muse (không cần cả hai). Xem “? Hướng dẫn” nếu chưa biết lấy ở đâu.');
})();
