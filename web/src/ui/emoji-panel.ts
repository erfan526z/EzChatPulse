import { EMOJI_CATEGORIES } from '../emojis';

/**
 * Emoji picker for the composer: a button toggles a panel above the input;
 * clicking an emoji inserts it at the cursor. Closes on outside click / Esc /
 * scroll / chat switch. No dependencies, works offline.
 */
const RECENT_KEY = 'chatpulse.emoji.recent';
const RECENT_MAX = 24;

function loadRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function pushRecent(emoji: string): void {
  const next = [emoji, ...loadRecents().filter((e) => e !== emoji)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // private mode / quota — recents are a nicety, never a failure
  }
}

export function mountEmojiPanel(input: HTMLTextAreaElement, host: HTMLElement): { close: () => void } {
  const btn = document.querySelector<HTMLButtonElement>('#emoji-btn');
  if (!btn) return { close: () => {} };

  const panel = document.createElement('div');
  panel.className = 'emoji-panel hidden';
  const tabs = document.createElement('div');
  tabs.className = 'emoji-cats';
  const grid = document.createElement('div');
  grid.className = 'emoji-grid';
  panel.append(tabs, grid);
  host.appendChild(panel);

  let open = false;
  // -1 is the recents tab; 0..n map into EMOJI_CATEGORIES
  let activeCat = loadRecents().length ? -1 : 0;

  function insert(emoji: string): void {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.setRangeText(emoji, start, end, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true })); // autogrow + typing
    input.focus();
  }

  function renderGrid(): void {
    const emojis = activeCat === -1 ? loadRecents() : EMOJI_CATEGORIES[activeCat]!.emojis;
    grid.innerHTML = '';
    if (!emojis.length) {
      const empty = document.createElement('div');
      empty.className = 'emoji-empty';
      empty.textContent = 'Emoji you use will show up here';
      grid.appendChild(empty);
      return;
    }
    for (const emoji of emojis) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'emoji-cell';
      cell.textContent = emoji;
      cell.title = emoji;
      cell.addEventListener('click', () => {
        insert(emoji);
        pushRecent(emoji);
      });
      grid.appendChild(cell);
    }
  }

  function renderTabs(): void {
    tabs.innerHTML = '';
    const recentTab = document.createElement('button');
    recentTab.type = 'button';
    recentTab.className = 'emoji-cat-btn' + (activeCat === -1 ? ' active' : '');
    recentTab.textContent = '🕘';
    recentTab.title = 'Recently used';
    recentTab.addEventListener('click', () => {
      activeCat = -1;
      renderTabs();
      renderGrid();
    });
    tabs.appendChild(recentTab);

    EMOJI_CATEGORIES.forEach((cat, i) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'emoji-cat-btn' + (i === activeCat ? ' active' : '');
      tab.textContent = cat.emojis[0] ?? '·';
      tab.title = cat.name;
      tab.addEventListener('click', () => {
        activeCat = i;
        renderTabs();
        renderGrid();
      });
      tabs.appendChild(tab);
    });
  }

  function openPanel(): void {
    renderTabs();
    renderGrid();
    panel.classList.remove('hidden');
    open = true;
  }

  function closePanel(): void {
    panel.classList.add('hidden');
    open = false;
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (open) closePanel();
    else openPanel();
  });

  document.addEventListener('pointerdown', (e) => {
    if (!open) return;
    if (panel.contains(e.target as Node) || e.target === btn) return;
    closePanel();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) closePanel();
  });

  return { close: closePanel };
}
