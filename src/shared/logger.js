/**
 * Tiny opt-in debug logger.
 *
 * Callers must never pass credentials, cookies, authorization headers, full
 * page URLs, or URL query strings. The helpers below only accept fixed short
 * labels and primitive status values.
 */

export function createLogger(enabled, scope = 'qbt') {
  const emit = (level, message, details) => {
    if (!enabled) return;
    const prefix = `[${scope}]`;
    if (details === undefined) console[level](prefix, message);
    else console[level](prefix, message, details);
  };

  return {
    get enabled() {
      return enabled;
    },
    debug: (message, details) => emit('debug', message, details),
    info: (message, details) => emit('info', message, details),
    warn: (message, details) => emit('warn', message, details),
    error: (message, details) => emit('error', message, details),
  };
}

export const noopLogger = {
  enabled: false,
  debug() {},
  info() {},
  warn() {},
  error() {},
};
