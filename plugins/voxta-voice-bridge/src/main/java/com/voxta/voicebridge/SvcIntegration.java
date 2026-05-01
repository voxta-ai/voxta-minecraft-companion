package com.voxta.voicebridge;

import de.maxhenkel.voicechat.api.BukkitVoicechatService;

/**
 * SVC-side bootstrap. Holds all references to Simple Voice Chat API types so
 * the main plugin class (VoxtaVoiceBridge) stays free of SVC imports and can
 * be loaded by Paper even when SVC isn't installed.
 *
 * VoxtaVoiceBridge.onEnable() loads this class reflectively
 * (Class.forName("com.voxta.voicebridge.SvcIntegration").getMethod("setup", ...))
 * only after confirming via PluginManager that the "voicechat" plugin is loaded.
 * That check uses no SVC types, so it's safe regardless of classpath.
 */
public final class SvcIntegration {

    private SvcIntegration() {
    }

    public static void setup(VoxtaVoiceBridge bridge) {
        // Concrete bridge implementation — its class file references SVC API
        // types (VoicechatServerApi, EntityAudioChannel, OpusEncoder etc.)
        // and is therefore only safe to load from this code path.
        AudioChannelManager mgr = new AudioChannelManager(bridge);
        bridge.setAudioBridge(mgr);

        BukkitVoicechatService service = bridge.getServer().getServicesManager()
                .load(BukkitVoicechatService.class);
        if (service != null) {
            service.registerPlugin(new VoxtaVoicechatPlugin());
            bridge.getLogger().info("Registered with Simple Voice Chat via BukkitVoicechatService");
        } else {
            bridge.getLogger().warning("BukkitVoicechatService not available — SVC integration may not function");
        }
    }
}
