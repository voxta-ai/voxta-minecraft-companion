import { createSignal } from 'solid-js';
import { useStatusListener, useChatListener, useCharactersListener } from './stores/app-store';
import ConnectionPanel from './components/ConnectionPanel';
import SettingsPanel from './components/SettingsPanel';
import ChatView from './components/ChatView';
import ActionToggles from './components/ActionToggles';
import StatusBar from './components/StatusBar';
import Modal from './components/Modal';

type Popup = 'connection' | 'actions' | 'settings' | null;

export default function App() {
    useStatusListener();
    useChatListener();
    useCharactersListener();

    const [activePopup, setActivePopup] = createSignal<Popup>(null);

    const togglePopup = (popup: Popup) => {
        setActivePopup(activePopup() === popup ? null : popup);
    };

    return (
        <div class="app">
            <header class="app-header">
                <div class="header-left">
                    <span class="logo">⛏️</span>
                    <h1>Voxta Minecraft Companion</h1>
                </div>
                <div class="header-actions">
                    <button
                        class={`header-btn ${activePopup() === 'connection' ? 'active' : ''}`}
                        onClick={() => togglePopup('connection')}
                        title="Connection"
                    >
                        🔗
                    </button>
                    <button
                        class={`header-btn ${activePopup() === 'actions' ? 'active' : ''}`}
                        onClick={() => togglePopup('actions')}
                        title="Actions"
                    >
                        🎮
                    </button>
                    <button
                        class={`header-btn ${activePopup() === 'settings' ? 'active' : ''}`}
                        onClick={() => togglePopup('settings')}
                        title="Settings"
                    >
                        ⚙️
                    </button>
                </div>
            </header>

            <div class="app-body">
                <div class="main-panel">
                    <ChatView />
                </div>
            </div>

            <StatusBar />

            {/* Popup modals */}
            <Modal
                open={activePopup() === 'connection'}
                title="🔗 Connection"
                onClose={() => setActivePopup(null)}
            >
                <ConnectionPanel />
            </Modal>

            <Modal
                open={activePopup() === 'actions'}
                title="🎮 Actions"
                onClose={() => setActivePopup(null)}
            >
                <ActionToggles />
            </Modal>

            <Modal
                open={activePopup() === 'settings'}
                title="⚙️ Settings"
                onClose={() => setActivePopup(null)}
            >
                <SettingsPanel />
            </Modal>
        </div>
    );
}
