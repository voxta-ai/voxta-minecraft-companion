/**
 * Bidirectional mapping between Voxta names and Minecraft usernames.
 * Ensures actions always resolve the correct player/bot entity,
 * even with multiple bots in the same world.
 */
export type NameRole = 'user' | 'bot';

export class NameRegistry {
    // voxtaName (lowercase) → mcUsername
    private readonly voxtaToMc = new Map<string, string>();
    // mcUsername (lowercase) → voxtaName
    private readonly mcToVoxta = new Map<string, string>();
    // mcUsername (lowercase) → role (user vs bot). Lets perception/event code
    // label nearby players and disambiguate chat without extra params.
    private readonly mcRoles = new Map<string, NameRole>();

    /** Register a name pair (e.g. "Lapiro" ↔ "Player", "Inferna" ↔ "VoxtaBot") */
    register(voxtaName: string, mcUsername: string, role: NameRole = 'bot'): void {
        this.voxtaToMc.set(voxtaName.toLowerCase(), mcUsername);
        this.mcToVoxta.set(mcUsername.toLowerCase(), voxtaName);
        this.mcRoles.set(mcUsername.toLowerCase(), role);
    }

    /** Returns true if the given MC username belongs to the user (the human player). */
    isUserMc(mcUsername: string): boolean {
        return this.mcRoles.get(mcUsername.toLowerCase()) === 'user';
    }

    /** Returns true if the given MC username belongs to a bot (companion AI). */
    isBotMc(mcUsername: string): boolean {
        return this.mcRoles.get(mcUsername.toLowerCase()) === 'bot';
    }

    /**
     * Resolve a name (could be Voxta or MC) to an MC username.
     * Returns the original name if no mapping exists.
     */
    resolveToMc(name: string): string {
        return this.voxtaToMc.get(name.toLowerCase()) ?? name;
    }

    /**
     * Resolve an MC username to a Voxta name.
     * Returns the original name if no mapping exists.
     */
    resolveToVoxta(mcName: string): string {
        return this.mcToVoxta.get(mcName.toLowerCase()) ?? mcName;
    }

    /**
     * Replace all known MC names in a text string with their Voxta names.
     * Useful for translating server messages like "Teleported VoxtaBot to Emptyngton".
     */
    resolveNamesInText(text: string): string {
        let result = text;
        for (const [mcLower, voxtaName] of this.mcToVoxta.entries()) {
            // Case-insensitive replacement of the MC name
            const regex = new RegExp(mcLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            result = result.replace(regex, voxtaName);
        }
        return result;
    }

    /** Returns true if the given MC username is registered (i.e. belongs to a known bot, not a human player) */
    hasMcUsername(mcUsername: string): boolean {
        return this.mcToVoxta.has(mcUsername.toLowerCase());
    }

    clear(): void {
        this.voxtaToMc.clear();
        this.mcToVoxta.clear();
    }
}
