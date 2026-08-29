"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

function AccessForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";

  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (response.ok && data.ok) {
        router.replace(next);
        router.refresh();
      } else {
        setError(
          data.error === "invalid_code"
            ? "That promo code is not recognized."
            : "Something went wrong. Please try again."
        );
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-md flex-col justify-center px-6 py-16">
      <p className="text-xs font-bold uppercase text-cyan-800">Access required</p>
      <h1 className="mt-3 font-serif text-3xl font-bold text-gray-950">
        Enter your promo code
      </h1>
      <p className="mt-3 text-sm leading-6 text-gray-600">
        Building studies and running the playground are available to subscribed
        researchers. Enter your promo code to continue. Browsing the datasets and
        agent evaluations stays open.
      </p>

      <form onSubmit={submit} className="mt-8">
        <label htmlFor="code" className="block text-sm font-semibold text-gray-900">
          Promo code
        </label>
        <input
          id="code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="Your promo code"
          autoComplete="off"
          disabled={busy}
          className="mt-2 h-12 w-full border border-gray-300 px-4 text-base outline-none focus:border-cyan-700 disabled:bg-gray-100"
        />
        {error && (
          <p className="mt-3 border-l-2 border-red-600 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || !code.trim()}
          className="mt-5 h-12 w-full bg-cyan-700 text-sm font-semibold text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          {busy ? "Checking…" : "Continue"}
        </button>
      </form>

      <p className="mt-6 text-xs leading-5 text-gray-500">
        Just browsing?{" "}
        <Link href="/dataset" className="font-semibold text-cyan-700 hover:underline">
          Explore the datasets
        </Link>{" "}
        or{" "}
        <Link href="/results" className="font-semibold text-cyan-700 hover:underline">
          view agent evaluations
        </Link>
        .
      </p>
    </div>
  );
}

export default function AccessPage() {
  return (
    <Suspense fallback={null}>
      <AccessForm />
    </Suspense>
  );
}
