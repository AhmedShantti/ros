import { User } from '../../../generated/prisma/client';

/**
 * The only shape of a user we ever hand outside the Identity context. Credential
 * material lives in a separate table and is never joined into this view.
 */
export interface SafeUser {
  id: string;
  email: string;
  displayName: string;
  phone: string | null;
  preferredLocale: string;
  status: User['status'];
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toSafeUser(user: User): SafeUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    phone: user.phone,
    preferredLocale: user.preferredLocale,
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
