import { For, Show, createMemo, createSignal } from 'solid-js';
import { inspectorData, useInspectorListener } from '../stores/app-store';
import type { InspectorContext, InspectorAction } from '../../shared/ipc-types';

interface InspectorDrawerProps {
    open: boolean;
}

/** Map known context patterns to icons */
function getContextIcon(text: string): string {
    if (text.includes('position:')) return '📍';
    if (text.includes('Health:') || text.includes('Food:')) return '❤️';
    if (text.includes('current activity:')) return '🏃';
    if (text.includes('movement:')) return '🦶';
    if (text.includes('oxygen:') || text.includes('drowning')) return '💨';
    if (text.includes('CRITICAL:') || text.includes('WARNING:')) return '⚠️';
    if (text.includes('Note:')) return '💡';
    if (text.includes('is holding:')) return '🤚';
    if (text.includes('armor:')) return '🛡️';
    if (text.includes('Nearby players:')) return '👤';
    if (text.includes('Nearby mobs:')) return '🐾';
    if (text.includes('inventory:')) return '🎒';
    if (text.includes('Nearby blocks:')) return '🧱';
    return '📄';
}

/** Extract a short label from a context line */
function getContextLabel(text: string): string {
    if (text.includes('position:')) return 'Location';
    if (text.includes('Health:')) return 'Status';
    if (text.includes('current activity:')) return 'Activity';
    if (text.includes('movement:')) return 'Movement';
    if (text.includes('oxygen:') || text.includes('drowning')) return 'Oxygen';
    if (text.includes('CRITICAL:') || text.includes('WARNING:')) return 'Alert';
    if (text.includes('Note:')) return 'Note';
    if (text.includes('is holding:')) return 'Held Item';
    if (text.includes('armor:')) return 'Armor';
    if (text.includes('Nearby players:')) return 'Players';
    if (text.includes('Nearby mobs:')) return 'Mobs';
    if (text.includes('inventory:')) return 'Inventory';
    if (text.includes('Nearby blocks:')) return 'Blocks';
    return 'Info';
}

/** Split pipe-delimited context values into individual items */
function splitContextValues(text: string): string[] {
    return text
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
}

/** Determine alert level for styling */
function getAlertLevel(text: string): 'critical' | 'warning' | 'note' | null {
    if (text.includes('CRITICAL:')) return 'critical';
    if (text.includes('WARNING:')) return 'warning';
    if (text.includes('Note:')) return 'note';
    return null;
}

/** Detect category from action name */
function getActionCategory(name: string): string {
    if (['mc_follow_player', 'mc_go_to', 'mc_go_home', 'mc_go_to_entity', 'mc_look_at', 'mc_stop'].includes(name))
        return 'movement';
    if (['mc_attack'].includes(name)) return 'combat';
    if (
        [
            'mc_mine_block',
            'mc_collect_items',
            'mc_eat',
            'mc_sleep',
            'mc_wake',
            'mc_set_home',
            'mc_cook',
            'mc_craft',
            'mc_place_block',
            'mc_fish',
        ].includes(name)
    )
        return 'survival';
    if (
        ['mc_equip', 'mc_give_item', 'mc_store_item', 'mc_take_item', 'mc_inspect', 'mc_toss', 'mc_use_item'].includes(
            name,
        )
    )
        return 'interaction';
    if (['mc_none'].includes(name)) return 'meta';
    return 'other';
}

const CATEGORY_META: Record<string, { icon: string; label: string; color: string }> = {
    movement: { icon: '🦶', label: 'Movement', color: 'var(--accent-blue)' },
    combat: { icon: '⚔️', label: 'Combat', color: 'var(--accent-red)' },
    survival: { icon: '🏕️', label: 'Survival', color: 'var(--accent-green)' },
    interaction: { icon: '🤝', label: 'Interaction', color: 'var(--accent-amber)' },
    meta: { icon: '💭', label: 'Meta', color: 'var(--accent-purple)' },
    other: { icon: '📦', label: 'Other', color: 'var(--text-secondary)' },
};

/** Get a short description from the full description */
function getShortDesc(desc: string): string {
    const first = desc.split('.')[0];
    return first.length > 60 ? first.substring(0, 57) + '...' : first;
}

/** Format action name for display: mc_follow_player → follow player */
function formatActionName(name: string): string {
    return name.replace(/^mc_/, '').replace(/_/g, ' ');
}

interface ActionGroup {
    category: string;
    icon: string;
    label: string;
    color: string;
    actions: InspectorAction[];
}

export default function InspectorDrawer(props: InspectorDrawerProps) {
    useInspectorListener();

    const [activeTab, setActiveTab] = createSignal<'contexts' | 'actions'>('contexts');

    const contextItems = createMemo(() =>
        inspectorData.contexts.map((ctx: InspectorContext) => ({
            icon: getContextIcon(ctx.text),
            label: getContextLabel(ctx.text),
            values: splitContextValues(ctx.text),
            alert: getAlertLevel(ctx.text),
            raw: ctx.text,
        })),
    );

    const actionGroups = createMemo((): ActionGroup[] => {
        const grouped: Record<string, InspectorAction[]> = {};
        for (const action of inspectorData.actions) {
            const cat = getActionCategory(action.name);
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(action);
        }
        const order = ['movement', 'combat', 'survival', 'interaction', 'meta', 'other'];
        return order
            .filter((cat) => grouped[cat])
            .map((cat) => ({
                category: cat,
                ...CATEGORY_META[cat],
                actions: grouped[cat],
            }));
    });

    return (
        <div class={`inspector-drawer ${props.open ? 'open' : ''}`}>
            <div class="inspector-tabs">
                <button
                    class={`inspector-tab ${activeTab() === 'contexts' ? 'active' : ''}`}
                    onClick={() => setActiveTab('contexts')}
                >
                    📋 Contexts
                    <Show when={inspectorData.contexts.length > 0}>
                        <span class="inspector-tab-count">{inspectorData.contexts.length}</span>
                    </Show>
                </button>
                <button
                    class={`inspector-tab ${activeTab() === 'actions' ? 'active' : ''}`}
                    onClick={() => setActiveTab('actions')}
                >
                    ⚡ Actions
                    <Show when={inspectorData.actions.length > 0}>
                        <span class="inspector-tab-count">{inspectorData.actions.length}</span>
                    </Show>
                </button>
            </div>
            <div class="inspector-drawer-body">
                {/* Contexts Tab */}
                <Show when={activeTab() === 'contexts'}>
                    <Show
                        when={contextItems().length > 0}
                        fallback={<p class="inspector-empty">No context data yet</p>}
                    >
                        <div class="inspector-context-grid">
                            <For each={contextItems()}>
                                {(item) => (
                                    <div class={`inspector-context-row ${item.alert ? `alert-${item.alert}` : ''}`}>
                                        <div class="inspector-context-icon">{item.icon}</div>
                                        <div class="inspector-context-content">
                                            <div class="inspector-context-label">{item.label}</div>
                                            <div class="inspector-context-values">
                                                <For each={item.values}>
                                                    {(val) => <span class="inspector-context-tag">{val}</span>}
                                                </For>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </For>
                        </div>
                    </Show>
                </Show>

                {/* Actions Tab */}
                <Show when={activeTab() === 'actions'}>
                    <Show
                        when={inspectorData.actions.length > 0}
                        fallback={<p class="inspector-empty">No actions registered yet</p>}
                    >
                        <div class="inspector-action-groups">
                            <For each={actionGroups()}>
                                {(group) => (
                                    <div class="inspector-action-group">
                                        <div class="inspector-group-header">
                                            <span class="inspector-group-icon">{group.icon}</span>
                                            <span
                                                class="inspector-group-label"
                                                style={{ color: group.color }}
                                            >
                                                {group.label}
                                            </span>
                                            <span class="inspector-group-count">{group.actions.length}</span>
                                        </div>
                                        <div class="inspector-group-actions">
                                            <For each={group.actions}>
                                                {(action) => (
                                                    <div class="inspector-action-card">
                                                        <div class="inspector-action-name">
                                                            {formatActionName(action.name)}
                                                        </div>
                                                        <div class="inspector-action-desc">
                                                            {getShortDesc(action.description)}
                                                        </div>
                                                    </div>
                                                )}
                                            </For>
                                        </div>
                                    </div>
                                )}
                            </For>
                        </div>
                    </Show>
                </Show>
            </div>
        </div>
    );
}
