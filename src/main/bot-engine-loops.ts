import type { Bot as MineflayerBot } from 'mineflayer';
import type { NameRegistry } from '../bot/name-registry';
import type { VoxtaClient } from '../bot/voxta/client';
import type { BotStatus } from '../shared/ipc-types';
import type { ScenarioAction } from '../bot/voxta/types';
import { readWorldState, buildContextStrings } from '../bot/minecraft/perception';
import { getVehicle, getEntityVehicle } from '../bot/minecraft/mineflayer-types';

// ---- Loop interval constants ----
const SPATIAL_LOOP_INTERVAL_MS = 100;    // Fast — responsive spatial audio positioning
const PROXIMITY_LOOP_INTERVAL_MS = 5000; // How often to check bot-player distance
const PROXIMITY_RANGE = 40;              // Blocks — beyond this, bot is silenced
const OUT_OF_RANGE_OFFSET = 9999;        // Offset to signal "player not visible"
const CONTEXT_KEY_BOT1 = 'minecraft-bot1';
const CONTEXT_KEY_BOT2 = 'minecraft-bot2';

/** Callbacks the perception/proximity/spatial loops use to interact with BotEngine state */
export interface LoopCallbacks {
    getVoxta(): VoxtaClient | null;
    getPlayerMcUsername(): string | null;
    getFollowingPlayer(): string | null;
    getNames(): NameRegistry;
    getEnabledActions(): ScenarioAction[];
    isBotInRange(slot: 1 | 2): boolean;
    setBotInRange(slot: 1 | 2, inRange: boolean): void;
    getActiveCharacterIds(): string[];
    getAssistantName(slot: 1 | 2): string | null;
    getLastSpeakingSlot(): 1 | 2;
    getMcBot(slot: 1 | 2): MineflayerBot | null;
    updateStatus(patch: Partial<BotStatus>): void;
    addChat(type: 'system' | 'event', sender: string, text: string): void;
    queueNote(text: string): void;
    emit(event: string, data: unknown): void;
}

/**
 * Creates a perception loop for a single bot slot.
 * Reads world state periodically and sends context updates to Voxta.
 */
export function createPerceptionLoop(
    bot: MineflayerBot,
    slot: 1 | 2,
    intervalMs: number,
    entityRange: number,
    assistantName: string,
    initialContextStrings: string[],
    callbacks: LoopCallbacks,
): ReturnType<typeof setInterval> {
    let lastContextHash = initialContextStrings.join('|');
    const contextKey = slot === 1 ? CONTEXT_KEY_BOT1 : CONTEXT_KEY_BOT2;
    const statusPositionKey = slot === 1 ? 'position' : 'position2';
    const statusHealthKey = slot === 1 ? 'health' : 'health2';
    const statusFoodKey = slot === 1 ? 'food' : 'food2';

    return setInterval(() => {
        const voxta = callbacks.getVoxta();
        if (!voxta?.sessionId) return;
        try {
            const state = readWorldState(bot, entityRange);
            const rawStrings = buildContextStrings(state, callbacks.getNames(), assistantName);
            const contextStrings = slot === 1
                ? rawStrings.map((s) => `[${assistantName}] ${s}`)
                : rawStrings.map((s) => `[${assistantName}] ${s}`);

            const contextHash = contextStrings.join('|');

            // Only update position if valid (null = bot pos was NaN during respawn/combat)
            callbacks.updateStatus({
                ...(state.position
                    ? { [statusPositionKey]: state.position }
                    : {}),
                [statusHealthKey]: state.health,
                [statusFoodKey]: state.food,
            } as Partial<BotStatus>);

            if (contextHash !== lastContextHash) {
                lastContextHash = contextHash;
                if (!callbacks.isBotInRange(slot)) return;
                if (slot === 1) {
                    // Send actions only with bot1's context (shared between both bots)
                    void voxta.updateContext(
                        contextKey,
                        contextStrings.map((text) => ({ text })),
                        callbacks.getEnabledActions(),
                    );
                } else {
                    // No actions here — actions are sent with bot1's context update
                    void voxta.updateContext(
                        contextKey,
                        contextStrings.map((text) => ({ text })),
                    );
                }
            }
        } catch (err) {
            // Perception can fail during respawn/chunk loading
            console.error(`[Perception] ${slot === 1 ? 'Context' : 'Bot 2 context'} update failed:`, err);
        }
    }, intervalMs);
}

/**
 * Creates the spatial audio position loop (fast — 100ms for responsive audio).
 * Emits bot and player positions so the renderer can apply spatial audio effects.
 */
export function createSpatialLoop(
    callbacks: LoopCallbacks,
): ReturnType<typeof setInterval> {
    return setInterval(() => {
        const playerMcUsername = callbacks.getPlayerMcUsername();
        if (!playerMcUsername) return;
        try {
            // Use the currently speaking bot's position — not always bot 1
            const slot = callbacks.getLastSpeakingSlot();
            const activeBot = callbacks.getMcBot(slot) ?? callbacks.getMcBot(1);
            if (!activeBot) return;

            // Use vehicle position when mounted — entity position is stale for passengers
            const botVehicle = getVehicle(activeBot);
            const botPos = botVehicle ? botVehicle.position : activeBot.entity?.position;
            const playerEntity = activeBot.players[playerMcUsername]?.entity;
            if (botPos && playerEntity) {
                const playerVehicle = getEntityVehicle(playerEntity);
                const pPos = playerVehicle ? playerVehicle.position : playerEntity.position;
                callbacks.emit('spatial-position', {
                    botX: botPos.x,
                    botY: botPos.y,
                    botZ: botPos.z,
                    playerX: pPos.x,
                    playerY: pPos.y,
                    playerZ: pPos.z,
                    playerYaw: playerEntity.yaw,
                });
            } else if (botPos) {
                // Player out of entity tracking range — signal max distance
                callbacks.emit('spatial-position', {
                    botX: botPos.x,
                    botY: botPos.y,
                    botZ: botPos.z,
                    playerX: botPos.x + OUT_OF_RANGE_OFFSET,
                    playerY: botPos.y,
                    playerZ: botPos.z,
                    playerYaw: 0,
                });
            }
        } catch {
            // Entity may not exist yet
        }
    }, SPATIAL_LOOP_INTERVAL_MS);
}

/**
 * Creates the proximity loop that silences/activates characters based on distance to the player.
 * When a bot is farther than PROXIMITY_RANGE blocks from the player, it gets
 * disabled in Voxta so it doesn't speak about things it can't see.
 */
export function createProximityLoop(
    isDualBot: boolean,
    callbacks: LoopCallbacks,
): ReturnType<typeof setInterval> {
    let proximityLogTick = 0;

    return setInterval(() => {
        const voxta = callbacks.getVoxta();
        if (!voxta?.sessionId) return;
        const playerMcUsername = callbacks.getPlayerMcUsername();
        if (!playerMcUsername) return;

        const findPlayer = (b: MineflayerBot) =>
            Object.values(b.entities).find(
                (e) => e.type === 'player' && e.username?.toLowerCase() === playerMcUsername.toLowerCase(),
            );

        const slotsToCheck: (1 | 2)[] = isDualBot ? [1, 2] : [1];
        const charIds = callbacks.getActiveCharacterIds();

        for (const slot of slotsToCheck) {
            const bot = callbacks.getMcBot(slot);
            const charId = charIds[slot - 1];
            if (!bot || !charId) continue;

            const playerEntity = findPlayer(bot);
            const dist = playerEntity
                ? playerEntity.position.distanceTo(bot.entity.position)
                : Infinity;
            const name = callbacks.getAssistantName(slot) ?? `Bot${slot}`;
            const inRange = dist <= PROXIMITY_RANGE;

            if (proximityLogTick % 6 === 0) {
                console.log(`[Proximity] ${name}: ${dist === Infinity ? 'not visible' : `${dist.toFixed(1)} blocks`} (${inRange ? 'in range' : 'OUT OF RANGE'})`);
            }

            if (inRange !== callbacks.isBotInRange(slot)) {
                callbacks.setBotInRange(slot, inRange);
                if (inRange) {
                    console.log(`[Proximity] ${name} back in range — rejoining`);
                    void voxta.addChatParticipant(charId);
                    callbacks.addChat('system', 'System', `${name} is back in range.`);
                    callbacks.queueNote(`${name} rejoined — back within range of the player.`);
                } else {
                    console.log(`[Proximity] ${name} out of range — removing`);
                    void voxta.removeChatParticipant(charId);
                    callbacks.addChat('system', 'System', `${name} is too far away to hear.`);
                }
            }
        }
        proximityLogTick++;
    }, PROXIMITY_LOOP_INTERVAL_MS);
}
