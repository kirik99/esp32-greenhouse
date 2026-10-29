const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CameraSettings, SET_TOPIC } = require('../camera-settings');
const { StubMqtt } = require('./helpers/stub-mqtt');

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'camera-settings-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const mqtt=new StubMqtt();
  const stateFile=path.join(dir,'camera_settings.json');
  let now=1000;
  const controller=new CameraSettings({mqttClient:mqtt,stateFile,now:()=>now,logger:{error:()=>{}}});
  return {controller,mqtt,stateFile,advance:n=>{now+=n}};
}
const enabled={reception_enabled:true,auto_enabled:true,interval_seconds:600};

test('camera policy defaults off and validates all fields before writing/publishing', t=>{
  const {controller:c,mqtt,stateFile}=fixture(t);
  assert.equal(c.acceptsPhotos(),false);
  assert.equal(c.getState().settings.auto_enabled,false);
  assert.equal(c.getState().settings.interval_seconds,3600);
  for(const invalid of [null,[],{}, {...enabled,interval_seconds:0},{...enabled,interval_seconds:90},
    {...enabled,interval_seconds:86460},{...enabled,interval_seconds:'600'},
    {...enabled,auto_enabled:'false'},{...enabled,reception_enabled:false},{...enabled,request_id:'spoof'}]){
    assert.throws(()=>c.update(invalid));
  }
  assert.equal(fs.existsSync(stateFile),false);
  assert.equal(mqtt.topic(SET_TOPIC).length,0);
});

test('camera settings persist, retained config is sent and matching fresh NVS ack is required', t=>{
  const {controller:c,mqtt,stateFile,advance}=fixture(t);
  c.update(enabled);
  assert.equal(c.acceptsPhotos(),true);
  const saved=JSON.parse(fs.readFileSync(stateFile));
  const publication=mqtt.topic(SET_TOPIC)[0];
  assert.equal(publication.options.retain,true);
  assert.equal(publication.options.qos,1);
  assert.equal(JSON.parse(publication.payload).request_id,saved.request_id);
  const restored=new CameraSettings({mqttClient:mqtt,stateFile});
  assert.deepEqual(restored.getState().settings,saved);
  const ack={protocol:1,request_id:saved.request_id,auto_enabled:true,interval_seconds:600,
    camera_ready:true,persisted:true,device_id:'test-ESP'};
  assert.equal(c.observeState({...ack,request_id:'22222222-2222-2222-2222-222222222222'}),true);
  assert.equal(c.getState().device.confirmed,false);
  c.observeState({...ack,persisted:false});
  assert.equal(c.getState().device.confirmed,false);
  c.observeState(ack);
  assert.equal(c.getState().device.confirmed,true);
  advance(120001);
  assert.equal(c.getState().device.confirmed,false);
  c.update({...enabled,auto_enabled:false});
  assert.notEqual(c.getState().settings.request_id,saved.request_id);
  assert.equal(c.getState().device.confirmed,false);
});

test('offline change is persisted but not queued; reconnect publishes latest desired state', t=>{
  const {controller:c,mqtt}=fixture(t);
  mqtt.connected=false;
  c.update(enabled);
  c.update({...enabled,auto_enabled:false});
  assert.equal(mqtt.topic(SET_TOPIC).length,0);
  mqtt.connected=true;
  c.publish();
  assert.equal(JSON.parse(mqtt.topic(SET_TOPIC)[0].payload).auto_enabled,false);
  c.observeStatus({relays:[]});
  assert.equal(c.getState().device.supported,false);
  assert.equal(c.observeState({protocol:1}),false);
});

test('corrupt state and failed persistence cannot silently enable reception', t=>{
  const {controller:c,mqtt,stateFile}=fixture(t);
  fs.mkdirSync(stateFile); // A directory in place of the file makes atomic replacement fail.
  assert.throws(()=>c.update(enabled));
  assert.equal(c.acceptsPhotos(),false);
  assert.equal(mqtt.topic(SET_TOPIC).length,0);
  fs.rmdirSync(stateFile);
  fs.writeFileSync(stateFile,'{"auto_enabled":true');
  const broken=new CameraSettings({mqttClient:mqtt,stateFile,logger:{error:()=>{}}});
  assert.equal(broken.acceptsPhotos(),false);
  assert.equal(broken.getState().load_error,true);
});
