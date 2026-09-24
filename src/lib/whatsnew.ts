/**
 * What's New content, shown once per app version on first launch (tracked in
 * localStorage) and reopenable any time from the About dialog.
 *
 * Release checklist: when shipping a new version, replace/extend SLIDES with
 * that release's highlights. The version gate keys off the app version at
 * runtime, so content just needs to describe the current release.
 */

export interface WhatsNewSlide {
  /** Release the slide belongs to, shown as a mono pill. */
  version: string;
  title: string;
  tagline: string;
  points: string[];
}

const SEEN_KEY = "mongo-bongo-whats-new-seen";

export const SLIDES: WhatsNewSlide[] = [
  {
    version: "0.1.0",
    title: "Mongo Bongo",
    tagline: "First build.",
    points: [
      "Table, Documents, Schema and Indexes views for any collection",
      "Query dock with Find, Aggregate and Shell",
      "Document drawer with typed field editing, a JSON editor and a diff view",
      "Production connections open read-only; edit mode is an explicit switch",
      "Credentials encrypted at rest, optionally keyed from the OS keychain",
    ],
  },
];

/** Version whose What's New the user has already seen (or dismissed). */
export function seenVersion(): string | null {
  return localStorage.getItem(SEEN_KEY);
}

export function markSeen(version: string): void {
  localStorage.setItem(SEEN_KEY, version);
}
