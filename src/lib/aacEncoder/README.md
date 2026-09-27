# AAC encoder in WebAssembly

`aacEncoder.worker.js` is FFmpeg's AAC encoder (libavcodec 62.23.103) compiled to WebAssembly, inside the worker
that [@mediabunny/aac-encoder](https://www.npmjs.com/package/@mediabunny/aac-encoder) 1.60.0 ships. Browsers whose
WebCodecs cannot encode AAC and whose MediaRecorder cannot write it (Firefox, Chrome on Linux) record voice messages
with it; no other browser loads it. `src/util/voiceRecording/wasmAacEncoder.ts` drives it.

The package starts this worker from a `blob:` URL, which the production CSP (`worker-src 'self'`) forbids, so the
worker is served here as a file of its own. It is the template literal passed to `inlineWorker` in the package's
`dist/bundles/mediabunny-aac-encoder.mjs`, unchanged:

```
sha256 93d0c3879604e40c31a97cf9d53c386e2851064a1576d04cad37406e124490e0  aacEncoder.worker.js
```

The worker takes `{ id, command }` messages, where a command is `init` (`numberOfChannels`, `sampleRate`,
`bitrate`), `encode` (`ctx`, `audioData`: one frame of interleaved 32-bit float samples, `timestamp` in samples)
or `flush` (`ctx`), and answers `{ id, success, data }` in order.

## Sources and licenses

- The worker and its C bridge: MPL-2.0 ([LICENSE](LICENSE)), source at
  https://github.com/Vanilagy/mediabunny/tree/v1.60.0/packages/aac-encoder (`src/encode.worker.ts`,
  `src/bridge.c`, `build/aac.js`).
- FFmpeg's libavcodec and libavutil: LGPL-2.1-or-later, used here under GPL-3.0-or-later with the rest of
  Onymgram. Source: https://ffmpeg.org/download.html.
- The Emscripten runtime: MIT.

To update, unpack the new package (`npm pack @mediabunny/aac-encoder@<version>`), take the literal out of the
bundle again, replace the file and the checksum above.
