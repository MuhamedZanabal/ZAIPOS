// Run with the installed Electron binary. No real profile, network or credentials.
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'zaipos-cash-runtime-'));
fs.mkdirSync(path.join(root,'profile'));
app.setPath('userData',path.join(root,'profile'));
// This contract exercises storage, not GPU rendering.
app.disableHardwareAcceleration();
const html=path.join(root,'index.html');
fs.writeFileSync(html,'<!doctype html><meta charset="utf-8"><title>ZAIPOS recovery contract</title>');
const windows=[];
const watchdog=setTimeout(()=>{console.error('FAIL: desktop recovery runtime timed out');app.exit(1);},30000);
app.whenReady().then(async()=>{
 try{
  for(let i=0;i<2;i++){
   const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
   windows.push(win);await win.loadFile(html);
  }
  const [first,second]=windows.map(win=>win.webContents);
  const support=await first.executeJavaScript('({secure:isSecureContext,locks:!!navigator.locks,protocol:location.protocol})');
  assert.equal(support.protocol,'file:');assert.equal(support.secure,true);assert.equal(support.locks,true);
  await first.executeJavaScript(`new Promise((resolve,reject)=>{navigator.locks.request('zaipos-cash-contract',async()=>{resolve(true);await new Promise(release=>{window.releaseCashLock=release;});}).catch(reject);})`);
  assert.equal(await second.executeJavaScript(`navigator.locks.request('zaipos-cash-contract',{ifAvailable:true},lock=>lock===null)`),true,'Second window must not acquire a held cash lock');
  await first.executeJavaScript(`window.releaseCashLock();localStorage.setItem('zaipos-cash-contract',JSON.stringify({reference:'FLOAT-RUNTIME-001',amount:'1.001',state:'pending'}));true`);
  assert.equal(await second.executeJavaScript(`navigator.locks.request('zaipos-cash-contract',()=>localStorage.getItem('zaipos-cash-contract'))`),JSON.stringify({reference:'FLOAT-RUNTIME-001',amount:'1.001',state:'pending'}));
  await first.loadFile(html);
  assert.equal(await first.executeJavaScript(`JSON.parse(localStorage.getItem('zaipos-cash-contract')).reference`),'FLOAT-RUNTIME-001','Draft survives renderer reload');
  await first.executeJavaScript(`new Promise((resolve,reject)=>{navigator.locks.request('zaipos-cash-contract',async()=>{resolve(true);await new Promise(()=>{});}).catch(reject);})`);
  windows[0].destroy();
  assert.equal(await second.executeJavaScript(`navigator.locks.request('zaipos-cash-contract',()=>true)`),true,'Destroying the owning renderer releases the lock');
  console.log(JSON.stringify({result:'PASS',electron:process.versions.electron,chromium:process.versions.chrome,origin:'file:',checks:['exclusive cross-window lock','shared exact persisted draft','renderer reload recovery','destroyed renderer lock release']}));
  clearTimeout(watchdog);for(const win of windows)if(!win.isDestroyed())win.destroy();app.exit(0);
 }catch(error){console.error('FAIL: desktop cash recovery runtime',error);clearTimeout(watchdog);app.exit(1);}
}).catch(error=>{console.error(error);app.exit(1);});
