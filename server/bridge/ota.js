const crypto = require('node:crypto');

const MODEL = 'hzad-s3-n16r8';
function canonical(m) {
  return `growbox-ota-v1\n${m.device_id}\n${m.model}\n${m.build}\n${m.size}\n${m.sha256}\n${m.expires}\n${m.url}\n`;
}
function validateManifest(m, now = Date.now()) {
  const keys = ['protocol','device_id','model','build','size','sha256','expires','url','signature'];
  if (!m || Array.isArray(m) || typeof m !== 'object' || Object.keys(m).length !== keys.length || Object.keys(m).some(k=>!keys.includes(k)) ||
      m.protocol !== 1 || m.model !== MODEL || !/^GrowboxESP32_[A-F0-9]{12}$/.test(m.device_id) ||
      !Number.isInteger(m.build) || m.build < 2 || m.build > 0xffffffff ||
      !Number.isInteger(m.size) || m.size < 1024 || m.size > 0x600000 ||
      typeof m.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.sha256) ||
      !Number.isInteger(m.expires) || m.expires <= now/1000 || m.expires > now/1000 + 86400 ||
      typeof m.url !== 'string' || m.url.length > 256 || !/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/[A-Za-z0-9._/:-]+$/.test(m.url) ||
      typeof m.signature !== 'string' || !/^[A-Za-z0-9+/]{342}==$/.test(m.signature)) throw new Error('Invalid or expired signed OTA manifest');
  const u = new URL(m.url);
  if (u.username || u.password || u.hash || u.search || !u.pathname.endsWith('/'+m.sha256+'.bin')) throw new Error('Expected firmware URL ending in SHA-256.bin');
  return m;
}
function verifyManifest(m, publicKey, now = Date.now()) {
  validateManifest(m, now);
  const key = crypto.createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength !== 2048 ||
      !crypto.verify('sha256', Buffer.from(canonical(m)), {key,padding:crypto.constants.RSA_PKCS1_PADDING}, Buffer.from(m.signature,'base64'))) throw new Error('Invalid firmware signature');
}

class OtaController {
  constructor({mqtt, climate, publicKey = '', now = Date.now}) {
    this.mqtt=mqtt; this.climate=climate; this.publicKey=publicKey; this.now=now;
    this.device=null; this.pending=null;
  }
  observe(status) {
    const o=status?.ota;
    if (!o || !/^GrowboxESP32_[A-F0-9]{12}$/.test(o.device_id) || o.model !== MODEL ||
        !Number.isInteger(o.build) || typeof o.enabled !== 'boolean' || typeof o.rollback !== 'boolean' ||
        typeof o.state !== 'string' || !Number.isInteger(o.slot_bytes) ||
        !Array.isArray(status.relays) || status.relays.length !== 6 || status.relays.some(x=>typeof x!=='boolean')) return;
    this.device={...o,relays:[...status.relays],received_at:this.now()};
    if (this.pending && o.device_id===this.pending.device_id && o.build===this.pending.build && o.state==='idle') this.pending=null;
  }
  getState() {
    return {configured:!!this.publicKey,mqtt_connected:!!this.mqtt.connected,
      device:this.device ? {...this.device,fresh:this.now()-this.device.received_at<30000}:null,
      pending:this.pending};
  }
  async start(manifest) {
    if (!this.publicKey) throw new Error('OTA signing public key is not configured');
    verifyManifest(manifest,this.publicKey,this.now());
    const d=this.device;
    if (!this.mqtt.connected || !d || this.now()-d.received_at>=30000) throw new Error('No fresh online ESP status');
    if (this.climate.mode!=='manual' || d.relays.some(Boolean)) throw new Error('Select manual mode and turn all relays OFF before OTA');
    if (!d.enabled || !d.rollback || !['idle','failed','rejected','not_idle'].includes(d.state)) throw new Error('ESP is not ready for safe OTA');
    if (manifest.device_id!==d.device_id || manifest.build<=d.build || manifest.size>d.slot_bytes) throw new Error('Firmware target/build/size does not match ESP');
    if (this.pending && this.now()-this.pending.sent_at<240000) throw new Error('An update has already been requested; wait for device status');
    this.pending={device_id:manifest.device_id,build:manifest.build,sent_at:this.now(),status:'requested'};
    try {
      // QoS0, non-retained: never replay an update after device/broker reconnect.
      await new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(new Error('MQTT delivery uncertain; inspect device status before retrying')),10000);
        try {
          this.mqtt.publish(`growbox/ota/${manifest.device_id}/set`,JSON.stringify(manifest),{qos:0,retain:false},err=>{
            clearTimeout(timeout);err?reject(err):resolve();
          });
        }catch(err){clearTimeout(timeout);reject(err);}
      });
    } catch (e) { this.pending.status='delivery_uncertain'; throw e; }
    return this.getState(); // Broker write is not installation confirmation.
  }
}
module.exports={MODEL,canonical,validateManifest,verifyManifest,OtaController};
