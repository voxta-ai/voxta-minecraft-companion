import { Show } from 'solid-js';
import type { JSXElement } from 'solid-js';

interface ModalProps {
    open: boolean;
    title: string;
    onClose: () => void;
    children: JSXElement;
}

export default function Modal(props: ModalProps) {
    const handleBackdropClick = (e: MouseEvent) => {
        if (e.target === e.currentTarget) props.onClose();
    };

    return (
        <Show when={props.open}>
            <div class="modal-overlay" onClick={handleBackdropClick}>
                <div class="modal-content">
                    <div class="modal-header">
                        <h2>{props.title}</h2>
                        <button class="modal-close" onClick={() => props.onClose()}>✕</button>
                    </div>
                    <div class="modal-body">
                        {props.children}
                    </div>
                </div>
            </div>
        </Show>
    );
}
