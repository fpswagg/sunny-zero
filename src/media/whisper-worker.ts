/**
 * Child process that runs Whisper for WorkerTranscriber (transcribe.ts). Keeping the model out of the
 * daemon matters: it peaks around 1.3 GB, above pm2's max_memory_restart for `sunny`, which used to
 * restart the daemon in the middle of every voice message.
 *
 * Protocol (IPC): parent sends { type: 'init', options } once, then { id, file }; the worker answers
 * { id, ok: true, transcript } or { id, ok: false, error }.
 */
import { Transcriber, type TranscribeHints, type TranscriberOptions } from './transcribe.ts';

let transcriber: Transcriber | undefined;

process.on('message', (msg: { type?: 'init'; options?: TranscriberOptions; id?: number; file?: string; hints?: TranscribeHints }) => {
  if (msg.type === 'init' && msg.options) {
    // The parent kills this process when idle, so the model never needs unloading here.
    transcriber = new Transcriber({ ...msg.options, idleMs: 24 * 3600_000 });
    return;
  }
  const { id, file } = msg;
  if (id === undefined || !file) return;
  if (!transcriber) {
    process.send?.({ id, ok: false, error: 'worker not initialised' });
    return;
  }
  transcriber.transcribe(file, msg.hints).then(
    (transcript) => process.send?.({ id, ok: true, transcript }),
    (err: unknown) => process.send?.({ id, ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
});

// Exit with the parent instead of lingering.
process.on('disconnect', () => process.exit(0));
