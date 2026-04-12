import { For, Show, createSignal, createEffect, createMemo } from 'solid-js';
import { chatMessages, sendMessage } from '../stores/chat-store';
import { status } from '../stores/connection-store';
import { speechPartialText, setSpeechPartialText } from '../stores/audio-store';
import AudioIcons from './AudioIcons';
import iconPng from '../icon.png';

const isDualBot = () => !!status.assistantName2;

interface ChatViewProps {
    onConnect: () => void;
}

export default function ChatView(props: ChatViewProps) {
    let messagesContainerRef: HTMLDivElement | undefined;
    const [inputText, setInputText] = createSignal('');

    // Auto-scroll to the bottom when new messages arrive
    createEffect(() => {
        // Read messages to subscribe — SolidJS re-runs this effect when the store changes
        const _msgs = chatMessages.messages;
        if (messagesContainerRef) {
            setTimeout(() => {
                if (messagesContainerRef) {
                    messagesContainerRef.scrollTop = messagesContainerRef.scrollHeight;
                }
            }, 50);
        }
    });

    // Show partial speech text in the input, or the user's typed text
    const displayValue = createMemo(() => {
        const partial = speechPartialText();
        return partial || inputText();
    });

    const handleSend = async () => {
        const text = inputText().trim();
        if (!text) return;
        setInputText('');
        setSpeechPartialText('');
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
                            <img src={iconPng} alt="Voxta Minecraft" class="empty-chat-icon" />
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
                                <div class="sender">
                                    {msg.sender}
                                    <span class="chat-time">
                                        {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                    </span>
                                </div>
                                <div>
                                    {msg.text}
                                    {(msg.repeatCount ?? 0) > 1 && (
                                        <span class="repeat-count"> (×{msg.repeatCount})</span>
                                    )}
                                </div>
                                <Show when={msg.badge}>
                                    <span
                                        class="chat-badge"
                                        data-variant={msg.badge?.includes('before') ? 'before' : 'after'}
                                    >
                                        {msg.badge}
                                    </span>
                                </Show>
                            </div>
                        )}
                    </For>
                </div>
            </Show>

            <div class="chat-input-bar">
                <div class="chat-input-wrapper">
                    <input
                        type="text"
                        placeholder={isConnected() ? 'Type a message...' : 'Connect first to chat'}
                        value={displayValue()}
                        onInput={(e) => {
                            setSpeechPartialText('');
                            setInputText(e.currentTarget.value);
                        }}
                        onKeyDown={handleKeyDown}
                        disabled={!isConnected()}
                    />
                    <AudioIcons />
                </div>
                <button
                    class="btn-send"
                    onClick={() => void handleSend()}
                    disabled={!isConnected() || !inputText().trim()}
                    title="Send message"
                >
                    <i class="bi bi-send-fill"></i>
                </button>
                <Show when={isDualBot() && isConnected()}>
                    <button
                        class={`btn-pause ${status.paused ? 'paused' : ''}`}
                        onClick={() => void window.api.pauseChat(!status.paused)}
                        title={status.paused ? 'Resume auto-conversation' : 'Pause auto-conversation'}
                    >
                        <i class={`bi ${status.paused ? 'bi-play-fill' : 'bi-pause-fill'}`}></i>
                    </button>
                </Show>
            </div>
        </div>
    );
}
