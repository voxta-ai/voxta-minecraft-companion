# Voxta Minecraft Companion

An AI-powered Minecraft companion bot that lives in your game world. It uses [Mineflayer](https://github.com/PrismarineJS/mineflayer) to interact with Minecraft and [Voxta](https://voxta.ai) for AI-driven conversation, voice chat, and action inference.

Talk to your companion by voice or text — they follow you, fight for you, build shelters, craft tools from scratch, fish, cook, and respond to the world around them.

![Voxta Minecraft Companion](docs/screenshot.png)

## Features

### 🧠 AI Integration
- **Real-time world perception** — Health, hunger, biome, time, weather, nearby entities, inventory, shelter status
- **Context-aware conversations** — The AI sees the game world and responds naturally
- **Voice chat** — Talk to your companion using your microphone via Voxta's speech-to-text
- **Action inference** — AI decides what to do based on your conversation, before or after its reply
- **Speech interruption** — Urgent events (taking damage, explosions) interrupt the bot mid-speech
- **Voice chance sliders** — Per-category probability controls for which results trigger voiced replies vs. silent notes

![Your companion in action — chatting and working in the Minecraft world](docs/screenshot-ingame.png)

### ⚒️ Autonomous Crafting
- **Full chain from nothing** — "Craft me a sword" with an empty inventory: bot chops trees, crafts planks, makes a crafting table, places it, crafts the item, and picks the table back up
- **Recursive dependency resolution** — Automatically crafts all required intermediate materials (logs → planks → sticks → sword)
- **Smart material selection** — Picks the best available variant (oak/spruce/birch) based on what's in inventory
- **Paper server compatible** — Proper window close sequence prevents inventory rollback issues

### 🏗️ Building System
- **Built-in structures** — Shelter (7×7 hut), Watchtower (5×5 tower with stairs), Wall (3×3 defensive barrier with arrow slit)
- **Auto-orientation** — Walls placed ahead of the player, rotated to match their look direction
- **Material-aware** — Picks cobblestone > planks > dirt based on inventory; reports exactly how many blocks are needed
- **Custom blueprints** — Load additional structures from JSON files
- **Build guard** — All other AI actions blocked during construction (except `mc_stop`)

### ⚔️ Combat
- **Auto-defense** — Automatically attacks hostile mobs that get within range
- **Combat modes** — Aggro (attack everything hostile), Hunt (target farm animals for food), Guard (patrol an area and defend it), Passive (only fights when attacked)
- **Hit-and-run kiting** — Zigzag approach against ranged attackers (skeletons, witches)
- **Creeper awareness** — Explosion detection via packet listener prevents false "defeated" reports
- **Combat timeouts** — 60-second absolute cap prevents infinite fight loops
- **Split mob handling** — Cooldowns for slimes/magma cubes prevent re-aggro spam

### 🐴 Mounted Navigation
- **Horse riding** — Mount and steer horses autonomously; follows the player at full gallop speed
- **Boat support** — Ride as a passenger in boats
- **Auto-dismount** — Hops off before attacking, following on foot, or navigating indoors
- **Vehicle-aware pathfinding** — Watchdog and spatial audio use vehicle position while mounted

### 🎣 Fishing & Survival
- **Fishing** — Cast rod, wait for bites, reel in automatically
- **Cooking** — Smelt food in furnaces
- **Auto-eat** — Notifies AI when eating automatically
- **Swimming** — Auto-jump to stay afloat when submerged

### 📦 Inventory & World Interaction
- **Give / receive items** — Toss items to player, receive from player
- **Chest management** — Store items in, take items from containers
- **Block placement** — Place blocks from inventory at valid positions nearby
- **Sleep** — Use beds at night

### 👁️ Vision
- **Screen capture** — Screenshots of your Minecraft window sent to Voxta's vision AI
- **Eyes mode** — Capture from the bot's spectator camera for true "bot vision"

### 🖥️ Desktop App
- Electron-based UI with connection management, chat history, action toggles, settings, and an inspector/debug drawer
- Real-time bot stats — health, hunger, mode, current action
- Toast notifications, action timing badges (before/after reply), chat log with event/note labeling
- Speech-to-text transcription display

![The companion app — chat, inspector, and real-time bot status](docs/screenshot-app.png)

## Requirements

- [Voxta](https://voxta.ai) server running (v0.x or later)
- A Minecraft Java Edition server (1.8 – 1.21+)
- Windows 10/11

## Installation

### From Releases (Recommended)
1. Download the latest release from [Releases](../../releases)
2. Run the installer
3. Launch **Voxta Minecraft Companion**

### From Source
```bash
git clone https://github.com/voxta-ai/voxta-minecraft-companion.git
cd voxta-minecraft-companion
npm install
npm run dev
```

## Quick Start

1. **Start Voxta** — Make sure your Voxta server is running
2. **Start a Minecraft server** — Or connect to an existing one
3. **Launch the companion** — Open the app and click 🔗 Connection
4. **Connect to Voxta** — Enter your Voxta URL (default: `http://localhost:5384/hub`)
5. **Configure Minecraft** — Enter the server host, port, and a bot username
6. **Select a character** — Pick which AI character will be your companion
7. **Launch!** — The bot joins your Minecraft world and starts chatting

## Building

```bash
# Development (with hot reload)
npm run dev

# Build the Electron app
npm run build

# Package as Windows installer
npm run dist

# Lint
npm run lint
npm run lint:fix

# Format
npm run format
npm run format:fix
```

## Architecture

```
src/
├── main/              # Electron main process
│   ├── bot-engine.ts  # Central orchestrator
│   ├── audio-pipeline.ts
│   ├── action-orchestrator.ts
│   ├── vision-capture.ts
│   └── voxta-message-handler.ts
├── bot/               # Bot logic (runs in main process)
│   ├── minecraft/     # Mineflayer integration
│   │   ├── actions/   # 13 action modules (mining, crafting, combat, etc.)
│   │   ├── perception.ts
│   │   ├── events.ts
│   │   └── game-data.ts
│   └── voxta/         # Voxta SignalR client
│       ├── client.ts
│       └── types.ts
├── renderer/          # SolidJS UI
│   ├── components/    # 10 UI components
│   ├── stores/        # SolidJS state management
│   └── services/      # Audio input service
├── shared/            # IPC types shared between processes
└── preload/           # Electron contextBridge
```

## Configuration

### Settings Panel
- **Events** — Toggle which game events trigger AI reactions (damage, death, mobs, etc.)
- **Notes** — Toggle which observations are silently noted by the AI (items, weather, time)
- **Voice Chance** — Set probability (0-100%) that action results trigger voiced responses, per category
- **Bot Behavior** — Auto-look at player, auto-defense, vision mode, action inference timing

### Action Toggles
Enable/disable individual game actions. Disabled actions won't be suggested by the AI.

## Tech Stack

- **Runtime**: [Electron](https://www.electronjs.org/) + [electron-vite](https://electron-vite.org/)
- **UI**: [SolidJS](https://www.solidjs.com/) + TypeScript
- **Minecraft**: [Mineflayer](https://github.com/PrismarineJS/mineflayer) + [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder)
- **AI Communication**: [SignalR](https://github.com/dotnet/aspnetcore/tree/main/src/SignalR) (WebSocket)
- **Linting**: ESLint (flat config) + Prettier
- **Packaging**: electron-builder (NSIS installer)

## License

[MIT](LICENSE)

## Links

- [Voxta](https://voxta.ai) — AI companion platform
- [Voxta Patreon](https://patreon.com/voxta) — Support the project
- [Mineflayer](https://github.com/PrismarineJS/mineflayer) — Minecraft bot framework
