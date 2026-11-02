'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Gọi IPC: trả về data hoặc ném lỗi để giao diện hiện thông báo tiếng Việt.
async function call(name, ...args) {
  const r = await ipcRenderer.invoke(name, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

contextBridge.exposeInMainWorld('h2', {
  call,
  on: (channel, fn) => {
    const ok = ['queue:update', 'queue:stats', 'queue:reset', 'claude:progress', 'project:changed', 'toast', 'bridge:status'];
    if (!ok.includes(channel)) return () => {};
    const h = (_e, data) => fn(data);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
  platform: process.platform
});
