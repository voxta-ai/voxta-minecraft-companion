import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // @voxta/voxta-client is built for bundler consumption: its ESM entry uses bare
        // directory imports (e.g. `export * from './lib/types'`) that Vite resolves but
        // Node's native ESM loader rejects. The electron app bundles the client via
        // electron-vite, so inline it here too instead of externalizing it to Node ESM.
        server: {
            deps: {
                inline: ['@voxta/voxta-client'],
            },
        },
    },
});
