'use strict';
// Xử lý media bằng FFmpeg (đi kèm bộ cài) và yt-dlp (tự tải lần đầu khi phân tích đối thủ).
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ensureDir } = require('./util');

function ffmpegPath(custom) {
  if (custom && fs.existsSync(custom)) return custom;
  try {
    let p = require('ffmpeg-static');
    if (p) p = p.replace('app.asar', 'app.asar.unpacked');
    if (p && fs.existsSync(p)) return p;
  } catch { /* chưa cài */ }
  return 'ffmpeg'; // thử ffmpeg trong PATH
}

function run(bin, args, { timeoutMs = 10 * 60 * 1000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, cwd }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).toString().slice(-800)));
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

class Media {
  constructor(getSettings, toolsDir) {
    this.getSettings = getSettings;
    this.toolsDir = ensureDir(toolsDir);
  }

  ff() {
    return ffmpegPath(this.getSettings().ffmpegPath);
  }

  // Khung cuối của clip → ảnh PNG để làm khung đầu cảnh sau (giữ liền mạch).
  async lastFrame(video, outPng) {
    ensureDir(path.dirname(outPng));
    await run(this.ff(), ['-y', '-sseof', '-0.15', '-i', video, '-frames:v', '1', '-q:v', '2', '-update', '1', outPng]);
    if (!fs.existsSync(outPng)) {
      // một số file ngắn không seek được từ cuối: lấy khung cuối bằng bộ lọc
      await run(this.ff(), ['-y', '-i', video, '-vf', 'reverse,select=eq(n\\,0)', '-frames:v', '1', outPng]);
    }
    return outPng;
  }

  async thumbnail(video, outJpg) {
    ensureDir(path.dirname(outJpg));
    await run(this.ff(), ['-y', '-ss', '1', '-i', video, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', outJpg]);
    return outJpg;
  }

  // Ghép các clip theo thứ tự cảnh thành một phim (chuẩn hóa về cùng khung hình và fps).
  async concat(videos, out, { aspect = '16:9', crossfade = 0 } = {}) {
    if (!videos.length) throw new Error('Chưa có clip nào để ghép.');
    ensureDir(path.dirname(out));
    const [W, H] = aspect === '9:16' ? [1080, 1920] : [1920, 1080];
    const args = ['-y'];
    videos.forEach((v) => args.push('-i', v));
    const hasAudio = await Promise.all(videos.map((v) => this.hasAudio(v)));
    const durs = await Promise.all(videos.map((v) => this.duration(v)));
    const filters = [];
    videos.forEach((_, i) => {
      filters.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p[v${i}]`);
      // clip không có tiếng → chèn im lặng đúng độ dài để ghép không lệch tiếng
      if (hasAudio[i]) filters.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`);
      else filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${durs[i].toFixed(3)}[a${i}]`);
    });
    if (crossfade > 0 && videos.length > 1) {
      // nối có chuyển cảnh mờ dần
      let vPrev = 'v0', aPrev = 'a0', offset = 0;
      for (let i = 1; i < videos.length; i++) {
        offset += durs[i - 1] - crossfade;
        filters.push(`[${vPrev}][v${i}]xfade=transition=fade:duration=${crossfade}:offset=${offset.toFixed(3)}[vx${i}]`);
        filters.push(`[${aPrev}][a${i}]acrossfade=d=${crossfade}[ax${i}]`);
        vPrev = 'vx' + i; aPrev = 'ax' + i;
      }
      args.push('-filter_complex', filters.join(';'), '-map', `[${vPrev}]`, '-map', `[${aPrev}]`);
    } else {
      const inputs = videos.map((_, i) => `[v${i}][a${i}]`).join('');
      filters.push(`${inputs}concat=n=${videos.length}:v=1:a=1[v][a]`);
      args.push('-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]');
    }
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out);
    await run(this.ff(), args, { timeoutMs: 60 * 60 * 1000 });
    return out;
  }

  async probe(file) {
    try {
      const r = await run(this.ff(), ['-hide_banner', '-i', file], { timeoutMs: 30000 });
      return r.stderr;
    } catch (e) {
      return e.message; // ffmpeg -i không có output luôn báo lỗi, nhưng stderr vẫn chứa thông tin
    }
  }

  async hasAudio(file) {
    return /Stream #.*Audio/.test(await this.probe(file));
  }

  async duration(file) {
    const m = (await this.probe(file)).match(/Duration: (\d+):(\d+):([\d.]+)/);
    return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 8;
  }

  // ---------- yt-dlp cho phân tích đối thủ ----------
  ytdlpPath() {
    const name = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    return path.join(this.toolsDir, name);
  }

  async ensureYtdlp() {
    const p = this.ytdlpPath();
    if (fs.existsSync(p)) return p;
    const asset = process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp';
    const res = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/' + asset, { redirect: 'follow' });
    if (!res.ok) throw new Error('Không tải được yt-dlp (' + res.status + ')');
    fs.writeFileSync(p, Buffer.from(await res.arrayBuffer()));
    if (process.platform !== 'win32') fs.chmodSync(p, 0o755);
    return p;
  }

  // Lấy thông tin video + phụ đề (không tải video) để Claude phân tích.
  async fetchCompetitor(url, workDir) {
    const bin = await this.ensureYtdlp();
    const dir = ensureDir(workDir);
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
    const r = await run(bin, ['--skip-download', '--dump-single-json', '--no-warnings', '--no-playlist', url], { timeoutMs: 120000 });
    const info = JSON.parse(r.stdout);
    const meta = {
      title: info.title, channel: info.channel || info.uploader, views: info.view_count, likes: info.like_count,
      comments: info.comment_count, durationSec: info.duration, uploadDate: info.upload_date,
      description: (info.description || '').slice(0, 3000), tags: (info.tags || []).slice(0, 30),
      chapters: (info.chapters || []).map((c) => ({ t: Math.round(c.start_time), title: c.title }))
    };
    let transcript = '';
    try {
      await run(bin, ['--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', 'en.*,vi.*,en,vi', '--sub-format', 'vtt', '--no-playlist', '-o', path.join(dir, 'sub.%(ext)s'), url], { timeoutMs: 120000 });
      const vtt = fs.readdirSync(dir).find((f) => f.endsWith('.vtt'));
      if (vtt) transcript = vttToText(fs.readFileSync(path.join(dir, vtt), 'utf8'));
    } catch { /* video không có phụ đề */ }
    return { meta, transcript };
  }
}

// VTT → văn bản có mốc thời gian, bỏ dòng lặp của phụ đề tự động.
function vttToText(vtt) {
  const out = [];
  let last = '', stamp = '';
  for (const line of vtt.split(/\r?\n/)) {
    const t = line.match(/^(\d\d:)?(\d\d):(\d\d)\.\d+\s+-->/);
    if (t) { stamp = (t[1] && t[1] !== '00:' ? t[1] : '') + t[2] + ':' + t[3]; continue; }
    if (!line.trim() || /^WEBVTT|^Kind:|^Language:|^NOTE/.test(line)) continue;
    const clean = line.replace(/<[^>]+>/g, '').trim();
    if (clean && clean !== last) { out.push(`[${stamp}] ${clean}`); last = clean; }
  }
  return out.join('\n');
}

module.exports = { Media, vttToText, ffmpegPath };
