// Prints a password reset link for a user, without sending any mail: the operator's path when the user's mailbox is
// wrong or SMTP fails. The link is the one the reset email would carry (valid 1 hour, works once); hand it over
// privately, since it lets whoever holds it set the password.
// Usage: pnpm --filter @gateway/api auth:reset-link <email>
//        (in the container: node dist/cli/reset-link.js <email>)
import { eq } from 'drizzle-orm';
import { auth, setResetDelivery } from '../auth.js';
import { db, pool } from '../db/index.js';
import { user } from '../db/schema.js';

const [email] = process.argv.slice(2);
if (!email) {
  console.error('usage: auth:reset-link <email>');
  process.exit(1);
}

try {
  const [found] = await db.select({ id: user.id }).from(user).where(eq(user.email, email.toLowerCase())).limit(1);
  if (!found) {
    console.error(`no user with email "${email}"`);
    process.exitCode = 1;
  } else {
    // Keep the link in this process instead of mailing it. better-auth 1.7 awaits sendResetPassword (no
    // advanced.backgroundTasks is set), so the link is here once the request returns.
    let link: string | undefined;
    setResetDelivery((reset) => {
      link = reset.link;
    });
    await auth.api.requestPasswordReset({ body: { email } });
    if (!link) throw new Error('better-auth produced no reset link');
    console.log(link);
  }
} finally {
  await pool.end();
}
