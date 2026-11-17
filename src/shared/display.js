/**
 * Resolve per-hostname display rules without ever accepting CSS from the user.
 * Supported values are fixed enums, so rules cannot inject styles or HTML.
 */

export function normalizeHostname(hostname) {
  return String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
}

/** Find the most specific matching site rule for a hostname. */
export function findSiteRule(rules, hostname) {
  const host = normalizeHostname(hostname);
  if (!host || !Array.isArray(rules)) return null;

  let best = null;
  for (const rule of rules) {
    const pattern = normalizeHostname(rule?.hostname);
    if (!pattern) continue;

    let matches = false;
    if (pattern === host) {
      matches = true;
    } else if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2);
      matches = host === suffix || host.endsWith(`.${suffix}`);
    }

    if (matches && (!best || pattern.length > best.hostname.length)) {
      best = rule;
    }
  }
  return best;
}

/** Return the effective placement/layout for a page. */
export function resolveDisplay(settings, hostname) {
  const rule = findSiteRule(settings?.display?.siteRules, hostname);
  return {
    hidden: rule ? rule.enabled === false : false,
    placement:
      rule && (rule.placement === 'before' || rule.placement === 'after')
        ? rule.placement
        : settings?.display?.placement === 'before'
          ? 'before'
          : 'after',
    layout:
      rule && (rule.layout === 'inline' || rule.layout === 'block')
        ? rule.layout
        : settings?.display?.layout === 'block'
          ? 'block'
          : 'inline',
  };
}
