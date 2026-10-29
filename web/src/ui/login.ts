import { api, setToken, ApiError, type CaptchaChallenge } from '../api';
import { store } from '../store';
import { toast } from './toast';

/** Mount the register/login screen. Calls onSuccess after a successful auth. */
export function mountLogin(onSuccess: () => void): void {
  const root = document.querySelector('#login-view')!;
  root.innerHTML = `
    <div class="login-card">
      <div class="login-logo">◉</div>
      <h1>EzChatPulse</h1>
      <p class="login-sub">fast · private · yours</p>
      <div class="login-tabs">
        <button type="button" class="tab active" data-tab="login">Sign in</button>
        <button type="button" class="tab" data-tab="register">Create account</button>
      </div>
      <form id="login-form" autocomplete="on">
        <div id="register-fields" class="hidden">
          <input id="f-display" type="text" placeholder="Display name" maxlength="32" autocomplete="nickname" />
          <input id="f-reg-email" type="email" placeholder="Email (optional — lets you recover your account)" maxlength="254" autocomplete="email" />
          <p class="login-hint">We'll send one confirmation link. You can add it later in settings.</p>
        </div>
        <input id="f-username" type="text" placeholder="Username" maxlength="32" autocomplete="username" required />
        <input id="f-password" type="password" placeholder="Password (min 8 characters)" minlength="8" autocomplete="current-password" required />
        <div id="captcha-box" class="captcha-box hidden">
          <div id="captcha-img" class="captcha-img" aria-label="captcha question"></div>
          <div class="captcha-side">
            <input id="f-captcha" type="text" inputmode="numeric" placeholder="Answer" autocomplete="off" />
            <button type="button" id="captcha-refresh" title="New question" aria-label="New question">↻</button>
          </div>
        </div>
        <button type="submit" id="login-submit">Sign in</button>
        <p class="login-error hidden"></p>
      </form>
    </div>`;

  const tabs = [...root.querySelectorAll<HTMLButtonElement>('.tab')];
  const registerFields = root.querySelector<HTMLDivElement>('#register-fields')!;
  const submitBtn = root.querySelector<HTMLButtonElement>('#login-submit')!;
  const errEl = root.querySelector<HTMLParagraphElement>('.login-error')!;
  const captchaBox = root.querySelector<HTMLDivElement>('#captcha-box')!;
  const captchaImg = root.querySelector<HTMLDivElement>('#captcha-img')!;
  const captchaInput = root.querySelector<HTMLInputElement>('#f-captcha')!;
  const captchaRefresh = root.querySelector<HTMLButtonElement>('#captcha-refresh')!;

  /** Current challenge; null = no captcha needed (yet). */
  let challenge: CaptchaChallenge | null = null;

  function showChallenge(c: CaptchaChallenge): void {
    challenge = c;
    captchaImg.innerHTML = c.svg;
    captchaInput.value = '';
    captchaBox.classList.remove('hidden');
  }

  function hideChallenge(): void {
    challenge = null;
    captchaImg.innerHTML = '';
    captchaInput.value = '';
    captchaBox.classList.add('hidden');
  }

  async function refreshChallenge(): Promise<void> {
    try {
      showChallenge(await api.captcha());
    } catch {
      /* the submit will surface a clear error */
    }
  }

  function autoGrowCaptchaIfNeeded(err: unknown): boolean {
    // server asked for a captcha (registration needs one / login after N failures)
    if (err instanceof ApiError && err.body?.captchaRequired) {
      const c = err.body.captcha as CaptchaChallenge | undefined;
      if (c?.token) {
        showChallenge(c);
        captchaInput.focus();
        return true;
      }
    }
    return false;
  }

  tabs.forEach((tab) =>
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const isRegister = tab.dataset.tab === 'register';
      registerFields.classList.toggle('hidden', !isRegister);
      submitBtn.textContent = isRegister ? 'Create account' : 'Sign in';
      // registration always carries a captcha (when the server has it enabled)
      if (isRegister && !challenge) void refreshChallenge();
    }),
  );

  captchaRefresh.addEventListener('click', () => void refreshChallenge());

  root.querySelector<HTMLFormElement>('#login-form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const isRegister = !registerFields.classList.contains('hidden');
    const username = (root.querySelector<HTMLInputElement>('#f-username')!).value.trim();
    const password = (root.querySelector<HTMLInputElement>('#f-password')!).value;
    const display = (root.querySelector<HTMLInputElement>('#f-display')!).value.trim();
    const email = (root.querySelector<HTMLInputElement>('#f-reg-email')!).value.trim();

    const captcha =
      challenge && !captchaBox.classList.contains('hidden')
        ? { token: challenge.token, answer: captchaInput.value.trim() }
        : undefined;

    errEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = isRegister ? 'Creating…' : 'Signing in…';
    try {
      const session = isRegister
        ? await api.register(username, display || username, password, captcha, email || undefined)
        : await api.login(username, password, captcha);
      setToken(session.token);
      store.setSession(session);
      onSuccess();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      autoGrowCaptchaIfNeeded(err);
      // a used/expired/mistyped challenge is dead — hand out a fresh one
      if (captcha) await refreshChallenge();
      errEl.textContent = message;
      errEl.classList.remove('hidden');
      submitBtn.classList.remove('shake');
      void submitBtn.offsetWidth; // restart animation
      submitBtn.classList.add('shake');
      toast(message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = isRegister ? 'Create account' : 'Sign in';
    }
  });

  // If registration is the initial tab state (it is not), nothing to do; but a
  // user who lands here and switches later gets a challenge lazily above.
  void hideChallenge;
}
