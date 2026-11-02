'use strict';
// Điều phối: lấy dự án → nhờ Claude → gộp kết quả vào dự án một cách an toàn.
const brain = require('./brain');
const { normalizeCharacter, normalizeLocation, normalizeScene } = require('./store');

function mergeBible(p, data) {
  if (data.style) {
    for (const k of Object.keys(p.style)) if (data.style[k]) p.style[k] = data.style[k];
  }
  for (const nc of data.characters || []) {
    const c = normalizeCharacter(nc);
    const old = p.characters.find((x) => x.tag === c.tag || x.name.toLowerCase() === c.name.toLowerCase());
    if (old) {
      // giữ nguyên khóa nhận dạng đã có — chỉ điền phần còn trống
      for (const k of ['identity', 'wardrobe', 'voice', 'role', 'personality']) if (!old[k] && c[k]) old[k] = c[k];
    } else {
      p.characters.push(c);
    }
  }
  for (const nl of data.locations || []) {
    const l = normalizeLocation(nl);
    const old = p.locations.find((x) => x.tag === l.tag);
    if (old) { if (!old.description) old.description = l.description; } else p.locations.push(l);
  }
  return p;
}

function mergeScript(p, data) {
  mergeBible(p, { characters: data.newCharacters || [], locations: data.newLocations || [] });
  p.script.logline = data.logline || p.script.logline;
  p.script.theme = data.theme || p.script.theme;
  p.script.outline = Array.isArray(data.outline) ? data.outline : p.script.outline;
  p.script.scenes = (data.scenes || []).map((s, i) => normalizeScene({ ...s, id: 'S' + String(i + 1).padStart(2, '0') }, i));
  p.review = null;
  return p;
}

const PATCHABLE = ['title', 'action', 'startState', 'endState', 'camera', 'sound', 'mood', 'dialogue', 'characters', 'location', 'timeOfDay', 'transition', 'duration'];

function applyPatches(p, patches, onlyIndexes) {
  let applied = 0;
  (patches || []).forEach((pt, i) => {
    if (onlyIndexes && !onlyIndexes.includes(i)) return;
    const s = p.script.scenes.find((x) => x.id === pt.scene);
    if (!s || !PATCHABLE.includes(pt.field)) return;
    let v = pt.value;
    if (pt.field === 'characters' && !Array.isArray(v)) v = String(v).split(/[,\s]+/).filter(Boolean);
    if (pt.field === 'dialogue' && !Array.isArray(v)) return;
    if (pt.field === 'duration') v = Number(v) || s.duration;
    s[pt.field] = v;
    pt.applied = true;
    applied++;
  });
  return applied;
}

class Studio {
  constructor({ store, runner, log }) {
    this.store = store;
    this.runner = runner;
    this.log = log || (() => {});
  }

  async buildBible(projectId, instructions, onProgress) {
    const p = this.store.get(projectId);
    const data = await this.runner.runJson(brain.biblePrompt(p, instructions), { onProgress });
    return this.store.update(projectId, (cur) => mergeBible(cur, data));
  }

  async writeScript(projectId, opts, onProgress) {
    const p = this.store.get(projectId);
    if (!p.style.visualStyle || !p.characters.length) {
      // chưa có bible → dựng trước để kịch bản bám theo nhân vật đã khóa
      await this.buildBible(projectId, '', onProgress);
    }
    const p2 = this.store.get(projectId);
    const data = await this.runner.runJson(brain.scriptPrompt(p2, opts), { onProgress });
    return this.store.update(projectId, (cur) => mergeScript(cur, data));
  }

  async review(projectId, onProgress) {
    const p = this.store.get(projectId);
    const data = await this.runner.runJson(brain.reviewPrompt(p), { onProgress });
    data.at = new Date().toISOString();
    return this.store.update(projectId, (cur) => { cur.review = data; return cur; });
  }

  applyReview(projectId, indexes) {
    return this.store.update(projectId, (cur) => {
      if (!cur.review) return cur;
      const n = applyPatches(cur, cur.review.patches, indexes);
      cur.review.appliedCount = (cur.review.appliedCount || 0) + n;
      return cur;
    });
  }

  async rewriteScene(projectId, sceneId, instruction, onProgress) {
    const p = this.store.get(projectId);
    const data = await this.runner.runJson(brain.rewriteScenePrompt(p, sceneId, instruction), { onProgress });
    return this.store.update(projectId, (cur) => {
      const i = cur.script.scenes.findIndex((s) => s.id === sceneId);
      if (i >= 0) cur.script.scenes[i] = normalizeScene({ ...data, id: sceneId }, i);
      return cur;
    });
  }

  async polishQuick(projectId, blocks, instruction, onProgress) {
    const p = projectId ? this.store.get(projectId) : null;
    const data = await this.runner.runJson(brain.polishQuickPrompt(p, blocks, instruction), { onProgress });
    const out = Array.isArray(data.prompts) ? data.prompts : [];
    if (out.length !== blocks.length) throw new Error('Claude trả về số prompt không khớp, thử lại nhé.');
    return out;
  }

  async analyzeCompetitor(input, onProgress) {
    const tools = input.transcript ? [] : ['WebFetch', 'WebSearch'];
    const report = await this.runner.runJson(brain.competitorPrompt(input), { tools, onProgress });
    return report;
  }
}

module.exports = { Studio, mergeBible, mergeScript, applyPatches };
