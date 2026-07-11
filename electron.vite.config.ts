import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
    main: {
        // Bundle the ESM @voxta/voxta-client into the CJS main output instead of require()-ing it at
        // runtime (which throws ERR_REQUIRE_ESM). Its transitive deps (signalr, axios, etc.) are not
        // in this app's package.json, so they get bundled in alongside it rather than externalized.
        plugins: [externalizeDepsPlugin({ exclude: ['@voxta/voxta-client'] })],
        build: {
            rollupOptions: {
                external: ['mineflayer', 'mineflayer-pathfinder', 'minecraft-data'],
            },
        },
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
    },
    renderer: {
        plugins: [solidPlugin()],
    },
});
