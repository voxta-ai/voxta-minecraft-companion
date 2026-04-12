import { createSignal, createMemo, createEffect, Show } from 'solid-js';
import type { CharacterInfo, ScenarioInfo } from '../../shared/ipc-types';
import { voxtaInfo, refreshCharacters } from '../stores/connection-store';
import CustomDropdown from './CustomDropdown';

interface CharacterSelectorProps {
    selectedCharacterId: () => string | null;
    setSelectedCharacterId: (id: string | null) => void;
    selectedCharacterId2: () => string | null;
    setSelectedCharacterId2: (id: string | null) => void;
    onScenariosLoaded: (scenarios: ScenarioInfo[]) => void;
    onMcOnlyChange: (checked: boolean) => void;
}

export default function CharacterSelector(props: CharacterSelectorProps) {
    const [refreshing, setRefreshing] = createSignal(false);
    const [mcOnly, setMcOnly] = createSignal(false);

    // Track last-chat timestamp per character for sorting
    const [charLastChat, setCharLastChat] = createSignal<Record<string, string>>({});

    // Persist mcOnly from localStorage
    createEffect(() => {
        try {
            const raw = localStorage.getItem('voxta-mc-config');
            if (raw) {
                const config = JSON.parse(raw);
                if (config.mcOnly) setMcOnly(true);
            }
        } catch { /* ignore */ }
    });

    // Fetch all chats to build a sort order by the most recent chat
    createEffect(() => {
        if (voxtaInfo.characters.length > 0) {
            const map: Record<string, string> = {};
            const promises = voxtaInfo.characters.map(async (char) => {
                const chats = await window.api.loadChats(char.id);
                if (chats.length > 0) {
                    map[char.id] = chats[0].lastSessionTimestamp ?? '';
                }
            });
            Promise.all(promises)
                .then(() => setCharLastChat(map))
                .catch(() => { /* ignore */ });
        }
    });

    // Sort characters: recent chats first
    const sortedCharacters = createMemo((): CharacterInfo[] => {
        const map = charLastChat();
        return [...voxtaInfo.characters].sort((a, b) => {
            const aTime = map[a.id] ?? '';
            const bTime = map[b.id] ?? '';
            if (aTime && !bTime) return -1;
            if (!aTime && bTime) return 1;
            if (aTime && bTime) return bTime.localeCompare(aTime);
            return 0;
        });
    });

    const displayCharacters = createMemo((): CharacterInfo[] => {
        const all = sortedCharacters();
        if (!mcOnly()) return all;
        return all.filter((c) => c.hasMcConfig);
    });

    const handleRefresh = async (): Promise<void> => {
        setRefreshing(true);
        try {
            await Promise.all([
                refreshCharacters(),
                window.api.loadScenarios().then((list) => props.onScenariosLoaded(list)),
            ]);
        } catch (err) {
            console.error('Failed to refresh:', err);
        } finally {
            setRefreshing(false);
        }
    };

    const handleMcOnlyChange = (checked: boolean) => {
        setMcOnly(checked);
        props.onMcOnlyChange(checked);
        try {
            const raw = localStorage.getItem('voxta-mc-config');
            const config = raw ? JSON.parse(raw) : {};
            config.mcOnly = checked;
            localStorage.setItem('voxta-mc-config', JSON.stringify(config));
        } catch { /* ignore */ }
    };

    return (
        <>
            <div class="field full-width">
                <div class="field-label-row">
                    <label>Voxta Character</label>
                    <div class="field-label-row-actions">
                        <button
                            class="char-refresh-btn"
                            title="Refresh characters and scenarios"
                            disabled={refreshing()}
                            onClick={handleRefresh}
                        >
                            {refreshing() ? '⏳' : '🔄'}
                        </button>
                        <Show when={sortedCharacters().some((c) => c.hasMcConfig)}>
                            <label class="mc-only-toggle" title="Show only characters with Minecraft Companion configured">
                                <input
                                    type="checkbox"
                                    checked={mcOnly()}
                                    onChange={(e) => handleMcOnlyChange(e.currentTarget.checked)}
                                />
                                <span class="mc-only-label">⛏️ MC only</span>
                            </label>
                        </Show>
                    </div>
                </div>
                <CustomDropdown
                    options={displayCharacters().map((char) => ({
                        value: char.id,
                        label: `${char.hasMcConfig ? '⛏️ ' : ''}${char.name}${char.id === voxtaInfo.defaultAssistantId ? ' ⭐' : ''}`,
                    }))}
                    value={props.selectedCharacterId()}
                    onChange={(val) => {
                        props.setSelectedCharacterId(val);
                    }}
                    placeholder="Select a character..."
                />
            </div>

            <div class="field full-width">
                <label>Second Companion (Optional)</label>
                <CustomDropdown
                    options={[
                        { value: '', label: 'None' },
                        ...displayCharacters()
                            .filter((char) => char.id !== props.selectedCharacterId())
                            .map((char) => ({
                                value: char.id,
                                label: `${char.hasMcConfig ? '⛏️ ' : ''}${char.name}`,
                            })),
                    ]}
                    value={props.selectedCharacterId2() ?? ''}
                    onChange={(val) => {
                        props.setSelectedCharacterId2(val || null);
                    }}
                    placeholder="Select a second character..."
                />
            </div>
        </>
    );
}
