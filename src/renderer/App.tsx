import { useStatusListener, useChatListener } from './stores/app-store';
import ConnectionPanel from './components/ConnectionPanel';
import ChatView from './components/ChatView';
import ActionToggles from './components/ActionToggles';
import StatusBar from './components/StatusBar';

export default function App() {
    useStatusListener();
    useChatListener();

    return (
        <div class="app">
            <header class="app-header">
                <span class="logo">⛏️</span>
                <h1>Voxta Minecraft Companion</h1>
            </header>

            <ConnectionPanel />

            <div class="app-body">
                <div class="main-panel">
                    <ChatView />
                </div>
                <div class="side-panel">
                    <ActionToggles />
                </div>
            </div>

            <StatusBar />
        </div>
    );
}
