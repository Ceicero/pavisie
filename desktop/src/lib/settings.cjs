'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_API_URL, normalizeApiUrl } = require('./api-url.cjs');

const RANGE_OPTIONS = [7, 30, 90];
const DEFAULTS = { apiUrl: DEFAULT_API_URL, rangeDays: 30, autoRefresh: true };

/** Keeps only known keys with valid values, so a hand-edited or outdated file can never break startup. */
function sanitizeSettings(raw) {
  const settings = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return settings;
  try {
    settings.apiUrl = normalizeApiUrl(raw.apiUrl);
  } catch {
    settings.apiUrl = DEFAULTS.apiUrl;
  }
  if (RANGE_OPTIONS.includes(raw.rangeDays)) settings.rangeDays = raw.rangeDays;
  if (typeof raw.autoRefresh === 'boolean') settings.autoRefresh = raw.autoRefresh;
  return settings;
}

/** A small JSON settings file in the app's own data folder. It holds preferences only — never a credential. */
function createSettingsStore(directory) {
  const file = path.join(directory, 'settings.json');
  let current = null;

  function load() {
    if (current) return current;
    try {
      current = sanitizeSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      current = { ...DEFAULTS };
    }
    return current;
  }

  function save(patch) {
    current = sanitizeSettings({ ...load(), ...patch });
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(current, null, 2));
    return current;
  }

  return { load, save };
}

module.exports = { DEFAULTS, RANGE_OPTIONS, createSettingsStore, sanitizeSettings };
