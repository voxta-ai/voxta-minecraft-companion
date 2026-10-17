import mineflayer from 'mineflayer';
import minecraftData from 'minecraft-data';

// Paper offers every Minecraft release, but the bot can only join the ones mineflayer supports.
// Patch releases share their protocol with a tested version (26.1.2 speaks 26.1's protocol 775),
// so support is decided by protocol number rather than by matching version strings.

function protocolOf(version: string): number | undefined {
    return minecraftData.versionsByMinecraftVersion.pc[version]?.version;
}

export function isBotSupportedVersion(version: string): boolean {
    const protocol = protocolOf(version);
    const oldest = protocolOf(mineflayer.oldestSupportedVersion);
    const newest = protocolOf(mineflayer.latestSupportedVersion);
    if (protocol === undefined || oldest === undefined || newest === undefined) return false;
    return protocol >= oldest && protocol <= newest;
}

function compareVersionsDescending(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/** Stable releases the bot can join, newest first. Pre-releases, RCs and snapshots contain a '-'. */
export function selectServerVersions(paperVersions: string[]): string[] {
    return paperVersions.filter((v) => !v.includes('-') && isBotSupportedVersion(v)).sort(compareVersionsDescending);
}
