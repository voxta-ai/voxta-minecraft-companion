package com.voxta.voicebridge;

import de.maxhenkel.voicechat.api.BukkitVoicechatService;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.plugin.messaging.Messenger;

/**
 * Main plugin class for the Voxta Voice Bridge.
 * Receives TTS audio from the Voxta Minecraft Companion via plugin messaging channel
 * and plays it through Simple Voice Chat so all nearby players can hear the bot.
 */
public class VoxtaVoiceBridge extends JavaPlugin {

    public static final String CHANNEL = "voxta:audio";

    // Static reference so VoxtaVoicechatPlugin can access the bridge instance
    private static VoxtaVoiceBridge instance;

    private AudioChannelManager audioChannelManager;

    public static VoxtaVoiceBridge getInstance() {
        return instance;
    }

    @Override
    public void onEnable() {
        instance = this;

        // Register the plugin messaging channel
        Messenger messenger = getServer().getMessenger();
        messenger.registerIncomingPluginChannel(this, CHANNEL, new AudioPacketListener(this));
        messenger.registerOutgoingPluginChannel(this, CHANNEL);

        // AudioChannelManager is initialized here; SVC wires into it via VoxtaVoicechatPlugin
        audioChannelManager = new AudioChannelManager(this);

        // Register with Simple Voice Chat via BukkitVoicechatService (Bukkit service registry)
        // This replaces the META-INF/services ServiceLoader approach which doesn't work
        // with Paper's PluginRemapper (it rewrites JARs and breaks ServiceLoader discovery)
        BukkitVoicechatService voicechatService = getServer().getServicesManager()
                .load(BukkitVoicechatService.class);
        if (voicechatService != null) {
            voicechatService.registerPlugin(new VoxtaVoicechatPlugin());
            getLogger().info("Registered with Simple Voice Chat via BukkitVoicechatService");
        } else {
            getLogger().warning("BukkitVoicechatService not available — is Simple Voice Chat installed?");
        }

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
}
