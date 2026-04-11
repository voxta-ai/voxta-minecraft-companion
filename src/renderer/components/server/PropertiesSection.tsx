import { Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import { serverState } from '../../stores/server-store';
import type { ServerProperties } from '../../../shared/ipc-types';

interface PropertiesSectionProps {
    properties: Accessor<ServerProperties>;
    updateProperty: (key: string, value: string) => void;
    propsChanged: Accessor<boolean>;
    savingProps: Accessor<boolean>;
    onSaveProperties: () => void;
    onResetDefaults: () => void;
    // Config
    memoryMb: Accessor<number>;
    setMemoryMb: (v: number) => void;
    autoStart: Accessor<boolean>;
    setAutoStart: (v: boolean) => void;
    configChanged: Accessor<boolean>;
    setConfigChanged: (v: boolean) => void;
    savingConfig: Accessor<boolean>;
    onSaveConfig: () => void;
}

export default function PropertiesSection(props: PropertiesSectionProps) {
    return (
        <div class="server-properties-section">
            <Show when={serverState() === 'running'}>
                <div class="server-hint">Changes require a server restart to take effect.</div>
            </Show>

            <div class="server-section-group">
                <div class="section-title">Startup</div>
                <div class="setting-card-list">
                    <div class="setting-card">
                        <div class="setting-card-info">
                            <div class="setting-card-name">Auto-start server</div>
                            <div class="setting-card-desc">
                                Automatically start the server when connecting to Voxta
                            </div>
                        </div>
                        <label class="toggle">
                            <input
                                type="checkbox"
                                checked={props.autoStart()}
                                onChange={(e) => {
                                    props.setAutoStart(e.currentTarget.checked);
                                    props.setConfigChanged(true);
                                }}
                            />
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                </div>
            </div>

            <div class="server-section-group">
                <div class="section-title">Performance</div>
                <div class="setting-card-list">
                    <div class="setting-card setting-card-column">
                        <div class="setting-card-info">
                            <div class="setting-card-name">Server Memory (RAM)</div>
                            <div class="setting-card-desc">
                                More memory allows larger worlds and more plugins
                            </div>
                        </div>
                        <div class="memory-slider-row">
                            <input
                                type="range"
                                class="memory-slider"
                                min="512"
                                max="8192"
                                step="512"
                                value={props.memoryMb()}
                                onInput={(e) => {
                                    props.setMemoryMb(parseInt(e.currentTarget.value, 10));
                                    props.setConfigChanged(true);
                                }}
                            />
                            <span class="memory-value">
                                {props.memoryMb() >= 1024 ? `${(props.memoryMb() / 1024).toFixed(props.memoryMb() % 1024 === 0 ? 0 : 1)} GB` : `${props.memoryMb()} MB`}
                            </span>
                        </div>
                        <div class="memory-labels">
                            <span>512 MB</span>
                            <span>8 GB</span>
                        </div>
                    </div>
                </div>
            </div>

            <div class="server-section-group">
                <div class="section-title">Game</div>
                <div class="setting-card-list">
                    <div class="setting-card">
                        <div class="setting-card-info">
                            <div class="setting-card-name">Difficulty</div>
                        </div>
                        <select
                            class="vision-select"
                            value={props.properties()['difficulty'] ?? 'easy'}
                            onChange={(e) => props.updateProperty('difficulty', e.currentTarget.value)}
                        >
                            <option value="peaceful">Peaceful</option>
                            <option value="easy">Easy</option>
                            <option value="normal">Normal</option>
                            <option value="hard">Hard</option>
                        </select>
                    </div>
                    <div class="setting-card">
                        <div class="setting-card-info">
                            <div class="setting-card-name">Game Mode</div>
                        </div>
                        <select
                            class="vision-select"
                            value={props.properties()['gamemode'] ?? 'survival'}
                            onChange={(e) => props.updateProperty('gamemode', e.currentTarget.value)}
                        >
                            <option value="survival">Survival</option>
                            <option value="creative">Creative</option>
                            <option value="adventure">Adventure</option>
                            <option value="spectator">Spectator</option>
                        </select>
                    </div>
                    <div class="setting-card">
                        <div class="setting-card-info">
                            <div class="setting-card-name">Max Players</div>
                        </div>
                        <input
                            type="number"
                            class="server-prop-number"
                            value={props.properties()['max-players'] ?? '5'}
                            min="1"
                            max="100"
                            onChange={(e) => props.updateProperty('max-players', e.currentTarget.value)}
                        />
                    </div>
                </div>
            </div>

            <div class="server-section-group">
                <div class="section-title">Server</div>
                <div class="setting-card-list">
                    <div class="setting-card">
                        <div class="setting-card-info">
                            <div class="setting-card-name">MOTD</div>
                            <div class="setting-card-desc">Message shown in the server browser</div>
                        </div>
                        <input
                            type="text"
                            class="server-prop-text"
                            value={props.properties()['motd'] ?? 'Voxta Test Server'}
                            onChange={(e) => props.updateProperty('motd', e.currentTarget.value)}
                        />
                    </div>
                    <div class="setting-card">
                        <div class="setting-card-info">
                            <div class="setting-card-name">Server Port</div>
                        </div>
                        <input
                            type="number"
                            class="server-prop-number"
                            value={props.properties()['server-port'] ?? '25565'}
                            min="1024"
                            max="65535"
                            onChange={(e) => props.updateProperty('server-port', e.currentTarget.value)}
                        />
                    </div>
                    <div class="setting-card">
                        <div class="setting-card-info">
                            <div class="setting-card-name">Verify Mojang Accounts</div>
                            <div class="setting-card-desc">When off, anyone can join without a paid account (required for bots)</div>
                        </div>
                        <label class="toggle">
                            <input
                                type="checkbox"
                                checked={props.properties()['online-mode'] === 'true'}
                                onChange={(e) => props.updateProperty('online-mode', e.currentTarget.checked ? 'true' : 'false')}
                            />
                            <span class="toggle-slider" />
                        </label>
                    </div>
                </div>
            </div>

            <div class="server-section-group">
                <div class="section-title">World</div>
                <div class="setting-card-list">
                    <div class="setting-card">
                        <div class="setting-card-info">
                            <div class="setting-card-name">Spawn Monsters</div>
                        </div>
                        <label class="toggle">
                            <input
                                type="checkbox"
                                checked={props.properties()['spawn-monsters'] !== 'false'}
                                onChange={(e) => props.updateProperty('spawn-monsters', e.currentTarget.checked ? 'true' : 'false')}
                            />
                            <span class="toggle-slider" />
                        </label>
                    </div>
                    <div class="setting-card">
                        <div class="setting-card-info">
                            <div class="setting-card-name">Spawn Animals</div>
                        </div>
                        <label class="toggle">
                            <input
                                type="checkbox"
                                checked={props.properties()['spawn-animals'] !== 'false'}
                                onChange={(e) => props.updateProperty('spawn-animals', e.currentTarget.checked ? 'true' : 'false')}
                            />
                            <span class="toggle-slider" />
                        </label>
                    </div>
                    <div class="setting-card">
                        <div class="setting-card-info">
                            <div class="setting-card-name">Allow Flight</div>
                        </div>
                        <label class="toggle">
                            <input
                                type="checkbox"
                                checked={props.properties()['allow-flight'] === 'true'}
                                onChange={(e) => props.updateProperty('allow-flight', e.currentTarget.checked ? 'true' : 'false')}
                            />
                            <span class="toggle-slider" />
                        </label>
                    </div>
                    <div class="setting-card">
                        <div class="setting-card-info">
                            <div class="setting-card-name">Command Blocks</div>
                        </div>
                        <label class="toggle">
                            <input
                                type="checkbox"
                                checked={props.properties()['enable-command-block'] !== 'false'}
                                onChange={(e) => props.updateProperty('enable-command-block', e.currentTarget.checked ? 'true' : 'false')}
                            />
                            <span class="toggle-slider" />
                        </label>
                    </div>
                </div>
            </div>

            <div class="server-section-group">
                <div class="setting-card-list">
                    <div class="setting-card">
                        <div class="setting-card-info">
                            <div class="setting-card-name">Reset to Defaults</div>
                            <div class="setting-card-desc">Restore all settings to their original values</div>
                        </div>
                        <button
                            class="server-reset-btn"
                            onClick={props.onResetDefaults}
                        >
                            Reset
                        </button>
                    </div>
                </div>
            </div>

            <div class="server-props-save">
                <button
                    class="btn btn-connect"
                    onClick={() => {
                        if (props.propsChanged()) props.onSaveProperties();
                        if (props.configChanged()) props.onSaveConfig();
                    }}
                    disabled={props.savingProps() || props.savingConfig() || (!props.propsChanged() && !props.configChanged())}
                >
                    {props.savingProps() || props.savingConfig() ? 'Saving...' : 'Save Settings'}
                </button>
                <Show when={props.propsChanged() || props.configChanged()}>
                    <span class="server-hint">Restart the server for changes to take effect.</span>
                </Show>
            </div>
        </div>
    );
}
