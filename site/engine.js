import { parseGIF, decompressFrame } from 'gifuct-js';
import { bounded, fitBox } from './core.js';

const MAX_UPLOAD = 150 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 25_000_000;
const MAX_FRAME_PIXELS = 12_000_000;
const MAX_FRAMES = 120;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function canvas(width, height) {
  const element = document.createElement('canvas');
  element.width = width; element.height = height;
  return element;
}

function waitEvent(element, success, fail = 'error', action = () => {}, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); element.removeEventListener(success, done); element.removeEventListener(fail, error); };
    const done = () => { clean(); resolve(); };
    const error = () => { clean(); reject(new Error('浏览器无法解码这份素材。请尝试 JPG／PNG 图片或 H.264 编码的 MP4 视频。')); };
    const timer = setTimeout(() => { clean(); reject(new Error('读取素材超时，请换用更短的视频或更小的图片。')); }, timeout);
    element.addEventListener(success, done, { once: true });
    element.addEventListener(fail, error, { once: true });
    try { action(); } catch (reason) { clean(); reject(reason); }
  });
}

async function imageElement(url) {
  const image = new Image();
  await waitEvent(image, 'load', 'error', () => { image.src = url; });
  if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > MAX_IMAGE_PIXELS) throw new Error('图片超过 2500 万像素，请先缩小后重试。');
  return image;
}

async function videoElement(url) {
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto';
  await waitEvent(video, 'loadeddata', 'error', () => { video.src = url; video.load(); });
  if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth) throw new Error('无法读取视频时长或画面。请尝试 H.264 编码的 MP4。');
  return video;
}

function releaseVideo(video) { video.pause(); video.removeAttribute('src'); video.load(); }

function toBlob(element, type, quality) {
  return new Promise((resolve, reject) => element.toBlob(blob => {
    if (!blob) return reject(new Error('浏览器无法导出这个格式，请改选 PNG 或 JPG。'));
    if (blob.type !== type) return reject(new Error('当前浏览器不支持此输出格式，请改选 PNG 或 JPG。'));
    resolve(blob);
  }, type, quality));
}

async function runWorker(payload, progress, signal) {
  if (signal.aborted) throw new Error('处理已取消。');
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const transfers = payload.buffer ? [payload.buffer] : payload.frames;
  return new Promise((resolve, reject) => {
    const abort = () => finish(new Error('处理已取消。'));
    const timer = setTimeout(() => finish(new Error('处理耗时过长，请缩短片段后重试。')), 180000);
    const finish = (error, result) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') progress(data.value, data.message);
      else if (data.type === 'error') finish(new Error(data.message));
      else if (data.type === 'done') finish(null, data);
    };
    worker.onerror = () => finish(new Error('处理进程无法启动。请使用 Safari／Chrome 打开页面，并重新尝试。'));
    worker.postMessage(payload, transfers);
  });
}

async function white(media, options, progress, signal) {
  const image = await imageElement(media.url);
  const { width, height } = fitBox(image.naturalWidth, image.naturalHeight, Math.max(image.naturalWidth, image.naturalHeight), 12_000_000);
  const target = canvas(width, height), context = target.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height);
  const result = await runWorker({ operation: 'white', width, height, buffer: pixels.data.buffer, options }, progress, signal);
  context.putImageData(new ImageData(new Uint8ClampedArray(result.buffer), width, height), 0, 0);
  progress(95, '导出透明 PNG');
  const blob = await toBlob(target, 'image/png');
  target.width = target.height = 1;
  return { blob, width, height, format: 'PNG', note: (result.changed ? '已导出透明 PNG。' : '未找到符合阈值的白色背景，请调整参数。') + (width !== media.width ? '超大图已按手机内存限制等比缩小。' : '') };
}

async function resize(media, options, progress, signal) {
  const edge = bounded(options.max_edge, 512, 32, 4096);
  const budget = bounded(options.max_kb, 500, 10, 5000) * 1000;
  const format = options.format || 'webp';
  if (!['webp', 'png', 'jpeg'].includes(format)) throw new Error('不支持的导出格式。');
  const image = await imageElement(media.url);
  let { width, height } = fitBox(image.naturalWidth, image.naturalHeight, edge);
  let quality = .92;
  const target = canvas(width, height), context = target.getContext('2d');
  for (let attempt = 0; attempt < 30; attempt++) {
    if (signal.aborted) throw new Error('处理已取消。');
    target.width = width; target.height = height;
    if (format === 'jpeg') { context.fillStyle = '#fff'; context.fillRect(0, 0, width, height); }
    context.imageSmoothingQuality = 'high'; context.drawImage(image, 0, 0, width, height);
    progress(10 + attempt * 2.8, '等比缩小并寻找合适的导出质量');
    const blob = await toBlob(target, `image/${format}`, quality);
    if (blob.size < budget) {
      target.width = target.height = 1;
      return { blob, width, height, format: format.toUpperCase(), note: '已达到体积目标。' + (format === 'jpeg' ? 'JPG 的透明区域已填充为白色。' : '') };
    }
    if (format !== 'png' && quality > .44) quality -= .12;
    else { width = Math.max(1, Math.floor(width * .78)); height = Math.max(1, Math.floor(height * .78)); quality = .8; }
    await tick();
  }
  throw new Error('当前体积目标无法达到，请提高上限。');
}

function capturePlan(media, options) {
  const start = bounded(options.start, 0, 0, Math.max(0, media.duration - .04));
  const duration = Math.min(bounded(options.duration, 3, .1, 15), media.duration - start);
  const requestedFPS = bounded(options.fps, 12, 4, 24);
  const count = Math.min(MAX_FRAMES, Math.max(1, Math.ceil(duration * requestedFPS)));
  const { width, height } = fitBox(media.width, media.height, bounded(options.width, 320, 64, 720), MAX_FRAME_PIXELS / count);
  return { start, duration, count, width, height };
}

async function captureVideo(media, plan, progress, signal) {
  const video = await videoElement(media.url);
  const target = canvas(plan.width, plan.height), context = target.getContext('2d', { willReadFrequently: true });
  const frames = [];
  try {
    for (let index = 0; index < plan.count; index++) {
      if (signal.aborted) throw new Error('处理已取消。');
      const time = Math.min(video.duration - .015, plan.start + index * plan.duration / plan.count);
      if (Math.abs(video.currentTime - time) > .0001) await waitEvent(video, 'seeked', 'error', () => { video.currentTime = time; });
      context.drawImage(video, 0, 0, plan.width, plan.height);
      frames.push(context.getImageData(0, 0, plan.width, plan.height).data.buffer);
      progress(Math.round(5 + (index + 1) / plan.count * 43), `读取片段 · ${index + 1} / ${plan.count} 帧`);
      await tick();
    }
    return frames;
  } finally { releaseVideo(video); target.width = target.height = 1; }
}

async function captureGIF(media, plan, progress, signal) {
  const parsed = media.parsed;
  const full = canvas(media.width, media.height), context = full.getContext('2d', { willReadFrequently: true });
  const patch = canvas(1, 1), patchContext = patch.getContext('2d');
  const scaled = canvas(plan.width, plan.height), scaledContext = scaled.getContext('2d', { willReadFrequently: true });
  const frames = [];
  let time = 0, previous = null, restore = null;
  for (const raw of parsed.frames) {
    if (!raw.image) continue;
    if (signal.aborted) throw new Error('处理已取消。');
    if (previous?.disposalType === 2) context.clearRect(previous.dims.left, previous.dims.top, previous.dims.width, previous.dims.height);
    if (previous?.disposalType === 3 && restore) context.putImageData(restore, 0, 0);
    const decoded = decompressFrame(raw, parsed.gct, true);
    if (decoded.disposalType === 3) restore = context.getImageData(0, 0, full.width, full.height);
    patch.width = decoded.dims.width; patch.height = decoded.dims.height;
    patchContext.putImageData(new ImageData(decoded.patch, patch.width, patch.height), 0, 0);
    context.drawImage(patch, decoded.dims.left, decoded.dims.top);
    const next = time + (decoded.delay || 100) / 1000;
    while (frames.length < plan.count && plan.start + frames.length * plan.duration / plan.count < next - 1e-8) {
      scaledContext.clearRect(0, 0, plan.width, plan.height);
      scaledContext.drawImage(full, 0, 0, plan.width, plan.height);
      frames.push(scaledContext.getImageData(0, 0, plan.width, plan.height).data.buffer);
      progress(Math.round(5 + frames.length / plan.count * 43), `读取 GIF · ${frames.length} / ${plan.count} 帧`);
    }
    time = next; previous = decoded;
    if (frames.length >= plan.count) break;
    await tick();
  }
  full.width = full.height = patch.width = patch.height = scaled.width = scaled.height = 1;
  if (frames.length !== plan.count) throw new Error('GIF 帧数据不完整，请换一份素材。');
  return frames;
}

async function gif(media, options, progress, signal) {
  const plan = capturePlan(media, options);
  const frames = media.parsed ? await captureGIF(media, plan, progress, signal) : await captureVideo(media, plan, progress, signal);
  const result = await runWorker({ operation: 'gif', frames, width: plan.width, height: plan.height, durationMs: plan.duration * 1000, options }, progress, signal);
  return { ...result, blob: new Blob([result.bytes], { type: 'image/gif' }), format: 'GIF', note: `已低于 ${Number(options.max_kb || 500)} KB · ${result.duration} 秒 · ${result.frames} 帧 · 自动循环播放。` };
}

export function createBrowserEngine() {
  const sources = new Map(), jobs = new Map();
  const urls = new Set();
  let controller = null;
  const objectURL = blob => { const url = URL.createObjectURL(blob); urls.add(url); return url; };
  const revoke = url => { URL.revokeObjectURL(url); urls.delete(url); };
  return {
    cancel() { controller?.abort(); },
    async request(path, request = {}) {
      if (path === '/api/status') return { token: 'browser', ffmpeg: true, version: '0.2.0', max_upload: MAX_UPLOAD };
      if (path.startsWith('/api/upload?')) {
        const file = request.body;
        if (!file?.size || file.size > MAX_UPLOAD) throw new Error('请选择 150 MB 以内的素材。');
        const url = objectURL(file);
        try {
          let metadata;
          if (file.name.toLowerCase().endsWith('.gif')) {
            if (file.size > 20 * 1024 * 1024) throw new Error('手机浏览器版暂支持 20 MB 以内的 GIF。');
            const parsed = parseGIF(await file.arrayBuffer());
            const images = parsed.frames.filter(frame => frame.image);
            if (!images.length || !parsed.lsd.width || !parsed.lsd.height || parsed.lsd.width * parsed.lsd.height > 12_000_000 || images.length > 3000) throw new Error('GIF 尺寸或帧数过大，请先使用本机版压缩。');
            const duration = images.reduce((sum, frame) => sum + (frame.gce?.delay || 10) / 100, 0);
            metadata = { kind: images.length > 1 ? 'video' : 'image', width: parsed.lsd.width, height: parsed.lsd.height, duration, parsed };
          } else if (file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(file.name)) {
            const video = await videoElement(url);
            metadata = { kind: 'video', width: video.videoWidth, height: video.videoHeight, duration: video.duration };
            releaseVideo(video);
          } else {
            const image = await imageElement(url);
            metadata = { kind: 'image', width: image.naturalWidth, height: image.naturalHeight };
          }
          const kind = new URL(path, location.href).searchParams.get('kind');
          if (kind && metadata.kind !== kind) throw new Error(kind === 'video' ? '请选择视频或动态 GIF。' : '请选择静态图片；动态图可以使用「视频转 GIF」。');
          // Keep just one source in memory. Previous downloads are retained until the next result.
          for (const media of sources.values()) revoke(media.url);
          sources.clear();
          const media = { ...metadata, id: crypto.randomUUID(), name: file.name, bytes: file.size, url };
          sources.set(media.id, media);
          const { parsed, ...publicMedia } = media;
          return publicMedia;
        } catch (error) { revoke(url); throw error; }
      }
      if (path.startsWith('/api/jobs/')) {
        const job = jobs.get(path.split('/').pop());
        if (!job) throw new Error('任务不存在。');
        return job;
      }
      if (path === '/api/process') {
        const payload = JSON.parse(request.body);
        const media = sources.get(payload.media_id);
        if (!media) throw new Error('请重新选择素材。');
        if (controller) throw new Error('已有任务在处理中。');
        const processor = { white, resize, gif }[payload.operation];
        if (!processor || (payload.operation === 'gif') !== (media.kind === 'video')) throw new Error('请选择与当前工具匹配的素材。');
        for (const job of jobs.values()) if (job.result?.url) revoke(job.result.url);
        jobs.clear();
        const job_id = crypto.randomUUID();
        const job = { status: 'working', progress: 0, message: '准备处理' };
        jobs.set(job_id, job);
        controller = new AbortController();
        const signal = controller.signal;
        const progress = (value, message) => { job.progress = value; job.message = message; };
        setTimeout(async () => {
          try {
            const result = await processor(media, payload.options || {}, progress, signal);
            if (signal.aborted) throw new Error('处理已取消。');
            const extension = result.blob.type.split('/')[1];
            const file = new File([result.blob], `${media.name.replace(/\.[^.]+$/, '')}_${payload.operation}.${extension}`, { type: result.blob.type });
            job.result = { ...result, file, bytes: result.blob.size, original_bytes: media.bytes, url: objectURL(result.blob), filename: file.name };
            delete job.result.blob;
            job.status = 'done'; job.progress = 100; job.message = '完成';
          } catch (error) { job.status = 'error'; job.message = error.message || '处理失败，请重试。'; }
          finally { controller = null; }
        }, 0);
        return { job_id };
      }
      throw new Error('未知操作。');
    }
  };
}
