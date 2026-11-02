'use strict';
// "Bộ não" — các việc giao cho Claude trên máy: phân tích đối thủ, dựng bộ nhân vật (bible),
// viết kịch bản liền mạch, kiểm tra nhất quán, sửa cảnh, chuốt prompt nhanh.
// Mọi câu lệnh gửi Claude đều yêu cầu trả JSON theo khuôn cố định để app đọc được chắc chắn.
const { videoModel, fitDuration, dialogueBudget } = require('./models');
const { compileScene, styleLock } = require('./compiler');

const ROLE = `You are the head writer, art director and continuity supervisor of "H2 Video Studio", a desktop app that turns a story into a series of short AI-generated video clips (Google Veo 3.1 / Gemini Omni Flash / Meta Muse). Each scene you write becomes ONE continuous, uncut shot rendered separately by a video model that has NO memory of the other shots. Your writing is what keeps the film coherent, on-topic and consistent.`;

const JSON_ONLY = `Return ONLY one valid JSON value. No markdown, no code fences, no commentary before or after.`;

function projectContext(p, { withScenes = true } = {}) {
  const ctx = {
    name: p.name,
    brief: p.brief,
    styleLock: p.style,
    characters: p.characters.map((c) => ({ tag: c.tag, name: c.name, role: c.role, identity: c.identity, wardrobe: c.wardrobe, voice: c.voice, personality: c.personality })),
    locations: p.locations.map((l) => ({ tag: l.tag, name: l.name, description: l.description }))
  };
  if (withScenes) ctx.script = p.script;
  if (p.competitor && p.competitor.report) {
    const r = p.competitor.report;
    ctx.competitorInsights = { structure: r.structure, hook: r.hook, pacing: r.pacing, retentionTricks: r.retentionTricks, whyItWorks: r.whyItWorks, weaknesses: r.weaknesses };
  }
  return JSON.stringify(ctx, null, 1);
}

// ---------- 1. Phân tích video đối thủ ----------
function competitorPrompt({ url, meta, transcript, notes }) {
  return `${ROLE}

TASK: Reverse-engineer a competitor video so the user can make a BETTER, ORIGINAL video in the same niche. Never copy their script, characters or titles; extract the mechanics.

Video URL: ${url || '(none)'}
${meta ? 'Metadata (title, channel, views, duration, description, tags):\n' + JSON.stringify(meta).slice(0, 6000) : ''}
${transcript ? 'Transcript / subtitles (may be auto-generated):\n' + transcript.slice(0, 40000) : 'No transcript was downloaded. If a URL is given, you may use WebFetch / WebSearch to read the page, its description and public info about it.'}
${notes ? 'User notes: ' + notes : ''}

Answer in Vietnamese for all analysis text, but keep "ideas[].title" in the language that fits the video's audience.
JSON shape:
{
 "title": "", "channel": "", "niche": "", "durationSec": 0, "views": 0,
 "summary": "2-3 câu tóm tắt nội dung",
 "hook": {"text": "câu/hình mở đầu", "technique": "vì sao nó giữ người xem", "seconds": 0},
 "structure": [{"part": "Hook|Setup|Escalation|Twist|Payoff|CTA...", "time": "0:00-0:15", "purpose": "", "technique": ""}],
 "pacing": "nhịp cắt, số cảnh/phút, độ dài câu",
 "visualStyle": "phong cách hình: 2D/3D/live-action, màu, ánh sáng, góc máy",
 "characters": [{"name": "", "look": "", "role": ""}],
 "audioStyle": "giọng đọc / thoại / nhạc / SFX",
 "retentionTricks": [""],
 "whyItWorks": [""],
 "weaknesses": ["điểm yếu ta có thể làm tốt hơn"],
 "titlePattern": "", "thumbnailPattern": "",
 "ideas": [{"title": "", "angle": "", "hook": "", "whyBetter": ""}],
 "recommendedBrief": {"topic": "", "goal": "", "genre": "", "audience": "", "narration": "dialogue|voiceover|none", "aspect": "16:9|9:16", "targetSeconds": 64, "dialogueLanguage": "English", "styleSuggestion": ""}
}
Give 6-10 ideas. ${JSON_ONLY}`;
}

// ---------- 2. Dựng bộ nhân vật / phong cách / bối cảnh ----------
function biblePrompt(p, instructions) {
  return `${ROLE}

TASK: Create the PRODUCTION BIBLE (style lock + character identity locks + locations) for this project. These texts are pasted VERBATIM by the app into every single video prompt, so they must be precise, visual and stable.

PROJECT:
${projectContext(p, { withScenes: false })}
${instructions ? '\nUSER INSTRUCTIONS: ' + instructions : ''}

RULES
- Write style, identity, wardrobe, voice and location descriptions in ENGLISH (video models understand English best). Names may stay Vietnamese if the story is Vietnamese.
- styleLock.visualStyle: one sentence fixing medium + rendering + era + overall look (e.g. "2D flat vector animation, thick black outlines, cel shading, soft paper texture"). It must fit the topic and audience.
- character.identity: 45-90 words of FIXED physical traits only: species/age range/gender presentation, height & build, face shape, skin tone, eye colour & shape, eyebrows, nose, hair colour/length/style, facial hair, distinctive marks (scar, mole, glasses), body proportions for stylised characters (e.g. stickman: round head, line thickness, dot eyes). NO emotions, NO actions, NO clothing, NO camera words. Make each character instantly distinguishable from the others (different silhouette, hair colour, colour accent).
- character.wardrobe: exact garments with colours and materials + one signature accessory. Keep it constant for the whole film unless the story requires a change.
- character.voice: age, timbre, pitch, pace, accent (used for native audio).
- tag: lowercase "@" + short ascii handle, unique (e.g. "@lan", "@kip").
- locations: every place the story needs, tag "#" + short ascii handle, description 25-60 words of fixed visual facts (architecture, materials, colours, landmarks, light source) so the place looks the same in every shot.
- negative: comma list of things to avoid for this style (always include subtitles, on-screen text, watermark, extra limbs, face morphing).
- If characters/locations already exist with an identity, KEEP their tag and identity text unchanged (you may fill empty fields). Add new ones only if the story needs them. Usually 1-4 characters.

JSON shape:
{"style": {"visualStyle": "", "palette": "", "lighting": "", "camera": "default camera language", "world": "era/world rules", "negative": ""},
 "characters": [{"tag": "@x", "name": "", "role": "", "identity": "", "wardrobe": "", "voice": "", "personality": "Vietnamese, 1 câu"}],
 "locations": [{"tag": "#x", "name": "", "description": ""}]}
${JSON_ONLY}`;
}

// ---------- 3. Viết kịch bản liền mạch ----------
function scriptPrompt(p, { sceneCount, instructions } = {}) {
  const model = videoModel(p.brief.model);
  const dur = fitDuration(p.brief.model, model.defaultDuration);
  const count = sceneCount || Math.max(1, Math.round((Number(p.brief.targetSeconds) || 64) / dur));
  const budget = dialogueBudget(dur);
  const narr = { dialogue: 'characters speak on screen (native audio)', voiceover: 'a narrator voice-over carries the story; characters mostly do not talk', none: 'no speech at all — tell the story with action, sound effects and music only' }[p.brief.narration] || 'characters speak';
  return `${ROLE}

TASK: Write the full shot-by-shot script: exactly ${count} scenes of ${dur} seconds each (model: ${model.label}).

PROJECT:
${projectContext(p, { withScenes: false })}
${instructions ? '\nUSER INSTRUCTIONS: ' + instructions : ''}

STORYTELLING RULES
- Topic lock: every scene must serve the topic "${p.brief.topic}" and the goal "${p.brief.goal || ''}". No side plots, no random new elements. Write the logline first and keep checking each scene against it.
- Structure: scene 1 is a HOOK that grabs attention in the first 2 seconds; then setup → escalation → turning point → payoff/ending that resolves the hook. Clear cause → effect between consecutive scenes.
- Audio mode: ${narr}. Dialogue language: ${p.brief.dialogueLanguage}. Max ${budget} spoken words per scene in total (a ${dur}s clip cannot hold more). Short, natural lines. For narration use "who": "Narrator".

AI-VIDEO RULES (critical for consistency)
- Each scene = ONE continuous shot, no cuts inside, no montage, ONE main action that physically fits in ${dur} seconds.
- Refer to characters ONLY by name/tag. NEVER describe their face, hair, body or clothes in action/startState/endState — the app injects the locked identity automatically and any extra description causes drift.
- Use only these character tags: ${p.characters.map((c) => c.tag).join(', ') || '(none yet — add them to newCharacters)'} and location tags: ${p.locations.map((l) => l.tag).join(', ') || '(none yet — add them to newLocations)'}.
- startState = exact visible situation at the first frame (who is where, posture, props, light). endState = exact situation at the last frame. When transition is "continuous", scene N's startState must describe the SAME situation as scene N-1's endState. Use "cut" for a new angle within the same moment/place, "time-skip" for a jump in time or place.
- Props and injuries persist: if a cup breaks in scene 3, it stays broken later.
- camera: one shot size + one movement (e.g. "medium close-up, slow push-in"). Vary shot sizes across scenes for rhythm.
- sound: ambience + key SFX + music mood. Never ask for on-screen text, subtitles or logos.

JSON shape:
{"logline": "1 câu tiếng Việt", "theme": "", "outline": [{"part": "Hook|Setup|...", "scenes": "S01-S02", "summary": "tiếng Việt"}],
 "newCharacters": [], "newLocations": [],
 "scenes": [{"id": "S01", "title": "tiếng Việt ngắn", "beat": "Hook", "duration": ${dur}, "location": "#tag", "timeOfDay": "", "characters": ["@tag"],
   "startState": "", "action": "", "endState": "", "dialogue": [{"who": "@tag or Narrator", "line": "", "delivery": "whispering, angry..."}],
   "camera": "", "sound": "", "mood": "", "transition": "continuous|cut|time-skip"}]}
Write startState/action/endState/camera/sound/mood in English. newCharacters/newLocations use the same shapes as the bible (tag, name, role, identity, wardrobe, voice / tag, name, description) — leave empty if not needed.
${JSON_ONLY}`;
}

// ---------- 4. Kiểm tra nhất quán (sau khi app ghép prompt) ----------
function reviewPrompt(p) {
  const compiled = p.script.scenes.filter((s) => s.enabled).map((s) => {
    const i = p.script.scenes.indexOf(s);
    const c = compileScene(p, s, i);
    return { id: s.id, transition: s.transition, characters: s.characters, finalPrompt: c.prompt, chainFromPrevious: c.plan.chain };
  });
  return `${ROLE}

TASK: Act as a strict continuity supervisor. Review the script AND the final prompts that will be sent to the video model, then return concrete fixes.

PROJECT (bible + script):
${projectContext(p)}

FINAL PROMPTS (as the video model will receive them):
${JSON.stringify(compiled, null, 1).slice(0, 90000)}

Check for:
1. topic: scenes that drift from the topic/logline or add unexplained elements.
2. character: appearance written inside action text (causes drift), a character appearing without being listed, two characters easy to confuse, voice/personality inconsistencies.
3. continuity: startState not matching previous endState on "continuous" transitions, props/lighting/time of day/positions jumping, wardrobe changes without reason.
4. logic: actions impossible in the clip duration, more than one main action, cause→effect gaps, an ending that doesn't pay off the hook.
5. dialogue: too many words for the duration, unnatural lines, wrong language, speaker not present.
6. prompt: ambiguous wording, conflicting instructions, missing camera, requests for on-screen text.

Write "problem" and "fix" in Vietnamese. Patches must contain the FULL new value of the field (English for prompt fields).
Allowed patch fields: title, action, startState, endState, camera, sound, mood, dialogue (array of {who,line,delivery}), characters (array of tags), location, timeOfDay, transition, duration.
JSON shape:
{"score": 0-100, "summary": "tiếng Việt 2-3 câu", "issues": [{"scene": "S03 or null", "severity": "high|medium|low", "type": "topic|character|continuity|logic|dialogue|prompt", "problem": "", "fix": ""}],
 "patches": [{"scene": "S03", "field": "startState", "value": "..."}]}
${JSON_ONLY}`;
}

// ---------- 5. Viết lại một cảnh ----------
function rewriteScenePrompt(p, sceneId, instruction) {
  const i = p.script.scenes.findIndex((s) => s.id === sceneId);
  const prev = p.script.scenes[i - 1], next = p.script.scenes[i + 1];
  return `${ROLE}

TASK: Rewrite scene ${sceneId} following the user's instruction while staying consistent with the bible, the previous scene's endState and the next scene's startState.
USER INSTRUCTION (Vietnamese): ${instruction || 'Làm cảnh này hay hơn, rõ hành động hơn.'}

PROJECT:
${projectContext(p, { withScenes: false })}
PREVIOUS SCENE: ${prev ? JSON.stringify(prev) : '(none)'}
CURRENT SCENE: ${JSON.stringify(p.script.scenes[i])}
NEXT SCENE: ${next ? JSON.stringify(next) : '(none)'}

Same rules: one continuous shot, never describe character appearance, max ${dialogueBudget(p.script.scenes[i].duration)} spoken words, English for prompt fields.
Return the full scene object with the same id. ${JSON_ONLY}`;
}

// ---------- 6. Chuốt prompt ở chế độ Tạo nhanh ----------
function polishQuickPrompt(p, blocks, instruction) {
  return `${ROLE}

TASK: The user typed several quick video prompts (one per clip). Rewrite them into strong ${p ? videoModel(p.brief.model).label : 'Veo 3.1'} prompts that form ONE coherent sequence: same characters, same place logic, consistent light and time of day, each clip one continuous shot with subject, action, camera, sound. Keep every @tag exactly as written (the app replaces @tags with locked character descriptions, so do NOT describe their looks). Keep the user's language for spoken lines; write the rest in English.
${instruction ? 'User wish: ' + instruction : ''}
${p ? 'PROJECT BIBLE:\n' + projectContext(p, { withScenes: false }) : ''}

PROMPTS:
${blocks.map((b, i) => `[${i + 1}] ${b}`).join('\n\n')}

JSON shape: {"prompts": ["...", "..."]} — same count and order as the input. ${JSON_ONLY}`;
}

// ---------- Prompt ảnh tham chiếu (ghép bằng code để giữ nguyên văn khóa nhận dạng) ----------
function referencePrompts(p, item, kind) {
  const style = styleLock(p) || 'clean, consistent illustration style';
  if (kind === 'location') {
    return {
      plate: `Environment reference plate, ${p.brief.aspect === '9:16' ? 'vertical 9:16' : 'wide 16:9'}: ${item.name} — ${item.description} ${style}. Empty scene, no people, eye-level establishing view, even readable lighting, no text, no watermark.`
    };
  }
  const look = `${item.identity} Wearing ${item.wardrobe || 'their signature outfit'}.`;
  return {
    sheet: `Character turnaround reference sheet of ${item.name}. ${look} ${style}. Four full-body views side by side in one image: front, three-quarter, side profile, back. Same character, same proportions and outfit in every view, neutral standing pose, plain light grey background, flat even studio lighting, no text, no labels, no props.`,
    portrait: `Close-up head-and-shoulders portrait of ${item.name}, facing camera, neutral expression. ${look} ${style}. Plain light grey background, soft even lighting, sharp facial details, no text.`,
    expressions: `Expression sheet of ${item.name}: six head shots in a 3x2 grid showing neutral, happy, sad, angry, surprised, scared. ${look} ${style}. Identical face and hairstyle in every panel, plain background, no text, no labels.`
  };
}

module.exports = { competitorPrompt, biblePrompt, scriptPrompt, reviewPrompt, rewriteScenePrompt, polishQuickPrompt, referencePrompts, projectContext, ROLE };
