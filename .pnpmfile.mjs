export const hooks = {
  beforePacking(pkg) {
    if (pkg.name === "@shllg/emend") {
      // The bundle is self-contained; keep private workspace devDependencies out of the tarball.
      delete pkg.devDependencies;
    }
    return pkg;
  },
};
