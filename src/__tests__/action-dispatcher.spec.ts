import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NameRegistry } from '../bot/name-registry';

// Mock action handlers
vi.mock('../bot/minecraft/actions', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../bot/minecraft/actions');
    return {
        ...actual,
        getArg: (args: Array<{ name: string; value: string }> | undefined, name: string) =>
            args?.find((a) => a.name === name)?.value ?? null,
        resetActionAbort: vi.fn(),
        setActionBusy: vi.fn(),
        getCurrentActivity: vi.fn().mockReturnValue(null),
        setCurrentActivity: vi.fn(),
        getCurrentCombatTarget: vi.fn().mockReturnValue(null),
        setBotMode: vi.fn(),
        setGuardCenter: vi.fn(),
        followPlayer: vi.fn().mockResolvedValue('Following Steve'),
        goTo: vi.fn().mockResolvedValue('Reached destination'),
        goHome: vi.fn().mockResolvedValue('Arrived home'),
        goToEntity: vi.fn().mockResolvedValue('Reached entity'),
        collectItems: vi.fn().mockResolvedValue('Collected 3 items'),
        attackEntity: vi.fn().mockResolvedValue('Defeated the zombie'),
        lookAtPlayer: vi.fn().mockResolvedValue('Looking at Steve'),
        mineBlock: vi.fn().mockResolvedValue('Mined 5 stone'),
        craftItem: vi.fn().mockResolvedValue('Crafted 1 wooden_pickaxe'),
        cookFood: vi.fn().mockResolvedValue('Cooked 3 porkchop'),
        fishAction: vi.fn().mockResolvedValue('Caught 2 fish'),
        equipItem: vi.fn().mockResolvedValue('Equipped diamond_sword'),
        eatFood: vi.fn().mockResolvedValue('Ate some bread'),
        giveItem: vi.fn().mockResolvedValue('Gave 1 diamond to Steve'),
        tossItem: vi.fn().mockResolvedValue('Tossed 1 dirt'),
        useHeldItem: vi.fn().mockResolvedValue('Used item'),
        storeItem: vi.fn().mockResolvedValue('Stored items'),
        takeItem: vi.fn().mockResolvedValue('Took items'),
        inspectContainer: vi.fn().mockResolvedValue('Chest contains: 3 items'),
        sleepInBed: vi.fn().mockResolvedValue('Sleeping'),
        setHomeBed: vi.fn().mockResolvedValue('Home set'),
        placeBlock: vi.fn().mockResolvedValue('Placed block'),
        buildStructure: vi.fn().mockResolvedValue('Built shelter'),
        mountEntity: vi.fn().mockResolvedValue('Mounted horse'),
        dismountEntity: vi.fn().mockResolvedValue('Dismounted'),
    };
});

import { executeAction } from '../bot/minecraft/action-dispatcher';
import {
    getCurrentActivity,
    getCurrentCombatTarget,
    setActionBusy,
    setCurrentActivity,
    setBotMode,
    setGuardCenter,
    followPlayer,
    goTo,
    goHome,
    goToEntity,
    attackEntity,
    mineBlock,
    craftItem,
    fishAction,
    eatFood,
    equipItem,
    mountEntity,
    dismountEntity,
    buildStructure,
} from '../bot/minecraft/actions';

function createMockBot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        entity: {
            position: { x: 100, y: 64, z: -200, offset: () => ({ x: 100, y: 65, z: -200 }) },
            onGround: true,
            velocity: { x: 0, y: 0, z: 0 },
        },
        pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
        heldItem: null,
        isSleeping: false,
        stopDigging: vi.fn(),
        activateItem: vi.fn(),
        deactivateItem: vi.fn(),
        wake: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

describe('Action Dispatcher', () => {
    const names = new NameRegistry();

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getCurrentActivity).mockReturnValue(null);
        vi.mocked(getCurrentCombatTarget).mockReturnValue(null);
    });

    describe('routing to correct handler', () => {
        it('routes mc_follow_player to followPlayer', async () => {
            const bot = createMockBot();
            await executeAction(bot as never, 'mc_follow_player', [{ name: 'player_name', value: 'Steve' }], names);
            expect(followPlayer).toHaveBeenCalledWith(bot, 'Steve', names);
        });

        it('routes mc_go_to to goTo', async () => {
            const bot = createMockBot();
            await executeAction(bot as never, 'mc_go_to', [
                { name: 'x', value: '100' }, { name: 'y', value: '64' }, { name: 'z', value: '-200' },
            ], names);
            expect(goTo).toHaveBeenCalledWith(bot, '100', '64', '-200');
        });

        it('routes mc_go_home to goHome', async () => {
            const bot = createMockBot();
            await executeAction(bot as never, 'mc_go_home', [], names);
            expect(goHome).toHaveBeenCalledWith(bot);
        });

        it('routes mc_go_to_entity to goToEntity', async () => {
            const bot = createMockBot();
            await executeAction(bot as never, 'mc_go_to_entity', [{ name: 'entity_name', value: 'Cow' }], names);
            expect(goToEntity).toHaveBeenCalledWith(bot, 'Cow');
        });

        it('routes mc_attack to attackEntity', async () => {
            const bot = createMockBot();
            await executeAction(bot as never, 'mc_attack', [{ name: 'entity_name', value: 'Zombie' }], names);
            expect(attackEntity).toHaveBeenCalledWith(bot, 'Zombie', names);
        });

        it('routes mc_mine_block to mineBlock', async () => {
            const bot = createMockBot();
            await executeAction(bot as never, 'mc_mine_block', [
                { name: 'block_type', value: 'stone' }, { name: 'count', value: '10' },
            ], names);
            expect(mineBlock).toHaveBeenCalledWith(bot, 'stone', '10');
        });

        it('routes mc_craft to craftItem', async () => {
            const bot = createMockBot();
            await executeAction(bot as never, 'mc_craft', [
                { name: 'item_name', value: 'wooden_pickaxe' }, { name: 'count', value: '1' },
            ], names);
            expect(craftItem).toHaveBeenCalledWith(bot, 'wooden_pickaxe', '1');
        });

        it('routes mc_fish to fishAction', async () => {
            const bot = createMockBot();
            await executeAction(bot as never, 'mc_fish', [{ name: 'count', value: '5' }], names);
            expect(fishAction).toHaveBeenCalledWith(bot, '5');
        });

        it('routes mc_eat to eatFood', async () => {
            const bot = createMockBot();
            await executeAction(bot as never, 'mc_eat', [{ name: 'food_name', value: 'bread' }], names);
            expect(eatFood).toHaveBeenCalledWith(bot, 'bread');
        });

        it('routes mc_equip to equipItem', async () => {
            const bot = createMockBot();
            await executeAction(bot as never, 'mc_equip', [{ name: 'item_name', value: 'diamond_sword' }], names);
            expect(equipItem).toHaveBeenCalledWith(bot, 'diamond_sword');
        });

        it('routes mc_build to buildStructure', async () => {
            const bot = createMockBot();
            await executeAction(bot as never, 'mc_build', [{ name: 'structure', value: 'shelter' }], names);
            expect(buildStructure).toHaveBeenCalledWith(bot, 'shelter', names);
        });

        it('routes mc_mount to mountEntity', async () => {
            const bot = createMockBot();
            await executeAction(bot as never, 'mc_mount', [{ name: 'entity_name', value: 'Horse' }], names);
            expect(mountEntity).toHaveBeenCalledWith(bot, 'Horse');
        });

        it('routes mc_dismount to dismountEntity', async () => {
            const bot = createMockBot();
            await executeAction(bot as never, 'mc_dismount', [], names);
            expect(dismountEntity).toHaveBeenCalledWith(bot);
        });
    });

    describe('building block guard', () => {
        it('blocks actions during building', async () => {
            const bot = createMockBot();
            vi.mocked(getCurrentActivity).mockReturnValue('building shelter');

            const result = await executeAction(bot as never, 'mc_mine_block', [{ name: 'block_type', value: 'stone' }], names);

            expect(result).toBe('');
            expect(mineBlock).not.toHaveBeenCalled();
        });

        it('allows mc_stop during building', async () => {
            const bot = createMockBot();
            vi.mocked(getCurrentActivity).mockReturnValue('building shelter');

            const result = await executeAction(bot as never, 'mc_stop', [], names);

            expect(result).toBe('Stopped current action');
        });

        it('allows mc_none during building', async () => {
            const bot = createMockBot();
            vi.mocked(getCurrentActivity).mockReturnValue('building shelter');

            const result = await executeAction(bot as never, 'mc_none', [], names);

            expect(result).toBe('');
        });
    });

    describe('duplicate combat skip', () => {
        it('skips mc_attack when already fighting same target', async () => {
            const bot = createMockBot();
            vi.mocked(getCurrentCombatTarget).mockReturnValue('zombie');

            const result = await executeAction(bot as never, 'mc_attack', [{ name: 'entity_name', value: 'zombie' }], names);

            expect(result).toBe('Already fighting zombie');
            expect(attackEntity).not.toHaveBeenCalled();
        });

        it('allows mc_attack against a different target', async () => {
            const bot = createMockBot();
            vi.mocked(getCurrentCombatTarget).mockReturnValue('zombie');

            await executeAction(bot as never, 'mc_attack', [{ name: 'entity_name', value: 'skeleton' }], names);

            expect(attackEntity).toHaveBeenCalled();
        });
    });

    describe('mc_stop behavior', () => {
        it('resets mode to passive', async () => {
            const bot = createMockBot();

            await executeAction(bot as never, 'mc_stop', [], names);

            expect(setBotMode).toHaveBeenCalledWith(bot, 'passive');
            expect(setGuardCenter).toHaveBeenCalledWith(bot, null);
            expect(setCurrentActivity).toHaveBeenCalledWith(bot, null);
        });

        it('stops pathfinder', async () => {
            const bot = createMockBot();

            await executeAction(bot as never, 'mc_stop', [], names);

            expect((bot.pathfinder as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalled();
        });
    });

    describe('mc_none', () => {
        it('returns empty string (no-op)', async () => {
            const bot = createMockBot();
            const result = await executeAction(bot as never, 'mc_none', [], names);
            expect(result).toBe('');
        });
    });

    describe('mc_set_mode', () => {
        it('sets guard mode with center position', async () => {
            const bot = createMockBot();

            const result = await executeAction(bot as never, 'mc_set_mode', [{ name: 'mode', value: 'guard' }], names);

            expect(setBotMode).toHaveBeenCalledWith(bot, 'guard');
            expect(setGuardCenter).toHaveBeenCalledWith(bot, { x: 100, y: 64, z: -200 });
            expect(result).toContain('Guard mode');
        });

        it('sets aggro mode', async () => {
            const bot = createMockBot();

            const result = await executeAction(bot as never, 'mc_set_mode', [{ name: 'mode', value: 'aggro' }], names);

            expect(setBotMode).toHaveBeenCalledWith(bot, 'aggro');
            expect(result).toContain('Aggro mode');
        });

        it('sets hunt mode', async () => {
            const bot = createMockBot();

            const result = await executeAction(bot as never, 'mc_set_mode', [{ name: 'mode', value: 'hunt' }], names);

            expect(setBotMode).toHaveBeenCalledWith(bot, 'hunt');
            expect(result).toContain('Hunt mode');
        });

        it('sets passive mode and clears guard center', async () => {
            const bot = createMockBot();

            const result = await executeAction(bot as never, 'mc_set_mode', [{ name: 'mode', value: 'passive' }], names);

            expect(setBotMode).toHaveBeenCalledWith(bot, 'passive');
            expect(setGuardCenter).toHaveBeenCalledWith(bot, null);
            expect(result).toContain('Passive mode');
        });

        it('rejects unknown modes', async () => {
            const bot = createMockBot();

            const result = await executeAction(bot as never, 'mc_set_mode', [{ name: 'mode', value: 'berserk' }], names);

            expect(result).toContain('Unknown mode');
            expect(setBotMode).not.toHaveBeenCalled();
        });
    });

    describe('busy state tracking', () => {
        it('sets busy for physical actions', async () => {
            const bot = createMockBot();

            await executeAction(bot as never, 'mc_mine_block', [{ name: 'block_type', value: 'stone' }], names);

            expect(setActionBusy).toHaveBeenCalledWith(bot, true);
            expect(setActionBusy).toHaveBeenCalledWith(bot, false);
        });

        it('does not set busy for mc_stop', async () => {
            const bot = createMockBot();

            await executeAction(bot as never, 'mc_stop', [], names);

            expect(setActionBusy).not.toHaveBeenCalledWith(bot, true);
        });
    });

    describe('unknown actions', () => {
        it('returns error for unknown action names', async () => {
            const bot = createMockBot();

            const result = await executeAction(bot as never, 'mc_fly_to_moon', [], names);

            expect(result).toBe('Unknown action: mc_fly_to_moon');
        });
    });

    describe('error handling', () => {
        it('catches handler errors and returns friendly message', async () => {
            const bot = createMockBot();
            vi.mocked(followPlayer).mockRejectedValueOnce(new Error('Pathfinder failed'));

            const result = await executeAction(bot as never, 'mc_follow_player', [{ name: 'player_name', value: 'Steve' }], names);

            expect(result).toContain('Failed to execute mc_follow_player');
            expect(result).toContain('Pathfinder failed');
        });
    });
});
