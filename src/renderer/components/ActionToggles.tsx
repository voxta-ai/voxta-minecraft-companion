import { For, onMount, createMemo } from 'solid-js';
import { actions, loadActions, toggleAction } from '../stores/app-store';

export default function ActionToggles() {
    onMount(() => {
        void loadActions();
    });

    const grouped = createMemo(() => {
        const groups: Record<string, typeof actions.list> = {
            movement: [],
            combat: [],
            communication: [],
        };
        for (const action of actions.list) {
            const cat = action.category || 'communication';
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(action);
        }
        return groups;
    });

    const categoryLabels: Record<string, string> = {
        movement: '🧭 Movement',
        combat: '⚔️ Combat',
        communication: '💬 Communication',
    };

    return (
        <div class="action-toggles">
            <h3>Actions</h3>
            <For each={Object.entries(grouped())}>
                {([category, items]) => (
                    <div class="action-category">
                        <div class="action-category-title">{categoryLabels[category] ?? category}</div>
                        <For each={items}>
                            {(action) => (
                                <div class="action-item">
                                    <label>{action.name.replace('mc_', '').replace(/_/g, ' ')}</label>
                                    <label class="toggle">
                                        <input
                                            type="checkbox"
                                            checked={action.enabled}
                                            onChange={(e) => void toggleAction(action.name, e.currentTarget.checked)}
                                        />
                                        <span class="toggle-slider" />
                                    </label>
                                </div>
                            )}
                        </For>
                    </div>
                )}
            </For>
        </div>
    );
}
