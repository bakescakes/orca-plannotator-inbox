/**
 * The Orca build of Plannotator: Settings → About's Orca card. It reads only the server's aggregate
 * GET /api/inbox/orca; no token, session id or native command reaches the page. Outside Orca mode that route
 * answers 404 and the card draws nothing.
 *
 * The type augmentations name the optional wire fields the Orca build's patches read in the window, so those
 * patches never edit upstream's shared interfaces.
 */
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../icons';
import { inboxUrl } from '../inboxUrl';

declare module '@plannotator/core/inbox-types' {
  interface InboxRun {
    /** Optional native host Open destination (the launch host's `routeHost`); absent means Terminal. */
    open_in?: string;
  }
}

declare module '../api' {
  interface ProjectFolder {
    /** A project of the Orca plugin's catalog, shown even before its first message. */
    orca_imported?: true;
  }
}

interface OrcaState {
  mode: string;
  connected: boolean;
  health: { title: string; detail: string; connected: number; waiting: number; blocked: number };
  projects: { imported: number };
  upgrade: { configured: boolean; state?: { phase: string; version: string | null; detail?: string | null } | null };
}

const PHASE_TEXT: Record<string, string> = {
  queued: 'waiting to start',
  resolving: 'finding the Orca build',
  building: 'preparing',
  staged: 'ready to switch',
  activating: 'switching',
  ready: 'in use',
  failed: 'not installed',
  'rolled-back': 'rolled back',
};

export function OrcaConnection() {
  const [state, setState] = useState<OrcaState | null>(null);
  const read = useCallback(async () => {
    try {
      const response = await fetch(inboxUrl('/orca'), { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (response.ok) {
        const value = await response.json();
        if (value?.mode === 'orca' && value?.health) setState(value);
      }
    } catch {
      // Not the Orca build in Orca mode, or it is restarting: no card.
    }
  }, []);
  useEffect(() => {
    void read();
  }, [read]);
  if (!state) return null;
  const update = state.upgrade.state;
  return (
    <section className="ib-sgroup" aria-label="Orca connection" data-orca-connection="">
      <div className="ib-card">
        <div className="ib-prow">
          <span className="ib-tile">
            <Icon name="link" />
          </span>
          <span className="ib-txt">
            <span className="ib-l">Orca · {state.health.title}</span>
            <span className="ib-desc">
              {state.projects.imported} projects · {state.health.connected} connected{state.health.waiting ? ` · ${state.health.waiting} waiting` : ''}
            </span>
            {update && (
              <span className="ib-desc" data-orca-update={update.phase}>
                Orca build{update.version ? ` ${update.version}` : ''}: {PHASE_TEXT[update.phase] ?? update.phase}
                {update.detail ? `. ${update.detail}` : ''}
              </span>
            )}
            <details>
              <summary className="ib-lnk">Connection details</summary>
              <p className="ib-desc">{state.health.detail}</p>
              <p className="ib-desc">
                {state.health.blocked ? `${state.health.blocked} replies need attention. ` : ''}
                {state.upgrade.configured
                  ? 'Updates install the Orca build of each Plannotator release, keep the Orca integration, and roll back if it does not start.'
                  : 'The Orca build updater is not set up; this version stays in use.'}
              </p>
            </details>
          </span>
          <span className="ib-ctl">
            <button type="button" className="ib-btn ib-sm" onClick={() => void read()}>
              Refresh
            </button>
          </span>
        </div>
      </div>
    </section>
  );
}
