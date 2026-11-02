// Các hàm chạy TRONG trang Google Flow (chrome.scripting.executeScript). Mỗi hàm phải tự chứa đủ mọi thứ.
// Bộ chọn phần tử đối chiếu giao diện Flow 11/2026:
//   ô prompt   : div.ProseMirror[contenteditable=true]   (aria-label "What do you want to create?")
//   nút tạo    : button[aria-label="Start generation"]   (CHỈ nhận cú bấm thật → bấm qua chrome.debugger)
//   cài đặt    : button[aria-label="Settings trigger"] → bảng có các nút role=radio (Image/Video, 16:9…, x1…)
//   chọn model : button[aria-label="Select model family"] → menu .mat-mdc-menu-panel button
//   kết quả    : flow-grid-tile-container chứa img/video [data-media-id], link flow-content.google/…

/* eslint-disable no-unused-vars */

// Chuẩn bị: chọn chế độ, khung hình, model, x1; dán prompt; trả về vị trí nút Tạo + danh sách kết quả cũ.
async function heuPrepare(job) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(250); } };
  const last = (el) => (el.innerText || '').trim().split(/\s+/).pop();
  const overlay = () => [...document.querySelectorAll('.cdk-overlay-pane')].find((p) => p.querySelector('[role=radio]'));
  const closeOverlay = async () => {
    for (let i = 0; i < 4 && document.querySelector('.cdk-overlay-pane'); i++) {
      const bd = document.querySelector('.cdk-overlay-backdrop');
      if (bd) bd.click(); else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(300);
    }
  };

  const editor = await waitFor(() => document.querySelector('div.ProseMirror[contenteditable=true]'));
  if (!editor) return { ok: false, error: 'Không thấy ô nhập prompt. Hãy mở MỘT DỰ ÁN trong Google Flow (không phải trang chủ).' };
  await closeOverlay();

  // ---- bảng cài đặt ----
  const trigger = document.querySelector('button[aria-label="Settings trigger"]');
  let credits = null;
  if (trigger) {
    trigger.click();
    const pane = await waitFor(overlay, 5000);
    if (!pane) return { ok: false, error: 'Không mở được bảng cài đặt của Flow.' };
    const radios = () => [...pane.querySelectorAll('[role=radio]')];
    const pick = async (word) => {
      const r = radios().find((x) => last(x) === word);
      if (!r) return false;
      if (r.getAttribute('aria-checked') !== 'true') { r.click(); await sleep(450); }
      return true;
    };
    if (!(await pick(job.kind === 'video' ? 'Video' : 'Image'))) return { ok: false, error: 'Không thấy nút chọn Ảnh/Video trong Flow.' };
    await pick(job.aspect || '16:9');
    if (job.flowModel) {
      const mbtn = pane.querySelector('[aria-label="Select model family"]');
      if (mbtn && !mbtn.innerText.includes(job.flowModel)) {
        mbtn.click();
        const item = await waitFor(() => [...document.querySelectorAll('.mat-mdc-menu-panel button, [role=menuitem]')].find((b) => b.innerText.includes(job.flowModel)), 4000);
        if (!item) {
          const have = [...document.querySelectorAll('.mat-mdc-menu-panel button')].map((b) => b.innerText.replace(/\s+/g, ' ').trim()).join(', ');
          await closeOverlay();
          return { ok: false, error: `Tài khoản Flow này không có model "${job.flowModel}". Đang có: ${have || 'không rõ'}.` };
        }
        item.click();
        await sleep(500);
      }
    }
    await pick('x1');
    const m = (pane.innerText || '').match(/use\s+(\d+)\s+credits?/i);
    if (m) credits = Number(m[1]);
    await closeOverlay();
  }

  // ---- dán prompt ----
  editor.focus();
  document.execCommand('selectAll');
  document.execCommand('insertText', false, job.prompt);
  await sleep(500);
  const typed = (editor.innerText || '').replace(/\s+/g, ' ').trim();
  if (!typed || typed.slice(0, 30) !== String(job.prompt).replace(/\s+/g, ' ').trim().slice(0, 30)) {
    return { ok: false, error: 'Không dán được prompt vào ô của Flow.' };
  }
  const btn = await waitFor(() => { const b = document.querySelector('button[aria-label="Start generation"]'); return b && !b.disabled ? b : null; }, 5000);
  if (!btn) return { ok: false, error: 'Nút Tạo của Flow đang bị khóa (có thể hết lượt hoặc đang có việc khác).' };
  btn.scrollIntoView({ block: 'center' });
  await sleep(200);
  const r = btn.getBoundingClientRect();
  return {
    ok: true, credits,
    seen: [...document.querySelectorAll('[data-media-id]')].map((e) => e.dataset.mediaId),
    tiles: document.querySelectorAll('flow-grid-tile-container').length,
    btn: { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  };
}

// Kiểm tra kết quả sau khi bấm Tạo.
function heuCheck(seen, kind, promptHead) {
  const seenSet = new Set(seen || []);
  const tiles = [...document.querySelectorAll('flow-grid-tile-container')];
  const head = String(promptHead || '').toLowerCase().slice(0, 40);
  const prompt = (document.querySelector('div.ProseMirror') || {}).innerText || '';
  // Ô mới = ô chưa chứa kết quả cũ nào
  const fresh = tiles.filter((t) => ![...t.querySelectorAll('[data-media-id]')].some((e) => seenSet.has(e.dataset.mediaId)));
  const tile = fresh[0] || null;
  const pageText = document.body.innerText || '';
  const errRe = /(failed|couldn.t|could not|something went wrong|violat|policy|not able to|unable to|try again|out of credits|not enough credits|limit reached)/i;
  if (!tile) {
    const pct = (pageText.match(/(\d{1,3})%/) || [])[1];
    const errEl = [...document.querySelectorAll('mat-snack-bar-container, .mat-mdc-snack-bar-label, [role=alert]')].map((e) => e.innerText).find((x) => errRe.test(x));
    if (errEl) return { state: 'failed', error: errEl.slice(0, 300) };
    return { state: 'pending', progress: pct ? pct + '%' : null, promptLeft: prompt.trim().toLowerCase().startsWith(head.slice(0, 20)) };
  }
  const text = tile.innerText || '';
  const pct = (text.match(/(\d{1,3})%/) || [])[1];
  const mediaEls = [...tile.querySelectorAll('[data-media-id]')];
  const urlIn = (re) => {
    for (const e of tile.querySelectorAll('img,video,source,a,[style]')) {
      const cands = [e.currentSrc, e.src, e.href, e.getAttribute && e.getAttribute('src'), e.getAttribute && e.getAttribute('style')];
      for (const c of cands) if (c && re.test(c)) { const m = String(c).match(/https:\/\/flow-content\.google\/[^"')\s]+/); return m ? m[0] : c; }
    }
    return null;
  };
  if (kind === 'image') {
    const u = urlIn(/flow-content\.google\/image\//);
    if (u && !pct) return { state: 'done', url: u, mediaId: mediaEls[0] && mediaEls[0].dataset.mediaId };
  } else {
    const u = urlIn(/flow-content\.google\/video\//);
    if (u && !pct) return { state: 'done', url: u, mediaId: mediaEls[0] && mediaEls[0].dataset.mediaId };
    if (mediaEls.length && !pct) {
      const r = tile.getBoundingClientRect();
      return { state: 'needHover', x: r.left + r.width / 2, y: r.top + r.height / 2, mediaId: mediaEls[0].dataset.mediaId };
    }
  }
  if (!pct && errRe.test(text)) return { state: 'failed', error: text.replace(/\s+/g, ' ').slice(0, 300) };
  return { state: 'pending', progress: pct ? pct + '%' : 'đang tạo' };
}

// Dò giao diện: trả về những gì tiện ích nhìn thấy (để kiểm tra / gửi cho người hỗ trợ).
function heuDiagnose() {
  const q = (s) => document.querySelector(s);
  return {
    url: location.href,
    editor: !!q('div.ProseMirror[contenteditable=true]'),
    generate: !!q('button[aria-label="Start generation"]'),
    settings: !!q('button[aria-label="Settings trigger"]'),
    settingsText: (q('button[aria-label="Settings trigger"]') || {}).innerText || null,
    tiles: document.querySelectorAll('flow-grid-tile-container').length,
    media: [...document.querySelectorAll('[data-media-id]')].slice(0, 5).map((e) => ({ tag: e.tagName, src: String(e.currentSrc || e.src || '').slice(0, 90) })),
    videos: [...document.querySelectorAll('video')].slice(0, 5).map((v) => String(v.currentSrc || v.src || '').slice(0, 90))
  };
}
