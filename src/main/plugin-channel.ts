import type { Bot as MineflayerBot } from 'mineflayer';

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

let chunkIdCounter = 0;

/** Get the raw protocol client from a mineflayer bot */
function getClient(bot: MineflayerBot): { write: (name: string, data: Record<string, unknown>) => void } {
    const client = (bot as unknown as { _client: { write: (name: string, data: Record<string, unknown>) => void } })._client;
    if (!client) {
        throw new Error('Bot._client is not available — bot may not be connected');
    }
    return client;
}

/** Register the voxta:audio plugin channel with the server */
export function registerPluginChannel(bot: MineflayerBot): void {
    const client = getClient(bot);
    // In Minecraft 1.13+, channel registration is done via minecraft:register
    const channelBuf = Buffer.from(CHANNEL, 'utf-8');
    client.write('custom_payload', {
        channel: 'minecraft:register',
        data: channelBuf,
    });
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
