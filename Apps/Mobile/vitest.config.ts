import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@modules': path.resolve(__dirname, 'modules'),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'modules/**/src/**/*.test.ts'],
    environment: 'node',
  },
});
