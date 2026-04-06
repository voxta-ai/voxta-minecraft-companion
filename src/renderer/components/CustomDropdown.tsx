import { createSignal, createMemo, For, Show, onCleanup } from 'solid-js';

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

export default function CustomDropdown(props: CustomDropdownProps) {
    const [isOpen, setIsOpen] = createSignal(false);
    const [searchQuery, setSearchQuery] = createSignal('');
    let containerRef: HTMLDivElement | undefined;
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

    // Close on click outside
    const handleClickOutside = (e: MouseEvent) => {
        if (containerRef && !containerRef.contains(e.target as Node)) {
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
                <div class="custom-dropdown-list">
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
            </Show>
        </div>
    );
}
