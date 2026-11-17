/**
 * What this Orca build of Plannotator carries. Written by build.mjs from recipe.json for each build: the copy in the
 * Orca plugin's build folder is a full build's, and build.mjs refuses to build when it differs from that.
 * `features`: what `GET /api/inbox/orca` serves. `omitted`: the optional patches this build left out.
 */
export const ORCA_BUILD: { readonly features: readonly string[]; readonly omitted: readonly string[] } = {
  features: ["launch-hosts","update-state","update-detail","agents","mark-faces"],
  omitted: [],
};
