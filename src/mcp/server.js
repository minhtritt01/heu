#!/usr/bin/env node
'use strict';
// MCP server cho Claude Desktop: Claude trên máy đọc thẳng dữ liệu dự án của H2 Video Studio
// (nhân vật, kịch bản, prompt đã ghép, báo cáo đối thủ) và ghi kết quả ngược lại vào app.
// Giao thức: JSON-RPC 2.0 qua stdin/stdout, mỗi thông điệp một dòng.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Store } = require('../core/store');
const { compileScene, lintProject } = require('../core/compiler');
const brain = require('../core/brain');
const { mergeBible, mergeScript, applyPatches } = require('../core/studio');
const { referencePrompts } = require('../core/brain');
const { ensureDir, writeJson, uid } = require('../core/util');

const WORKSPACE = process.env.H2_WORKSPACE || process.argv[2] || path.join(os.homedir(), 'Documents', 'H2VideoStudio');
const store = new Store(WORKSPACE);

function findProject(ref) {
  const hit = store.findByName(ref);
  if (!hit) throw new Error(`Không thấy dự án "${ref}". Gọi list_projects để xem tên chính xác.`);
  return store.get(hit.id);
}

const projectArg = { type: 'string', description: 'Tên hoặc id dự án (xem list_projects)' };

const TOOLS = [
  {
    name: 'list_projects',
    description: 'Liệt kê các dự án video trong H2 Video Studio.',
    inputSchema: { type: 'object', properties: {} },
    run: () => store.list()
  },
  {
    name: 'create_project',
    description: 'Tạo dự án video mới với chủ đề và thông số cơ bản.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, topic: { type: 'string' }, goal: { type: 'string' }, genre: { type: 'string' }, audience: { type: 'string' },
        aspect: { type: 'string', enum: ['16:9', '9:16'] }, targetSeconds: { type: 'number' },
        model: { type: 'string', enum: ['veo-3.1-fast', 'veo-3.1-lite', 'veo-3.1-quality', 'omni-flash', 'meta-muse'] },
        narration: { type: 'string', enum: ['dialogue', 'voiceover', 'none'] }, dialogueLanguage: { type: 'string' }
      },
      required: ['name', 'topic']
    },
    run: (a) => {
      const brief = {};
      for (const k of ['topic', 'goal', 'genre', 'audience', 'aspect', 'targetSeconds', 'model', 'narration', 'dialogueLanguage']) if (a[k] != null) brief[k] = a[k];
      const p = store.create(a.name, { brief });
      return { id: p.id, name: p.name, message: 'Đã tạo. Bước tiếp: get_writing_rules(task="bible") rồi save_bible.' };
    }
  },
  {
    name: 'get_project',
    description: 'Đọc toàn bộ dự án: brief, khóa phong cách, nhân vật, bối cảnh, kịch bản, prompt cuối cùng sẽ gửi cho model video, và các lỗi nhất quán phát hiện bằng code.',
    inputSchema: { type: 'object', properties: { project: projectArg, includePrompts: { type: 'boolean', default: true } }, required: ['project'] },
    run: (a) => {
      const p = findProject(a.project);
      const out = { project: p, lint: lintProject(p) };
      if (a.includePrompts !== false) {
        out.compiledPrompts = p.script.scenes.map((s, i) => {
          const c = compileScene(p, s, i);
          return { id: s.id, prompt: c.prompt, chainFromPrevious: c.plan.chain, referenceImages: c.refs.map((r) => r.name), warnings: c.warnings };
        });
      }
      return out;
    }
  },
  {
    name: 'get_writing_rules',
    description: 'BẮT BUỘC đọc trước khi viết. Trả về đúng bộ quy tắc + khuôn JSON mà app dùng cho từng việc (bible = phong cách & nhân vật, script = kịch bản, review = kiểm tra nhất quán, competitor = phân tích đối thủ).',
    inputSchema: { type: 'object', properties: { project: projectArg, task: { type: 'string', enum: ['bible', 'script', 'review', 'competitor'] }, instructions: { type: 'string' } }, required: ['task'] },
    run: (a) => {
      if (a.task === 'competitor') return brain.competitorPrompt({ url: a.project || '', notes: a.instructions });
      const p = findProject(a.project);
      if (a.task === 'bible') return brain.biblePrompt(p, a.instructions);
      if (a.task === 'script') return brain.scriptPrompt(p, { instructions: a.instructions });
      return brain.reviewPrompt(p);
    }
  },
  {
    name: 'save_bible',
    description: 'Lưu khóa phong cách, nhân vật (mô tả nhận dạng tiếng Anh, trang phục, giọng) và bối cảnh vào dự án. Nhân vật đã có mô tả sẽ được giữ nguyên.',
    inputSchema: {
      type: 'object',
      properties: {
        project: projectArg,
        style: { type: 'object', description: '{visualStyle, palette, lighting, camera, world, negative}' },
        characters: { type: 'array', items: { type: 'object' }, description: '[{tag:"@x", name, role, identity, wardrobe, voice, personality}]' },
        locations: { type: 'array', items: { type: 'object' }, description: '[{tag:"#x", name, description}]' }
      },
      required: ['project']
    },
    run: (a) => {
      const p = findProject(a.project);
      store.update(p.id, (cur) => mergeBible(cur, a));
      const after = store.get(p.id);
      return { characters: after.characters.map((c) => c.tag + ' ' + c.name), locations: after.locations.map((l) => l.tag), referencePrompts: after.characters.map((c) => ({ tag: c.tag, ...referencePrompts(after, c, 'character') })) };
    }
  },
  {
    name: 'save_script',
    description: 'Lưu kịch bản (thay toàn bộ cảnh). Mỗi cảnh = 1 shot liền, không tả ngoại hình nhân vật trong action.',
    inputSchema: {
      type: 'object',
      properties: {
        project: projectArg, logline: { type: 'string' }, theme: { type: 'string' }, outline: { type: 'array', items: { type: 'object' } },
        scenes: { type: 'array', items: { type: 'object' } }, newCharacters: { type: 'array', items: { type: 'object' } }, newLocations: { type: 'array', items: { type: 'object' } }
      },
      required: ['project', 'scenes']
    },
    run: (a) => {
      const p = findProject(a.project);
      store.update(p.id, (cur) => mergeScript(cur, a));
      const after = store.get(p.id);
      return { scenes: after.script.scenes.length, lint: lintProject(after) };
    }
  },
  {
    name: 'update_scene',
    description: 'Sửa một cảnh: truyền các trường cần đổi (action, startState, endState, dialogue, camera, sound, mood, characters, location, transition, duration, title).',
    inputSchema: { type: 'object', properties: { project: projectArg, sceneId: { type: 'string' }, fields: { type: 'object' } }, required: ['project', 'sceneId', 'fields'] },
    run: (a) => {
      const p = findProject(a.project);
      const patches = Object.entries(a.fields).map(([field, value]) => ({ scene: a.sceneId, field, value }));
      let n = 0;
      store.update(p.id, (cur) => { n = applyPatches(cur, patches); return cur; });
      const after = store.get(p.id);
      const i = after.script.scenes.findIndex((s) => s.id === a.sceneId);
      return { updatedFields: n, prompt: i >= 0 ? compileScene(after, after.script.scenes[i], i).prompt : null };
    }
  },
  {
    name: 'save_review',
    description: 'Lưu kết quả kiểm tra nhất quán {score, summary, issues, patches}. Người dùng sẽ duyệt và áp dụng patch trong app.',
    inputSchema: { type: 'object', properties: { project: projectArg, review: { type: 'object' } }, required: ['project', 'review'] },
    run: (a) => {
      const p = findProject(a.project);
      store.update(p.id, (cur) => { cur.review = { ...a.review, at: new Date().toISOString() }; return cur; });
      return 'Đã lưu. Người dùng mở tab Kiểm tra để áp dụng.';
    }
  },
  {
    name: 'save_competitor_report',
    description: 'Lưu báo cáo phân tích video đối thủ (khuôn JSON lấy từ get_writing_rules task=competitor). Có thể gắn vào dự án có sẵn hoặc tạo dự án mới từ recommendedBrief.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, report: { type: 'object' }, project: { type: 'string', description: 'Bỏ trống để tạo dự án mới' } }, required: ['report'] },
    run: (a) => {
      const competitor = { url: a.url || '', report: a.report, at: new Date().toISOString() };
      const dir = ensureDir(path.join(WORKSPACE, 'competitors'));
      writeJson(path.join(dir, uid('r_') + '.json'), competitor);
      if (a.project) {
        const p = findProject(a.project);
        store.update(p.id, (cur) => { cur.competitor = competitor; return cur; });
        return 'Đã gắn báo cáo vào dự án ' + p.name;
      }
      const rb = a.report.recommendedBrief || {};
      const p = store.create(rb.topic || a.report.title || 'Từ phân tích đối thủ', { brief: rb, competitor });
      return { message: 'Đã tạo dự án mới từ báo cáo', id: p.id, name: p.name };
    }
  },
  {
    name: 'request_render',
    description: 'Gửi yêu cầu render các cảnh sang app (app phải đang mở). Bỏ trống scenes để render tất cả cảnh chưa có video.',
    inputSchema: { type: 'object', properties: { project: projectArg, scenes: { type: 'array', items: { type: 'string' } } }, required: ['project'] },
    run: (a) => {
      const p = findProject(a.project);
      const dir = ensureDir(path.join(WORKSPACE, 'inbox'));
      writeJson(path.join(dir, uid('req_') + '.json'), { type: 'render', projectId: p.id, scenes: a.scenes || null });
      return 'Đã gửi. App H2 Video Studio sẽ đưa các cảnh vào hàng đợi render.';
    }
  }
];

// ---------- JSON-RPC qua stdio ----------
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'h2-video-studio', version: '1.0.0' },
      instructions: 'H2 Video Studio: app tạo video AI. Khi người dùng nhờ viết kịch bản / tạo nhân vật / kiểm tra / phân tích đối thủ cho một dự án: 1) list_projects, 2) get_writing_rules đúng task, 3) get_project, 4) viết theo đúng quy tắc, 5) lưu bằng save_bible / save_script / save_review / save_competitor_report. Không tả ngoại hình nhân vật trong action vì app tự chèn mô tả khóa.'
    } });
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === (params && params.name));
    if (!tool) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Không có tool ' + (params && params.name) } });
    try {
      const r = tool.run((params && params.arguments) || {});
      const text = typeof r === 'string' ? r : JSON.stringify(r, null, 1);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } catch (e) {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Lỗi: ' + e.message }], isError: true } });
    }
  }
  if (id !== undefined && id !== null) {
    if (method && method.startsWith('notifications/')) return undefined;
    return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  }
  return undefined;
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch (e) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: ' + e.message } }); }
  }
});
process.stdin.on('end', () => process.exit(0));
fs.writeSync(2, `[h2-video-studio MCP] workspace: ${WORKSPACE}\n`);
