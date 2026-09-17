const API_BASE = '/api';

export interface AppSettings {
  sheikhAvatarUrl?: string;
}

/**
 * Subscribes to global app settings from server database.
 */
export function subscribeToSettings(
  onUpdate: (settings: AppSettings) => void
): () => void {
  let isSubscribed = true;

  const loadSettings = async () => {
    try {
      const res = await fetch(`${API_BASE}/settings`);
      if (res.ok) {
        const data = await res.json();
        if (isSubscribed) {
          onUpdate(data);
        }
      }
    } catch {
      // Ignore network errors and fall back gracefully
    }
  };

  loadSettings();
  const intervalId = setInterval(loadSettings, 10000);

  const handleLocalChange = () => {
    loadSettings();
  };
  window.addEventListener('settings_database_changed', handleLocalChange);

  return () => {
    isSubscribed = false;
    clearInterval(intervalId);
    window.removeEventListener('settings_database_changed', handleLocalChange);
  };
}

/**
 * Updates the global app settings in server database.
 */
export async function updateAppSettings(newSettings: Partial<AppSettings>): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newSettings),
    });
    if (!res.ok) {
      throw new Error(`Failed to update settings (HTTP ${res.status})`);
    }
    window.dispatchEvent(new Event('settings_database_changed'));
  } catch (err) {
    console.error('Error updating app settings on server:', err);
    throw err;
  }
}
