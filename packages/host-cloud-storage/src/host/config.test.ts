import { describe, expect, test } from 'vitest'
import { loadCloudStorageConfig, redactMysqlUrl } from './config.ts'

describe('cloud storage config', () => {
  test('fails closed to SQLite', () => {
    expect(loadCloudStorageConfig({})).toEqual({ backend: 'sqlite', enabled: false })
  })

  test('refuses MySQL from Offline', () => {
    expect(() =>
      loadCloudStorageConfig({
        BIU_ONLINE: '0',
        BIU_STORAGE_BACKEND: 'mysql',
        BIU_MYSQL_URL: 'mysql://biu:secret@db.example.test',
      }),
    ).toThrow(/only available in the Online runtime/)
  })

  test('loads explicitly enabled, separate Online databases', () => {
    expect(
      loadCloudStorageConfig({
        BIU_ONLINE: '1',
        BIU_STORAGE_BACKEND: 'dual',
        BIU_MYSQL_URL: 'mysql://biu:secret@db.example.test:3306',
        BIU_MYSQL_DATABASE: 'biu_dev',
        BIU_OPS_MYSQL_DATABASE: 'biu_ops_dev',
      }),
    ).toEqual({
      backend: 'dual',
      enabled: true,
      url: 'mysql://biu:secret@db.example.test:3306',
      productDatabase: 'biu_dev',
      operationsDatabase: 'biu_ops_dev',
    })
  })

  test('redacts passwords', () => {
    expect(redactMysqlUrl('mysql://biu:secret@db.example.test')).not.toContain('secret')
  })
})
