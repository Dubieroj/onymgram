import type { VoiceCodec } from './nativeVoiceRecorder';

import { AAC_ENCODER_CONFIG, ENCODER_CONFIG } from './nativeVoiceRecorder';

const usablePromises: Partial<Record<VoiceCodec, Promise<boolean>>> = {};

export function checkIsNativeRecorderUsable(codec: VoiceCodec = 'opus'): Promise<boolean> {
  usablePromises[codec] ??= (async () => {
    if (!isNativeRecorderSupported()) {
      return false;
    }

    try {
      const { supported } = await AudioEncoder.isConfigSupported(codec === 'aac' ? AAC_ENCODER_CONFIG : ENCODER_CONFIG);
      return Boolean(supported);
    } catch (err) {
      return false;
    }
  })();

  return usablePromises[codec];
}

// FFmpeg's AAC encoder in WebAssembly stands in where WebCodecs cannot encode AAC
export function isWasmAacEncoderSupported() {
  return isNativeRecorderSupported() && typeof WebAssembly !== 'undefined' && typeof Worker !== 'undefined';
}

function isNativeRecorderSupported(): boolean {
  return typeof AudioEncoder !== 'undefined'
    && typeof AudioData !== 'undefined'
    && typeof AudioWorkletNode !== 'undefined'
    && typeof AudioContext !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia);
}
