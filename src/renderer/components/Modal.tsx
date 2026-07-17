import { Show } from 'solid-js';
import type { JSXElement } from 'solid-js';

interface ModalProps {
    open: boolean;
    title: string;
    onClose: () => void;
    children: JSXElement;
}

export default function Modal(props: ModalProps) {
    // Only treat it as a backdrop dismiss when the press STARTED on the overlay.
    // Otherwise a text-selection drag that starts in an input and releases on
    // the backdrop would close the modal.
    let pressedOnOverlay = false;

    const handleOverlayMouseDown = (e: MouseEvent) => {
        pressedOnOverlay = e.target === e.currentTarget;
    };

    const handleBackdropClick = (e: MouseEvent) => {
        if (e.target === e.currentTarget && pressedOnOverlay) props.onClose();
        pressedOnOverlay = false;
    };

    return (
        <Show when={props.open}>
            <div class="modal-overlay" onMouseDown={handleOverlayMouseDown} onClick={handleBackdropClick}>
                <div class="modal-content">
                    <div class="modal-header">
                        <h2>{props.title}</h2>
                        <button class="modal-close" onClick={() => props.onClose()}>
                            ✕
                        </button>
                    </div>
                    <div class="modal-body">{props.children}</div>
                </div>
            </div>
        </Show>
    );
}
