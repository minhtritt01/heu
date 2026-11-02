'use strict';
// BẢNG GIÁ: (1) gói bán phần mềm do bạn tự đặt, (2) ước tính chi phí API cho một dự án.
const { VIDEO_MODELS, videoModel, fitDuration } = require('./models');

const DEFAULT_PLANS = [
  { id: 'free', name: 'Dùng thử', price: 0, period: '7 ngày', highlight: false,
    features: ['10 video/ngày', '1 dự án', 'Veo 3.1 Fast & Lite', 'Claude viết kịch bản'] },
  { id: 'pro', name: 'Pro', price: 299000, period: 'tháng', highlight: true,
    features: ['Không giới hạn video', 'Không giới hạn dự án', 'Mọi model: Veo 3.1, Omni Flash, Meta Muse', 'Khóa nhân vật + kiểm tra nhất quán', 'Phân tích video đối thủ', 'Chạy song song 4 luồng'] },
  { id: 'studio', name: 'Studio', price: 699000, period: 'tháng', highlight: false,
    features: ['Mọi thứ trong Pro', 'Nhiều tài khoản Flow/Muse', 'Chạy song song 10 luồng', 'Hỗ trợ 1-1 qua Zalo'] }
];

// Giá mặc định có thể sửa trong Cài đặt > Bảng giá.
const DEFAULT_RATES = {
  usdToVnd: 26000,
  useapiMonthlyUsd: 15,
  flowPlan: 'pro', // pro | ultra
  flowCreditUsdPro: 0.02, // ~Veo Fast 8s ≈ $0.40 trên gói Pro
  flowCreditUsdUltra: 0.01,
  musePerVideoUsd: 0, // gói Muse miễn phí: tốn hạn mức tuần, không tốn tiền
  officialGeminiPerSecondUsd: { 'veo-3.1-fast': 0.12, 'veo-3.1-lite': 0.05, 'veo-3.1-quality': 0.4, 'omni-flash': 0.1 },
  claudeNote: 'Claude chạy bằng gói Claude Pro/Max trên máy — không tính tiền theo lượt.'
};

function clipCost(modelId, seconds, rates = DEFAULT_RATES) {
  const m = videoModel(modelId);
  const d = fitDuration(modelId, seconds);
  if (m.provider === 'muse') {
    return { credits: 0, usd: rates.musePerVideoUsd || 0, quotaPercent: m.musePercent, seconds: d, officialUsd: null };
  }
  const table = rates.flowPlan === 'ultra' ? m.creditsUltra : m.credits;
  const credits = table[d] || table[8] || 20;
  const perCredit = rates.flowPlan === 'ultra' ? rates.flowCreditUsdUltra : rates.flowCreditUsdPro;
  const official = rates.officialGeminiPerSecondUsd[modelId];
  return { credits, usd: +(credits * perCredit).toFixed(3), seconds: d, officialUsd: official ? +(official * d).toFixed(2) : null };
}

function estimateProject(project, { takesPerScene = 1.3, rates = DEFAULT_RATES } = {}) {
  const scenes = project.script.scenes.filter((s) => s.enabled);
  const modelId = project.brief.model;
  let credits = 0, usd = 0, seconds = 0, quota = 0, official = 0;
  for (const s of scenes) {
    const c = clipCost(modelId, s.duration, rates);
    credits += c.credits * takesPerScene;
    usd += c.usd * takesPerScene;
    seconds += c.seconds;
    quota += (c.quotaPercent || 0) * takesPerScene;
    official += (c.officialUsd || 0) * takesPerScene;
  }
  return {
    scenes: scenes.length, seconds, model: videoModel(modelId).label, takesPerScene,
    credits: Math.round(credits), usd: +usd.toFixed(2), vnd: Math.round(usd * rates.usdToVnd / 1000) * 1000,
    museQuotaPercent: Math.round(quota), officialUsd: +official.toFixed(2)
  };
}

function modelTable(rates = DEFAULT_RATES) {
  return Object.entries(VIDEO_MODELS).map(([id, m]) => {
    const c = clipCost(id, m.defaultDuration, rates);
    return { id, label: m.label, provider: m.provider === 'muse' ? 'Meta Muse' : 'Google Flow', seconds: c.seconds, credits: c.credits, usd: c.usd, vnd: Math.round(c.usd * rates.usdToVnd / 100) * 100, officialUsd: c.officialUsd, quotaPercent: c.quotaPercent || null, note: m.note, maxRefs: m.maxRefs };
  });
}

module.exports = { DEFAULT_PLANS, DEFAULT_RATES, clipCost, estimateProject, modelTable };
