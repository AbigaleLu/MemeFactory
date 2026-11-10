import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'docs');
await mkdir(output, { recursive: true });
await Promise.all(['index.html', 'style.css', 'favicon.svg'].map(name => copyFile(path.join(root, 'site', name), path.join(output, name))));
await build({
  entryPoints: { app: path.join(root, 'site/app.js'), worker: path.join(root, 'site/worker.js') },
  outdir: output, bundle: true, format: 'esm', target: ['safari16.4', 'chrome100'],
  minify: true, legalComments: 'eof', logLevel: 'info'
});
const licenses = await Promise.all([
  ['gifenc', 'LICENSE'], ['gifuct-js', 'LICENSE'], ['js-binary-schema-parser', 'LICENSE']
].map(async ([name, file]) => {
  let text;
  try { text = await readFile(path.join(root, 'node_modules', name, file), 'utf8'); }
  catch { text = await readFile(path.join(root, 'node_modules', name, file + '.md'), 'utf8'); }
  return `${name}\n${'='.repeat(name.length)}\n${text.replace(/\r\n/g, '\n').trimEnd()}`;
}));
await writeFile(path.join(output, 'THIRD_PARTY_LICENSES.txt'), licenses.join('\n\n') + '\n');
await writeFile(path.join(output, '.nojekyll'), '');
console.log('GitHub Pages build ready: docs/');
