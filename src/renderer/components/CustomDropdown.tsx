import { createSignal, For, Show, onCleanup } from 'solid-js';

export interface DropdownOption {
    value: string;
    label: string;
}

interface CustomDropdownProps {
    options: DropdownOption[];
    value: string | null;
    onChange: (value: string) => void;
    class?: string;
    placeholder?: string;
}

export default function CustomDropdown(props: CustomDropdownProps) {
    const [isOpen, setIsOpen] = createSignal(false);
    let containerRef: HTMLDivElement | undefined;

    const selectedLabel = () => {
        const opt = props.options.find((o) => o.value === props.value);
        return opt?.label ?? props.placeholder ?? 'Select...';
    };

    const handleToggle = () => {
        setIsOpen(!isOpen());
    };

    const handleSelect = (value: string) => {
        props.onChange(value);
        setIsOpen(false);
    };

    // Close on click outside
    const handleClickOutside = (e: MouseEvent) => {
        if (containerRef && !containerRef.contains(e.target as Node)) {
            setIsOpen(false);
        }
    };

    document.addEventListener('mousedown', handleClickOutside);
    onCleanup(() => document.removeEventListener('mousedown', handleClickOutside));

    return (
        <div class={`custom-dropdown ${props.class ?? ''}`} ref={(el) => (containerRef = el)}>
            <div class={`custom-dropdown-trigger ${isOpen() ? 'open' : ''}`} onClick={handleToggle}>
                <span class="custom-dropdown-label">{selectedLabel()}</span>
                <span class="custom-dropdown-arrow">{isOpen() ? '▲' : '▼'}</span>
            </div>
            <Show when={isOpen()}>
                <div class="custom-dropdown-list">
                    <For each={props.options}>
                        {(option) => (
                            <div
                                class={`custom-dropdown-item ${option.value === props.value ? 'active' : ''}`}
                                onClick={() => handleSelect(option.value)}
                            >
                                {option.label}
                            </div>
                        )}
                    </For>
                </div>
            </Show>
        </div>
    );
}
