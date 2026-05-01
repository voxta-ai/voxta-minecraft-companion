package com.voxta.voicebridge;

import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.plugin.messaging.Messenger;

/**
 * Main plugin class for the Voxta Voice Bridge.
 *
 * Receives TTS audio from the Voxta Minecraft Companion via plugin messaging
 * channel and (when Simple Voice Chat is installed) plays it through SVC so
 * all nearby players can hear the bot.
 *
 * IMPORTANT: this class deliberately does NOT import any
 * de.maxhenkel.voicechat.* types. Paper's PluginClassLoader eagerly verifies
 * the main plugin class with Class.forName(..., true, ...) — if the constant
 * pool of THIS class references SVC types, the plugin fails to load with
 * NoClassDefFoundError when SVC is missing. All SVC-touching code is
 * therefore reachable only via SvcIntegration, which is loaded reflectively
 * after we confirm SVC is present via PluginManager.
 */
public class VoxtaVoiceBridge extends JavaPlugin {

    public static final String CHANNEL = "voxta:audio";

    private static VoxtaVoiceBridge instance;

    /** AudioBridge is an SVC-free interface; the actual implementation
     *  (AudioChannelManager) lives in the SvcIntegration code path. */
    private AudioBridge audioBridge;

    public static VoxtaVoiceBridge getInstance() {
        return instance;
    }

    public AudioBridge getAudioBridge() {
        return audioBridge;
    }

    /** Called from SvcIntegration.setup once SVC is confirmed present. */
    public void setAudioBridge(AudioBridge bridge) {
        this.audioBridge = bridge;
    }

    @Override
    public void onEnable() {
        instance = this;

        // Plugin messaging channel — works with or without SVC.
        Messenger messenger = getServer().getMessenger();
        messenger.registerIncomingPluginChannel(this, CHANNEL, new AudioPacketListener(this));
        messenger.registerOutgoingPluginChannel(this, CHANNEL);

        // Conditionally bring up SVC integration. Using PluginManager keeps
        // this method's bytecode free of SVC class references, so VoxtaVoiceBridge
        // verifies cleanly even when SVC is absent.
        if (getServer().getPluginManager().getPlugin("voicechat") != null) {
            try {
                Class.forName("com.voxta.voicebridge.SvcIntegration")
                        .getMethod("setup", VoxtaVoiceBridge.class)
                        .invoke(null, this);
            } catch (ReflectiveOperationException e) {
                getLogger().severe("Failed to set up Simple Voice Chat integration: " + e.getMessage());
                Throwable cause = e.getCause() != null ? e.getCause() : e;
                cause.printStackTrace();
            }
        } else {
            getLogger().info(
                "Simple Voice Chat plugin not detected — voice bridge will respond to "
                + "the companion's version handshake but cannot forward audio. "
                + "Install Simple Voice Chat to enable in-game voice."
            );
        }

        getLogger().info("Voxta Voice Bridge enabled — listening on channel: " + CHANNEL);
    }

    @Override
    public void onDisable() {
        Messenger messenger = getServer().getMessenger();
        messenger.unregisterIncomingPluginChannel(this, CHANNEL);
        messenger.unregisterOutgoingPluginChannel(this, CHANNEL);

        if (audioBridge != null) {
            audioBridge.shutdown();
        }

        getLogger().info("Voxta Voice Bridge disabled");
    }
}
