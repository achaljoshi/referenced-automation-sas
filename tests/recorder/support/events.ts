import { targetWindowOf, type PathStep, type RawEvent, type Target, type TargetWindow } from '../../../src/recorder';

/** Builders for raw bridge events and targets, so a test reads as what the user did. */
export const win = (title: string, className?: string): TargetWindow => targetWindowOf(title, className);

export const step = {
  button: (name: string, extra: Partial<PathStep> = {}): PathStep => ({ controlType: 'Button', name, ...extra }),
  edit: (name: string, extra: Partial<PathStep> = {}): PathStep => ({ controlType: 'Edit', name, ...extra }),
  list: (name: string, extra: Partial<PathStep> = {}): PathStep => ({ controlType: 'List', name, ...extra }),
  item: (name: string, extra: Partial<PathStep> = {}): PathStep => ({ controlType: 'ListItem', name, ...extra }),
  menu: (name: string, extra: Partial<PathStep> = {}): PathStep => ({ controlType: 'MenuItem', name, ...extra }),
  check: (name: string, extra: Partial<PathStep> = {}): PathStep => ({ controlType: 'CheckBox', name, ...extra }),
  node: (name: string, extra: Partial<PathStep> = {}): PathStep => ({ controlType: 'TreeItem', name, ...extra }),
};

export const target = (title: string, ...path: PathStep[]): Target => ({ window: win(title), path });

type Loose = Omit<Extract<RawEvent, { type: string }>, 't'> & { t?: number };

/** Gives every event a time (`gap` ms after the one before) unless it has one. */
export function raw(events: Loose[], gap = 50): RawEvent[] {
  let t = 0;
  return events.map((event) => {
    t = event.t ?? t + gap;
    return { ...event, t } as RawEvent;
  });
}

export const opened = (title: string, extra: { className?: string; owned?: boolean } = {}): Loose => ({ type: 'windowOpened', title, ...extra }) as Loose;
export const closed = (title: string): Loose => ({ type: 'windowClosed', title }) as Loose;
export const activated = (title: string): Loose => ({ type: 'windowActivated', title }) as Loose;
export const click = (t: Target, at?: number): Loose => ({ type: 'click', target: t, ...(at !== undefined ? { t: at } : {}) }) as Loose;
export const invoke = (t: Target, at?: number): Loose => ({ type: 'invoke', target: t, ...(at !== undefined ? { t: at } : {}) }) as Loose;
export const typed = (t: Target, value: string, extra: { committedBy?: 'enter' | 'tab' | 'blur'; t?: number } = {}): Loose => ({ type: 'typed', target: t, value, ...extra }) as Loose;
export const key = (keys: string, title: string, at?: number): Loose => ({ type: 'key', keys, window: win(title), ...(at !== undefined ? { t: at } : {}) }) as Loose;
