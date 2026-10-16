/**
 * In-memory MQTT client stub: records every publish so tests can assert that a
 * forbidden relay command was never sent to the broker.
 */

class StubMqtt {
  constructor({ connected = true } = {}) {
    this.connected = connected;
    this.publishes = []; // [{ topic, payload }]
    this.handlers = {};
  }

  publish(topic, payload, options, callback) {
    if (!this.connected) throw new Error('MQTT client is not connected');
    const record = { topic, payload: String(payload) };
    if (options && typeof options === 'object') record.options = options;
    this.publishes.push(record);
    if (typeof options === 'function') options(null);
    else if (typeof callback === 'function') callback(null);
    return true;
  }

  end() { this.connected = false; }

  topic(name) { return this.publishes.filter(p => p.topic === name); }

  /** Decoded growbox/relay/set commands in order. */
  relayCommands() {
    return this.topic('growbox/relay/set').map(p => JSON.parse(p.payload));
  }

  clear() { this.publishes = []; }
}

module.exports = { StubMqtt };
