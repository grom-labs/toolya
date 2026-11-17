import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {setImmediate as tick} from 'node:timers/promises';
import vm from 'node:vm';

// Exercise the real module with browser and ADB doubles. Never opens USB or a shell.
// Use the installed compiler CLI, supported by TypeScript 7 as well as its
// native packages. No unstable compiler API or newer Node type stripping needed.
const temporary=await mkdtemp(path.join(tmpdir(),'toolya-stream-tests-'));
let javascript;
try {
  execFileSync(process.execPath,[
    fileURLToPath(new URL('../node_modules/typescript/bin/tsc',import.meta.url)),
    '--ignoreConfig','--noCheck','--target','ES2022','--module','ESNext','--outDir',temporary,
    fileURLToPath(new URL('../src/stream.ts',import.meta.url)),
  ],{windowsHide:true});
  javascript=await readFile(path.join(temporary,'stream.js'),'utf8');
} finally {
  const parent=await realpath(tmpdir()),target=await realpath(temporary);
  assert.ok(target.startsWith(parent+path.sep),'Temporary directory escaped the system temp folder');
  await rm(target,{recursive:true,force:true});
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

function processDouble({killReject=false,cancelReject=false}={}){
  const counts={kills:0,cancels:0,releases:0,reads:0};
  let controller;
  const stream=new ReadableStream({start(value){controller=value;}});
  const proc={
    kill(){counts.kills++;if(killReject)return Promise.reject(new Error('kill failed'));},
    output:{getReader(){
      const reader=stream.getReader();
      return {
        read(){counts.reads++;return reader.read();},
        cancel(){counts.cancels++;const result=reader.cancel();return cancelReject?result.then(()=>{throw new Error('cancel failed');}):result;},
        releaseLock(){counts.releases++;reader.releaseLock();},
      };
    }},
  };
  return {proc,counts,controller};
}

async function start({spawn,raw=false,run,pull,decode}={}){
  const counts={draws:0,pulls:0,triggers:0,status:0};
  const errors=[];
  const canvasContext={drawImage(){counts.draws++;},createImageData:()=>({data:new Uint8Array(16)}),putImageData(){}};
  const context=vm.createContext({
    Uint8Array,Uint32Array,performance,Blob,console,
    setTimeout:(fn)=>{queueMicrotask(fn);return 1;},
    document:{createElement:()=>({getContext:()=>canvasContext})},
    createImageBitmap:decode??(async()=>({close(){}})),
    fetch:async()=>{throw new Error('No binary download in tests');},
  });
  const mocks={
    './adb':{
      run:async(_adb,cmd)=>{
        if(cmd.includes('--version'))return raw?'MISSING':'fb_stream test';
        counts.triggers++;return run?run(cmd):'';
      },
      pullFile:async()=>{counts.pulls++;return pull?pull():new Uint8Array(16);},
      pushFile:async()=>{throw new Error('No device writes in tests');},
    },
    './image':{SCREEN_W:2,SCREEN_H:2},
    './wasm':{getContract:async()=>({screen:{grab_trigger:'MOCK_TRIGGER'},files:{screencap:'MOCK_CAPTURE'}})},
  };
  const module=new vm.SourceTextModule(javascript,{context});
  await module.link(async name=>{
    assert.ok(mocks[name],'Unexpected dependency: '+name);
    return new vm.SyntheticModule(Object.keys(mocks[name]),function(){
      for(const [key,value] of Object.entries(mocks[name]))this.setExport(key,value);
    },{context});
  });
  await module.evaluate();
  const handle=await module.namespace.startStream(
    {subprocess:{noneProtocol:{spawn:spawn??(()=>{throw new Error('Unexpected spawn');})}}},
    {width:2,height:2,getContext:()=>canvasContext},()=>counts.status++,e=>errors.push(e),
  );
  return {handle,counts,errors};
}

test('MJPEG EOF makes the handle inactive and releases resources',async t=>{
  const p=processDouble();p.controller.close();
  const s=await start({spawn:async()=>p.proc});t.after(()=>s.handle.stop());
  await tick();
  assert.equal(s.handle.active,false);
  assert.equal(p.counts.kills,1);assert.equal(p.counts.releases,1);
  assert.equal(s.errors.length,0);
});

test('Stop before spawn settles kills the late process exactly once',async()=>{
  const pending=deferred(),p=processDouble();
  const s=await start({spawn:()=>pending.promise});
  s.handle.stop();s.handle.stop();pending.resolve(p.proc);await tick();
  assert.equal(s.handle.active,false);assert.equal(p.counts.kills,1);
  assert.equal(p.counts.reads,0);assert.equal(s.errors.length,0);
});

test('Stop cancels a pending read and releases its reader',async()=>{
  const p=processDouble(),s=await start({spawn:async()=>p.proc});
  await tick();assert.equal(p.counts.reads,1);
  s.handle.stop();s.handle.stop();await tick();
  assert.equal(p.counts.kills,1);assert.equal(p.counts.cancels,1);
  assert.equal(p.counts.releases,1);assert.equal(s.errors.length,0);
});

test('a read failure closes resources and reports one error',async t=>{
  const p=processDouble(),s=await start({spawn:async()=>p.proc});t.after(()=>s.handle.stop());
  p.controller.error(new Error('read failed'));await tick();
  assert.equal(s.handle.active,false);assert.equal(p.counts.kills,1);
  assert.equal(p.counts.releases,1);assert.equal(s.errors.length,1);
});

test('a spawn failure becomes inactive and reports one error',async t=>{
  const s=await start({spawn:async()=>{throw new Error('spawn failed');}});t.after(()=>s.handle.stop());
  await tick();assert.equal(s.handle.active,false);assert.equal(s.errors.length,1);
});

test('Stop observes rejected kill and cancel promises',async()=>{
  const p=processDouble({killReject:true,cancelReject:true}),s=await start({spawn:async()=>p.proc});
  await tick();s.handle.stop();await tick();await tick();
  assert.equal(s.handle.active,false);assert.equal(p.counts.kills,1);
  assert.equal(p.counts.releases,1);assert.equal(s.errors.length,0);
});

test('Stop during bitmap decoding closes the bitmap without drawing',async()=>{
  const p=processDouble(),decoding=deferred();let closed=0;
  const s=await start({spawn:async()=>p.proc,decode:()=>decoding.promise});
  p.controller.enqueue(new Uint8Array([1,0,0,0,42]));await tick();
  s.handle.stop();decoding.resolve({close(){closed++;}});await tick();
  assert.equal(closed,1);assert.equal(s.counts.draws,0);assert.equal(s.counts.status,0);
  assert.equal(p.counts.kills,1);assert.equal(p.counts.releases,1);
});

test('raw Stop during capture trigger prevents a later pull',async()=>{
  const pending=deferred(),s=await start({raw:true,run:()=>pending.promise});
  s.handle.stop();pending.resolve('');await tick();
  assert.equal(s.counts.triggers,1);assert.equal(s.counts.pulls,0);
  assert.equal(s.counts.draws,0);assert.equal(s.errors.length,0);
});

test('raw Stop during pull prevents drawing the returned frame',async()=>{
  const pending=deferred(),s=await start({raw:true,pull:()=>pending.promise});
  await tick();assert.equal(s.counts.pulls,1);
  s.handle.stop();pending.resolve(new Uint8Array(16));await tick();
  assert.equal(s.counts.draws,0);assert.equal(s.counts.triggers,1);
  assert.equal(s.errors.length,0);
});

test('a new session can run after another session has stopped',async()=>{
  const p1=processDouble(),s1=await start({spawn:async()=>p1.proc});
  await tick();s1.handle.stop();await tick();
  const p2=processDouble(),s2=await start({spawn:async()=>p2.proc});
  await tick();assert.equal(s2.handle.active,true);assert.equal(p2.counts.kills,0);
  s2.handle.stop();await tick();assert.equal(p1.counts.kills,1);assert.equal(p2.counts.kills,1);
});
