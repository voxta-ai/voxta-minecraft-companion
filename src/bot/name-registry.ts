/**
 * Bidirectional mapping between Voxta names and Minecraft usernames.
 * Ensures actions always resolve the correct player/bot entity,
 * even with multiple bots in the same world.
 */
export class NameRegistry {
    // voxtaName (lowercase) → mcUsername
    private readonly voxtaToMc = new Map<string, string>();
    // mcUsername (lowercase) → voxtaName
    private readonly mcToVoxta = new Map<string, string>();

    /** Register a name pair (e.g. "Lapiro" ↔ "Player", "Inferna" ↔ "VoxtaBot") */
    register(voxtaName: string, mcUsername: string): void {
        this.voxtaToMc.set(voxtaName.toLowerCase(), mcUsername);
        this.mcToVoxta.set(mcUsername.toLowerCase(), voxtaName);
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

    clear(): void {
        this.voxtaToMc.clear();
        this.mcToVoxta.clear();
    }
}
