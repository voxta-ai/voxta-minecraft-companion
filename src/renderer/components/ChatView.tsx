import { For, Show, createSignal, createEffect } from 'solid-js';
import { chatMessages, sendMessage, status } from '../stores/app-store';

interface ChatViewProps {
    onConnect: () => void;
}

export default function ChatView(props: ChatViewProps) {
    let messagesContainerRef: HTMLDivElement | undefined;
    const [inputText, setInputText] = createSignal('');

    // Auto-scroll to bottom when new messages arrive
    createEffect(() => {
        const _msgs = chatMessages.messages;
        if (messagesContainerRef) {
            setTimeout(() => {
                if (messagesContainerRef) {
                    messagesContainerRef.scrollTop = messagesContainerRef.scrollHeight;
                }
            }, 50);
        }
    });

    const handleSend = async () => {
        const text = inputText().trim();
        if (!text) return;
        setInputText('');
        await sendMessage(text);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void handleSend();
        }
    };

    const isConnected = () => status.sessionId !== null;

    return (
        <div class="chat-view">
            <Show
                when={chatMessages.messages.length > 0}
                fallback={
                    <div class="empty-chat">
                        <div class="empty-chat-content">
                            <span class="empty-chat-icon">⛏️</span>
                            <p>No active session</p>
                            <button class="btn btn-connect" onClick={() => props.onConnect()}>
                                🔗 Connect
                            </button>
                        </div>
                    </div>
                }
            >
                <div class="chat-messages" ref={(el) => (messagesContainerRef = el)}>
                    <For each={chatMessages.messages}>
                        {(msg) => (
                            <div class={`chat-msg ${msg.type}`}>
                                <div class="sender">{msg.sender}</div>
                                <div>
                                    {msg.text}
                                    {(msg.repeatCount ?? 0) > 1 && (
                                        <span class="repeat-count"> (×{msg.repeatCount})</span>
                                    )}
                                </div>
                            </div>
                        )}
                    </For>
                </div>
            </Show>

            <div class="chat-input-bar">
                <input
                    type="text"
                    placeholder={isConnected() ? 'Type a message...' : 'Connect first to chat'}
                    value={inputText()}
                    onInput={(e) => setInputText(e.currentTarget.value)}
                    onKeyDown={handleKeyDown}
                    disabled={!isConnected()}
                />
                <button
                    onClick={handleSend}
                    disabled={!isConnected() || !inputText().trim()}
                >
                    Send
                </button>
            </div>
        </div>
    );
}
