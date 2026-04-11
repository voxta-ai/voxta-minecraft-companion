import { createSignal, createEffect, Show, For } from 'solid-js';
import { serverState, serverConsole, clearServerConsole } from '../../stores/server-store';

export default function ConsoleSection() {
    const [commandInput, setCommandInput] = createSignal('');
    const [consoleCopied, setConsoleCopied] = createSignal(false);
    let consoleRef: HTMLDivElement | undefined;

    // Auto-scroll console to bottom
    createEffect(() => {
        void serverConsole.lines.length; // reactive dependency — triggers scroll on new lines
        if (consoleRef) {
            requestAnimationFrame(() => {
                if (consoleRef) consoleRef.scrollTop = consoleRef.scrollHeight;
            });
        }
    });

    function handleSendCommand(): void {
        const cmd = commandInput().trim();
        if (!cmd) return;
        void window.api.serverSendCommand(cmd);
        setCommandInput('');
    }

    return (
        <div class="server-console-section">
            <div class="server-console-toolbar">
                <span class="server-console-count">{serverConsole.lines.length} lines</span>
                <button
                    class="terminal-toolbar-btn"
                    onClick={() => {
                        const text = serverConsole.lines
                            .map((line) => {
                                const time = new Date(line.timestamp).toLocaleTimeString([], {
                                    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
                                });
                                return `${time} ${line.text}`;
                            })
                            .join('\n');
                        void navigator.clipboard.writeText(text).then(() => {
                            setConsoleCopied(true);
                            setTimeout(() => setConsoleCopied(false), 1500);
                        });
                    }}
                    title="Copy to Clipboard"
                >
                    <i class={consoleCopied() ? 'bi bi-check-lg' : 'bi bi-clipboard'}></i> {consoleCopied() ? 'Copied!' : 'Copy'}
                </button>
                <button class="terminal-toolbar-btn" onClick={clearServerConsole}>
                    <i class="bi bi-slash-circle"></i> Clear
                </button>
            </div>
            <div class="server-console-logs" ref={(el) => (consoleRef = el)}>
                <code>
                    <For each={serverConsole.lines}>
                        {(line) => (
                            <div class={`terminal-row ${line.level === 'error' ? 'terminal-row-error' : line.level === 'warn' ? 'terminal-row-warn' : ''}`}>
                                <span class="terminal-timestamp">
                                    {new Date(line.timestamp).toLocaleTimeString([], {
                                        hour12: false,
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        second: '2-digit',
                                    })}
                                </span>
                                <div class="terminal-content">{line.text}</div>
                            </div>
                        )}
                    </For>
                    <Show when={serverConsole.lines.length === 0}>
                        <div class="terminal-empty">Server console is empty. Start the server to see output.</div>
                    </Show>
                </code>
            </div>
            <div class="server-command-bar">
                <input
                    type="text"
                    value={commandInput()}
                    onInput={(e) => setCommandInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSendCommand();
                    }}
                    placeholder={serverState() === 'running' ? 'Type a server command...' : 'Server is not running'}
                    disabled={serverState() !== 'running'}
                />
                <button
                    class="btn btn-connect server-command-send"
                    onClick={handleSendCommand}
                    disabled={serverState() !== 'running' || !commandInput().trim()}
                >
                    Send
                </button>
            </div>
        </div>
    );
}
