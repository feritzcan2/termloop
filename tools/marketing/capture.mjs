// Import in the CUA REPL and pass its documented App binding.
// All interaction and screenshots stay on the CUA API.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
export function createRecorder(app, root) {
  const state = () => app.getAXState({ emit: false, disableDiffing: true });
  const index = async pattern => {
    const line = (await state()).split('\n').find(line => pattern.test(line));
    if (!line) throw new Error(`Missing control: ${pattern}`);
    return Number(line.trim().match(/^\d+/)[0]);
  };
  const go = async pattern => { await app.click(await index(pattern)); return state(); };
  const fill = async (pattern, value) => { await app.setValue(await index(pattern), value); return state(); };
  const shot = async name => {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, `${name}.png`), await app.getScreenshot({ emit: false }));
  };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const record = async (name, actions) => {
    const directory = path.join(root, name);
    await mkdir(directory, { recursive: true });
    const times = [];
    const skipped = [];
    const start = Date.now();
    let done = false;
    let paused = false;
    let inCapture = false;
    const capture = (async () => {
      while (!done) {
        if (paused) { await delay(20); continue; }
        inCapture = true;
        try {
          const bytes = await app.getScreenshot({ emit: false });
          await writeFile(path.join(directory, `${String(times.length).padStart(5, '0')}.png`), bytes);
          times.push(Date.now() - start);
        } catch (error) {
          // Native menu-only surfaces can temporarily have no screenshot.
          skipped.push({ at: Date.now() - start, reason: String(error) });
        } finally { inCapture = false; }
        await delay(200);
      }
    })();
    try {
      await delay(1000);
      for (const action of actions) {
        paused = true;
        while (inCapture) await delay(20);
        await action();
        paused = false;
        await delay(2500);
      }
    } finally {
      done = true;
      await capture;
      await writeFile(path.join(directory, 'timing.json'), JSON.stringify(times));
      await writeFile(path.join(directory, 'capture.json'), JSON.stringify({ name, frames: times.length, skipped, elapsed: Date.now() - start }, null, 2));
    }
    if (!times.length) throw new Error(`No frames captured for ${name}`);
    return { name, frames: times.length, seconds: (Date.now() - start) / 1000 };
  };
  return { go, fill, shot, record, state };
}
