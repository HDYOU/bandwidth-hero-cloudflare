import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adjustQuality,
  grayscale,
  isAnimated,
  parseParams,
  shouldCompress,
  sniffFormat,
} from '../src/lib.js';

const req = (qs) => new Request(`https://proxy.example.com/?${qs}`);

test('sniffFormat 优先 content-type，其次文件头', () => {
  assert.equal(sniffFormat('image/jpeg'), 'jpeg');
  assert.equal(sniffFormat('image/png; charset=x'), 'png');
  assert.equal(sniffFormat('', Uint8Array.from([0xff, 0xd8, 0xff])), 'jpeg');
  assert.equal(sniffFormat('', Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), 'png');
  assert.equal(sniffFormat('', Uint8Array.from([0x47, 0x49, 0x46, 0x38])), 'gif');
  assert.equal(sniffFormat('application/octet-stream'), 'unknown');
});

test('isAnimated 识别 APNG / 动图 WebP / 多帧 GIF', () => {
  const acTL = new TextEncoder().encode('xxxxacTLxxxx');
  assert.equal(isAnimated(acTL, 'png'), true);
  assert.equal(isAnimated(new TextEncoder().encode('plain png data'), 'png'), false);

  const anim = new TextEncoder().encode('RIFFxxxxWEBPVP8XxxxxANIM');
  assert.equal(isAnimated(anim, 'webp'), true);

  // 两帧的 GIF（两个 GCE 块）
  const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x21, 0xf9, 0x00, 0x21, 0xf9, 0x00]);
  assert.equal(isAnimated(gif, 'gif'), true);

  const single = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x21, 0xf9, 0x00, 0x2c]);
  assert.equal(isAnimated(single, 'gif'), false);
});

test('adjustQuality 对大图降质量', () => {
  assert.equal(adjustQuality(100 * 100, 5000, 40), 40);
  assert.equal(adjustQuality(4_000_000, 2_000_000, 40), 4); // factor 0.1
  assert.equal(adjustQuality(1_200_000, 600_000, 40), 20); // factor 0.5
});

test('grayscale 只改 RGB，不动 alpha', () => {
  const imageData = { data: Uint8ClampedArray.from([255, 0, 0, 128]) };
  grayscale(imageData);
  const [r, g, b, a] = imageData.data;
  assert.ok(r === g && g === b);
  assert.equal(a, 128);
});

test('shouldCompress 的边界', () => {
  const base = { originType: 'image/jpeg', format: 'jpeg', originSize: 50_000, animated: false, webp: true, minLen: 2048 };
  assert.equal(shouldCompress(base), true);
  assert.equal(shouldCompress({ ...base, originType: 'text/html' }), false);
  assert.equal(shouldCompress({ ...base, originSize: 0 }), false);
  assert.equal(shouldCompress({ ...base, format: 'gif' }), false);
  assert.equal(shouldCompress({ ...base, animated: true }), false);
  assert.equal(shouldCompress({ ...base, originSize: 1000 }), false);
});

test('parseParams 解析并夹紧质量值', () => {
  const u = encodeURIComponent('https://example.com/a.jpg');
  const p = parseParams(req(`url=${u}&l=80`));
  assert.equal(p.target, 'https://example.com/a.jpg');
  assert.equal(p.quality, 80);
  assert.equal(p.format, 'webp');
  assert.equal(p.grayscale, true);

  assert.equal(parseParams(req(`url=${u}&l=999`)).quality, 100);
  assert.equal(parseParams(req(`url=${u}&l=1`)).quality, 10);
  assert.equal(parseParams(req(`url=${u}&bw=0&jpeg=1`)).format, 'jpg');
  assert.equal(parseParams(req(`url=${u}&bw=0`)).grayscale, false);

  assert.equal(parseParams(req('')), null);
  assert.equal(parseParams(req('url=not-a-url')).error, 'Invalid URL');
  assert.equal(parseParams(req(`url=${encodeURIComponent('http://127.0.0.1/x.jpg')}`)).error, 'URL not allowed');
});

test('parseParams 支持 base64 附加请求头', () => {
  const u = encodeURIComponent('https://example.com/a.jpg');
  const headers = Buffer.from(JSON.stringify({ Referer: 'https://example.com/' })).toString('base64');
  const p = parseParams(req(`url=${u}&headers=${encodeURIComponent(headers)}`));
  assert.equal(p.extraHeaders.Referer, 'https://example.com/');
});
