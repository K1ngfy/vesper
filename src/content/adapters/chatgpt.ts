import { createAdapter } from './shared';

export const chatgptAdapter = createAdapter(
  (url) => /^https?:\/\/(www\.)?chatgpt\.com\//.test(url),
  '#prompt-textarea',
);
