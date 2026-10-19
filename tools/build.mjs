// Single-file build for publishing.
// Inlines styles.css and every ES module reachable from src/main.js into
// dist/index.html, so the published page needs no supporting files.
//
// The simulation worker cannot be a separate file either, so src/sim-worker.js
// and its imports are bundled the same way into a classic script whose source
// replaces `const INLINE_WORKER_SOURCE = null;` in src/sim-host.js; the page
// then starts the worker from a Blob URL.
//
//   node tools/build.mjs              a complete standalone page
//   node tools/build.mjs --fragment   the page without <!doctype>/<html>/<head>/<body>,
//                                     for hosts that wrap a fragment in their own document
//
// The module transform is deliberately small: it supports the subset this
// project uses (named `import { a, b as c } from './x.js'`, and `export`
// on function/class/const/let declarations or `export { a, b }` lists).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const entry = join(root, 'src', 'main.js');
const workerEntry = join(root, 'src', 'sim-worker.js');
const WORKER_MARKER = 'const INLINE_WORKER_SOURCE = null;';

const IMPORT_RE = /^\s*import\s*\{([^}]*)\}\s*from\s*['"](\.\/[^'"]+)['"];?\s*$/gm;
const BARE_IMPORT_RE = /^\s*import\s+['"][^'"]+['"];?\s*$/gm;
const EXPORT_DECL_RE = /^export\s+(?:async\s+)?(function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\};?\s*$/gm;

function modId(path) {
  return '__m_' + path.slice(root.length + 1).replace(/[^A-Za-z0-9]/g, '_');
}

/** Bundle `entryPath` and everything it imports into one script of module-scoped IIFEs. */
async function bundle(entryPath) {
  const modules = new Map(); // abs path -> { id, header, body, exports }
  const order = [];

  async function load(path, stack = []) {
    if (modules.has(path)) return;
    if (stack.includes(path)) throw new Error('Circular import: ' + [...stack, path].join(' -> '));
    const src = await readFile(path, 'utf8');
    if (/^\s*export\s+default\b/m.test(src)) throw new Error(`Default exports are not supported: ${path}`);
    if (/\bimport\s*\(/.test(src)) throw new Error(`Dynamic import is not supported: ${path}`);

    const deps = [];
    const bindings = [];
    for (const m of src.matchAll(IMPORT_RE)) {
      const dep = resolve(dirname(path), m[2]);
      deps.push(dep);
      const names = m[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
        const [name, alias] = s.split(/\s+as\s+/).map((t) => t.trim());
        return alias ? `${name}: ${alias}` : name;
      });
      bindings.push({ dep, names });
    }
    for (const dep of deps) await load(dep, [...stack, path]);

    const exports = [];
    for (const m of src.matchAll(EXPORT_DECL_RE)) exports.push(m[2]);
    for (const m of src.matchAll(EXPORT_LIST_RE)) {
      for (const s of m[1].split(',').map((t) => t.trim()).filter(Boolean)) {
        const [name, alias] = s.split(/\s+as\s+/).map((t) => t.trim());
        exports.push(alias ? `${alias}: ${name}` : name);
      }
    }

    const body = src
      .replace(IMPORT_RE, '')
      .replace(BARE_IMPORT_RE, '')
      .replace(EXPORT_LIST_RE, '')
      .replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm, '');

    const header = bindings.map((b) => `const { ${b.names.join(', ')} } = ${modId(b.dep)};`).join('\n');
    modules.set(path, { id: modId(path), header, body, exports });
    order.push(path);
  }

  await load(entryPath);

  let script = '';
  for (const path of order) {
    const m = modules.get(path);
    const name = path.slice(root.length + 1).replace(/\\/g, '/');
    script += `// ---- ${name}\nconst ${m.id} = (() => {\n${m.header}\n${m.body}\nreturn { ${m.exports.join(', ')} };\n})();\n\n`;
  }
  return { script, count: order.length };
}

// The worker runs as a classic script, so it asks for the strict mode modules have.
const worker = await bundle(workerEntry);
const workerSource = `'use strict';\n${worker.script}`;
if (/\bimport\.meta\b/.test(workerSource)) throw new Error('The worker bundle uses import.meta, which a classic worker cannot');
new Script(workerSource, { filename: 'sim-worker (bundled)' }); // syntax check only

const app = await bundle(entry);
const markerAt = app.script.indexOf(WORKER_MARKER);
if (markerAt < 0 || app.script.indexOf(WORKER_MARKER, markerAt + 1) >= 0) {
  throw new Error(`Expected exactly one "${WORKER_MARKER}" in the bundle (src/sim-host.js)`);
}
const script = app.script.replace(WORKER_MARKER, () => `const INLINE_WORKER_SOURCE = ${JSON.stringify(workerSource)};`);

const css = await readFile(join(root, 'styles.css'), 'utf8');
let html = await readFile(join(root, 'index.html'), 'utf8');

const cssTag = '<link rel="stylesheet" href="styles.css">';
const jsTag = '<script type="module" src="src/main.js"></script>';
if (!html.includes(cssTag) || !html.includes(jsTag)) throw new Error('index.html is missing the stylesheet or module script tag');

// Guard against a stray closing tag inside inlined code (inside the worker's
// string literal too, where <\/script reads back as </script).
const safeScript = script.replace(/<\/script/gi, '<\\/script');
const safeCss = css.replace(/<\/style/gi, '<\\/style');
html = html.replace(cssTag, () => `<style>\n${safeCss}\n</style>`);
html = html.replace(jsTag, () => `<script type="module">\n${safeScript}</script>`);

if (process.argv.includes('--fragment')) {
  // Keep the head's children (title first, so hosts that scan for it find it) and the body's
  // content; drop the document skeleton itself.
  const head = html.match(/<head>([\s\S]*?)<\/head>/);
  const body = html.match(/<body>([\s\S]*?)<\/body>/);
  if (!head || !body) throw new Error('index.html needs <head> and <body> for --fragment');
  const headInner = head[1]
    .replace(/^\s*<meta charset=[^>]*>\s*$/m, '')
    .replace(/^\s*<meta name="viewport"[^>]*>\s*$/m, '');
  html = `${headInner.trim()}\n\n${body[1].trim()}\n`;
}

await mkdir(join(root, 'dist'), { recursive: true });
await writeFile(join(root, 'dist', 'index.html'), html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
const workerKb = (Buffer.byteLength(workerSource) / 1024).toFixed(1);
console.log(`dist/index.html written (${kb} KB, ${app.count} modules; worker ${workerKb} KB, ${worker.count} modules, inlined)`);
