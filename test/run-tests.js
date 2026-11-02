'use strict';
// Kiểm tra phần lõi không cần Electron: node test/run-tests.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const { Store } = require('../src/core/store');
const { compileScene, lintProject, compileQuick, splitQuickBlocks } = require('../src/core/compiler');
const { mergeBible, mergeScript, applyPatches, Studio } = require('../src/core/studio');
const { extractJson } = require('../src/core/util');
const brain = require('../src/core/brain');
const pricing = require('../src/core/pricing');
const { ClaudeRunner } = require('../src/core/claude');
const { UseApi } = require('../src/core/providers/useapi');
const { RenderQueue } = require('../src/core/queue');
const { Media, vttToText } = require('../src/core/media');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h2test-'));
let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const BIBLE = {
  style: { visualStyle: '3D Pixar-like animation, soft global illumination, rounded shapes', palette: 'warm oranges and teal', lighting: 'golden hour', negative: 'subtitles, watermark' },
  characters: [
    { tag: '@lan', name: 'Lan', role: 'hero', identity: 'Vietnamese girl around 10 years old, small slim build, round face, warm light-tan skin, big dark-brown almond eyes, black hair in two short pigtails with red ties, tiny mole under left eye.', wardrobe: 'yellow raincoat over white T-shirt, blue shorts, red rubber boots', voice: 'bright, fast, curious child voice' },
    { tag: '@ong', name: 'Ông Tư', role: 'grandfather', identity: 'Vietnamese man in his 70s, thin and slightly stooped, long oval face, deep wrinkles, white thin moustache and short white hair, kind narrow eyes behind round wire glasses.', wardrobe: 'faded brown áo bà ba shirt, black trousers, conical non la hat', voice: 'slow, low, gentle southern Vietnamese accent' }
  ],
  locations: [{ tag: '#ben', name: 'River pier', description: 'old wooden pier on a wide brown Mekong river, coconut palms, small blue wooden boat tied to a post' }]
};
const SCRIPT = {
  logline: 'Lan học câu cá với ông', outline: [],
  scenes: [
    { title: 'Mở', duration: 8, location: '#ben', characters: ['@lan', '@ong'], startState: 'Lan runs onto the pier', action: 'Lan stops beside Ông Tư who is fishing', endState: 'Lan sits next to Ông Tư, legs dangling', dialogue: [{ who: '@lan', line: 'Grandpa, can I try?' }], camera: 'wide shot, slow push-in', sound: 'river water, birds', transition: 'cut' },
    { title: 'Câu', duration: 8, location: '#ben', characters: ['@lan', '@ong'], startState: 'Lan sits next to Ông Tư, legs dangling', action: 'Ông Tư hands Lan the bamboo rod', endState: 'Lan grips the rod with both hands', dialogue: [{ who: '@ong', line: 'Hold it gently, like a bird.' }], camera: 'medium two-shot', sound: 'water lapping', transition: 'continuous' },
    { title: 'Kéo', duration: 6, location: '#ben', characters: ['@lan'], startState: 'Lan grips the rod', action: 'The rod bends hard and Lan pulls', endState: 'a silver fish flips out of the water', dialogue: [{ who: '@ghost', line: 'This is a very very long line that will definitely exceed the word budget for an eight second clip for sure' }], camera: 'close-up', transition: 'continuous' }
  ]
};

const store = new Store(path.join(tmp, 'ws'));

test('Nhân bản dự án: chép ảnh tham chiếu, đổi đường dẫn, tùy chọn giữ kịch bản', () => {
  const p = store.create('Gốc', { brief: { topic: 't' } });
  const ref = path.join(store.projectDir(p.id), 'refs', 'lan.png');
  fs.writeFileSync(ref, 'IMG');
  const vid = path.join(store.projectDir(p.id), 'videos', 'S01_v1.mp4');
  fs.writeFileSync(vid, 'VID');
  store.update(p.id, (cur) => { mergeBible(cur, BIBLE); mergeScript(cur, SCRIPT); cur.characters[0].refImages = [ref]; cur.script.scenes[0].takes = [{ file: vid }]; cur.script.scenes[0].selected = vid; return cur; });
  const a = store.duplicate(p.id, 'Bản A');
  assert.notStrictEqual(a.id, p.id);
  assert.strictEqual(a.name, 'Bản A');
  assert.ok(a.characters[0].refImages[0].startsWith(store.projectDir(a.id)), 'ảnh phải nằm trong dự án mới');
  assert.strictEqual(fs.readFileSync(a.characters[0].refImages[0], 'utf8'), 'IMG');
  assert.strictEqual(a.script.scenes.length, 3);
  assert.strictEqual(a.script.scenes[0].selected, '');
  const b = store.duplicate(p.id, 'Bản B', { videos: true });
  assert.strictEqual(fs.readFileSync(b.script.scenes[0].selected, 'utf8'), 'VID');
  assert.ok(b.script.scenes[0].selected.startsWith(store.projectDir(b.id)));
  const c = store.duplicate(p.id, 'Phần 2', { script: false });
  assert.strictEqual(c.script.scenes.length, 0);
  assert.strictEqual(c.characters.length, 2);
  // bản gốc không bị đụng tới
  assert.strictEqual(store.get(p.id).script.scenes[0].selected, vid);
  test.dupId = p.id;
});

test('Thùng rác: xóa → liệt kê → khôi phục (kể cả khi trùng mã) → xóa vĩnh viễn', () => {
  const id = test.dupId;
  const before = store.get(id);
  store.remove(id);
  assert.ok(!store.list().some((x) => x.id === id));
  const tr = store.listTrash().find((x) => x.id === id);
  assert.ok(tr && tr.name === 'Gốc' && tr.scenes === 3);
  const r = store.restore(tr.folder);
  assert.strictEqual(r.id, id);
  assert.strictEqual(fs.readFileSync(r.characters[0].refImages[0], 'utf8'), 'IMG');
  assert.deepStrictEqual(r.characters[0].refImages, before.characters[0].refImages);
  // khôi phục khi đã có dự án cùng mã → cấp mã mới, sửa đường dẫn
  store.remove(id);
  const folder = store.listTrash().find((x) => x.id === id).folder;
  const dup = path.join(store.trashDir(), folder);
  const copyFolder = folder.replace(/-\d+$/, '-1');
  fs.cpSync(dup, path.join(store.trashDir(), copyFolder), { recursive: true });
  store.restore(folder);
  const r2 = store.restore(copyFolder);
  assert.notStrictEqual(r2.id, id);
  assert.ok(r2.name.endsWith('(khôi phục)'));
  assert.ok(r2.characters[0].refImages[0].startsWith(store.projectDir(r2.id)));
  store.remove(r2.id);
  const f3 = store.listTrash().find((x) => x.id === r2.id).folder;
  store.purge(f3);
  assert.ok(!store.listTrash().some((x) => x.folder === f3));
  assert.throws(() => store.restore('../etc'));
});

test('extractJson đọc được JSON bọc trong chữ/code fence', () => {
  assert.deepStrictEqual(extractJson('Here:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(extractJson('blah {"a":{"b":"}"}} tail'), { a: { b: '}' } });
  assert.deepStrictEqual(extractJson('[1,2]'), [1, 2]);
  assert.throws(() => extractJson('không có json'));
});

test('tạo dự án, gộp bible và kịch bản', () => {
  const p = store.create('Ông và cháu', { brief: { topic: 'Câu cá trên sông', model: 'veo-3.1-fast' } });
  store.update(p.id, (cur) => mergeBible(cur, BIBLE));
  store.update(p.id, (cur) => mergeScript(cur, SCRIPT));
  const q = store.get(p.id);
  assert.strictEqual(q.characters.length, 2);
  assert.strictEqual(q.script.scenes[2].id, 'S03');
  // gộp lần 2 không ghi đè khóa nhận dạng
  store.update(p.id, (cur) => mergeBible(cur, { characters: [{ tag: '@lan', name: 'Lan', identity: 'KHÁC HẲN' }] }));
  assert.ok(store.get(p.id).characters[0].identity.startsWith('Vietnamese girl'));
  test.pid = p.id;
});

test('ghép prompt chèn nguyên văn mô tả nhân vật vào MỌI cảnh', () => {
  const p = store.get(test.pid);
  p.script.scenes.forEach((s, i) => {
    const c = compileScene(p, s, i);
    for (const tag of s.characters) {
      const ch = p.characters.find((x) => x.tag === tag);
      assert.ok(c.prompt.includes(ch.identity.replace(/\.$/, '')), `${s.id} thiếu mô tả ${ch.name}`);
      assert.ok(c.prompt.includes('Wearing ' + ch.wardrobe.split(',')[0].trim().toLowerCase().slice(0, 10)), `${s.id} thiếu trang phục`);
    }
    assert.ok(c.prompt.includes('3D Pixar-like animation'), 'thiếu khóa phong cách');
    assert.ok(c.prompt.includes('Avoid: subtitles'), 'thiếu danh sách cấm');
  });
  const c1 = compileScene(p, p.script.scenes[0], 0);
  assert.ok(!/Wearing .*\.\./.test(c1.prompt), 'dấu chấm đôi');
  console.log('\n--- Prompt mẫu S02 ---\n' + compileScene(p, p.script.scenes[1], 1).prompt + '\n---');
});

test('chế độ nối tự động: cảnh "continuous" lấy khung cuối, cảnh "cut" dùng ảnh tham chiếu', () => {
  const p = store.get(test.pid);
  assert.strictEqual(compileScene(p, p.script.scenes[0], 0).plan.chain, false);
  assert.strictEqual(compileScene(p, p.script.scenes[1], 1).plan.chain, true);
  assert.strictEqual(compileScene(p, p.script.scenes[1], 1, { noChain: true }).plan.chain, false);
  // Muse: nối khung + vẫn giữ ảnh nhân vật
  const m = compileScene(p, p.script.scenes[1], 1, { model: 'meta-muse' });
  assert.ok(m.plan.chain && m.plan.useRefs);
  assert.ok(m.prompt.includes('in exactly 16:9'));
  assert.ok(m.prompt.includes('Animate image_1'));
});

test('ảnh tham chiếu được gắn đúng thứ tự và marker @referenceImage', () => {
  store.update(test.pid, (p) => { p.characters[0].refImages = ['/x/lan.png']; p.characters[1].refImages = ['/x/ong.png']; p.locations[0].refImages = ['/x/ben.png']; return p; });
  const p = store.get(test.pid);
  const c = compileScene(p, p.script.scenes[0], 0);
  assert.deepStrictEqual(c.refs.map((r) => r.file), ['/x/lan.png', '/x/ong.png', '/x/ben.png']);
  assert.ok(c.prompt.includes('Lan (@referenceImage_1)'));
  assert.ok(c.prompt.includes('Ông Tư (@referenceImage_2)'));
});

test('lint bắt lỗi nhân vật lạ, thoại dài, thời lượng sai', () => {
  const p = store.get(test.pid);
  const issues = lintProject(p);
  const s3 = issues.filter((i) => i.scene === 'S03').map((i) => i.msg).join(' | ');
  assert.ok(/@ghost|không có mặt/.test(s3), s3);
  assert.ok(/quá dài/.test(s3), s3);
  assert.ok(lintProject(p, 'meta-muse').some((i) => /sẽ dùng 10s/.test(i.msg)));
});

test('áp dụng patch từ Claude', () => {
  const p = store.get(test.pid);
  const n = applyPatches(p, [{ scene: 'S03', field: 'dialogue', value: [] }, { scene: 'S03', field: 'hack', value: 1 }, { scene: 'S02', field: 'characters', value: '@lan, @ong' }]);
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(p.script.scenes[1].characters, ['@lan', '@ong']);
});

test('Tạo nhanh: tách khối bằng dòng trắng và thay @tag', () => {
  const p = store.get(test.pid);
  assert.strictEqual(splitQuickBlocks('a\nb\n\n\nc\n  \n d').length, 3);
  const c = compileQuick(p, '@lan waves at the camera on #ben', { model: 'veo-3.1-fast' });
  assert.ok(c.prompt.includes('Lan waves'));
  assert.ok(c.prompt.includes(p.characters[0].identity.slice(0, 30)));
  assert.strictEqual(c.refs.length, 1);
});

test('prompt cho Claude chứa quy tắc khóa nhân vật & khuôn JSON', () => {
  const p = store.get(test.pid);
  const sp = brain.scriptPrompt(p);
  assert.ok(sp.includes('NEVER describe their face'));
  assert.ok(sp.includes('@lan'));
  assert.ok(/exactly \d+ scenes of 8 seconds/.test(sp));
  const rp = brain.reviewPrompt(p);
  assert.ok(rp.includes('FINAL PROMPTS'));
  const ref = brain.referencePrompts(p, p.characters[0], 'character');
  assert.ok(ref.sheet.includes(p.characters[0].identity));
});

test('bảng giá ước tính chi phí', () => {
  const p = store.get(test.pid);
  const e = pricing.estimateProject(p);
  assert.strictEqual(e.scenes, 3);
  assert.ok(e.credits > 0 && e.usd > 0);
  assert.ok(pricing.modelTable().length >= 5);
});

test('vtt → văn bản', () => {
  const t = vttToText('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello <c>world</c>\n\n00:00:02.000 --> 00:00:03.000\nHello world\nNext');
  assert.strictEqual(t, '[00:01] Hello world\n[00:02] Next');
});

test('ClaudeRunner gọi CLI, đọc JSON và nhờ sửa khi JSON hỏng', async () => {
  // Giả lập lệnh "claude": trả JSON hỏng ở lần 1, đúng ở lần 2
  const fake = path.join(tmp, 'claude');
  const counter = path.join(tmp, 'count');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('fs');let n=0;try{n=+fs.readFileSync(${JSON.stringify(counter)},'utf8')}catch{}
fs.writeFileSync(${JSON.stringify(counter)},String(n+1));
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
 if(!process.argv.includes('-p')||!process.argv.includes('dontAsk')){console.log('bad args');process.exit(2)}
 const result = n===0 ? 'Sure! {"scenes": [oops' : '{"ok":true,"len":'+input.length+'}';
 console.log(JSON.stringify({type:'result',is_error:false,result,total_cost_usd:0.01}));
});`);
  fs.chmodSync(fake, 0o755);
  const bin = process.platform === 'win32' ? (fs.writeFileSync(fake + '.cmd', '@"' + process.execPath + '" "' + fake + '" %*'), fake + '.cmd') : fake;
  const r = new ClaudeRunner({ getSettings: () => ({ claudePath: bin }), workDir: path.join(tmp, 'cw') });
  const j = await r.runJson('hello');
  assert.strictEqual(j.ok, true);
  assert.strictEqual(fs.readFileSync(counter, 'utf8'), '2');
});

test('Studio.writeScript chạy trọn: bible → script (Claude giả lập)', async () => {
  const fake = { runJson: async (prompt) => (prompt.includes('PRODUCTION BIBLE') ? BIBLE : SCRIPT) };
  const st = new Studio({ store, runner: fake });
  const p = store.create('Dự án 2', { brief: { topic: 'x' } });
  const out = await st.writeScript(p.id, {});
  assert.strictEqual(out.script.scenes.length, 3);
  assert.strictEqual(out.characters.length, 2);
});

test('Hàng đợi: Flow nối khung, upload có cache, tải về, cập nhật cảnh', async () => {
  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null });
    const ok = (obj, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(obj), arrayBuffer: async () => Buffer.from('MP4DATA') });
    if (url.includes('/google-flow/assets')) return ok({ mediaGenerationId: { mediaGenerationId: 'img:' + calls.length } });
    if (url.endsWith('/google-flow/videos')) return ok({ jobid: 'job' + calls.length, status: 'created' }, 201);
    if (url.includes('/google-flow/jobs/')) return ok({ status: 'completed', response: { media: [{ videoUrl: 'https://flow-content.google/v.mp4' }], remainingCredits: 999 } });
    if (url.startsWith('https://flow-content.google')) return ok({});
    return ok({ error: 'unknown' }, 404);
  };
  const settings = { veoToken: 'tok', flowEmail: 'a@b.c', maxParallel: 2, retries: 1 };
  const api = new UseApi(() => settings, fakeFetch);
  // chưa có ffmpeg thật trong test thì giả lập lastFrame/thumbnail
  const media = { lastFrame: async (v, png) => { fs.mkdirSync(path.dirname(png), { recursive: true }); fs.writeFileSync(png, 'PNG'); return png; }, thumbnail: async () => null };
  const ws = path.join(tmp, 'ws');
  const q = new RenderQueue({ workspace: ws, api, media, store, getSettings: () => settings });
  // ảnh tham chiếu thật trên đĩa
  const refA = path.join(tmp, 'lan.png'); fs.writeFileSync(refA, 'A');
  store.update(test.pid, (p) => { p.characters[0].refImages = [refA]; p.characters[1].refImages = [refA]; p.locations[0].refImages = []; return p; });
  const p = store.get(test.pid);
  const c1 = compileScene(p, p.script.scenes[0], 0);
  const t1 = q.add({ projectId: p.id, sceneId: 'S01', model: 'veo-3.1-fast', prompt: c1.prompt, refs: c1.refs.map((r) => r.file) });
  const t2 = q.add({ projectId: p.id, sceneId: 'S02', model: 'veo-3.1-fast', prompt: 'p2', refs: [], dependsOn: t1.id });
  const origSleep = require('../src/core/util').sleep;
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout: ' + JSON.stringify(q.tasks.map((t) => [t.status, t.error])))), 8000);
    q.on('update', () => { if (q.tasks.every((t) => ['done', 'failed'].includes(t.status))) { clearTimeout(to); resolve(); } });
  });
  assert.deepStrictEqual(q.tasks.map((t) => t.status), ['done', 'done'], JSON.stringify(q.tasks.map((t) => t.error)));
  const vidCalls = calls.filter((c) => c.url.endsWith('/google-flow/videos'));
  assert.strictEqual(vidCalls[0].body.referenceImage_1 !== undefined, true, 'S01 phải gửi ảnh tham chiếu');
  assert.strictEqual(vidCalls[0].body.aspectRatio, 'landscape');
  assert.ok(vidCalls[1].body.startImage, 'S02 phải dùng khung cuối của S01');
  assert.strictEqual(vidCalls[1].body.referenceImage_1, undefined);
  // cùng một file ảnh cho 2 nhân vật → chỉ upload 1 lần
  assert.strictEqual(calls.filter((c) => c.url.includes('/assets') && c.url.includes('flow')).length, 2); // 1 ảnh ref + 1 khung cuối
  const after = store.get(p.id);
  assert.ok(after.script.scenes[0].selected.endsWith('S01_v1.mp4'));
  assert.strictEqual(fs.readFileSync(after.script.scenes[1].selected, 'utf8'), 'MP4DATA');
  void origSleep;
});

test('Hàng đợi: giới hạn luồng riêng cho Muse và tổng số luồng', async () => {
  let inflight = { muse: 0, flow: 0 }, peak = { muse: 0, flow: 0, total: 0 };
  const settings = { veoToken: 'tok', museToken: 'tok2', maxParallel: 5, maxParallelFlow: 4, maxParallelMuse: 2, retries: 0 };
  const q = new RenderQueue({ workspace: path.join(tmp, 'ws3'), api: {}, media: {}, store, getSettings: () => settings });
  q.runVideo = async (t) => {
    const pv = t.model === 'meta-muse' ? 'muse' : 'flow';
    inflight[pv]++;
    peak[pv] = Math.max(peak[pv], inflight[pv]);
    peak.total = Math.max(peak.total, inflight.muse + inflight.flow);
    await new Promise((r) => setTimeout(r, 40));
    inflight[pv]--;
  };
  for (let i = 0; i < 6; i++) q.add({ model: 'meta-muse', prompt: 'm' + i });
  for (let i = 0; i < 6; i++) q.add({ model: 'veo-3.1-fast', prompt: 'f' + i });
  await new Promise((r) => { const iv = setInterval(() => { if (q.tasks.every((t) => t.status === 'done')) { clearInterval(iv); r(); } }, 20); });
  assert.strictEqual(peak.muse, 2, 'Muse vượt 2 luồng');
  assert.ok(peak.flow <= 4 && peak.flow >= 3, 'Flow ' + peak.flow);
  assert.strictEqual(peak.total, 5, 'tổng ' + peak.total);
});

test('Hàng đợi: lỗi 403 không thử lại và báo tiếng Việt dễ hiểu', async () => {
  const fakeFetch = async (url) => ({ ok: false, status: 403, text: async () => JSON.stringify({ error: 'blocked by policy' }) });
  const settings = { museToken: 'tok', maxParallel: 1, retries: 3 }; // chỉ có API Muse vẫn chạy được Muse
  const q = new RenderQueue({ workspace: path.join(tmp, 'ws2'), api: new UseApi(() => settings, fakeFetch), media: {}, store, getSettings: () => settings });
  const t = q.add({ model: 'meta-muse', prompt: 'x' });
  await new Promise((r) => q.on('update', () => { if (t.status === 'failed') r(); }));
  assert.strictEqual(t.attempts, 1);
  assert.ok(/bộ lọc nội dung/.test(t.error), t.error);
});

test('API riêng: Veo dùng veoToken, Muse dùng museToken, thiếu bên nào chỉ chặn bên đó', async () => {
  const { providerToken, hasProviderToken } = require('../src/core/providers/useapi');
  const seen = [];
  const fakeFetch = async (url, init = {}) => { seen.push({ url, auth: init.headers && init.headers.Authorization }); return { ok: true, status: 200, text: async () => JSON.stringify({ ok: 1 }) }; };
  const both = { veoToken: 'VEO', museToken: 'MUSE', museEmail: 'm@x.y' };
  const api = new UseApi(() => both, fakeFetch);
  await api.flowAccounts();
  await api.museAccount();
  assert.strictEqual(seen[0].auth, 'Bearer VEO');
  assert.strictEqual(seen[1].auth, 'Bearer MUSE');
  // chỉ có Muse → Veo báo thiếu API Veo 3, Muse vẫn chạy
  const onlyMuse = { museToken: 'MUSE', museEmail: 'm@x.y' };
  const api2 = new UseApi(() => onlyMuse, fakeFetch);
  await assert.rejects(() => api2.flowAccounts(), (e) => e.status === 401 && e.provider === 'flow' && /API Veo 3/.test(e.message));
  await api2.museAccount();
  // hàng đợi: thêm task Veo khi chưa có API Veo → báo lỗi rõ, không tạo task; Muse thì thêm được
  const q = new RenderQueue({ workspace: path.join(tmp, 'ws4'), api: {}, media: {}, store, getSettings: () => ({ ...onlyMuse, maxParallel: 1 }) });
  q.pump = () => {};
  assert.throws(() => q.add({ model: 'veo-3.1-fast', prompt: 'x' }), /cần API Veo 3/);
  assert.throws(() => q.add({ kind: 'image', model: 'nano-banana-pro', prompt: 'x' }), /cần API Veo 3/);
  assert.ok(q.add({ model: 'meta-muse', prompt: 'x' }).id);
  assert.ok(q.add({ kind: 'image', model: 'muse-image', prompt: 'x' }).id);
  // chỉ có Veo → Muse bị chặn
  const q2 = new RenderQueue({ workspace: path.join(tmp, 'ws5'), api: {}, media: {}, store, getSettings: () => ({ veoToken: 'VEO' }) });
  q2.pump = () => {};
  assert.throws(() => q2.add({ model: 'meta-muse', prompt: 'x' }), /cần API Meta Muse/);
  assert.ok(q2.add({ model: 'veo-3.1-lite', prompt: 'x' }).id);
  // token cũ dùng chung vẫn chạy cho cả hai (tương thích bản trước)
  assert.strictEqual(providerToken({ useapiToken: 'OLD' }, 'muse'), 'OLD');
  assert.strictEqual(providerToken({ useapiToken: 'OLD', veoToken: 'NEW' }, 'flow'), 'NEW');
  assert.strictEqual(hasProviderToken({}, 'flow'), false);
});

test('Cầu nối Chrome: tiện ích nhận việc, gửi file về, task xong; chặn sai mã và trang web lạ', async () => {
  const { FlowBridge } = require('../src/core/bridge');
  const settings = { veoMode: 'extension', flowBridgeKey: 'AB12-CD34', maxParallel: 3, retries: 0 };
  const bridge = new FlowBridge({ getSettings: () => settings });
  const port = await bridge.start(0);
  const base = 'http://127.0.0.1:' + port;
  const H = { 'X-HEU-Key': 'AB12-CD34' };
  try {
    assert.strictEqual((await fetch(base + '/bridge/next', { headers: { 'X-HEU-Key': 'SAI' } })).status, 401);
    assert.strictEqual((await fetch(base + '/bridge/next', { headers: { ...H, Origin: 'https://evil.example' } })).status, 403);
    const q = new RenderQueue({ workspace: path.join(tmp, 'ws6'), api: {}, media: { thumbnail: async () => null }, store, getSettings: () => settings, bridge });
    // chế độ Chrome: không cần token Veo
    const t = q.add({ kind: 'image', model: 'nano-banana-2', prompt: 'a red boat', aspect: '16:9' });
    const t2 = q.add({ model: 'veo-3.1-fast', prompt: 'a kite', aspect: '9:16' });
    await fetch(base + '/bridge/hello', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ flowTab: true, version: '1.0.0' }) });
    assert.ok(bridge.isReady());
    let j = null;
    for (let i = 0; i < 40 && !j; i++) { j = (await (await fetch(base + '/bridge/next', { headers: H })).json()).job; if (!j) await new Promise((r) => setTimeout(r, 50)); }
    assert.strictEqual(j.kind, 'image');
    assert.strictEqual(j.flowModel, 'Nano Banana 2.1');
    // chỉ 1 việc Flow một lúc trong chế độ Chrome
    assert.strictEqual((await (await fetch(base + '/bridge/next', { headers: H })).json()).job, null);
    await fetch(base + '/bridge/progress?id=' + j.id, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ progress: '45%' }) });
    assert.ok(/45%/.test(t.progress), t.progress);
    const up = await fetch(base + '/bridge/upload?id=' + j.id + '&ext=png&mediaId=m1', { method: 'POST', headers: H, body: Buffer.alloc(5000, 7) });
    assert.strictEqual(up.status, 200);
    for (let i = 0; i < 40 && t.status !== 'done'; i++) await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(t.status, 'done', t.error);
    assert.ok(t.output.endsWith('.png') && fs.statSync(t.output).size === 5000);
    // việc thứ 2 (video) → tiện ích báo lỗi bộ lọc → task lỗi, thông báo dễ hiểu
    let j2 = null;
    for (let i = 0; i < 40 && !j2; i++) { j2 = (await (await fetch(base + '/bridge/next', { headers: H })).json()).job; if (!j2) await new Promise((r) => setTimeout(r, 50)); }
    assert.strictEqual(j2.flowModel, 'Veo 3.1 - Fast');
    assert.strictEqual(j2.aspect, '9:16');
    await fetch(base + '/bridge/error?id=' + j2.id, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'This prompt violates our policy' }) });
    for (let i = 0; i < 40 && t2.status !== 'failed'; i++) await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(t2.status, 'failed');
    assert.ok(/bộ lọc/.test(t2.error), t2.error);
  } finally { bridge.stop(); }
});

test('MCP server: initialize, tools/list, get_project, save_review', async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp', 'server.js')], { env: { ...process.env, H2_WORKSPACE: path.join(tmp, 'ws') } });
  const lines = [];
  let buf = '';
  srv.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const sendMsg = (m) => srv.stdin.write(JSON.stringify(m) + '\n');
  sendMsg({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  sendMsg({ jsonrpc: '2.0', method: 'notifications/initialized' });
  sendMsg({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  sendMsg({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_project', arguments: { project: 'Ông và cháu' } } });
  sendMsg({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'save_review', arguments: { project: 'Ông và cháu', review: { score: 80, issues: [], patches: [] } } } });
  sendMsg({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_writing_rules', arguments: { project: 'Ông và cháu', task: 'script' } } });
  await new Promise((r) => { const iv = setInterval(() => { if (lines.length >= 5) { clearInterval(iv); r(); } }, 50); });
  srv.kill();
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
  assert.strictEqual(byId[1].result.serverInfo.name, 'h2-video-studio');
  assert.ok(byId[2].result.tools.length >= 9);
  const gp = JSON.parse(byId[3].result.content[0].text);
  assert.ok(gp.compiledPrompts[0].prompt.includes('Lan'));
  assert.strictEqual(store.get(test.pid).review.score, 80);
  assert.ok(byId[5].result.content[0].text.includes('AI-VIDEO RULES'));
});

test('FFmpeg: lấy khung cuối và ghép phim (nếu máy có ffmpeg)', async () => {
  let ff = null;
  try { execFileSync('ffmpeg', ['-version']); ff = 'ffmpeg'; } catch { console.log('   (bỏ qua: không có ffmpeg)'); return; }
  const m = new Media(() => ({ ffmpegPath: '' }), path.join(tmp, 'tools'));
  m.ff = () => ff;
  const a = path.join(tmp, 'a.mp4'), b = path.join(tmp, 'b.mp4');
  execFileSync(ff, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest', '-pix_fmt', 'yuv420p', a], { stdio: 'ignore' });
  execFileSync(ff, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=2', '-pix_fmt', 'yuv420p', b], { stdio: 'ignore' }); // không có tiếng
  const png = await m.lastFrame(a, path.join(tmp, 'frames', 'a_last.png'));
  assert.ok(fs.statSync(png).size > 1000);
  const out = await m.concat([a, b], path.join(tmp, 'out', 'film.mp4'), { aspect: '16:9' });
  const d = await m.duration(out);
  assert.ok(d > 3.8 && d < 4.3, 'độ dài ' + d);
  assert.ok(await m.hasAudio(out));
  const out2 = await m.concat([a, b, a], path.join(tmp, 'out', 'film2.mp4'), { aspect: '9:16', crossfade: 0.5 });
  const d2 = await m.duration(out2);
  assert.ok(d2 > 4.8 && d2 < 5.3, 'crossfade ' + d2);
});

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log('✔ ' + t.name);
    } catch (e) {
      console.log('✘ ' + t.name + '\n   ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n   '));
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${tests.length} bài kiểm tra đạt`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
})();
