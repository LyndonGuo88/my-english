import { Capacitor } from "@capacitor/core";

export async function prepareNativeRuntime() {
  if (!Capacitor.isNativePlatform()) return;

  if (navigator.serviceWorker) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  }

  if (window.caches) {
    const keys = await window.caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  }

  if (window.indexedDB?.databases) {
    const databases = await window.indexedDB.databases();
    await Promise.all(databases.map((database) => new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(database.name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    })));
  }
}
