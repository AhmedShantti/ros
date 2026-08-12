-- CreateTable
CREATE TABLE "identity"."password_reset_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "identity"."password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "identity"."password_reset_tokens"("user_id");

-- AddForeignKey
ALTER TABLE "identity"."password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Runtime grant for ros_app. This table is global identity data (users are
-- tenant-agnostic, ADR 0001), so it is intentionally NOT RLS-protected — like
-- users / credentials / sessions.
GRANT SELECT, INSERT, UPDATE, DELETE ON "identity"."password_reset_tokens" TO ros_app;
