import { For, Show, createMemo } from 'solid-js';
import { inspectorData, useInspectorListener } from '../stores/app-store';
import type { InspectorContext } from '../../shared/ipc-types';

interface InspectorDrawerProps {
    open: boolean;
    onClose: () => void;
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
    // Remove the "Character's X": prefix for cleaner display
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

export default function InspectorDrawer(props: InspectorDrawerProps) {
    useInspectorListener();

    const contextItems = createMemo(() =>
        inspectorData.contexts.map((ctx: InspectorContext) => ({
            icon: getContextIcon(ctx.text),
            label: getContextLabel(ctx.text),
            values: splitContextValues(ctx.text),
            alert: getAlertLevel(ctx.text),
            raw: ctx.text,
        })),
    );

    return (
        <div class={`inspector-drawer ${props.open ? 'open' : ''}`}>
            <div class="inspector-drawer-header">
                <h2>🔍 Inspector</h2>
                <button class="modal-close" onClick={() => props.onClose()}>
                    ✕
                </button>
            </div>
            <div class="inspector-drawer-body">
                {/* Contexts Section */}
                <div class="inspector-section">
                    <h3>📋 Contexts</h3>
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
                </div>

                {/* Actions Section */}
                <div class="inspector-section">
                    <h3>⚡ Available Actions</h3>
                    <Show
                        when={inspectorData.actions.length > 0}
                        fallback={<p class="inspector-empty">No actions registered yet</p>}
                    >
                        <div class="inspector-actions-list">
                            <For each={inspectorData.actions}>
                                {(action) => (
                                    <div class="inspector-action-item">
                                        <span class="inspector-action-dot">●</span>
                                        <span class="inspector-action-name">{action.name}</span>
                                        <Show when={action.layer}>
                                            <span class="inspector-action-layer">{action.layer}</span>
                                        </Show>
                                    </div>
                                )}
                            </For>
                        </div>
                    </Show>
                </div>
            </div>
        </div>
    );
}
