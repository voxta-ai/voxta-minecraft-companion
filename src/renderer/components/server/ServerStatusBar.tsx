import { Show } from 'solid-js';
import type { Accessor, JSXElement } from 'solid-js';
import { serverState, serverPort, serverError, startServer, stopServer } from '../../stores/server-store';

function getStateLabel(state: string): string {
    switch (state) {
        case 'not-installed':
            return 'Not Installed';
        case 'idle':
            return 'Stopped';
        case 'starting':
            return 'Starting...';
        case 'running':
            return 'Running';
        case 'stopping':
            return 'Stopping...';
        case 'error':
            return 'Error';
        default:
            return state;
    }
}

function getStateDotClass(state: string): string {
    switch (state) {
        case 'running':
            return 'connected';
        case 'starting':
        case 'stopping':
            return 'connecting';
        case 'error':
            return 'error';
        default:
            return 'disconnected';
    }
}

interface ServerStatusBarProps {
    installedVersion: Accessor<string | null>;
    /** Extra buttons shown before Start/Stop (e.g. the Server Manager's version change). */
    actions?: JSXElement;
    /** Hide Start when the caller starts the server itself (the wizard's "Start server & continue"). */
    hideStart?: boolean;
}

/** Built-in server state, port and version with Start/Stop. */
export default function ServerStatusBar(props: ServerStatusBarProps) {
    return (
        <div class="server-status-bar">
            <div class="server-status-info">
                <span class={`status-dot ${getStateDotClass(serverState())}`} />
                <span class="server-status-label">{getStateLabel(serverState())}</span>
                <Show when={serverState() === 'running'}>
                    <span class="server-port">:{serverPort()}</span>
                </Show>
                <span class="server-version-badge">Paper {props.installedVersion() ?? ''}</span>
                <Show when={serverError()}>
                    <span class="server-error-msg">{serverError()}</span>
                </Show>
            </div>
            <div class="server-status-actions">
                {props.actions}
                <Show
                    when={serverState() !== 'running' && serverState() !== 'starting'}
                    fallback={
                        <button
                            class="btn btn-disconnect"
                            onClick={() => void stopServer()}
                            disabled={serverState() === 'stopping'}
                        >
                            {serverState() === 'stopping' ? 'Stopping...' : 'Stop'}
                        </button>
                    }
                >
                    <Show when={!props.hideStart}>
                        <button
                            class="btn btn-connect"
                            onClick={() => void startServer()}
                            disabled={serverState() === 'stopping'}
                        >
                            Start
                        </button>
                    </Show>
                </Show>
            </div>
        </div>
    );
}
