export type MysqlMigration = {
  version: number
  name: string
  statements: readonly string[]
}

const MYSQL_TABLE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci'

/**
 * Only new control-plane tables are created here. Existing SQLite business
 * rows are migrated by a separate, explicit importer after dry-run checks.
 */
export const PRODUCT_MIGRATIONS: readonly MysqlMigration[] = [
  {
    version: 1,
    name: 'device_backup_and_auth_revision_foundation',
    statements: [
      `CREATE TABLE IF NOT EXISTS account_devices (
        id VARCHAR(64) NOT NULL,
        account_id VARCHAR(64) NOT NULL,
        platform VARCHAR(32) NOT NULL DEFAULT '',
        app_version VARCHAR(32) NOT NULL DEFAULT '',
        first_seen_at BIGINT NOT NULL,
        last_seen_at BIGINT NOT NULL,
        revoked_at BIGINT NULL,
        PRIMARY KEY (id),
        KEY account_devices_account_seen (account_id, last_seen_at DESC)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS offline_profiles (
        device_id VARCHAR(64) NOT NULL,
        local_account_id VARCHAR(64) NOT NULL,
        cloud_account_id VARCHAR(64) NOT NULL,
        display_name VARCHAR(255) NOT NULL DEFAULT '',
        local_page_count BIGINT NOT NULL DEFAULT 0,
        local_session_count BIGINT NOT NULL DEFAULT 0,
        last_seen_at BIGINT NOT NULL,
        PRIMARY KEY (device_id, local_account_id),
        KEY offline_profiles_cloud_seen (cloud_account_id, last_seen_at DESC)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS authz_revisions (
        workspace_id VARCHAR(64) NOT NULL,
        collection_name VARCHAR(128) NOT NULL,
        revision BIGINT NOT NULL DEFAULT 0,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (workspace_id, collection_name)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS cloud_backups (
        id VARCHAR(64) NOT NULL,
        account_id VARCHAR(64) NOT NULL,
        source_device_id VARCHAR(64) NOT NULL,
        name VARCHAR(255) NOT NULL DEFAULT '',
        scope ENUM('private_backup', 'workspace') NOT NULL DEFAULT 'private_backup',
        workspace_id VARCHAR(64) NULL,
        manifest_version BIGINT NOT NULL DEFAULT 1,
        status ENUM('uploading', 'ready', 'failed', 'deleted') NOT NULL DEFAULT 'uploading',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (id),
        KEY cloud_backups_account_updated (account_id, updated_at DESC),
        KEY cloud_backups_workspace_updated (workspace_id, updated_at DESC)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS cloud_backup_items (
        backup_id VARCHAR(64) NOT NULL,
        collection_name VARCHAR(128) NOT NULL,
        record_id VARCHAR(128) NOT NULL,
        record_version BIGINT NOT NULL DEFAULT 1,
        content_hash CHAR(64) NOT NULL,
        metadata_json JSON NOT NULL,
        object_key VARCHAR(1024) NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (backup_id, collection_name, record_id),
        KEY cloud_backup_items_hash (content_hash),
        CONSTRAINT cloud_backup_items_backup_fk
          FOREIGN KEY (backup_id) REFERENCES cloud_backups(id) ON DELETE CASCADE
      ) ${MYSQL_TABLE}`,
    ],
  },
]

export const OPERATIONS_MIGRATIONS: readonly MysqlMigration[] = [
  {
    version: 1,
    name: 'operations_projections_governance_and_audit',
    statements: [
      `CREATE TABLE IF NOT EXISTS ops_accounts (
        id VARCHAR(64) NOT NULL, email VARCHAR(320) NOT NULL DEFAULT '',
        name VARCHAR(255) NOT NULL DEFAULT '', status VARCHAR(32) NOT NULL DEFAULT 'active',
        workspace_count BIGINT NOT NULL DEFAULT 0, plan VARCHAR(64) NOT NULL DEFAULT '',
        last_seen_at BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
        PRIMARY KEY (id), KEY ops_accounts_workspace_seen (workspace_count DESC, last_seen_at DESC),
        KEY ops_accounts_status_updated (status, updated_at DESC)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS ops_workspaces (
        id VARCHAR(64) NOT NULL, name VARCHAR(255) NOT NULL, owner_id VARCHAR(64) NOT NULL DEFAULT '',
        location VARCHAR(32) NOT NULL DEFAULT 'cloud', member_count BIGINT NOT NULL DEFAULT 0,
        status VARCHAR(32) NOT NULL DEFAULT 'active', created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
        PRIMARY KEY (id), KEY ops_workspaces_owner (owner_id),
        KEY ops_workspaces_location_updated (location, updated_at DESC)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS ops_usage_daily (
        id VARCHAR(255) NOT NULL, day CHAR(10) NOT NULL, account_id VARCHAR(64) NOT NULL DEFAULT '',
        workspace_id VARCHAR(64) NOT NULL DEFAULT '', tokens BIGINT NOT NULL DEFAULT 0,
        requests BIGINT NOT NULL DEFAULT 0, storage_bytes BIGINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL,
        PRIMARY KEY (id), KEY ops_usage_daily_day_account (day, account_id),
        KEY ops_usage_daily_workspace_day (workspace_id, day)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS ops_devices (
        id VARCHAR(255) NOT NULL, installation_id VARCHAR(128) NOT NULL,
        account_id VARCHAR(64) NOT NULL DEFAULT '', version VARCHAR(32) NOT NULL DEFAULT '',
        os VARCHAR(64) NOT NULL DEFAULT '', status VARCHAR(32) NOT NULL DEFAULT 'online',
        last_seen_at BIGINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL,
        PRIMARY KEY (id), KEY ops_devices_account_seen (account_id, last_seen_at DESC),
        KEY ops_devices_installation (installation_id)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS ops_sync_health (
        id VARCHAR(255) NOT NULL, installation_id VARCHAR(128) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'idle', pending_ops BIGINT NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL, last_sync_at BIGINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL,
        PRIMARY KEY (id), KEY ops_sync_health_status_sync (status, last_sync_at DESC),
        KEY ops_sync_health_installation (installation_id)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS ops_security_events (
        id VARCHAR(255) NOT NULL, kind VARCHAR(128) NOT NULL, account_id VARCHAR(64) NOT NULL DEFAULT '',
        summary TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (id),
        KEY ops_security_events_kind_created (kind, created_at DESC),
        KEY ops_security_events_account_created (account_id, created_at DESC)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS ops_account_governance (
        account_id VARCHAR(64) NOT NULL,
        status ENUM('active', 'suspended') NOT NULL DEFAULT 'active',
        reason VARCHAR(1024) NOT NULL DEFAULT '', updated_by VARCHAR(64) NOT NULL,
        updated_at BIGINT NOT NULL, PRIMARY KEY (account_id),
        KEY ops_account_governance_status_updated (status, updated_at DESC)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS ops_audit_logs (
        id VARCHAR(255) NOT NULL, actor_id VARCHAR(64) NOT NULL DEFAULT '',
        action VARCHAR(128) NOT NULL, target VARCHAR(255) NOT NULL DEFAULT '',
        summary TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (id),
        KEY ops_audit_logs_created (created_at DESC),
        KEY ops_audit_logs_action_created (action, created_at DESC)
      ) ${MYSQL_TABLE}`,
    ],
  },
]
