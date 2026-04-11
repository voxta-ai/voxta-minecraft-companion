import { createStore } from 'solid-js/store';
import type { ActionToggle } from '../../shared/ipc-types';

const [actions, setActions] = createStore<{ list: ActionToggle[] }>({
    list: [],
});

export { actions };

export async function loadActions(): Promise<void> {
    const result = await window.api.getActions();
    setActions('list', result);
}

export async function toggleAction(name: string, enabled: boolean): Promise<void> {
    await window.api.toggleAction(name, enabled);
    setActions('list', (a) => a.name === name, 'enabled', enabled);
}
