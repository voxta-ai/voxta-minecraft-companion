import { createSignal, createEffect, Show, For } from 'solid-js';
import type { ServerState } from '../../shared/ipc-types';
import { serverState, serverError, startupProgress, serverConsole } from '../stores/server-store';

const STEPS = [
    { key: 1, label: 'Preparing server files' },
    { key: 2, label: 'Checking Java runtime' },
    { key: 3, label: 'Launching server' },
    { key: 4, label: 'Loading world' },
];

/**
 * Friendly popup shown while the managed Minecraft server boots (e.g. after
 * auto-start on connect). Replaces the old "button text changes to Starting..."
 * behaviour with a branded step checklist + live status line.
 */
export default function ServerStartupModal() {
    const [visible, setVisible] = createSignal(false);
    let prev: ServerState | null = null;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;

    createEffect(() => {
        const s = serverState();
        if (s === 'starting' && prev !== 'starting') {
            if (hideTimer) clearTimeout(hideTimer);
            setVisible(true);
        } else if (s === 'running' && prev === 'starting') {
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = setTimeout(() => setVisible(false), 1600);
        } else if (s === 'idle' || s === 'not-installed') {
            if (hideTimer) clearTimeout(hideTimer);
            setVisible(false);
        }
        // 'error' keeps the popup open so the user sees what went wrong;
        // 'stopping' leaves the current visibility untouched.
        prev = s;
    });

    const isRunning = () => serverState() === 'running';
    const isError = () => serverState() === 'error';
    const activeStep = () => startupProgress()?.step ?? 1;
    const currentStep = () => (isRunning() ? STEPS.length + 1 : activeStep());

    const stepStatus = (key: number): 'done' | 'active' | 'pending' => {
        if (isError()) {
            if (key < activeStep()) return 'done';
            return key === activeStep() ? 'active' : 'pending';
        }
        if (key < currentStep()) return 'done';
        return key === currentStep() ? 'active' : 'pending';
    };

    const percent = () => {
        if (isRunning()) return 100;
        return Math.round((Math.max(0, currentStep() - 1) / STEPS.length) * 100);
    };

    const statusLine = () => {
        const lines = serverConsole.lines;
        return lines.length ? lines[lines.length - 1].text : '';
    };

    const heading = () =>
        isError() ? 'Server failed to start' : isRunning() ? 'Server ready' : 'Starting Minecraft server';
    const subtitle = () =>
        isError()
            ? (serverError() ?? 'Something went wrong while starting the server.')
            : isRunning()
                ? 'Your world is up and running.'
                : 'Hang tight while we get your world ready.';

    return (
        <Show when={visible()}>
            <div class="startup-overlay">
                <div class="startup-modal">
                    <div class="startup-header">
                        <div
                            class="startup-emblem"
                            classList={{ done: isRunning(), error: isError() }}
                        >
                            <i
                                class={`bi ${isError() ? 'bi-exclamation-triangle-fill' : isRunning() ? 'bi-check-circle-fill' : 'bi-hdd-network'}`}
                            ></i>
                        </div>
                        <div class="startup-heading">
                            <h2>{heading()}</h2>
                            <p>{subtitle()}</p>
                        </div>
                    </div>

                    <div class="startup-bar">
                        <div
                            class="startup-bar-fill"
                            classList={{ error: isError() }}
                            style={{ width: `${percent()}%` }}
                        />
                    </div>

                    <ul class="startup-steps">
                        <For each={STEPS}>
                            {(step) => {
                                const st = () => stepStatus(step.key);
                                return (
                                    <li
                                        class="startup-step"
                                        classList={{
                                            done: st() === 'done',
                                            active: st() === 'active',
                                            pending: st() === 'pending',
                                            error: isError() && st() === 'active',
                                        }}
                                    >
                                        <span class="startup-step-icon">
                                            <i
                                                class={`bi ${
                                                    st() === 'done'
                                                        ? 'bi-check-circle-fill'
                                                        : st() === 'active'
                                                            ? isError()
                                                                ? 'bi-x-circle-fill'
                                                                : 'bi-arrow-repeat'
                                                            : 'bi-circle'
                                                }`}
                                            ></i>
                                        </span>
                                        <span class="startup-step-label">
                                            {st() === 'active' && startupProgress()?.label
                                                ? startupProgress()!.label
                                                : step.label}
                                        </span>
                                    </li>
                                );
                            }}
                        </For>
                    </ul>

                    <Show when={statusLine() && !isRunning()}>
                        <div class="startup-status-line" title={statusLine()}>
                            {statusLine()}
                        </div>
                    </Show>

                    <div class="startup-actions">
                        <Show
                            when={isError()}
                            fallback={
                                <button class="startup-ghost-btn" onClick={() => setVisible(false)}>
                                    Run in background
                                </button>
                            }
                        >
                            <button class="btn btn-disconnect" onClick={() => setVisible(false)}>
                                Close
                            </button>
                        </Show>
                    </div>
                </div>
            </div>
        </Show>
    );
}
