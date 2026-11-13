import { desensitize, testRule } from './engine';
import type { Scheme } from './types';

self.onmessage = ({ data }: MessageEvent<{ text: string; scheme: Scheme; validate: boolean }>) => {
  try {
    const { text, scheme, validate } = data;
    const result =
      validate && scheme.rules[0]
        ? testRule(text, scheme.rules[0])
        : desensitize(text, scheme, true);
    self.postMessage({ result });
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : 'engine-error' });
  }
};
