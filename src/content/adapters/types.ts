export interface Adapter {
  match(url: string): boolean;
  getTarget(el: HTMLElement, selector?: string): HTMLElement | null;
}
