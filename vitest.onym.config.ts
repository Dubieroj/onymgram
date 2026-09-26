import { defineConfig } from 'vitest/config';

// The Onym protocol core is plain TypeScript: its tests run in Node without the app's Vite pipeline
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/api/onym/**/*.test.ts', 'src/util/voiceRecording/**/*.test.ts'],
  },
});
