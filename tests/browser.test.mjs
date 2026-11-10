import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseGIF, decompressFrames } from 'gifuct-js';
import { bounded, encodeAdaptiveGIF, fitBox, frameDelays, removeWhiteRGBA, resizeRGBA } from '../site/core.js';

function pixel(data, width, x, y) { return Array.from(data.slice((y * width + x) * 4, (y * width + x + 1) * 4)); }
function fixture() {
  const width = 12, height = 10, data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 2; y <= 7; y++) for (let x = 2; x <= 9; x++) data.set([220, 90, 40, 255], (y * width + x) * 4);
  data.set([255, 255, 255, 255], (4 * width + 5) * 4);
  data.set([20, 30, 40, 128], (3 * width + 3) * 4);
  return { width, height, data };
}

test('edge removal preserves enclosed white, existing alpha and input bytes', () => {
  const { width, height, data } = fixture();
  const original = data.slice();
  const output = removeWhiteRGBA(data, width, height);
  assert.deepEqual(pixel(output.data, width, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixel(output.data, width, 5, 4), [255, 255, 255, 255]);
  assert.deepEqual(pixel(output.data, width, 3, 3), [20, 30, 40, 128]);
  assert.deepEqual(data, original);
});

test('global white removal and soft alpha follow the selected thresholds', () => {
  const { width, height, data } = fixture();
  assert.equal(pixel(removeWhiteRGBA(data, width, height, { scope: 'all' }).data, width, 5, 4)[3], 0);
  const soft = removeWhiteRGBA(new Uint8ClampedArray([235, 235, 235, 255]), 1, 1);
  assert.equal(soft.data[3], 128);
});

test('all four edges participate; separate white pockets stay inside the subject', () => {
  const data = new Uint8ClampedArray(3 * 3 * 4).fill(255);
  for (const [x, y] of [[1, 0], [0, 1], [2, 1], [1, 2]]) data.set([0, 0, 0, 255], (y * 3 + x) * 4);
  const result = removeWhiteRGBA(data, 3, 3).data;
  assert.equal(pixel(result, 3, 1, 1)[3], 255);
  assert.equal(pixel(result, 3, 2, 2)[3], 0);
});

test('invalid settings and incomplete pixel arrays are rejected', () => {
  for (const value of [NaN, Infinity, -1, 900]) assert.throws(() => bounded(value, 10, 0, 100));
  assert.throws(() => removeWhiteRGBA(new Uint8ClampedArray(3), 1, 1));
  assert.throws(() => removeWhiteRGBA(new Uint8ClampedArray(4), 1, 1, { scope: 'bad' }));
});

test('fitBox preserves portrait/landscape proportions and does not upscale', () => {
  assert.deepEqual(fitBox(720, 360, 240), { width: 240, height: 120 });
  assert.deepEqual(fitBox(180, 320, 240), { width: 135, height: 240 });
  assert.deepEqual(fitBox(20, 10, 240), { width: 20, height: 10 });
  const fit = fitBox(640, 360, 640, 5000);
  assert.ok(fit.width * fit.height <= 5000);
});

test('RGBA downsampling retains solid colors and alpha', () => {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < 16; i++) data.set([40, 70, 100, 128], i * 4);
  assert.deepEqual(Array.from(resizeRGBA(data, 4, 4, 1, 1)), [40, 70, 100, 128]);
});

test('GIF delays preserve the whole clip using centisecond precision', () => {
  const delays = frameDelays(3000, 36);
  assert.equal(delays.reduce((a, b) => a + b), 3000);
  assert.ok(delays.every(delay => delay >= 10 && delay % 10 === 0));
});

test('adaptive encoding produces real animated GIF bytes under budget without shortening', () => {
  let seed = 12345;
  const frames = Array.from({ length: 18 }, () => {
    const data = new Uint8ClampedArray(128 * 72 * 4);
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; data[i + c] = seed >>> 24; }
      data[i + 3] = 255;
    }
    return data;
  });
  const result = encodeAdaptiveGIF(frames, 128, 72, 1500, { max_kb: 50, fps: 12 });
  assert.ok(result.bytes.length < 50000);
  assert.ok(result.attempts > 1);
  assert.equal(new TextDecoder().decode(result.bytes.slice(0, 6)), 'GIF89a');
  const parsed = parseGIF(result.bytes.buffer);
  const decoded = decompressFrames(parsed, true);
  assert.ok(decoded.length > 1);
  assert.equal(decoded.reduce((sum, frame) => sum + frame.delay, 0), 1500);
  assert.ok(new TextDecoder().decode(result.bytes).includes('NETSCAPE2.0'));
});

test('GIF transparency survives encode/decode', () => {
  const frame = new Uint8ClampedArray([0, 0, 0, 0, 240, 80, 40, 255]);
  const result = encodeAdaptiveGIF([frame, frame], 2, 1, 1000, { max_kb: 100, fps: 4 });
  const decoded = decompressFrames(parseGIF(result.bytes.buffer), true);
  assert.equal(decoded[0].patch[3], 0);
  assert.equal(decoded[0].patch[7], 255);
});

test('Pages entry uses relative assets, a worker and no remote processing endpoint', async () => {
  const html = await readFile(new URL('../docs/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../docs/app.js', import.meta.url), 'utf8');
  assert.ok(html.includes('src="./app.js"'));
  assert.ok(html.includes("connect-src 'none'"));
  assert.ok(!html.match(/(?:src|href)="\//));
  assert.ok(!app.includes('fetch('));
  assert.ok(app.includes('Worker('));
});
