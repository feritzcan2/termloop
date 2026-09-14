import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const catalog = JSON.parse(await readFile(path.join(root, 'tools/marketing/catalog.json'), 'utf8'));
const extras = JSON.parse(await readFile(path.join(root, 'tools/marketing/extras.json'), 'utf8'));
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const media = f => {
  const base = `assets/videos/tour/${f.id}`;
  return `<div class="feature-media"><div class="demo-frame">
    <video controls muted loop playsinline preload="${f.id === 'ask-to' ? 'metadata' : 'none'}" poster="${base}.jpg" width="1920" height="1080" aria-label="${escape(f.label)} demonstration" aria-describedby="${f.id}-caption"><source src="${base}.mp4" type="video/mp4"><track kind="captions" src="${base}.vtt" srclang="en" label="English"><a href="${base}.mp4">Watch ${escape(f.label)}</a></video>
    </div><div class="demo-actions"><button type="button" data-play-demo hidden>Play demo</button><button type="button" data-expand-demo hidden>Fullscreen</button><a href="${base}.mp4" download>MP4 ↓</a><span data-duration></span></div>
    <p class="demo-caption" id="${f.id}-caption">${escape(f.description)}</p>
    <details class="feature-instructions"><summary>How to use ${escape(f.label)}</summary><ol>${f.steps.map(step => `<li>${escape(step)}</li>`).join('')}</ol></details></div>`;
};
const [hero, ...features] = catalog;
const icons = {
  'keep-awake': '<path d="M12 3v8m-6-6a9 9 0 1 0 12 0"/>',
  'terminal-reading': '<path d="M8 5v14M16 5v14"/>',
  'task-favorites': '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z"/>',
  'developer-notes': '<path d="m7 12 3 3 7-7"/><rect x="3" y="3" width="18" height="18" rx="5"/>',
  notifications: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/>',
  appearance: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18" fill="currentColor" stroke="none"/>',
};
const everyday = `<section class="everyday-tools" id="everyday" aria-labelledby="everyday-heading">
  <div class="everyday-heading"><p class="prompt-line">the little things</p><h2 id="everyday-heading">Useful every day.</h2><p>Keep a long run awake, pause the output, or mark what matters. Small controls, always close to the work.</p></div>
  <div class="everyday-grid">${extras.map(f => `<article class="everyday-card" id="${f.id}"><a href="https://github.com/feritzcan2/termloop/blob/main/docs/features.md#${f.docAnchor}" aria-labelledby="${f.id}-title">
    <div class="everyday-preview preview-${f.id}" aria-hidden="true"><span class="everyday-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${icons[f.id]}</svg></span><span class="preview-copy">${escape(f.preview)}<small>${escape(f.hint)}</small></span></div>
    <h3 id="${f.id}-title">${escape(f.label)}</h3><p>${escape(f.description)}</p><span class="everyday-link">How it works <span aria-hidden="true">↗</span></span>
  </a></article>`).join('\n')}</div>
</section>`;
const heroMarkup = `        <!-- DEMO HERO START -->
        <div class="hero-demo" id="${hero.id}" data-demo data-demo-label="${escape(hero.label)}">
          <p class="feature-kicker">${escape(hero.label)}</p><h2>${escape(hero.title)}</h2>
          ${media(hero)}
        </div>
        <!-- DEMO HERO END -->`;
const tour = `    <section class="tour" id="features"><div class="shell">
      <div class="section-heading"><div><p class="prompt-line">${catalog.length} essential workflows</p><h2>See the work stay connected.</h2></div><p>Launch an agent, get a second opinion, and turn review notes into the next change. Follow real work in populated Projects.</p></div>
      <nav class="demo-nav" aria-label="Demo navigation">${catalog.map(f => `<a href="#${f.id}">${escape(f.label)}</a>`).join('')}<a href="#everyday">Everyday tools ↓</a></nav>
      <div class="tour-controls"><label class="autoplay-option"><input type="checkbox" id="demo-autoplay" checked disabled> Auto-play visible demos</label><label>Speed <select id="video-speed" disabled><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option></select></label></div>
      ${features.map(f => `<article class="feature-story" id="${f.id}" data-demo data-demo-label="${escape(f.label)}"><div class="feature-copy"><span class="feature-kicker">${escape(f.label)}</span><h3>${escape(f.title)}</h3></div>${media(f)}</article>`).join('\n')}
      ${everyday}
    </div></section>\n\n`;
const file = path.join(root, 'landing/index.html');
let page = await readFile(file, 'utf8');
const heroStart = page.indexOf('        <!-- DEMO HERO START -->');
const heroEnd = page.indexOf('        <!-- DEMO HERO END -->', heroStart);
if (heroStart < 0 || heroEnd < 0) throw new Error('Hero boundaries missing');
page = page.slice(0, heroStart) + heroMarkup + page.slice(heroEnd + '        <!-- DEMO HERO END -->'.length);
const start = page.indexOf('    <section class="tour" id="features">');
const end = page.indexOf('    <section class="section principles"', start);
if (start < 0 || end < 0) throw new Error('Feature guide boundaries missing');
page = page.slice(0, start) + tour + page.slice(end);
await writeFile(file, page);
const docs = `# TermLoop feature videos

The homepage and GitHub README feature **${catalog.length} essential workflows**, followed by ${extras.length} compact everyday tools. Website videos are silent 1920 × 1080 H.264, with a JPEG poster, optional English captions and three written steps. Six edited recordings run at 30 FPS; the restored Quick Actions and Changes clips retain their original 20 and 15 FPS. README GIFs follow the same complete edits at 960 × 540, up to 25 FPS.

The six September edits use continuous intervals with smooth wait acceleration and soft click ripples. Quick Actions and Changes preserve the previously published clips byte-for-byte, including their timing and earlier interface. Only the most visible video plays automatically; manual pause and reduced-motion preferences are respected.

${catalog.map(f => `- [${f.label}](../../landing/assets/videos/tour/${f.id}.mp4): ${f.description}`).join('\n')}

Everyday tools use compact illustrated cards with links to their written guides, without adding more video players: ${extras.map(f => f.label).join(', ')}. Their decorative previews are not live app controls.

## Recording provenance

Ask To, Tasks, Task Worktrees and Code review were captured on September 14, 2026. Handoff and Fork reuse the September 9 OBS deliveries with their added caption band removed, then receive the same new timing and click treatment. Their earlier interface remains visible; these two are not new September 14 takes. The renderer preserves the entire selected source interval, but does not establish whether earlier edits of those two recovered deliveries contained cuts.

The populated Launchpad demo includes source files, Git changes, Tasks and five release tests. Its reusable template is in [tools/marketing/demo-project](../../tools/marketing/demo-project). Worktree footage ends after successful creation. A stationary recorder coordinate overlay in an empty corner of the three new feature takes is removed. A workflow-editor take was excluded after an unsupported lead-agent error; it is not presented as a successful demo.

## Reproduce

Keep raw recordings outside the repository. Capture only the demo window in OBS at native 1920 × 1080, 30 FPS, with audio muted. Enable the password-protected OBS WebSocket server only for capture, using \`node tools/marketing/capture.mjs start\` and \`stop <feature-id>\`.

With Python 3, Node, ffmpeg and ffprobe installed:

\`\`\`sh
python3 tools/marketing/render.py --recordings /absolute/path/to/recordings
python3 tools/marketing/readme-gifs.py
node tools/marketing/build-guide.mjs
node --test tools/marketing/*.test.mjs tools/marketing/demo-project/test/*.test.mjs
python3 tools/marketing/render_test.py
node tools/marketing/verify.mjs
\`\`\`

\`catalog.json\` owns the eight video features and written steps; \`extras.json\` owns the six everyday tools. \`edits.json\` pins source checksums, archive paths, dates, speed ramps, click positions and caption anchors. Each delivered MP4 has a JSON report with its checksum, frame count and source coverage. Older assets remain in the archive; the homepage references only these eight MP4s. Restore just the two original clips with \`python3 tools/marketing/render.py --only quick-actions changes\`.

These demonstrations are not comprehensive integration tests. Cross-provider routing, mobile pairing and notification delivery were not retested during this media update.
`;
await writeFile(path.join(root, 'artifacts/marketing/README.md'), docs);
console.log(`Generated ${catalog.length} homepage demos and the recording guide.`);
