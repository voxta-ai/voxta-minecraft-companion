import { createSignal } from 'solid-js';
import type { ServerProperties } from '../../shared/ipc-types';
import { addToast } from './toast-store';

// ---- Server properties (server.properties file) ----

const [properties, setProperties] = createSignal<ServerProperties>({});
const [propsChanged, setPropsChanged] = createSignal(false);
const [savingProps, setSavingProps] = createSignal(false);

// ---- Server config (memory, auto-start) ----

const [memoryMb, setMemoryMb] = createSignal(1024);
const [autoStart, setAutoStart] = createSignal(false);
const [configChanged, setConfigChanged] = createSignal(false);
const [savingConfig, setSavingConfig] = createSignal(false);

export { properties, memoryMb, autoStart, propsChanged, savingProps, configChanged, savingConfig };

/** Load properties and config from the server */
export async function loadPropertiesAndConfig(): Promise<void> {
    const [props, config] = await Promise.all([
        window.api.serverGetProperties(),
        window.api.serverGetConfig(),
    ]);
    setProperties(props);
    setMemoryMb(config.memoryMb);
    setAutoStart(config.autoStart);
}

/** Update a single server property and mark as changed */
export function updateProperty(key: string, value: string): void {
    setProperties((prev) => ({ ...prev, [key]: value }));
    setPropsChanged(true);
}

/** Update a config value and mark as changed */
export function updateMemoryMb(value: number): void {
    setMemoryMb(value);
    setConfigChanged(true);
}

/** Update auto-start config and mark as changed */
export function updateAutoStart(value: boolean): void {
    setAutoStart(value);
    setConfigChanged(true);
}

/** Save server.properties to disk */
export async function saveProperties(): Promise<void> {
    setSavingProps(true);
    try {
        await window.api.serverSaveProperties(properties());
        setPropsChanged(false);
        addToast('success', 'Server properties saved');
    } catch (err) {
        addToast('error', `Failed to save properties: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
        setSavingProps(false);
    }
}

/** Save server config (memory, auto-start) */
export async function saveConfig(): Promise<void> {
    setSavingConfig(true);
    try {
        await window.api.serverSaveConfig({ memoryMb: memoryMb(), autoStart: autoStart() });
        setConfigChanged(false);
        addToast('success', 'Server configuration saved');
    } catch (err) {
        addToast('error', `Failed to save config: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
        setSavingConfig(false);
    }
}

/** Reset all properties and config to defaults */
export function resetDefaults(): void {
    setProperties({
        'difficulty': 'easy',
        'gamemode': 'survival',
        'max-players': '5',
        'motd': 'Voxta Test Server',
        'server-port': '25565',
        'online-mode': 'false',
        'spawn-monsters': 'true',
        'spawn-animals': 'true',
        'allow-flight': 'false',
        'enable-command-block': 'true',
    });
    setMemoryMb(1024);
    setAutoStart(false);
    setPropsChanged(true);
    setConfigChanged(true);
}
