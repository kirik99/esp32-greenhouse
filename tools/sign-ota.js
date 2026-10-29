// Offline signer. Never upload the private key or a secret-bearing build to GitHub.
const {sign}=require('../server/bridge/ota-sign');
if(require.main===module){
  try {
    const [binary,key,device,url,build,expires]=process.argv.slice(2);
    if(!expires)throw new Error('Usage: node tools/sign-ota.js app.bin private.pem GrowboxESP32_MAC https://host/firmware/app.bin BUILD EXPIRES_UNIX');
    process.stdout.write(JSON.stringify(sign({binary,key,device,url,build,expires}),null,2)+'\n');
  }catch(e){console.error(e.message);process.exitCode=1;}
}
module.exports={sign};
