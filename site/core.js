import * as gifenc from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifenc.GIFEncoder ? gifenc : gifenc.default;

export function bounded(value, fallback, min, max) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error('处理参数超出允许范围。');
  return number;
}

export function fitBox(width, height, edge, pixels = Infinity) {
  const scale = Math.min(1, edge / Math.max(width, height), Math.sqrt(pixels / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

export function removeWhiteRGBA(input, width, height, options = {}, progress = () => {}) {
  if (input.length !== width * height * 4) throw new Error('图片像素数据不完整。');
  const threshold = bounded(options.threshold, 245, 200, 255);
  const softness = bounded(options.softness, 20, 0, 60);
  const scope = options.scope || 'edges';
  if (!['edges', 'all'].includes(scope)) throw new Error('未知去白范围。');
  const data = new Uint8ClampedArray(input);
  const count = width * height;
  const mask = new Uint8Array(count);
  const low = threshold - softness;
  for (let index = 0; index < count; index++) {
    const pixel = index * 4;
    if (data[pixel + 3] === 0 || Math.min(data[pixel], data[pixel + 1], data[pixel + 2]) >= low) mask[index] = 1;
  }
  progress(25, '识别边缘白色背景');
  if (scope === 'edges') {
    const queue = new Int32Array(count);
    let head = 0, tail = 0;
    const add = index => { if (mask[index] === 1) { mask[index] = 2; queue[tail++] = index; } };
    for (let x = 0; x < width; x++) { add(x); add((height - 1) * width + x); }
    for (let y = 0; y < height; y++) { add(y * width); add(y * width + width - 1); }
    while (head < tail) {
      const index = queue[head++], x = index % width;
      if (x > 0) add(index - 1);
      if (x < width - 1) add(index + 1);
      if (index >= width) add(index - width);
      if (index < count - width) add(index + width);
    }
  }
  progress(65, '柔化边缘并减少白边');
  let changed = 0;
  for (let index = 0; index < count; index++) {
    if (!mask[index] || (scope === 'edges' && mask[index] !== 2)) continue;
    const pixel = index * 4;
    const whiteness = Math.min(data[pixel], data[pixel + 1], data[pixel + 2]);
    const matte = softness ? Math.round(255 * Math.min(1, Math.max(0, (threshold - whiteness) / softness))) : (whiteness >= threshold ? 0 : 255);
    if (matte === 255 || data[pixel + 3] === 0) continue;
    changed++;
    if (matte === 0) data.fill(0, pixel, pixel + 4);
    else {
      for (let channel = 0; channel < 3; channel++) data[pixel + channel] = Math.max(0, Math.min(255, Math.round((data[pixel + channel] * 255 - 255 * (255 - matte)) / matte)));
      data[pixel + 3] = Math.round(data[pixel + 3] * matte / 255);
    }
  }
  return { data, changed };
}

export function resizeRGBA(input, width, height, targetWidth, targetHeight) {
  if (width === targetWidth && height === targetHeight) return input;
  const output = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y++) {
    const sy = Math.max(0, (y + 0.5) * height / targetHeight - 0.5);
    const y0 = Math.floor(sy), y1 = Math.min(height - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < targetWidth; x++) {
      const sx = Math.max(0, (x + 0.5) * width / targetWidth - 0.5);
      const x0 = Math.floor(sx), x1 = Math.min(width - 1, x0 + 1), fx = sx - x0;
      const destination = (y * targetWidth + x) * 4;
      for (let c = 0; c < 4; c++) output[destination + c] =
        input[(y0 * width + x0) * 4 + c] * (1 - fx) * (1 - fy) +
        input[(y0 * width + x1) * 4 + c] * fx * (1 - fy) +
        input[(y1 * width + x0) * 4 + c] * (1 - fx) * fy +
        input[(y1 * width + x1) * 4 + c] * fx * fy;
    }
  }
  return output;
}

export function frameDelays(durationMs, count) {
  const ticks = Math.max(count, Math.round(durationMs / 10));
  return Array.from({ length: count }, (_, i) => (Math.round((i + 1) * ticks / count) - Math.round(i * ticks / count)) * 10);
}

export function encodeAdaptiveGIF(frames, width, height, durationMs, options = {}, progress = () => {}) {
  if (!frames.length || durationMs < 100) throw new Error('片段过短，无法生成 GIF。');
  const budget = bounded(options.max_kb, 500, 50, 500) * 1000;
  const requestedFPS = bounded(options.fps, 12, 4, 24);
  const profiles = [[1, 1, 256], [1, 1, 128], [.85, 1, 96], [.75, .85, 80], [.65, .75, 64], [.55, .65, 48], [.45, .5, 32], [.35, .4, 24], [.25, .3, 16], [0, 0, 16]];
  for (let attempt = 0; attempt < profiles.length; attempt++) {
    const [scale, speed, colors] = profiles[attempt];
    const { width: w, height: h } = fitBox(width, height, Math.max(32, Math.round(Math.max(width, height) * scale)));
    const count = Math.min(frames.length, Math.max(1, Math.ceil(durationMs * Math.max(2, requestedFPS * speed) / 1000)));
    const delays = frameDelays(durationMs, count);
    const encoder = GIFEncoder();
    for (let index = 0; index < count; index++) {
      const source = frames[Math.min(frames.length - 1, Math.floor(index * frames.length / count))];
      const rgba = resizeRGBA(source, width, height, w, h);
      const palette = quantize(rgba, colors, { format: 'rgba4444', oneBitAlpha: true });
      const transparentIndex = palette.findIndex(color => color[3] === 0);
      if (transparentIndex > 0) [palette[0], palette[transparentIndex]] = [palette[transparentIndex], palette[0]];
      const pixels = applyPalette(rgba, palette, 'rgba4444');
      encoder.writeFrame(pixels, w, h, { palette, delay: delays[index], repeat: 0, transparent: transparentIndex >= 0, transparentIndex: 0, dispose: 2 });
      if (index % 8 === 0 || index === count - 1) progress(50 + Math.round((attempt + (index + 1) / count) * 4.7), `第 ${attempt + 1} 次编码 · ${w}×${h} · ${(count * 1000 / durationMs).toFixed(1)}fps · ${colors} 色`);
    }
    encoder.finish();
    const bytes = encoder.bytes();
    if (bytes.length < budget) return { bytes, width: w, height: h, fps: Math.round(count * 10000 / durationMs) / 10, colors, frames: count, duration: delays.reduce((sum, delay) => sum + delay, 0) / 1000, attempts: attempt + 1 };
  }
  throw new Error('压缩后仍超出目标。请缩短片段或提高体积上限；不会导出超标结果。');
}
