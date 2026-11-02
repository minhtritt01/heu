'use strict';
// Danh mục model video/ảnh. Một chỗ duy nhất để trình ghép prompt, hàng đợi, bảng giá và giao diện cùng dùng.
// Số credit Flow theo bảng credit chính thức của Google Flow (qua tài liệu useapi.net, 10/2026).

const VIDEO_MODELS = {
  'veo-3.1-fast': {
    label: 'Veo 3.1 Fast', provider: 'flow', apiModel: 'veo-3.1-fast',
    durations: [8, 6, 4], defaultDuration: 8, maxRefs: 3, refsNeed8s: true,
    supportsStartFrame: true, supportsRefsWithStartFrame: false,
    credits: { 4: 20, 6: 20, 8: 20 }, creditsUltra: { 4: 10, 6: 10, 8: 10 },
    note: 'Mặc định. Nhận tối đa 3 ảnh tham chiếu nhân vật (chỉ clip 8s).'
  },
  'veo-3.1-lite': {
    label: 'Veo 3.1 Lite', provider: 'flow', apiModel: 'veo-3.1-lite',
    durations: [8, 6, 4], defaultDuration: 8, maxRefs: 0,
    supportsStartFrame: true, supportsRefsWithStartFrame: false,
    credits: { 4: 10, 6: 10, 8: 10 }, creditsUltra: { 4: 5, 6: 5, 8: 5 },
    note: 'Rẻ nhất, không nhận ảnh tham chiếu — nên dùng chế độ nối khung hình.'
  },
  'veo-3.1-quality': {
    label: 'Veo 3.1 Quality', provider: 'flow', apiModel: 'veo-3.1-quality',
    durations: [8], defaultDuration: 8, maxRefs: 0,
    supportsStartFrame: true, supportsRefsWithStartFrame: false,
    credits: { 8: 100 }, creditsUltra: { 8: 100 },
    note: 'Đẹp nhất, đắt nhất, chỉ 8 giây, không nhận ảnh tham chiếu.'
  },
  'omni-flash': {
    label: 'Gemini Omni Flash', provider: 'flow', apiModel: 'omni-flash',
    durations: [10, 8, 6, 4], defaultDuration: 8, maxRefs: 7,
    supportsStartFrame: true, supportsRefsWithStartFrame: false,
    credits: { 4: 15, 6: 20, 8: 25, 10: 30 }, creditsUltra: { 4: 15, 6: 20, 8: 25, 10: 30 },
    note: 'Âm thanh gốc tốt, nhận tới 7 ảnh tham chiếu, có clip 10 giây.'
  },
  'meta-muse': {
    label: 'Meta Muse', provider: 'muse', apiModel: 'muse',
    durations: [10], defaultDuration: 10, maxRefs: 8,
    supportsStartFrame: true, supportsRefsWithStartFrame: true,
    musePercent: 3,
    note: 'Luôn ~10 giây có tiếng. Tỉ lệ khung ghi trong prompt. Nhận khung đầu + ảnh nhân vật cùng lúc.'
  }
};

const IMAGE_MODELS = {
  'nano-banana-pro': { label: 'Nano Banana Pro (Flow)', provider: 'flow', apiModel: 'nano-banana-pro', maxRefs: 10 },
  'nano-banana-2': { label: 'Nano Banana 2 (Flow)', provider: 'flow', apiModel: 'nano-banana-2', maxRefs: 3 },
  'imagen-4': { label: 'Imagen 4 (Flow)', provider: 'flow', apiModel: 'imagen-4', maxRefs: 0 },
  'muse-image': { label: 'Meta Muse Image', provider: 'muse', apiModel: 'muse', maxRefs: 9 }
};

function videoModel(id) {
  return VIDEO_MODELS[id] || VIDEO_MODELS['veo-3.1-fast'];
}

// Thời lượng hợp lệ gần nhất với mong muốn.
function fitDuration(modelId, wanted) {
  const m = videoModel(modelId);
  const w = Number(wanted) || m.defaultDuration;
  return m.durations.slice().sort((a, b) => Math.abs(a - w) - Math.abs(b - w))[0];
}

// Ngân sách lời thoại theo thời lượng (khoảng 2,5 từ/giây, chừa 1,5 giây đầu/cuối).
function dialogueBudget(seconds) {
  return Math.max(6, Math.floor((Number(seconds) - 1.5) * 2.5));
}

module.exports = { VIDEO_MODELS, IMAGE_MODELS, videoModel, fitDuration, dialogueBudget };
