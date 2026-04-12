import type { Accessor } from 'solid-js';
import type { SetupProgress } from '../../shared/ipc-types';

interface SetupProgressBarProps {
    progress: Accessor<SetupProgress | null>;
}

/** Reusable progress bar for server setup / plugin installation */
export default function SetupProgressBar(props: SetupProgressBarProps) {
    const widthPercent = (): string => {
        const p = props.progress();
        if (!p) return '0%';
        if (p.bytesTotal) {
            return `${Math.round(((p.bytesDownloaded ?? 0) / p.bytesTotal) * 100)}%`;
        }
        return `${Math.round(((p.step ?? 0) / (p.totalSteps ?? 1)) * 100)}%`;
    };

    return (
        <div class="server-setup-progress">
            <div class="server-setup-progress-label">{props.progress()?.label}</div>
            <div class="server-setup-progress-bar">
                <div class="server-setup-progress-fill" style={{ width: widthPercent() }} />
            </div>
        </div>
    );
}
