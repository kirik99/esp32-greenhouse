const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('node:child_process');
const jpeg = require('jpeg-js');
const { FakeTelegram, sleep } = require('./helpers/fake-telegram');

test('real bridge entrypoint connects HTTPS archive events to Telegram and preserves manual mode', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'growbox-http-bot-'));
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({mode: 'manual', profiles: {}}));
  const cameraFile = path.join(dir, 'camera_settings.json');
  fs.writeFileSync(cameraFile, JSON.stringify({reception_enabled:true,auto_enabled:false,interval_seconds:600,request_id:'11111111-1111-1111-1111-111111111111'}));
  const tg = new FakeTelegram();
  await tg.start();
  const token = 'offline-image-upload-token-for-tests';
  const child = spawn(process.execPath, [path.join('test', 'helpers', 'bridge-child.js')], {
    cwd: path.join(__dirname, '..'),
    env: {...process.env, MQTT_HOST:'127.0.0.1', MQTT_PORT:'1', INFLUXDB_URL:'http://127.0.0.1:1',
      BRIDGE_PORT:'0', IMAGES_DIR:path.join(dir,'images'), CLIMATE_STATE_FILE:stateFile, CAMERA_SETTINGS_FILE:cameraFile,
      IMAGE_UPLOAD_TOKEN:token, TELEGRAM_BOT_TOKEN:'1:TEST-TOKEN', TELEGRAM_CHAT_ID:'777',
      TELEGRAM_API_ROOT:tg.apiRoot, TELEGRAM_AUTO_PHOTO:'on', EMIT_SIGNAL:'none'}
  });
  let output = '';
  child.stdout.on('data', d=>{output+=d});
  child.stderr.on('data', d=>{output+=d});
  const exited = new Promise(resolve=>child.once('exit',resolve));
  async function waitFor(check) {
    const end = Date.now()+10000;
    while(!check()) { if(Date.now()>end)throw Error('Bridge readiness timeout: '+output); await sleep(30); }
  }
  try {
    await waitFor(()=>/listening on port (\d+)/.test(output) && /Bot started/.test(output));
    const base='http://127.0.0.1:'+output.match(/listening on port (\d+)/)[1];
    const image=jpeg.encode({data:Buffer.from([40,60,80,255]),width:1,height:1},85).data;
    const response=await fetch(base+'/api/upload-image',{method:'POST',
      headers:{'Content-Type':'image/jpeg','X-Upload-Token':token},body:image});
    assert.equal(response.status,201);
    const saved=await response.json();
    await waitFor(()=>tg.photos().length===1);
    assert.match(tg.captions()[0], /Ручной/);
    const meta=JSON.parse(fs.readFileSync(path.join(dir,'images',saved.filename+'.json')));
    assert.equal(meta.mode,'manual');
    assert.equal(meta.transport,'https');
    assert.deepEqual(fs.readFileSync(path.join(dir,'images',saved.filename)),image);
    assert.equal((await fetch(base+'/health').then(r=>r.json())).climate_mode,'manual');
    const rejected=await fetch(base+'/api/upload-image',{method:'POST',
      headers:{'Content-Type':'image/jpeg','X-Upload-Token':'wrong'},body:image});
    assert.equal(rejected.status,401);
    await sleep(100);
    assert.equal(tg.photos().length,1);
  } finally {
    child.stdin.write('shutdown\n');
    let timer;
    await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>{child.kill();resolve()},6000)})]);
    clearTimeout(timer);
    await tg.stop();
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
