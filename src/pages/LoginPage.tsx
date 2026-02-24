import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signInWithGoogle } from "../lib/googleAuth";
import { useAppContext } from "../store/AppContext";

const CLIENT_ID = import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID as string;

export function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  const { setAuth } = useAppContext();
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);

  async function handleSignIn(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    setStatus("");
    try {
      setLoading(true);
      setStatus("Opening Google sign-in...");
      const auth = await signInWithGoogle(CLIENT_ID);
      setAuth(auth);
      navigate("/wizard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sign in");
    } finally {
      setLoading(false);
      setStatus("");
    }
  }

  return (
    <main className="login-page">
      <section className="card">
        <h1>DK Weekly Points</h1>
        <p>Sign in with Google to start the wizard.</p>
        <form onSubmit={handleSignIn} className="form-grid">
          <button type="submit" disabled={loading}>
            {loading ? "Signing in..." : "Sign In with Google"}
          </button>
        </form>
        <p className="hint">Allowlist blocks the UI. Sheet sharing permissions still control true access.</p>
        {status ? <p>{status}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </section>
    </main>
  );
}
