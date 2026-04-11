import type { CharacterInfo, ChatListItem, ScenarioInfo } from '../shared/ipc-types';

const CLIENT_NAME = 'Voxta.Minecraft';

/**
 * Fetch full character details from Voxta REST API, including MC config detection.
 */
export async function fetchCharacterDetails(
    voxtaUrl: string,
    voxtaApiKey: string | null,
): Promise<CharacterInfo[]> {
    const baseUrl = voxtaUrl.replace(/\/hub\/?$/, '');
    const headers: Record<string, string> = {};
    if (voxtaApiKey) {
        headers['Authorization'] = `Bearer ${voxtaApiKey}`;
    }
    const res = await fetch(`${baseUrl}/api/characters/?assistant=true`, { headers });
    if (!res.ok) {
        console.error(`[Voxta] Failed to fetch characters: ${res.status}`);
        return [];
    }

    const data = (await res.json()) as { characters: Array<{ id: string; name: string }> };

    // Parallel-fetch full details to check for Minecraft Companion app config
    return Promise.all(
        data.characters.map(async (c) => {
            try {
                const detailRes = await fetch(`${baseUrl}/api/characters/${c.id}`, { headers });
                if (detailRes.ok) {
                    const detail = (await detailRes.json()) as {
                        appConfiguration?: Record<string, Record<string, string>>;
                    };
                    const mcConfig = detail.appConfiguration?.[CLIENT_NAME];
                    const enabledValue = mcConfig?.['enabled']?.toLowerCase();
                    const hasMc = enabledValue === 'true' || (mcConfig?.['skin'] != null && mcConfig['skin'] !== '');
                    return { id: c.id, name: c.name, hasMcConfig: hasMc };
                }
            } catch {
                // Ignore individual fetch failures
            }
            return { id: c.id, name: c.name, hasMcConfig: false };
        }),
    );
}

/**
 * Load available scenarios from Voxta REST API.
 */
export async function loadScenarios(
    voxtaUrl: string,
    voxtaApiKey: string | null,
): Promise<ScenarioInfo[]> {
    const baseUrl = voxtaUrl.replace(/\/hub\/?$/, '');
    const headers: Record<string, string> = {};
    if (voxtaApiKey) {
        headers['Authorization'] = `Bearer ${voxtaApiKey}`;
    }
    const res = await fetch(`${baseUrl}/api/scenarios`, { headers });
    if (!res.ok) {
        console.error(`[Voxta] Failed to load scenarios: ${res.status}`);
        return [];
    }
    const data = (await res.json()) as {
        scenarios: Array<{ id: string; name: string; client?: string }>;
    };
    return data.scenarios.map((s) => ({ id: s.id, name: s.name, client: s.client ?? null }));
}

/**
 * Load previous chats for a character from Voxta REST API.
 */
export async function loadChats(
    voxtaUrl: string,
    voxtaApiKey: string | null,
    characterId: string,
): Promise<ChatListItem[]> {
    const baseUrl = voxtaUrl.replace(/\/hub\/?$/, '');
    const headers: Record<string, string> = {};
    if (voxtaApiKey) {
        headers['Authorization'] = `Bearer ${voxtaApiKey}`;
    }
    const res = await fetch(`${baseUrl}/api/chats?characterId=${characterId}`, { headers });
    if (!res.ok) {
        console.error(`[Voxta] Failed to load chats: ${res.status}`);
        return [];
    }
    const data = (await res.json()) as {
        chats: Array<{
            id: string;
            title?: string;
            created: string;
            lastSession?: string;
            lastSessionTimestamp?: string;
            createdTimestamp?: string;
            favorite?: boolean;
            scenarioId?: string;
        }>;
    };
    return data.chats.map((c) => ({
        id: c.id,
        title: c.title ?? null,
        created: c.created,
        lastSession: c.lastSession ?? null,
        lastSessionTimestamp: c.lastSessionTimestamp ?? c.createdTimestamp ?? null,
        favorite: c.favorite ?? false,
        scenarioId: c.scenarioId ?? null,
    }));
}

/**
 * Toggle favorite status on a chat.
 */
export async function favoriteChat(
    voxtaUrl: string,
    voxtaApiKey: string | null,
    chatId: string,
    favorite: boolean,
): Promise<void> {
    const baseUrl = voxtaUrl.replace(/\/hub\/?$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (voxtaApiKey) {
        headers['Authorization'] = `Bearer ${voxtaApiKey}`;
    }
    const res = await fetch(`${baseUrl}/api/chats/${chatId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ favorite }),
    });
    if (!res.ok) {
        console.error(`[Voxta] Failed to toggle favorite: ${res.status}`);
    }
}

/**
 * Delete a chat.
 */
export async function deleteChat(
    voxtaUrl: string,
    voxtaApiKey: string | null,
    chatId: string,
): Promise<void> {
    const baseUrl = voxtaUrl.replace(/\/hub\/?$/, '');
    const headers: Record<string, string> = {};
    if (voxtaApiKey) {
        headers['Authorization'] = `Bearer ${voxtaApiKey}`;
    }
    const res = await fetch(`${baseUrl}/api/chats/${chatId}`, {
        method: 'DELETE',
        headers,
    });
    if (!res.ok) {
        console.error(`[Voxta] Failed to delete chat: ${res.status}`);
    }
}

/**
 * Convert raw errors into user-friendly messages for Voxta/MC connection failures.
 */
export function humanizeError(err: unknown, context: string): string {
    // Build a comprehensive string to search — AggregateError has an empty message
    // but stores error codes in .code and a nested .errors[] array
    let raw: string;
    if (err instanceof Error) {
        raw = err.message || '';
        const errWithCode = err as Error & { code?: string; errors?: Error[] };
        if (errWithCode.code) raw += ` ${errWithCode.code}`;
        if (errWithCode.errors) {
            for (const nested of errWithCode.errors) {
                raw += ` ${nested.message}`;
                if ((nested as Error & { code?: string }).code) {
                    raw += ` ${(nested as Error & { code?: string }).code}`;
                }
            }
        }
    } else {
        raw = String(err);
    }

    // Minecraft connection errors
    if (raw.includes('ECONNREFUSED')) {
        return `Cannot connect to Minecraft server — is the server running and the port correct?`;
    }
    if (raw.includes('ETIMEDOUT') || raw.includes('EHOSTUNREACH')) {
        return `Cannot reach Minecraft server — check the host address and make sure the server is accessible.`;
    }
    if (raw.includes('ENOTFOUND')) {
        return `Server address not found — check the host name is correct.`;
    }
    // Version mismatch (Mineflayer reports server vs client version)
    const versionMatch = raw.match(/server is version ([\d.]+)/i);
    if (versionMatch) {
        return `Version mismatch — the server runs ${versionMatch[1]}. Set "Game Version" to ${versionMatch[1]} and try again.`;
    }

    // Voxta connection errors
    if (raw.includes('Failed to complete negotiation') || raw.includes('Status code')) {
        return `Cannot connect to Voxta — is the server running at the specified URL?`;
    }
    if (raw.includes('authentication') || raw.includes('401') || raw.includes('403')) {
        return `Voxta authentication failed — check your API key.`;
    }

    // Generic
    if (raw.includes('timed out')) {
        return `${context} timed out — try again.`;
    }

    return `${context}: ${raw}`;
}
