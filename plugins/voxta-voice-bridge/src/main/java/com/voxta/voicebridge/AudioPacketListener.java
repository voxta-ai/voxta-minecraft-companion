package com.voxta.voicebridge;

import org.bukkit.entity.Player;
import org.bukkit.plugin.messaging.PluginMessageListener;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Listens for audio data sent from the Voxta Minecraft Companion via plugin messaging channel.
 *
 * Packet protocol:
 *
 * AUDIO packet (type=0x01):
 *   [1 byte]  type = 0x01
 *   [2 bytes] chunk ID (uint16, groups parts of the same audio clip)
 *   [2 bytes] part index (uint16, 0-based)
 *   [2 bytes] total parts (uint16)
 *   [4 bytes] sample rate (uint32, e.g. 24000)
 *   [remaining] raw PCM data (16-bit signed LE mono)
 *
 * CONTROL packet (type=0x02):
 *   [1 byte]  type = 0x02
 *   [1 byte]  command:
 *       0x01 = register host (followed by UTF-8 host username)
 *       0x02 = set distance (followed by uint16 distance)
 *       0x03 = stop/clear audio
 */
public class AudioPacketListener implements PluginMessageListener {

    private static final byte TYPE_AUDIO = 0x01;
    private static final byte TYPE_CONTROL = 0x02;

    private static final byte CMD_REGISTER_HOST = 0x01;
    private static final byte CMD_SET_DISTANCE = 0x02;
    private static final byte CMD_STOP = 0x03;

    private final VoxtaVoiceBridge bridge;

    // Chunk reassembly: sender UUID + chunk ID → parts collected
    private final Map<String, ChunkAssembly> pendingChunks = new ConcurrentHashMap<>();

    public AudioPacketListener(VoxtaVoiceBridge bridge) {
        this.bridge = bridge;
    }

    @Override
    public void onPluginMessageReceived(String channel, Player sender, byte[] data) {
        if (!channel.equals(VoxtaVoiceBridge.CHANNEL) || data.length < 1) {
            return;
        }

        byte type = data[0];

        switch (type) {
            case TYPE_AUDIO -> handleAudioPacket(sender, data);
            case TYPE_CONTROL -> handleControlPacket(sender, data);
            default -> bridge.getLogger().warning("Unknown packet type: " + type + " from " + sender.getName());
        }
    }

    // Track first audio received for a one-time confirmation log
    private boolean firstAudioReceived = false;

    private void handleAudioPacket(Player sender, byte[] data) {
        // Minimum: type(1) + chunkId(2) + partIndex(2) + totalParts(2) + sampleRate(4) = 11
        if (data.length < 11) {
            bridge.getLogger().warning("Audio packet too short (" + data.length + " bytes) from " + sender.getName());
            return;
        }

        ByteBuffer buf = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN);
        buf.get(); // skip type byte

        int chunkId = Short.toUnsignedInt(buf.getShort());
        int partIndex = Short.toUnsignedInt(buf.getShort());
        int totalParts = Short.toUnsignedInt(buf.getShort());
        int sampleRate = buf.getInt();

        // Remaining bytes are PCM data
        byte[] pcmPart = new byte[buf.remaining()];
        buf.get(pcmPart);

        if (!firstAudioReceived) {
            firstAudioReceived = true;
            bridge.getLogger().info("First audio packet received from " + sender.getName()
                    + " — chunkId=" + chunkId + ", " + sampleRate + "Hz, "
                    + totalParts + " part(s), " + pcmPart.length + " bytes");
        }

        String key = sender.getUniqueId() + ":" + chunkId;

        ChunkAssembly assembly = pendingChunks.computeIfAbsent(key, k ->
                new ChunkAssembly(totalParts, sampleRate)
        );

        assembly.addPart(partIndex, pcmPart);

        if (assembly.isComplete()) {
            pendingChunks.remove(key);
            byte[] fullPcm = assembly.assemble();
            bridge.getLogger().info("Audio chunk " + chunkId + " complete: "
                    + fullPcm.length + " bytes PCM from " + sender.getName()
                    + " — sending to SVC");
            try {
                bridge.getAudioChannelManager().sendAudio(sender, fullPcm, sampleRate);
            } catch (Exception e) {
                bridge.getLogger().severe("Failed to send audio to SVC for " + sender.getName()
                        + ": " + e.getMessage());
                e.printStackTrace();
            }
        }
    }

    private void handleControlPacket(Player sender, byte[] data) {
        if (data.length < 2) return;

        byte command = data[1];
        UUID botUuid = sender.getUniqueId();

        switch (command) {
            case CMD_REGISTER_HOST -> {
                // Read host username from remaining bytes
                if (data.length > 2) {
                    String hostUsername = new String(data, 2, data.length - 2, StandardCharsets.UTF_8);
                    Player hostPlayer = bridge.getServer().getPlayerExact(hostUsername);
                    if (hostPlayer != null) {
                        bridge.getAudioChannelManager().setHostExclusion(botUuid, hostPlayer.getUniqueId());
                        bridge.getLogger().info("Registered host exclusion: " + hostUsername + " for bot " + sender.getName());
                    } else {
                        bridge.getLogger().warning("Host player not found: " + hostUsername);
                    }
                }
            }
            case CMD_SET_DISTANCE -> {
                if (data.length >= 4) {
                    int distance = ByteBuffer.wrap(data, 2, 2).order(ByteOrder.LITTLE_ENDIAN).getShort() & 0xFFFF;
                    bridge.getAudioChannelManager().setDistance(botUuid, distance);
                    bridge.getLogger().info("Set distance for bot " + sender.getName() + ": " + distance);
                }
            }
            case CMD_STOP -> {
                bridge.getAudioChannelManager().removeBot(botUuid);
                bridge.getLogger().info("Stopped audio for bot " + sender.getName());
            }
            default -> bridge.getLogger().warning("Unknown control command: " + command);
        }
    }

    /**
     * Holds parts of a chunked audio clip until all parts arrive.
     */
    private static class ChunkAssembly {
        private final byte[][] parts;
        private final int sampleRate;
        private int receivedCount;
        private int totalBytes;

        ChunkAssembly(int totalParts, int sampleRate) {
            this.parts = new byte[totalParts][];
            this.sampleRate = sampleRate;
            this.receivedCount = 0;
            this.totalBytes = 0;
        }

        void addPart(int index, byte[] data) {
            if (index < parts.length && parts[index] == null) {
                parts[index] = data;
                receivedCount++;
                totalBytes += data.length;
            }
        }

        boolean isComplete() {
            return receivedCount == parts.length;
        }

        byte[] assemble() {
            byte[] result = new byte[totalBytes];
            int offset = 0;
            for (byte[] part : parts) {
                if (part != null) {
                    System.arraycopy(part, 0, result, offset, part.length);
                    offset += part.length;
                }
            }
            return result;
        }
    }
}
