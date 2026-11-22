import { render } from "solid-js/web";
import { inject } from "@vercel/analytics";
import { PrivacyPreferences } from "./components/PrivacyPreferences";
import App from "./App";
import { AccountClient } from "./cloud/account";
import { browserStorage } from "./tasks/task-storage";
import { PRODUCTION_ORIGINS } from "./shared/site";
import "./styles/app.css";

const root = document.getElementById("root");
if (!root) throw new Error("The app root is missing.");

/**
 * Back from Google sign-in: trade its code for a session before the list
 * opens, so the list starts as the signed-in account. The code never stays
 * in the address bar.
 */
async function finishGoogleSignIn(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (!code && !params.has("error")) return;
  history.replaceState(null, "", location.pathname);
  if (!code) return;
  const client = new AccountClient({ storage: browserStorage() });
  try {
    await client.finishGoogle(code);
  } catch {
    // Still a guest: "Do it for me" asks to sign in again.
  } finally {
    await client.dispose();
  }
}

void finishGoogleSignIn().finally(() =>
  render(
    () => (
      <>
        <App />
        <PrivacyPreferences />
      </>
    ),
    root,
  ),
);

// Track production page views only, never auth query strings/fragments or task data.
if (import.meta.env.PROD && PRODUCTION_ORIGINS.includes(location.origin)) {
  inject({
    mode: "production",
    beforeSend: (event) => {
      const url = new URL(event.url);
      url.search = "";
      url.hash = "";
      return { ...event, url: url.toString() };
    },
  });
}
