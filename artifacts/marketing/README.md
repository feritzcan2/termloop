# TermLoop feature videos

The homepage and GitHub README feature **6 essential workflows**. Each website video is silent 1920 × 1080 H.264 at 30 FPS, with a JPEG poster, optional English captions and three written steps. The README uses 960 × 540, 25 FPS looping GIFs of the same complete edits.

The selected recording intervals stay continuous: waits accelerate with smooth speed ramps, menus and results remain readable, and soft click ripples identify the actions. There are no new interior cuts, camera zooms, terminal highlights or baked caption panels. Only the most visible video plays automatically; manual pause and reduced-motion preferences are respected.

- [Ask To](../../landing/assets/videos/tour/ask-to.mp4): Ask one agent to consult another agent. TermLoop creates a visible helper Session, preserves the relationship, and returns the answer to the requester.
- [Handoff](../../landing/assets/videos/tour/handoff.mp4): Send a visible, composed handoff from one running Project Session to another. The target receives the brief in its own real terminal and continues from there.
- [Session Fork](../../landing/assets/videos/tour/fork.mp4): Fork a Session from the sidebar, see the parent-child relationship, and continue in a new Ghostty terminal. The branch in thinking is explicit instead of becoming another anonymous tab.
- [Tasks](../../landing/assets/videos/tour/task-briefs.mp4): Keep a clear brief, acceptance criteria and a small checklist attached to each Task.
- [Task Worktrees](../../landing/assets/videos/tour/task-worktrees.mp4): Create a branch and managed worktree directly from a Task. Keep parallel changes in separate checkouts.
- [Code review](../../landing/assets/videos/tour/full-file-review.mp4): Read the diff, compare versions side by side and keep track of the files you have checked.

## Recording provenance

Ask To, Tasks, Task Worktrees and Code review were captured on September 14, 2026. Handoff and Fork reuse the September 9 OBS deliveries with their added caption band removed, then receive the same new timing and click treatment. Their earlier interface remains visible; these two are not new September 14 takes. The renderer preserves the entire selected source interval, but does not establish whether earlier edits of those two recovered deliveries contained cuts.

The populated Launchpad demo includes source files, Git changes, Tasks and five release tests. Its reusable template is in [tools/marketing/demo-project](../../tools/marketing/demo-project). Worktree footage ends after successful creation. A stationary recorder coordinate overlay in an empty corner of the three new feature takes is removed. A workflow-editor take was excluded after an unsupported lead-agent error; it is not presented as a successful demo.

## Reproduce

Keep raw recordings outside the repository. Capture only the demo window in OBS at native 1920 × 1080, 30 FPS, with audio muted. Enable the password-protected OBS WebSocket server only for capture, using `node tools/marketing/capture.mjs start` and `stop <feature-id>`.

With Python 3, Node, ffmpeg and ffprobe installed:

```sh
python3 tools/marketing/render.py --recordings /absolute/path/to/recordings
python3 tools/marketing/readme-gifs.py
node tools/marketing/build-guide.mjs
node --test tools/marketing/*.test.mjs tools/marketing/demo-project/test/*.test.mjs
python3 tools/marketing/render_test.py
node tools/marketing/verify.mjs
```

`catalog.json` owns the six features and written steps. `edits.json` pins source checksums, dates, speed ramps, click positions and caption anchors. Each delivered MP4 has a JSON report with its checksum, frame count and source coverage. Older assets remain in the archive; the homepage references only these six MP4s.

These demonstrations are not comprehensive integration tests. Cross-provider routing, mobile pairing and notification delivery were not retested during this media update.
