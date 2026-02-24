export type GoogleAuthResult = {
  accessToken: string;
  email: string;
};

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: {
            client_id: string;
            scope: string;
            callback: (response: { access_token?: string; error?: string }) => void;
          }): {
            requestAccessToken(): void;
          };
        };
      };
    };
  }
}

const GOOGLE_SCRIPT_URL = "https://accounts.google.com/gsi/client";

let googleScriptPromise: Promise<void> | null = null;

function ensureGoogleScript(): Promise<void> {
  if (window.google?.accounts?.oauth2) {
    return Promise.resolve();
  }
  if (googleScriptPromise) {
    return googleScriptPromise;
  }
  googleScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GOOGLE_SCRIPT_URL}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Failed to load Google script")));
      return;
    }
    const script = document.createElement("script");
    script.src = GOOGLE_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google script"));
    document.head.appendChild(script);
  });
  return googleScriptPromise;
}

async function fetchEmail(accessToken: string): Promise<string> {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!response.ok) {
    throw new Error(`Unable to read user profile (${response.status})`);
  }
  const payload = (await response.json()) as { email?: string };
  if (!payload.email) {
    throw new Error("Google account email not available");
  }
  return payload.email;
}

export async function signInWithGoogle(clientId: string): Promise<GoogleAuthResult> {
  if (!clientId) {
    throw new Error("Missing VITE_GOOGLE_WEB_CLIENT_ID");
  }
  await ensureGoogleScript();
  return new Promise<GoogleAuthResult>((resolve, reject) => {
    const oauth2 = window.google?.accounts?.oauth2;
    if (!oauth2) {
      reject(new Error("Google OAuth client is unavailable"));
      return;
    }
    const tokenClient = oauth2.initTokenClient({
      client_id: clientId,
      scope: "https://www.googleapis.com/auth/spreadsheets openid email profile",
      callback: async (response) => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error || "Login failed"));
          return;
        }
        try {
          const email = await fetchEmail(response.access_token);
          resolve({ accessToken: response.access_token, email });
        } catch (error) {
          reject(error instanceof Error ? error : new Error("Unable to fetch profile"));
        }
      }
    });
    tokenClient.requestAccessToken();
  });
}
