import type { ElectronAPI } from '../preload';

declare global {
    interface Window {
        api: ElectronAPI;
    }
}
