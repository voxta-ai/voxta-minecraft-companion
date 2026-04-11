import type { Bot as MineflayerBot } from 'mineflayer';
import type { NameRegistry } from '../bot/name-registry';
import type { VoxtaClient } from '../bot/voxta/client';
import type { BotStatus } from '../shared/ipc-types';
import type { ScenarioAction } from '../bot/voxta/types';
import { readWorldState, buildContextStrings } from '../bot/minecraft/perception';

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
    const contextKey = slot === 1 ? 'minecraft-bot1' : 'minecraft-bot2';
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

            // Only update position if it's valid (perception returns 0,0,0 when bot pos is NaN)
            const posValid = state.position.x !== 0 || state.position.y !== 0 || state.position.z !== 0;
            callbacks.updateStatus({
                ...(posValid
                    ? {
                          [statusPositionKey]: {
                              x: Math.round(state.position.x),
                              y: Math.round(state.position.y),
                              z: Math.round(state.position.z),
                          },
                      }
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
            const botVehicle = (activeBot as unknown as { vehicle: { position: { x: number; y: number; z: number } } | null }).vehicle;
            const botPos = botVehicle ? botVehicle.position : activeBot.entity?.position;
            const playerEntity = activeBot.players[playerMcUsername]?.entity;
            if (botPos && playerEntity) {
                const playerVehicle = (playerEntity as unknown as { vehicle: { position: { x: number; y: number; z: number } } | null }).vehicle;
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
                    playerX: botPos.x + 9999,
                    playerY: botPos.y,
                    playerZ: botPos.z,
                    playerYaw: 0,
                });
            }
        } catch {
            // Entity may not exist yet
        }
    }, 100);
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
    const PROXIMITY_RANGE = 40; // blocks
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

        // Bot 1
        const bot1 = callbacks.getMcBot(1);
        const charIds = callbacks.getActiveCharacterIds();
        if (bot1 && charIds[0]) {
            const playerEntity = findPlayer(bot1);
            // Player is not visible in entities = beyond render distance = definitely out of range
            const dist1 = playerEntity
                ? playerEntity.position.distanceTo(bot1.entity.position)
                : Infinity;
            const inRange = dist1 <= PROXIMITY_RANGE;
            if (proximityLogTick % 6 === 0) {
                const name = callbacks.getAssistantName(1) ?? 'Bot1';
                console.log(`[Proximity] ${name}: ${dist1 === Infinity ? 'not visible' : `${dist1.toFixed(1)} blocks`} (${inRange ? 'in range' : 'OUT OF RANGE'})`);
            }
            if (inRange !== callbacks.isBotInRange(1)) {
                callbacks.setBotInRange(1, inRange);
                const name = callbacks.getAssistantName(1) ?? 'Bot';
                if (inRange) {
                    console.log(`[Proximity] ${name} back in range — rejoining`);
                    void voxta.addChatParticipant(charIds[0]);
                    callbacks.addChat('system', 'System', `${name} is back in range.`);
                    callbacks.queueNote(`${name} rejoined — back within range of the player.`);
                } else {
                    console.log(`[Proximity] ${name} out of range — removing`);
                    void voxta.removeChatParticipant(charIds[0]);
                    callbacks.addChat('system', 'System', `${name} is too far away to hear.`);
                }
            }
        }

        // Bot 2 (dual-bot only)
        if (isDualBot) {
            const bot2 = callbacks.getMcBot(2);
            if (bot2 && charIds[1]) {
                const playerEntity2 = findPlayer(bot2);
                const dist2 = playerEntity2
                    ? playerEntity2.position.distanceTo(bot2.entity.position)
                    : Infinity;
                if (proximityLogTick % 6 === 0) {
                    const name2 = callbacks.getAssistantName(2) ?? 'Bot2';
                    console.log(`[Proximity] ${name2}: ${dist2 === Infinity ? 'not visible' : `${dist2.toFixed(1)} blocks`} (${dist2 <= PROXIMITY_RANGE ? 'in range' : 'OUT OF RANGE'})`);
                }
                const inRange2 = dist2 <= PROXIMITY_RANGE;
                if (inRange2 !== callbacks.isBotInRange(2)) {
                    callbacks.setBotInRange(2, inRange2);
                    const name2 = callbacks.getAssistantName(2) ?? 'Bot2';
                    if (inRange2) {
                        console.log(`[Proximity] ${name2} back in range — rejoining`);
                        void voxta.addChatParticipant(charIds[1]);
                        callbacks.addChat('system', 'System', `${name2} is back in range.`);
                        callbacks.queueNote(`${name2} rejoined — back within range of the player.`);
                    } else {
                        console.log(`[Proximity] ${name2} out of range — removing`);
                        void voxta.removeChatParticipant(charIds[1]);
                        callbacks.addChat('system', 'System', `${name2} is too far away to hear.`);
                    }
                }
            }
        }
        proximityLogTick++;
    }, 5000);
}
