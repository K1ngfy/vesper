import { getEditableTarget } from '../insert';
import type { Adapter } from './types';

export function createAdapter(match: Adapter['match'], defaultSelector?: string): Adapter {
  return {
    match,
    getTarget(el, selector) {
      const target = getEditableTarget(el);
      if (!target) return null;
      const preferred = selector || defaultSelector;
      if (!preferred) return target;
      try {
        const scoped = el.closest(preferred);
        if (scoped && scoped.contains(target)) return getEditableTarget(scoped) ?? target;
      } catch {
        // An invalid custom selector must not disable generic interception.
      }
      return target;
    },
  };
}
