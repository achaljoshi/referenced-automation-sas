import type { RecordedEvent, Recording } from '../../../src/recorder';
import { step, target, win } from './events';

type Loose<E> = E extends unknown ? Omit<E, 't'> & { t?: number } : never;

/** A recording from events (times are filled in): for the converter tests. */
export function rec(events: Array<Loose<RecordedEvent>>, app = 'eg'): Recording {
  let t = 0;
  return {
    version: 1,
    app,
    startedAt: '2026-10-23T09:00:00.000Z',
    tool: 'test',
    events: events.map((event) => {
      t = event.t ?? t + 100;
      return { ...event, t } as RecordedEvent;
    }),
  };
}

export { step, target, win };

/** The event shorthands: what the user did, already tidied. */
export const ev = {
  opened: (title: string, extra: { className?: string; owned?: boolean } = {}) => ({ type: 'windowOpened' as const, title, ...extra }),
  closed: (title: string) => ({ type: 'windowClosed' as const, title }),
  click: (t: ReturnType<typeof target>) => ({ type: 'click' as const, target: t }),
  doubleClick: (t: ReturnType<typeof target>) => ({ type: 'doubleClick' as const, target: t }),
  rightClick: (t: ReturnType<typeof target>) => ({ type: 'rightClick' as const, target: t }),
  text: (t: ReturnType<typeof target>, value: string, committedBy: 'enter' | 'tab' | 'blur' = 'blur') => ({ type: 'text' as const, target: t, value, committedBy }),
  secret: (t: ReturnType<typeof target>, committedBy: 'enter' | 'tab' | 'blur' = 'blur', secretKind?: 'password' | 'pin' | 'otp' | 'token' | 'secret' | 'key') => ({
    type: 'text' as const,
    target: t,
    secret: true as const,
    committedBy,
    ...(secretKind ? { secretKind } : {}),
  }),
  key: (keys: string, title: string, on?: ReturnType<typeof target>) => ({ type: 'key' as const, keys, window: win(title), ...(on ? { target: on } : {}) }),
  select: (t: ReturnType<typeof target>, ...items: string[]) => ({ type: 'select' as const, target: t, items }),
  toggle: (t: ReturnType<typeof target>, state: boolean) => ({ type: 'toggle' as const, target: t, state }),
  expand: (t: ReturnType<typeof target>) => ({ type: 'expand' as const, target: t }),
  collapse: (t: ReturnType<typeof target>) => ({ type: 'collapse' as const, target: t }),
  menu: (title: string, ...path: string[]) => ({ type: 'menu' as const, window: win(title), path }),
  dialog: (title: string, button: string) => ({ type: 'dialogHandled' as const, title, button }),
};
