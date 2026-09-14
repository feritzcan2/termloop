# TermLoop feature videos

The homepage and GitHub README feature **7 essential workflows**, followed by 6 compact everyday tools. Website videos are silent 1920 × 1080 H.264, with a JPEG poster, optional English captions and three written steps. Five demos run at 30 FPS; Quick Actions and Changes retain their original 20 and 15 FPS. README GIFs follow the same complete edits at 960 × 540, up to 25 FPS.

The demos focus on the action in five seconds; Tasks takes six seconds to include its optional worktree. Fixed close-ups enlarge menus, forms and changed lines. Explicit cuts omit waiting and repeated navigation. Fork retains its continuous sequence with smooth wait acceleration and click ripples. Tasks selects moments from the brief and worktree chapters. Quick Actions and Changes retain their recorded 20 and 15 FPS. Only the most visible video plays automatically; manual pause and reduced-motion preferences are respected.

- [Ask To](../../landing/assets/videos/tour/ask-to.mp4): Ask one agent to consult another agent. TermLoop creates a visible helper Session, preserves the relationship, and returns the answer to the requester.
- [Quick Actions](../../landing/assets/videos/tour/quick-actions.mp4): Open Quick Actions, write the request and launch an agent with the right context.
- [Handoff](../../landing/assets/videos/tour/handoff.mp4): Send a visible, composed handoff from one running Project Session to another. The target receives the brief in its own real terminal and continues from there.
- [Session Fork](../../landing/assets/videos/tour/fork.mp4): Fork a Session from the sidebar, see the parent-child relationship, and continue in a new Ghostty terminal. The branch in thinking is explicit instead of becoming another anonymous tab.
- [Tasks](../../landing/assets/videos/tour/tasks.mp4): Keep the goal, acceptance criteria and checklist in one Task. When the change needs its own checkout, create a branch and worktree from that same Task.
- [Changes](../../landing/assets/videos/tour/changes.mp4): Open the diff, leave a note on a line and send the review to a running agent.
- [Code review](../../landing/assets/videos/tour/full-file-review.mp4): Read the diff, compare versions side by side and keep track of the files you have checked.

Everyday tools use compact illustrated cards with links to their written guides, without adding more video players: Keep Awake, Pause to Read, Task Favorites, Developer Notes, Notifications, Appearance. Their decorative previews are not live app controls.

The social sharing poster is a still from the Tasks close-up, replacing the earlier empty terminal. All 31 written feature guides were considered for presentation. The six everyday cards remain static: their controls are explained without an extra loop. The other 18 features retain their existing written guides: Dev Server, Run configurations, Multi-Agent, Agent library, Custom agents, Workflow templates, Review cycles, Task Lifecycle, Session Refresh, Review progress, Task archive, Restore archived work, Steward, Mobile Companion, MCP & Prompts, Context Bank, Instruction consistency and Skill library. No extra video players are needed to repeat those guides or the actions already shown in the seven main demos.

## Recording provenance

Ask To, Fork, both Tasks chapters and Code review were captured on September 14. These are edits of real footage, not new recordings. Fork shows the Session menu action and the resulting child Session with visible parentage in five seconds. Handoff uses the September 9 recording; Quick Actions and Changes use earlier archived recordings. Cropping improves focus but does not modernize those older interfaces.

The populated Launchpad demo includes source files, Git changes, Tasks and five release tests. Its reusable template is in [tools/marketing/demo-project](../../tools/marketing/demo-project). Worktree footage ends after successful creation. The close-ups exclude the stationary recorder coordinate overlay. A workflow-editor take was excluded after an unsupported lead-agent error; it is not presented as a successful demo.

## Reproduce

Keep raw recordings outside the repository. Capture only the demo window in OBS at native 1920 × 1080, 30 FPS, with audio muted. Enable the password-protected OBS WebSocket server only for capture, using `node tools/marketing/capture.mjs start` and `stop <feature-id>`.

With Python 3, Node, ffmpeg and ffprobe installed:

```sh
python3 tools/marketing/render.py --recordings /absolute/path/to/recordings
python3 tools/marketing/readme-gifs.py
node tools/marketing/build-guide.mjs
node --test tools/marketing/*.test.mjs tools/marketing/demo-project/test/*.test.mjs
python3 -B tools/marketing/render_test.py
node tools/marketing/verify.mjs
```

`catalog.json` owns the seven video features and written steps; `extras.json` owns the six everyday tools. `edits.json` pins source checksums, source roots, selected intervals, close-up crops, output durations and caption anchors. Shot-based captions and posters use output time; Fork retains source-time anchors. Each delivered MP4 has a JSON report with its checksum, frame count and source coverage. Older assets remain in the archive; the homepage references only these seven MP4s. Rebuild the repo-backed Quick Actions, Tasks and Changes edits with `python3 tools/marketing/render.py --only quick-actions tasks changes`.

These demonstrations are not comprehensive integration tests. Cross-provider routing, mobile pairing and notification delivery were not retested during this media update.
