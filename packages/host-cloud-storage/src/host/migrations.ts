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
  {
    version: 2,
    name: 'sqlite_import_audit',
    statements: [
      `CREATE TABLE IF NOT EXISTS sqlite_import_runs (
        id BIGINT NOT NULL AUTO_INCREMENT,
        source_kind VARCHAR(32) NOT NULL,
        source_name VARCHAR(255) NOT NULL,
        table_count BIGINT NOT NULL,
        source_rows BIGINT NOT NULL,
        target_rows BIGINT NOT NULL,
        report_json JSON NOT NULL,
        imported_at BIGINT NOT NULL,
        PRIMARY KEY (id),
        KEY sqlite_import_runs_kind_time (source_kind, imported_at DESC)
      ) ${MYSQL_TABLE}`,
    ],
  },
  {
    version: 3,
    name: 'migration_tenancy_exceptions',
    statements: [
      `CREATE TABLE IF NOT EXISTS migration_tenancy_exceptions (
        collection_name VARCHAR(128) NOT NULL,
        record_id VARCHAR(128) NOT NULL,
        reason VARCHAR(64) NOT NULL DEFAULT 'missing_record_owner',
        proposed_workspace_id VARCHAR(64) NULL,
        resolved_at BIGINT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (collection_name, record_id),
        KEY migration_tenancy_exceptions_resolution (resolved_at, collection_name)
      ) ${MYSQL_TABLE}`,
    ],
  },
  {
    version: 4,
    name: 'tenancy_exception_resolution',
    statements: [
      `ALTER TABLE migration_tenancy_exceptions
       ADD COLUMN resolution VARCHAR(32) NULL AFTER proposed_workspace_id`,
    ],
  },
  {
    version: 5,
    name: 'dual_shadow_state',
    statements: [
      `CREATE TABLE IF NOT EXISTS shadow_sync_cursors (
        session_id VARCHAR(128) NOT NULL,
        last_seq BIGINT NOT NULL DEFAULT -1,
        row_count BIGINT NOT NULL DEFAULT 0,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (session_id)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS shadow_sync_tables (
        table_name VARCHAR(128) NOT NULL,
        checksum CHAR(64) NOT NULL,
        row_count BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (table_name)
      ) ${MYSQL_TABLE}`,
    ],
  },
  {
    version: 6,
    name: 'page_editor_runtime_tenancy',
    statements: [
      `ALTER TABLE pages
       ADD COLUMN workspace_id VARCHAR(64) NOT NULL DEFAULT '' AFTER id`,
      `UPDATE pages p
       JOIN record_owners o ON o.collection = '/pages' AND o.record_id = p.id
       SET p.workspace_id = o.workspace_id
       WHERE p.workspace_id = ''`,
      `ALTER TABLE pages DROP PRIMARY KEY, ADD PRIMARY KEY (workspace_id, id)`,
      `CREATE INDEX pages_workspace_updated ON pages (workspace_id, updated_at DESC, id DESC)`,
      `ALTER TABLE pages MODIFY parent_id VARCHAR(128) NULL`,
      `CREATE INDEX pages_workspace_parent ON pages (workspace_id, parent_id)`,
      `ALTER TABLE editor_content
       ADD COLUMN workspace_id VARCHAR(64) NOT NULL DEFAULT '' FIRST`,
      `UPDATE editor_content c
       JOIN record_owners o ON o.collection = c.collection AND o.record_id = c.record_id
       SET c.workspace_id = o.workspace_id
       WHERE c.workspace_id = ''`,
      `ALTER TABLE editor_content DROP PRIMARY KEY,
       ADD PRIMARY KEY (workspace_id, collection, record_id)`,
    ],
  },
  {
    version: 7,
    name: 'task_runtime_tenancy_and_types',
    statements: [
      `ALTER TABLE tasks
       ADD COLUMN workspace_id VARCHAR(64) NOT NULL DEFAULT '' AFTER id`,
      `UPDATE tasks t
       JOIN record_owners o ON o.collection = '/tasks' AND o.record_id = t.id
       SET t.workspace_id = o.workspace_id
       WHERE t.workspace_id = ''`,
      `ALTER TABLE tasks
       MODIFY id VARCHAR(128) NOT NULL,
       MODIFY title TEXT NOT NULL,
       MODIFY status VARCHAR(16) NOT NULL DEFAULT 'todo',
       MODIFY priority VARCHAR(16) NOT NULL DEFAULT 'med',
       MODIFY difficulty VARCHAR(16) NOT NULL DEFAULT 'med',
       MODIFY assignee VARCHAR(255) NOT NULL DEFAULT '',
       MODIFY due_at BIGINT NULL,
       MODIFY sort DOUBLE NOT NULL DEFAULT 0,
       MODIFY created_at BIGINT NOT NULL,
       MODIFY updated_at BIGINT NOT NULL,
       MODIFY assigned_at BIGINT NULL,
       MODIFY project VARCHAR(255) NOT NULL DEFAULT '',
       MODIFY parent_id VARCHAR(128) NULL,
       MODIFY depth BIGINT NOT NULL DEFAULT 0,
       MODIFY report_interval_sec BIGINT NOT NULL DEFAULT 60,
       MODIFY last_report_prompt_at BIGINT NULL,
       MODIFY report_prompt_count BIGINT NOT NULL DEFAULT 0,
       MODIFY emoji VARCHAR(64) NOT NULL DEFAULT ''`,
      `ALTER TABLE tasks DROP PRIMARY KEY, ADD PRIMARY KEY (workspace_id, id)`,
      `CREATE INDEX tasks_workspace_status_sort
       ON tasks (workspace_id, status, sort DESC, updated_at DESC, id DESC)`,
      `CREATE INDEX tasks_workspace_parent ON tasks (workspace_id, parent_id)`,
    ],
  },
  {
    version: 8,
    name: 'account_workspace_authorization_control_plane',
    statements: [
      `CREATE TABLE IF NOT EXISTS accounts (
        id VARCHAR(64) NOT NULL, name VARCHAR(255) NOT NULL, token VARCHAR(128) NOT NULL,
        password_hash VARCHAR(255) NOT NULL DEFAULT '', created_at BIGINT NOT NULL,
        email VARCHAR(320) NULL, active_workspace_id VARCHAR(64) NOT NULL DEFAULT '',
        must_change_password TINYINT(1) NOT NULL DEFAULT 0, password_recall TEXT NOT NULL,
        PRIMARY KEY (id), UNIQUE KEY accounts_token (token),
        KEY accounts_email_lookup (email)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS auth_sessions (
        id VARCHAR(64) NOT NULL, account_id VARCHAR(64) NOT NULL, token_hash CHAR(64) NOT NULL,
        device_name VARCHAR(120) NOT NULL DEFAULT '', expires_at BIGINT NULL, revoked_at BIGINT NULL,
        created_at BIGINT NOT NULL, last_seen_at BIGINT NOT NULL,
        PRIMARY KEY (id), UNIQUE KEY auth_sessions_token (token_hash),
        KEY auth_sessions_account (account_id, revoked_at, expires_at)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS workspaces (
        id VARCHAR(64) NOT NULL, name VARCHAR(255) NOT NULL, owner_id VARCHAR(64) NOT NULL,
        created_at BIGINT NOT NULL, PRIMARY KEY (id), KEY workspaces_owner (owner_id, created_at)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS workspace_members (
        workspace_id VARCHAR(64) NOT NULL, account_id VARCHAR(64) NOT NULL,
        role ENUM('owner','admin','member','viewer') NOT NULL, created_at BIGINT NOT NULL,
        display_name VARCHAR(255) NOT NULL DEFAULT '', avatar TEXT NOT NULL,
        member_kind ENUM('member','external','guest') NOT NULL DEFAULT 'member',
        PRIMARY KEY (workspace_id, account_id),
        KEY workspace_members_account (account_id, workspace_id)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS workspace_invites (
        id VARCHAR(64) NOT NULL, token_hash CHAR(64) NOT NULL, workspace_id VARCHAR(64) NOT NULL,
        kind ENUM('workspace','guest') NOT NULL, role ENUM('member','viewer') NOT NULL,
        collection VARCHAR(128) NOT NULL DEFAULT '', record_id VARCHAR(128) NOT NULL DEFAULT '',
        view_id VARCHAR(128) NOT NULL DEFAULT '', resource_role ENUM('viewer','editor','manager','owner') NOT NULL DEFAULT 'viewer',
        expires_at BIGINT NOT NULL, max_uses BIGINT NOT NULL DEFAULT 1, use_count BIGINT NOT NULL DEFAULT 0,
        created_by VARCHAR(64) NOT NULL, created_at BIGINT NOT NULL, revoked_at BIGINT NULL,
        PRIMARY KEY (id), UNIQUE KEY workspace_invites_token (token_hash),
        KEY workspace_invites_workspace (workspace_id, created_at)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS workspace_groups (
        id VARCHAR(64) NOT NULL, workspace_id VARCHAR(64) NOT NULL, name VARCHAR(255) NOT NULL,
        created_by VARCHAR(64) NOT NULL, created_at BIGINT NOT NULL,
        PRIMARY KEY (id), KEY workspace_groups_workspace (workspace_id, created_at)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS workspace_group_members (
        group_id VARCHAR(64) NOT NULL, account_id VARCHAR(64) NOT NULL, created_at BIGINT NOT NULL,
        PRIMARY KEY (group_id, account_id), KEY workspace_group_members_account (account_id, group_id)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS record_owners (
        workspace_id VARCHAR(64) NOT NULL, collection VARCHAR(128) NOT NULL, record_id VARCHAR(128) NOT NULL,
        owner_id VARCHAR(64) NOT NULL, version BIGINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL,
        PRIMARY KEY (workspace_id, collection, record_id),
        KEY record_owners_record (collection, record_id),
        KEY record_owners_owner (workspace_id, owner_id, collection)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS resource_policies (
        workspace_id VARCHAR(64) NOT NULL, collection VARCHAR(128) NOT NULL, record_id VARCHAR(128) NOT NULL,
        ownership ENUM('personal','workspace','shared') NOT NULL, owner_account_id VARCHAR(64) NOT NULL,
        access_mode ENUM('inherit','private','members','restricted') NOT NULL,
        member_default_role ENUM('viewer','editor') NOT NULL DEFAULT 'viewer',
        parent_collection VARCHAR(128) NOT NULL DEFAULT '', parent_record_id VARCHAR(128) NOT NULL DEFAULT '',
        created_by VARCHAR(64) NOT NULL, created_at BIGINT NOT NULL,
        PRIMARY KEY (workspace_id, collection, record_id),
        KEY resource_policies_parent (workspace_id, parent_collection, parent_record_id)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS record_grants (
        workspace_id VARCHAR(64) NOT NULL, collection VARCHAR(128) NOT NULL, record_id VARCHAR(128) NOT NULL,
        subject_type ENUM('account','group','workspace_role','member_view') NOT NULL,
        subject_id VARCHAR(128) NOT NULL, role ENUM('viewer','editor','manager','owner') NOT NULL,
        granted_by VARCHAR(64) NOT NULL, created_at BIGINT NOT NULL,
        PRIMARY KEY (workspace_id, collection, record_id, subject_type, subject_id),
        KEY record_grants_subject (workspace_id, collection, subject_type, subject_id)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS view_grants (
        workspace_id VARCHAR(64) NOT NULL, collection VARCHAR(128) NOT NULL, view_id VARCHAR(128) NOT NULL,
        subject_type ENUM('account','member_view') NOT NULL, subject_id VARCHAR(128) NOT NULL,
        role ENUM('viewer','editor','manager','owner') NOT NULL, granted_by VARCHAR(64) NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (workspace_id, collection, view_id, subject_type, subject_id),
        KEY view_grants_subject (workspace_id, collection, subject_type, subject_id)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS authz_revisions (
        workspace_id VARCHAR(64) NOT NULL, collection_name VARCHAR(128) NOT NULL,
        revision BIGINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL,
        PRIMARY KEY (workspace_id, collection_name)
      ) ${MYSQL_TABLE}`,
      `ALTER TABLE accounts
       MODIFY id VARCHAR(64) NOT NULL,
       MODIFY name VARCHAR(255) NOT NULL,
       MODIFY token VARCHAR(128) NOT NULL,
       MODIFY password_hash VARCHAR(255) NOT NULL DEFAULT '',
       MODIFY created_at BIGINT NOT NULL,
       MODIFY email VARCHAR(320) NULL,
       MODIFY active_workspace_id VARCHAR(64) NOT NULL DEFAULT '',
       MODIFY must_change_password TINYINT(1) NOT NULL DEFAULT 0,
       ADD COLUMN normalized_email VARCHAR(320)
         GENERATED ALWAYS AS (NULLIF(LOWER(TRIM(email)), '')) STORED,
       ADD UNIQUE KEY accounts_email_nonempty (normalized_email)`,
      `ALTER TABLE auth_sessions
       MODIFY id VARCHAR(64) NOT NULL,
       MODIFY account_id VARCHAR(64) NOT NULL,
       MODIFY token_hash CHAR(64) NOT NULL,
       MODIFY device_name VARCHAR(120) NOT NULL DEFAULT '',
       MODIFY expires_at BIGINT NULL,
       MODIFY revoked_at BIGINT NULL,
       MODIFY created_at BIGINT NOT NULL,
       MODIFY last_seen_at BIGINT NOT NULL`,
      `ALTER TABLE record_owners
       MODIFY workspace_id VARCHAR(64) NOT NULL,
       MODIFY collection VARCHAR(128) NOT NULL,
       MODIFY record_id VARCHAR(128) NOT NULL,
       MODIFY owner_id VARCHAR(64) NOT NULL,
       MODIFY version BIGINT NOT NULL DEFAULT 0,
       MODIFY updated_at BIGINT NOT NULL`,
    ],
  },
  {
    version: 9,
    name: 'account_guests_credentials_and_audit',
    statements: [
      `CREATE TABLE IF NOT EXISTS guest_sessions (
        id VARCHAR(64) NOT NULL, account_id VARCHAR(64) NOT NULL, workspace_id VARCHAR(64) NOT NULL,
        expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL, last_seen_at BIGINT NOT NULL,
        revoked_at BIGINT NULL, PRIMARY KEY (id),
        KEY guest_sessions_account (account_id, revoked_at, expires_at),
        KEY guest_sessions_workspace (workspace_id, expires_at)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS mcp_credentials (
        id VARCHAR(64) NOT NULL, token_hash CHAR(64) NOT NULL, account_id VARCHAR(64) NOT NULL,
        workspace_id VARCHAR(64) NOT NULL, allowed_tools JSON NOT NULL,
        expires_at BIGINT NULL, revoked_at BIGINT NULL, created_at BIGINT NOT NULL,
        PRIMARY KEY (id), UNIQUE KEY mcp_credentials_token (token_hash),
        KEY mcp_credentials_account_workspace (account_id, workspace_id, created_at)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS mcp_audit_log (
        id BIGINT NOT NULL AUTO_INCREMENT, credential_id VARCHAR(64) NOT NULL,
        account_id VARCHAR(64) NOT NULL, workspace_id VARCHAR(64) NOT NULL,
        tool_name VARCHAR(255) NOT NULL, success TINYINT(1) NOT NULL, created_at BIGINT NOT NULL,
        PRIMARY KEY (id), KEY mcp_audit_workspace (workspace_id, id DESC),
        KEY mcp_audit_credential (credential_id, created_at)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS plugin_audit_log (
        id BIGINT NOT NULL AUTO_INCREMENT, account_id VARCHAR(64) NOT NULL,
        workspace_id VARCHAR(64) NOT NULL DEFAULT '', plugin_id VARCHAR(64) NOT NULL,
        action VARCHAR(128) NOT NULL, detail_json JSON NOT NULL, created_at BIGINT NOT NULL,
        PRIMARY KEY (id), KEY plugin_audit_workspace (workspace_id, id DESC)
      ) ${MYSQL_TABLE}`,
    ],
  },
  {
    version: 10,
    name: 'collaboration_runtime_and_plugin_metadata',
    statements: [
      `CREATE TABLE IF NOT EXISTS sync_ops (
        id BIGINT NOT NULL AUTO_INCREMENT, workspace_id VARCHAR(64) NOT NULL,
        collection VARCHAR(128) NOT NULL, record_id VARCHAR(128) NOT NULL,
        field VARCHAR(128) NOT NULL, value_json JSON NOT NULL, version BIGINT NOT NULL,
        author_id VARCHAR(64) NOT NULL, created_at BIGINT NOT NULL,
        PRIMARY KEY (id), KEY sync_ops_workspace (workspace_id, id),
        KEY sync_ops_record (workspace_id, collection, record_id, id)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS edit_locks (
        workspace_id VARCHAR(64) NOT NULL, collection VARCHAR(128) NOT NULL,
        record_id VARCHAR(128) NOT NULL, account_id VARCHAR(64) NOT NULL, expires_at BIGINT NOT NULL,
        PRIMARY KEY (workspace_id, collection, record_id), KEY edit_locks_expiry (expires_at)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS presence (
        workspace_id VARCHAR(64) NOT NULL, account_id VARCHAR(64) NOT NULL,
        collection VARCHAR(128) NOT NULL DEFAULT '', record_id VARCHAR(128) NOT NULL DEFAULT '',
        seen_at BIGINT NOT NULL, PRIMARY KEY (workspace_id, account_id),
        KEY presence_workspace_seen (workspace_id, seen_at DESC)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS plugin_packages (
        id VARCHAR(64) NOT NULL, version VARCHAR(64) NOT NULL, package_hash CHAR(64) NOT NULL,
        package_path VARCHAR(1024) NOT NULL, source_kind VARCHAR(64) NOT NULL,
        trust_state VARCHAR(32) NOT NULL, tenant_mode VARCHAR(32) NOT NULL,
        has_web TINYINT(1) NOT NULL DEFAULT 0, has_host TINYINT(1) NOT NULL DEFAULT 0,
        manifest_json JSON NOT NULL, installed_by VARCHAR(64) NOT NULL,
        created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
        PRIMARY KEY (id, version), KEY plugin_packages_trust (trust_state, id)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS plugin_assignments (
        workspace_id VARCHAR(64) NOT NULL, plugin_id VARCHAR(64) NOT NULL,
        plugin_version VARCHAR(64) NOT NULL DEFAULT '',
        subject_type ENUM('workspace','account','member_view') NOT NULL,
        subject_id VARCHAR(128) NOT NULL, created_by VARCHAR(64) NOT NULL, created_at BIGINT NOT NULL,
        PRIMARY KEY (workspace_id, plugin_id, subject_type, subject_id),
        KEY plugin_assignments_subject (workspace_id, subject_type, subject_id),
        KEY plugin_assignments_plugin (workspace_id, plugin_id)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS plugin_workspace_config (
        workspace_id VARCHAR(64) NOT NULL, plugin_id VARCHAR(64) NOT NULL,
        config_json JSON NOT NULL, updated_by VARCHAR(64) NOT NULL, updated_at BIGINT NOT NULL,
        PRIMARY KEY (workspace_id, plugin_id)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS plugin_account_config (
        workspace_id VARCHAR(64) NOT NULL, plugin_id VARCHAR(64) NOT NULL,
        account_id VARCHAR(64) NOT NULL, config_json JSON NOT NULL, updated_at BIGINT NOT NULL,
        PRIMARY KEY (workspace_id, plugin_id, account_id),
        KEY plugin_account_config_account (account_id, workspace_id)
      ) ${MYSQL_TABLE}`,
      `CREATE TABLE IF NOT EXISTS plugin_loads (
        workspace_id VARCHAR(64) NOT NULL, account_id VARCHAR(64) NOT NULL,
        plugin_id VARCHAR(64) NOT NULL, loaded_at BIGINT NOT NULL,
        PRIMARY KEY (workspace_id, account_id, plugin_id), KEY plugin_loads_plugin (plugin_id)
      ) ${MYSQL_TABLE}`,
    ],
  },
  {
    version: 11,
    name: 'file_system_metadata_runtime_tenancy',
    statements: [
      `ALTER TABLE facets ADD COLUMN workspace_id VARCHAR(64) NOT NULL DEFAULT '' FIRST`,
      `ALTER TABLE facet_stamps ADD COLUMN workspace_id VARCHAR(64) NOT NULL DEFAULT '' FIRST`,
      `ALTER TABLE facet_record_values ADD COLUMN workspace_id VARCHAR(64) NOT NULL DEFAULT '' FIRST`,
      `ALTER TABLE record_meta ADD COLUMN workspace_id VARCHAR(64) NOT NULL DEFAULT '' FIRST`,
      `ALTER TABLE record_banners ADD COLUMN workspace_id VARCHAR(64) NOT NULL DEFAULT '' FIRST`,
      `ALTER TABLE banner_gallery ADD COLUMN workspace_id VARCHAR(64) NOT NULL DEFAULT '' FIRST`,
      `ALTER TABLE shares ADD COLUMN workspace_id VARCHAR(64) NOT NULL DEFAULT '' AFTER token`,
      `ALTER TABLE attachments ADD COLUMN workspace_id VARCHAR(64) NOT NULL DEFAULT '' FIRST`,
      `ALTER TABLE content_refs ADD COLUMN workspace_id VARCHAR(64) NOT NULL DEFAULT '' FIRST`,
      `ALTER TABLE block_refs ADD COLUMN workspace_id VARCHAR(64) NOT NULL DEFAULT '' FIRST`,
      `ALTER TABLE page_block_index ADD COLUMN workspace_id VARCHAR(64) NOT NULL DEFAULT '' FIRST`,
      `ALTER TABLE page_block_cover ADD COLUMN workspace_id VARCHAR(64) NOT NULL DEFAULT '' FIRST`,
      `ALTER TABLE page_block_index_meta ADD COLUMN workspace_id VARCHAR(64) NOT NULL DEFAULT '' FIRST`,

      `UPDATE facet_record_values v JOIN record_owners o
       ON o.collection = v.collection AND o.record_id = v.record_id
       SET v.workspace_id = o.workspace_id WHERE v.workspace_id = ''`,
      `UPDATE record_meta m JOIN record_owners o
       ON o.collection = m.collection AND o.record_id = m.record_id
       SET m.workspace_id = o.workspace_id WHERE m.workspace_id = ''`,
      `UPDATE record_banners b JOIN record_owners o
       ON o.collection = b.collection AND o.record_id = b.record_id
       SET b.workspace_id = o.workspace_id WHERE b.workspace_id = ''`,
      `UPDATE content_refs r JOIN record_owners o
       ON o.collection = r.collection AND o.record_id = r.record_id
       SET r.workspace_id = o.workspace_id WHERE r.workspace_id = ''`,
      `UPDATE block_refs r JOIN record_owners o
       ON o.collection = r.collection AND o.record_id = r.record_id
       SET r.workspace_id = o.workspace_id WHERE r.workspace_id = ''`,
      `UPDATE facet_stamps s JOIN record_owners o
       ON o.collection = s.collection AND o.record_id = s.record_id
       SET s.workspace_id = o.workspace_id WHERE s.workspace_id = ''`,
      `UPDATE page_block_index i JOIN record_owners o
       ON o.collection = i.collection AND o.record_id = i.page_id
       SET i.workspace_id = o.workspace_id WHERE i.workspace_id = ''`,
      `UPDATE page_block_cover c JOIN record_owners o
       ON o.collection = c.collection AND o.record_id = c.page_id
       SET c.workspace_id = o.workspace_id WHERE c.workspace_id = ''`,
      `UPDATE shares s JOIN record_owners o
       ON s.kind = 'record' AND o.collection = s.collection AND o.record_id = s.record_id
       SET s.workspace_id = o.workspace_id WHERE s.workspace_id = ''`,
      `UPDATE shares s JOIN saved_views v
       ON s.kind = 'view' AND v.collection = s.collection AND v.view_id = s.view_id
       SET s.workspace_id = v.workspace_id WHERE s.workspace_id = ''`,
      `UPDATE facets f JOIN (
         SELECT facet_id, MIN(workspace_id) workspace_id
         FROM facet_stamps WHERE workspace_id <> '' GROUP BY facet_id
       ) s ON s.facet_id = f.id SET f.workspace_id = s.workspace_id WHERE f.workspace_id = ''`,
      `UPDATE attachments a JOIN (
         SELECT name, MIN(workspace_id) workspace_id FROM (
           SELECT name, workspace_id FROM content_refs WHERE workspace_id <> ''
           UNION ALL SELECT name, workspace_id FROM block_refs WHERE workspace_id <> ''
         ) refs GROUP BY name
       ) r ON r.name = a.name SET a.workspace_id = r.workspace_id WHERE a.workspace_id = ''`,

      `ALTER TABLE facets
       MODIFY id VARCHAR(128) NOT NULL,
       MODIFY label VARCHAR(255) NOT NULL,
       DROP PRIMARY KEY,
       ADD PRIMARY KEY (workspace_id, id),
       ADD KEY facets_workspace_label (workspace_id, label)`,
      `ALTER TABLE facet_stamps
       MODIFY facet_id VARCHAR(128) NOT NULL, MODIFY collection VARCHAR(128) NOT NULL,
       MODIFY record_id VARCHAR(128) NOT NULL, DROP PRIMARY KEY,
       ADD PRIMARY KEY (workspace_id, facet_id, collection, record_id),
       ADD KEY facet_stamps_record_tenant (workspace_id, collection, record_id)`,
      `ALTER TABLE facet_record_values
       MODIFY collection VARCHAR(128) NOT NULL, MODIFY record_id VARCHAR(128) NOT NULL,
       DROP PRIMARY KEY, ADD PRIMARY KEY (workspace_id, collection, record_id)`,
      `ALTER TABLE record_meta
       MODIFY collection VARCHAR(128) NOT NULL, MODIFY record_id VARCHAR(128) NOT NULL,
       DROP PRIMARY KEY, ADD PRIMARY KEY (workspace_id, collection, record_id),
       ADD KEY record_meta_deleted_tenant (workspace_id, collection, deleted_at)`,
      `ALTER TABLE record_banners
       MODIFY collection VARCHAR(128) NOT NULL, MODIFY record_id VARCHAR(128) NOT NULL,
       DROP PRIMARY KEY, ADD PRIMARY KEY (workspace_id, collection, record_id)`,
      `ALTER TABLE banner_gallery MODIFY id VARCHAR(128) NOT NULL, DROP PRIMARY KEY,
       ADD PRIMARY KEY (workspace_id, id), ADD KEY banner_gallery_recent (workspace_id, created_at DESC)`,
      `ALTER TABLE saved_views
       MODIFY workspace_id VARCHAR(64) NOT NULL, MODIFY collection VARCHAR(128) NOT NULL,
       MODIFY view_id VARCHAR(128) NOT NULL, DROP PRIMARY KEY,
       ADD PRIMARY KEY (workspace_id, collection, view_id),
       ADD KEY saved_views_workspace_collection (workspace_id, collection)`,
      `ALTER TABLE shares
       MODIFY token VARCHAR(128) NOT NULL, MODIFY collection VARCHAR(128) NOT NULL,
       MODIFY view_id VARCHAR(128) NOT NULL, MODIFY record_id VARCHAR(128) NOT NULL,
       DROP PRIMARY KEY, ADD PRIMARY KEY (token),
       ADD UNIQUE KEY shares_tenant_target (workspace_id, kind, collection, view_id, record_id),
       ADD KEY shares_workspace_updated (workspace_id, updated_at DESC)`,
      `ALTER TABLE attachments MODIFY name VARCHAR(255) NOT NULL, DROP PRIMARY KEY,
       ADD PRIMARY KEY (workspace_id, name)`,
      `ALTER TABLE content_refs
       MODIFY collection VARCHAR(128) NOT NULL, MODIFY record_id VARCHAR(128) NOT NULL,
       MODIFY name VARCHAR(255) NOT NULL, MODIFY source VARCHAR(128) NOT NULL,
       DROP PRIMARY KEY, ADD PRIMARY KEY (workspace_id, collection, record_id, name, source),
       ADD KEY content_refs_asset_tenant (workspace_id, name)`,
      `ALTER TABLE block_refs
       MODIFY collection VARCHAR(128) NOT NULL, MODIFY record_id VARCHAR(128) NOT NULL,
       MODIFY block_id VARCHAR(128) NOT NULL, MODIFY name VARCHAR(128) NOT NULL,
       MODIFY source VARCHAR(128) NOT NULL, DROP PRIMARY KEY,
       ADD PRIMARY KEY (workspace_id, collection, record_id, block_id, name, source),
       ADD KEY block_refs_asset_tenant (workspace_id, name)`,
      `ALTER TABLE page_block_index
       MODIFY collection VARCHAR(128) NOT NULL, MODIFY page_id VARCHAR(128) NOT NULL,
       MODIFY block_id VARCHAR(128) NOT NULL, DROP PRIMARY KEY,
       ADD PRIMARY KEY (workspace_id, collection, page_id, block_id),
       ADD KEY page_block_index_page_tenant (workspace_id, collection, page_id)`,
      `ALTER TABLE page_block_cover
       MODIFY collection VARCHAR(128) NOT NULL, MODIFY page_id VARCHAR(128) NOT NULL,
       DROP PRIMARY KEY, ADD PRIMARY KEY (workspace_id, collection, page_id)`,
      `ALTER TABLE page_block_index_meta MODIFY \`key\` VARCHAR(128) NOT NULL, DROP PRIMARY KEY,
       ADD PRIMARY KEY (workspace_id, \`key\`)`,
    ],
  },
  {
    version: 12,
    name: 'session_execution_leases',
    statements: [
      // 桌面设备接管云端会话执行时的租约。放在 MySQL 里，多台 Online 实例才能看到同一把锁。
      `CREATE TABLE IF NOT EXISTS session_execution_leases (
        session_id VARCHAR(128) NOT NULL,
        account_id VARCHAR(64) NOT NULL,
        lease_id VARCHAR(64) NOT NULL,
        executor_id VARCHAR(120) NOT NULL DEFAULT 'device',
        expires_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (session_id),
        KEY session_execution_leases_expiry (expires_at)
      ) ${MYSQL_TABLE}`,
    ],
  },
  {
    version: 13,
    name: 'session_order_and_workspace_subject_indexes',
    statements: [
      `ALTER TABLE sessions
       ADD INDEX sessions_updated (updated_at DESC), ALGORITHM=INPLACE, LOCK=NONE`,
      `ALTER TABLE record_grants
       ADD INDEX record_grants_workspace_subject (workspace_id, subject_type, subject_id),
       ALGORITHM=INPLACE, LOCK=NONE`,
      `ALTER TABLE view_grants
       ADD INDEX view_grants_workspace_subject (workspace_id, subject_type, subject_id),
       ALGORITHM=INPLACE, LOCK=NONE`,
    ],
  },
  {
    version: 14,
    name: 'session_event_time_projection',
    statements: [
      `ALTER TABLE sessions
       ADD COLUMN first_event_at BIGINT NULL,
       ADD COLUMN last_user_message_at BIGINT NULL,
       ADD COLUMN event_times_ready TINYINT(1) NOT NULL DEFAULT 0,
       ALGORITHM=INSTANT`,
      `CREATE TRIGGER events_summary_insert AFTER INSERT ON events FOR EACH ROW
       UPDATE sessions SET
         first_event_at = IF(first_event_at IS NULL, NEW.ts, LEAST(first_event_at, NEW.ts)),
         last_user_message_at = IF(NEW.type = 'user/message',
           IF(last_user_message_at IS NULL, NEW.ts, GREATEST(last_user_message_at, NEW.ts)),
           last_user_message_at)
       WHERE id = NEW.session_id AND event_times_ready = 1`,
      `CREATE TRIGGER events_summary_delete AFTER DELETE ON events FOR EACH ROW
       UPDATE sessions SET event_times_ready = 0 WHERE id = OLD.session_id`,
      `CREATE TRIGGER events_summary_update AFTER UPDATE ON events FOR EACH ROW
       UPDATE sessions SET event_times_ready = 0
       WHERE id IN (OLD.session_id, NEW.session_id)`,
    ],
  },
  {
    version: 15,
    name: 'saved_views_account_owner',
    statements: [
      // 视图按创建账号隔离。迁移前没有归属的历史视图统一交给空间所有者。
      `UPDATE saved_views v JOIN workspaces w ON w.id = v.workspace_id
       SET v.payload_json = JSON_SET(v.payload_json, '$.createdBy', w.owner_id)
       WHERE JSON_VALID(v.payload_json) AND w.owner_id <> ''
         AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(v.payload_json, '$.createdBy')), '') IN ('', 'null')`,
    ],
  },
  {
    version: 16,
    name: 'record_scope_from_collaborators',
    statements: [
      // 之前 MySQL 加协作者不会重算归属，留下“有协作者却仍是私人”的记录；按 SQLite 同一规则补齐。
      `UPDATE resource_policies p
       SET p.ownership = CASE WHEN EXISTS (
             SELECT 1 FROM record_grants g
             JOIN workspace_members m ON m.workspace_id = g.workspace_id AND m.account_id = g.subject_id
             WHERE g.workspace_id = p.workspace_id AND g.collection = p.collection AND g.record_id = p.record_id
               AND g.subject_type = 'account' AND g.subject_id <> p.owner_account_id
               AND m.member_kind IN ('external', 'guest')
           ) THEN 'shared' ELSE 'workspace' END,
           p.access_mode = IF(p.access_mode = 'private', 'restricted', p.access_mode)
       WHERE p.ownership = 'personal'
         AND EXISTS (
           SELECT 1 FROM record_grants g
           WHERE g.workspace_id = p.workspace_id AND g.collection = p.collection AND g.record_id = p.record_id
             AND NOT (g.subject_type = 'account' AND g.subject_id = p.owner_account_id)
         )`,
    ],
  },
  {
    version: 17,
    name: 'shares_drop_untenanted_target_index',
    statements: [
      // 从 SQLite 导入时带来的 shares_target(kind, collection, view_id, record_id) 不含 workspace_id：
      // 两个空间分享同一目标会撞唯一约束，按冲突更新写入时还会改写别的空间的分享。
      // 第 11 版已加了按空间的 shares_tenant_target，这里只删旧索引；不存在时什么也不做。
      `SET @biu_drop_shares_target = (
         SELECT IF(COUNT(*) > 0, 'ALTER TABLE shares DROP INDEX shares_target', 'DO 0')
         FROM information_schema.statistics
         WHERE table_schema = DATABASE() AND table_name = 'shares' AND index_name = 'shares_target'
       )`,
      'PREPARE biu_drop_shares_target FROM @biu_drop_shares_target',
      'EXECUTE biu_drop_shares_target',
      'DEALLOCATE PREPARE biu_drop_shares_target',
    ],
  },
  {
    version: 18,
    name: 'record_scope_narrow_after_revoke',
    statements: [
      // 撤销协作只在之后的授权变更时收窄归属；这里按 reconcileRecordScope 同一规则补算历史记录。
      // 只动“共享”与“受限的空间”两类：它们是撤销后可能留下的过宽状态。
      `UPDATE resource_policies p
       SET p.ownership = CASE
             WHEN EXISTS (
               SELECT 1 FROM record_grants g
               JOIN workspace_members m ON m.workspace_id = g.workspace_id AND m.account_id = g.subject_id
               WHERE g.workspace_id = p.workspace_id AND g.collection = p.collection AND g.record_id = p.record_id
                 AND g.subject_type = 'account' AND g.subject_id <> p.owner_account_id
                 AND m.member_kind IN ('external', 'guest')
             ) OR EXISTS (
               SELECT 1 FROM shares s
               WHERE s.workspace_id = p.workspace_id AND s.kind = 'record'
                 AND s.collection = p.collection AND s.record_id = p.record_id
             ) THEN 'shared'
             WHEN p.access_mode = 'members' OR EXISTS (
               SELECT 1 FROM record_grants g
               WHERE g.workspace_id = p.workspace_id AND g.collection = p.collection AND g.record_id = p.record_id
                 AND NOT (g.subject_type = 'account' AND g.subject_id = p.owner_account_id)
             ) THEN 'workspace'
             ELSE 'personal'
           END,
           p.access_mode = CASE
             WHEN p.access_mode NOT IN ('private', 'restricted') THEN p.access_mode
             WHEN EXISTS (
               SELECT 1 FROM record_grants g
               WHERE g.workspace_id = p.workspace_id AND g.collection = p.collection AND g.record_id = p.record_id
                 AND NOT (g.subject_type = 'account' AND g.subject_id = p.owner_account_id)
             ) THEN 'restricted'
             ELSE 'private'
           END
       WHERE p.ownership = 'shared' OR (p.ownership = 'workspace' AND p.access_mode = 'restricted')`,
    ],
  },
  {
    version: 19,
    name: 'view_grants_key_includes_grantor',
    statements: [
      // “全部”视图按人隔离：同一对象可以分别被不同管理者授权。主键不含授权人时只能存一条，
      // 后授的会改写先授的范围。主键加上 granted_by；已经包含时什么也不做。
      // 从 SQLite 导入的 granted_by 是 LONGTEXT，不能进主键；先改成与其余键列一致的 VARCHAR(128) utf8mb4_bin。
      `SET @biu_view_grants_grantor = (
         SELECT IF(MAX(data_type) <> 'varchar' OR MAX(character_maximum_length) <> 128 OR MAX(collation_name) <> 'utf8mb4_bin',
           'ALTER TABLE view_grants MODIFY granted_by VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL',
           'DO 0')
         FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = 'view_grants' AND column_name = 'granted_by'
       )`,
      'PREPARE biu_view_grants_grantor FROM @biu_view_grants_grantor',
      'EXECUTE biu_view_grants_grantor',
      'DEALLOCATE PREPARE biu_view_grants_grantor',
      `SET @biu_view_grants_pk = (
         SELECT IF(SUM(column_name = 'granted_by') = 0,
           'ALTER TABLE view_grants DROP PRIMARY KEY, ADD PRIMARY KEY (workspace_id, collection, view_id, subject_type, subject_id, granted_by)',
           'DO 0')
         FROM information_schema.statistics
         WHERE table_schema = DATABASE() AND table_name = 'view_grants' AND index_name = 'PRIMARY'
       )`,
      'PREPARE biu_view_grants_pk FROM @biu_view_grants_pk',
      'EXECUTE biu_view_grants_pk',
      'DEALLOCATE PREPARE biu_view_grants_pk',
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
  {
    version: 2,
    name: 'operations_import_audit',
    statements: [
      `CREATE TABLE IF NOT EXISTS ops_import_runs (
        id BIGINT NOT NULL AUTO_INCREMENT,
        sources_json JSON NOT NULL,
        report_json JSON NOT NULL,
        imported_at BIGINT NOT NULL,
        PRIMARY KEY (id),
        KEY ops_import_runs_time (imported_at DESC)
      ) ${MYSQL_TABLE}`,
    ],
  },
]
