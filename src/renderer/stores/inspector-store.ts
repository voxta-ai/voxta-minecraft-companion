import { createStore } from 'solid-js/store';
import { onCleanup, onMount } from 'solid-js';
import type { InspectorData } from '../../shared/ipc-types';

const [inspectorData, setInspectorData] = createStore<InspectorData>({
    contexts: [],
    actions: [],
});

export { inspectorData };

export function useInspectorListener(): void {
    onMount(() => {
        const cleanup = window.api.onInspectorUpdate((data) => {
            setInspectorData(data);
        });
        onCleanup(cleanup);
    });
}
