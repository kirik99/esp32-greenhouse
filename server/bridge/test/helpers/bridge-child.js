/**
 * Child process used by the tests: boots the *real* bridge entrypoint (index.js).
 *
 * EMIT_SIGNAL: SIGINT | SIGTERM | none
 *   - SIGINT/SIGTERM: the child emits that signal in-process after EMIT_AFTER_MS,
 *     which also works on Windows (a real OS-signal case is covered on Linux/CI).
 *   - none: the child stays up until the parent writes "shutdown" to its stdin.
 */

require('../../index.js');

const signal = process.env.EMIT_SIGNAL || 'SIGTERM';

if (signal !== 'none') {
  const delay = Number(process.env.EMIT_AFTER_MS || 1200);
  setTimeout(() => {
    console.log(`[test-child] emitting ${signal}`);
    process.emit(signal);
  }, delay);
} else {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (String(chunk).includes('shutdown')) {
      console.log('[test-child] shutdown requested over stdin');
      process.emit('SIGTERM');
    }
  });
}
