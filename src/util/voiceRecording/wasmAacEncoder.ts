import workerUrl from '../../lib/aacEncoder/aacEncoder.worker.js?url';

// FFmpeg's AAC encoder in WebAssembly (src/lib/aacEncoder), for browsers whose WebCodecs cannot encode AAC. It stands
// in for the part of AudioEncoder that NativeVoiceRecorder uses, which records mono
type Packet = { encodedData: ArrayBuffer; pts: number; duration: number };
type Reply = { ctx: number; frameSize: number; extradata: ArrayBuffer; packets: Packet[] };
type Command = { type: 'init'; data: { numberOfChannels: number; sampleRate: number; bitrate: number } }
  | { type: 'encode'; data: { ctx: number; audioData: ArrayBuffer; timestamp: number } }
  | { type: 'flush'; data: { ctx: number } };
type Response = { id: number; success: true; data: Reply } | { id: number; success: false; error: unknown };

export default class WasmAacEncoder {
  state: CodecState = 'unconfigured';

  private worker?: Worker;

  // The worker answers in order, so each command waits for the one before it
  private queue = Promise.resolve();

  private replies = new Map<number, { resolve: (reply: Reply) => void; reject: (err: DOMException) => void }>();

  private nextId = 0;

  private ctx = 0;

  private frameSize = 0;

  private sampleRate = 0;

  // Samples that do not make a whole frame yet
  private pending = new Float32Array(0);

  private timestamp = 0;

  private metadata?: EncodedAudioChunkMetadata;

  constructor(private init: AudioEncoderInit) {}

  configure(config: AudioEncoderConfig) {
    this.state = 'configured';
    this.sampleRate = config.sampleRate;
    this.worker = new Worker(workerUrl);
    this.worker.onmessage = ({ data }: MessageEvent<Response>) => {
      const reply = this.replies.get(data.id);
      this.replies.delete(data.id);
      if (data.success) reply?.resolve(data.data);
      else reply?.reject(new DOMException(String(data.error), 'EncodingError'));
    };
    this.worker.onerror = (e) => {
      const error = new DOMException(e.message || 'The AAC encoder did not load', 'OperationError');
      this.replies.forEach(({ reject }) => reject(error));
      this.replies.clear();
      this.init.error(error);
    };

    this.enqueue(async () => {
      const { ctx, frameSize, extradata } = await this.send({
        type: 'init',
        data: { numberOfChannels: config.numberOfChannels, sampleRate: config.sampleRate, bitrate: config.bitrate! },
      });
      this.ctx = ctx;
      this.frameSize = frameSize;
      this.metadata = {
        decoderConfig: {
          codec: config.codec,
          sampleRate: config.sampleRate,
          numberOfChannels: config.numberOfChannels,
          description: new Uint8Array(extradata),
        },
      };
    });
  }

  encode(data: AudioData) {
    const samples = new Float32Array(data.numberOfFrames);
    data.copyTo(samples, { planeIndex: 0 });
    this.enqueue(async () => {
      this.pending = concat(this.pending, samples);
      while (this.pending.length >= this.frameSize) {
        await this.encodeFrame(this.pending.slice(0, this.frameSize));
        this.pending = this.pending.slice(this.frameSize);
      }
    });
  }

  flush() {
    this.enqueue(async () => {
      // The last samples are padded with silence to a whole frame
      if (this.pending.length) {
        const frame = new Float32Array(this.frameSize);
        frame.set(this.pending);
        this.pending = new Float32Array(0);
        await this.encodeFrame(frame);
      }
      this.emit(await this.send({ type: 'flush', data: { ctx: this.ctx } }));
    });
    return this.queue;
  }

  close() {
    this.state = 'closed';
    this.worker?.terminate();
  }

  private async encodeFrame(frame: Float32Array<ArrayBuffer>) {
    const reply = await this.send({
      type: 'encode',
      data: { ctx: this.ctx, audioData: frame.buffer, timestamp: this.timestamp },
    }, [frame.buffer]);
    this.timestamp += this.frameSize;
    this.emit(reply);
  }

  private emit({ packets }: Reply) {
    packets.forEach(({ encodedData, pts, duration }) => {
      this.init.output(new EncodedAudioChunk({
        type: 'key',
        timestamp: (pts * 1_000_000) / this.sampleRate,
        duration: (duration * 1_000_000) / this.sampleRate,
        data: encodedData,
      }), this.metadata);
    });
  }

  // A failed command fails every later one and the flush that waits for them
  private enqueue(task: () => Promise<void>) {
    this.queue = this.queue.then(task);
    this.queue.catch(() => {});
  }

  private send(command: Command, transfer: Transferable[] = []) {
    return new Promise<Reply>((resolve, reject) => {
      const id = this.nextId++;
      this.replies.set(id, { resolve, reject });
      this.worker!.postMessage({ id, command }, transfer);
    });
  }
}

function concat(a: Float32Array, b: Float32Array) {
  const result = new Float32Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
}
