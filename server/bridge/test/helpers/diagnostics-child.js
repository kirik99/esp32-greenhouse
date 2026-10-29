const { EventEmitter } = require('node:events');
const Module = require('node:module');
class FakeMqtt extends EventEmitter {
  constructor() { super(); this.connected = true; this.published = []; }
  subscribe(topic, options, callback) { if (typeof options === 'function') options(null); else if (callback) callback(null); }
  publish(topic, message, options, callback) { this.published.push(topic); if (typeof options === 'function') options(null); else if (callback) callback(null); }
  end() { this.connected = false; }
}
const client = new FakeMqtt();
const originalLoad = Module._load;
Module._load = function(request, ...args) { return request === 'mqtt' ? { connect: () => client } : originalLoad.call(this, request, ...args); };
require('../../index');
Module._load = originalLoad;
setImmediate(() => client.emit('connect'));
process.on('message', input => {
  if (input.shutdown) return process.emit('SIGTERM');
  const before = client.published.length;
  client.emit('message', input.topic, Buffer.from(JSON.stringify(input.payload)), { retain: !!input.retain });
  process.send({ id: input.id, published: client.published.length - before });
});
