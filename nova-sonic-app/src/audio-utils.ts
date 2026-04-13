/** Capture microphone as 16kHz mono PCM16 and return base64 chunks via callback */
export async function startMicCapture(
  onChunk: (base64Pcm: string) => void
): Promise<{ stop: () => void }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      sampleRate: 16000,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });

  const audioCtx = new AudioContext({ sampleRate: 16000 });
  const source = audioCtx.createMediaStreamSource(stream);
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (e) => {
    const float32 = e.inputBuffer.getChannelData(0);
    const pcm16 = float32ToPcm16(float32);
    const base64 = arrayBufferToBase64(pcm16.buffer as ArrayBuffer);
    onChunk(base64);
  };

  source.connect(processor);
  processor.connect(audioCtx.destination);

  return {
    stop() {
      processor.disconnect();
      source.disconnect();
      audioCtx.close();
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

/** Play base64-encoded PCM16 24kHz mono audio with gapless scheduling */
export class AudioPlayer {
  private audioCtx: AudioContext;
  private nextTime = 0;
  private sources: AudioBufferSourceNode[] = [];

  constructor() {
    this.audioCtx = new AudioContext({ sampleRate: 24000 });
  }

  enqueue(base64Pcm: string) {
    const bytes = base64ToArrayBuffer(base64Pcm);
    const int16 = new Int16Array(bytes);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }
    const buffer = this.audioCtx.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);

    // Schedule immediately with no gap
    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioCtx.destination);

    const now = this.audioCtx.currentTime;
    // If nextTime is in the past, start from now with a tiny lookahead
    const startTime = this.nextTime > now ? this.nextTime : now + 0.005;
    source.start(startTime);
    this.nextTime = startTime + buffer.duration;

    this.sources.push(source);
    source.onended = () => {
      const idx = this.sources.indexOf(source);
      if (idx !== -1) this.sources.splice(idx, 1);
    };
  }

  stop() {
    for (const s of this.sources) {
      try { s.stop(); } catch {}
    }
    this.sources = [];
    this.nextTime = 0;
    this.audioCtx.close();
  }
}

function float32ToPcm16(float32: Float32Array): Int16Array {
  const pcm16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm16;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
