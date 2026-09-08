import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { TermLoopControlClient } from '../../contract/generated/typescript/dist/current.js';

const [runtimeFile, destination] = process.argv.slice(2);
if (!runtimeFile || !destination || !path.isAbsolute(destination)) throw new Error('Usage: node tools/marketing/seed-demo.mjs <runtime.json> <absolute-new-demo-folder>');
const template = fileURLToPath(new URL('./demo-project/', import.meta.url));
// Exclusive creation prevents a repeat recording from overwriting real work.
await mkdir(destination);
await cp(template, destination, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: destination, encoding: 'utf8' });
git('init', '-b', 'main');
git('add', '.');
git('-c', 'user.name=Launchpad Demo', '-c', 'user.email=demo@example.invalid', 'commit', '-m', 'Create fictional Launchpad release dashboard');
// A local remote-tracking base supports managed worktrees without a hosted repo.
git('remote', 'add', 'origin', destination);
git('fetch', 'origin');
const record = JSON.parse(await readFile(runtimeFile, 'utf8'));
const client = new TermLoopControlClient(record.controlUrl, record.token, url => new WebSocket(url));
try {
  const project = await client.call('project.create', { name: 'Launchpad Demo', folderPath: destination });
  const projectId = project.id;
  const tasks = [];
  for (const [title, brief] of [
    ['Polish onboarding checklist', 'Show clear progress for every release.\n\nAcceptance criteria:\n- Empty checklists show 0%.\n- Progress stays between 0 and 100.\n- Keyboard users can reach every action.\n- Run pnpm test before review.'],
    ['Build the activity feed', 'Add release events with readable timestamps and accessible status labels. Use fictional sample data only.'],
    ['Review keyboard navigation', 'Audit focus order, visible focus, and progress labels. Keep all controls usable without a mouse.'],
  ]) tasks.push(await client.call('task.create', { projectId, title, brief, worktreeIntent: 'none', worktreePrefix: null, baseRef: null, agentId: null, model: null, permission: null, reasoning: null, kickoffMessage: null }));
  await client.call('task.updateDeveloperNotes', { taskId: tasks[0].id, expectedDeveloperNotes: [], developerNotes: [
    { id: 'demo-empty', text: 'Check empty checklist behavior', completed: true },
    { id: 'demo-focus', text: 'Verify visible keyboard focus', completed: false },
    { id: 'demo-test', text: 'Run the five release tests before review', completed: false },
  ] });
  for (const [name, kind, command] of [['Launchpad preview', 'devServer', 'pnpm dev'], ['Release tests', 'testRunner', 'pnpm test']]) {
    const snapshot = await client.call('runConfiguration.list', { projectId });
    await client.call('runConfiguration.create', { projectId, name, kind, command, workingDirectory: '.', env: [], setupCommand: null, setupPolicy: 'never', urlAutoDetect: kind === 'devServer', fallbackUrls: kind === 'devServer' ? ['http://localhost:4173'] : [], autoOpenFirstUrl: false, expectedRevision: snapshot.stateRevision });
  }
  const workflows = await client.call('workflow.configurationList', { projectId });
  await client.call('workflow.configurationCreate', { projectId, name: 'Discuss, build, review', coordinatorAgentId: 'codex', model: 'default', permission: 'default', reasoning: 'default', maxReviewCycles: 2, expectedRevision: workflows.stateRevision, steps: [
    ['discuss', 'Challenge the approach', 'Review the checklist edge cases and agree on a small plan.', 'claude'],
    ['implement', 'Build the agreed change', 'Implement the agreed plan and run pnpm test.', null],
    ['review', 'Review accessibility and tests', 'Inspect the diff, keyboard access, and empty checklist tests.', 'claude'],
    ['fix', 'Resolve review findings', 'Address actionable findings and rerun the affected tests.', null],
  ].map(([kind, title, instructions, agentId], i) => ({ id: `step-${i+1}`, kind, title, instructions, agentId, reuseStepId: null, profileRef: null, model: agentId ? 'default' : null, permission: agentId ? 'default' : null, reasoning: agentId ? 'default' : null })) });
  const terminal = await client.call('session.launchTerminal', { projectId, cwd: destination });
  await client.call('session.rename', { sessionId: terminal.id, name: 'Launchpad · release checks' });
  const source = path.join(destination, 'src/releases.mjs');
  await writeFile(source, (await readFile(source, 'utf8')).replace('done: 6, total: 8', 'done: 7, total: 8'));
  await writeFile(path.join(destination, 'src/activity.mjs'), 'export const activity = [\n  { title: "Checklist edge cases covered", status: "Ready for review" },\n  { title: "Keyboard audit started", status: "In progress" },\n];\n');
  const evidence = { projectId, destination, tasks: tasks.map(({ id, title }) => ({ id, title })), terminalId: terminal.id };
  await writeFile('/tmp/termloop-marketing-demo.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { client.close(); }
