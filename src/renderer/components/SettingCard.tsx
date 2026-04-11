import { Show } from 'solid-js';
import type { JSXElement } from 'solid-js';

interface SettingCardProps {
    name: JSXElement;
    description?: string;
    children: JSXElement;
}

/** Reusable card layout for settings, toggles, and property rows.
 *  Renders the standard setting-card structure: name + optional description on
 *  the left, action element (toggle, slider, button, select, input) on the right. */
export function SettingCard(props: SettingCardProps) {
    return (
        <div class="setting-card">
            <div class="setting-card-info">
                <div class="setting-card-name">{props.name}</div>
                <Show when={props.description}>
                    <div class="setting-card-desc">{props.description}</div>
                </Show>
            </div>
            {props.children}
        </div>
    );
}
