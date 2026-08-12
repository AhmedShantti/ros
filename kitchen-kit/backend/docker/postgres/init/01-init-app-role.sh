#!/bin/bash
# Runs once on first container init (as the migrator/owner superuser).
# Creates the runtime application role: a NON-superuser with NOBYPASSRLS so that
# PostgreSQL Row Level Security (and FORCE RLS) actually constrains it.
# Table/schema privileges are granted later, in the migration that enables RLS.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    DO \$\$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROS_APP_USER}') THEN
            CREATE ROLE "${ROS_APP_USER}" LOGIN PASSWORD '${ROS_APP_PASSWORD}'
                NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        END IF;
    END
    \$\$;

    GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO "${ROS_APP_USER}";
EOSQL

echo "ros: application role '${ROS_APP_USER}' ready (non-superuser, NOBYPASSRLS)"
