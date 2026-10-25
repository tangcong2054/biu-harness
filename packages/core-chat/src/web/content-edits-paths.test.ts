import { describe, expect, it } from 'vitest'
import { recordParts } from './content-edits-table.tsx'

describe('recordParts', () => {
  it('keeps record ids that start with a slash (page blocks / components)', () => {
    expect(recordParts('/page-blocks//pages::p1::b1')).toEqual({
      collection: '/page-blocks',
      recordId: '/pages::p1::b1',
    })
  })

  it('keeps slashes inside record ids', () => {
    expect(recordParts('/views/pages::builtin-all:/pages')).toEqual({
      collection: '/views',
      recordId: 'pages::builtin-all:/pages',
    })
  })

  it('splits plain paths and rejects collection-only paths', () => {
    expect(recordParts('/pages/p1')).toEqual({ collection: '/pages', recordId: 'p1' })
    expect(recordParts('pages/p1')).toEqual({ collection: '/pages', recordId: 'p1' })
    expect(recordParts('/pages')).toBeNull()
    expect(recordParts('/pages/')).toBeNull()
    expect(recordParts('/')).toBeNull()
  })
})
