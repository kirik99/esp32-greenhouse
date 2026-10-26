const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {spawn}=require('node:child_process');
const jpeg=require('jpeg-js');
const {sleep}=require('./helpers/fake-telegram');

test('camera API requires PIN and enforces persistent reception pause',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'growbox-camera-api-'));
 const state=path.join(dir,'climate.json');
 const camera=path.join(dir,'camera_settings.json');
 fs.writeFileSync(state,JSON.stringify({mode:'manual',profiles:{}}));
 const child=spawn(process.execPath,['test/helpers/bridge-child.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,
   MQTT_HOST:'127.0.0.1',MQTT_PORT:'1',INFLUXDB_URL:'http://127.0.0.1:1',TELEGRAM_BOT_TOKEN:'',
   BRIDGE_PORT:'0',IMAGES_DIR:path.join(dir,'images'),CLIMATE_STATE_FILE:state,CAMERA_SETTINGS_FILE:camera,
   IMAGE_UPLOAD_TOKEN:'offline-camera-api-upload-token-32',ADMIN_PIN:'test-pin',PUBLIC_TELEMETRY:'false',EMIT_SIGNAL:'none'}});
 let output='';child.stdout.on('data',d=>{output+=d});child.stderr.on('data',d=>{output+=d});
 const exited=new Promise(resolve=>child.once('exit',resolve));
 try {
   const end=Date.now()+10000;
   while(!/listening on port (\d+)/.test(output)){if(Date.now()>end)throw Error('Boot timeout');await sleep(30)}
   const base='http://127.0.0.1:'+output.match(/listening on port (\d+)/)[1];
   assert.equal((await fetch(base+'/api/camera/settings')).status,401);
   assert.equal((await fetch(base+'/api/photo-exports/config')).status,401);
   assert.equal((await fetch(base+'/api/photo-exports/preview?all=1')).status,401);
   assert.equal((await fetch(base+'/api/photo-exports',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"all":true}'})).status,401);
   assert.equal((await fetch(base+'/api/ota/status')).status,401);
   assert.equal((await fetch(base+'/api/ota/start',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
   const input={reception_enabled:true,auto_enabled:false,interval_seconds:600};
   assert.equal((await fetch(base+'/api/camera/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})).status,401);
   const auth=await fetch(base+'/api/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:'test-pin'})}).then(r=>r.json());
   assert.equal(auth.success,true);
   const headers={'Content-Type':'application/json',Authorization:'Bearer '+auth.token};
   assert.equal((await fetch(base+'/api/ota/status',{headers}).then(r=>r.json())).configured,false);
   assert.equal((await fetch(base+'/api/ota/start',{method:'POST',headers,body:'{}'})).status,409);
   const initial=await fetch(base+'/api/camera/settings',{headers}).then(r=>r.json());
   assert.equal(initial.settings.reception_enabled,false);
   assert.equal((await fetch(base+'/api/capture',{method:'POST',headers})).status,409);
   const image=jpeg.encode({data:Buffer.from([40,60,80,255]),width:1,height:1},85).data;
   const upload=()=>fetch(base+'/api/upload-image',{method:'POST',headers:{'Content-Type':'image/jpeg','X-Upload-Token':'offline-camera-api-upload-token-32'},body:image});
   assert.equal((await upload()).status,503);
   const invalid=await fetch(base+'/api/camera/settings',{method:'PUT',headers,body:JSON.stringify({...input,interval_seconds:0})});
   assert.equal(invalid.status,400);assert.equal(fs.existsSync(camera),false);
   const ok=await fetch(base+'/api/camera/settings',{method:'PUT',headers,body:JSON.stringify(input)});
   assert.equal(ok.status,200);
   const accepted=await ok.json();assert.equal(accepted.device,null);assert.equal(accepted.mqtt_connected,false);
   assert.equal((await upload()).status,201);
   const files=fs.readdirSync(path.join(dir,'images'));
   const exportInfo=await fetch(base+'/api/photo-exports/preview?all=1',{headers}).then(r=>r.json());
   assert.equal(exportInfo.count,1);
   const ticketResponse=await fetch(base+'/api/photo-exports',{method:'POST',headers,body:'{"all":true}'});
   assert.equal(ticketResponse.status,201);
   const ticket=await ticketResponse.json();
   const zip=await fetch(base+ticket.download_url);
   assert.equal(zip.status,200);
   assert.equal(zip.headers.get('content-type'),'application/zip');
   assert.equal(Buffer.from(await zip.arrayBuffer()).readUInt32LE(0),0x04034b50);
   const off=await fetch(base+'/api/camera/settings',{method:'PUT',headers,body:JSON.stringify({...input,reception_enabled:false})});
   assert.equal(off.status,200);assert.equal((await upload()).status,503);
   assert.deepEqual(fs.readdirSync(path.join(dir,'images')),files);
   assert.equal((await fetch(base+'/health').then(r=>r.json())).climate_mode,'manual');
   assert.equal(JSON.parse(fs.readFileSync(camera)).reception_enabled,false);
 } finally {
   child.stdin.write('shutdown\n');let timer;
   await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>{child.kill();resolve()},6000)})]);
   clearTimeout(timer);fs.rmSync(dir,{recursive:true,force:true});
 }
});
