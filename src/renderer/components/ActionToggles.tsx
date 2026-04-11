import { For, onMount, createMemo } from 'solid-js';
import { actions, loadActions, toggleAction } from '../stores/action-store';
import { SettingCard } from './SettingCard';

/** Short human-friendly descriptions for each action (keyed by action name) */
const ACTION_DESCRIPTIONS: Record<string, string> = {
    mc_follow_player: 'Walk behind and stay near a player',
    mc_go_to: 'Navigate to specific X/Y/Z coordinates',
    mc_go_home: 'Return to the home base where the bed is',
    mc_look_at: 'Turn to face a specific player',
    mc_stop: 'Cancel the current action and stand still',
    mc_attack: 'Attack the nearest hostile or named entity',
    mc_mine_block: 'Find and collect blocks, ores, or plants',
    mc_collect_items: 'Pick up dropped items from the ground',
    mc_eat: 'Eat food from inventory to restore hunger',
    mc_sleep: 'Find a nearby bed and sleep (night only)',
    mc_wake: 'Wake up and get out of bed',
    mc_set_home: 'Mark a nearby bed as the respawn point',
    mc_cook: 'Cook food or smelt ores in a furnace',
    mc_craft: 'Craft items using materials in inventory',
    mc_place_block: 'Place a block at a nearby location',
    mc_fish: 'Cast a rod and wait for fish to bite',
    mc_equip: 'Equip an item from inventory',
    mc_give_item: 'Toss items to a nearby player',
    mc_store_item: 'Deposit items into a nearby chest',
    mc_take_item: 'Withdraw items from a nearby chest',
    mc_inspect: 'Check contents of a container or inventory',
    mc_toss: 'Drop items from inventory onto the ground',
    mc_use_item: 'Use/activate an item (potions, buckets, etc.)',
    mc_none: 'No action — just talking',
};

function formatActionName(name: string): string {
    return name
        .replace('mc_', '')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function ActionToggles() {
    onMount(() => {
        void loadActions();
    });

    const grouped = createMemo(() => {
        const groups: Record<string, typeof actions.list> = {};
        for (const action of actions.list) {
            const cat = action.category || 'interaction';
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(action);
        }
        return groups;
    });

    const categoryLabels: Record<string, string> = {
        movement: '🧭 Movement',
        combat: '⚔️ Combat',
        communication: '💬 Communication',
        survival: '⛏️ Survival',
        interaction: '🤝 Interaction',
        meta: '⚙️ Meta',
    };

    return (
        <div class="action-toggles">
            <h3>Actions</h3>
            <For each={Object.entries(grouped())}>
                {([category, items]) => (
                    <div class="action-category">
                        <div class="action-category-title">{categoryLabels[category] ?? category}</div>
                        <div class="setting-card-list">
                            <For each={items}>
                                {(action) => (
                                    <SettingCard
                                        name={formatActionName(action.name)}
                                        description={ACTION_DESCRIPTIONS[action.name] ?? ''}
                                    >
                                        <label class="toggle">
                                            <input
                                                type="checkbox"
                                                checked={action.enabled}
                                                onChange={(e) =>
                                                    void toggleAction(action.name, e.currentTarget.checked)
                                                }
                                            />
                                            <span class="toggle-slider" />
                                        </label>
                                    </SettingCard>
                                )}
                            </For>
                        </div>
                    </div>
                )}
            </For>
        </div>
    );
}
