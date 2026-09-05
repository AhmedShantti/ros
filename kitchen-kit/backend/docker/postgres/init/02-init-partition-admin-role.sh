#!/bin/bash
# Runs once on first container init (as the migrator/owner superuser).
# Creates the FR-DR-002 partition-DDL role: a NON-superuser role that owns
# ONLY the partitioned parent tables the partition-lifecycle job maintains
# (ownership is assigned later, in the migration that transfers it) and holds
# NO DML privilege of its own. It exists solely because attaching a partition
# requires table ownership, and `ros_app` (the runtime role every request path
# uses) deliberately does not have it — see
# src/modules/platform/partitioning/partition-admin-connection.service.ts for
# the full reasoning.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    DO \$\$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROS_PARTITION_ADMIN_USER}') THEN
            CREATE ROLE "${ROS_PARTITION_ADMIN_USER}" LOGIN PASSWORD '${ROS_PARTITION_ADMIN_PASSWORD}'
                NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        END IF;
    END
    \$\$;

    GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO "${ROS_PARTITION_ADMIN_USER}";
EOSQL

echo "ros: partition-admin role '${ROS_PARTITION_ADMIN_USER}' ready (non-superuser, NOBYPASSRLS, no DML)"
