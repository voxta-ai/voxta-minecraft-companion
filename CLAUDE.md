# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start Electron app with hot reload (electron-vite)
npm run build        # Build all Electron bundles
npm run lint         # ESLint check
npm run lint:fix     # Auto-fix lint issues
npm run format       # Check formatting (Prettier)
npm run format:fix   # Auto-format code
npm run dist         # Build Windows NSIS installer + portable ZIP
```

There are no unit tests — validation is lint + format only.

## What This Project Is

A desktop Electron app that bridges a Voxta AI server with a Minecraft Java Edition server. The bot connects to both simultaneously: it plays Minecraft (via Mineflayer) while an AI character (via Voxta's SignalR API) perceives the world, speaks, and issues game actions in real time.

## Architecture

**Three-layer Electron structure:**

```
src/main/       — Node.js main process (bot logic, IPC, orchestration)
src/renderer/   — SolidJS UI (connection panel, chat, settings, inspector)
src/preload/    — Context bridge (exposes safe IPC API to renderer)
src/bot/        — Minecraft (Mineflayer) + Voxta (SignalR) client code
src/shared/     — IPC type definitions shared across all layers
```

### Main Process

- **`bot-engine.ts`** — Central orchestrator. Manages both clients (Mineflayer + Voxta), runs the perception loop (10ms), routes events, handles action toggling and settings. All state changes are emitted via EventEmitter to `ipc-handlers.ts`.
- **`ipc-handlers.ts`** — Bridges BotEngine events to the renderer via Electron IPC.
- **`action-orchestrator.ts`** — Sits between Voxta action messages and action execution. Handles voice-chance logic, reentrance guard (prevents spam loops), and follow-resume after tasks.
- **`audio-pipeline.ts`** — Parallel audio chunk download, emitted to renderer in order via a sentinel-based promise chain.

### Bot Layer (`src/bot/`)

**Minecraft (`src/bot/minecraft/`):**
- **`action-definitions.ts`** — Defines ~24 Voxta-compatible action schemas (mining, crafting, combat, movement, building, etc.).
- **`action-dispatcher.ts`** — Routes action calls to handler functions.
- **`actions/`** — One file per action category: `movement.ts`, `mining.ts`, `crafting.ts`, `combat.ts`, `cooking.ts`, `fishing.ts`, `containers.ts`, `inventory.ts`, `building.ts`, `placement.ts`, `home.ts`.
- **`action-state.ts`** — Shared mutable state: `isActionBusy`, `currentActivity`, `autoDefend`, mode tracking. Isolated to avoid scattered state.
- **`perception.ts`** — Reads world state (position, health, food, nearby entities, inventory, biome, weather, time, shelter detection) for Voxta context.
- **`events.ts`** — `McEventBridge`: registers Mineflayer listeners and routes callbacks (damage, death, chat, hostile mobs, auto-look, auto-defense).
- **`blueprints/`** — Structure templates (shelter, walls, watchtower) for the building system.

**Voxta (`src/bot/voxta/`):**
- **`client.ts`** — SignalR HubConnection. Authenticates, manages chat sessions, sends/receives messages.

### Renderer (`src/renderer/`)

SolidJS UI with stores in `src/renderer/stores/`:
- **`app-store.ts`** — `BotStatus`, chat messages, action toggles, settings.
- **`audio-store.ts`** — Audio playback state.
- **`console-store.ts`** — Live console log entries.

Key components: `ConnectionPanel` (2-phase: Voxta → character selection → Minecraft config), `ChatView`, `SettingsPanel`, `ActionToggles`, `InspectorDrawer` (debug state), `TerminalPanel` (F2 toggle), `AudioPlayer` (Web Audio API with spatial reverb/echo).

### Shared

- **`src/shared/ipc-types.ts`** — All IPC channel type definitions. The contract between main and renderer.

## Key Design Patterns

- **Action flow**: Voxta sends action → `action-orchestrator` validates (not duplicate, not in reentrance guard) → `action-dispatcher` routes → handler executes async → result fed back to Voxta as context.
- **Quick vs Physical actions**: Physical actions set `isActionBusy` and cancel the previous action. Quick actions (e.g., toggle settings) do not.
- **Follow-resume**: If the bot is following a player and receives a task action, it resumes following after the task completes.
- **Reentrance guard**: Prevents action result → AI reply → new action → loop spam.
- **Dynamic require for minecraft-data**: `minecraft-data` is loaded via `require()` at runtime (not `import`) because it provides version-specific block/item data. ESLint is configured to allow this.

## ESLint Notes

The flat config (`eslint.config.mjs`) intentionally disables several rules for this codebase:
- Allows `_`-prefixed unused variables
- Disables `no-require-imports` (for `minecraft-data`)
- Allows `any` type and unsafe member access (Mineflayer's dynamic objects don't have complete types)
- Allows empty catch blocks (best-effort patterns throughout bot actions)
