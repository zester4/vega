/**
 * Better Auth client for React (sign-in, sign-up, signOut, session).
 */
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: typeof window !== "undefined" ? window.location.origin : "",
});
