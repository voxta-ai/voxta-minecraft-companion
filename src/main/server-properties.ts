import type { ServerProperties } from '../shared/ipc-types';

/**
 * Parse a server.properties file content into a key-value object.
 */
export function parseProperties(content: string): ServerProperties {
    const props: ServerProperties = {};
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        props[trimmed.substring(0, eqIdx)] = trimmed.substring(eqIdx + 1);
    }
    return props;
}

/**
 * Update a server.properties file content with new values,
 * preserving comments and ordering.
 */
export function updatePropertiesContent(original: string, updates: ServerProperties): string {
    if (!original.trim()) {
        return Object.entries(updates)
            .map(([key, value]) => `${key}=${value}`)
            .join('\n') + '\n';
    }

    const updatedKeys = new Set<string>();
    const lines = original.split('\n').map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) return line;
        const key = trimmed.substring(0, eqIdx);
        if (key in updates) {
            updatedKeys.add(key);
            return `${key}=${updates[key]}`;
        }
        return line;
    });

    for (const [key, value] of Object.entries(updates)) {
        if (!updatedKeys.has(key)) {
            lines.push(`${key}=${value}`);
        }
    }

    return lines.join('\n');
}
