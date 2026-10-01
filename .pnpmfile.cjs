// better-auth lists vitest and drizzle-kit as optional peers. pnpm satisfies them from the api's
// devDependencies, and `pnpm deploy --prod` keeps that snapshot, which drags the dev toolchain
// (vitest, vite, tsx, drizzle-kit, esbuild) into the runtime image. Drop the two peers.
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === 'better-auth') {
        for (const name of ['vitest', 'drizzle-kit']) {
          if (pkg.peerDependencies) delete pkg.peerDependencies[name];
          if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[name];
        }
      }
      return pkg;
    },
  },
};
