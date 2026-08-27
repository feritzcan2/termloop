import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-f2-task-launch-repair-"));
const runtimeDirectory = path.join(temporary, "runtime");
const stateDirectory = path.join(temporary, "state");
const runtimeFile = path.join(runtimeDirectory, "runtime.json");
const repository = path.join(temporary, "repository");
const worktree = path.join(temporary, "task-worktree");
const moved = path.join(temporary, "task-worktree-moved");
const globalGitConfig = path.join(temporary, "global.gitconfig");
const emptyHooks = path.join(temporary, "empty-hooks");
const agentBin = path.join(temporary, "agent-bin");
const agentProbeLog = path.join(temporary, "agent-probes.log");
const serverBinary = path.join(root, "target/debug", process.platform === "win32" ? "termloop-server.exe" : "termloop-server");
const evidencePath = path.join(root, "artifacts/evidence/f2/task-launch-repair.local.json");
await Promise.all([mkdir(runtimeDirectory,{recursive:true}),mkdir(stateDirectory,{recursive:true}),mkdir(emptyHooks,{recursive:true}),mkdir(agentBin,{recursive:true}),mkdir(path.dirname(evidencePath),{recursive:true}),writeFile(globalGitConfig,""),writeFile(agentProbeLog,"")]);
await Promise.all([installFakeAgent("claude"),installFakeAgent("codex")]);
git(temporary,["init","--initial-branch=main",repository]);
git(repository,["config","user.name","TermLoop Fixture"]); git(repository,["config","user.email","fixture@termloop.invalid"]); git(repository,["commit","--allow-empty","-m","fixture"]);
const evidence={schema:"f2-task-launch-repair-v2",capturedAt:new Date().toISOString(),host:{platform:process.platform,arch:process.arch,git:git(repository,["--version"]).trim()},checks:{worktreeRequiredTyped:false,capabilitiesReported:false,capabilitySnapshotCached:false,taskTerminalLaunch:false,taskAgentLaunchUsesCachedCapability:false,sessionRemainsProjectScoped:false,multipleWritersAllowed:false,alternateBranchProjected:false,alternateBranchLaunch:false,durableTaskBranchPreserved:false,movedLinkInspectionAllowed:false,repairGenerationAdvanced:false,repairReplayIdempotent:false,originBranchPreserved:false,repairedTaskLaunch:false},installedAgents:[],skipped:{installedAgentLaunch:"A bounded fake-agent launch passes; interactive installed-agent startup is not asserted in unattended local acceptance.",shownElectronFlows:"Task-row alternate-branch action and colour are unit/type checked; a shown Electron interaction remains unmeasured.",launchTimeoutAndUnavailableMatrix:"Typed queue-timeout mapping and unavailable-reason rendering are implemented and type-checked; a saturated real-daemon matrix remains unmeasured.",repairCrashMatrix:"Prepared/invoked recovery transitions have store coverage; external daemon kill injection and shown retry/dismissal remain unmeasured.",repairSafetyMatrix:"Current-path stale backlink has real-Git coverage; unrelated-repository, lock, overflow, and three-generation repair replay remain unmeasured.",crossPlatformRuntime:"local host only",processKillMatrix:"external kill injection remains unmeasured"},failures:[]};
let server;
try {
 server=spawn(serverBinary,[],{cwd:root,env:{...process.env,PATH:`${agentBin}${path.delimiter}${process.env.PATH ?? ""}`,TERMLOOP_RUNTIME_DIR:runtimeDirectory,TERMLOOP_STATE_DIR:stateDirectory},stdio:["ignore","pipe","pipe"]});
 let stderr=""; server.stderr.on("data",chunk=>stderr+=String(chunk));
 const record=await readRecord(server.pid);
 const project=await call(record,"project.create",{name:"Task launch repair",folderPath:repository});
 const emptyTask=await call(record,"task.create",{projectId:project.id,title:"Needs worktree",brief:null,worktreeIntent:"none"});
 const required=await rawCall(record,"task.launchTerminal",{taskId:emptyTask.id});
 assert.equal(required.ok,false); assert.deepEqual(required.error.details,{kind:"worktreeRequired",taskId:emptyTask.id}); evidence.checks.worktreeRequiredTyped=true;
 const startupProbeCount=await probeCount();
 const capabilities=await call(record,"agent.capabilityList"); assert.deepEqual(capabilities.map(value=>value.agent_id).sort(),["claude","codex"]); evidence.installedAgents=capabilities.filter(value=>value.available).map(value=>value.agent_id); evidence.checks.capabilitiesReported=true;
 assert.deepEqual(await call(record,"agent.capabilityList"),capabilities); assert.equal(await probeCount(),startupProbeCount); evidence.checks.capabilitySnapshotCached=true;
 const task=await call(record,"task.create",{projectId:project.id,title:"Managed Task",brief:"visible brief",worktreeIntent:"none"});
 const provision=await call(record,"task.provisionWorktree",{operationId:randomUUID(),taskId:task.id,repositoryPath:repository,destinationPath:worktree,branchName:"feature/task-launch",branchMode:"create",baseRef:"refs/heads/main"});
 const fakeAgent=await call(record,"task.launchAgent",{taskId:task.id,agentId:"claude"}); assert.equal(fakeAgent.process.cwd,await real(worktree)); await new Promise(resolve=>setTimeout(resolve,100)); assert.equal(await probeCount(),startupProbeCount); evidence.checks.taskAgentLaunchUsesCachedCapability=true;
 const terminal=await call(record,"task.launchTerminal",{taskId:task.id}); assert.equal(terminal.process.cwd,await real(worktree)); evidence.checks.taskTerminalLaunch=true; assert.equal("task_id" in terminal,false); evidence.checks.sessionRemainsProjectScoped=true;
 const terminal2=await call(record,"task.launchTerminal",{taskId:task.id}); assert.notEqual(terminal.id,terminal2.id); evidence.checks.multipleWritersAllowed=true;
 await call(record,"session.terminate",{sessionId:terminal.id}); await call(record,"session.terminate",{sessionId:terminal2.id});
 git(worktree,["checkout","-b","agent/current-work"]);
 await call(record,"task.inspectWorktreeCleanup",{taskId:task.id});
 const alternateTask=(await call(record,"task.list",{projectId:project.id})).find(candidate=>candidate.id===task.id);
 assert.equal(alternateTask.branch.name,"feature/task-launch"); evidence.checks.durableTaskBranchPreserved=true;
 assert.equal(alternateTask.worktree_health.checked_out_branch,"agent/current-work"); assert.equal(alternateTask.worktree_health.launch_ready,true); evidence.checks.alternateBranchProjected=true;
 const alternateTerminal=await call(record,"task.launchTerminal",{taskId:task.id}); assert.equal(alternateTerminal.process.cwd,await real(worktree)); evidence.checks.alternateBranchLaunch=true; await call(record,"session.terminate",{sessionId:alternateTerminal.id});
 await ensureSessionStopped(record,fakeAgent.id);
 git(worktree,["checkout","feature/task-launch"]);
 await rename(worktree,moved);
 const aliasedMoved=path.join(moved,"..",path.basename(moved));
 const preview=await call(record,"task.inspectWorktreeRepair",{taskId:task.id,candidatePath:aliasedMoved}); assert.equal(preview.decision,"allowed",JSON.stringify(preview)); assert.equal(preview.candidate_path,await real(moved)); evidence.checks.movedLinkInspectionAllowed=true;
 const repairParams={operationId:randomUUID(),taskId:task.id,candidatePath:aliasedMoved,expectedManagedWorktreeOperationId:preview.managed_worktree_operation_id,expectedWorktreeGeneration:preview.worktree_generation};
 const repaired=await call(record,"task.repairWorktree",repairParams); assert.equal(repaired.worktree_generation,preview.worktree_generation+1); evidence.checks.repairGenerationAdvanced=true;
 const replayed=await call(record,"task.repairWorktree",repairParams); assert.equal(replayed.outcome,"alreadyCompleted"); assert.equal(replayed.worktree_generation,repaired.worktree_generation); evidence.checks.repairReplayIdempotent=true;
 assert.equal(repaired.task.branch.name,"feature/task-launch"); evidence.checks.originBranchPreserved=true;
 const after=await call(record,"task.launchTerminal",{taskId:task.id}); assert.equal(after.process.cwd,await real(moved)); evidence.checks.repairedTaskLaunch=true; await call(record,"session.terminate",{sessionId:after.id});
 assert.equal(provision.task.id,task.id);
 await writeFile(evidencePath,JSON.stringify(evidence,null,2)+"\n");
 console.log(`F2_TASK_LAUNCH_REPAIR_OK ${evidencePath}`);
} catch(error) { evidence.failures.push(error instanceof Error?error.stack??error.message:String(error)); await writeFile(evidencePath,JSON.stringify(evidence,null,2)+"\n"); throw error; }
finally { if(server?.exitCode===null){server.kill("SIGINT");await new Promise(resolve=>server.once("exit",resolve));} await rm(temporary,{recursive:true,force:true}); }

async function installFakeAgent(name){const executable=path.join(agentBin,name);await writeFile(executable,`#!/bin/sh\ncase "$1" in\n  --help) printf '%s\\n' '${name}:help' >> ${JSON.stringify(agentProbeLog)}; printf '%s\\n' 'fixture help' ;;\n  --version) printf '%s\\n' '${name}:version' >> ${JSON.stringify(agentProbeLog)}; printf '%s\\n' '${name} fixture 1.0' ;;\n  app-server) if [ "$2" = "--help" ]; then printf '%s\\n' '${name}:app-server-help' >> ${JSON.stringify(agentProbeLog)}; printf '%s\\n' 'fixture app server'; fi ;;\nesac\nexit 0\n`);await chmod(executable,0o755);}
async function probeCount(){return (await readFile(agentProbeLog,"utf8")).split("\n").filter(Boolean).length;}
async function ensureSessionStopped(record,sessionId){const termination=await rawCall(record,"session.terminate",{sessionId});assert.ok(termination.ok||termination.error?.code==="notFound");const end=Date.now()+3000;while(Date.now()<end){const session=(await call(record,"session.list")).find(candidate=>candidate.id===sessionId);if(!session||!["running","resuming"].includes(session.lifecycle_state))return;await new Promise(resolve=>setTimeout(resolve,40));}throw new Error(`Session ${sessionId} did not stop`);}

async function readRecord(pid){const end=Date.now()+8000;while(Date.now()<end){try{const value=JSON.parse(await readFile(runtimeFile,"utf8"));if(value.pid===pid)return value;}catch{}await new Promise(r=>setTimeout(r,40));}throw new Error("runtime discovery timeout");}
async function call(record,method,params={}){const response=await rawCall(record,method,params);if(!response.ok)throw new Error(`${method}: ${response.error?.code}: ${response.error?.message} ${JSON.stringify(response.error?.details)}`);return response.result;}
async function rawCall(record,method,params={}){const socket=new WebSocket(record.controlUrl);const id=randomUUID();return await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{socket.close();reject(new Error(`${method} timeout`));},12000);socket.once("open",()=>socket.send(JSON.stringify({id,protocolVersion:record.protocolVersion,token:record.token,method,params})));socket.once("message",raw=>{clearTimeout(timeout);socket.close();resolve(JSON.parse(String(raw)));});socket.once("error",reject);});}
function git(cwd,args){return execFileSync("git",["-c",`core.hooksPath=${emptyHooks}`,...args],{cwd,encoding:"utf8",env:{...process.env,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:globalGitConfig,GIT_TERMINAL_PROMPT:"0",LC_ALL:"C",LANG:"C",GIT_AUTHOR_NAME:"Fixture",GIT_AUTHOR_EMAIL:"fixture@termloop.invalid",GIT_COMMITTER_NAME:"Fixture",GIT_COMMITTER_EMAIL:"fixture@termloop.invalid"}});}
async function real(value){const {realpath}=await import("node:fs/promises");return realpath(value);}
