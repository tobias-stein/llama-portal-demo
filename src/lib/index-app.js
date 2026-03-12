import { CognitoUserPool, AuthenticationDetails, CognitoUser } from 'amazon-cognito-identity-js';
import '../config.js'; // Imports the global awsConfig

/* ─────────────────────────────────────────────
   Shared helpers
───────────────────────────────────────────── */
function parseJwt(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64    = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      window.atob(base64).split('').map(c =>
        '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
      ).join('')
    );
    return JSON.parse(jsonPayload);
  } catch (e) {
    return null;
  }
}

function buildUserPool() {
  return new CognitoUserPool({
    UserPoolId: window.AppConfig.USER_POOL_ID,
    ClientId:   window.AppConfig.CLIENT_ID,
  });
}

function onAuthSuccess(result, email, code) {
  const idToken = result.getIdToken().getJwtToken();
  sessionStorage.setItem('idToken',   idToken);
  sessionStorage.setItem('userEmail', email);
  sessionStorage.setItem('otcCode',   code);
  window.location.href = getRedirectUrl(idToken);
}

function getRedirectUrl(idToken) {
  const payload = parseJwt(idToken);
  const groups  = payload?.['cognito:groups'] || [];
  return window.AppConfig.HOST_URL + groups.includes(window.AppConfig.ROLES.ADMIN) ? 'admin.html' : 'booking.html';
}

/* ─────────────────────────────────────────────
   Magic link auto-login
   Runs immediately if ?code= is present in URL.
   Reuses the same CUSTOM_AUTH guest flow as OTC.
───────────────────────────────────────────── */
const GUEST_USERNAME = window.AppConfig.ROLES.GUEST;

function handleMagicLink() {
  const params = new URLSearchParams(window.location.search);
  const code   = params.get('code');
  if (!code) return; // no magic link — render normal login UI

  // Show the overlay and hide the login page behind it
  const overlay     = document.getElementById('magic-link-overlay');
  const overlayText = document.getElementById('magic-link-status');
  const overlayErr  = document.getElementById('magic-link-error');
  overlay.classList.remove('hidden');

  // Clean the code from the URL immediately so it can't be bookmarked/replayed
  window.history.replaceState({}, document.title, window.location.pathname);

  const userPool    = buildUserPool();
  const cognitoUser = new CognitoUser({ Username: GUEST_USERNAME, Pool: userPool });
  cognitoUser.setAuthenticationFlowType('CUSTOM_AUTH');

  const authDetails = new AuthenticationDetails({ Username: GUEST_USERNAME });

  cognitoUser.initiateAuth(authDetails, {
    onSuccess: (result) => {
      // Rare: session already valid
      onAuthSuccess(result, GUEST_USERNAME, code);
    },

    onFailure: (err) => {
      overlayText.textContent = 'Something went wrong.';
      overlayErr.textContent  = 'This link may have already been used or has expired.';
      overlayErr.classList.remove('hidden');
      document.getElementById('magic-link-spinner').classList.add('hidden');
      document.getElementById('magic-link-retry').classList.remove('hidden');
    },

    customChallenge: () => {
      // Challenge issued — immediately answer with the code from the URL
      overlayText.textContent = 'Verifying your invitation…';

      cognitoUser.sendCustomChallengeAnswer(code, {
        onSuccess: (result) => {
          overlayText.textContent = '✓ Verified! Redirecting…';
          onAuthSuccess(result, GUEST_USERNAME, code);
        },

        onFailure: (err) => {
          overlayText.textContent = 'Invalid invitation link.';
          overlayErr.textContent  = 'This link may have already been used or has expired.';
          overlayErr.classList.remove('hidden');
          document.getElementById('magic-link-spinner').classList.add('hidden');
          document.getElementById('magic-link-retry').classList.remove('hidden');
        },

        customChallenge: () => {
          // Wrong code but Cognito allowing retry — treat as failure for magic links
          overlayText.textContent = 'Invalid invitation link.';
          overlayErr.textContent  = 'This link may have already been used or has expired.';
          overlayErr.classList.remove('hidden');
          document.getElementById('magic-link-spinner').classList.add('hidden');
          document.getElementById('magic-link-retry').classList.remove('hidden');
        },
      });
    },
  });
}

// Run before anything else renders
handleMagicLink();

/* ─────────────────────────────────────────────
   Mode toggle
───────────────────────────────────────────── */
const modeToggle  = document.getElementById('mode-toggle');
const btnPassword = document.getElementById('btn-password');
const btnOtc      = document.getElementById('btn-otc');
const panelPw     = document.getElementById('panel-password');
const panelOtc    = document.getElementById('panel-otc');

function switchMode(mode) {
  if (mode === 'password') {
    modeToggle.classList.remove('otc-active');
    btnPassword.classList.add('active');
    btnOtc.classList.remove('active');
    panelPw.classList.remove('hidden');
    panelOtc.classList.add('hidden', 'slide-left');
  } else {
    modeToggle.classList.add('otc-active');
    btnOtc.classList.add('active');
    btnPassword.classList.remove('active');
    panelOtc.classList.remove('hidden', 'slide-left');
    panelPw.classList.add('hidden');
    panelPw.classList.remove('slide-left');
  }
}

btnPassword.addEventListener('click', () => switchMode('password'));
btnOtc.addEventListener('click',      () => switchMode('otc'));

/* ─────────────────────────────────────────────
   Password login
───────────────────────────────────────────── */
const passwordForm = document.getElementById('login-form');
const passwordBtn  = document.getElementById('submit-password');
const passwordErr  = document.getElementById('error-password');

function showPasswordError(msg) {
  passwordErr.textContent = msg;
  passwordErr.classList.add('visible');
}
function clearPasswordError() {
  passwordErr.textContent = '';
  passwordErr.classList.remove('visible');
}

passwordForm.addEventListener('submit', (e) => {
  e.preventDefault();
  clearPasswordError();

  const email    = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  if (!email || !password) {
    showPasswordError('Please enter your email and password.');
    return;
  }

  passwordBtn.classList.add('loading');
  passwordBtn.disabled = true;

  const userPool    = buildUserPool();
  const authDetails = new AuthenticationDetails({ Username: email, Password: password });
  const cognitoUser = new CognitoUser({ Username: email, Pool: userPool });

  cognitoUser.authenticateUser(authDetails, {
    onSuccess: (result) => onAuthSuccess(result, email, undefined),

    onFailure: (err) => {
      showPasswordError(err.message || 'Authentication failed. Please check your credentials.');
      passwordBtn.classList.remove('loading');
      passwordBtn.disabled = false;
    },

    newPasswordRequired: (userAttributes) => {
      console.log('New password required.');
      const newPassword = prompt('Please enter your new password:');
      delete userAttributes.email_verified;
      delete userAttributes.email;
      cognitoUser.completeNewPasswordChallenge(newPassword, userAttributes, {
        onSuccess: (result) => onAuthSuccess(result, email, undefined),
        onFailure: (err) => {
          showPasswordError(err.message || 'Failed to set new password.');
          passwordBtn.classList.remove('loading');
          passwordBtn.disabled = false;
        },
      });
    },
  });
});

/* ─────────────────────────────────────────────
   One-Time Code login
   User types their code and submits once.
   Same flow as magic link — initiate then
   immediately answer the challenge.
───────────────────────────────────────────── */
const otcForm  = document.getElementById('otc-form');
const otcBtn   = document.getElementById('submit-otc');
const otcErr   = document.getElementById('error-otc');
const otcInput = document.getElementById('otc-code');

function showOtcError(msg) {
  otcErr.textContent = msg;
  otcErr.classList.add('visible');
}
function clearOtcError() {
  otcErr.textContent = '';
  otcErr.classList.remove('visible');
}

/* ── Auto-format input as XXXX-XXXX-XXXX ── */
otcInput.addEventListener('input', () => {
  const cursor = otcInput.selectionStart;
  const raw    = otcInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);

  // Insert dashes at positions 4 and 8
  let formatted = raw;
  if (raw.length > 8) formatted = raw.slice(0,4) + '-' + raw.slice(4,8) + '-' + raw.slice(8);
  else if (raw.length > 4) formatted = raw.slice(0,4) + '-' + raw.slice(4);

  otcInput.value = formatted;

  // Restore cursor — account for inserted dashes
  const dashes = (formatted.slice(0, cursor).match(/-/g) || []).length
               - (otcInput.value.slice(0, cursor).replace(formatted, '').match(/-/g) || []).length;
  const newCursor = Math.min(cursor + dashes, formatted.length);
  otcInput.setSelectionRange(newCursor, newCursor);
});

otcInput.addEventListener('keydown', (e) => {
  // Skip over dashes cleanly on backspace
  if (e.key === 'Backspace') {
    const pos = otcInput.selectionStart;
    if (pos > 0 && otcInput.value[pos - 1] === '-') {
      e.preventDefault();
      otcInput.setSelectionRange(pos - 1, pos - 1);
    }
  }
});

otcForm.addEventListener('submit', (e) => {
  e.preventDefault();
  clearOtcError();

  const code = otcInput.value.trim();
  if (code.replace(/-/g, '').length < 12) {
    showOtcError('Please enter your full invitation code (XXXX-XXXX-XXXX).');
    return;
  }

  otcBtn.classList.add('loading');
  otcBtn.disabled = true;
  otcInput.disabled = true;

  const userPool    = buildUserPool();
  const cognitoUser = new CognitoUser({ Username: GUEST_USERNAME, Pool: userPool });
  cognitoUser.setAuthenticationFlowType('CUSTOM_AUTH');

  const authDetails = new AuthenticationDetails({ Username: GUEST_USERNAME });

  cognitoUser.initiateAuth(authDetails, {
    onSuccess: (result) => {
      // Edge case: session already valid
      onAuthSuccess(result, GUEST_USERNAME, code);
    },

    onFailure: (err) => {
      showOtcError(err.message || 'Failed to start authentication.');
      resetOtcForm();
    },

    customChallenge: () => {
      // Challenge issued — answer immediately with the typed code
      cognitoUser.sendCustomChallengeAnswer(code, {
        onSuccess: (result) => onAuthSuccess(result, GUEST_USERNAME, code),

        onFailure: (err) => {
          showOtcError(err.message || 'Invalid or expired code.');
          resetOtcForm();
        },

        customChallenge: () => {
          // Wrong code but Cognito allowing retry — treat as a clean failure
          showOtcError('Invalid or expired code. Please check and try again.');
          resetOtcForm();
        },
      });
    },
  });
});

function resetOtcForm() {
  otcBtn.classList.remove('loading');
  otcBtn.disabled = false;
  otcInput.disabled = false;
  otcInput.value = '';
  otcInput.focus();
}