const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const express=require('express');
const {installFirmwareDownload}=require('../ota-download');
test('firmware download requires separate token and only serves bounded regular SHA-named files',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ota-download-test-'));
  const filename='a'.repeat(64)+'.bin';
  fs.writeFileSync(path.join(directory,filename),Buffer.alloc(2048,0xe9));
  fs.writeFileSync(path.join(directory,'b'.repeat(64)+'.bin'),Buffer.alloc(5));
  const app=express();installFirmwareDownload(app,{directory,token:'d'.repeat(32)});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}/api/ota/firmware/`;
  const headers={'X-OTA-Token':'d'.repeat(32)};
  try {
    assert.equal((await fetch(base+filename)).status,401);
    assert.equal((await fetch(base+filename,{headers:{'X-OTA-Token':'wrong'}})).status,401);
    assert.equal((await fetch(base+'secret.env',{headers})).status,400);
    assert.equal((await fetch(base+'b'.repeat(64)+'.bin',{headers})).status,404);
    const r=await fetch(base+filename,{headers});assert.equal(r.status,200);
    assert.equal(r.headers.get('content-length'),'2048');assert.equal(r.headers.get('cache-control'),'no-store');
    assert.equal((await r.arrayBuffer()).byteLength,2048);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(directory,{recursive:true,force:true});}
});
