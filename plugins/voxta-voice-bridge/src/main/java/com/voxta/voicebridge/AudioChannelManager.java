package com.voxta.voicebridge;

import de.maxhenkel.voicechat.api.VoicechatServerApi;
import de.maxhenkel.voicechat.api.audiochannel.EntityAudioChannel;
import de.maxhenkel.voicechat.api.opus.OpusEncoder;
import org.bukkit.entity.Player;

import javax.sound.sampled.AudioFormat;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Manages per-bot SVC audio channels.
 * Receives raw PCM audio, resamples to 48kHz mono 16-bit,
 * encodes with Opus, and sends through EntityAudioChannel.
 */
public class AudioChannelManager {

    // SVC uses 48kHz, 960 samples per 20ms frame
    private static final int SVC_SAMPLE_RATE = 48000;
    private static final int FRAME_SIZE = 960; // 20ms at 48kHz

    private final VoxtaVoiceBridge bridge;
    private VoicechatServerApi serverApi;

    // Bot UUID → active audio channel
    private final Map<UUID, EntityAudioChannel> channels = new ConcurrentHashMap<>();

    // Bot UUID → opus encoder
    private final Map<UUID, OpusEncoder> encoders = new ConcurrentHashMap<>();

    // Host UUID to exclude from hearing bot audio via SVC
    private final Map<UUID, UUID> hostExclusions = new ConcurrentHashMap<>();

    public AudioChannelManager(VoxtaVoiceBridge bridge) {
        this.bridge = bridge;
    }

    /** Called when SVC server API becomes available */
    public void onVoicechatReady(VoicechatServerApi api) {
        this.serverApi = api;
        bridge.getLogger().info("AudioChannelManager ready");
    }

    /**
     * Register a host player to be excluded from hearing a bot's SVC audio.
     * The host hears the bot through the Electron app's SpatialAudioEngine instead.
     */
    public void setHostExclusion(UUID botUuid, UUID hostUuid) {
        hostExclusions.put(botUuid, hostUuid);
        bridge.getLogger().info("Host exclusion set: bot " + botUuid + " → host " + hostUuid);
    }

    /**
     * Send raw PCM audio data for a bot player.
     * The audio is resampled to 48kHz if needed, split into 20ms Opus frames,
     * and sent through the bot's EntityAudioChannel.
     *
     * @param botPlayer  The bot's Player entity on the server
     * @param pcmData    Raw PCM audio (16-bit signed, mono)
     * @param sampleRate Source sample rate (e.g. 24000)
     */
    // Track frames sent for periodic logging
    private int totalFramesSent = 0;

    public void sendAudio(Player botPlayer, byte[] pcmData, int sampleRate) {
        if (serverApi == null) {
            bridge.getLogger().warning("SVC API not ready — dropping audio from " + botPlayer.getName()
                    + " (" + pcmData.length + " bytes)");
            return;
        }

        UUID botUuid = botPlayer.getUniqueId();

        // Get or create the audio channel for this bot
        EntityAudioChannel channel = channels.computeIfAbsent(botUuid, uuid -> {
            bridge.getLogger().info("Creating SVC audio channel for bot: " + botPlayer.getName()
                    + " (UUID: " + uuid + ")");
            try {
                var serverPlayer = serverApi.fromServerPlayer(botPlayer);
                EntityAudioChannel ch = serverApi.createEntityAudioChannel(uuid, serverPlayer);
                if (ch != null) {
                    ch.setCategory("voxta");
                    ch.setDistance(32); // Default — will be synced with maxDistance setting
                    bridge.getLogger().info("SVC audio channel created successfully for " + botPlayer.getName());
                } else {
                    bridge.getLogger().severe("serverApi.createEntityAudioChannel returned null for " + botPlayer.getName());
                }
                return ch;
            } catch (Exception e) {
                bridge.getLogger().severe("Exception creating SVC audio channel for " + botPlayer.getName()
                        + ": " + e.getMessage());
                e.printStackTrace();
                return null;
            }
        });

        if (channel == null) {
            bridge.getLogger().warning("No audio channel available for bot: " + botPlayer.getName()
                    + " — dropping " + pcmData.length + " bytes");
            return;
        }

        // Get or create Opus encoder for this bot
        OpusEncoder encoder = encoders.computeIfAbsent(botUuid, uuid -> {
            try {
                OpusEncoder enc = serverApi.createEncoder();
                if (enc != null) {
                    bridge.getLogger().info("Opus encoder created for " + botPlayer.getName());
                } else {
                    bridge.getLogger().severe("serverApi.createEncoder() returned null");
                }
                return enc;
            } catch (Exception e) {
                bridge.getLogger().severe("Exception creating Opus encoder: " + e.getMessage());
                e.printStackTrace();
                return null;
            }
        });

        if (encoder == null) {
            bridge.getLogger().warning("No Opus encoder available for bot: " + botPlayer.getName());
            return;
        }

        // Resample to 48kHz if needed
        short[] samples = bytesToShorts(pcmData);
        if (sampleRate != SVC_SAMPLE_RATE) {
            int originalLength = samples.length;
            samples = resample(samples, sampleRate, SVC_SAMPLE_RATE);
            bridge.getLogger().info("Resampled " + sampleRate + "Hz -> " + SVC_SAMPLE_RATE + "Hz: "
                    + originalLength + " -> " + samples.length + " samples");
        }

        // Split into 20ms frames (960 samples at 48kHz) and send
        int framesSent = 0;
        for (int offset = 0; offset + FRAME_SIZE <= samples.length; offset += FRAME_SIZE) {
            short[] frame = new short[FRAME_SIZE];
            System.arraycopy(samples, offset, frame, 0, FRAME_SIZE);
            try {
                byte[] encoded = encoder.encode(frame);
                channel.send(encoded);
                framesSent++;
            } catch (Exception e) {
                bridge.getLogger().severe("Failed to encode/send frame " + framesSent
                        + " for " + botPlayer.getName() + ": " + e.getMessage());
                break;
            }
        }

        totalFramesSent += framesSent;
        int leftoverSamples = samples.length % FRAME_SIZE;
        bridge.getLogger().info("Sent " + framesSent + " Opus frames for " + botPlayer.getName()
                + " (total: " + totalFramesSent + ", leftover: " + leftoverSamples + " samples)");
    }

    /** Set the SVC audio channel distance for a bot */
    public void setDistance(UUID botUuid, int distance) {
        EntityAudioChannel channel = channels.get(botUuid);
        if (channel != null) {
            channel.setDistance(distance);
        }
    }

    /** Clean up a bot's audio channel and encoder */
    public void removeBot(UUID botUuid) {
        channels.remove(botUuid);
        OpusEncoder encoder = encoders.remove(botUuid);
        if (encoder != null) {
            encoder.close();
        }
        hostExclusions.remove(botUuid);
        bridge.getLogger().info("Removed audio channel for bot: " + botUuid);
    }

    /** Clean up all channels on plugin disable */
    public void shutdown() {
        for (OpusEncoder encoder : encoders.values()) {
            encoder.close();
        }
        encoders.clear();
        channels.clear();
        hostExclusions.clear();
    }

    /** Convert 16-bit PCM byte array (little-endian) to short array */
    private static short[] bytesToShorts(byte[] bytes) {
        short[] shorts = new short[bytes.length / 2];
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(shorts);
        return shorts;
    }

    /** Convert short array back to 16-bit PCM byte array (little-endian) */
    private static byte[] shortsToBytes(short[] shorts) {
        byte[] bytes = new byte[shorts.length * 2];
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().put(shorts);
        return bytes;
    }

    /** Simple linear interpolation resample */
    private static short[] resample(short[] input, int fromRate, int toRate) {
        double ratio = (double) fromRate / toRate;
        int outputLength = (int) (input.length / ratio);
        short[] output = new short[outputLength];

        for (int i = 0; i < outputLength; i++) {
            double srcIndex = i * ratio;
            int idx = (int) srcIndex;
            double frac = srcIndex - idx;

            if (idx + 1 < input.length) {
                output[i] = (short) (input[idx] * (1 - frac) + input[idx + 1] * frac);
            } else if (idx < input.length) {
                output[i] = input[idx];
            }
        }

        return output;
    }
}
