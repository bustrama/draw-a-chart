import { useRegisterSW } from 'virtual:pwa-register/react';

const HOUR = 60 * 60 * 1000;

/** Unobtrusive "new version" notice; the user decides when to reload (never mid-stroke). */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (registration) setInterval(() => void registration.update(), HOUR);
    },
  });
  if (!needRefresh) return null;
  return (
    <div className="absolute right-3 bottom-3 z-20 flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850/95 px-3 py-2 text-xs text-ink-200 shadow-lg">
      <span>A new version is available.</span>
      <button type="button" className="ui-control rounded-md bg-accent px-2 py-1 font-medium text-ink-950" onClick={() => void updateServiceWorker(true)}>
        Reload
      </button>
      <button type="button" className="ui-control px-1 text-ink-400 hover:text-ink-200" onClick={() => setNeedRefresh(false)}>
        Later
      </button>
    </div>
  );
}
