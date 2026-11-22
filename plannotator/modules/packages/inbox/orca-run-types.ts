/**
 * The Orca build of Plannotator (the `launch-hosts` group of its edits): the optional run-line field the window reads
 * (RunLine.tsx), named here so the edits never change upstream's shared interfaces.
 */
export {};

declare module '@plannotator/core/inbox-types' {
  interface InboxRun {
    /** Optional native host Open destination (the launch host's `routeHost`); absent means Terminal. */
    open_in?: string;
  }
}
