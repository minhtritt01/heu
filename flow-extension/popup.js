const $ = (id) => document.getElementById(id);
const line = (cls, text) => `<div class="row"><span class="dot ${cls}"></span><span>${text}</span></div>`;
async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: 'status' });
  if (!s) return;
  $('st').innerHTML =
    line(s.connected ? 'ok' : s.hasKey ? 'err' : 'warn', s.connected ? 'Đã nối với app HÊU' : s.hasKey ? 'Chưa nối được HÊU' : 'Chưa nhập mã ghép nối') +
    line(s.flowTab ? 'ok' : 'warn', s.flowTab ? 'Đã thấy dự án Google Flow' : 'Chưa mở dự án Google Flow') +
    `<div class="muted">${s.busy ? '⏳ ' : ''}${s.note || ''}${s.lastError ? '<br><span style="color:#ff6b6b">Lỗi gần nhất: ' + s.lastError + '</span>' : ''}</div>`;
}
(async () => {
  const c = await chrome.storage.local.get(['host', 'key']);
  $('key').value = c.key || '';
  $('host').value = c.host || 'http://127.0.0.1:47321';
  refresh();
  setInterval(refresh, 1500);
})();
$('save').onclick = async () => { await chrome.runtime.sendMessage({ type: 'save', key: $('key').value.trim().toUpperCase(), host: $('host').value.trim() }); refresh(); };
$('open').onclick = () => chrome.tabs.create({ url: 'https://flow.google.com/' });
$('diag').onclick = async () => { const r = await chrome.runtime.sendMessage({ type: 'diag' }); $('out').hidden = false; $('out').textContent = JSON.stringify(r, null, 2); };
