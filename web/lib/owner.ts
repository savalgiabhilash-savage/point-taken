// The only account allowed to see the Docs tab (architecture + model blueprint). Client-safe: the
// nav uses it to show the tab; the real gate is isOwner() in current-user.ts (server-side).
export const OWNER_EMAIL = "savalgiabhilash@gmail.com";

export const isOwnerEmail = (email: string | null | undefined) =>
  (email ?? "").trim().toLowerCase() === OWNER_EMAIL;
