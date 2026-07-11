// ---- Connection / protocol diagnostics ----
// mineflayer only supports a fixed set of Minecraft versions (mineflayer.testedVersions).
// Pointing it at a newer server (e.g. 26.1 / protocol 775) fails mid-handshake with cryptic
// packet-decode errors: protocol 775 added ~15 serverbound packets that shift every later
// packet ID, but minecraft-data's IDs are wrong for it, so the server misreads the bot's
// packets and kicks it (see mineflayer#3888, minecraft-data#1174).
//
// Without these logs that surfaces as a silent disconnect. This makes the handshake legible:
// the negotiated protocol, every protocol-state transition, and low-level decode errors with
// the exact offending packet name.

import type { Bot } from 'mineflayer';

export function setupConnectionDiagnostics(
    bot: Bot,
    requestedVersion: string,
    supportedVersions: readonly string[],
): void {
    const newest = supportedVersions[supportedVersions.length - 1] ?? 'unknown';
    console.log(
        `[MC Conn] Requested version: ${requestedVersion || '(auto-detect)'} | mineflayer supports up to ${newest}`,
    );
    if (requestedVersion && supportedVersions.length > 0 && !supportedVersions.includes(requestedVersion)) {
        console.warn(
            `[MC Conn] WARNING: "${requestedVersion}" is NOT in mineflayer's supported versions ` +
                `(${supportedVersions.join(', ')}). Expect handshake/packet-decode failures until mineflayer adds it.`,
        );
    }

    const client = bot._client;

    client.on('connect', () => {
        console.log(
            `[MC Conn] TCP connected — using protocol ${client.protocolVersion} (mc ${client.version})`,
        );
    });

    // Handshake progresses handshaking -> login -> configuration -> play. An unsupported
    // version typically stalls or dies in login/configuration.
    client.on('state', (newState: string, oldState: string) => {
        console.log(`[MC Conn] Protocol state: ${oldState} -> ${newState}`);
    });

    // Low-level protocol errors bubble here with the exact packet name, e.g.
    // "Failed to decode packet 'clientbound/minecraft:...'" — the smoking gun for
    // shifted/incorrect packet IDs on an unsupported version.
    client.on('error', (err: Error) => {
        console.error(`[MC Conn] Protocol client error: ${err.stack ?? err.message}`);
    });
}
