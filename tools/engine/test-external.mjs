import {spawnSync} from "node:child_process";
import {mkdir,mkdtemp,readFile,writeFile,cp} from "node:fs/promises";
import {createHash} from "node:crypto";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const options=new Map();for(let i=2;i<process.argv.length;i+=2)options.set(process.argv[i],process.argv[i+1]);
const repository=options.get("--repository"),revision=options.get("--revision");
if(!repository||!revision||!/^[a-f0-9]{40}$/.test(revision))throw Error("Supply --repository URL --revision FULL_SHA [--packages DIRECTORY]");
const packages=path.resolve(options.get("--packages")??path.join(root,"work/engine-packages"));
const directory=await mkdtemp(path.join(os.tmpdir(),"termloop-external-engine-"));
const manifest=JSON.parse(await readFile(path.join(packages,"engine-packages.json"),"utf8"));
for(const entry of manifest.packages){const bytes=await readFile(path.join(packages,entry.filename));if(createHash("sha256").update(bytes).digest("hex")!==entry.sha256)throw Error(`Changed package: ${entry.name}`);}
function run(program,args,cwd){const result=spawnSync(program,args,{cwd,stdio:"inherit",timeout:300000});if(result.status!==0)throw Error(`${program} failed (${result.status}): ${result.error??""}`);}
const rust=path.join(directory,"rust");await mkdir(path.join(rust,"src"),{recursive:true});
await cp(path.join(root,"tests/e2e/engine/rust/main.rs"),path.join(rust,"src/main.rs"));
await writeFile(path.join(rust,"Cargo.toml"),`[package]\nname="external-engine-consumer"\nversion="0.1.0"\nedition="2024"\n[dependencies]\n`+["launch","agent-runtime","terminal"].map(name=>`termloop-${name} = { git = ${JSON.stringify(repository)}, rev = ${JSON.stringify(revision)} }`).join("\n")+"\n");
run("cargo",["run","--quiet"],rust);
const terminal=path.join(directory,"terminal");await cp(path.join(root,"tests/e2e/engine/terminal"),terminal,{recursive:true});
await cp(packages,path.join(terminal,"vendor"),{recursive:true});
const dependencies=Object.fromEntries(manifest.packages.map(p=>[p.name,`file:vendor/${p.filename}`]));
await writeFile(path.join(terminal,"package.json"),JSON.stringify({name:"external-terminal-consumer",version:"0.1.0",private:true,type:"module",main:"main.mjs",packageManager:"pnpm@10.14.0",scripts:{build:"node build.mjs",test:"pnpm build && electron ."},dependencies:{...dependencies,electron:manifest.electron,esbuild:"0.28.1"},pnpm:{onlyBuiltDependencies:["electron","esbuild"],overrides:dependencies}},null,2));
run("pnpm",["install"],terminal);
run("pnpm",process.platform==="darwin"?["test"]:["build"],terminal);
await writeFile(path.join(directory,"report.json"),JSON.stringify({status:"pass",repository,revision,native:process.platform==="darwin"?"pass":"unmeasured",directory,packages:manifest.packages},null,2));
console.log(`EXTERNAL_ENGINE_PASS: ${directory}`);
