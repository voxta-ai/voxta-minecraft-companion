import { createSignal, Show, onMount, onCleanup } from 'solid-js';
import { useStatusListener, useChatListener, status, stopSession } from './stores/app-store';
import { addLogEntry } from './stores/console-store';
import { initServerStore } from './stores/server-store';
import ConnectionPanel from './components/ConnectionPanel';
import SettingsPanel from './components/SettingsPanel';
import ChatView from './components/ChatView';
import ActionToggles from './components/ActionToggles';
import StatusBar from './components/StatusBar';
import Modal from './components/Modal';
import ToastContainer from './components/ToastContainer';
import AudioPlayer from './components/AudioPlayer';
import InspectorDrawer from './components/InspectorDrawer';
import TerminalPanel from './components/TerminalPanel';
import ServerPanel from './components/ServerPanel';

type Popup = 'connection' | 'actions' | 'settings' | 'server' | null;

export default function App() {
    useStatusListener();
    useChatListener();
    initServerStore();

    const [activePopup, setActivePopup] = createSignal<Popup>(null);
    const [inspectorOpen, setInspectorOpen] = createSignal(false);
    const [terminalOpen, setTerminalOpen] = createSignal(false);

    const togglePopup = (popup: Popup) => {
        setActivePopup(activePopup() === popup ? null : popup);
    };

    // Subscribe to console logs from main process at app level
    // (not inside TerminalPanel, which only mounts when visible)
    onMount(() => {
        const unsub = window.api.onConsoleLog((entry) => {
            addLogEntry(entry);
        });
        onCleanup(unsub);
    });

    // F2 to toggle terminal
    onMount(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'F2') {
                e.preventDefault();
                setTerminalOpen((prev) => !prev);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        onCleanup(() => window.removeEventListener('keydown', handleKeyDown));
    });

    return (
        <div class="app">
            <AudioPlayer />
            <header class="app-header">
                <div class="header-left">
                    <span class="logo">⛏️</span>
                    <h1>Voxta Minecraft Companion</h1>
                </div>
                <div class="header-actions">
                    <Show
                        when={status.sessionId !== null}
                        fallback={
                            <button
                                class={`header-btn ${activePopup() === 'connection' ? 'active' : ''}`}
                                onClick={() => togglePopup('connection')}
                                title="Connection"
                            >
                                <span class="header-btn-icon">🔗</span>
                                <span class="header-btn-label">Connect</span>
                            </button>
                        }
                    >
                        <button
                            class="header-btn header-btn-disconnect"
                            onClick={() => {
                                void stopSession().then(() => setActivePopup('connection'));
                            }}
                            title="Stop Session"
                        >
                            <span class="header-btn-icon">■</span>
                            <span class="header-btn-label">Stop</span>
                        </button>
                    </Show>
                    <button
                        class={`header-btn ${activePopup() === 'actions' ? 'active' : ''}`}
                        onClick={() => togglePopup('actions')}
                        title="Actions"
                    >
                        <span class="header-btn-icon">🎮</span>
                        <span class="header-btn-label">Actions</span>
                    </button>
                    <button
                        class={`header-btn ${activePopup() === 'settings' ? 'active' : ''}`}
                        onClick={() => togglePopup('settings')}
                        title="Settings"
                    >
                        <span class="header-btn-icon">⚙️</span>
                        <span class="header-btn-label">Settings</span>
                    </button>
                    <button
                        class={`header-btn ${activePopup() === 'server' ? 'active' : ''}`}
                        onClick={() => togglePopup('server')}
                        title="Server Manager"
                    >
                        <span class="header-btn-icon" style={{ color: 'var(--text-secondary)' }}><i class="bi bi-hdd-rack"></i></span>
                        <span class="header-btn-label">Server</span>
                    </button>
                    <button
                        class={`header-btn ${terminalOpen() ? 'active' : ''}`}
                        onClick={() => setTerminalOpen(!terminalOpen())}
                        title="Terminal (F2)"
                    >
                        <span class="header-btn-icon" style={{ color: 'var(--text-secondary)' }}><i class="bi bi-terminal-fill"></i></span>
                        <span class="header-btn-label">Terminal</span>
                    </button>
                    <button
                        class={`header-btn ${inspectorOpen() ? 'active' : ''}`}
                        onClick={() => setInspectorOpen(!inspectorOpen())}
                        title="Inspector"
                    >
                        <span class="header-btn-icon">🔍</span>
                        <span class="header-btn-label">Inspector {inspectorOpen() ? '▸' : '◂'}</span>
                    </button>
                </div>
            </header>

            <Show
                when={!terminalOpen()}
                fallback={<TerminalPanel />}
            >
                <div class="app-body">
                    <div class="main-panel">
                        <ChatView onConnect={() => setActivePopup('connection')} />
                    </div>
                    <InspectorDrawer open={inspectorOpen()} />
                </div>
            </Show>

            <StatusBar />
            <ToastContainer />

            {/* Popup modals */}
            <Modal open={activePopup() === 'connection'} title="🔗 Connection" onClose={() => setActivePopup(null)}>
                <ConnectionPanel onClose={() => setActivePopup(null)} />
            </Modal>

            <Modal open={activePopup() === 'actions'} title="🎮 Actions" onClose={() => setActivePopup(null)}>
                <ActionToggles />
            </Modal>

            <Modal open={activePopup() === 'settings'} title="⚙️ Settings" onClose={() => setActivePopup(null)}>
                <SettingsPanel />
            </Modal>

            <Modal open={activePopup() === 'server'} title="Server Manager" onClose={() => setActivePopup(null)}>
                <ServerPanel />
            </Modal>
        </div>
    );
}

