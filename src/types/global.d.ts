import type { StudioApi } from './studio';

declare global {
  interface Window {
    studio: StudioApi;
  }
}

export {};
