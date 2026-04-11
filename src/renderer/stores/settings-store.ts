import { createStore } from 'solid-js/store';
import type { McSettings } from '../../shared/ipc-types';
import { DEFAULT_SETTINGS } from '../../shared/ipc-types';

const SETTINGS_KEY = 'voxta-mc-settings';

function loadSavedSettings(): McSettings {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
        /* ignore */
    }
    return { ...DEFAULT_SETTINGS };
}

const [settings, setSettings] = createStore<McSettings>(loadSavedSettings());

// Sync saved settings to the main process on startup
// (without this, the main starts with DEFAULT_SETTINGS until the user changes a toggle)
void window.api.updateSettings({ ...settings });

export { settings };

export function updateSetting<K extends keyof McSettings>(key: K, value: McSettings[K]): void {
    setSettings(key, value);
    const updated = { ...settings };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
    void window.api.updateSettings(updated);
}

export function getSettings(): McSettings {
    return { ...settings };
}
