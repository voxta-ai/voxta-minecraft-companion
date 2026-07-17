import { createSignal, createMemo, createEffect, For, Show, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { JSX } from 'solid-js';

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
    searchable?: boolean;
}

// Approx. max menu height (search box + options list) used for flip decisions.
const MENU_MAX_HEIGHT = 300;

export default function CustomDropdown(props: CustomDropdownProps) {
    const [isOpen, setIsOpen] = createSignal(false);
    const [searchQuery, setSearchQuery] = createSignal('');
    const [menuStyle, setMenuStyle] = createSignal<JSX.CSSProperties>({});
    let containerRef: HTMLDivElement | undefined;
    let menuRef: HTMLDivElement | undefined;
    let searchInputRef: HTMLInputElement | undefined;

    const selectedLabel = () => {
        const opt = props.options.find((o) => o.value === props.value);
        return opt?.label ?? props.placeholder ?? 'Select...';
    };

    const filteredOptions = createMemo(() => {
        const query = searchQuery().toLowerCase().trim();
        if (!query) return props.options;
        return props.options.filter((o) => o.label.toLowerCase().includes(query));
    });

    // The menu is portaled to <body> so it escapes the modal's scroll clipping;
    // anchor it to the trigger with fixed positioning and flip up near the edge.
    const updatePosition = () => {
        if (!containerRef) return;
        const rect = containerRef.getBoundingClientRect();
        const gap = 4;
        const spaceBelow = window.innerHeight - rect.bottom;
        const openUp = spaceBelow < MENU_MAX_HEIGHT && rect.top > spaceBelow;
        setMenuStyle({
            position: 'fixed',
            left: `${rect.left}px`,
            width: `${rect.width}px`,
            'z-index': '1000',
            ...(openUp
                ? { bottom: `${window.innerHeight - rect.top + gap}px` }
                : { top: `${rect.bottom + gap}px` }),
        });
    };

    createEffect(() => {
        if (!isOpen()) return;
        updatePosition();
        window.addEventListener('scroll', updatePosition, true);
        window.addEventListener('resize', updatePosition);
        onCleanup(() => {
            window.removeEventListener('scroll', updatePosition, true);
            window.removeEventListener('resize', updatePosition);
        });
    });

    const handleToggle = () => {
        const opening = !isOpen();
        setIsOpen(opening);
        if (opening) {
            setSearchQuery('');
            // Focus the search input after the DOM updates
            requestAnimationFrame(() => {
                searchInputRef?.focus();
            });
        }
    };

    const handleSelect = (value: string) => {
        props.onChange(value);
        setIsOpen(false);
        setSearchQuery('');
    };

    const handleSearchKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            setIsOpen(false);
            setSearchQuery('');
        } else if (e.key === 'Enter') {
            // Select the first matching option on Enter
            const matches = filteredOptions();
            if (matches.length === 1) {
                handleSelect(matches[0].value);
            }
        }
    };

    // Close on click outside — the menu lives outside containerRef (portaled),
    // so check it too, otherwise clicking an option would count as "outside".
    const handleClickOutside = (e: MouseEvent) => {
        const target = e.target as Node;
        if (
            containerRef &&
            !containerRef.contains(target) &&
            (!menuRef || !menuRef.contains(target))
        ) {
            setIsOpen(false);
            setSearchQuery('');
        }
    };

    document.addEventListener('mousedown', handleClickOutside);
    onCleanup(() => document.removeEventListener('mousedown', handleClickOutside));

    const isSearchable = () => props.searchable !== false;

    return (
        <div class={`custom-dropdown ${props.class ?? ''}`} ref={(el) => (containerRef = el)}>
            <div class={`custom-dropdown-trigger ${isOpen() ? 'open' : ''}`} onClick={handleToggle}>
                <span class="custom-dropdown-label">{selectedLabel()}</span>
                <span class="custom-dropdown-arrow">{isOpen() ? '▲' : '▼'}</span>
            </div>
            <Show when={isOpen()}>
                <Portal>
                    <div class="custom-dropdown-list" style={menuStyle()} ref={(el) => (menuRef = el)}>
                        <Show when={isSearchable()}>
                            <div class="custom-dropdown-search">
                                <input
                                    ref={(el) => (searchInputRef = el)}
                                    type="text"
                                    class="custom-dropdown-search-input"
                                    placeholder="Search..."
                                    value={searchQuery()}
                                    onInput={(e) => setSearchQuery(e.currentTarget.value)}
                                    onKeyDown={handleSearchKeyDown}
                                />
                            </div>
                        </Show>
                        <div class="custom-dropdown-options">
                            <For each={filteredOptions()}>
                                {(option) => (
                                    <div
                                        class={`custom-dropdown-item ${option.value === props.value ? 'active' : ''}`}
                                        onClick={() => handleSelect(option.value)}
                                    >
                                        {option.label}
                                    </div>
                                )}
                            </For>
                            <Show when={filteredOptions().length === 0}>
                                <div class="custom-dropdown-empty">No matches found</div>
                            </Show>
                        </div>
                    </div>
                </Portal>
            </Show>
        </div>
    );
}
