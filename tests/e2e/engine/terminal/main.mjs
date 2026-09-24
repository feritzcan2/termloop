import {app,BrowserWindow,ipcMain,nativeImage} from 'electron';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {GhosttySurfaceManager,loadGhosttyHostAddon} from '@termloop/ghostty-host';
const require=createRequire(import.meta.url);
async function run(){
await app.whenReady();
const addon=loadGhosttyHostAddon({addonPath:require.resolve('@termloop/ghostty-host/addon'),resourcesPath:path.dirname(require.resolve('@termloop/ghostty-host/resource-manifest'))});
if(!addon)throw Error('real Ghostty addon failed to load');
const window=new BrowserWindow({width:820,height:540,show:false,webPreferences:{preload:path.resolve('preload.cjs'),contextIsolation:true,sandbox:true}});
const manager=new GhosttySurfaceManager(addon,window,require.resolve('@termloop/ghostty-host/embedded-config'),require.resolve('@termloop/ghostty-host/light-config'),{input:()=>{},closed:()=>{},shortcut:()=>{throw Error('product shortcut leaked');}});
let surfaceId;
const routes={create:frame=>{const result=manager.create(frame);surfaceId=result.surfaceId;return result;},write:(id,bytes)=>manager.write(id,bytes),setFrame:(...args)=>manager.setFrame(...args),setVisible:(...args)=>manager.setVisible(...args),setColorScheme:(...args)=>manager.setColorScheme(...args),snapshotText:id=>manager.probeText(id),diagnosticText:id=>manager.probeText(id),snapshotImage:id=>manager.snapshotPng(id)?.toString('base64'),snapshotAndHide:id=>manager.snapshotAndHidePng(id)?.toString('base64'),scrollToBottom:id=>manager.scrollToBottom(id),focus:id=>manager.focus(id),destroy:id=>manager.destroy(id)};
for(const [name,callback] of Object.entries(routes))ipcMain.handle(name,(_, ...args)=>callback(...args));
const deadline=setTimeout(()=>{console.error('EXTERNAL_GHOSTTY_TIMEOUT');app.exit(1);},20000);
ipcMain.handle('done',async(_,text)=>{
 if(!text?.includes('EXTERNAL_GHOSTTY_ENGINE_READY')||!text.includes('İstanbul'))throw Error('native surface text mismatch: '+text);
 let png; const until=Date.now()+8000; let colors=0;
 while(Date.now()<until){png=manager.snapshotPng(surfaceId); if(png?.length){const pixels=nativeImage.createFromBuffer(png).toBitmap();const seen=new Set();for(let i=0;i<pixels.length;i+=4)seen.add(pixels.readUInt32LE(i));colors=seen.size;if(colors>20)break;}await new Promise(resolve=>setTimeout(resolve,100));}
 if(colors<=20)throw Error('native surface did not render text pixels');
 await writeFile('native-surface.png',png);
 await writeFile('report.json',JSON.stringify({status:'pass',mode:'native',renderer:'Ghostty',nativeBytes:png.length,externalPackages:true}));
 console.log('EXTERNAL_GHOSTTY_CONSUMER_PASS');clearTimeout(deadline);manager.dispose();window.close();app.quit();
});
window.showInactive();await window.loadFile('index.html');
}
run().catch(error=>{console.error(error);app.exit(1);});
