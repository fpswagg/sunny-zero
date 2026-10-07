// Voice engine of the agent app: microphone capture at 16 kHz, speech detection, WAV encoding,
// and the speaker that reads replies sentence by sentence while they stream in.
'use strict';

(() => {
  const RATE = 16000;
  const FRAME = 320; // 20 ms at 16 kHz
  const FRAME_MS = 20;

  /** The microphone: clean mono frames of 20 ms at 16 kHz, whatever the device rate. */
  class Mic {
    constructor(ctx, base) {
      this.ctx = ctx;
      this.base = base;
      this.onFrame = () => {};
      this.carry = new Float32Array(0);
      this.pos = 0;
      this.out = new Float32Array(FRAME);
      this.outN = 0;
      this.lastFrame = 0; // performance.now() of the last frame: lets the call notice a dead microphone
      this.onLost = () => {};
    }

    /** True while the browser is still handing us audio. */
    get alive() {
      const t = this.stream?.getAudioTracks?.()[0];
      return !!t && t.readyState === 'live' && !t.muted;
    }

    async start() {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      const ctx = this.ctx;
      // The phone took the microphone (a call, Siri, another app) or it was unplugged.
      this.stream.getAudioTracks().forEach((t) => {
        t.onended = () => this.onLost('ended');
        t.onmute = () => this.onLost('muted');
        t.onunmute = () => this.onLost('unmuted');
      });
      this.lastFrame = performance.now();
      this.source = ctx.createMediaStreamSource(this.stream);
      this.sink = ctx.createGain();
      this.sink.gain.value = 0;
      this.sink.connect(ctx.destination);
      this.ratio = ctx.sampleRate / RATE;
      try {
        await ctx.audioWorklet.addModule(`${this.base}/capture-worklet.js`);
        this.node = new AudioWorkletNode(ctx, 'capture');
        this.node.port.onmessage = (e) => this.push(e.data);
      } catch {
        // Older browsers: the deprecated processor still works everywhere.
        this.node = ctx.createScriptProcessor(2048, 1, 1);
        this.node.onaudioprocess = (e) => this.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      }
      this.source.connect(this.node);
      this.node.connect(this.sink);
    }

    /** Resamples to 16 kHz (box filter: average the input samples each output sample covers). */
    push(input) {
      const data = new Float32Array(this.carry.length + input.length);
      data.set(this.carry);
      data.set(input, this.carry.length);
      const r = this.ratio;
      let p = this.pos;
      while (p + r <= data.length) {
        const a = Math.floor(p);
        const b = Math.max(a + 1, Math.floor(p + r));
        let sum = 0;
        for (let i = a; i < b; i++) sum += data[i];
        this.out[this.outN++] = sum / (b - a);
        if (this.outN === FRAME) {
          const frame = this.out;
          this.out = new Float32Array(FRAME);
          this.outN = 0;
          let e = 0;
          for (let i = 0; i < FRAME; i++) e += frame[i] * frame[i];
          this.lastFrame = performance.now();
          this.onFrame(frame, Math.sqrt(e / FRAME));
        }
        p += r;
      }
      const keep = Math.floor(p);
      this.carry = data.slice(keep);
      this.pos = p - keep;
    }

    stop() {
      this.stream?.getAudioTracks().forEach((t) => {
        t.onended = t.onmute = t.onunmute = null;
      });
      try {
        this.source?.disconnect();
        this.node?.disconnect();
        this.sink?.disconnect();
      } catch {}
      this.stream?.getTracks().forEach((t) => t.stop());
    }
  }

  /**
   * Turns microphone frames into utterances. Two ways:
   * - "auto": detects speech (adaptive noise floor), keeps half a second from before it started,
   *   and ends after a pause;
   * - "hold": records between press() and release() (push to talk).
   */
  class Listener {
    constructor(opts = {}) {
      this.mode = 'off'; // off | auto | hold
      this.endMs = opts.endMs ?? 1100;
      this.onStart = opts.onStart ?? (() => {});
      this.onEnd = opts.onEnd ?? (() => {});
      this.onDiscard = opts.onDiscard ?? (() => {});
      this.onLevel = opts.onLevel ?? (() => {});
      this.onBargeIn = opts.onBargeIn ?? (() => {});
      this.bargeIn = false; // listen for the user talking over the agent
      this.pre = []; // last frames before speech
      this.preMax = 25; // 500 ms
      this.noise = 0.004;
      this.calibrated = 0;
      this.reset();
    }

    reset() {
      this.capturing = false;
      this.frames = [];
      this.hot = 0;
      this.voiced = 0;
      this.silent = 0;
      this.releasing = 0;
      this.loudRun = 0;
    }

    setMode(mode) {
      this.mode = mode;
      this.reset();
    }

    get thresholds() {
      const start = Math.max(0.011, this.noise * 3);
      return { start, keep: Math.max(0.008, this.noise * 2) };
    }

    feed(frame, rms) {
      this.onLevel(rms);
      this.pre.push(frame);
      if (this.pre.length > this.preMax) this.pre.shift();
      const { start, keep } = this.thresholds;

      // Learn the room: the noise floor follows quiet frames quickly and loud ones very slowly.
      if (!this.capturing) {
        const rate = this.calibrated < 25 ? 0.2 : rms < start ? 0.04 : 0.002;
        this.noise = Math.min(0.02, this.noise * (1 - rate) + rms * rate);
        this.calibrated++;
      }

      if (this.mode === 'speaking') {
        // The agent talks: only a clear, sustained voice (well above the echo) interrupts it.
        if (!this.bargeIn) return;
        this.loudRun = rms > Math.max(0.05, this.noise * 7) ? this.loudRun + 1 : Math.max(0, this.loudRun - 2);
        if (this.loudRun >= 15) {
          this.loudRun = 0;
          this.onBargeIn();
        }
        return;
      }

      if (this.mode === 'hold') {
        if (!this.capturing) return;
        this.frames.push(frame);
        if (rms > keep) this.voiced++;
        if (this.releasing && --this.releasing === 0) this.finish();
        else if (this.frames.length * FRAME_MS > 120000) this.finish();
        return;
      }

      if (this.mode !== 'auto') return;
      if (!this.capturing) {
        this.hot = rms > start ? this.hot + 1 : Math.max(0, this.hot - 1);
        if (this.hot >= 4) {
          this.capturing = true;
          this.frames = this.pre.slice();
          this.voiced = this.hot;
          this.silent = 0;
          this.onStart();
        }
        return;
      }
      this.frames.push(frame);
      if (rms > keep) {
        this.voiced++;
        this.silent = 0;
      } else this.silent++;
      if (this.silent * FRAME_MS >= this.endMs || this.frames.length * FRAME_MS > 60000) this.finish();
    }

    /** Push to talk: start recording now (with a little audio from just before the press). */
    press() {
      if (this.mode !== 'hold') return;
      this.capturing = true;
      this.releasing = 0;
      this.frames = this.pre.slice(-10);
      this.voiced = 0;
      this.onStart();
    }

    /** Push to talk: stop after a short tail so the last syllable is not cut. */
    release() {
      if (this.mode !== 'hold' || !this.capturing) return;
      this.releasing = 12; // 240 ms
    }

    cancel() {
      this.reset();
    }

    finish() {
      const frames = this.frames;
      const voicedMs = this.voiced * FRAME_MS;
      this.reset();
      // Trim the trailing silence, keeping a little.
      let end = frames.length;
      const { keep } = this.thresholds;
      while (end > 15) {
        const f = frames[end - 1];
        let e = 0;
        for (let i = 0; i < f.length; i++) e += f[i] * f[i];
        if (Math.sqrt(e / f.length) > keep) break;
        end--;
      }
      const used = frames.slice(0, Math.min(frames.length, end + 15));
      if (voicedMs < 240) return this.onDiscard(voicedMs);
      const samples = new Float32Array(used.length * FRAME);
      used.forEach((f, i) => samples.set(f, i * FRAME));
      this.onEnd(samples, voicedMs);
    }
  }

  /** 16 kHz mono 16-bit WAV: every speech service reads it, nothing to decode or repair. */
  function encodeWav(samples) {
    // Normalise quiet recordings (up to +18 dB) so soft voices transcribe as well as loud ones.
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    const gain = peak > 0 ? Math.min(8, 0.9 / peak) : 1;
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    v.setUint32(4, 36 + samples.length * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, RATE, true);
    v.setUint32(28, RATE * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, 'data');
    v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i] * gain));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  /**
   * Cuts streaming reply text into sentences worth speaking. Never cuts inside a code block, so
   * the server can drop whole blocks before speaking.
   */
  class Sentences {
    constructor(onSentence) {
      this.onSentence = onSentence;
      this.buf = '';
      this.count = 0;
    }
    push(delta) {
      this.buf += delta;
      for (;;) {
        const fences = (this.buf.match(/```/g) || []).length;
        if (fences % 2) return;
        // First piece short (start talking fast), later ones a bit longer (fewer requests).
        const min = this.count === 0 ? 24 : 90;
        const re = /[.!?…]+["»”')\]]*\s+|:\s*\n|\n\s*\n/g;
        let cut = -1;
        let m;
        while ((m = re.exec(this.buf))) {
          if (m.index + m[0].length >= min) {
            cut = m.index + m[0].length;
            break;
          }
        }
        if (cut < 0) return;
        this.emit(this.buf.slice(0, cut));
        this.buf = this.buf.slice(cut);
      }
    }
    /** A tool call or the end of the reply: say what is left. */
    flush() {
      const fences = (this.buf.match(/```/g) || []).length;
      if (fences % 2) this.buf += '\n```';
      this.emit(this.buf);
      this.buf = '';
    }
    emit(text) {
      if (!/[\p{L}\p{N}]/u.test(text.replace(/```[\s\S]*?```/g, ''))) return;
      this.count++;
      this.onSentence(text.trim());
    }
    reset() {
      this.buf = '';
      this.count = 0;
    }
  }

  /**
   * Plays the agent's voice: a queue of sentences, each fetched as audio ahead of time (two at
   * once) and played back to back through the call's audio context.
   */
  class Speaker {
    constructor(ctx, fetchAudio) {
      this.ctx = ctx;
      this.fetchAudio = fetchAudio;
      this.queue = [];
      this.gen = 0;
      this.node = null;
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.connect(ctx.destination);
      this.level = new Float32Array(this.analyser.fftSize);
      this.onStart = () => {};
      this.onIdle = () => {};
      this.onError = () => {};
      this.onOk = () => {};
      /** Optional: speaks a sentence another way (the device voice) when the agent's voice fails. */
      this.fallback = null;
      this.fallbackCancel = null;
    }
    get busy() {
      return !!this.node || this.queue.length > 0;
    }
    say(text) {
      const item = { text, audio: null };
      this.queue.push(item);
      this.prefetch();
      if (!this.node) void this.next();
    }
    prefetch() {
      const gen = this.gen;
      for (const item of this.queue.slice(0, 2)) {
        if (item.audio) continue;
        item.audio = this.fetchAudio(item.text)
          .then((buf) => (gen === this.gen ? this.ctx.decodeAudioData(buf) : null))
          .then((audio) => {
            if (audio && gen === this.gen) this.onOk();
            return audio;
          })
          .catch((err) => {
            item.failed = true;
            if (gen === this.gen) this.onError(err, item.text);
            return null;
          });
      }
    }
    async next() {
      const gen = this.gen;
      const item = this.queue[0];
      if (!item) return this.onIdle();
      this.node = 'loading';
      this.prefetch();
      const audio = await item.audio;
      if (gen !== this.gen) return;
      this.queue.shift();
      if (!audio) {
        if (item.failed && this.fallback) {
          // Say it with the fallback voice, then carry on with the queue.
          this.node = 'fallback';
          this.onStart(item.text);
          try {
            await this.fallback(item.text, gen);
          } catch {}
          if (gen !== this.gen) return;
        }
        this.node = null;
        return this.next();
      }
      const node = this.ctx.createBufferSource();
      node.buffer = audio;
      node.connect(this.analyser);
      this.node = node;
      node.onended = () => {
        if (this.node !== node) return;
        this.node = null;
        void this.next();
      };
      this.onStart(item.text);
      node.start();
    }
    /** Output loudness 0..1 for the visual. */
    get rms() {
      if (!this.node || typeof this.node === 'string') return 0;
      this.analyser.getFloatTimeDomainData(this.level);
      let e = 0;
      for (const v of this.level) e += v * v;
      return Math.sqrt(e / this.level.length);
    }
    stop() {
      this.gen++;
      this.queue = [];
      this.fallbackCancel?.();
      const n = this.node;
      this.node = null;
      if (n && typeof n !== 'string') {
        try {
          n.stop();
        } catch {}
      }
    }
  }

  window.Voice = { Mic, Listener, Sentences, Speaker, encodeWav, RATE };
})();
