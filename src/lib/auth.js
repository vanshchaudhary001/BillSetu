import { useCallback, useEffect, useState } from 'react';
import {
  getCurrentBusiness,
  getCurrentUser,
  login as loginRequest,
  logout as logoutRequest,
  register as registerRequest,
  switchBusiness as switchBusinessRequest,
} from './api.js';
import { claimUnscopedWorkspace, setWorkspaceScope } from './storage.js';

export const MIN_PASSWORD_LENGTH = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Client-side form validation only. The backend remains authoritative for
 * account existence, password rules and session validity.
 */
export function validateAuthForm({ mode, email, password, confirmation }) {
  const address = String(email || '').trim();
  if (!address) return 'Enter your email address.';
  if (!EMAIL_PATTERN.test(address)) return 'Enter a valid email address.';
  if (!password) return 'Enter your password.';
  if (mode === 'register') {
    if (password.length < MIN_PASSWORD_LENGTH) {
      return `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`;
    }
    if (password !== confirmation) return 'The passwords do not match.';
  }
  return '';
}

export function useAuth() {
  const [status, setStatus] = useState('loading');
  const [user, setUser] = useState(null);
  const [business, setBusiness] = useState(null);
  const [startupError, setStartupError] = useState('');

  useEffect(() => {
    let active = true;
    getCurrentUser()
      .then(nextUser => {
        if (!active) return;
        setWorkspaceScope(nextUser.id);
        claimUnscopedWorkspace(nextUser.id);
        setStartupError('');
        setUser(nextUser);
        setStatus('authenticated');
        return getCurrentBusiness()
          .then(nextBusiness => { if (active) setBusiness(nextBusiness); })
          .catch(() => { if (active) setBusiness(null); });
      })
      .catch(error => {
        if (!active) return;
        setWorkspaceScope('');
        setUser(null);
        setStartupError(error?.status === 0 ? error.message : '');
        setStatus('unauthenticated');
      });
    return () => { active = false; };
  }, []);

  const establishSession = useCallback(nextUser => {
    setWorkspaceScope(nextUser.id);
    claimUnscopedWorkspace(nextUser.id);
    setStartupError('');
    setUser(nextUser);
    setStatus('authenticated');
    getCurrentBusiness()
      .then(nextBusiness => setBusiness(nextBusiness))
      .catch(() => setBusiness(null));
    return nextUser;
  }, []);

  const login = useCallback(async (email, password) => {
    const nextUser = await loginRequest(String(email || '').trim(), password);
    return establishSession(nextUser);
  }, [establishSession]);

  const register = useCallback(async (email, password) => {
    const nextUser = await registerRequest(String(email || '').trim(), password);
    return establishSession(nextUser);
  }, [establishSession]);

  const logout = useCallback(async () => {
    // The backend must revoke the server-side session before we drop local
    // authentication state. A failed request keeps the authenticated UI and
    // reports the problem instead of pretending the user signed out.
    await logoutRequest();
    setWorkspaceScope('');
    setUser(null);
    setBusiness(null);
    setStatus('unauthenticated');
  }, []);

  const switchBusiness = useCallback(async businessId => {
    // Keep the current context intact until the server has confirmed the
    // membership-controlled switch.  The successful state update changes the
    // Workspace key in App, which unmounts old business data before mounting
    // the new business workspace.
    const nextBusiness = await switchBusinessRequest(businessId);
    setBusiness(nextBusiness);
    return nextBusiness;
  }, []);

  return { status, user, business, startupError, login, register, logout, switchBusiness };
}
