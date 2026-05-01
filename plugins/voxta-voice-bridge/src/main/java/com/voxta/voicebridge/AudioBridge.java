package com.voxta.voicebridge;

import org.bukkit.entity.Player;

import java.util.UUID;

/**
 * Abstraction over Simple Voice Chat audio forwarding so the rest of the
 * plugin can talk to "the SVC layer" without referencing SVC's API classes
 * directly. This lets the main plugin and packet listener load even when
 * SVC isn't installed on the server — only the concrete implementation
 * (AudioChannelManager) imports SVC types, and that class is loaded
 * reflectively from SvcIntegration only when SVC is present.
 */
public interface AudioBridge {
    /** Forward raw PCM audio for the given bot player to nearby SVC clients. */
    void sendAudio(Player botPlayer, byte[] pcmData, int sampleRate);

    /** Mark a host player as excluded from hearing this bot's SVC audio. */
    void setHostExclusion(UUID botUuid, UUID hostUuid);

    /** Update the SVC audio range for a bot's voice channel. */
    void setDistance(UUID botUuid, int distance);

    /** Tear down a bot's audio channel and encoder when it disconnects. */
    void removeBot(UUID botUuid);

    /** Release all resources on plugin disable. */
    void shutdown();
}
