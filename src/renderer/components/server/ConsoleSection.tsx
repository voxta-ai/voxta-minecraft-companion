import { createSignal, createEffect, Show, For } from 'solid-js';
import { serverState, serverConsole, clearServerConsole } from '../../stores/server-store';
import { formatTimestamp } from '../../utils/format';
import CopyButton from '../CopyButton';

export default function ConsoleSection() {
    const [commandInput, setCommandInput] = createSignal('');
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
                <CopyButton
                    getText={() =>
                        serverConsole.lines
                            .map((line) => `${formatTimestamp(line.timestamp)} ${line.text}`)
                            .join('\n')
                    }
                />
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
                                    {formatTimestamp(line.timestamp)}
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
