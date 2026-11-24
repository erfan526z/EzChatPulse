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
          <p class="login-hint" id="reg-email-hint">We'll send one confirmation link. You can add it later in settings.</p>
        </div>
        <input id="f-username" type="text" placeholder="Username" maxlength="32" autocomplete="username" required />
        <input id="f-password" type="password" placeholder="Password (min 8 characters)" minlength="8" autocomplete="current-password" required />
        <div id="captcha-box" class="captcha-box hidden">
          <div id="captcha-img" class="captcha-img" aria-label="captcha question"></div>
          <div class="captcha-side">
            <input id="f-captcha" type="text" inputmode="numeric" placeholder="Answer" autocomplete="off" />
            <button type="button" id="captcha-refresh" title="New question" aria-label="New question">↻</button>
          </div>
          <div class="captcha-hint">Wrong or hard to read? Tap ↻ for a new question.</div>
        </div>
        <button type="submit" id="login-submit">Sign in</button>
        <p class="login-error hidden"></p>
      </form>
    </div>`;

  // the signup form asks for whatever the server actually requires: with
  // verification enforced, an address is the only way to be able to send
  const emailInput = root.querySelector<HTMLInputElement>('#f-reg-email')!;
  const emailHint = root.querySelector<HTMLParagraphElement>('#reg-email-hint')!;
  /** does the server require an address? set once the policy request lands */
  let emailRequired = false;
  void api
    .registrationPolicy()
    .then((policy) => {
      if (!policy.emailRequired) return;
      emailRequired = true;
      emailInput.placeholder = 'Email (required)';
      emailHint.textContent = "We'll send one confirmation link. Confirm it before you can send messages.";
      // only the visible tab may hold constraints (see applyTab)
      if (!registerFields.classList.contains('hidden')) emailInput.required = true;
    })
    .catch(() => {
      /* policy is advisory here: the server still enforces it on submit */
    });

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

  applyTab(false); // start on Sign in: the hidden register fields must not validate

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

  /**
   * Show one tab and make only that tab's fields participate in the form.
   *
   * A `required` control inside a hidden container makes the whole form invalid
   * and the browser silently refuses to submit — clicking "Sign in" looked like
   * a no-op with no error anywhere ("An invalid form control is not focusable").
   * Disabled controls are exempt from validation and from submission, so the
   * hidden tab is disabled outright.
   */
  function applyTab(isRegister: boolean): void {
    registerFields.classList.toggle('hidden', !isRegister);
    for (const field of registerFields.querySelectorAll<HTMLInputElement>('input')) {
      field.disabled = !isRegister;
    }
    emailInput.required = isRegister && emailRequired;
    submitBtn.textContent = isRegister ? 'Create account' : 'Sign in';
    if (isRegister && !challenge) void refreshChallenge();
  }

  tabs.forEach((tab) =>
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      applyTab(tab.dataset.tab === 'register');
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
      // The auth response carries the PUBLIC profile (no email). Hydrate the
      // private one so settings shows the account's real email/verification state.
      try {
        const me = await api.me();
        store.setUser(me.user);
        store.setRequireVerifiedEmail(Boolean(me.requireVerifiedEmail));
      } catch {
        /* non-fatal: the app still works, settings falls back to "no email" */
      }
      onSuccess();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      const replaced = autoGrowCaptchaIfNeeded(err);
      // a used/expired/mistyped challenge is dead — hand out a fresh one, unless
      // the error already came with a new one
      if (captcha && !replaced) await refreshChallenge();
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
