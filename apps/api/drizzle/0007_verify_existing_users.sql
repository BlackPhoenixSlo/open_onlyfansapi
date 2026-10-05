-- Email verification on sign-up (requireEmailVerification): accounts that existed before it keep signing in.
UPDATE "user" SET "email_verified" = true WHERE "email_verified" = false;
