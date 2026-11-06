"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import styles from "@/components/folio-page.module.css";
import PageLoading from "@/components/PageLoading";

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
    <div className={`${styles.page} ${styles.narrow}`}>
      <h1>
        Enter your promo code
      </h1>
      <p className={styles.lede}>
        Building studies is available to subscribed
        researchers. Enter your promo code to continue. Browsing the study library and
        benchmark stays open.
      </p>

      <form onSubmit={submit} className={styles.formSheet}>
        <label htmlFor="code" className="block text-sm font-semibold text-[var(--foreground)]">
          Promo code
        </label>
        <input
          id="code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="Your promo code"
          autoComplete="off"
          disabled={busy}
          className="mt-2 h-12 w-full border border-[var(--site-line)] px-4 text-base outline-none focus:border-[var(--site-accent)] disabled:bg-[var(--site-surface)]"
        />
        {error && (
          <p className="mt-3 border-l-2 border-red-600 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || !code.trim()}
          className="mt-5 h-12 w-full bg-[var(--site-accent)] text-sm font-semibold text-white hover:bg-[var(--site-accent)] disabled:cursor-not-allowed disabled:bg-[var(--site-selected)]"
        >
          {busy ? "Checking…" : "Continue"}
        </button>
      </form>

      <p className="mt-6 text-xs leading-5 text-[var(--site-muted)]">
        Just browsing?{" "}
        <Link href="/studies" className="font-semibold text-[var(--site-accent)] hover:underline">
          Explore the Study Library
        </Link>{" "}
        or{" "}
        <Link href="/results" className="font-semibold text-[var(--site-accent)] hover:underline">
          view benchmark
        </Link>
        .
      </p>
    </div>
  );
}

export default function AccessPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <AccessForm />
    </Suspense>
  );
}
