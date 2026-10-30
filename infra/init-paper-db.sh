#!/bin/sh
# New volume initialization; rerunning explicitly never rotates existing passwords.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv paper_password LOCAL_PAPER_DB_PASSWORD
SELECT NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hth_test') AS create_role \gset
\if :create_role
CREATE ROLE hth_test LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD :'paper_password';
\endif
SELECT NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS safe_role FROM pg_roles WHERE rolname = 'hth_test' \gset
\if :safe_role
\else
\echo PAPER_ROLE_UNSAFE
\quit 1
\endif
SELECT NOT EXISTS (SELECT FROM pg_database WHERE datname = 'hth_readonly_test') AS create_database \gset
\if :create_database
CREATE DATABASE hth_readonly_test OWNER hth_test;
\endif
SELECT datdba = (SELECT oid FROM pg_roles WHERE rolname = 'hth_test') AS safe_owner FROM pg_database WHERE datname = 'hth_readonly_test' \gset
\if :safe_owner
\else
\echo PAPER_DATABASE_OWNER_MISMATCH
\quit 1
\endif
REVOKE CONNECT ON DATABASE hth_trading FROM PUBLIC;
GRANT CONNECT ON DATABASE hth_trading TO hth;
SQL
