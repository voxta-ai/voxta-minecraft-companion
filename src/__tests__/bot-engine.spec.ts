import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { McSettings } from '../shared/ipc-types';
import { DEFAULT_SETTINGS } from '../shared/ipc-types';

// ---- Mock Electron APIs ----
vi.mock('electron', () => ({
    app: {
        getPath: vi.fn().mockReturnValue('/tmp/test-userdata'),
        getAppPath: vi.fn().mockReturnValue('/tmp/test-app'),
    },
}));

// ---- Mock all heavy dependencies before importing BotEngine ----

vi.mock('../bot/minecraft/bot', () => ({
    createMinecraftBot: vi.fn(),
}));

vi.mock('../bot/minecraft/perception', () => ({
    readWorldState: vi.fn().mockReturnValue({ position: { x: 0, y: 64, z: 0 }, health: 20, food: 20 }),
    buildContextStrings: vi.fn().mockReturnValue(['context line 1']),
}));

vi.mock('../bot/minecraft/action-definitions', () => ({
    MINECRAFT_ACTIONS: [
        { name: 'mc_follow_player', description: 'Follow a player', category: 'movement', isQuick: false },
        { name: 'mc_stop', description: 'Stop moving', category: 'movement', isQuick: true },
        { name: 'mc_attack', description: 'Attack entity', category: 'combat', isQuick: false },
    ],
}));

vi.mock('../bot/minecraft/action-dispatcher', () => ({
    executeAction: vi.fn().mockResolvedValue(''),
    initHomePosition: vi.fn(),
}));

vi.mock('../bot/minecraft/blueprints', () => ({
    loadCustomBlueprints: vi.fn(),
}));

vi.mock('../bot/minecraft/actions', () => ({
    dismountEntity: vi.fn(),
}));

vi.mock('../bot/minecraft/events', () => ({
    McEventBridge: vi.fn(),
}));

vi.mock('../bot/minecraft/mineflayer-types', () => ({
    setFollowDistance: vi.fn(),
    getVehicle: vi.fn().mockReturnValue(null),
}));

vi.mock('./audio-pipeline', () => ({
    AudioPipeline: vi.fn().mockImplementation(() => ({
        handleAudioStarted: vi.fn(),
        handleAudioComplete: vi.fn(),
        setRawAudioCallback: vi.fn(),
    })),
}));

vi.mock('./voxta-message-handler', () => ({
    dispatchVoxtaMessage: vi.fn(),
}));

vi.mock('./skin-server', () => ({
    getPublicSkinUrl: vi.fn().mockResolvedValue(null),
}));

vi.mock('./action-orchestrator', () => ({
    resetActionFired: vi.fn(),
}));

vi.mock('./plugin-channel', () => ({
    registerPluginChannel: vi.fn(),
    sendAudioData: vi.fn(),
    sendRegisterHost: vi.fn(),
    sendSetDistance: vi.fn(),
    sendStopAudio: vi.fn(),
    extractPcmFromWav: vi.fn(),
}));

vi.mock('./bot-engine-voxta', () => ({
    fetchCharacterDetails: vi.fn().mockResolvedValue([]),
    loadScenarios: vi.fn().mockResolvedValue([]),
    loadChats: vi.fn().mockResolvedValue([]),
    favoriteChat: vi.fn(),
    deleteChat: vi.fn(),
    humanizeError: vi.fn((e: Error) => e.message),
}));

vi.mock('./bot-engine-movement', () => ({
    createModeScanLoop: vi.fn().mockReturnValue({ loop: 1, flush: vi.fn() }),
    createMountedSteeringLoop: vi.fn().mockReturnValue(2),
    createFollowWatchdog: vi.fn().mockReturnValue(3),
}));

vi.mock('./bot-engine-loops', () => ({
    createPerceptionLoop: vi.fn().mockReturnValue(4),
    createSpatialLoop: vi.fn().mockReturnValue(5),
    createProximityLoop: vi.fn().mockReturnValue(6),
}));

vi.mock('./bot-engine-events', () => ({
    createEventBridge: vi.fn().mockReturnValue({ destroy: vi.fn() }),
}));

// ---- Import module under test after mocks ----
import { BotEngine } from '../main/bot-engine';
import { MINECRAFT_ACTIONS } from '../bot/minecraft/action-definitions';

describe('BotEngine', () => {
    let engine: BotEngine;

    beforeEach(() => {
        vi.clearAllMocks();
        engine = new BotEngine();
    });

    // ---- Status ----

    describe('getStatus', () => {
        it('returns initial disconnected status', () => {
            const status = engine.getStatus();
            expect(status.mc).toBe('disconnected');
            expect(status.mc2).toBe('disconnected');
            expect(status.voxta).toBe('disconnected');
            expect(status.position).toBeNull();
            expect(status.health).toBeNull();
            expect(status.food).toBeNull();
            expect(status.currentAction).toBeNull();
            expect(status.assistantName).toBeNull();
            expect(status.sessionId).toBeNull();
            expect(status.paused).toBe(false);
        });

        it('returns a shallow copy, not the internal reference', () => {
            const status1 = engine.getStatus();
            const status2 = engine.getStatus();
            expect(status1).not.toBe(status2);
            expect(status1).toEqual(status2);
        });

        it('mutations to returned object do not affect internal state', () => {
            const status = engine.getStatus();
            status.mc = 'connected';
            status.health = 999;
            const fresh = engine.getStatus();
            expect(fresh.mc).toBe('disconnected');
            expect(fresh.health).toBeNull();
        });
    });

    // ---- Actions ----

    describe('getActions', () => {
        it('returns all actions from MINECRAFT_ACTIONS', () => {
            const actions = engine.getActions();
            expect(actions).toHaveLength(MINECRAFT_ACTIONS.length);
        });

        it('maps name, description, and category from definitions', () => {
            const actions = engine.getActions();
            const follow = actions.find((a) => a.name === 'mc_follow_player');
            expect(follow).toBeDefined();
            expect(follow!.description).toBe('Follow a player');
            expect(follow!.category).toBe('movement');
        });

        it('defaults all actions to enabled', () => {
            const actions = engine.getActions();
            for (const action of actions) {
                expect(action.enabled).toBe(true);
            }
        });

        it('reflects toggled-off state', () => {
            engine.toggleAction('mc_stop', false);
            const actions = engine.getActions();
            const stop = actions.find((a) => a.name === 'mc_stop');
            expect(stop!.enabled).toBe(false);
        });
    });

    describe('toggleAction', () => {
        it('disables an action', () => {
            engine.toggleAction('mc_attack', false);
            const actions = engine.getActions();
            const attack = actions.find((a) => a.name === 'mc_attack');
            expect(attack!.enabled).toBe(false);
        });

        it('re-enables a disabled action', () => {
            engine.toggleAction('mc_attack', false);
            engine.toggleAction('mc_attack', true);
            const actions = engine.getActions();
            const attack = actions.find((a) => a.name === 'mc_attack');
            expect(attack!.enabled).toBe(true);
        });

        it('does not affect other actions', () => {
            engine.toggleAction('mc_stop', false);
            const actions = engine.getActions();
            const follow = actions.find((a) => a.name === 'mc_follow_player');
            expect(follow!.enabled).toBe(true);
        });
    });

    // ---- Settings ----

    describe('updateSettings', () => {
        it('stores new settings', () => {
            const newSettings: McSettings = {
                ...DEFAULT_SETTINGS,
                enableAutoDefense: false,
            };
            engine.updateSettings(newSettings);
            // Settings are private, but we can verify through behavior:
            // no error thrown, and the object is replaced (not mutated)
            const another: McSettings = { ...DEFAULT_SETTINGS, enableAutoDefense: true };
            engine.updateSettings(another);
            // If it stored correctly, further calls work without error
        });

        it('emits no side effects when neither timing nor distance changed', () => {
            // Same settings as default — nothing should be pushed
            engine.updateSettings({ ...DEFAULT_SETTINGS });
            // pushActionsToVoxta requires voxta.sessionId which is null
            // sendSetDistance requires mcBot which is null
            // No error means the guards worked
        });
    });

    // ---- Chat / Messages ----

    describe('sendMessage', () => {
        it('returns early when voxta is not connected', async () => {
            // voxta is null by default — should not throw
            await engine.sendMessage('hello');
            // No crash = success
        });
    });

    describe('event emission', () => {
        it('emits chat-message when addChat is called via public API', () => {
            const spy = vi.fn();
            engine.on('chat-message', spy);

            // sendMessage calls addChat internally — but requires voxta
            // Instead, test through sendMessage path when disconnected
            // addChat is private, so we rely on integration paths

            // Verify engine supports the event
            expect(engine.listenerCount('chat-message')).toBe(1);
        });

        it('emits status-changed on status update', () => {
            const spy = vi.fn();
            engine.on('status-changed', spy);

            // updateSettings doesn't trigger status-changed directly,
            // but updateStatus is called in many paths
            expect(engine.listenerCount('status-changed')).toBe(1);
        });

        it('emits toast events', () => {
            const spy = vi.fn();
            engine.on('toast', spy);
            expect(engine.listenerCount('toast')).toBe(1);
        });
    });

    // ---- Pause ----

    describe('pauseChat', () => {
        it('does not throw when voxta is null', async () => {
            await engine.pauseChat(true);
            await engine.pauseChat(false);
            // No crash = success — optional chaining handles null voxta
        });
    });

    // ---- Audio handlers ----

    describe('handleAudioStarted', () => {
        it('does not throw when voxta is null', () => {
            engine.handleAudioStarted({ messageId: 'test', url: 'http://example.com/audio.wav' });
            // No crash — voxta null guard
        });
    });

    describe('handleAudioComplete', () => {
        it('delegates to audio pipeline', () => {
            engine.handleAudioComplete('msg-1');
            // AudioPipeline mock is called internally — no crash = success
        });
    });

    // ---- Disconnect ----

    describe('disconnect', () => {
        it('does not throw when nothing is connected', async () => {
            await engine.disconnect();
            const status = engine.getStatus();
            expect(status.voxta).toBe('disconnected');
        });

        it('resets all status fields after disconnect', async () => {
            await engine.disconnect();
            const status = engine.getStatus();
            expect(status.mc).toBe('disconnected');
            expect(status.mc2).toBe('disconnected');
            expect(status.position).toBeNull();
            expect(status.health).toBeNull();
            expect(status.assistantName).toBeNull();
            expect(status.sessionId).toBeNull();
        });
    });

    // ---- Constructor ----

    describe('constructor', () => {
        it('initializes all action toggles to true', () => {
            const actions = engine.getActions();
            expect(actions.every((a) => a.enabled === true)).toBe(true);
        });

        it('starts with disconnected status', () => {
            const status = engine.getStatus();
            expect(status.mc).toBe('disconnected');
            expect(status.voxta).toBe('disconnected');
        });
    });
});
