const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
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
}
module.exports={installFirmwareDownload};
