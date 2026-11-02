'use strict';
// Lưu trữ dự án trên ổ đĩa. Mỗi dự án là một thư mục: project.json + refs/ + videos/ + frames/.
// MCP server (cho Claude Desktop) đọc/ghi đúng các file này, nên app và Claude luôn thấy cùng một dữ liệu.
const fs = require('fs');
const path = require('path');
const { ensureDir, readJson, writeJson, uid, slugify } = require('./util');

function defaultProject(name) {
  const now = new Date().toISOString();
  return {
    schema: 1,
    id: uid('p_'),
    name: name || 'Dự án mới',
    createdAt: now,
    updatedAt: now,
    brief: {
      topic: '',
      goal: '',
      genre: '',
      audience: '',
      platform: 'YouTube',
      dialogueLanguage: 'English',
      narration: 'dialogue', // dialogue | voiceover | none
      targetSeconds: 64,
      aspect: '16:9',
      model: 'veo-3.1-fast',
      notes: ''
    },
    style: {
      visualStyle: '',
      palette: '',
      lighting: '',
      camera: '',
      world: '',
      negative: 'subtitles, captions, on-screen text, watermark, logo, extra fingers, distorted face, morphing, flicker, extra characters'
    },
    characters: [],
    locations: [],
    script: { logline: '', theme: '', outline: [], scenes: [] },
    continuity: { mode: 'auto' }, // auto | refs | chain
    review: null,
    competitor: null
  };
}

function normalizeCharacter(c) {
  const name = c.name || 'Nhân vật';
  let tag = String(c.tag || '@' + slugify(name).split('-')[0]).trim();
  if (!tag.startsWith('@')) tag = '@' + tag;
  return {
    id: c.id || uid('c_'),
    tag: tag.toLowerCase().replace(/[^@a-z0-9_]/g, ''),
    name,
    role: c.role || '',
    identity: c.identity || '',
    wardrobe: c.wardrobe || '',
    voice: c.voice || '',
    personality: c.personality || '',
    refPrompts: c.refPrompts || {},
    refImages: Array.isArray(c.refImages) ? c.refImages : []
  };
}

function normalizeLocation(l) {
  const name = l.name || 'Bối cảnh';
  let tag = String(l.tag || '#' + slugify(name).split('-').slice(0, 2).join('_')).trim();
  if (!tag.startsWith('#')) tag = '#' + tag;
  return {
    id: l.id || uid('l_'),
    tag: tag.toLowerCase().replace(/[^#a-z0-9_]/g, ''),
    name,
    description: l.description || '',
    refPrompt: l.refPrompt || '',
    refImages: Array.isArray(l.refImages) ? l.refImages : []
  };
}

function normalizeScene(s, i) {
  const id = s.id || 'S' + String(i + 1).padStart(2, '0');
  return {
    id,
    title: s.title || '',
    beat: s.beat || '',
    duration: Number(s.duration) || 8,
    location: s.location || '',
    timeOfDay: s.timeOfDay || '',
    characters: Array.isArray(s.characters) ? s.characters.map((t) => String(t).toLowerCase()) : [],
    startState: s.startState || '',
    action: s.action || '',
    dialogue: Array.isArray(s.dialogue) ? s.dialogue.filter((d) => d && d.line) : [],
    camera: s.camera || '',
    sound: s.sound || '',
    mood: s.mood || '',
    endState: s.endState || '',
    transition: s.transition || 'cut',
    promptOverride: s.promptOverride || '',
    enabled: s.enabled !== false,
    takes: Array.isArray(s.takes) ? s.takes : [], // các lần render: {file, thumb, taskId, model, at}
    selected: s.selected || '' // file bản được chọn để ghép phim
  };
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) return;
  ensureDir(to);
  for (const f of fs.readdirSync(from)) {
    const a = path.join(from, f), b = path.join(to, f);
    if (fs.statSync(a).isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

// Đổi mọi đường dẫn file nằm trong thư mục dự án cũ sang thư mục mới (ảnh tham chiếu, video…).
function rewritePaths(obj, oldDirs, newDir) {
  const fix = (v) => {
    if (typeof v === 'string') {
      for (const o of oldDirs) {
        if (o && v.startsWith(o)) return newDir + v.slice(o.length);
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = fix(v[k]); return v; }
    return v;
  };
  return fix(obj);
}

class Store {
  constructor(workspace) {
    this.setWorkspace(workspace);
  }

  setWorkspace(workspace) {
    this.workspace = ensureDir(workspace);
    this.projectsDir = ensureDir(path.join(workspace, 'projects'));
  }

  projectDir(id) {
    return path.join(this.projectsDir, id);
  }

  list() {
    const out = [];
    for (const name of fs.readdirSync(this.projectsDir)) {
      const p = readJson(path.join(this.projectsDir, name, 'project.json'), null);
      if (p && p.id) {
        out.push({
          id: p.id, name: p.name, updatedAt: p.updatedAt, topic: p.brief.topic,
          scenes: p.script.scenes.length, characters: p.characters.length, model: p.brief.model
        });
      }
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  create(name, patch = {}) {
    const p = defaultProject(name);
    Object.assign(p.brief, patch.brief || {});
    if (patch.competitor) p.competitor = patch.competitor;
    const dir = this.projectDir(p.id);
    for (const sub of ['refs', 'videos', 'frames', 'exports']) ensureDir(path.join(dir, sub));
    this.save(p);
    return p;
  }

  get(id) {
    const p = readJson(path.join(this.projectDir(id), 'project.json'), null);
    if (!p) throw new Error('Không tìm thấy dự án ' + id);
    // nâng cấp dữ liệu cũ / do Claude ghi thiếu trường
    const base = defaultProject(p.name);
    p.brief = Object.assign(base.brief, p.brief);
    p.style = Object.assign(base.style, p.style);
    p.characters = (p.characters || []).map(normalizeCharacter);
    p.locations = (p.locations || []).map(normalizeLocation);
    p.script = Object.assign(base.script, p.script);
    p.script.scenes = (p.script.scenes || []).map(normalizeScene);
    p.continuity = Object.assign(base.continuity, p.continuity);
    return p;
  }

  save(p) {
    p.updatedAt = new Date().toISOString();
    writeJson(path.join(this.projectDir(p.id), 'project.json'), p);
    return p;
  }

  update(id, mutator) {
    const p = this.get(id);
    const r = mutator(p);
    this.save(r || p);
    return r || p;
  }

  remove(id) {
    const dir = this.projectDir(id);
    // Không xóa hẳn: chuyển vào thùng rác để lấy lại được.
    const trash = ensureDir(path.join(this.workspace, 'trash'));
    const p = readJson(path.join(dir, 'project.json'), {});
    const dest = path.join(trash, id + '-' + Date.now());
    fs.renameSync(dir, dest);
    writeJson(path.join(dest, 'trash-info.json'), { id, name: p.name || id, deletedAt: new Date().toISOString(), originalDir: dir });
  }

  // ---------- Thùng rác ----------
  trashDir() {
    return ensureDir(path.join(this.workspace, 'trash'));
  }

  listTrash() {
    const out = [];
    for (const folder of fs.readdirSync(this.trashDir())) {
      const dir = path.join(this.trashDir(), folder);
      const p = readJson(path.join(dir, 'project.json'), null);
      if (!p) continue;
      const info = readJson(path.join(dir, 'trash-info.json'), {});
      const ts = Number(folder.split('-').pop());
      out.push({
        folder, id: p.id, name: p.name, topic: p.brief && p.brief.topic,
        scenes: (p.script && p.script.scenes || []).length, characters: (p.characters || []).length,
        deletedAt: info.deletedAt || (ts ? new Date(ts).toISOString() : '')
      });
    }
    return out.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  }

  restore(folder) {
    if (!/^[\w-]+$/.test(folder)) throw new Error('Tên thư mục thùng rác không hợp lệ');
    const src = path.join(this.trashDir(), folder);
    const p = readJson(path.join(src, 'project.json'), null);
    if (!p) throw new Error('Không tìm thấy dự án trong thùng rác');
    const oldDir = readJson(path.join(src, 'trash-info.json'), {}).originalDir || this.projectDir(p.id);
    let id = p.id;
    // Đã có dự án cùng mã (vd. đã nhân bản/khôi phục trước đó) → cấp mã mới
    if (fs.existsSync(this.projectDir(id))) id = uid('p_');
    const dest = this.projectDir(id);
    fs.renameSync(src, dest);
    fs.rmSync(path.join(dest, 'trash-info.json'), { force: true });
    const restored = rewritePaths(readJson(path.join(dest, 'project.json'), {}), [oldDir, this.projectDir(p.id)], dest);
    restored.id = id;
    if (id !== p.id) restored.name = p.name + ' (khôi phục)';
    this.save(restored);
    return this.get(id);
  }

  purge(folder) {
    if (!/^[\w-]+$/.test(folder)) throw new Error('Tên thư mục thùng rác không hợp lệ');
    fs.rmSync(path.join(this.trashDir(), folder), { recursive: true, force: true });
  }

  // ---------- Nhân bản ----------
  // keep: { script: true, videos: false } — nhân vật, bối cảnh, phong cách, ảnh tham chiếu luôn được giữ.
  duplicate(id, name, keep = {}) {
    const src = this.get(id);
    const srcDir = this.projectDir(id);
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = uid('p_');
    copy.name = name || src.name + ' (bản sao)';
    copy.createdAt = new Date().toISOString();
    copy.review = null;
    const destDir = this.projectDir(copy.id);
    for (const sub of ['refs', 'videos', 'frames', 'exports']) ensureDir(path.join(destDir, sub));
    // chép ảnh tham chiếu
    copyDir(path.join(srcDir, 'refs'), path.join(destDir, 'refs'));
    if (keep.script === false) {
      copy.script = { logline: '', theme: '', outline: [], scenes: [] };
    } else if (keep.videos) {
      copyDir(path.join(srcDir, 'videos'), path.join(destDir, 'videos'));
      copyDir(path.join(srcDir, 'frames'), path.join(destDir, 'frames'));
    } else {
      for (const s of copy.script.scenes) { s.takes = []; s.selected = ''; }
    }
    const out = rewritePaths(copy, [srcDir], destDir);
    writeJson(path.join(destDir, 'project.json'), out);
    return this.get(copy.id);
  }

  findByName(nameOrId) {
    const all = this.list();
    const q = String(nameOrId || '').toLowerCase();
    return all.find((p) => p.id === nameOrId) ||
      all.find((p) => p.name.toLowerCase() === q) ||
      all.find((p) => p.name.toLowerCase().includes(q));
  }
}

module.exports = { Store, defaultProject, normalizeCharacter, normalizeLocation, normalizeScene, rewritePaths };
