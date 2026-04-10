package com.voxta.voicebridge;

import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.plugin.messaging.Messenger;

/**
 * Main plugin class for the Voxta Voice Bridge.
 * Receives TTS audio from the Voxta Minecraft Companion via plugin messaging channel
 * and plays it through Simple Voice Chat so all nearby players can hear the bot.
 */
public class VoxtaVoiceBridge extends JavaPlugin {

    public static final String CHANNEL = "voxta:audio";

    private AudioChannelManager audioChannelManager;
    private VoxtaVoicechatPlugin voicechatPlugin;

    @Override
    public void onEnable() {
        // Register the plugin messaging channel
        Messenger messenger = getServer().getMessenger();
        messenger.registerIncomingPluginChannel(this, CHANNEL, new AudioPacketListener(this));
        messenger.registerOutgoingPluginChannel(this, CHANNEL);

        // SVC integration is initialized when the voicechat API is ready
        voicechatPlugin = new VoxtaVoicechatPlugin(this);
        audioChannelManager = new AudioChannelManager(this);

        getLogger().info("Voxta Voice Bridge enabled — listening on channel: " + CHANNEL);
    }

    @Override
    public void onDisable() {
        Messenger messenger = getServer().getMessenger();
        messenger.unregisterIncomingPluginChannel(this, CHANNEL);
        messenger.unregisterOutgoingPluginChannel(this, CHANNEL);

        if (audioChannelManager != null) {
            audioChannelManager.shutdown();
        }

        getLogger().info("Voxta Voice Bridge disabled");
    }

    public AudioChannelManager getAudioChannelManager() {
        return audioChannelManager;
    }

    public VoxtaVoicechatPlugin getVoicechatPlugin() {
        return voicechatPlugin;
    }
}
