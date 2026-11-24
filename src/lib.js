/**
 * 纯函数工具集：参数解析、格式嗅探、动图判断、质量调整、灰度化。
 * 不依赖 WASM，方便单独测试（见 test/lib.test.mjs）。
 */

export const DEFAULT_QUALITY = 40;
export const MIN_QUALITY = 10;
export const MAX_QUALITY = 100;
export const DEFAULT_MIN_COMPRESS_LENGTH = 2048;

/** 依据 content-type + 文件头判断真实格式 */
export function sniffFormat(contentType = '', bytes) {
  const ct = contentType.toLowerCase();
  if (ct.includes('image/jpeg') || ct.includes('image/jpg')) return 'jpeg';
  if (ct.includes('image/png')) return 'png';
  if (ct.includes('image/webp')) return 'webp';
  if (ct.includes('image/avif')) return 'avif';
  if (ct.includes('image/gif')) return 'gif';
  // content-type 不可靠时看 magic bytes
  if (bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return 'webp';
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'gif';
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'avif';
  }
  return 'unknown';
}

function hasAscii(bytes, str) {
  const pat = [...str].map((c) => c.charCodeAt(0));
  outer: for (let i = 0; i <= bytes.length - pat.length; i++) {
    for (let j = 0; j < pat.length; j++) if (bytes[i + j] !== pat[j]) continue outer;
    return true;
  }
  return false;
}

/** 动图（GIF / APNG / 动图 WebP）不压缩，避免把动画压成静帧 */
export function isAnimated(bytes, format) {
  if (format === 'png') return hasAscii(bytes, 'acTL');
  if (format === 'webp') return hasAscii(bytes, 'ANIM');
  if (format === 'gif') {
    // 数一下 graphic control extension（0x21 0xF9）的数量
    let gce = 0;
    for (let i = 0; i < bytes.length - 1; i++) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9) gce++;
    }
    return gce > 1;
  }
  return false;
}

/** 大图/大文件按比例降质量，复刻原项目 compress.js 的策略 */
export function adjustQuality(pixelCount, originSize, quality) {
  const thresholds = [
    { pixels: 3000000, size: 1536000, factor: 0.1 },
    { pixels: 2000000, size: 1024000, factor: 0.25 },
    { pixels: 1000000, size: 512000, factor: 0.5 },
    { pixels: 500000, size: 256000, factor: 0.75 },
  ];
  for (const t of thresholds) {
    if (pixelCount > t.pixels && originSize > t.size) return Math.ceil(quality * t.factor);
  }
  return quality;
}

/** 原地灰度化（BT.709 亮度） */
export function grayscale(imageData) {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const luma = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = luma;
  }
  return imageData;
}

/** 是否应当跳过压缩、直接回源 */
export function shouldCompress({ originType, format, originSize, animated, webp, minLen }) {
  if (!originType.startsWith('image')) return false;
  if (originSize === 0) return false;
  if (format === 'unknown') return false;
  if (format === 'gif') return false; // 不支持动图/调色板重新编码，直接回源
  if (animated) return false;
  if (webp && originSize < minLen) return false;
  if (!webp && format === 'png' && originSize < minLen * 50) return false;
  return true;
}

/** 解析请求参数 */
export function parseParams(request) {
  const sp = new URL(request.url).searchParams;
  let urls = sp.getAll('url');
  if (urls.length > 1) urls = urls.join('&url=');
  let url = urls[0];
  if (!url) return null;

  url = url.replace(/^http:\/\/1\.1\.\d\.\d\/bmi\/(https?:\/\/)?/i, 'http://');

  let target;
  try {
    target = new URL(url);
  } catch {
    return { error: 'Invalid URL' };
  }
  if (!/^https?:$/.test(target.protocol)) return { error: 'Invalid URL' };
  // 简单 SSRF 防护：拒绝内网 / 本机 / 云元数据地址
  if (
    /^(localhost|127\.|0\.0\.0\.0|169\.254\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(
      target.hostname,
    )
  ) {
    return { error: 'URL not allowed' };
  }

  const formatParam = sp.get('format');
  const webp = !sp.has('jpeg') || sp.get('jpeg') === '0';
  const format = formatParam || (webp ? 'webp' : 'jpg');
  const q = parseInt(sp.get('l'), 10);

  let extraHeaders = {};
  const rawHeaders = sp.get('headers');
  if (rawHeaders) {
    try {
      extraHeaders = JSON.parse(atob(rawHeaders));
    } catch {
      extraHeaders = {};
    }
  }

  return {
    target: target.href,
    webp,
    format,
    quality: Math.min(Math.max(q || DEFAULT_QUALITY, MIN_QUALITY), MAX_QUALITY),
    grayscale: sp.get('bw') !== '0',
    extraHeaders,
  };
}
