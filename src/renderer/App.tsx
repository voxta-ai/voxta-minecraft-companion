import { createSignal } from 'solid-js';
import { useStatusListener, useChatListener } from './stores/app-store';
import ConnectionPanel from './components/ConnectionPanel';
import SettingsPanel from './components/SettingsPanel';
import ChatView from './components/ChatView';
import ActionToggles from './components/ActionToggles';
import StatusBar from './components/StatusBar';
import Modal from './components/Modal';
import ToastContainer from './components/ToastContainer';
import AudioPlayer from './components/AudioPlayer';

type Popup = 'connection' | 'actions' | 'settings' | null;

export default function App() {
    useStatusListener();
    useChatListener();

    const [activePopup, setActivePopup] = createSignal<Popup>(null);

    const togglePopup = (popup: Popup) => {
        setActivePopup(activePopup() === popup ? null : popup);
    };

    return (
        <div class="app">
            <AudioPlayer />
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
                    <ChatView onConnect={() => setActivePopup('connection')} />
                </div>
            </div>

            <StatusBar />
            <ToastContainer />

            {/* Popup modals */}
            <Modal
                open={activePopup() === 'connection'}
                title="🔗 Connection"
                onClose={() => setActivePopup(null)}
            >
                <ConnectionPanel onClose={() => setActivePopup(null)} />
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
