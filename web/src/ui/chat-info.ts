import { api } from '../api';
import { store } from '../store';
import { avatarEl, formatLastSeen } from './format';
import { openProfile } from './profile';
import { confirmDialog, toast } from './toast';
import type { MemberInfo, UIChat } from '../types';

/**
 * Chat info — what the header opens.
 *
 * Private chats keep the person card (profile.ts); groups get this page: name,
 * picture, presence, description, the member list with admin controls, and the
 * leave/delete actions that used to live in a cramped members modal.
 */

let closeCurrent: (() => void) | null = null;
let refreshCurrent: (() => void) | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function closeChatInfo(): void {
  closeCurrent?.();
}

/** Current chat shape from the store, so live member/description changes show. */
function liveChat(chatId: number): UIChat | null {
  return store.state.chats.get(chatId) ?? null;
}

export function openChatInfo(chat: UIChat): void {
  closeCurrent?.();
  const me = store.state.session?.user.id;
  if (!me) return;
  const myId: number = me;
  if (chat.type === 'private') {
    const peer = chat.members.find((m) => m.userId !== me);
    if (peer) void openProfile(peer.userId);
    return;
  }

  const screen = el('div', 'settings-screen chat-info');
  screen.setAttribute('role', 'dialog');
  screen.setAttribute('aria-label', 'Group info');

  const top = el('header', 'screen-top');
  const back = el('button', 'icon-btn');
  back.type = 'button';
  back.title = 'Back';
  back.setAttribute('aria-label', 'Back');
  back.textContent = '‹';
  top.append(back, el('h1', 'screen-title', 'Group info'));

  const scroll = el('div', 'set-scroll');
  screen.append(top, scroll);
  document.body.appendChild(screen);

  const close = (): void => {
    document.removeEventListener('keydown', onKey);
    screen.classList.remove('show');
    window.setTimeout(() => screen.remove(), 200);
    closeCurrent = null;
    refreshCurrent = null;
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  };
  back.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  closeCurrent = close;
  requestAnimationFrame(() => screen.classList.add('show'));

  // ── render (re-runnable so member changes repaint in place) ───────────
  function render(): void {
    const chatNow = liveChat(chat.id) ?? chat;
    const members = chatNow.members;
    const amAdmin = members.find((m) => m.userId === me)?.role === 'admin';
    const online = members.filter((m) => m.online).length;

    scroll.innerHTML = '';

    // head: picture, name, presence
    const head = el('div', 'ci-head');
    const avatar = avatarEl(chatNow.id, chatNow.name ?? 'Group', 96);
    avatar.classList.add('group-avatar', 'ci-avatar');
    head.append(avatar, el('div', 'ci-name', chatNow.name ?? 'Group'));
    head.append(
      el('div', 'ci-sub', `${members.length} ${members.length === 1 ? 'member' : 'members'} · ${online} online`),
    );
    scroll.appendChild(head);

    // description
    const desc = el('div', 'ci-card');
    const descText = (chatNow.description ?? '').trim();
    if (descText) {
      desc.appendChild(el('div', 'ci-desc-text', descText));
    } else {
      desc.appendChild(el('div', 'ci-desc-empty', amAdmin ? 'Add a description' : 'No description'));
    }
    if (amAdmin) {
      desc.classList.add('editable');
      desc.addEventListener('click', () => openDescriptionEditor(chatNow));
    }
    scroll.appendChild(desc);

    // members
    scroll.appendChild(el('div', 'set-group-title', `Members · ${members.length}`));
    const list = el('div', 'set-card');
    for (const member of members) list.appendChild(memberRow(chatNow, member, amAdmin, myId));
    scroll.appendChild(list);

    // actions
    const actions = el('div', 'ci-actions');
    const add = el('button', 'set-save secondary', 'Add member');
    add.addEventListener('click', () => openAddMember(chatNow));
    actions.appendChild(add);
    scroll.appendChild(actions);

    const danger = el('div', 'set-card ci-danger');
    const leave = el('button', 'set-row clickable danger');
    leave.type = 'button';
    const leaveText = el('div', 'set-row-text');
    leaveText.appendChild(el('div', 'label', 'Leave group'));
    leave.appendChild(leaveText);
    leave.addEventListener('click', () => void leaveGroup(chatNow, amAdmin));
    danger.appendChild(leave);
    if (amAdmin) {
      const del = el('button', 'set-row clickable danger');
      del.type = 'button';
      const delText = el('div', 'set-row-text');
      delText.appendChild(el('div', 'label', 'Delete group'));
      del.appendChild(delText);
      del.addEventListener('click', () => void deleteGroup(chatNow));
      danger.appendChild(del);
    }
    scroll.appendChild(danger);
  }

  function memberRow(chatNow: UIChat, member: MemberInfo, amAdmin: boolean, myId: number): HTMLElement {
    const row = el('div', 'ci-member');
    row.appendChild(avatarEl(member.userId, member.displayName, 36, member.avatarUrl));
    const body = el('div', 'ci-member-body');
    const nameLine = el('div', 'ci-member-name');
    nameLine.textContent = member.displayName + (member.userId === myId ? ' (you)' : '');
    if (member.role === 'admin') {
      const badge = el('span', 'ci-badge', 'admin');
      nameLine.appendChild(badge);
    }
    const sub = el('div', 'ci-member-sub', member.online ? 'online' : formatLastSeen(member.lastSeenAt));
    body.append(nameLine, sub);
    row.appendChild(body);
    row.addEventListener('click', () => void openProfile(member.userId));
    if (amAdmin && member.userId !== myId) {
      const kick = el('button', 'mm-kick', 'Remove');
      kick.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog('Remove member?', `${member.displayName} will lose access to this group.`, 'Remove');
        if (!ok) return;
        try {
          await api.removeMember(chatNow.id, member.userId);
          store.setMembers(
            chatNow.id,
            chatNow.members.filter((m) => m.userId !== member.userId),
          );
          toast(`${member.displayName} removed`);
          render();
        } catch (err) {
          toast(err instanceof Error ? err.message : 'Failed to remove', 'error');
        }
      });
      row.appendChild(kick);
    }
    return row;
  }

  // ── description editor ────────────────────────────────────────────────
  function openDescriptionEditor(chatNow: UIChat): void {
    const box = el('div', 'ci-desc-editor');
    const field = el('textarea');
    field.value = chatNow.description ?? '';
    field.maxLength = 255;
    field.rows = 3;
    field.placeholder = 'What is this group about?';
    const apply = el('button', 'pe-apply', 'Apply');
    apply.type = 'button';
    apply.disabled = true;
    const cancel = el('button', 'set-link', 'Cancel');
    cancel.type = 'button';
    field.addEventListener('input', () => {
      apply.disabled = field.value.trim() === (chatNow.description ?? '').trim();
    });
    cancel.addEventListener('click', () => render());
    apply.addEventListener('click', async () => {
      apply.disabled = true;
      try {
        const { chat: updated } = await api.updateChat(chatNow.id, { description: field.value.trim() });
        store.patchChat(chatNow.id, { description: updated.description });
        toast('Description updated', 'info');
        render();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Could not save', 'error');
        apply.disabled = false;
      }
    });
    const row = el('div', 'pe-head');
    row.append(el('div', 'pe-label', 'Description'), apply);
    box.append(row, field, cancel);
    const card = scroll.querySelector('.ci-card');
    if (card) card.replaceWith(box);
    field.focus();
  }

  // ── add member ────────────────────────────────────────────────────────
  function openAddMember(chatNow: UIChat): void {
    const box = el('div', 'ci-add');
    const input = el('input');
    input.type = 'text';
    input.placeholder = 'Search people to add';
    input.maxLength = 32;
    const results = el('div', 'ci-add-results');
    const done = el('button', 'set-link', 'Done');
    done.type = 'button';
    done.addEventListener('click', () => render());
    const headRow = el('div', 'pe-head');
    headRow.append(el('div', 'pe-label', 'Add member'), done);
    box.append(headRow, input, results);
    scroll.appendChild(box);
    input.focus();

    let debounce: ReturnType<typeof setTimeout> | undefined;
    input.addEventListener('input', () => {
      clearTimeout(debounce);
      const q = input.value.trim();
      results.innerHTML = '';
      if (!q) return;
      debounce = setTimeout(async () => {
        try {
          const { users } = await api.users(q);
          results.innerHTML = '';
          const already = new Set(chatNow.members.map((m) => m.userId));
          const eligible = users.filter((u) => !already.has(u.id));
          if (!eligible.length) {
            results.appendChild(el('div', 'ci-desc-empty', 'Nobody new found'));
            return;
          }
          for (const user of eligible) {
            const row = el('div', 'ci-add-row');
            row.append(avatarEl(user.id, user.displayName, 32), el('span', 'ci-add-name', user.displayName));
            row.append(el('span', 'ci-add-handle', `@${user.username}`));
            row.addEventListener('click', async () => {
              try {
                const { members } = await api.addMember(chatNow.id, user.id);
                store.setMembers(chatNow.id, members as MemberInfo[]);
                toast(`${user.displayName} added`);
                render();
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Failed to add', 'error');
              }
            });
            results.appendChild(row);
          }
        } catch (err) {
          toast(err instanceof Error ? err.message : 'Search failed', 'error');
        }
      }, 250);
    });
  }

  async function leaveGroup(chatNow: UIChat, amAdmin: boolean): Promise<void> {
    const ok = await confirmDialog(
      'Leave group?',
      amAdmin
        ? `You are the admin — after you leave, no one can manage "${chatNow.name}".`
        : `You will lose access to "${chatNow.name}".`,
      'Leave',
    );
    if (!ok) return;
    try {
      await api.leaveGroup(chatNow.id);
      store.removeChat(chatNow.id);
      close();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not leave', 'error');
    }
  }

  async function deleteGroup(chatNow: UIChat): Promise<void> {
    const ok = await confirmDialog(
      'Delete group?',
      `"${chatNow.name}" will be deleted for everyone. This cannot be undone.`,
      'Delete',
    );
    if (!ok) return;
    try {
      await api.deleteGroup(chatNow.id);
      store.removeChat(chatNow.id);
      close();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete', 'error');
    }
  }

  render();
  refreshCurrent = render;
  store.subscribe(() => refreshCurrent?.());
}
