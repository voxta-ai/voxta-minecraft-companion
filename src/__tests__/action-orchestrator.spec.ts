import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ServerActionMessage } from '../bot/voxta/types';
import type { ActionOrchestratorCallbacks } from '../main/action-orchestrator';
import type { McSettings } from '../shared/ipc-types';
import { DEFAULT_SETTINGS } from '../shared/ipc-types';

// Mock all external dependencies before importing the module under test
vi.mock('../bot/minecraft/action-dispatcher', () => ({
    executeAction: vi.fn().mockResolvedValue(''),
    setFishCaughtCallback: vi.fn(),
}));

vi.mock('../bot/minecraft/actions', () => ({
    isActionBusy: vi.fn().mockReturnValue(false),
    getCurrentActivity: vi.fn().mockReturnValue(null),
    setBuildProgressCallback: vi.fn(),
    setCraftProgressCallback: vi.fn(),
}));

vi.mock('../bot/minecraft/actions/action-state.js', () => ({
    isAutoDefending: vi.fn().mockReturnValue(false),
    getBotMode: vi.fn().mockReturnValue('passive'),
    setBotMode: vi.fn(),
}));

import { handleActionMessage, resetActionFired } from '../main/action-orchestrator';
import { isActionBusy, getCurrentActivity } from '../bot/minecraft/actions';
import { isAutoDefending, getBotMode, setBotMode } from '../bot/minecraft/actions/action-state.js';
import { NameRegistry } from '../bot/name-registry';

// Minimal bot mock — just needs to be an object for WeakMap keying and pathfinder access
function createMockBot(): Record<string, unknown> {
    return {
        entity: { position: { x: 0, y: 64, z: 0 } },
        pathfinder: { goal: null },
    };
}

function createMockCallbacks(overrides: Partial<ActionOrchestratorCallbacks> = {}): ActionOrchestratorCallbacks {
    return {
        getAssistantName: vi.fn().mockReturnValue('TestBot'),
        getSettings: vi.fn().mockReturnValue({ ...DEFAULT_SETTINGS } as McSettings),
        isReplying: vi.fn().mockReturnValue(false),
        getFollowingPlayer: vi.fn().mockReturnValue(null),
        setFollowingPlayer: vi.fn(),
        addChat: vi.fn(),
        updateCurrentAction: vi.fn(),
        queueNote: vi.fn(),
        sendNoteNow: vi.fn(),
        queueEvent: vi.fn(),
        getVoxta: vi.fn().mockReturnValue(null),
        ...overrides,
    };
}

function createAction(name: string, args?: Array<{ name: string; value: string }>): ServerActionMessage {
    return {
        $type: 'action',
        sessionId: 'test-session',
        value: name,
        arguments: args,
    } as ServerActionMessage;
}

describe('Action Orchestrator', () => {
    const names = new NameRegistry();

    beforeEach(() => {
        resetActionFired();
        vi.clearAllMocks();
        // Reset mocks to default values
        vi.mocked(isActionBusy).mockReturnValue(false);
        vi.mocked(getCurrentActivity).mockReturnValue(null);
        vi.mocked(isAutoDefending).mockReturnValue(false);
        vi.mocked(getBotMode).mockReturnValue('passive');
    });

    describe('empty action handling', () => {
        it('ignores empty action name', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();
            const action = createAction('');

            handleActionMessage(action, bot as never, names, callbacks);

            expect(callbacks.updateCurrentAction).toHaveBeenCalledWith(null);
            expect(callbacks.addChat).not.toHaveBeenCalled();
        });

        it('ignores action with only whitespace', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();
            const action = createAction('   ');

            handleActionMessage(action, bot as never, names, callbacks);

            expect(callbacks.updateCurrentAction).toHaveBeenCalledWith(null);
            expect(callbacks.addChat).not.toHaveBeenCalled();
        });
    });

    describe('reentrance guard', () => {
        it('allows the first action', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();

            handleActionMessage(createAction('mc_stop'), bot as never, names, callbacks);

            expect(callbacks.addChat).toHaveBeenCalled();
        });

        it('blocks a second action in the same turn', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();

            handleActionMessage(createAction('mc_stop'), bot as never, names, callbacks);
            callbacks.addChat = vi.fn(); // reset to check second call
            handleActionMessage(createAction('mc_go_home'), bot as never, names, callbacks);

            expect(callbacks.addChat).not.toHaveBeenCalled();
        });

        it('resets after resetActionFired()', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();

            handleActionMessage(createAction('mc_stop'), bot as never, names, callbacks);
            resetActionFired();
            callbacks.addChat = vi.fn();
            handleActionMessage(createAction('mc_go_home'), bot as never, names, callbacks);

            expect(callbacks.addChat).toHaveBeenCalled();
        });

        it('mc_none does not set the reentrance guard', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();

            handleActionMessage(createAction('mc_none'), bot as never, names, callbacks);
            callbacks.addChat = vi.fn();
            handleActionMessage(createAction('mc_stop'), bot as never, names, callbacks);

            expect(callbacks.addChat).toHaveBeenCalled();
        });
    });

    describe('duplicate long-running action detection', () => {
        it('ignores duplicate mc_mine_block when already busy', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();
            vi.mocked(isActionBusy).mockReturnValue(true);
            vi.mocked(getCurrentActivity).mockReturnValue('Mining stone');

            handleActionMessage(createAction('mc_mine_block'), bot as never, names, callbacks);

            expect(callbacks.addChat).not.toHaveBeenCalled();
        });

        it('ignores duplicate mc_fish when already busy', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();
            vi.mocked(isActionBusy).mockReturnValue(true);
            vi.mocked(getCurrentActivity).mockReturnValue('Fishing');

            handleActionMessage(createAction('mc_fish'), bot as never, names, callbacks);

            expect(callbacks.addChat).not.toHaveBeenCalled();
        });

        it('allows non-long-running actions even when busy', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();
            vi.mocked(isActionBusy).mockReturnValue(true);
            vi.mocked(getCurrentActivity).mockReturnValue('Mining stone');

            handleActionMessage(createAction('mc_stop'), bot as never, names, callbacks);

            expect(callbacks.addChat).toHaveBeenCalled();
        });
    });

    describe('auto-defense combat skip', () => {
        it('ignores mc_attack when auto-defending', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();
            vi.mocked(isAutoDefending).mockReturnValue(true);

            handleActionMessage(createAction('mc_attack'), bot as never, names, callbacks);

            expect(callbacks.addChat).not.toHaveBeenCalled();
        });

        it('ignores mc_go_to_entity when auto-defending', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();
            vi.mocked(isAutoDefending).mockReturnValue(true);

            handleActionMessage(createAction('mc_go_to_entity'), bot as never, names, callbacks);

            expect(callbacks.addChat).not.toHaveBeenCalled();
        });

        it('allows non-combat actions when auto-defending', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();
            vi.mocked(isAutoDefending).mockReturnValue(true);

            handleActionMessage(createAction('mc_stop'), bot as never, names, callbacks);

            expect(callbacks.addChat).toHaveBeenCalled();
        });
    });

    describe('follow state tracking', () => {
        it('sets following player on mc_follow_player', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();

            handleActionMessage(
                createAction('mc_follow_player', [{ name: 'player_name', value: 'Steve' }]),
                bot as never, names, callbacks,
            );

            expect(callbacks.setFollowingPlayer).toHaveBeenCalledWith('Steve');
        });

        it('strips LLM type annotations from player name', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();

            handleActionMessage(
                createAction('mc_follow_player', [{ name: 'player_name', value: 'string="Steve"' }]),
                bot as never, names, callbacks,
            );

            expect(callbacks.setFollowingPlayer).toHaveBeenCalledWith('Steve');
        });

        it('clears following player on mc_stop', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();

            handleActionMessage(createAction('mc_stop'), bot as never, names, callbacks);

            expect(callbacks.setFollowingPlayer).toHaveBeenCalledWith(null);
        });

        it('clears following player on mc_go_home', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();

            handleActionMessage(createAction('mc_go_home'), bot as never, names, callbacks);

            expect(callbacks.setFollowingPlayer).toHaveBeenCalledWith(null);
        });

        it('clears following player on mc_go_to', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();

            handleActionMessage(createAction('mc_go_to'), bot as never, names, callbacks);

            expect(callbacks.setFollowingPlayer).toHaveBeenCalledWith(null);
        });
    });

    describe('mode auto-switch on follow', () => {
        it('switches from guard to passive when following', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();
            vi.mocked(getBotMode).mockReturnValue('guard');

            handleActionMessage(
                createAction('mc_follow_player', [{ name: 'player_name', value: 'Steve' }]),
                bot as never, names, callbacks,
            );

            expect(setBotMode).toHaveBeenCalledWith(bot, 'passive');
        });

        it('switches from hunt to passive when following', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();
            vi.mocked(getBotMode).mockReturnValue('hunt');

            handleActionMessage(
                createAction('mc_follow_player', [{ name: 'player_name', value: 'Steve' }]),
                bot as never, names, callbacks,
            );

            expect(setBotMode).toHaveBeenCalledWith(bot, 'passive');
        });

        it('preserves aggro mode when following (expected combo)', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();
            vi.mocked(getBotMode).mockReturnValue('aggro');

            handleActionMessage(
                createAction('mc_follow_player', [{ name: 'player_name', value: 'Steve' }]),
                bot as never, names, callbacks,
            );

            expect(setBotMode).not.toHaveBeenCalled();
        });
    });

    describe('action notifications', () => {
        it('sends fishing notification on mc_fish', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();

            handleActionMessage(createAction('mc_fish'), bot as never, names, callbacks);

            expect(callbacks.queueNote).toHaveBeenCalledWith(
                expect.stringContaining('fishing'),
            );
        });

        it('sends mining notification on mc_mine_block', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();

            handleActionMessage(
                createAction('mc_mine_block', [
                    { name: 'block_type', value: 'diamond_ore' },
                    { name: 'count', value: '5' },
                ]),
                bot as never, names, callbacks,
            );

            expect(callbacks.queueNote).toHaveBeenCalledWith(
                expect.stringContaining('diamond_ore'),
            );
        });

        it('sends go home notification on mc_go_home', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();

            handleActionMessage(createAction('mc_go_home'), bot as never, names, callbacks);

            expect(callbacks.queueNote).toHaveBeenCalledWith(
                expect.stringContaining('heading home'),
            );
        });

        it('sends build notification on mc_build', () => {
            const bot = createMockBot();
            const callbacks = createMockCallbacks();

            handleActionMessage(
                createAction('mc_build', [{ name: 'structure', value: 'watchtower' }]),
                bot as never, names, callbacks,
            );

            expect(callbacks.queueNote).toHaveBeenCalledWith(
                expect.stringContaining('watchtower'),
            );
        });
    });
});
