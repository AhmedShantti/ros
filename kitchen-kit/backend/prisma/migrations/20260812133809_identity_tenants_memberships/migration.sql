-- CreateEnum
CREATE TYPE "identity"."TenantStatus" AS ENUM ('active', 'suspended', 'closed');

-- CreateEnum
CREATE TYPE "identity"."MembershipStatus" AS ENUM ('active', 'inactive', 'suspended');

-- AlterTable
ALTER TABLE "identity"."sessions" ADD COLUMN     "membership_id" UUID;

-- CreateTable
CREATE TABLE "identity"."tenants" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "legal_name" VARCHAR(255) NOT NULL,
    "default_currency" CHAR(3) NOT NULL,
    "default_locale" VARCHAR(10) NOT NULL DEFAULT 'ar',
    "country_pack_code" VARCHAR(8) NOT NULL,
    "status" "identity"."TenantStatus" NOT NULL DEFAULT 'active',
    "owner_user_id" UUID,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."memberships" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "status" "identity"."MembershipStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "identity"."tenants"("slug");

-- CreateIndex
CREATE INDEX "memberships_tenant_id_idx" ON "identity"."memberships"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_user_id_tenant_id_key" ON "identity"."memberships"("user_id", "tenant_id");

-- CreateIndex
CREATE INDEX "sessions_membership_id_idx" ON "identity"."sessions"("membership_id");

-- AddForeignKey
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "identity"."memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."tenants" ADD CONSTRAINT "tenants_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "identity"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."memberships" ADD CONSTRAINT "memberships_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
