package com.voxta.voicebridge;

import de.maxhenkel.voicechat.api.VoicechatApi;
import de.maxhenkel.voicechat.api.VoicechatPlugin;
import de.maxhenkel.voicechat.api.VoicechatServerApi;
import de.maxhenkel.voicechat.api.events.EventRegistration;

/**
 * Simple Voice Chat plugin integration.
 * Registers with the SVC API and provides access to the server-side voicechat API.
 */
public class VoxtaVoicechatPlugin implements VoicechatPlugin {

    private VoicechatServerApi serverApi;

    /** No-arg constructor required by ServiceLoader (SVC plugin discovery) */
    public VoxtaVoicechatPlugin() {
    }

    @Override
    public String getPluginId() {
        return "voxta-voice-bridge";
    }

    @Override
    public void initialize(VoicechatApi api) {
        VoxtaVoiceBridge bridge = VoxtaVoiceBridge.getInstance();
        if (bridge != null) {
            bridge.getLogger().info("Simple Voice Chat API initialized");
        }
    }

    @Override
    public void registerEvents(EventRegistration registration) {
        registration.registerEvent(de.maxhenkel.voicechat.api.events.VoicechatServerStartedEvent.class, event -> {
            serverApi = event.getVoicechat();
            VoxtaVoiceBridge bridge = VoxtaVoiceBridge.getInstance();
            if (bridge != null) {
                bridge.getLogger().info("Simple Voice Chat server ready — audio bridge active");
                bridge.getAudioChannelManager().onVoicechatReady(serverApi);
            }
        });
    }

    public VoicechatServerApi getServerApi() {
        return serverApi;
    }
}
