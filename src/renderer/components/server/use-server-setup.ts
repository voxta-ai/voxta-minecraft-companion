import { createSignal, onMount, onCleanup } from 'solid-js';
import { setIsInstalled, setIsSettingUp, setSetupProgress } from '../../stores/server-store';

/**
 * Paper version list, installed version and the setup action for the built-in server.
 * Shared by the Server Manager and the connection wizard's Server step.
 */
export function useServerSetup() {
    const [availableVersions, setAvailableVersions] = createSignal<string[]>([]);
    const [selectedVersion, setSelectedVersion] = createSignal('');
    const [loadingVersions, setLoadingVersions] = createSignal(false);
    const [installedVersion, setInstalledVersion] = createSignal<string | null>(null);

    onMount(() => {
        const unsubProgress = window.api.onServerSetupProgress((progress) => {
            setSetupProgress(progress);
        });
        void window.api.serverGetInstalledVersion().then((version) => {
            setInstalledVersion(version);
        });
        onCleanup(() => {
            unsubProgress();
        });
    });

    async function fetchVersions(): Promise<void> {
        setLoadingVersions(true);
        try {
            const versions = await window.api.serverGetVersions();
            setAvailableVersions(versions);
            if (versions.length > 0 && !selectedVersion()) {
                setSelectedVersion(versions[0]);
            }
        } catch (err) {
            console.error('Failed to fetch versions:', err);
        } finally {
            setLoadingVersions(false);
        }
    }

    /** Download and configure Paper at the selected version. Resolves true on success. */
    async function runSetup(): Promise<boolean> {
        const version = selectedVersion();
        if (!version) return false;
        setIsSettingUp(true);
        try {
            await window.api.serverSetup(version);
            setIsInstalled(true);
            setInstalledVersion(version);
            return true;
        } catch (err) {
            console.error('Setup failed:', err);
            return false;
        } finally {
            setIsSettingUp(false);
            setSetupProgress(null);
        }
    }

    return {
        availableVersions,
        selectedVersion,
        setSelectedVersion,
        loadingVersions,
        installedVersion,
        fetchVersions,
        runSetup,
    };
}
