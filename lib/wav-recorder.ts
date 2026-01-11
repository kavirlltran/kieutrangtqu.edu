// Simple WAV recorder fallback for browsers that don't support MediaRecorder audio (notably iOS Safari).
// Uses WebAudio + ScriptProcessor to capture PCM and encodes a 16-bit PCM WAV Blob.

export type WavRecording = { blob: Blob; durationSec: number; mimeType: string };

export type WavRecorderHandle = {
  stop: () => Promise<WavRecording>;
};

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function floatTo16BitPCM(view: DataView, offset: number, input: Float32Array) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
}

function mergeBuffers(chunks: Float32Array[]) {
  let length = 0;
  for (const c of chunks) length += c.length;
  const out = new Float32Array(length);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function encodeWav(mono: Float32Array, sampleRate: number): Blob {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + mono.length * bytesPerSample);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + mono.length * bytesPerSample, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(view, 36, "data");
  view.setUint32(40, mono.length * bytesPerSample, true);
  floatTo16BitPCM(view, 44, mono);

  return new Blob([view], { type: "audio/wav" });
}

export async function startWavRecorder(): Promise<WavRecorderHandle> {
  if (typeof window === "undefined") throw new Error("Browser only");

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  const AudioCtx: any = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!AudioCtx) throw new Error("AudioContext not supported");

  const audioCtx = new AudioCtx();
  const source = audioCtx.createMediaStreamSource(stream);

  // ScriptProcessor is deprecated but still widely supported and works on iOS Safari.
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];

  processor.onaudioprocess = (e: any) => {
    const input = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
  };

  source.connect(processor);
  processor.connect(audioCtx.destination);

  const stop = async (): Promise<WavRecording> => {
    processor.disconnect();
    source.disconnect();

    stream.getTracks().forEach((t: any) => t.stop());

    const sampleRate = audioCtx.sampleRate || 44100;
    // Close to release mic indicator on iOS
    try {
      await audioCtx.close();
    } catch {}

    const mono = mergeBuffers(chunks);
    const blob = encodeWav(mono, sampleRate);
    const durationSec = mono.length / sampleRate;

    return { blob, durationSec, mimeType: "audio/wav" };
  };

  return { stop };
}
