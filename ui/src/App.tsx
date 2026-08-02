import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { hasSecret, setSecret } from "./api";
import "./App.css";

function BrandMark() {
  return <span className="brand-mark">CC</span>;
}

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
      <div className="secret-card">
        <div className="brand">
          <BrandMark />
          <h1>Campaign Codegen</h1>
        </div>
        <p>
          Enter the API shared secret (matches <code>API_SHARED_SECRET</code> in the server's <code>.env</code>) to
          continue.
        </p>
        <form onSubmit={submit} className="secret-form">
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
        <NavLink to="/" className="brand" end>
          <BrandMark />
          Campaign Codegen
        </NavLink>
        <nav>
          <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>
            Campaigns
          </NavLink>
          <NavLink to="/new" className={({ isActive }) => (isActive ? "active" : "")}>
            New campaign
          </NavLink>
        </nav>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
