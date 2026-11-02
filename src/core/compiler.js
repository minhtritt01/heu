'use strict';
// TRÌNH GHÉP PROMPT — trái tim của việc giữ nhân vật đồng nhất.
// Claude chỉ viết phần riêng của từng cảnh (hành động, thoại, máy quay...). Phần "khóa" (phong cách,
// mô tả nhận dạng nhân vật, trang phục, giọng, bối cảnh, danh sách cấm) do code chèn NGUYÊN VĂN vào mọi
// prompt, nên không bao giờ bị AI viết lệch qua từng cảnh.
const { videoModel, fitDuration, dialogueBudget } = require('./models');
const { wordCount } = require('./util');

const MAX_PROMPT_CHARS = 3600; // Veo giới hạn ~1024 token đầu vào

function charByTag(project, tag) {
  const t = String(tag || '').toLowerCase();
  return project.characters.find((c) => c.tag === t || c.name.toLowerCase() === t.replace(/^@/, ''));
}

function locByTag(project, tag) {
  const t = String(tag || '').toLowerCase();
  return project.locations.find((l) => l.tag === t || l.name.toLowerCase() === t.replace(/^#/, ''));
}

function styleLock(project) {
  const s = project.style;
  return [s.visualStyle, s.palette && 'Color palette: ' + s.palette, s.lighting && 'Lighting: ' + s.lighting, s.world]
    .filter(Boolean).join('. ').replace(/\.\./g, '.');
}

function aspectLine(aspect, provider) {
  const a = aspect === '9:16' ? '9:16 vertical' : '16:9 landscape';
  // Muse không có tham số tỉ lệ: phải ghi rõ "in exactly" thì mới ra đúng khung.
  return provider === 'muse' ? `Create the video in exactly ${a.split(' ')[0]} aspect ratio (${a.split(' ')[1]}).` : `Framing: ${a}.`;
}

// Quyết định cách nối cảnh: dùng ảnh tham chiếu nhân vật hay lấy khung cuối cảnh trước làm khung đầu.
function continuityPlan(project, scene, index, modelId, noChain) {
  const m = videoModel(modelId);
  const mode = project.continuity.mode || 'auto';
  const prev = index > 0 ? project.script.scenes[index - 1] : null;
  const chainable = !!prev && m.supportsStartFrame && !noChain;
  let chain = false;
  if (mode === 'chain') chain = chainable;
  else if (mode === 'auto') chain = chainable && scene.transition === 'continuous';
  const useRefs = m.maxRefs > 0 && (!chain || m.supportsRefsWithStartFrame);
  return { chain, useRefs, prevSceneId: prev ? prev.id : null };
}

// Chọn ảnh tham chiếu: mỗi nhân vật có mặt 1 ảnh (ảnh đầu tiên = bảng nhân vật), rồi tới bối cảnh.
function pickRefs(project, scene, maxRefs) {
  const refs = [];
  for (const tag of scene.characters) {
    const c = charByTag(project, tag);
    if (c && c.refImages[0] && refs.length < maxRefs) refs.push({ kind: 'character', tag: c.tag, name: c.name, file: c.refImages[0] });
  }
  // nhân vật chính có thêm ảnh thứ hai nếu còn chỗ (vd ảnh cận mặt)
  for (const tag of scene.characters) {
    const c = charByTag(project, tag);
    if (c && c.refImages[1] && refs.length < maxRefs) refs.push({ kind: 'character', tag: c.tag, name: c.name, file: c.refImages[1] });
  }
  const loc = locByTag(project, scene.location);
  if (loc && loc.refImages[0] && refs.length < maxRefs) refs.push({ kind: 'location', tag: loc.tag, name: loc.name, file: loc.refImages[0] });
  return refs;
}

function refMarker(provider, n, hasStartFrame) {
  if (provider === 'muse') return `the person shown in image_${n + (hasStartFrame ? 1 : 0)}`;
  return `@referenceImage_${n}`;
}

function compileScene(project, scene, index, opts = {}) {
  const modelId = opts.model || project.brief.model;
  const m = videoModel(modelId);
  const provider = m.provider;
  const duration = fitDuration(modelId, scene.duration);
  const plan = continuityPlan(project, scene, index, modelId, opts.noChain);
  const refs = plan.useRefs ? pickRefs(project, scene, m.maxRefs) : [];
  const warnings = [];

  if (scene.promptOverride && scene.promptOverride.trim()) {
    return { prompt: scene.promptOverride.trim(), refs, plan, duration, model: modelId, provider, warnings: ['Cảnh này dùng prompt tự viết tay — không được khóa tự động.'] };
  }

  const lines = [];
  const style = styleLock(project);
  if (style) lines.push(`Visual style (identical in every shot of this film): ${style}.`);
  lines.push(aspectLine(project.brief.aspect, provider));
  if (plan.chain && provider === 'muse') lines.push('Animate image_1: the shot starts exactly on that frame and continues the motion naturally.');

  const loc = locByTag(project, scene.location);
  const setting = loc ? `${loc.name} — ${loc.description}` : scene.location;
  if (setting) lines.push(`Setting: ${setting}${scene.timeOfDay ? ', ' + scene.timeOfDay : ''}.`);

  const present = scene.characters.map((t) => charByTag(project, t)).filter(Boolean);
  if (present.length) {
    lines.push('Characters (must look exactly the same as in every other shot — same face, hair, body, outfit):');
    for (const c of present) {
      const ri = refs.findIndex((r) => r.kind === 'character' && r.tag === c.tag);
      const mark = ri >= 0 ? ` (${refMarker(provider, ri + 1, plan.chain)})` : '';
      lines.push(`- ${c.name}${mark}: ${describeChar(c)}`);
    }
    if (present.length === 1) lines.push(`Only ${present[0].name} appears on screen; no other people.`);
  } else {
    lines.push('No people on screen.');
  }

  if (scene.camera) lines.push(`Shot: ${scene.camera}.`);

  const actionParts = [];
  if (scene.startState) actionParts.push(`Opening frame: ${trimDot(scene.startState)}`);
  if (scene.action) actionParts.push(scene.action);
  if (scene.endState) actionParts.push(`Final frame: ${trimDot(scene.endState)}`);
  if (actionParts.length) lines.push('Action: ' + actionParts.map(trimDot).join('. ') + '.');

  // Thoại / lời dẫn
  const lang = project.brief.dialogueLanguage || 'English';
  const budget = dialogueBudget(duration);
  const words = scene.dialogue.reduce((n, d) => n + wordCount(d.line), 0);
  if (scene.dialogue.length) {
    for (const d of scene.dialogue) {
      const who = String(d.who || '').toLowerCase();
      if (/narrat|dẫn|voice/.test(who)) {
        lines.push(`Narrator voice-over (${narratorVoice(project)}, ${lang}): "${d.line}"`);
      } else {
        const c = charByTag(project, d.who) || project.characters.find((x) => x.name.toLowerCase() === who);
        const name = c ? c.name : d.who;
        const voice = c && c.voice ? `, ${c.voice}` : '';
        const how = d.delivery ? `, ${d.delivery}` : '';
        lines.push(`${name} says (${lang}${voice}${how}): "${d.line}"`);
      }
    }
    if (words > budget) warnings.push(`Thoại ${words} từ, quá dài cho clip ${duration}s (nên ≤ ${budget} từ) — dễ bị cắt giữa câu.`);
  } else {
    lines.push('No spoken dialogue and no narration in this shot.');
  }

  if (scene.sound) lines.push(`Sound: ${trimDot(scene.sound)}.`);
  if (scene.mood) lines.push(`Mood: ${trimDot(scene.mood)}.`);

  const prev = index > 0 ? project.script.scenes[index - 1] : null;
  if (prev && prev.endState && scene.transition !== 'time-skip') {
    lines.push(`Continuity: this shot follows directly after the previous shot, which ended on: ${trimDot(prev.endState)}. Keep positions, props, lighting and outfits consistent.`);
  }

  const neg = project.style.negative;
  if (neg) lines.push(`Avoid: ${trimDot(neg)}.`);

  let prompt = lines.join('\n');
  if (prompt.length > MAX_PROMPT_CHARS) {
    warnings.push(`Prompt dài ${prompt.length} ký tự (> ${MAX_PROMPT_CHARS}). Hãy rút gọn mô tả nhân vật hoặc hành động.`);
  }
  if (plan.useRefs && present.length && !refs.some((r) => r.kind === 'character')) {
    warnings.push('Chưa có ảnh tham chiếu cho nhân vật trong cảnh — độ giống nhau chỉ dựa vào chữ.');
  }
  return { prompt, refs, plan, duration, model: modelId, provider, warnings };
}

function describeChar(c) {
  const id = trimDot(c.identity);
  const w = trimDot(c.wardrobe);
  return (id ? id + '.' : '') + (w ? ' Wearing ' + lowerFirst(w) + '.' : '');
}

function narratorVoice(project) {
  const n = project.characters.find((c) => /narrat|dẫn chuyện/i.test(c.role + ' ' + c.name));
  return n && n.voice ? n.voice : 'calm, warm documentary narrator voice';
}

function lowerFirst(s) {
  s = String(s || '').trim();
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}
function trimDot(s) {
  return String(s || '').trim().replace(/[.\s]+$/, '');
}

// Kiểm tra lỗi bằng code trước khi tốn tiền render (Claude sẽ kiểm tra thêm phần ý nghĩa).
function lintProject(project, modelId) {
  const model = modelId || project.brief.model;
  const m = videoModel(model);
  const issues = [];
  const add = (scene, level, msg) => issues.push({ scene, level, msg });

  if (!project.style.visualStyle) add(null, 'error', 'Chưa khóa phong cách hình ảnh (Visual style). Mọi cảnh sẽ dễ lệch tông.');
  for (const c of project.characters) {
    if (!c.identity || c.identity.length < 40) add(null, 'error', `${c.name} (${c.tag}) thiếu mô tả nhận dạng chi tiết — đây là thứ giữ mặt nhân vật.`);
    if (!c.wardrobe) add(null, 'warn', `${c.name} chưa khóa trang phục.`);
    if (m.maxRefs > 0 && !c.refImages.length) add(null, 'warn', `${c.name} chưa có ảnh tham chiếu.`);
  }
  const scenes = project.script.scenes.filter((s) => s.enabled);
  if (!scenes.length) add(null, 'error', 'Chưa có cảnh nào trong kịch bản.');
  scenes.forEach((s) => {
    const idx = project.script.scenes.indexOf(s);
    for (const t of s.characters) if (!charByTag(project, t)) add(s.id, 'error', `Nhân vật ${t} không có trong danh sách nhân vật.`);
    if (s.location && !locByTag(project, s.location) && s.location.startsWith('#')) add(s.id, 'warn', `Bối cảnh ${s.location} chưa được định nghĩa.`);
    for (const d of s.dialogue) {
      const who = String(d.who || '').toLowerCase();
      const isNarr = /narrat|dẫn|voice/.test(who);
      const c = charByTag(project, d.who) || project.characters.find((x) => x.name.toLowerCase() === who);
      if (!isNarr && (!c || !s.characters.includes(c.tag))) add(s.id, 'warn', `Người nói "${d.who}" không có mặt trong cảnh.`);
    }
    const dur = fitDuration(model, s.duration);
    if (dur !== Number(s.duration)) add(s.id, 'info', `${m.label} không hỗ trợ ${s.duration}s — sẽ dùng ${dur}s.`);
    if (idx > 0 && !s.startState && s.transition === 'continuous') add(s.id, 'warn', 'Cảnh nối liền nhưng thiếu trạng thái mở đầu (startState).');
    if (!s.endState && idx < project.script.scenes.length - 1) add(s.id, 'info', 'Thiếu trạng thái kết cảnh (endState) — cảnh sau khó nối mạch.');
    const c = compileScene(project, s, idx, { model });
    for (const w of c.warnings) add(s.id, 'warn', w);
  });
  return issues;
}

// Chế độ Tạo nhanh: thay @tag trong câu bằng tên + khóa nhận dạng, thêm khóa phong cách.
function compileQuick(project, text, opts = {}) {
  const modelId = opts.model || (project && project.brief.model) || 'veo-3.1-fast';
  const m = videoModel(modelId);
  let body = String(text || '').trim();
  const used = [];
  if (project) {
    body = body.replace(/@[a-z0-9_]+/gi, (tag) => {
      const c = charByTag(project, tag);
      if (!c) return tag;
      if (!used.includes(c)) used.push(c);
      return c.name;
    });
  }
  const lines = [];
  if (project && styleLock(project)) lines.push(`Visual style: ${styleLock(project)}.`);
  lines.push(aspectLine(opts.aspect || (project && project.brief.aspect) || '16:9', m.provider));
  if (used.length) {
    lines.push('Characters (exact same appearance as in all other shots):');
    used.forEach((c, i) => {
      const mark = c.refImages[0] && i < m.maxRefs ? ` (${refMarker(m.provider, i + 1, false)})` : '';
      lines.push(`- ${c.name}${mark}: ${describeChar(c)}`);
    });
  }
  lines.push(body);
  if (project && project.style.negative) lines.push(`Avoid: ${trimDot(project.style.negative)}.`);
  const refs = used.filter((c) => c.refImages[0]).slice(0, m.maxRefs).map((c) => ({ kind: 'character', tag: c.tag, name: c.name, file: c.refImages[0] }));
  return { prompt: lines.join('\n'), refs, model: modelId, provider: m.provider };
}

// Tách khối prompt trong ô Tạo nhanh: các video cách nhau bằng 1 dòng trắng.
function splitQuickBlocks(text) {
  return String(text || '').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
}

module.exports = { compileScene, lintProject, compileQuick, splitQuickBlocks, continuityPlan, pickRefs, styleLock, charByTag, locByTag, MAX_PROMPT_CHARS };
