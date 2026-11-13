import { createAdapter } from './shared';

export const claudeAdapter = createAdapter(
  (url) => /^https?:\/\/(www\.)?claude\.ai\//.test(url),
  '.ProseMirror',
);
