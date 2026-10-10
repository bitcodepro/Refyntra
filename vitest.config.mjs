import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (pkg) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@refyntra/contracts': src('contracts'),
      '@refyntra/domain': src('domain'),
      '@refyntra/application': src('application'),
      '@refyntra/infrastructure': src('infrastructure'),
      '@refyntra/adapter-testing': src('adapter-testing'),
      '@refyntra/adapter-vscode-providers': src('adapter-vscode-providers'),
      '@refyntra/adapter-lsp': src('adapter-lsp'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // packages/extension/test/unit holds pure (vscode-free) presentation logic; the rest runs in the Extension Host.
    exclude: ['packages/extension/test/suite/**', 'packages/extension/test/workspaces/**', '**/node_modules/**'],
    testTimeout: 10000,
  },
});
