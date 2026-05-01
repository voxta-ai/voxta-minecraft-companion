import type { Bot as MineflayerBot } from 'mineflayer';
import { getClient } from '../bot/minecraft/mineflayer-types';

/**
 * Handles communication with the Voxta Voice Bridge Paper plugin
 * via Minecraft's plugin messaging channel system.
 *
 * Protocol matches AudioPacketListener.java on the server side:
 *
 * AUDIO packet (type=0x01):
 *   [1 byte]  type = 0x01
 *   [2 bytes] chunk ID (uint16 LE)
 *   [2 bytes] part index (uint16 LE)
 *   [2 bytes] total parts (uint16 LE)
 *   [4 bytes] sample rate (uint32 LE)
 *   [remaining] raw PCM data (16-bit signed LE mono)
 *
 * CONTROL packet (type=0x02):
 *   [1 byte]  type = 0x02
 *   [1 byte]  command
 *   [remaining] command-specific data
 */

const CHANNEL = 'voxta:audio';
const MAX_PAYLOAD = 32000; // Stay under Minecraft's 32KB plugin channel limit
const HEADER_SIZE = 11; // type(1) + chunkId(2) + partIndex(2) + totalParts(2) + sampleRate(4)
const MAX_PCM_PER_PACKET = MAX_PAYLOAD - HEADER_SIZE;

const TYPE_AUDIO = 0x01;
const TYPE_CONTROL = 0x02;
const CMD_REGISTER_HOST = 0x01;
const CMD_SET_DISTANCE = 0x02;
const CMD_STOP = 0x03;
const CMD_HELLO = 0x04;
const CMD_VERSION = 0x05;

/** Plugin version we expect to find on the server. Bump in lockstep with
 *  plugins/voxta-voice-bridge/build.gradle.kts so users on external Minecraft
 *  servers get a clear notice when their plugins folder needs updating. */
export const EXPECTED_VOICE_BRIDGE_VERSION = '1.0.1';

/** How long to wait for a CMD_VERSION response before warning the user that
 *  the plugin is missing or out-of-date. */
const VERSION_HANDSHAKE_TIMEOUT_MS = 4000;

let chunkIdCounter = 0;

/** Register the voxta:audio plugin channel with the server.
 *  Uses mineflayer/minecraft-protocol's typed channel API which (a) sends a
 *  properly-formatted minecraft:register packet (cstring-encoded) and
 *  (b) hooks the per-channel emission so listeners on `client.on(CHANNEL, ...)`
 *  receive incoming messages on this channel. */
export function registerPluginChannel(bot: MineflayerBot): void {
    const client = getClient(bot) as unknown as {
        registerChannel: (name: string, parser: unknown, custom: boolean) => void;
    };
    client.registerChannel(CHANNEL, undefined, true);
    console.log(`[PluginChannel] Registered channel: ${CHANNEL} for bot ${bot.username}`);
}

/**
 * Send raw PCM audio data through the plugin channel.
 * Automatically chunks data into packets that fit within the 32KB limit.
 *
 * @param bot        The mineflayer bot instance
 * @param pcmData    Raw PCM audio bytes (16-bit signed LE mono)
 * @param sampleRate Source sample rate (e.g. 24000)
 */
export function sendAudioData(bot: MineflayerBot, pcmData: Buffer, sampleRate: number): void {
    const client = getClient(bot);
    const chunkId = (chunkIdCounter++) & 0xFFFF; // Wrap at 65535

    const totalParts = Math.ceil(pcmData.length / MAX_PCM_PER_PACKET);
    console.log(
        `[PluginChannel] Sending audio: chunkId=${chunkId}, ${pcmData.length} bytes PCM, ` +
        `${sampleRate}Hz, ${totalParts} packet(s) → ${bot.username}`,
    );

    for (let i = 0; i < totalParts; i++) {
        const offset = i * MAX_PCM_PER_PACKET;
        const end = Math.min(offset + MAX_PCM_PER_PACKET, pcmData.length);
        const pcmSlice = pcmData.subarray(offset, end);

        const packet = Buffer.alloc(HEADER_SIZE + pcmSlice.length);
        packet.writeUInt8(TYPE_AUDIO, 0);
        packet.writeUInt16LE(chunkId, 1);
        packet.writeUInt16LE(i, 3);
        packet.writeUInt16LE(totalParts, 5);
        packet.writeUInt32LE(sampleRate, 7);
        pcmSlice.copy(packet, HEADER_SIZE);

        try {
            client.write('custom_payload', {
                channel: CHANNEL,
                data: packet,
            });
        } catch (err) {
            console.error(`[PluginChannel] Failed to send packet ${i + 1}/${totalParts} for chunk ${chunkId}:`, err);
            return; // Don't send remaining parts if one fails
        }
    }
}

/** Send control packet: register the host player to exclude from SVC audio */
export function sendRegisterHost(bot: MineflayerBot, hostUsername: string): void {
    const client = getClient(bot);
    const userBytes = Buffer.from(hostUsername, 'utf-8');
    const packet = Buffer.alloc(2 + userBytes.length);
    packet.writeUInt8(TYPE_CONTROL, 0);
    packet.writeUInt8(CMD_REGISTER_HOST, 1);
    userBytes.copy(packet, 2);

    client.write('custom_payload', {
        channel: CHANNEL,
        data: packet,
    });
    console.log(`[PluginChannel] Registered host exclusion: ${hostUsername}`);
}

/** Send control packet: set the SVC audio distance for this bot */
export function sendSetDistance(bot: MineflayerBot, distance: number): void {
    const client = getClient(bot);
    const packet = Buffer.alloc(4);
    packet.writeUInt8(TYPE_CONTROL, 0);
    packet.writeUInt8(CMD_SET_DISTANCE, 1);
    packet.writeUInt16LE(distance, 2);

    client.write('custom_payload', {
        channel: CHANNEL,
        data: packet,
    });
    console.log(`[PluginChannel] Set SVC distance: ${distance} blocks for ${bot.username}`);
}

/** Send control packet: stop/clear audio for this bot */
export function sendStopAudio(bot: MineflayerBot): void {
    const client = getClient(bot);
    const packet = Buffer.alloc(2);
    packet.writeUInt8(TYPE_CONTROL, 0);
    packet.writeUInt8(CMD_STOP, 1);

    client.write('custom_payload', {
        channel: CHANNEL,
        data: packet,
    });
    console.log(`[PluginChannel] Sent stop audio for ${bot.username}`);
}

/**
 * Outcome of the version handshake — feeds into a user-facing warning
 * surfaced through the connection panel / chat panel by bot-engine.
 *
 * `svcAvailable` is reported by the plugin (1.0.1+) and tells us whether
 * Simple Voice Chat itself is installed alongside the bridge. Without SVC,
 * audio bridging silently no-ops, so we surface a different warning.
 */
export type VoiceBridgeStatus =
    | { kind: 'ok'; version: string; svcAvailable: boolean }
    | { kind: 'outdated'; version: string; svcAvailable: boolean }
    | { kind: 'missing' };

/**
 * Send CMD_HELLO to the server-side plugin and wait briefly for a
 * CMD_VERSION response. Resolves with:
 *   - 'ok'       — plugin replied with the expected version
 *   - 'outdated' — plugin replied with a different (older) version
 *   - 'missing'  — no response within the timeout (plugin missing or 1.0.0)
 *
 * Old 1.0.0 plugins log "Unknown control command: 4" and don't reply,
 * which is exactly what we want — they fall into the 'missing' branch.
 */
export function checkVoiceBridgeVersion(bot: MineflayerBot): Promise<VoiceBridgeStatus> {
    const client = getClient(bot);

    return new Promise<VoiceBridgeStatus>((resolve) => {
        let resolved = false;
        const finish = (status: VoiceBridgeStatus): void => {
            if (resolved) return;
            resolved = true;
            client.removeListener(CHANNEL, onChannelMessage);
            clearTimeout(timeoutHandle);
            resolve(status);
        };

        // mineflayer/minecraft-protocol emits incoming custom-channel messages
        // as channel-named events when the channel is registered via
        // client.registerChannel(name, parser, true). Argument is the raw
        // Buffer (no parser was registered, so no decoding is applied).
        const onChannelMessage = (data: Buffer): void => {
            console.log(
                `[VoiceBridge debug] ${CHANNEL} message received — ` +
                `len=${data?.length ?? 'undefined'}, ` +
                `firstBytes=${data ? Array.from(data.subarray(0, Math.min(8, data.length))).map((b) => b.toString(16).padStart(2, '0')).join(' ') : 'none'}`,
            );
            // Layout from voxta-voice-bridge 1.0.1+:
            //   [0] TYPE_CONTROL  [1] CMD_VERSION  [2] flags  [3..] utf8 version
            if (!data || data.length < 3) return;
            if (data.readUInt8(0) !== TYPE_CONTROL) return;
            if (data.readUInt8(1) !== CMD_VERSION) return;
            const flags = data.readUInt8(2);
            const svcAvailable = (flags & 0x01) !== 0;
            const version = data.subarray(3).toString('utf8');
            if (version === EXPECTED_VOICE_BRIDGE_VERSION) {
                console.log(`[VoiceBridge] Version OK: ${version} (svcAvailable=${svcAvailable})`);
                finish({ kind: 'ok', version, svcAvailable });
            } else {
                console.warn(`[VoiceBridge] Version mismatch: got "${version}", expected "${EXPECTED_VOICE_BRIDGE_VERSION}"`);
                finish({ kind: 'outdated', version, svcAvailable });
            }
        };

        client.on(CHANNEL, onChannelMessage);

        const timeoutHandle = setTimeout(() => {
            console.warn(
                `[VoiceBridge] No response to CMD_HELLO after ${VERSION_HANDSHAKE_TIMEOUT_MS}ms — ` +
                `plugin may be missing or older than ${EXPECTED_VOICE_BRIDGE_VERSION}`,
            );
            finish({ kind: 'missing' });
        }, VERSION_HANDSHAKE_TIMEOUT_MS);

        const packet = Buffer.alloc(2);
        packet.writeUInt8(TYPE_CONTROL, 0);
        packet.writeUInt8(CMD_HELLO, 1);
        try {
            client.write('custom_payload', { channel: CHANNEL, data: packet });
            console.log(`[VoiceBridge] Sent CMD_HELLO, awaiting version response (${VERSION_HANDSHAKE_TIMEOUT_MS}ms timeout)`);
        } catch (err) {
            console.error('[VoiceBridge] Failed to send CMD_HELLO:', err);
            finish({ kind: 'missing' });
        }
    });
}

/**
 * Extract raw PCM data from a WAV buffer by stripping the header.
 * Returns the PCM data and sample rate.
 */
export function extractPcmFromWav(wavBuffer: Buffer): { pcm: Buffer; sampleRate: number } {
    // Validate minimum WAV header
    if (wavBuffer.length < 44) {
        console.error(`[PluginChannel] WAV buffer too small: ${wavBuffer.length} bytes`);
        throw new Error(`WAV buffer too small: ${wavBuffer.length} bytes`);
    }

    const magic = wavBuffer.toString('ascii', 0, 4);
    if (magic !== 'RIFF') {
        console.error(`[PluginChannel] Not a WAV file — magic: "${magic}" (expected "RIFF")`);
        throw new Error(`Not a WAV file — magic: "${magic}"`);
    }

    // Standard WAV header: sample rate at offset 24
    const sampleRate = wavBuffer.readUInt32LE(24);
    const channels = wavBuffer.readUInt16LE(22);
    const bitsPerSample = wavBuffer.readUInt16LE(34);

    // Find the "data" chunk
    let dataOffset = 12; // Skip RIFF header (12 bytes)
    while (dataOffset < wavBuffer.length - 8) {
        const chunkId = wavBuffer.toString('ascii', dataOffset, dataOffset + 4);
        const chunkSize = wavBuffer.readUInt32LE(dataOffset + 4);
        if (chunkId === 'data') {
            const pcm = wavBuffer.subarray(dataOffset + 8, dataOffset + 8 + chunkSize);
            const durationMs = Math.round((pcm.length / (sampleRate * channels * (bitsPerSample / 8))) * 1000);
            console.log(
                `[PluginChannel] WAV parsed: ${sampleRate}Hz, ${channels}ch, ${bitsPerSample}bit, ` +
                `${pcm.length} bytes PCM (~${durationMs}ms)`,
            );
            return { pcm, sampleRate };
        }
        dataOffset += 8 + chunkSize;
    }

    // Fallback: assume 44-byte header
    const pcm = wavBuffer.subarray(44);
    console.warn(
        `[PluginChannel] WAV "data" chunk not found — using 44-byte header fallback. ` +
        `${sampleRate}Hz, ${channels}ch, ${bitsPerSample}bit, ${pcm.length} bytes PCM`,
    );
    return { pcm, sampleRate };
}
