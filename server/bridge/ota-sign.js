// Offline-only helper. No HTTP route calls this; private keys stay off the server.
const fs=require('node:fs');
const crypto=require('node:crypto');
const {MODEL,canonical,verifyManifest}=require('./ota');
function sign({binary,key,device,url,build,expires}) {
  const data=fs.readFileSync(binary);
  if(data[0]!==0xe9)throw new Error('Expected an ESP application .bin (not a merged flash image)');
  const identities=[...new Set(data.toString('latin1').match(/GROWBOX_OTA_V1:hzad-s3-n16r8:[0-9]+:/g)||[])];
  if(identities.length!==1||identities[0]!==`GROWBOX_OTA_V1:hzad-s3-n16r8:${Number(build)}:`)throw new Error('Application embedded model/build does not match requested release');
  const privateKey=crypto.createPrivateKey(fs.readFileSync(key));
  if(privateKey.asymmetricKeyType!=='rsa'||privateKey.asymmetricKeyDetails.modulusLength!==2048)throw new Error('RSA-2048 key required');
  const m={protocol:1,device_id:device,model:MODEL,build:Number(build),size:data.length,
    sha256:crypto.createHash('sha256').update(data).digest('hex'),expires:Number(expires),url};
  m.signature=crypto.sign('sha256',Buffer.from(canonical(m)),{key:privateKey,padding:crypto.constants.RSA_PKCS1_PADDING}).toString('base64');
  verifyManifest(m,crypto.createPublicKey(privateKey).export({type:'spki',format:'pem'}));
  return m;
}
module.exports={sign};
