import { useState } from "react";
import { useSignInEmailPassword, useSignUpEmailPassword } from "@nhost/nextjs";
import { useRouter } from "next/router";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const router = useRouter();

  const { signInEmailPassword, isLoading: signingIn, error: signInError } = useSignInEmailPassword();
  const { signUpEmailPassword, isLoading: signingUp, error: signUpError } = useSignUpEmailPassword();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const result = mode === "signin" ? await signInEmailPassword(email, password) : await signUpEmailPassword(email, password);
    if (result.isSuccess) router.push("/");
  }

  return (
    <div style={{ maxWidth: 360, margin: "80px auto" }}>
      <h1>AI Workflow Builder</h1>
      <form onSubmit={submit} className="card">
        <div style={{ marginBottom: 10 }}>
          <label>Email</label><br />
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required style={{ width: "100%" }} />
        </div>
        <div style={{ marginBottom: 10 }}>
          <label>Password</label><br />
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required style={{ width: "100%" }} />
        </div>
        <button type="submit" disabled={signingIn || signingUp}>
          {mode === "signin" ? "Sign in" : "Sign up"}
        </button>
        <button type="button" onClick={() => setMode(mode === "signin" ? "signup" : "signin")} style={{ marginLeft: 8, background: "transparent" }}>
          {mode === "signin" ? "Need an account?" : "Have an account?"}
        </button>
        {(signInError || signUpError) && (
          <p style={{ color: "#f87171" }}>{signInError?.message || signUpError?.message}</p>
        )}
      </form>
      <p style={{ opacity: 0.6, fontSize: 13 }}>
        After signing up, an admin adds you to an organization via <code>org_members</code>
        (there's no self-serve org creation UI in this scaffold — see README).
      </p>
    </div>
  );
}
