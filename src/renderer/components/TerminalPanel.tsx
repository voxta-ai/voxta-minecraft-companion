import { For, Show, createEffect, createSignal } from 'solid-js';
import { consoleLogs, clearLogs } from '../stores/console-store';
import ConsoleLine from './ConsoleLine';

/**
 * In-app terminal panel.
 * Toggled open/closed by F2 key or a header button.
 * Displays main-process console output with VS Code-style coloring.
 * Note: Log subscription is in App.tsx so logs are captured even when the panel is hidden.
 */
export default function TerminalPanel() {
    let logsContainerRef: HTMLDivElement | undefined;
    const [copied, setCopied] = createSignal(false);

    // Auto-scroll to bottom when new entries arrive
    createEffect(() => {
        const _count = consoleLogs.entries.length;
        if (logsContainerRef) {
            requestAnimationFrame(() => {
                if (logsContainerRef) {
                    logsContainerRef.scrollTop = logsContainerRef.scrollHeight;
                }
            });
        }
    });

    const getLevelIcon = (level: string): string => {
        switch (level) {
            case 'error':
                return '✕';
            case 'warn':
                return '⚠';
            default:
                return '';
        }
    };

    const getLevelClass = (level: string): string => {
        switch (level) {
            case 'error':
                return 'terminal-row-error';
            case 'warn':
                return 'terminal-row-warn';
            default:
                return '';
        }
    };

    return (
        <div class="terminal-panel">
            <div class="terminal-toolbar">
                <div class="terminal-toolbar-left">
                    <span class="terminal-toolbar-icon"><i class="bi bi-terminal-fill"></i></span>
                    <span class="terminal-toolbar-title">
                        Console ({consoleLogs.entries.length})
                    </span>
                </div>
                <div class="terminal-toolbar-actions">
                    <button
                        class="terminal-toolbar-btn"
                        onClick={() => {
                            const text = consoleLogs.entries
                                .map((e) => {
                                    const time = new Date(e.timestamp).toLocaleTimeString([], {
                                        hour12: false,
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        second: '2-digit',
                                    });
                                    return `${time} ${e.text}`;
                                })
                                .join('\n');
                            void navigator.clipboard.writeText(text).then(() => {
                                setCopied(true);
                                setTimeout(() => setCopied(false), 1500);
                            });
                        }}
                        title="Copy to Clipboard"
                    >
                        <i class={copied() ? 'bi bi-check-lg' : 'bi bi-clipboard'}></i> {copied() ? 'Copied!' : 'Copy'}
                    </button>
                    <button
                        class="terminal-toolbar-btn"
                        onClick={clearLogs}
                        title="Clear Console"
                    >
                        <i class="bi bi-slash-circle"></i> Clear
                    </button>
                </div>
            </div>

            <div class="terminal-logs" ref={(el) => (logsContainerRef = el)}>
                <code>
                    <For each={consoleLogs.entries}>
                        {(entry) => (
                            <div class={`terminal-row ${getLevelClass(entry.level)}`}>
                                <span class="terminal-timestamp">
                                    {new Date(entry.timestamp).toLocaleTimeString([], {
                                        hour12: false,
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        second: '2-digit',
                                    })}
                                </span>
                                <Show when={entry.level !== 'log'}>
                                    <span class="terminal-level-icon">{getLevelIcon(entry.level)}</span>
                                </Show>
                                <div class="terminal-content">
                                    <ConsoleLine text={entry.text} />
                                </div>
                            </div>
                        )}
                    </For>
                    <Show when={consoleLogs.entries.length === 0}>
                        <div class="terminal-empty">Console is empty</div>
                    </Show>
                </code>
            </div>
        </div>
    );
}
