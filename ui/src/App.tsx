import { useState } from "react";
import { Link, Outlet } from "react-router-dom";
import { hasSecret, setSecret } from "./api";
import "./App.css";

function SecretPrompt({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setSecret(value.trim());
    onSaved();
  }

  return (
    <div className="secret-gate">
      <form onSubmit={submit} className="secret-form">
        <h1>Campaign Codegen</h1>
        <p>Enter the API shared secret (matches <code>API_SHARED_SECRET</code> in the server's <code>.env</code>).</p>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Shared secret"
          autoFocus
        />
        <button type="submit">Continue</button>
      </form>
    </div>
  );
}

export default function App() {
  const [unlocked, setUnlocked] = useState(hasSecret());

  if (!unlocked) {
    return <SecretPrompt onSaved={() => setUnlocked(true)} />;
  }

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">Campaign Codegen</Link>
        <nav>
          <Link to="/">Campaigns</Link>
          <Link to="/new">New campaign</Link>
        </nav>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
