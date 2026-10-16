const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {MODEL,canonical,verifyManifest,OtaController}=require('../ota');
const {StubMqtt}=require('./helpers/stub-mqtt');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {sign}=require('../ota-sign');
const pair=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const publicKey=pair.publicKey.export({type:'spki',format:'pem'});
const now=1792140000000;
function manifest(patch={}) {
  const m={protocol:1,device_id:'GrowboxESP32_84C7BB7ADFB4',model:MODEL,build:2,size:4096,sha256:'a'.repeat(64),
    expires:now/1000+3600,url:'https://example.com/firmware/'+ 'a'.repeat(64) +'.bin',...patch};
  m.signature=crypto.sign('sha256',Buffer.from(canonical(m)),pair.privateKey).toString('base64');
  return m;
}
function fixture() {
  let clock=now;
  const mqtt=new StubMqtt(),climate={mode:'manual'};
  const controller=new OtaController({mqtt,climate,publicKey,now:()=>clock});
  const status={relays:Array(6).fill(false),ota:{device_id:'GrowboxESP32_84C7BB7ADFB4',model:MODEL,build:1,
    enabled:true,rollback:true,state:'idle',slot_bytes:0x600000}};
  controller.observe(status);
  return {controller,mqtt,climate,status,tick:n=>clock+=n};
}
test('OTA manifest binds target, version, expiry, URL and binary hash to RSA signature',()=>{
  const m=manifest();verifyManifest(m,publicKey,now);
  for(const patch of [{build:3},{device_id:'GrowboxESP32_000000000000'},{sha256:'b'.repeat(64)},{url:'https://other.example/app.bin'}]) {
    assert.throws(()=>verifyManifest({...m,...patch},publicKey,now));
  }
  for(const patch of [{expires:now/1000-1},{expires:now/1000+86401},{url:'http://example.com/a.bin'},
    {url:'https://user:pass@example.com/a.bin'},{url:'https://example.com/a.bin?token=secret'},{build:1},{size:999},{model:'other'}]) {
    assert.throws(()=>verifyManifest(manifest(patch),publicKey,now));
  }
});
test('OTA refuses missing config, stale device, auto mode, active relays, disabled rollback, wrong target and duplicates',async()=>{
  const f=fixture();
  f.controller.publicKey='';await assert.rejects(f.controller.start(manifest()));f.controller.publicKey=publicKey;
  f.climate.mode='fruiting';await assert.rejects(f.controller.start(manifest()));f.climate.mode='manual';
  f.status.relays[1]=true;f.controller.observe(f.status);await assert.rejects(f.controller.start(manifest()));
  f.status.relays[1]=false;f.status.ota.rollback=false;f.controller.observe(f.status);await assert.rejects(f.controller.start(manifest()));
  f.status.ota.rollback=true;f.controller.observe(f.status);
  await assert.rejects(f.controller.start(manifest({device_id:'GrowboxESP32_000000000000'})));
  await assert.rejects(f.controller.start(manifest({size:0x600001})));
  f.tick(31000);await assert.rejects(f.controller.start(manifest()));f.controller.observe(f.status);
  assert.equal(f.mqtt.publishes.length,0);
  const state=await f.controller.start(manifest());
  assert.equal(state.pending.status,'requested');
  assert.deepEqual(f.mqtt.publishes[0].options,{qos:0,retain:false});
  assert.equal(f.mqtt.publishes[0].topic,'growbox/ota/GrowboxESP32_84C7BB7ADFB4/set');
  await assert.rejects(f.controller.start(manifest()));
  f.status.ota.build=2;f.controller.observe(f.status);assert.equal(f.controller.getState().pending,null);
});
test('offline signer binds manifest build to embedded firmware identity',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ota-sign-test-'));
  try {
    const binary=path.join(dir,'app.bin'),key=path.join(dir,'private.pem');
    const data=Buffer.alloc(4096);data[0]=0xe9;data.write('GROWBOX_OTA_V1:hzad-s3-n16r8:2:',256);
    fs.writeFileSync(binary,data);fs.writeFileSync(key,pair.privateKey.export({type:'pkcs8',format:'pem'}));
    const hash=crypto.createHash('sha256').update(data).digest('hex');
    const input={binary,key,device:'GrowboxESP32_84C7BB7ADFB4',url:'https://example.com/firmware/'+hash+'.bin',build:2,expires:Math.floor(Date.now()/1000)+3600};
    const m=sign(input);verifyManifest(m,publicKey);
    assert.throws(()=>sign({...input,build:3}),/embedded/);
    data[0]=0xff;fs.writeFileSync(binary,data);assert.throws(()=>sign(input),/application/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('failed MQTT delivery remains uncertain and cannot be immediately replayed',async()=>{
  const f=fixture();
  f.mqtt.connected=false;await assert.rejects(f.controller.start(manifest()));
  f.mqtt.connected=true;f.mqtt.publish=()=>{throw new Error('connection lost')};
  await assert.rejects(f.controller.start(manifest()),/connection lost/);
  assert.equal(f.controller.getState().pending.status,'delivery_uncertain');
  await assert.rejects(f.controller.start(manifest()),/already/);
});
