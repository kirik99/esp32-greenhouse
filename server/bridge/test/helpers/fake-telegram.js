/**
 * Fake Telegram Bot API server for the test suite.
 *
 * Speaks just enough of the HTTP Bot API for telegraf's long polling: getMe,
 * deleteWebhook, getUpdates, sendMessage, sendPhoto, sendChatAction,
 * editMessageText, editMessageReplyMarkup, answerCallbackQuery.
 *
 * Nothing leaves the machine: tests never talk to api.telegram.org.
 */

const http = require('http');

class FakeTelegram {
  constructor() {
    this.calls = [];
    this.updates = [];
    this.updateId = 1000;
    this.messageId = 500;
    this.failMethods = new Set(); // methods answering 500 to provoke errors
    this.server = http.createServer((req, res) => this.#handle(req, res));
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.apiRoot = `http://127.0.0.1:${this.server.address().port}`;
    return this.apiRoot;
  }

  async stop() {
    await new Promise((resolve) => this.server.close(resolve));
    this.server.closeAllConnections?.();
  }

  #handle(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const method = new URL(req.url, 'http://localhost').pathname.split('/').pop();
      const raw = Buffer.concat(chunks);
      let json = {};
      try { json = JSON.parse(raw.toString('utf8')); } catch { /* multipart body */ }
      const call = { method, json, raw: raw.toString('latin1') };
      this.calls.push(call);

      const respond = (ok, result, description) => {
        call.failed = !ok;
        res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ok ? { ok: true, result } : { ok: false, error_code: 500, description }));
      };

      if (this.failMethods.has(method)) return respond(false, null, `forced failure for ${method}`);

      if (method === 'getMe') return respond(true, this.getMeResult || { id: 42, is_bot: true, first_name: 'Growbox', username: 'growbox_test_bot' });
      if (method === 'getUpdates') {
        if (this.updates.length) {
          const batch = this.updates;
          this.updates = [];
          return respond(true, batch);
        }
        return setTimeout(() => respond(true, []), 50);
      }
      if (method === 'sendMessage' || method === 'sendPhoto') {
        return respond(true, { message_id: ++this.messageId, date: Math.floor(Date.now() / 1000), chat: { id: json.chat_id ?? 0 } });
      }
      return respond(true, true); // editMessageText, answerCallbackQuery, deleteWebhook, ...
    });
  }

  // -- helpers for tests ----------------------------------------------------
  sendCommand(text, chatId = 777) {
    this.updates.push({
      update_id: ++this.updateId,
      message: {
        message_id: this.updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private' },
        from: { id: chatId, is_bot: false, first_name: 'Tester' },
        text,
        entities: [{ type: 'bot_command', offset: 0, length: text.split(/\s+/)[0].length }]
      }
    });
  }

  pressButton(data, chatId = 777) {
    this.updates.push({
      update_id: ++this.updateId,
      callback_query: {
        id: `cb${this.updateId}`,
        chat_instance: 'test',
        from: { id: chatId, is_bot: false, first_name: 'Tester' },
        data,
        message: { message_id: 4242, date: 0, chat: { id: chatId, type: 'private' }, text: 'card', from: { id: 42, is_bot: true, first_name: 'Growbox' } }
      }
    });
  }

  /** Calls the API accepted (failed responses are excluded - they were never delivered). */
  delivered(method) { return this.calls.filter(c => c.method === method && !c.failed); }
  attempts(method) { return this.calls.filter(c => c.method === method); }

  messages() { return this.delivered('sendMessage'); }
  texts() { return this.messages().map(c => c.json.text || ''); }
  edits() { return this.delivered('editMessageText'); }
  markupEdits() { return this.delivered('editMessageReplyMarkup'); }
  answers() { return this.delivered('answerCallbackQuery'); }
  photos() { return this.delivered('sendPhoto'); }

  /** Captions of every sendPhoto call, extracted from the multipart body. */
  captions() {
    return this.photos().map((call) => {
      const part = call.raw.split(/name="caption"[^]*?\r\n\r\n/)[1];
      if (!part) return '';
      const value = part.split(/\r\n--/)[0];
      if (/%[0-9A-Fa-f]{2}/.test(value)) {
        try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch { return value; }
      }
      return Buffer.from(value, 'latin1').toString('utf8');
    });
  }

  reset() { this.calls = []; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { FakeTelegram, sleep };
