// Links a workspace to the backend owner user whose accounts it may use.
// Usage: pnpm --filter @gateway/api link-team <workspace-slug> <backendUserId>
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/index.js';
import { organization, teamBackend } from '../src/db/schema.js';

const [slug, rawUserId] = process.argv.slice(2);
const backendUserId = Number(rawUserId);
if (!slug || !Number.isInteger(backendUserId) || backendUserId <= 0) {
  console.error('usage: link-team <workspace-slug> <backendUserId>');
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
      .values({ teamId: team.id, backendUserId })
      .onConflictDoUpdate({ target: teamBackend.teamId, set: { backendUserId, linkedAt: new Date() } });
    console.log(`linked workspace ${slug} (${team.id}) to backend user #${backendUserId}`);
  }
} finally {
  await pool.end();
}
