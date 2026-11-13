'use strict';

const DEFAULT_API_URL = 'https://api.pavisie.com';

/**
 * Normalizes a user-typed API address to an origin (`https://api.example.com`), or throws with a message that
 * is safe to show as-is. Plain http is accepted for this machine only: the session cookie this app sends is
 * the same one the web dashboard uses, so it must never cross the network unencrypted.
 */
function normalizeApiUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('Enter the address of your Pavisie API.');
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error('That is not a valid web address.');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('The API address must start with https:// (http:// only works for localhost).');
  }
  if (url.username || url.password)
    throw new Error('The API address must not contain a username or password.');
  return url.origin;
}

module.exports = { DEFAULT_API_URL, normalizeApiUrl };
