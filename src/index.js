/**
 * Bandwidth Hero proxy —— Cloudflare Workers 版
 *
 * 原项目（Node + Express + sharp）无法在 Workers 上运行，这里用 WASM 编解码器
 * (@jsquash/*) 复刻同样的接口与行为：
 *
 *   GET /?url=<编码后的原图地址>&l=<质量 10-100>&bw=0|1&jpeg[=1]&format=webp|jpg
 *       &headers=<base64(JSON 附加请求头)>
 *
 * 输出同尺寸、默认 WebP 的低质量图，并返回 x-original-size / x-bytes-saved
 * 供 Bandwidth Hero 插件统计节省的流量。
 */

import { init as initWebpEncode, default as encodeWebp } from '@jsquash/webp/encode.js';
import { init as initWebpDecode, default as decodeWebp } from '@jsquash/webp/decode.js';
import { init as initJpegDecode, default as decodeJpeg } from '@jsquash/jpeg/decode.js';
import { init as initJpegEncode, default as encodeJpeg } from '@jsquash/jpeg/encode.js';
import { init as initPngDecode, default as decodePng } from '@jsquash/png/decode.js';
import { init as initAvifDecode, default as decodeAvif } from '@jsquash/avif/decode.js';

import webpEncSimd from '@jsquash/webp/codec/enc/webp_enc_simd.wasm';
import webpEncScalar from '@jsquash/webp/codec/enc/webp_enc.wasm';
import webpDecWasm from '@jsquash/webp/codec/dec/webp_dec.wasm';
import jpegDecWasm from '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm';
import jpegEncWasm from '@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm';
import pngDecWasm from '@jsquash/png/codec/pkg/squoosh_png_bg.wasm';
import avifDecWasm from '@jsquash/avif/codec/dec/avif_dec.wasm';

import {
  DEFAULT_MIN_COMPRESS_LENGTH,
  adjustQuality,
  grayscale,
  isAnimated,
  parseParams,
  shouldCompress,
  sniffFormat,
} from './lib.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; rv:121.0) Gecko/20100101 Firefox/121.0';
const ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
const CACHE_TTL = 86400;

/* ---------------------------------------------------------------- 编解码器 */

let codecReady;

function detectSimd() {
  return import('wasm-feature-detect')
    .then((m) => m.simd())
    .catch(() => false);
}

function initCodecs() {
  if (!codecReady) {
    codecReady = (async () => {
      const simd = await detectSimd();
      await Promise.all([
        initWebpEncode(simd ? webpEncSimd : webpEncScalar),
        initJpegEncode(jpegEncWasm),
        initWebpDecode(webpDecWasm),
        initJpegDecode(jpegDecWasm),
        initPngDecode(pngDecWasm),
        initAvifDecode(avifDecWasm),
      ]);
    })().catch((err) => {
      codecReady = undefined; // 下次请求重试
      throw err;
    });
  }
  return codecReady;
}

async function decodeImage(format, buffer) {
  switch (format) {
    case 'jpeg':
      return decodeJpeg(buffer);
    case 'png':
      return decodePng(buffer);
    case 'webp':
      return decodeWebp(buffer);
    case 'avif':
      return decodeAvif(buffer);
    default:
      return null;
  }
}

async function encodeImage(format, imageData, quality) {
  if (format === 'jpg' || format === 'jpeg') return encodeJpeg(imageData, { quality });
  return encodeWebp(imageData, { quality });
}

/* ---------------------------------------------------------------- 响应构造 */

function redirectTo(target, status = 302) {
  const html = `<html><head><meta http-equiv="refresh" content="0;url=${encodeURI(
    target,
  )}"></head><body></body></html>`;
  return new Response(html, {
    status,
    headers: { location: encodeURI(target), 'content-type': 'text/html; charset=utf-8' },
  });
}

function bypass(body, contentType) {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': contentType || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'x-proxy-bypass': '1',
      'cache-control': 'public, max-age=3600',
    },
  });
}

/* ------------------------------------------------------------------ 主流程 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    if (url.pathname !== '/') return new Response('Not Found', { status: 404 });

    const p = parseParams(request);
    if (!p) return new Response('bandwidth-hero-proxy', { status: 200 });
    if (p.error) return new Response(p.error, { status: 400 });
    if (p.format !== 'webp' && p.format !== 'jpg' && p.format !== 'jpeg') {
      return new Response('Unsupported format', { status: 400 });
    }

    // 边缘缓存命中
    const cached = await caches.default.match(request.url);
    if (cached) return cached;

    // 拉原图
    let origin;
    try {
      const headers = new Headers({
        'user-agent': UA,
        accept: ACCEPT,
        'accept-language': 'en-US,en;q=0.9',
        via: '2.0 bandwidth-hero',
      });
      for (const h of ['cookie', 'referer', 'dnt']) {
        const v = request.headers.get(h);
        if (v) headers.set(h, v);
      }
      for (const [k, v] of Object.entries(p.extraHeaders)) {
        if (typeof v === 'string') headers.set(String(k).toLowerCase(), v);
      }

      origin = await fetch(p.target, { headers, redirect: 'follow' });
    } catch {
      return redirectTo(p.target);
    }

    const originType = origin.headers.get('content-type') || '';
    const body = await origin.arrayBuffer();
    const bytes = new Uint8Array(body);
    const originSize = bytes.byteLength;
    const format = sniffFormat(originType, bytes);
    const minLen = parseInt(env.MIN_COMPRESS_LENGTH, 10) || DEFAULT_MIN_COMPRESS_LENGTH;

    if (
      !shouldCompress({
        originType,
        format,
        originSize,
        animated: isAnimated(bytes, format),
        webp: p.webp,
        minLen,
      })
    ) {
      const res = bypass(body, originType);
      ctx.waitUntil(caches.default.put(request.url, res.clone()));
      return res;
    }

    // 解码 → 灰度 → 重编码
    try {
      await initCodecs();
      const imageData = await decodeImage(format, body);
      if (!imageData) return redirectTo(p.target);

      const quality = adjustQuality(imageData.width * imageData.height, originSize, p.quality);
      if (p.grayscale) grayscale(imageData);

      const output = await encodeImage(p.format, imageData, quality);
      if (!output || output.byteLength === 0) return redirectTo(p.target);

      const outBytes = new Uint8Array(output);
      const outType = p.format === 'jpg' || p.format === 'jpeg' ? 'image/jpeg' : 'image/webp';

      let filename = 'image';
      try {
        filename = decodeURIComponent(new URL(p.target).pathname.split('/').pop() || 'image');
      } catch {}

      const res = new Response(outBytes, {
        status: 200,
        headers: {
          'content-type': outType,
          'content-disposition': `inline; filename="${encodeURIComponent(filename)}.${p.format}"`,
          'x-content-type-options': 'nosniff',
          'x-original-size': String(originSize),
          'x-bytes-saved': String(Math.max(originSize - outBytes.byteLength, 0)),
          'cache-control': `public, max-age=${CACHE_TTL}`,
        },
      });
      ctx.waitUntil(caches.default.put(request.url, res.clone()));
      return res;
    } catch (err) {
      console.error('compress failed:', err?.message || err);
      return redirectTo(p.target);
    }
  },
};
