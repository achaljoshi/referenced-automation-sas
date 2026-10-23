import * as fs from 'node:fs';
import * as path from 'node:path';
import { AdapterError, getLogger, loadEnv, type ConfigReader } from '@automation/referenced-automation-utils';
import { SafetyPolicy, selectedEnvironmentName, type OperationGuard as CorePolicy } from '../core';
import { guarded } from '../desktop/guard';
import { windowPatternFor } from '../desktop/inspect';
import { DesktopTransportError, type DesktopSession } from '../desktop';
import { DEFAULT_MAX_QUEUE, normalizeKeys, RECORD_MODES, type RawEvent, type RecordMode, type RecordSnapshot, type RecordStartResult } from '../desktop/recording';
import { coalesce, type CoalesceOptions, type CoalesceStats } from './coalesce';
import { DEFAULT_STOP_KEY } from './config';
import { RECORDING_VERSION, serializeRecording, type Recording, type RecordedEvent } from './format';

const log = getLogger('sas-recorder');

/** The tool name written into recordings. */
export const RECORDER_TOOL = 'sas-desktop-record 1';

export interface RecorderOptions {
  /** `smc`, `eg`, or a regular expression for the title of a window of the program to record. */
  app: string;
  mode?: RecordMode;
  /** The chord that ends the recording; noticed in any window, recorded in none. Default Ctrl+Alt+Q. */
  stopKey?: string;
  /** How often the bridge is asked for events. Default 200 ms. */
  pollMs?: number;
  /** The bridge's queue bound. Default 5000. */
  maxQueue?: number;
  /** Extra regular expressions: a field whose name or automation id matches is treated as a secret. */
  secretPatterns?: string[];
  /** The policy gate (default: allows). The CLI passes the core's SafetyPolicy. */
  guard?: Parameters<typeof guarded>[0];
  /** Called after every collection with the running counts (the live "events seen" counter). */
  onProgress?: (progress: RecorderProgress) => void;
  /** Overrides for the coalescing windows (tests). */
  coalesce?: CoalesceOptions;
  /** For deterministic output (tests, examples): the start time and tool name written into the recording. */
  startedAt?: string;
  tool?: string;
}

export interface RecorderProgress {
  /** Raw events seen so far (what the counter shows). */
  eventsSeen: number;
  dropped: number;
  secretKeysDiscarded: number;
  foreignKeysIgnored: number;
  stopRequested: boolean;
  targetAlive: boolean;
}

export interface RecordingResult {
  recording: Recording;
  stats: CoalesceStats & { dropped: number; secretKeysDiscarded: number; foreignKeysIgnored: number; durationMs: number };
  warnings: string[];
}

/** The window title regular expression `--app` stands for. */
export function appTitleRegex(app: string): string {
  return windowPatternFor(app).source;
}

/**
 * Records what a person does in one running SAS desktop program, through the bridge's record.* operations.
 *
 *   const recorder = await Recorder.start(session, { app: 'eg' });
 *   ...the user works...                       recorder.eventsSeen is a live counter
 *   const { recording } = await recorder.stop();
 *   await recorder.save('recordings/run_project.sasrec.json', recording);
 *
 * The bridge only ever looks at the chosen program's windows, and never keeps what is typed into a secret field (a password field, or a field
 * named like one): the entry says `secret: true` and nothing else. This class tidies the raw events into a recording (see coalesce.ts) and
 * refuses to write a file that would break that promise. NOT VERIFIED on a real Windows desktop with the real programs.
 */
export class Recorder {
  private readonly raw: RawEvent[] = [];
  private seen = 0;
  private last: RecordSnapshot | undefined;
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private error: unknown;
  private stopped = false;
  private stopRequestedResolve!: () => void;
  /** Resolves when the user pressed the stop chord (or the recorded program went away). */
  readonly stopRequested: Promise<void>;

  private constructor(
    private readonly session: DesktopSession,
    readonly options: RecorderOptions,
    readonly started: RecordStartResult,
    private readonly pollMs: number,
  ) {
    this.stopRequested = new Promise<void>((resolve) => {
      this.stopRequestedResolve = resolve;
    });
  }

  /** Starts recording the program `options.app` names. It must be running (and, for Management Console, with the Java Access Bridge on). */
  static async start(session: DesktopSession, options: RecorderOptions): Promise<Recorder> {
    const mode = options.mode ?? 'full';
    if (!(RECORD_MODES as readonly string[]).includes(mode)) throw new AdapterError('sas-recorder', 'start', `mode must be one of ${RECORD_MODES.join(', ')} (found "${mode}")`);
    const stopKey = normalizeKeys(options.stopKey ?? DEFAULT_STOP_KEY);
    if (stopKey === undefined) throw new AdapterError('sas-recorder', 'start', `the stop key "${options.stopKey}" is not a key chord such as Ctrl+Alt+Q`);
    const guard = options.guard ?? { authorize: () => undefined, record: () => undefined };
    return guarded(guard, { driver: 'sas-recorder', operation: 'record', kind: 'read', target: options.app, local: true }, async () => {
      let started: RecordStartResult;
      try {
        started = (await session.send({
          op: 'record.start',
          titleRegex: appTitleRegex(options.app),
          mode,
          maxQueue: options.maxQueue ?? DEFAULT_MAX_QUEUE,
          stopKey,
          ...(options.secretPatterns && options.secretPatterns.length > 0 ? { secretPatterns: options.secretPatterns } : {}),
        })) as RecordStartResult;
      } catch (error) {
        if (error instanceof DesktopTransportError && error.code === 'NOT_IMPLEMENTED') {
          throw new AdapterError('sas-recorder', 'start', `this bridge cannot record: ${error.message}. Use the bridge this version ships (sas-desktop-inspect doctor checks it).`, { cause: error });
        }
        if (error instanceof DesktopTransportError && error.code === 'NOT_FOUND') {
          throw new AdapterError('sas-recorder', 'start', `${error.message} (looked for a window matching ${appTitleRegex(options.app)}; list what is open with: sas-desktop-inspect windows)`, { cause: error });
        }
        throw error;
      }
      const recorder = new Recorder(session, { ...options, mode, stopKey }, started, options.pollMs ?? 200);
      log.info(`[sas-recorder] recording ${started.process} (process ${started.pids.join(', ')}), ${started.windows} window(s) open, mode ${started.mode}`);
      recorder.schedule();
      return recorder;
    });
  }

  /** How many raw events the bridge has reported so far: the live counter. */
  get eventsSeen(): number {
    return this.seen;
  }

  get progress(): RecorderProgress {
    const last = this.last;
    return {
      eventsSeen: this.seen,
      dropped: last?.dropped ?? 0,
      secretKeysDiscarded: last?.secretKeysDiscarded ?? 0,
      foreignKeysIgnored: last?.foreignKeysIgnored ?? 0,
      stopRequested: last?.stopRequested ?? false,
      targetAlive: last?.targetAlive ?? true,
    };
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.collect().finally(() => this.schedule()), this.pollMs);
  }

  /** Asks the bridge for what happened since the last time. Called by the timer; tests call it to step by hand. */
  async collect(): Promise<RecorderProgress> {
    if (this.polling || this.stopped) return this.progress;
    this.polling = true;
    try {
      const snapshot = (await this.session.send({ op: 'record.events', drain: true })) as RecordSnapshot;
      this.take(snapshot);
      if (snapshot.stopRequested || !snapshot.targetAlive) this.stopRequestedResolve();
    } catch (error) {
      this.error = error;
      this.stopRequestedResolve();
      log.warn(`[sas-recorder] stopped collecting: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.polling = false;
    }
    return this.progress;
  }

  private take(snapshot: RecordSnapshot): void {
    this.last = snapshot;
    this.raw.push(...snapshot.events);
    this.seen += snapshot.events.length;
    this.options.onProgress?.(this.progress);
  }

  /** The recording so far (without ending it): what the events collected up to now would become. */
  preview(): Recording {
    return this.build(this.raw, undefined).recording;
  }

  /** Ends the recording: collects what is left, removes the hooks, tidies the events and returns the recording. Safe to call twice. */
  async stop(): Promise<RecordingResult> {
    if (this.timer) clearTimeout(this.timer);
    const wasStopped = this.stopped;
    this.stopped = true;
    if (!wasStopped) {
      while (this.polling) await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        const final = (await this.session.send({ op: 'record.stop' })) as RecordSnapshot;
        this.take(final);
      } catch (error) {
        // the program ended or the desktop went away: what was collected before is still a recording
        if (!this.error) this.error = error;
        log.warn(`[sas-recorder] record.stop failed: ${error instanceof Error ? error.message : String(error)} - using what was collected`);
      }
    }
    return this.build(this.raw, this.last);
  }

  private build(raw: RawEvent[], snapshot: RecordSnapshot | undefined): RecordingResult {
    const { events, stats, warnings } = coalesce(raw, this.options.coalesce);
    const durationMs = snapshot?.durationMs ?? events[events.length - 1]?.t ?? 0;
    const recording: Recording = {
      version: RECORDING_VERSION,
      app: this.options.app,
      startedAt: this.options.startedAt ?? this.started.startedAt,
      tool: this.options.tool ?? RECORDER_TOOL,
      events,
      stats: {
        rawEvents: stats.rawEvents,
        dropped: snapshot?.dropped ?? 0,
        secretEntries: stats.secretEntries,
        secretKeysDiscarded: snapshot?.secretKeysDiscarded ?? 0,
        durationMs,
      },
    };
    if ((snapshot?.dropped ?? 0) > 0) warnings.push(`${snapshot?.dropped} event(s) did not fit the bridge's queue and were lost - raise SAS_RECORDER_MAX_QUEUE or SAS_RECORDER_POLL_MS lower`);
    if (this.error) warnings.push(`recording ended early: ${this.error instanceof Error ? this.error.message : String(this.error)}`);
    return {
      recording,
      stats: { ...stats, dropped: snapshot?.dropped ?? 0, secretKeysDiscarded: snapshot?.secretKeysDiscarded ?? 0, foreignKeysIgnored: snapshot?.foreignKeysIgnored ?? 0, durationMs },
      warnings,
    };
  }

  /**
   * Writes a recording to a file (folders are created). Refuses to overwrite one unless `overwrite`. The text goes through `serializeRecording`, which
   * refuses an invalid recording - in particular one with a value in a secret entry.
   */
  async save(file: string, recording: Recording, options: { overwrite?: boolean } = {}): Promise<string> {
    return saveRecording(file, recording, options);
  }
}

/** Writes a recording file (see Recorder.save). */
export function saveRecording(file: string, recording: Recording, options: { overwrite?: boolean } = {}): string {
  const target = path.resolve(file);
  if (fs.existsSync(target) && !options.overwrite) throw new AdapterError('sas-recorder', 'save', `${file} already exists: choose another name, or overwrite on purpose (--force)`);
  const text = serializeRecording(recording);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return target;
}

/** A few lines for the person who just recorded: what is in the file, and the reminder about passwords. */
export function summarizeRecording(result: RecordingResult, file?: string): string[] {
  const { recording, stats } = result;
  const count = (type: RecordedEvent['type']) => recording.events.filter((e) => e.type === type).length;
  const windows = new Set(recording.events.filter((e) => e.type === 'windowOpened' || e.type === 'windowActivated').map((e) => (e as { title: string }).title));
  const parts = (['click', 'doubleClick', 'rightClick', 'text', 'key', 'select', 'toggle', 'expand', 'collapse', 'menu', 'dialogHandled'] as const)
    .map((type) => [type, count(type)] as const)
    .filter(([, n]) => n > 0)
    .map(([type, n]) => `${n} ${type}`);
  const lines = [
    `${file ? `Recorded ${file}: ` : 'Recorded '}${recording.events.length} event(s) from ${stats.rawEvents} raw event(s) in ${(stats.durationMs / 1000).toFixed(1)} s${parts.length ? ` (${parts.join(', ')})` : ''}`,
    `  windows seen: ${windows.size === 0 ? 'none' : [...windows].map((w) => `"${w}"`).join(', ')}`,
  ];
  const weak = recording.events.filter((e) => 'target' in e && e.target && e.target.path.length > 0 && !e.target.path.some((s) => s.automationId || s.name)).length;
  if (weak > 0) lines.push(`  ${weak} event(s) have a control with no name or automation id (common in Management Console): the converter will find them by class and position or leave a TODO`);
  lines.push(
    `  passwords: nothing typed into a password field was kept - ${stats.secretEntries} entry(ies) are marked secret (no value); ${stats.secretKeysDiscarded} key press(es) in such fields were thrown away`,
    '  The converted test reads each secret from the environment (SAS_PASSWORD, SAS_PIN, ...): set them in .env.<env>.local, never in a file you commit.',
  );
  if (stats.dropped > 0) lines.push(`  WARNING: ${stats.dropped} event(s) were lost because the bridge's queue was full`);
  for (const warning of result.warnings) lines.push(`  note: ${warning}`);
  return lines;
}

/**
 * The environment gate for the real recorder: it only runs against an environment the team declared (src/core), and production needs the same
 * explicit permission any read there needs. Returns the environment name. The recording CLI calls this before it starts (not with `--simulator`).
 */
export function authorizeRecording(app: string, options: { policy?: CorePolicy; env?: ConfigReader } = {}): string {
  const env = options.env ?? loadEnv();
  const policy = options.policy ?? new SafetyPolicy({ env });
  const environment = selectedEnvironmentName(env);
  const op = { driver: 'sas-recorder', operation: 'record', kind: 'read' as const, target: app, environment, local: true };
  policy.authorize(op);
  policy.record({ op, outcome: 'ok', durationMs: 0 });
  return environment;
}
