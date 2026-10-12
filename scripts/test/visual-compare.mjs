// Compares the screenshots of the visual suite with the committed baselines and writes one self-contained HTML report.
//   node scripts/test/visual-compare.mjs --actual <dir> --baselines <dir> --out <dir> [--update]
// <dir>/<theme>/<scenario>.png. Masks (tests/visual/masks.json): rectangles painted over in both images before the
// comparison, per scenario ("*" = every scenario). --update copies the actual screenshots over the baselines.
// pixelmatch + pngjs are root devDependencies (never in the VSIX).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const actualDir = path.resolve(arg('--actual', path.join(repo, 'test-results', 'visual', 'actual')));
const baselineDir = path.resolve(arg('--baselines', path.join(repo, 'tests', 'visual', 'baselines')));
const outDir = path.resolve(arg('--out', path.join(repo, 'test-results', 'visual')));
const masksFile = path.resolve(arg('--masks', path.join(repo, 'tests', 'visual', 'masks.json')));
const update = process.argv.includes('--update');

/** Per-pixel color tolerance of pixelmatch (0..1) and the share of differing pixels that still passes. */
const THRESHOLD = 0.1;
const MAX_DIFF_RATIO = 0.0005;

const masks = fs.existsSync(masksFile) ? JSON.parse(fs.readFileSync(masksFile, 'utf8')) : {};
const read = (f) => PNG.sync.read(fs.readFileSync(f));

function paintMasks(png, rects) {
  for (const r of rects) {
    for (let y = Math.max(0, r.y); y < Math.min(png.height, r.y + r.height); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(png.width, r.x + r.width); x++) {
        const i = (y * png.width + x) * 4;
        png.data[i] = 255;
        png.data[i + 1] = 0;
        png.data[i + 2] = 255;
        png.data[i + 3] = 255;
      }
    }
  }
}

const themes = fs.existsSync(actualDir) ? fs.readdirSync(actualDir).filter((t) => fs.statSync(path.join(actualDir, t)).isDirectory()).sort() : [];
if (themes.length === 0) {
  console.error(`No screenshots in ${actualDir}`);
  process.exit(1);
}

const results = [];
for (const theme of themes) {
  for (const f of fs.readdirSync(path.join(actualDir, theme)).filter((x) => x.endsWith('.png')).sort()) {
    const scenario = f.replace(/\.png$/, '');
    const actualPath = path.join(actualDir, theme, f);
    const baselinePath = path.join(baselineDir, theme, f);
    if (update) {
      fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
      fs.copyFileSync(actualPath, baselinePath);
      results.push({ theme, scenario, status: 'updated', actualPath, baselinePath });
      continue;
    }
    if (!fs.existsSync(baselinePath)) {
      results.push({ theme, scenario, status: 'missing baseline', actualPath });
      continue;
    }
    const actual = read(actualPath);
    const baseline = read(baselinePath);
    if (actual.width !== baseline.width || actual.height !== baseline.height) {
      results.push({ theme, scenario, status: `size ${actual.width}x${actual.height} ≠ ${baseline.width}x${baseline.height}`, actualPath, baselinePath });
      continue;
    }
    const rects = [...(masks['*'] ?? []), ...(masks[scenario] ?? [])];
    paintMasks(actual, rects);
    paintMasks(baseline, rects);
    const diff = new PNG({ width: actual.width, height: actual.height });
    const pixels = pixelmatch(baseline.data, actual.data, diff.data, actual.width, actual.height, { threshold: THRESHOLD });
    const ratio = pixels / (actual.width * actual.height);
    const diffPath = path.join(outDir, 'diff', theme, f);
    fs.mkdirSync(path.dirname(diffPath), { recursive: true });
    fs.writeFileSync(diffPath, PNG.sync.write(diff));
    results.push({ theme, scenario, status: ratio <= MAX_DIFF_RATIO ? 'pass' : 'fail', pixels, ratio, actualPath, baselinePath, diffPath });
  }
}
// A baseline without a screenshot is a scenario that did not run.
if (!update && fs.existsSync(baselineDir)) {
  for (const theme of fs.readdirSync(baselineDir)) {
    for (const f of fs.readdirSync(path.join(baselineDir, theme)).filter((x) => x.endsWith('.png'))) {
      if (!results.some((r) => r.theme === theme && r.scenario === f.replace(/\.png$/, ''))) results.push({ theme, scenario: f.replace(/\.png$/, ''), status: 'no screenshot', baselinePath: path.join(baselineDir, theme, f) });
    }
  }
}

const dataUri = (p) => (p && fs.existsSync(p) ? `data:image/png;base64,${fs.readFileSync(p).toString('base64')}` : '');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ok = (r) => r.status === 'pass' || r.status === 'updated';
const failed = results.filter((r) => !ok(r));
const rows = results
  .map((r) => {
    const img = (p, label) => (p ? `<figure><figcaption>${label}</figcaption><a href="${dataUri(p)}" target="_blank"><img src="${dataUri(p)}" alt="${label}"></a></figure>` : `<figure><figcaption>${label}</figcaption><div class="none">none</div></figure>`);
    const detail = r.pixels !== undefined ? ` — ${r.pixels} px (${(r.ratio * 100).toFixed(3)} %)` : '';
    return `<section class="${ok(r) ? 'ok' : 'bad'}"><h2>${esc(r.theme)} / ${esc(r.scenario)} <span>${esc(r.status)}${detail}</span></h2><div class="row">${img(r.baselinePath, 'baseline')}${img(r.actualPath, 'actual')}${img(r.diffPath, 'diff')}</div></section>`;
  })
  .join('\n');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Refyntra visual tests</title><style>
body{font:14px system-ui,sans-serif;margin:16px;background:#fff;color:#111}h1{font-size:20px}h2{font-size:15px;margin:0 0 8px}
h2 span{font-weight:normal}section{border:1px solid #ccc;border-left:6px solid #2a2;padding:8px;margin:0 0 16px}section.bad{border-left-color:#d22}
.row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}figure{margin:0}figcaption{color:#555;font-size:12px}img{width:100%;border:1px solid #ddd}.none{padding:24px;color:#888;border:1px dashed #ccc}
@media (max-width:900px){.row{grid-template-columns:1fr}}
</style></head><body><h1>Refyntra visual tests: ${results.length - failed.length}/${results.length} ${update ? 'updated' : 'passed'}</h1>
<p>Threshold ${THRESHOLD}, at most ${(MAX_DIFF_RATIO * 100).toFixed(3)} % differing pixels; masked regions are magenta in the diff inputs.</p>
${rows}</body></html>`;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'report.html'), html);

for (const r of results) console.log(`${ok(r) ? 'PASS' : 'FAIL'}  ${r.theme}/${r.scenario}  ${r.status}${r.pixels !== undefined ? ` (${r.pixels} px)` : ''}`);
console.log(`Report: ${path.join(outDir, 'report.html')}`);
process.exit(failed.length ? 1 : 0);
