// Links a workspace to the upstream, so its keys may reach it. Idempotent. Sign-up links new workspaces itself;
// this is the repair path for one left unlinked (the link insert failed) or created before auto-linking.
// Usage: pnpm --filter @gateway/api link-team <workspace-slug>
//        (in the container: node dist/db/link-team.js <workspace-slug>)
import { eq } from 'drizzle-orm';
import { db, pool } from './index.js';
import { linkTeam } from '../lib/team-link.js';
import { organization } from './schema.js';

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
    await linkTeam(team.id);
    console.log(`linked workspace ${slug} (${team.id}) to the upstream`);
  }
} finally {
  await pool.end();
}
