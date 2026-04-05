import { For, Show } from 'solid-js';
import { parseConsoleLine } from '../utils/ConsoleFormatting';

interface Props {
    text: string;
}

export default function ConsoleLine(props: Props) {
    const tokens = () => parseConsoleLine(props.text);

    return (
        <div>
            <For each={tokens()}>
                {(token) => (
                    <Show
                        when={!token.isUrl}
                        fallback={
                            <a
                                href={token.text}
                                target="_blank"
                                rel="noreferrer"
                                style={{ color: '#569CD6', 'text-decoration': 'underline', cursor: 'pointer' }}
                                onClick={(e) => e.stopPropagation()}
                            >
                                {token.text}
                            </a>
                        }
                    >
                        <span style={{ color: token.color }}>{token.text}</span>
                    </Show>
                )}
            </For>
        </div>
    );
}
