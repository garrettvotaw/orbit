import type { OrbitApi } from '../../../shared/ipc';

declare global {
  interface Window {
    orbit: OrbitApi;
  }
}
export {};
