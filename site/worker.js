import { encodeAdaptiveGIF, removeWhiteRGBA } from './core.js';

self.onmessage = ({ data: job }) => {
  const progress = (value, message) => self.postMessage({ type: 'progress', value, message });
  try {
    if (job.operation === 'white') {
      const result = removeWhiteRGBA(new Uint8ClampedArray(job.buffer), job.width, job.height, job.options, progress);
      self.postMessage({ type: 'done', changed: result.changed, buffer: result.data.buffer }, [result.data.buffer]);
    } else if (job.operation === 'gif') {
      const result = encodeAdaptiveGIF(job.frames.map(buffer => new Uint8ClampedArray(buffer)), job.width, job.height, job.durationMs, job.options, progress);
      self.postMessage({ type: 'done', ...result, bytes: result.bytes.buffer }, [result.bytes.buffer]);
    } else throw new Error('未知处理任务。');
  } catch (error) { self.postMessage({ type: 'error', message: error.message || '素材处理失败，请换一份素材重试。' }); }
};
