const {contextBridge,ipcRenderer}=require('electron');
const bridge={};
for(const name of ['create','write','setFrame','setVisible','setColorScheme','snapshotText','snapshotImage','snapshotAndHide','scrollToBottom','focus','diagnosticText','destroy'])bridge[name]=(...args)=>ipcRenderer.invoke(name,...args);
bridge.onInput=()=>()=>{};bridge.onClosed=()=>()=>{};
contextBridge.exposeInMainWorld('proof',{bridge,done:text=>ipcRenderer.invoke('done',text)});
