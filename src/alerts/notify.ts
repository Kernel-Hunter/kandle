import { APP } from '../config';

/**
 * Delivery for fired alerts: a system notification (when allowed), plus a short tone.
 * The in-app toast is shown by the caller.
 */

let audio: AudioContext | null = null;

/** Browsers only start audio after a user gesture, so create the context on the first click. */
export function unlockAudioOnGesture(): void {
  const unlock = () => {
    try {
      audio ??= new AudioContext();
      void audio.resume();
    } catch {
      // No Web Audio; alerts stay silent.
    }
  };
  window.addEventListener('pointerdown', unlock, { once: true, capture: true });
  window.addEventListener('keydown', unlock, { once: true, capture: true });
}

/** Two short rising tones, about 0.3 s. */
export function playAlertSound(): void {
  try {
    audio ??= new AudioContext();
    const ctx = audio;
    const start = ctx.currentTime + 0.01;
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = start + i * 0.15;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.14);
    });
  } catch {
    // Audio blocked or unavailable.
  }
}

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return notificationsSupported() ? Notification.permission : 'unsupported';
}

/** Asks once; later calls return the stored answer without prompting again. */
export async function ensureNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function showSystemNotification(title: string, body: string): void {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag: `${APP.id}-alert-${Date.now()}`, icon: './favicon.svg' });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // Some browsers only allow notifications from a service worker.
  }
}
