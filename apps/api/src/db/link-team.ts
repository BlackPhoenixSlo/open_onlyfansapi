// Links a workspace to the upstream, so its keys may reach it. Idempotent.
// Usage: pnpm --filter @gateway/api link-team <workspace-slug>
//        (in the container: node dist/db/link-team.js <workspace-slug>)
import { eq } from 'drizzle-orm';
import { db, pool } from './index.js';
import { organization, teamBackend } from './schema.js';

const [slug] = process.argv.slice(2);
if (!slug) {
  console.error('usage: link-team <workspace-slug>');
  process.exit(1);
}

try {
  const [team] = await db.select({ id: organization.id }).from(organization).where(eq(organization.slug, slug)).limit(1);
  if (!team) {
    console.error(`no workspace with slug "${slug}"`);
    process.exitCode = 1;
  } else {
    await db
      .insert(teamBackend)
      .values({ teamId: team.id })
      .onConflictDoUpdate({ target: teamBackend.teamId, set: { linkedAt: new Date() } });
    console.log(`linked workspace ${slug} (${team.id}) to the upstream`);
  }
} finally {
  await pool.end();
}
