const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const express=require('express');
function installFirmwareDownload(app,{directory,token=''}) {
  app.get('/api/ota/firmware/:filename',(req,res)=>{
    if(!directory || token.length<32)return res.status(503).json({error:'Firmware hosting disabled'});
    const actual=Buffer.from(req.get('X-OTA-Token')||''),expected=Buffer.from(token);
    if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected))return res.status(401).json({error:'Unauthorized'});
    if(!/^[a-f0-9]{64}\.bin$/.test(req.params.filename))return res.status(400).json({error:'Expected SHA-256.bin filename'});
    const file=path.resolve(directory,req.params.filename);
    try {
      const stat=fs.lstatSync(file);
      if(!stat.isFile() || stat.size<1024 || stat.size>0x600000)return res.status(404).end();
    }catch(_){return res.status(404).end();}
    res.set('Cache-Control','no-store');
    res.type('application/octet-stream').sendFile(file);
  });

  const raw = express.raw({ type: 'application/octet-stream', limit: 0x600000 });
  app.post('/api/ota/upload-firmware', (req, res, next) => {
    if (!directory) return res.status(503).json({ error: 'Firmware hosting disabled' });
    next();
  }, raw, (req, res) => {
    const data = req.body;
    if (!Buffer.isBuffer(data) || data.length < 1024 || data.length > 0x600000 || data[0] !== 0xe9) {
      return res.status(400).json({ error: 'Expected valid ESP application .bin' });
    }
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const filename = `${sha256}.bin`;
    const targetPath = path.resolve(directory, filename);
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(targetPath, data);
      return res.status(201).json({ filename, sha256, size: data.length });
    } catch (err) {
      return res.status(500).json({ error: 'Could not save firmware file: ' + err.message });
    }
  });
}
module.exports={installFirmwareDownload};
