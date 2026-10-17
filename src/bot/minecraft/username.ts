// Minecraft only accepts usernames of 3-16 characters made of letters, digits and underscores.
// Anything else (a space, an accent, an apostrophe, an emoji) gets the bot kicked during login
// with "Invalid characters in username", so character names are converted before connecting.

const MIN_LENGTH = 3;
const MAX_LENGTH = 16;

export function toMinecraftUsername(name: string, fallback: string): string {
    const cleaned = name
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[\s-]+/g, '_')
        .replace(/[^A-Za-z0-9_]/g, '')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, MAX_LENGTH);

    if (cleaned.length === 0) return fallback;
    if (cleaned.length < MIN_LENGTH) return `${cleaned}Bot`;
    return cleaned;
}

/** Second bot's username, made distinct from the first so the server doesn't reject a duplicate login. */
export function toSecondMinecraftUsername(name: string, firstUsername: string): string {
    const username = toMinecraftUsername(name, 'Companion2');
    if (username.toLowerCase() !== firstUsername.toLowerCase()) return username;
    return `${username.slice(0, MAX_LENGTH - 1)}2`;
}
