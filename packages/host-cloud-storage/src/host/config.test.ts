import { describe, expect, test } from 'vitest'
import { loadCloudStorageConfig, redactMysqlUrl } from './config.ts'

describe('cloud storage config', () => {
  test('fails closed to SQLite', () => {
    expect(loadCloudStorageConfig({})).toEqual({ backend: 'sqlite', enabled: false })
  })

  test('keeps MySQL disabled in Offline', () => {
    expect(loadCloudStorageConfig({
      BIU_ONLINE: '0',
      BIU_STORAGE_BACKEND: 'dual',
      BIU_MYSQL_URL: 'mysql://biu:secret@db.example.test',
    })).toEqual({ backend: 'dual', enabled: false })
  })

  test('loads explicitly enabled, separate Online databases', () => {
    expect(
      loadCloudStorageConfig({
        BIU_ONLINE: '1',
        BIU_STORAGE_BACKEND: 'mysql',
        BIU_MYSQL_URL: 'mysql://biu:secret@db.example.test:3306',
        BIU_MYSQL_DATABASE: 'biu_dev',
        BIU_OPS_MYSQL_DATABASE: 'biu_ops_dev',
      }),
    ).toEqual({
      backend: 'mysql',
      enabled: true,
      url: 'mysql://biu:secret@db.example.test:3306',
      productDatabase: 'biu_dev',
      operationsDatabase: 'biu_ops_dev',
    })
  })

  test('online only runs on MySQL', () => {
    for (const backend of [undefined, 'sqlite', 'dual']) {
      expect(() => loadCloudStorageConfig({ BIU_ONLINE: '1', ...(backend ? { BIU_STORAGE_BACKEND: backend } : {}) }))
        .toThrow(/requires BIU_STORAGE_BACKEND=mysql/)
    }
    // 单独的运营开发控制台（BIU_OPERATIONS=1）仍可用本地库。
    expect(loadCloudStorageConfig({ BIU_ONLINE: '1', BIU_OPERATIONS: '1' })).toEqual({ backend: 'sqlite', enabled: false })
  })

  test('redacts passwords', () => {
    expect(redactMysqlUrl('mysql://biu:secret@db.example.test')).not.toContain('secret')
  })
})
