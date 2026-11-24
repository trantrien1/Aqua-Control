/**
 * Sinh lại MANIFEST.sha256 cho gói bàn giao.
 *   node --no-warnings tools/make-manifest.mjs
 * Bỏ qua: data/, node_modules/, .env, .npm-cache, .git, .ui-smoke, file tạm.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'data', '.git', '.npm-cache', '.ui-smoke', '.vscode', '.pio', '.gh-tmp', '.tooling', '.playwright-cli', 'output']);
const SKIP_FILES = new Set(['.env', 'local-config.h', 'MANIFEST.sha256']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.tmp-') || entry.name.endsWith('.zip')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (!SKIP_FILES.has(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const lines = walk(ROOT)
  .map((file) => {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    return { rel, hash };
  })
  .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  .map(({ rel, hash }) => `${hash}  ${rel}`);

fs.writeFileSync(path.join(ROOT, 'MANIFEST.sha256'), lines.join('\n') + '\n');
console.log(`Đã ghi MANIFEST.sha256 cho ${lines.length} file.`);
