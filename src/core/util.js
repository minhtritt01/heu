'use strict';
// Tiện ích chung, chạy được cả trong Electron lẫn Node thường (để MCP server và test dùng lại).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Ghi an toàn: ghi ra file tạm rồi đổi tên, tránh hỏng file khi máy tắt giữa chừng.
function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function uid(prefix = '') {
  return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'du-an';
}

function fileHash(file) {
  const h = crypto.createHash('sha1');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Lấy khối JSON đầu tiên hợp lệ trong một đoạn văn bản (Claude đôi khi bọc trong ```json).
function extractJson(text) {
  if (text == null) throw new Error('Không có nội dung để đọc JSON');
  if (typeof text === 'object') return text;
  const s = String(text).trim();
  try { return JSON.parse(s); } catch { /* thử cách khác */ }
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch { /* tiếp */ }
  }
  // Quét tìm cặp ngoặc cân bằng đầu tiên
  for (let i = 0; i < s.length; i++) {
    const open = s[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(i, j + 1)); } catch { break; }
        }
      }
    }
  }
  throw new Error('Claude không trả về JSON hợp lệ');
}

// Tìm theo chiều sâu các chuỗi thỏa điều kiện trong một object (dùng khi API trả cấu trúc lồng nhau).
function deepFind(obj, test, out = []) {
  if (obj == null) return out;
  if (typeof obj === 'string') { if (test(obj)) out.push(obj); return out; }
  if (Array.isArray(obj)) { for (const v of obj) deepFind(v, test, out); return out; }
  if (typeof obj === 'object') { for (const k of Object.keys(obj)) deepFind(obj[k], test, out); }
  return out;
}

function mimeOf(file) {
  const ext = path.extname(file).toLowerCase();
  return { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4' }[ext] || 'application/octet-stream';
}

function wordCount(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}

module.exports = { ensureDir, readJson, writeJson, uid, slugify, fileHash, sleep, extractJson, deepFind, mimeOf, wordCount };
