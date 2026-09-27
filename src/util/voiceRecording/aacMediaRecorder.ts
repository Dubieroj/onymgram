import M4aAacWriter from './m4aAacWriter';
import { readAacTrack } from './mp4AacReader';
import { AAC_ENCODER_CONFIG } from './nativeVoiceRecorder';

// Safari without WebCodecs audio records AAC through MediaRecorder. MediaRecorder may write the clip in fragments,
// which the Onym apps' players do not open, so the frames are written again as one indexed file
const MIME_TYPE = 'audio/mp4;codecs=mp4a.40.2';
const TAP_BUFFER_SIZE = 2048;
const AAC_FRAME_SAMPLES = 1024;

export default class AacMediaRecorder {
  onSamples?: (samples: Float32Array) => void;

  private stream?: MediaStream;

  private recorder?: MediaRecorder;

  private chunks: Blob[] = [];

  private audioContext?: AudioContext;

  private tap?: ScriptProcessorNode;

  static isSupported() {
    return typeof MediaRecorder !== 'undefined'
      && MediaRecorder.isTypeSupported(MIME_TYPE)
      && Boolean(navigator.mediaDevices?.getUserMedia);
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    try {
      this.recorder = new MediaRecorder(this.stream, {
        mimeType: MIME_TYPE,
        audioBitsPerSecond: AAC_ENCODER_CONFIG.bitrate,
      });
      this.recorder.ondataavailable = (e) => this.chunks.push(e.data);

      // The waveform is taken from the same microphone stream
      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(this.stream);
      this.tap = this.audioContext.createScriptProcessor(TAP_BUFFER_SIZE, 1, 1);
      this.tap.onaudioprocess = (e) => {
        if (this.recorder?.state === 'recording') this.onSamples?.(e.inputBuffer.getChannelData(0));
      };
      source.connect(this.tap);
      this.tap.connect(this.audioContext.destination);

      this.recorder.start();
    } catch (err) {
      this.release();
      throw err;
    }
  }

  pause(): Promise<void> {
    if (this.recorder?.state === 'recording') this.recorder.pause();
    return Promise.resolve();
  }

  resume(): void {
    if (this.recorder?.state === 'paused') this.recorder.resume();
  }

  async stop(): Promise<Uint8Array> {
    const recorder = this.recorder;
    // A recorder whose microphone went away has stopped by itself and fires no second `stop`
    if (recorder && recorder.state !== 'inactive') {
      await new Promise((resolve) => {
        recorder.onstop = resolve;
        recorder.stop();
      });
    }
    this.release();

    return remux(new Uint8Array(await new Blob(this.chunks).arrayBuffer()));
  }

  private release() {
    this.tap?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.audioContext && this.audioContext.state !== 'closed') {
      void this.audioContext.close().catch(() => {});
    }
  }
}

// Empty when the recording holds no AAC track, which the caller reports as a recording without data
function remux(file: Uint8Array) {
  const track = readAacTrack(file);
  if (!track?.frames.length) return new Uint8Array(0);

  const writer = new M4aAacWriter({
    sampleRate: track.sampleRate,
    channels: track.channels,
    bitrate: AAC_ENCODER_CONFIG.bitrate!,
  });
  writer.setDecoderConfig(track.config);
  track.frames.forEach((frame) => writer.writePacket(frame, AAC_FRAME_SAMPLES));
  return writer.finalize();
}
