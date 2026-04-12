import { createSignal } from 'solid-js';

const COPY_FEEDBACK_TIMEOUT_MS = 1500;

interface CopyButtonProps {
    getText: () => string;
    class?: string;
    title?: string;
}

/** Reusable clipboard copy button with "Copied!" feedback */
export default function CopyButton(props: CopyButtonProps) {
    const [copied, setCopied] = createSignal(false);

    function handleCopy(): void {
        void navigator.clipboard.writeText(props.getText()).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), COPY_FEEDBACK_TIMEOUT_MS);
        });
    }

    return (
        <button
            class={props.class ?? 'terminal-toolbar-btn'}
            onClick={handleCopy}
            title={props.title ?? 'Copy to Clipboard'}
        >
            <i class={copied() ? 'bi bi-check-lg' : 'bi bi-clipboard'}></i> {copied() ? 'Copied!' : 'Copy'}
        </button>
    );
}
