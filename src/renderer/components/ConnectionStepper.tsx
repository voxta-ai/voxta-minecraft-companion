import { For, Show } from 'solid-js';

const STEPS = [
    { key: 'connect', label: 'Connect' },
    { key: 'companion', label: 'Companion' },
    { key: 'chat', label: 'Chat' },
];

interface ConnectionStepperProps {
    /** Key of the currently active step: 'connect' | 'companion' | 'chat'. */
    current: () => string;
}

/** Compact progress header for the connection wizard. */
export default function ConnectionStepper(props: ConnectionStepperProps) {
    const currentIndex = () => {
        const idx = STEPS.findIndex((s) => s.key === props.current());
        return idx < 0 ? 0 : idx;
    };

    return (
        <div class="wizard-stepper">
            <For each={STEPS}>
                {(step, i) => (
                    <>
                        <div
                            class="wizard-step"
                            classList={{
                                done: i() < currentIndex(),
                                active: i() === currentIndex(),
                            }}
                        >
                            <span class="wizard-step-dot">
                                {i() < currentIndex() ? '✓' : i() + 1}
                            </span>
                            <span class="wizard-step-name">{step.label}</span>
                        </div>
                        <Show when={i() < STEPS.length - 1}>
                            <div class="wizard-step-line" classList={{ done: i() < currentIndex() }} />
                        </Show>
                    </>
                )}
            </For>
        </div>
    );
}
