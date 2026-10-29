import './styles.css';
import { api, getToken, setToken } from './api';
import { store } from './store';
import { socket } from './ws';
import { refreshChats, openChat } from './actions';
import { mountLogin } from './ui/login';
import { mountSidebar } from './ui/sidebar';
import { mountChatPane } from './ui/chat';

const loginView = document.querySelector<HTMLDivElement>('#login-view')!;
const mainView = document.querySelector<HTMLDivElement>('#main-view')!;
const emptyState = document.querySelector<HTMLDivElement>('#empty-state')!;

function showLogin(): void {
  loginView.classList.remove('hidden');
  mainView.classList.add('hidden');
  emptyState.classList.add('hidden');
}

function showMain(): void {
  loginView.classList.add('hidden');
  mainView.classList.remove('hidden');
}

async function enterApp(): Promise<void> {
  showMain();
  socket.connect();
  try {
    await refreshChats();
  } catch (err) {
    console.warn('initial chat load failed:', err);
  }
}

async function boot(): Promise<void> {
  mountSidebar((chatId) => {
    void openChat(chatId);
  });
  mountChatPane();

  // Esc closes the open chat (unless a modal or the lightbox is up)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.querySelector('#modal-root .modal-overlay, #lightbox:not(.hidden)')) return;
    if (store.state.activeChatId != null) store.setActiveChat(null);
  });

  const token = getToken();
  if (!token) {
    showLogin();
    return;
  }
  try {
    const { user, requireVerifiedEmail } = await api.me();
    store.setSession({ token, user });
    store.setRequireVerifiedEmail(Boolean(requireVerifiedEmail));
    await enterApp();
  } catch {
    setToken(null);
    showLogin();
  }
}

mountLogin(() => {
  void enterApp();
});

void boot();
