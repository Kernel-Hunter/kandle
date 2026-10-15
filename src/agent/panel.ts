import { DEFAULT_PORT, TOKEN_PATTERN, normalizeToken } from '../../packages/mcp/src/protocol';
import { APP } from '../config';
import type { KeyValueStorage } from '../store/layout';
import { h } from '../ui/dom';
import { createModal } from '../ui/modal';
import type { BridgeStatus } from './client';

export interface AgentSettings {
  enabled: boolean;
  port: number;
  token: string;
}

const key = () => `${APP.id}:agent`;

export function loadAgentSettings(storage: KeyValueStorage): AgentSettings {
  const fallback: AgentSettings = { enabled: false, port: DEFAULT_PORT, token: '' };
  try {
    const raw = storage.getItem(key());
    if (!raw) return fallback;
    const r = JSON.parse(raw) as Record<string, unknown>;
    const port = typeof r.port === 'number' && Number.isInteger(r.port) && r.port > 0 && r.port < 65536 ? r.port : DEFAULT_PORT;
    return { enabled: r.enabled === true, port, token: typeof r.token === 'string' ? r.token.slice(0, 64) : '' };
  } catch {
    return fallback;
  }
}

export function saveAgentSettings(storage: KeyValueStorage, settings: AgentSettings): void {
  try {
    storage.setItem(key(), JSON.stringify(settings));
  } catch {
    // Storage blocked; the settings last for this session.
  }
}

const STATUS_TEXT: Record<BridgeStatus, string> = {
  off: 'Off',
  connecting: 'Connecting',
  connected: 'Connected to your agent',
  waiting: 'Waiting for kandle-mcp. Start your agent with the Kandle MCP server.',
  bad_token: 'Wrong pairing code. Ask your agent for the code (it calls get_bridge_status) or open ~/.kandle/bridge-token.',
  locked: 'Too many wrong codes. Waiting a minute before trying again.',
  protocol: 'This kandle-mcp version does not match the app. Update both.',
  replaced: 'Another Kandle tab or window is connected to the agent. Turn the bridge off and on to take over.',
};

/**
 * Pages served from a public origin (the hosted app) need the browser's permission to reach
 * 127.0.0.1. Chrome asks for it the first time; until the user allows it, the bridge just waits.
 */
const LOCAL_NETWORK_HINT =
  'If your browser asks to let this site connect to devices on your local network, allow it: kandle-mcp runs on 127.0.0.1. If you blocked it, allow it again in the site settings next to the address bar.';

function servedFromThisComputer(): boolean {
  const host = location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}

export const AGENT_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4M9 12h.01M15 12h.01M9.5 15.5h5"/></svg>';

export interface AgentPanelOptions {
  storage: KeyValueStorage;
  onChange: (settings: AgentSettings) => void;
}

/** The "Agent" topbar button and its settings dialog. */
export function createAgentPanel(options: AgentPanelOptions) {
  let settings = loadAgentSettings(options.storage);
  let status: BridgeStatus = 'off';
  let detail = '';
  const activity: Array<{ time: number; method: string; ok: boolean; error?: string }> = [];

  const modal = createModal('AI agent', { className: 'modal-small agent-modal' });
  const enabled = h('input', { type: 'checkbox', id: 'agent-enabled' }) as HTMLInputElement;
  const tokenInput = h('input', {
    class: 'text-input agent-code',
    type: 'text',
    placeholder: 'XXXX-XXXX-XXXX',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Pairing code',
    maxlength: 32,
  }) as HTMLInputElement;
  const portInput = h('input', { class: 'text-input agent-port', type: 'number', min: 1, max: 65535, 'aria-label': 'Bridge port' }) as HTMLInputElement;
  const statusDot = h('span', { class: 'agent-dot' });
  const statusText = h('span', { class: 'agent-status-text' });
  const activityList = h('ul', { class: 'agent-activity' });
  const command = `claude mcp add kandle -- ${APP.mcpNpx}`;

  const apply = () => {
    const token = normalizeToken(tokenInput.value);
    const port = Number(portInput.value);
    settings = {
      enabled: enabled.checked,
      token,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    };
    tokenInput.value = token;
    saveAgentSettings(options.storage, settings);
    options.onChange(settings);
    render();
  };

  enabled.addEventListener('change', () => {
    if (enabled.checked && !TOKEN_PATTERN.test(normalizeToken(tokenInput.value))) {
      detail = 'Enter the pairing code first.';
      enabled.checked = false;
      render();
      tokenInput.focus();
      return;
    }
    apply();
  });
  tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!TOKEN_PATTERN.test(normalizeToken(tokenInput.value))) {
        detail = 'Pairing codes look like K7QD-9MXR-2HPA.';
        render();
        return;
      }
      enabled.checked = true;
      apply();
    }
  });
  tokenInput.addEventListener('change', () => {
    if (TOKEN_PATTERN.test(normalizeToken(tokenInput.value))) apply();
  });
  portInput.addEventListener('change', apply);

  modal.body.append(
    h(
      'p',
      { class: 'agent-intro' },
      'Let an AI agent such as Claude Code, Codex, Cursor or Gemini CLI read this chart, change symbols, add indicators, draw levels and set alerts. ',
      'The agent runs the kandle-mcp server on this computer and Kandle connects to it on 127.0.0.1 only.',
    ),
    h('label', { class: 'agent-row agent-toggle', for: 'agent-enabled' }, enabled, h('span', {}, 'Agent bridge')),
    h('div', { class: 'agent-row' }, h('span', { class: 'agent-label' }, 'Pairing code'), tokenInput),
    h('div', { class: 'agent-row' }, h('span', { class: 'agent-label' }, 'Port'), portInput),
    h('div', { class: 'agent-row agent-status' }, statusDot, statusText),
    h(
      'details',
      { class: 'agent-help' },
      h('summary', {}, 'Set up your agent'),
      h('p', {}, '1. Add the server to your agent, for example in Claude Code:'),
      h(
        'div',
        { class: 'agent-cmd' },
        h('code', {}, command),
        h('button', {
          class: 'btn small',
          onclick: () => void navigator.clipboard?.writeText(command).catch(() => undefined),
        }, 'Copy'),
      ),
      h('p', {}, '2. Ask the agent for the Kandle pairing code (it calls get_bridge_status). It is also saved in ~/.kandle/bridge-token.'),
      h('p', {}, '3. Paste the code above and turn on Agent bridge. The code is stored in this browser, so you only do this once.'),
    ),
    h('div', { class: 'col-title' }, 'Recent agent actions'),
    activityList,
  );

  const button = h(
    'button',
    { class: 'tb-btn agent-btn', title: 'AI agent bridge', onclick: () => open() },
    h('span', { html: AGENT_ICON }),
    h('span', { class: 'tb-label' }, 'Agent'),
    h('span', { class: 'agent-dot' }),
  );

  function render(): void {
    enabled.checked = settings.enabled;
    if (document.activeElement !== tokenInput) tokenInput.value = settings.token;
    portInput.value = String(settings.port);
    const shown: BridgeStatus = settings.enabled ? status : 'off';
    for (const dot of [statusDot, button.querySelector('.agent-dot')!]) dot.className = `agent-dot agent-${shown}`;
    let text = detail && shown !== 'connected' ? `${STATUS_TEXT[shown]} ${detail}`.trim() : STATUS_TEXT[shown];
    if (shown === 'waiting' && !servedFromThisComputer()) text = `${text} ${LOCAL_NETWORK_HINT}`;
    statusText.textContent = text;
    button.title = `AI agent bridge: ${STATUS_TEXT[shown]}`;
    button.classList.toggle('active', shown === 'connected');
    activityList.replaceChildren(
      ...(activity.length === 0
        ? [h('li', { class: 'muted' }, 'Nothing yet.')]
        : activity.map((a) =>
            h(
              'li',
              { class: a.ok ? '' : 'agent-failed' },
              h('span', { class: 'muted' }, new Date(a.time).toLocaleTimeString()),
              ` ${a.method}`,
              a.error ? h('span', { class: 'muted' }, ` (${a.error})`) : null,
            ),
          )),
    );
  }

  function open(): void {
    render();
    modal.open();
  }

  render();
  return {
    button,
    open,
    settings: () => settings,
    setStatus(next: BridgeStatus, info?: string) {
      status = next;
      detail = info ?? '';
      render();
    },
    logActivity(method: string, ok: boolean, error?: string) {
      activity.unshift({ time: Date.now(), method, ok, error });
      activity.length = Math.min(activity.length, 8);
      render();
    },
  };
}
