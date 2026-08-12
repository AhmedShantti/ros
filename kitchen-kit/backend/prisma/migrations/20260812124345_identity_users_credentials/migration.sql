-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "identity";

-- CreateEnum
CREATE TYPE "identity"."UserStatus" AS ENUM ('active', 'disabled', 'locked');

-- CreateEnum
CREATE TYPE "identity"."CredentialType" AS ENUM ('password', 'pin', 'oauth');

-- CreateTable
CREATE TABLE "identity"."users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(24),
    "display_name" VARCHAR(120) NOT NULL,
    "preferred_locale" VARCHAR(10) NOT NULL DEFAULT 'ar',
    "status" "identity"."UserStatus" NOT NULL DEFAULT 'active',
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."credentials" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "credential_type" "identity"."CredentialType" NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "pin_for_terminal" BOOLEAN NOT NULL DEFAULT false,
    "must_reset" BOOLEAN NOT NULL DEFAULT false,
    "rotated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "identity"."users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "credentials_user_id_credential_type_key" ON "identity"."credentials"("user_id", "credential_type");

-- AddForeignKey
ALTER TABLE "identity"."credentials" ADD CONSTRAINT "credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
