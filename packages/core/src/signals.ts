// Ctrl-C handling for long-running CLI commands: the first SIGINT/SIGTERM asks for a graceful stop
// (abort in-flight work, keep resumable state); a second one exits at once with 128 + signo.

type SignalSource = Pick<NodeJS.EventEmitter, 'on' | 'removeListener'>;

export interface StopSignalOptions {
  /** Defaults to `process`. */
  proc?: SignalSource;
  /** Defaults to `process.exit`. */
  exit?: (code: number) => void;
}

/** Installs the handlers; returns a function that removes them. */
export function installStopSignals(onFirst: (sig: NodeJS.Signals) => void, opts: StopSignalOptions = {}): () => void {
  const proc = opts.proc ?? process;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let stopping = false;
  const handler = (sig: NodeJS.Signals) => {
    if (stopping) {
      exit(sig === 'SIGTERM' ? 143 : 130);
      return;
    }
    stopping = true;
    onFirst(sig);
  };
  proc.on('SIGINT', handler);
  proc.on('SIGTERM', handler);
  return () => {
    proc.removeListener('SIGINT', handler);
    proc.removeListener('SIGTERM', handler);
  };
}
