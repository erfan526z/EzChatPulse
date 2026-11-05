import { authedFileUrl } from '../api';

/** Deterministic gradient avatar from a user id + initials. */
export function avatarGradient(id: number): string {
  const hue = (id * 137.508) % 360; // golden angle avoids adjacent ids sharing hues
  return `linear-gradient(135deg, hsl(${hue}, 62%, 52%), hsl(${(hue + 45) % 360}, 68%, 38%))`;
}

export function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}

export function avatarEl(id: number, name: string, size = 40, imageUrl?: string | null): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'avatar';
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.fontSize = `${Math.max(size * 0.38, 10)}px`;
  el.style.background = avatarGradient(id);
  el.textContent = initials(name);

  if (imageUrl) {
    // avatars are auth-gated, so they arrive as a blob URL; the initials stay
    // visible underneath until it loads (and forever if it fails)
    void authedFileUrl(imageUrl)
      .then((u) => {
        el.classList.add('has-photo');
        el.style.backgroundImage = `url("${u}")`;
        el.textContent = '';
      })
      .catch(() => {
        /* keep the initials */
      });
  }
  return el;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return hm;
  const yesterday = new Date(today.getTime() - 86400000);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${hm}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + hm;
}

export function formatLastSeen(ts: number | null): string {
  if (!ts) return 'last seen recently';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'last seen just now';
  if (min < 60) return `last seen ${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `last seen ${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'last seen yesterday';
  if (days < 7) return `last seen ${days} days ago`;
  return 'last seen ' + new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}
