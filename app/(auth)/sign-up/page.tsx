"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { MailIcon, LockIcon, UserIcon, ArrowRightIcon } from "lucide-react";
import { authClient } from "@/lib/auth-client";

export default function SignUpPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await authClient.signUp.email({
        name,
        email,
        password,
        callbackURL: "/settings",
      });
      if (result.error) {
        setError(result.error.message ?? "Sign up failed");
        return;
      }
      router.push("/settings");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign up failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="w-full max-w-md rounded-2xl border border-[#1e1e22] bg-[#111113]/90 p-8 shadow-xl backdrop-blur-sm"
    >
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-[#e8e8ea]">Create account</h1>
        <p className="mt-1 text-sm text-[#6b6b7a]">
          Sign up to manage your VEGA integrations and API keys.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label htmlFor="name" className="mb-1.5 block text-xs font-medium text-[#8b8b9a]">
            Name
          </label>
          <div className="relative">
            <UserIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#6b6b7a]" />
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
              placeholder="Your name"
              className="w-full rounded-lg border border-[#2a2a30] bg-[#1a1a1f] py-2.5 pl-10 pr-4 text-sm text-[#e8e8ea] placeholder:text-[#4a4a58] focus:border-[#00e5cc]/50 focus:outline-none focus:ring-1 focus:ring-[#00e5cc]/30"
            />
          </div>
        </div>

        <div>
          <label htmlFor="email" className="mb-1.5 block text-xs font-medium text-[#8b8b9a]">
            Email
          </label>
          <div className="relative">
            <MailIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#6b6b7a]" />
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              placeholder="you@example.com"
              className="w-full rounded-lg border border-[#2a2a30] bg-[#1a1a1f] py-2.5 pl-10 pr-4 text-sm text-[#e8e8ea] placeholder:text-[#4a4a58] focus:border-[#00e5cc]/50 focus:outline-none focus:ring-1 focus:ring-[#00e5cc]/30"
            />
          </div>
        </div>

        <div>
          <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-[#8b8b9a]">
            Password
          </label>
          <div className="relative">
            <LockIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#6b6b7a]" />
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              placeholder="At least 8 characters"
              className="w-full rounded-lg border border-[#2a2a30] bg-[#1a1a1f] py-2.5 pl-10 pr-4 text-sm text-[#e8e8ea] placeholder:text-[#4a4a58] focus:border-[#00e5cc]/50 focus:outline-none focus:ring-1 focus:ring-[#00e5cc]/30"
            />
          </div>
        </div>

        {error && (
          <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#00e5cc] py-2.5 text-sm font-semibold text-[#0a0a0b] transition-colors hover:bg-[#00e5cc]/90 disabled:opacity-50"
        >
          {loading ? "Creating account…" : "Sign up"}
          <ArrowRightIcon className="size-4" />
        </button>
      </form>

      <p className="mt-6 text-center text-xs text-[#6b6b7a]">
        Already have an account?{" "}
        <Link href="/sign-in" className="text-[#00e5cc] hover:underline">
          Sign in
        </Link>
      </p>
    </motion.div>
  );
}
