/**
 * The Orca build of Plannotator (the `projects` group of its edits): the optional project field the window reads
 * (projectMenu.ts), named here so the edits never change upstream's shared interfaces.
 */
export {};

declare module './api' {
  interface ProjectFolder {
    /** A project of the Orca plugin's catalog, shown even before its first message. */
    orca_imported?: true;
  }
}
